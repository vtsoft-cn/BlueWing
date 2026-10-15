import { net } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { Database } from '../db/Database';
import { SingBoxManager } from './SingBoxManager';

const execFileAsync = promisify(execFile);

const MIRRORS = [
  'fastly.jsdelivr.net',
  'gcore.jsdelivr.net',
  'testingcf.jsdelivr.net',
];

/** 固定 IP 兜底:本地 DNS 解析失败(如域名被阻断返回空解析)时,直接向这些任播边缘 IP 发起请求 */
const PINNED_IPS = ['151.101.65.229', '151.101.193.229', '104.17.207.5', '104.17.208.5'];

const STATIC_RULES = ['geosite-cn', 'geoip-cn', 'geosite-category-ads-all', 'geoip-private'];

/** sing-box .srs 二进制以 "SRS" 魔数开头;以此识别并拒存 404 文本页等垃圾内容(注意 geoip-private 仅 ~150B,不能按大小一刀切) */
function isSrsBuffer(buf: Buffer): boolean {
  return buf.length >= 50 && buf.subarray(0, 3).toString('ascii') === 'SRS';
}

interface AttemptResult {
  buf?: Buffer;
  error?: string;
}

async function curlTo(
  url: string,
  outFile: string,
  proxyPort?: number,
  pinnedIp?: string
): Promise<AttemptResult> {
  try {
    const args = ['-sS', '-L', '--max-time', '25', '-o', outFile];
    if (proxyPort) args.push('-x', `http://127.0.0.1:${proxyPort}`);
    if (pinnedIp) {
      const host = new URL(url).hostname;
      args.push('--resolve', `${host}:443:${pinnedIp}`);
    }
    args.push(url);
    await execFileAsync('curl.exe', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const buf = fs.readFileSync(outFile);
    if (isSrsBuffer(buf)) return { buf };
    return { error: '内容无效(非规则文件)' };
  } catch (e: any) {
    const msg: string = e.message || '下载失败';
    if (msg.includes("Couldn't resolve") || msg.includes('Could not resolve') || msg.includes('resolve host')) {
      return { error: '域名无法解析(可能被 DNS 阻断)' };
    }
    if (msg.includes('reset') || msg.includes('recvfrom')) {
      return { error: '连接被重置' };
    }
    return { error: msg.slice(0, 80) };
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

async function netFetchTo(url: string): Promise<AttemptResult> {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (isSrsBuffer(buf)) return { buf };
      return { error: '内容无效(非规则文件)' };
    }
    return { error: `HTTP ${res.status}` };
  } catch (e: any) {
    const msg: string = e.message || '';
    if (msg.includes('ERR_NAME_NOT_RESOLVED')) return { error: '域名无法解析(可能被 DNS 阻断)' };
    if (msg.includes('ERR_CONNECTION_RESET') || msg.includes('forcibly closed')) return { error: '连接被重置' };
    return { error: msg.slice(0, 80) || '网络错误' };
  }
}

async function fetchSrs(
  relPath: string,
  opts: { coreRunning: boolean; proxyPort?: number }
): Promise<Buffer> {
  const urlPath = `gh/MetaCubeX/meta-rules-dat@sing/geo/${relPath}`;
  const urls = MIRRORS.map((m) => `https://${m}/${urlPath}`);
  const tmp = path.join(process.env.OWNBOX_DATA_DIR || '.', '.rule-dl.part');
  const attempts: (() => Promise<AttemptResult>)[] = [];
  const errors: string[] = [];

  const collect = (r: AttemptResult): AttemptResult => {
    if (r.buf) return { buf: r.buf };
    if (r.error && !errors.includes(r.error)) errors.push(r.error);
    return {};
  };

  // ① 核心已连接:优先走本地核心代理下载——域名由节点侧解析,完全绕开本地 DNS 问题
  if (opts.coreRunning && opts.proxyPort) {
    for (const mirror of MIRRORS) {
      attempts.push(async () => collect(await curlTo(`https://${mirror}/${urlPath}`, tmp, opts.proxyPort)));
    }
  }
  // ② Chromium 网络栈(自动跟随系统代理)
  for (const url of urls) {
    attempts.push(async () => collect(await netFetchTo(url)));
  }
  // ③ curl 直连
  for (const url of urls) {
    attempts.push(async () => collect(await curlTo(url, tmp)));
  }
  // ④ 固定 IP 兜底:跳过本地 DNS,直接向任播边缘 IP 发起请求
  for (const mirror of MIRRORS) {
    for (const ip of PINNED_IPS) {
      attempts.push(async () => collect(await curlTo(`https://${mirror}/${urlPath}`, tmp, undefined, ip)));
    }
  }

  let lastError = '所有镜像均不可达';
  for (const attempt of attempts) {
    const r = await attempt();
    if (r.buf) return r.buf;
    if (r.error && errors[errors.length - 1] !== r.error) lastError = r.error;
    void errors;
  }
  throw new Error(lastError);
}

export interface RuleSetUpdateResult {
  updated: string[];
  failed: string[];
  coreRunning: boolean;
}

export class RuleSetUpdater {
  /**
   * 更新分流规则集数据(.srs)到用户数据目录 data/rules/,
   * 优先级高于应用内置的 resources/bin/rules(见 ConfigGenerator.locateRulesDir)。
   * 范围:内置 4 条静态规则集 + 用户分流规则中引用的 geosite:/geoip: 分类。
   * 下载顺序:核心已连接→优先走自身代理;随后 Chromium 网络栈、直连、固定 IP 兜底。
   */
  public static async updateAll(): Promise<RuleSetUpdateResult> {
    const db = Database.getInstance();
    const dataDir =
      process.env.OWNBOX_DATA_DIR ||
      path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'), 'OwnBox');
    const rulesDir = path.join(dataDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });

    // 收集需要更新的规则集:静态 4 条 + 用户规则引用的分类
    const tags = new Set<string>(STATIC_RULES);
    for (const r of db.getRules()) {
      for (const d of r.domains || []) {
        if (d.startsWith('geosite:')) tags.add(`geosite-${d.slice(8)}`);
      }
      for (const ip of r.ip || []) {
        if (ip.startsWith('geoip:')) tags.add(`geoip-${ip.slice(6)}`);
      }
    }

  const coreRunning = SingBoxManager.getInstance().getState() === 'running';
  const proxyPort = coreRunning ? db.getSettings().mixedPort : undefined;

  // 应用内置的规则文件目录:某个规则集下载失败时回退复制,保证 data/rules 文件集完整
  // (生成的配置按文件存在性切换本地/远程,缺文件会导致配置校验失败)
  const bundledCandidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'rules') : '',
    path.join(path.dirname(process.execPath || ''), 'resources', 'bin', 'rules'),
    path.join(process.cwd(), 'bin', 'rules'),
  ];
  const bundledDir = bundledCandidates.find((c) => c && fs.existsSync(path.join(c, 'geosite-cn.srs')));

  const updated: string[] = [];
  const failed: string[] = [];
  for (const tag of tags) {
    const kind = tag.startsWith('geosite-') ? 'geosite' : 'geoip';
    const relPath = `${kind}/${tag.replace(/^(geosite|geoip)-/, '')}.srs`;
    const target = path.join(rulesDir, `${tag}.srs`);
    try {
      const buf = await fetchSrs(relPath, { coreRunning, proxyPort });
      fs.writeFileSync(target, buf);
      updated.push(tag);
    } catch (e: any) {
      // 下载失败:若目标文件尚不存在,从内置目录补齐,保证配置始终可生成
      const bundledFile = bundledDir ? path.join(bundledDir, `${tag}.srs`) : '';
      if (!fs.existsSync(target) && bundledFile && fs.existsSync(bundledFile)) {
        fs.copyFileSync(bundledFile, target);
      }
      failed.push(`${tag}: ${e.message}`);
    }
  }
  return { updated, failed, coreRunning };
}
}
