import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { VpnProfile, VpnProfileType } from '../../../types';
import { VpnEngine, VpnEngineContext } from './EngineContract';
import { WindowsNetQuery, psEscape, classifyAdapterRoutes } from './WindowsNetQuery';

/**
 * Windows 原生 RAS 引擎(IKEv2 / L2TP / SSTP)——零第三方二进制依赖。
 *
 * 连接:Add-VpnConnection 建电话簿条目(按用户,无需管理员)→ rasdial 拨号
 * (凭据经 argv 传递,与系统 rasdial 常规用法一致)→ 轮询 WAN Miniport 适配器
 * Up → 查询路由/DNS 上报。断开:rasdial /disconnect + Remove-VpnConnection
 * 清掉电话簿条目,系统不残留。
 *
 * splitTunnel(默认开):-SplitTunneling $true 让 RAS 只落地服务端下发的内网
 * 路由、不接管默认路由;配合应用侧 custody 移交或 OS 路由直通两种模式。
 */

const TUNNEL_TYPE_MAP: Record<string, string> = {
  ikev2: 'Ikev2',
  l2tp: 'L2tp',
  sstp: 'Sstp',
};

const ADAPTER_DESC_MAP: Record<string, string> = {
  ikev2: 'WAN Miniport (IKEv2)',
  l2tp: 'WAN Miniport (L2TP)',
  sstp: 'WAN Miniport (SSTP)',
};

/** rasdial 常见退出码 → 可读原因 */
export function describeRasdialExitCode(code: number): string {
  switch (code) {
    case 0:
      return '连接成功';
    case 691:
      return '认证失败:用户名、密码或 L2TP 预共享密钥不正确';
    case 623:
      return '电话簿条目未找到';
    case 628:
      return '连接被服务器关闭(隧道协议或证书协商失败)';
    case 678:
      return '服务器无响应(地址或端口不可达)';
    case 692:
      return '硬件/端口错误';
    case 721:
      return '远端无应答';
    case 809:
      return '无法建立计算机与 VPN 服务器之间的网络连接(防火墙/NAT 或 UDP 500/4500 被拦)';
    case 789:
      return 'L2TP 安全协商失败:预共享密钥不匹配,或 UDP 500/4500 被拦截';
    case 800:
      return '无法建立 VPN 连接(服务器不可达或连接类型不匹配)';
    case 812:
      return '服务器策略拒绝该连接(认证方法不匹配)';
    case 13801:
      return 'IKEv2 服务器证书校验失败或未配置为接受 EAP';
    case 13806:
      return 'IKEv2 机器证书不可用';
    default:
      return `RAS 拨号失败(错误码 ${code})`;
  }
}

/** 电话簿条目名:ASCII + 档案 id,稳定可重拨、可幂等删除 */
export function rasEntryName(profile: VpnProfile): string {
  const safeId = profile.id.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'x';
  return `BlueWing VPN ${safeId}`;
}

/**
 * 直接改写电话簿内容中的 L2TP PSK(纯函数,供单测)。
 * 背景:本机(Windows 10 19045)实测 VpnClient cmdlet 对 L2tpPsk 全面失效——
 * Add-VpnConnection 静默丢弃 PSK 值(仅落 IpSecFlags=1),Set-VpnConnection 直接
 * NullReferenceException 崩溃;而 rasphone.pbk 本就是 RAS 的原生存储,直写
 * `IpSecFlags=1` + `L2tpPsk=<psk>` 即为业界部署脚本的标准绕法。
 * 返回改写后的完整内容;条目节不存在返回 null(调用方放弃,走 cmdlet 原值)。
 */
