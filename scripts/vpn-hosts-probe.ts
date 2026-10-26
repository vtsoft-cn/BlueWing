/**
 * 应用内 Hosts 映射端到端探针:
 * 1. 用 ConfigGenerator 生成带 hosts 映射(hostcheck.test -> 127.0.0.1)的真实配置;
 * 2. 本机 18080 起响应服务;拉起 sing-box(mixed 12880);
 * 3. curl 经代理访问 hostcheck.test:18080 —— 200 = 映射生效;失败 = 未生效;
 * 4. 对照组:不存在的域名应失败(排除"任何域名都通"假象);
 * 5. fakeip 模式重复主测。
 * 用法:npx tsx scripts/vpn-hosts-probe.ts
 */
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { ConfigGenerator } from '../src/main/core/ConfigGenerator';
import { Database } from '../src/main/db/Database';
import { AppSettings, DnsConfig, HostsRecord, ProxyNode, RouteRule } from '../src/types';

const tmp = path.join(os.tmpdir(), 'bw-hosts-probe');
Database.getInstance(tmp);

const node: ProxyNode = { id: 'n1', name: 't', type: 'socks', server: '1.2.3.4', port: 1, groupId: 'g' };

function makeDns(mode: 'standard' | 'fakeip'): DnsConfig {
  const hosts: HostsRecord[] = [
    { id: 'h1', domain: 'hostcheck.test', ip: '127.0.0.1', enabled: true, remark: 'probe' },
  ];
  return {
    mode,
    remoteDns: 'https://1.1.1.1/dns-query',
    directDns: '223.5.5.5',
    fakeIpRange: '198.18.0.0/15',
    enableDnsRouting: true,
    servers: [],
    hosts,
  };
}

function makeSettings(): AppSettings {
  return {
    theme: 'system', language: 'zh-CN', startOnBoot: false, startMinimized: false,
    autoConnectOnLaunch: false, closeToTray: true,
    mixedPort: 12880, allowLan: false, inboundAuth: false, systemProxyEnabled: false, systemProxyBypassLan: true,
    tunEnabled: false, tunMtu: 9000, tunStack: 'native', tunAutoRoute: true, tunStrictRoute: false,
    tunDnsHijack: true, tunIPv6: false, tunEndpointIndependentNat: true,
    dnsCache: false, // 排除 DNS 缓存干扰
    routingMode: 'rule', // 复刻用户实例:兜底=代理出站(节点指向不可达地址,模拟'域名进代理即死')
    logLevel: 'debug',
    clashApiEnabled: true, clashApiPort: 19191,
    testUrl: 'http://x', testTimeoutMs: 1000, testConcurrent: 1,
    webdav: { serverUrl: '', username: '', password: '', remotePath: 'x', autoSync: false },
  };
}

function curl(url: string): { code: number; out: string } {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', '-x', 'http://127.0.0.1:12880', url], { encoding: 'utf8', timeout: 15000 });
  return { code: Number(r.stdout.trim()) || 0, out: r.stderr || '' };
}

function runCoreOnce(label: string, dns: DnsConfig): void {
  const cfg = ConfigGenerator.generate('n1', [node], [] as RouteRule[], [], dns, makeSettings());
  const cfgPath = path.join(tmp, `cfg-${dns.mode}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  // 断言配置里确实有 predefined hosts 规则
  const hostsRule = cfg.dns.rules.find((r: any) => r.action === 'predefined');
  console.log(`[${label}] predefined 规则: ${JSON.stringify(hostsRule?.domain)} answer=${JSON.stringify(hostsRule?.answer)}`);
  if (!hostsRule) console.log(`[${label}] !! 配置中没有 hosts 规则——生成层已丢`);

  const core = spawn(path.resolve('bin/sing-box.exe'), ['run', '-c', cfgPath], { windowsHide: true, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } });
  let log = '';
  core.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  core.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const http = spawn('python', ['-m', 'http.server', '18080', '--bind', '127.0.0.1'], { windowsHide: true });

  setTimeout(() => {
    // 直连对照:确认响应服务本身在
    const directCtl = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', 'http://127.0.0.1:18080/ping'], { encoding: 'utf8', timeout: 10000 });
    console.log(`[${label}] 直连对照 127.0.0.1:18080 -> HTTP ${directCtl.stdout.trim()} (非 200=响应服务没起来,结论无效)`);
    const hit = curl('http://hostcheck.test:18080/ping');
    const miss = curl('http://nonexistent-xyz.test:18080/ping');
    // 关键对照:经代理直拨回环地址——排除"sing-box 禁止 direct 出站拨 127.0.0.1"的假象
    const loop = curl('http://127.0.0.1:18080/ping');
    console.log(`[${label}] 映射域名 hostcheck.test -> HTTP ${hit.code} ${hit.code === 200 ? '(命中映射!)' : '(未生效)'}`);
    console.log(`[${label}] 对照 nonexistent-xyz -> HTTP ${miss.code} ${miss.code === 200 ? '(!!异常通)' : '(预期失败)'}`);
    console.log(`[${label}] 经代理拨 127.0.0.1 -> HTTP ${loop.code} (404=能拨回环,解析才是死因)`);
    // Clash API 直探 DNS 模块内部:规则命中与否的判别器
    const q = spawnSync('curl', ['-s', '--max-time', '5', 'http://127.0.0.1:19191/dns/query?name=hostcheck.test&type=A'], { encoding: 'utf8', timeout: 10000 });
    console.log(`[${label}] /dns/query hostcheck.test -> ${q.stdout.trim().slice(0, 300) || '(空)'}`);
    console.log(`[${label}] 核心日志(全部尾部):\n  ` + log.split('\n').slice(-14).join('\n  '));
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(core.pid)], { stdio: 'ignore' }); } catch {}
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(http.pid)], { stdio: 'ignore' }); } catch {}
  }, 4000);
}

fs.mkdirSync(tmp, { recursive: true });
runCoreOnce('standard', makeDns('standard'));
setTimeout(() => runCoreOnce('fakeip', makeDns('fakeip')), 9000);
setTimeout(() => process.exit(0), 19000);
