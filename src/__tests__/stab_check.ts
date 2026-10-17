// 运行时稳定性验证:ConfigGenerator 生成完整配置(独立端口,避开用户正在使用的 2080/9090),
// 以真实 sing-box 进程运行 8 秒——内置规则集应零网络加载、进程存活无 FATAL。
import { ConfigGenerator } from '../../src/main/core/ConfigGenerator';
import { ProxyNode, DnsConfig, AppSettings } from '../../src/types';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const node: ProxyNode = {
  id: 'stab-test',
  name: 'stab-direct',
  type: 'socks',
  server: '127.0.0.1',
  port: 1080,
  groupId: 'default',
} as ProxyNode;

const dns: DnsConfig = {
  mode: 'standard',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: '223.5.5.5',
  fakeIpRange: '198.18.0.0/15',
  enableDnsRouting: true,
  servers: [],
} as DnsConfig;

const settings: AppSettings = {
  theme: 'light', language: 'zh-CN', startOnBoot: false, startMinimized: false, autoConnectOnLaunch: false,
  closeToTray: true, mixedPort: 31280, allowLan: false, inboundAuth: false, systemProxyEnabled: false,
  systemProxyBypassLan: true, tunEnabled: false, tunMtu: 9000, tunStack: 'system', tunAutoRoute: true,
  tunStrictRoute: false, tunDnsHijack: true, tunIPv6: false, routingMode: 'rule', logLevel: 'info',
  clashApiEnabled: true, clashApiPort: 39090, testUrl: 'http://cp.cloudflare.com/generate_204',
  testTimeoutMs: 5000, testConcurrent: 8, webdav: { serverUrl: '', username: '', password: '', remotePath: '', autoSync: false },
} as AppSettings;

const config = ConfigGenerator.generate('stab-test', [node], [], [], dns, settings);

// 断言:基础规则集全部本地化
const localRs = (config.route.rule_set || []).filter((r: any) => ['geosite-cn','geoip-cn','geosite-category-ads-all','geoip-private'].includes(r.tag));
if (localRs.length !== 4 || localRs.some((r: any) => r.type !== 'local')) {
  console.error('FAIL: 基础规则集未全部本地化', localRs.map((r: any) => r.tag + ':' + r.type));
  process.exit(1);
}
console.log('规则集本地化 OK:', localRs.map((r: any) => r.tag).join(', '));

const cfgPath = path.join(__dirname, 'stab_test_config.json');
fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');

// 端口预检(避免与用户运行中的实例冲突)
for (const port of [31280, 31281, 39090]) {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `if (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`]);
  } catch {
    console.error(`SKIP: 端口 ${port} 被占用,可能用户实例正在运行——本次跳过运行时验证`);
    process.exit(0);
  }
}

const exe = path.resolve(__dirname, '../../bin/sing-box.exe');
const child = spawn(exe, ['run', '-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

const startedAt = Date.now();
setTimeout(() => {
  const alive = !child.killed && child.exitCode === null;
  const fatal = /FATAL/.test(out);
  fs.unlinkSync(cfgPath);
  if (alive && !fatal) {
    console.log(`PASS: 核心运行 ${Math.round((Date.now() - startedAt) / 1000)}s 存活,无 FATAL,规则集零网络加载`);
    child.kill();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error('FAIL: 核心异常退出或 FATAL:\n' + out.slice(0, 2000));
    child.kill();
    process.exit(1);
  }
}, 8000);
child.on('exit', (code) => {
  if (Date.now() - startedAt < 7000) {
    console.error(`FAIL: 核心提前退出(code=${code}):\n` + out.slice(0, 2000));
    process.exit(1);
  }
});