export function patchPhonebookPsk(content: string, entryName: string, psk: string): string | null {
  const lines = content.split(/\r?\n/);
  const sectionStart = lines.findIndex((l) => l.trim() === `[${entryName}]`);
  if (sectionStart < 0) return null;
  const sectionEnd = lines.findIndex((l, i) => i > sectionStart && l.trim().startsWith('['));
  const end = sectionEnd < 0 ? lines.length : sectionEnd;

  let flagsIdx = -1;
  let pskIdx = -1;
  for (let i = sectionStart; i < end; i++) {
    if (/^IpSecFlags=/.test(lines[i])) flagsIdx = i;
    if (/^L2tpPsk=/.test(lines[i])) pskIdx = i;
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (pskIdx >= 0) {
    lines[pskIdx] = `L2tpPsk=${psk}`;
  } else if (flagsIdx >= 0) {
    lines.splice(flagsIdx + 1, 0, `L2tpPsk=${psk}`);
  } else {
    lines.splice(end, 0, `IpSecFlags=1`, `L2tpPsk=${psk}`);
  }
  if (flagsIdx >= 0) lines[flagsIdx] = 'IpSecFlags=1';
  return lines.join(eol);
}

export class RasVpnEngine implements VpnEngine {
  public readonly engineName = 'ras';
  private profile: VpnProfile | null = null;
  private entryName = '';
  private stopped = false;

  public async start(ctx: VpnEngineContext): Promise<void> {
    this.profile = ctx.profile;
    this.stopped = false;
    const { profile } = ctx;
    const tunnelType = TUNNEL_TYPE_MAP[profile.type as string];
    if (!tunnelType) {
      ctx.onError(`不支持的 RAS 隧道类型: ${profile.type}`);
      return;
    }
    if (!profile.server) {
      ctx.onError('缺少服务器地址');
      return;
    }
    this.entryName = rasEntryName(profile);

    // 1) 幂等重建电话簿条目(遗留条目直接覆盖,-Force)
    const pskPart =
      profile.type === 'l2tp' && profile.l2tpPsk
        ? ` -L2tpPsk '${psEscape(profile.l2tpPsk)}'`
        : '';
    const suffixPart = profile.dnsSuffix ? ` -DnsSuffix '${psEscape(profile.dnsSuffix)}'` : '';
    const addScript =
      `Remove-VpnConnection -Name '${psEscape(this.entryName)}' -Force -ErrorAction SilentlyContinue; ` +
      `$null = Add-VpnConnection -Name '${psEscape(this.entryName)}' ` +
      `-ServerAddress '${psEscape(profile.server)}' -TunnelType ${tunnelType} ` +
      `-SplitTunneling:$${profile.splitTunnel === false ? 'false' : 'true'} -Force${pskPart}${suffixPart}; ` +
      `if ($?) { 'ok' } else { 'fail' }`;
    const addOut = await WindowsNetQuery.runPowerShell(addScript, 15000);
    if (!addOut.trim().endsWith('ok')) {
      ctx.onError('创建 Windows VPN 连接条目失败(Add-VpnConnection)');
      return;
    }
    if (this.stopped) return;

    // L2TP PSK 补丁:cmdlet 在部分 Windows 构建上静默丢弃 -L2tpPsk(实测 19045:
    // 条目仅落 IpSecFlags=1 而无 L2tpPsk 值,IKE 协商必败/789)。直写电话簿兜底。
    if (profile.type === 'l2tp' && profile.l2tpPsk) {
      const patched = this.applyPhonebookPsk(this.entryName, profile.l2tpPsk);
      if (patched) {
        ctx.onLog('info', '已直写电话簿补全 L2TP 预共享密钥(cmdlet 在此 Windows 构建上不可靠)');
      } else {
        ctx.onLog('warn', 'L2TP 预共享密钥直写电话簿失败:未找到条目,继续按 cmdlet 结果拨号');
      }
    }

    // 2) rasdial 拨号:凭据经参数传递(仅用户名密码认证;证书认证的 IKEv2 不适用)
    const dialArgs = profile.username
      ? [this.entryName, profile.username, profile.password || '']
      : [this.entryName];
    const dialCode = await this.rasdial(dialArgs);
    if (dialCode !== 0) {
      ctx.onError(describeRasdialExitCode(dialCode));
      await this.cleanupEntry();
      return;
    }
    if (this.stopped) {
      await this.cleanupEntry();
      return;
    }

    // 3) 轮询 WAN Miniport 适配器 Up(RAS 拨号成功到适配器就绪有短暂延迟)
    const descPattern = ADAPTER_DESC_MAP[profile.type as string] || '';
    let adapter = await WindowsNetQuery.findAdapterByDescription([descPattern]);
    for (let i = 0; i < 10 && !adapter && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      adapter = await WindowsNetQuery.findAdapterByDescription([descPattern]);
    }
    if (!adapter) {
      ctx.onError('拨号成功但未能定位 VPN 网卡(WAN Miniport)');
      await this.disconnect();
      return;
    }

    // 4) 上报网络事实:直连子网(含 VPN 网关/DNS)计入内网段供分流;
    //    classify 内部已把直连子网从"可移交路由"中剔除(custody 安全),此处补回
    const network = await WindowsNetQuery.getAdapterNetwork(adapter.interfaceIndex);
    if (this.stopped) return;
    const { corp, fullTunnel } = classifyAdapterRoutes(network.routes, network.connectedPrefix);
    const routes = corp.concat(network.connectedPrefix && !corp.includes(network.connectedPrefix) ? [network.connectedPrefix] : []);
    ctx.onLog(
      'info',
      `RAS 连接建立:网卡 ${adapter.name},内网段 ${routes.length} 个${fullTunnel ? '(服务端下发了全隧道路由,已按分流处理)' : ''}`
    );
    ctx.onConnected();
    ctx.onNetworkInfo({
      adapterName: adapter.name,
      routes,
      dnsServers: network.dnsServers,
      domainSuffixes: network.domainSuffixes.concat(profile.dnsSuffix ? [profile.dnsSuffix] : []),
      ipv4: network.ipv4,
      installedOsRoutes: true,
    });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    if (!this.entryName) return;
    await this.rasdial([this.entryName, '/disconnect']);
    await this.cleanupEntry();
  }

  private async cleanupEntry(): Promise<void> {
    if (!this.entryName) return;
    const script = `Remove-VpnConnection -Name '${psEscape(this.entryName)}' -Force -ErrorAction SilentlyContinue; 'done'`;
    await WindowsNetQuery.runPowerShell(script, 10000);
  }

  /** 将 L2TP PSK 直写当前用户电话簿(Add-VpnConnection 已建好条目之后调用) */
  private applyPhonebookPsk(entryName: string, psk: string): boolean {
    try {
      // 电话簿按 ANSI 字节读写,非 ASCII 的 PSK 无法安全直写(需 cp936 编码,放弃并回退)
      if (!/^[\x20-\x7e]+$/.test(psk)) return false;
      const pbkPath = path.join(
        process.env.APPDATA || '',
        'Microsoft', 'Network', 'Connections', 'Pbk', 'rasphone.pbk'
      );
      if (!process.env.APPDATA || !fs.existsSync(pbkPath)) return false;
      // latin1 字节保真往返:电话簿在中文系统是 ANSI(cp936),utf-8 读写会破坏字节
      const content = fs.readFileSync(pbkPath, 'latin1');
      const patched = patchPhonebookPsk(content, entryName, psk);
      if (patched === null) return false;
      const tmpPath = `${pbkPath}.bwtmp`;
      fs.writeFileSync(tmpPath, patched, 'latin1');
      fs.renameSync(tmpPath, pbkPath);
      return true;
    } catch {
      return false;
    }
  }

  /** 直拉 rasdial.exe(参数化 argv,不经 shell 拼接);返回退出码,异常返回 -1 */
  private rasdial(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      try {
        const proc = spawn('rasdial.exe', args, { windowsHide: true });
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve(-1);
        }, 90000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(-1);
        });
      } catch {
        resolve(-1);
      }
    });
  }
}
