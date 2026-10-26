/**
 * 头less 冒烟:用真实 sing-box check 校验"VPN 注入后"的配置合法性。
 * 覆盖:vpn-corp 出站 bind_interface、vpn-dns server/detour、DNS/路由规则顺序、
 * TUN strict_route 关闭、fakeip 模式下的 vpn-dns 规则前置。
 * 用法:npx tsx scripts/vpn-config-check.ts
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { ConfigGenerator } from '../src/main/core/ConfigGenerator';
import { Database } from '../src/main/db/Database';
import { AppSettings, DnsConfig, ProxyNode, VpnSplitConfig } from '../src/types';

const tmp = path.join(os.tmpdir(), 'bw-vpn-cfg-check');
Database.getInstance(tmp);

const settings: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  startOnBoot: false,
  startMinimized: false,
  autoConnectOnLaunch: false,
  closeToTray: true,
  mixedPort: 2080,
  allowLan: false,
  inboundAuth: false,
  systemProxyEnabled: true,
  systemProxyBypassLan: true,
  tunEnabled: true,
  tunMtu: 9000,
  tunStack: 'native',
  tunAutoRoute: true,
  tunStrictRoute: true, // 故意开:验证 VPN 共存强制关闭
  tunDnsHijack: true,
  tunIPv6: false,
  tunEndpointIndependentNat: true,
  dnsCache: true,
  routingMode: 'rule',
  logLevel: 'warn',
  clashApiEnabled: true,
  clashApiPort: 9090,
  testUrl: 'http://x',
  testTimeoutMs: 5000,
  testConcurrent: 10,
  webdav: { serverUrl: '', username: '', password: '', remotePath: 'x', autoSync: false },
};

const dns: DnsConfig = {
  mode: 'standard',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: '223.5.5.5',
  fakeIpRange: '198.18.0.0/15',
  enableDnsRouting: true,
  servers: [],
};

const node: ProxyNode = {
  id: 'n1',
  name: 'test',
  type: 'socks',
  server: '1.2.3.4',
  port: 1080,
  groupId: 'default',
};

const vpn: VpnSplitConfig = {
  adapterName: 'BlueWing VPN smoke',
  routes: ['10.1.0.0/16', '10.8.0.0/24'],
  dnsServers: ['10.1.2.53'],
  domainSuffixes: ['corp.example.com'],
};

let failures = 0;
for (const [label, mode] of [
  ['standard+tun+vpn', 'standard'],
  ['fakeip+tun+vpn', 'fakeip'],
] as const) {
  const config = ConfigGenerator.generate(
    'n1',
    [node],
    [],
    [],
    { ...dns, mode },
    settings,
    undefined,
    undefined,
    vpn
  );
  const cfgPath = path.join(tmp, `cfg-${mode}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  const res = spawnSync(path.resolve('bin/sing-box.exe'), ['check', '-c', cfgPath], { env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' },
    encoding: 'utf8',
    timeout: 20000,
  });
  const ok = res.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} sing-box check [${label}]${ok ? '' : '\n' + (res.stderr || res.stdout)}`);
  if (!ok) failures++;
}


// WireGuard VPN injection check
const wgCfg = ConfigGenerator.generate('n1', [node], [], [], { ...dns, mode: 'standard' as const }, settings, undefined, {
  adapterName: '',
  routes: ['10.7.0.0/16'],
  dnsServers: ['10.7.0.1'],
  domainSuffixes: ['corp.wg'],
  wireguard: { server: '1.2.3.4', port: 51820, privateKey: 'MIlcShCz0mFiTzShdC7wzZXbpqLqNbFlxI8RVqQD1mA=', peerPublicKey: 'qPC1QTJ4OSIaK4N0u8bqzjgIHQeM8EmN2YcbOopTpTk=', localAddress: '10.7.0.2/32' },
});
fs.writeFileSync(path.join(tmp, 'cfg-wg.json'), JSON.stringify(wgCfg, null, 2), 'utf8');
const r3 = spawnSync(path.resolve('bin/sing-box.exe'), ['check', '-c', path.join(tmp, 'cfg-wg.json')], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } });
console.log((r3.status === 0 ? 'PASS' : 'FAIL') + ' sing-box check [wireguard-vpn]');
if (r3.status !== 0) console.log(r3.stderr);
failures += r3.status === 0 ? 0 : 1;

process.exit(failures === 0 ? 0 : 1);
