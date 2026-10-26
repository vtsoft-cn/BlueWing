/**
 * hosts 映射修复方向验证:
 * A) 去掉 route.default_domain_resolver —— 出站解析是否会走路由规则(predefined)
 * B) dns.hosts 字段 —— 1.14.3 是否支持(check + 运行时)
 * C) 对照:现行为(default_domain_resolver=direct-dns,已知 502)
 * 用法:npx tsx scripts/vpn-hosts-fixvariants.ts
 */
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ConfigGenerator } from '../src/main/core/ConfigGenerator';
import { Database } from '../src/main/db/Database';
import { AppSettings, DnsConfig, HostsRecord, ProxyNode } from '../src/types';

const tmp = path.join(os.tmpdir(), 'bw-hosts-probe');
Database.getInstance(tmp);
const node: ProxyNode = { id: 'n1', name: 't', type: 'socks', server: '1.2.3.4', port: 1, groupId: 'g' };
const hosts: HostsRecord[] = [{ id: 'h1', domain: 'hostcheck.test', ip: '127.0.0.1', enabled: true }];
const dns: DnsConfig = {
  mode: 'standard', remoteDns: 'https://1.1.1.1/dns-query', directDns: '223.5.5.5',
  fakeIpRange: '198.18.0.0/15', enableDnsRouting: true, servers: [], hosts,
};
const settings: AppSettings = {
  theme: 'system', language: 'zh-CN', startOnBoot: false, startMinimized: false,
  autoConnectOnLaunch: false, closeToTray: true,
  mixedPort: 12880, allowLan: false, inboundAuth: false, systemProxyEnabled: false, systemProxyBypassLan: true,
  tunEnabled: false, tunMtu: 9000, tunStack: 'native', tunAutoRoute: true, tunStrictRoute: false,
  tunDnsHijack: true, tunIPv6: false, tunEndpointIndependentNat: true,
  dnsCache: false, routingMode: 'direct', logLevel: 'warn',
  clashApiEnabled: false, clashApiPort: 19191,
  testUrl: 'http://x', testTimeoutMs: 1000, testConcurrent: 1,
  webdav: { serverUrl: '', username: '', password: '', remotePath: 'x', autoSync: false },
};

function variant(label: string, mutate: (cfg: Record<string, any>) => void): void {
  const cfg = ConfigGenerator.generate('n1', [node], [], [], dns, settings);
  mutate(cfg);
  const cfgPath = path.join(tmp, `var-${label}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const chk = spawnSync(path.resolve('bin/sing-box.exe'), ['check', '-c', cfgPath], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } });
  if (chk.status !== 0) {
    console.log(`[${label}] check FAIL: ${(chk.stderr || '').split('\n').filter(Boolean).slice(-1)[0]}`);
    return;
  }
  const core = spawn(path.resolve('bin/sing-box.exe'), ['run', '-c', cfgPath], { windowsHide: true, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } });
  const http = spawn('python', ['-m', 'http.server', '18080', '--bind', '127.0.0.1'], { windowsHide: true });
  setTimeout(() => {
    const hit = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', '-x', 'http://127.0.0.1:12880', 'http://hostcheck.test:18080/ping'], { encoding: 'utf8', timeout: 15000 });
    const code = hit.stdout.trim();
    console.log(`[${label}] check PASS; 经代理映射域名 -> HTTP ${code} ${code === '404' ? '→ 命中映射!(404=到达本地服务)' : code === '200' ? '→ 命中映射!' : '→ 未生效'}`);
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(core.pid)], { stdio: 'ignore' }); } catch {}
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(http.pid)], { stdio: 'ignore' }); } catch {}
  }, 3500);
}

variant('A2-deprecated-env', (cfg) => { delete cfg.route.default_domain_resolver; });
//, (cfg) => { (cfg.dns as any).hosts = { 'hostcheck.test': ['127.0.0.1'] }; }), 8000);
setTimeout(() => variant('C-现状对照', () => {}), 16000);
setTimeout(() => process.exit(0), 25000);
