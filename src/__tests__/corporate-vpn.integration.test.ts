import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import http from 'http';
import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { CorporateVpnSession as CorporateVpnManager } from '../main/vpn/CorporateVpnSession';
import { CredentialVault } from '../main/vpn/CredentialVault';
import { VpnCoreProcess } from '../main/vpn/VpnCoreProcess';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { SingBoxManager } from '../main/core/SingBoxManager';
import { ProxySelectionService } from '../main/core/ProxySelectionService';
import { Database } from '../main/db/Database';
import { LogManager } from '../main/log/LogManager';
import { applyCorporateConfig } from '../main/vpn/CorporateConfig';
import { AppSettings, DnsConfig, ProxyNode } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('A company VPN that rejects public traffic leaves CN local and foreign traffic on the proxy', { timeout: 120000 }, async (t) => {
  const cases = [
    { name: 'smart / public VPN denied', mode: 'split', proxy: true, domestic: 'DIRECT', foreign: 'PUBLIC', lan: 'DIRECT', denyPublic: true },
    { name: 'smart SoftEther / automatic TCP outlet', protocol: 'softether', mode: 'split', proxy: true, domestic: 'VPN', foreign: 'PUBLIC', lan: 'VPN', denyPublic: false },
    { name: 'all VPN / foreign proxy has priority', mode: 'vpn', proxy: true, domestic: 'VPN', foreign: 'PUBLIC', lan: 'VPN', denyPublic: false },
    { name: 'all VPN / no public proxy', mode: 'vpn', proxy: false, domestic: 'VPN', foreign: 'VPN', lan: 'VPN', denyPublic: false },
    { name: 'custom / domestic proxy and foreign direct', mode: 'custom', proxy: true, domestic: 'PUBLIC', foreign: 'DIRECT', lan: 'DIRECT', denyPublic: true,
      custom: { domestic: 'proxy', foreign: 'direct', lan: 'direct' } },
  ] as const;
  for (const policyCase of cases) await t.test(policyCase.name, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-cn-vpn-'));
  const prior = process.env.BLUEWING_DATA_DIR; process.env.BLUEWING_DATA_DIR = dir;
  let sb: ReturnType<typeof spawn> | undefined; const servers: net.Server[] = [], sockets = new Set<net.Socket>();
  t.after(async () => {
    if (sb) { const closed = new Promise(r => sb!.exitCode !== null ? r(null) : sb!.once('exit', r)); sb.kill(); await closed; }
    for (const s of sockets) s.destroy(); for (const s of servers) s.close();
    if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const companyAttempts: string[] = [];
  const serve = async (body: string, companyOnly = false) => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let stage = 0, data = Buffer.alloc(0);
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        if (stage === 0 && data.length >= 2 + data[1]) { data = data.subarray(2 + data[1]); socket.write(Buffer.from([5, 2])); stage = 1; }
        if (stage === 1 && data.length >= 2 + data[1] + 1) { const n = 2 + data[1] + 1 + data[2 + data[1]]; if (data.length < n) return; data = data.subarray(n); socket.write(Buffer.from([1, 0])); stage = 2; }
        if (stage === 2 && data.length >= 5) {
          const n = data[3] === 1 ? 10 : data[3] === 4 ? 22 : 7 + data[4]; if (data.length < n) return;
          const host = data[3] === 1 ? [...data.subarray(4, 8)].join('.') : data.subarray(5, 5 + data[4]).toString();
          if (companyOnly) {
            companyAttempts.push(host);
            if (policyCase.denyPublic && !['8.8.8.8', 'office.company.cn'].includes(host)) { socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); stage = 4; return; }
          }
          data = data.subarray(n); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1])); stage = 3;
        }
        if (stage === 3 && data.includes(Buffer.from('\r\n\r\n'))) { socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); stage = 4; }
      });
    }); servers.push(server); return listen(server);
  };
  const vpnPort = await serve('VPN', true), publicPort = await serve('PUBLIC');
  // Both mock SOCKS outlets use password authentication; no real site is contacted.
  const repo = new ProfileRepository(dir);
  const softether = 'protocol' in policyCase && policyCase.protocol === 'softether';
  const p = repo.save({ id: 'cn', name: 'Company only', protocol: softether ? 'softether' : 'easyconnect', gateway: { host: 'vpn.example.com', port: 10443 }, username: 'fixture', authMethod: 'auth/psw', loginDomain: softether ? 'fixture-hub' : '', trafficMode: policyCase.mode, autoDiscoverPrivate: softether, customRouting: 'custom' in policyCase ? policyCase.custom : undefined, tls: {}, targets: [{ domains: ['office.company.cn'], cidrs: ['8.8.8.8/32'] }], hosts: {}, bindInterface: '' });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8')); stored.profiles[0].socksPort = vpnPort; stored.profiles[0].dnsPort = await freePort(); fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
  const policy = new CorporatePolicy(dir); policy.prepare(repo.list()); const runtime = policy.runtime();
  const direct = await serve('DIRECT');
  const config = ConfigGenerator.generate('public', policyCase.proxy ? [{ id: 'public', name: 'Public', type: 'socks', server: '127.0.0.1', port: publicPort, username: 'test', password: 'test', groupId: 'test' }] : [], [], [],
    { mode: 'standard', remoteDns: '223.5.5.5', directDns: '223.5.5.5', servers: [] } as DnsConfig,
    { mixedPort: await freePort(), tunEnabled: false, routingMode: 'rule', clashApiEnabled: false, logLevel: 'debug' } as AppSettings, undefined, runtime);
  config.outbounds[config.outbounds.findIndex((r: any) => r.tag === 'direct')] = { type: 'socks', tag: 'direct', server: '127.0.0.1', server_port: direct, username: 'test', password: 'test', version: '5' };
  config.inbounds.find((r: any) => r.tag === 'speedtest-in').listen_port = await freePort();
  const file = path.join(dir, 'config.json'), binary = path.resolve('bin/sing-box.exe'); fs.writeFileSync(file, JSON.stringify(config)); execFileSync(binary, ['check', '-c', file], { windowsHide: true });
  const port = config.inbounds.find((r: any) => r.tag === 'mixed-in').listen_port;
  let log = ''; sb = spawn(binary, ['run', '-c', file], { windowsHide: true }); sb.stdout?.on('data', b => log += b); sb.stderr?.on('data', b => log += b);
  // Match the product's 20s startup budget on busy Windows hosts; exited cores fail immediately.
  let ready = false; const startupDeadline = Date.now() + 20000;
  while (Date.now() < startupDeadline) { if (sb.exitCode !== null) break; try { if ((await request(port, 'http://223.5.5.5/')).body === 'DIRECT') { ready = true; break; } } catch {} await sleep(100); }
  assert.ok(ready, log); const pid = sb.pid;
  assert.equal((await request(port, 'http://8.8.8.8/')).body, policyCase.proxy ? 'PUBLIC' : 'DIRECT', 'An inactive VPN intercepted a saved public target');
  policy.setProbe(p.id, 'company-on', repo.list());
  let active = false; for (let i = 0; i < 30; i++) { try { if ((await request(port, 'http://8.8.8.8/')).body === 'VPN') { active = true; break; } } catch {} await sleep(100); }
  assert.ok(active, log);
  assert.equal((await request(port, 'http://www.baidu.com/')).body, policyCase.domestic, log);
  assert.equal((await request(port, 'http://223.5.5.5/')).body, policyCase.domestic, log);
  assert.equal((await request(port, 'http://chatgpt.com/')).body, policyCase.foreign, log);
  assert.equal((await request(port, 'http://1.1.1.1/')).body, policyCase.foreign, log);
  assert.equal((await request(port, 'http://192.168.77.1/')).body, policyCase.lan, log);
  assert.equal((await request(port, 'http://8.8.8.8/')).body, 'VPN', log);
  assert.equal((await request(port, 'http://office.company.cn/')).body, 'VPN', log);
  assert.equal((await request(port, 'http://223.5.5.5:22/')).body, softether ? 'VPN' : policyCase.domestic, log);
  assert.equal((await request(port, 'http://223.5.5.5:23879/')).body, policyCase.domestic, log);
  if (policyCase.denyPublic) assert.ok(companyAttempts.every(host => ['8.8.8.8', 'office.company.cn'].includes(host)), 'Public traffic must never enter the company VPN');
  policy.deactivate(repo.list()); let restored = false;
  for (let i = 0; i < 30; i++) { if ((await request(port, 'http://223.5.5.5/')).body === 'DIRECT' && (await request(port, 'http://8.8.8.8/')).body === (policyCase.proxy ? 'PUBLIC' : 'DIRECT')) { restored = true; break; } await sleep(100); }
  assert.ok(restored, log); assert.equal(sb.pid, pid); assert.equal(sb.exitCode, null);
  assert.equal((await request(port, 'http://chatgpt.com/')).body, policyCase.proxy ? 'PUBLIC' : 'DIRECT', log);
  assert.equal((await request(port, 'http://8.8.8.8/')).body, policyCase.proxy ? 'PUBLIC' : 'DIRECT', 'Explicit disconnect must restore ordinary routing');
  });
});
test('Automatic private dispatch protects a learned TCP port after a failure and releases it on explicit disconnect', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-auto-private-'));
  const sockets = new Set<net.Socket>(), servers: net.Server[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child) { const closed = new Promise(r => child!.exitCode !== null ? r(null) : child!.once('exit', r)); child.kill(); await closed; }
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const attempted: string[] = [];
  const serve = async (body: string, automatic = false) => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      let stage = 0, data = Buffer.alloc(0);
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        if (stage === 0 && data.length >= 2 + data[1]) { data = data.subarray(2 + data[1]); socket.write(Buffer.from([5, 2])); stage = 1; }
        if (stage === 1 && data.length >= 3 + data[1]) {
          const n = 3 + data[1] + data[2 + data[1]]; if (data.length < n) return;
          data = data.subarray(n); socket.write(Buffer.from([1, 0])); stage = 2;
        }
        if (stage === 2 && data.length >= 5) {
          const n = data[3] === 1 ? 10 : data[3] === 4 ? 22 : 7 + data[4]; if (data.length < n) return;
          const host = data[3] === 1 ? [...data.subarray(4, 8)].join('.') : data.subarray(5, 5 + data[4]).toString();
          if (automatic) attempted.push(host + ':' + data.readUInt16BE(n - 2));
          data = data.subarray(n); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1])); stage = 3;
        }
        if (stage === 3 && data.includes(Buffer.from('\r\n\r\n'))) { socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); stage = 4; }
      });
    }); servers.push(server); return listen(server);
  };
  const autoPort = await serve('AUTO', true), localPort = await serve('LOCAL'), publicPort = await serve('PUBLIC');
  const repo = new ProfileRepository(dir), p = repo.save({ id: 'auto-private', name: 'Auto', protocol: 'softether', gateway: { host: 'vpn.example.com', port: 5555 }, username: 'fixture', loginDomain: 'VPN', authMethod: 'auth/psw', targets: [], hosts: {}, tls: {}, bindInterface: '' });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8')); stored.profiles[0].socksPort = autoPort; stored.profiles[0].dnsPort = await freePort(); fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
  const policy = new CorporatePolicy(dir); policy.prepare(repo.list());
  const config = ConfigGenerator.generate('public', [{ id: 'public', name: 'Public', type: 'socks', server: '127.0.0.1', port: publicPort, username: 'fixture', password: 'fixture', groupId: 'fixture' }], [], [],
    { mode: 'standard', remoteDns: '223.5.5.5', directDns: '223.5.5.5', servers: [] } as DnsConfig,
    { mixedPort: await freePort(), tunEnabled: false, routingMode: 'rule', clashApiEnabled: false, logLevel: 'warn' } as AppSettings, undefined, policy.runtime());
  config.experimental.cache_file.path = path.join(dir, 'cache.db').replace(/\\/g, '/');
  config.outbounds[config.outbounds.findIndex((o: any) => o.tag === 'direct')] = { tag: 'direct', type: 'socks', server: '127.0.0.1', server_port: localPort, username: 'fixture', password: 'fixture', version: '5' };
  config.inbounds.find((i: any) => i.tag === 'speedtest-in').listen_port = await freePort();
  const file = path.join(dir, 'config.json'), binary = path.resolve('bin/sing-box.exe'); fs.writeFileSync(file, JSON.stringify(config));
  execFileSync(binary, ['check', '-c', file], { windowsHide: true });
  child = spawn(binary, ['run', '-c', file], { windowsHide: true }); let log = ''; child.stderr?.on('data', b => log += b);
  const port = config.inbounds.find((i: any) => i.tag === 'mixed-in').listen_port;
  let ready = false; for (let i = 0; i < 40; i++) { try { if ((await request(port, 'http://192.168.77.12:22/')).body === 'LOCAL') { ready = true; break; } } catch {} await sleep(100); } assert.ok(ready, log);
  policy.setProbe(p.id, 'active', repo.list());
  let active = false; for (let i = 0; i < 30; i++) { if ((await request(port, 'http://192.168.77.12:22/')).body === 'AUTO') { active = true; break; } await sleep(100); } assert.ok(active, log);
  assert.equal((await request(port, 'http://223.5.5.5/')).body, 'AUTO', 'SoftEther uses the same automatic outlet for public TCP');
  assert.equal((await request(port, 'http://1.1.1.1/')).body, 'PUBLIC');
  assert.ok(attempted.every(value => ['192.168.77.12:22', '223.5.5.5:80'].includes(value)), 'Foreign proxy traffic entered automatic direct/VPN selection');
  policy.learn(p.id, { address: '192.168.77.12', port: 22, network: 'tcp', outlet: 'vpn' }, repo.list());
  policy.deactivate(repo.list(), true);
  let protectedPort = false;
  for (let i = 0; i < 30; i++) { try { protectedPort = !['AUTO', 'LOCAL'].includes((await request(port, 'http://192.168.77.12:22/')).body); } catch { protectedPort = true; } if (protectedPort) break; await sleep(100); }
  assert.ok(protectedPort, log);
  try { assert.notEqual((await request(port, 'http://192.168.77.12:22/')).body, 'LOCAL'); } catch (e) { if (e instanceof assert.AssertionError) throw e; }
  // The guard and automatic rule-set files are watched independently. Wait for
  // the automatic scope to deactivate before checking the other port.
  let otherPortLocal = false;
  for (let i = 0; i < 30; i++) { if ((await request(port, 'http://192.168.77.12:80/')).body === 'LOCAL') { otherPortLocal = true; break; } await sleep(100); }
  assert.ok(otherPortLocal, 'learned port expanded into whole-host ownership');
  policy.deactivate(repo.list());
  assert.equal(policy.discovery.targets(repo.get(p.id)).length, 1, 'Disconnect must retain discovery settings');
  let cleared = false; for (let i = 0; i < 30; i++) { try { if ((await request(port, 'http://192.168.77.12:22/')).body === 'LOCAL') { cleared = true; break; } } catch {} await sleep(100); } assert.ok(cleared, log);
});

const listen = (s: net.Server | http.Server, host = '127.0.0.1') =>
  new Promise<number>((resolve) =>
    s.listen(0, host, () => resolve((s.address() as net.AddressInfo).port)),
  );
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 30000 + Math.floor(Math.random() * 12000),
      s = net.createServer();
    const ok = await new Promise<boolean>((r) => {
      s.once('error', () => r(false));
      s.listen(port, '127.0.0.1', () => r(true));
    });
    if (ok) {
      await new Promise<void>((r) => s.close(() => r()));
      return port;
    }
  }
  throw new Error('No test port available');
}
function request(
  proxyPort: number,
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: url,
        headers: { Host: new URL(url).host },
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (b) => (body += b));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        res.on('error', reject);
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('Standalone VPN: no node and explicit direct mode resolve and reach ordinary internet directly', { timeout: 30000 }, async (t) => {
  for (const withSavedNode of [false, true]) await t.test(withSavedNode ? 'saved node with direct mode' : 'no proxy nodes', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-vpn-direct-'));
    const prior = process.env.BLUEWING_DATA_DIR;
    process.env.BLUEWING_DATA_DIR = dir;
    let core: VpnCoreProcess | undefined, sb: ReturnType<typeof spawn> | undefined;
    const servers: net.Server[] = [];
    const dnsServer = dgram.createSocket('udp4');
    t.after(async () => {
      await core?.stop();
      if (sb) {
        const stopped = new Promise(resolve => sb!.exitCode !== null ? resolve(null) : sb!.once('exit', resolve));
        sb.kill(); await stopped;
      }
      for (const server of servers) server.close();
      dnsServer.close();
      if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const queries: string[] = [];
    dnsServer.on('message', (query, remote) => {
      let end = 12; const labels: string[] = [];
      while (query[end]) { const length = query[end++]; labels.push(query.subarray(end, end + length).toString()); end += length; }
      end++;
      const isA = query.readUInt16BE(end) === 1;
      queries.push(labels.join('.'));
      const header = Buffer.from(query.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(isA ? 1 : 0, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 127, 0, 0, 1]);
      dnsServer.send(Buffer.concat([header, query.subarray(12, end + 4), ...(isA ? [answer] : [])]), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dnsServer.bind(0, '127.0.0.1', resolve));
    const dnsPort = dnsServer.address().port;
    const ordinary = http.createServer((_, res) => res.end('PUBLIC-DIRECT'));
    servers.push(ordinary); const ordinaryPort = await listen(ordinary);
    const companyTrap = http.createServer((_, res) => res.end('COMPANY-LEAK'));
    servers.push(companyTrap); const trapPort = await listen(companyTrap, '127.0.0.2');
    let proxyConnections = 0;
    const unusedProxy = net.createServer(socket => { proxyConnections++; socket.destroy(); });
    servers.push(unusedProxy); const unusedPort = await listen(unusedProxy);
    const repo = new ProfileRepository(dir);
    const p = repo.save({ id: 'standalone-fixture', name: 'Standalone fixture', protocol: 'easyconnect', gateway: { host: 'vpn.example.com', port: 10443 }, username: '', authMethod: 'auth/psw', loginDomain: '', rememberPassword: false, rememberSession: false, tls: {}, targets: [{ domains: ['dev.corp.example'], cidrs: [] }], hosts: { 'dev.corp.example': ['127.0.0.2'] }, bindInterface: '' });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'));
    stored.profiles[0].socksPort = await freePort(); stored.profiles[0].dnsPort = await freePort();
    fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
    const policy = new CorporatePolicy(dir); policy.setProbe(p.id, 'standalone', repo.list());
    const runtime = policy.runtime();
    core = new VpnCoreProcess(path.resolve('bin/bluewing-vpn-core.exe'));
    await core.request('configure', { endpoints: runtime.profiles.map(r => ({ profile: r.profile, user: r.socksUser, password: r.socksPassword })) });
    const mixedPort = await freePort();
    const nodes: ProxyNode[] = withSavedNode ? [{ id: 'unused', name: 'Unused proxy', type: 'socks', server: '127.0.0.1', port: unusedPort, groupId: 'test' }] : [];
    const config = ConfigGenerator.generate('unused', nodes, [
      { id: 'pinned', name: 'Old node rule', enabled: true, domains: ['full:ordinary.public.example'], outbound: 'unused' },
      { id: 'blocked', name: 'Blocked', enabled: true, domains: ['full:blocked.public.example'], outbound: 'block' },
    ], [], { mode: withSavedNode ? 'standard' : 'fakeip', remoteDns: 'udp://127.0.0.1:9', directDns: `udp://127.0.0.1:${dnsPort}`, fakeIpRange: '198.18.0.0/15', enableDnsRouting: true, servers: [] },
    { mixedPort, tunEnabled: false, systemProxyBypassLan: true, routingMode: withSavedNode ? 'direct' : 'rule', clashApiEnabled: false, dnsCache: false, logLevel: 'debug' } as AppSettings, undefined, runtime);
    config.inbounds.find((r: any) => r.tag === 'speedtest-in').listen_port = await freePort();
    const file = path.join(dir, 'config.json'), binary = path.resolve('bin/sing-box.exe');
    // 与应用运行时(SingBoxManager)一致:hosts/VPN 分流时配置省略 default_domain_resolver,
    // 需要该环境变量启用 sing-box 的兼容行为(check 与 run 成对携带)。
    const sbEnv = { windowsHide: true, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } };
    fs.writeFileSync(file, JSON.stringify(config)); execFileSync(binary, ['check', '-c', file], { ...sbEnv, timeout: 5000 });
    let log = ''; sb = spawn(binary, ['run', '-c', file], sbEnv);
    sb.stdout?.on('data', b => log += b); sb.stderr?.on('data', b => log += b);
    let response;
    for (let i = 0; i < 30; i++) { try { response = await request(mixedPort, `http://ordinary.public.example:${ordinaryPort}/`); break; } catch { await sleep(100); } }
    assert.equal(response?.body, 'PUBLIC-DIRECT', log);
    assert.ok(queries.includes('ordinary.public.example'), 'ordinary DNS must use the direct resolver');
    assert.equal((await request(mixedPort, `http://127.0.0.1:${ordinaryPort}/`)).body, 'PUBLIC-DIRECT');
    for (const url of [`http://dev.corp.example:${trapPort}/`, `http://127.0.0.2:${trapPort}/`, `http://blocked.public.example:${ordinaryPort}/`]) {
      try { const result = await request(mixedPort, url); assert.ok(!['PUBLIC-DIRECT', 'COMPANY-LEAK'].includes(result.body)); } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    }
    assert.equal(proxyConnections, 0, 'ordinary or company traffic must never use a saved proxy in direct mode');
    assert.ok(!queries.includes('dev.corp.example'), 'company DNS must never fall back to ordinary internet DNS');
    policy.deactivate(repo.list()); await sleep(400);
    assert.equal((await request(mixedPort, `http://127.0.0.2:${trapPort}/`)).body, 'COMPANY-LEAK', 'Manual disconnect must release prior company targets');
    assert.equal((await request(mixedPort, `http://ordinary.public.example:${ordinaryPort}/`)).body, 'PUBLIC-DIRECT');
  });
});
test('Running core switches node-free → proxy → direct → deleted/re-added proxy with company policy intact', { timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-switch-'));
  const prior = process.env.BLUEWING_DATA_DIR;
  process.env.BLUEWING_DATA_DIR = dir;
  Database.resetInstance();
  const db = Database.getInstance(dir);
  // Use an isolated manager instance; never touch the user's ports or system proxy.
  const manager: SingBoxManager = new (SingBoxManager as any)();
  t.mock.method(SingBoxManager, 'getInstance', () => manager);
  const sockets = new Set<net.Socket>();
  const resolver = dgram.createSocket('udp4');
  resolver.on('message', (query, remote) => {
    let end = 12; while (query[end]) end += query[end] + 1; end++;
    const isA = query.readUInt16BE(end) === 1;
    const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(isA ? 1 : 0, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 127, 0, 0, 1]);
    resolver.send(Buffer.concat([header, query.subarray(12, end + 4), ...(isA ? [answer] : [])]), remote.port, remote.address);
  });
  await new Promise<void>(r => resolver.bind(0, '127.0.0.1', r));
  const local = http.createServer((_, res) => res.end('PUBLIC-DIRECT'));
  const proxy = http.createServer((_, res) => res.end('PUBLIC-PROXY'));
  proxy.on('connect', (_, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString();
      if (pending.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nPUBLIC-PROXY');
    });
  });
  for (const server of [local, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  let native: VpnCoreProcess | undefined;
  t.after(async () => {
    await manager.stop(); await native?.stop();
    for (const socket of sockets) socket.destroy();
    local.close(); proxy.close();
    resolver.close();
    LogManager.getInstance().destroy();
    Database.resetInstance();
    if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const localPort = await listen(local), proxyPort = await listen(proxy);
  const mixedPort = await freePort();
  db.saveSettings({ mixedPort, tunEnabled: false, routingMode: 'rule', systemProxyBypassLan: false, clashApiEnabled: true, clashApiPort: await freePort() });
  db.saveRules([]); db.saveAppRules([]);
  db.saveDns({ mode: 'standard', remoteDns: 'udp://127.0.0.1:9', directDns: `udp://127.0.0.1:${resolver.address().port}`, enableDnsRouting: false, fakeIpRange: '198.18.0.0/15', servers: [] });
  const repo = new ProfileRepository(dir);
  const p = repo.save({ id: 'switch-company', name: 'Switch fixture', protocol: 'easyconnect', gateway: { host: 'vpn.example.com', port: 10443 }, username: '', authMethod: 'auth/psw', loginDomain: '', rememberPassword: false, rememberSession: false, tls: {}, targets: [{ domains: ['private.corp.example'], cidrs: ['127.0.0.2/32'] }], hosts: {}, bindInterface: '' });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'));
  stored.profiles[0].socksPort = await freePort(); stored.profiles[0].dnsPort = await freePort();
  fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
  const policy = new CorporatePolicy(dir); policy.setProbe(p.id, 'switching', repo.list());
  const runtime = policy.runtime();
  native = new VpnCoreProcess(path.resolve('bin/bluewing-vpn-core.exe'));
  await native.request('configure', { endpoints: runtime.profiles.map(r => ({ profile: r.profile, user: r.socksUser, password: r.socksPassword })) });
  const nativePid = (native as any).child.pid;
  const speedPort = await freePort();
  manager.setConfigEnricher(async config => {
    applyCorporateConfig(config, runtime);
    config.inbounds.find((i: any) => i.tag === 'speedtest-in').listen_port = speedPort;
  });
  const states: string[] = [];
  manager.on('stateChange', state => states.push(state));
  const initial = ConfigGenerator.generate('', [], [], [], db.getDns(), db.getSettings());
  assert.equal(await manager.start(initial), true);
  const url = `http://ordinary.public.example:${localPort}/`;
  const verify = async (expected: string) => {
    const actual = await request(mixedPort, url).catch(error => {
      throw new Error(`${expected} failed in mode ${db.getSettings().routingMode}: ${error.message}\n${LogManager.getInstance().getLogs().slice(-16).map(l => l.message).join('\n')}`);
    });
    assert.equal(actual.body, expected);
    const live = JSON.parse(manager.getLiveConfig());
    assert.equal(live.route.final, expected === 'PUBLIC-DIRECT' ? 'direct' : 'proxy');
    assert.equal(live.dns.servers.find((s: any) => s.tag === 'remote-dns').detour, expected === 'PUBLIC-DIRECT' ? undefined : 'proxy');
    assert.ok(live.route.rules.some((r: any) => r.rule_set?.includes(`corp-route-${p.id}`)));
    assert.ok(live.dns.rules.some((r: any) => r.server === `corp-dns-${p.id}`));
    const result = await request(mixedPort, `http://127.0.0.2:${localPort}/`).catch(() => undefined);
    assert.notEqual(result?.body, 'PUBLIC-DIRECT'); assert.notEqual(result?.body, 'PUBLIC-PROXY');
    assert.equal((native as any).child.pid, nativePid, 'public outlet changes must not restart the protocol process');
    assert.ok(!states.some(s => ['stopped', 'crashed', 'error'].includes(s)), 'controlled reload must not be reported as a VPN-disconnecting stop');
  };
  await verify('PUBLIC-DIRECT');
  const node: ProxyNode = { id: 'added', name: 'Proxy fixture', type: 'http', server: '127.0.0.1', port: proxyPort, groupId: 'test' };
  db.addNode(node);
  await ProxySelectionService.selectDirect(); // collection sync preserves the existing outlet
  await verify('PUBLIC-DIRECT');
  assert.equal((await ProxySelectionService.selectNode(node.id)).success, true);
  await verify('PUBLIC-PROXY');
  assert.equal((await ProxySelectionService.selectDirect()).success, true);
  await verify('PUBLIC-DIRECT');
  assert.equal((await ProxySelectionService.selectNode(node.id)).success, true);
  await verify('PUBLIC-PROXY');
  db.deleteNode(node.id);
  assert.equal((await ProxySelectionService.selectDirect()).success, true);
  await verify('PUBLIC-DIRECT');
  db.addNode({ ...node, id: 're-added' });
  await verify('PUBLIC-DIRECT');
  assert.equal((await ProxySelectionService.selectNode('re-added')).success, true);
  await verify('PUBLIC-PROXY');
  // Failed reloads and explicit stops still propagate a terminal state.
  const invalid = ConfigGenerator.generate('re-added', db.getNodes(), [], [], db.getDns(), db.getSettings());
  invalid.outbounds.find((o: any) => o.tag === 'proxy').default = 'missing-outbound';
  assert.equal(await manager.start(invalid), false);
  assert.ok(states.includes('error'));
  await manager.stop(); assert.equal(states.at(-1), 'stopped');
});

test(
  'Bundled native core and sing-box: company traffic fails closed while public/CN/LAN remain independent',
  { timeout: 30000 },
  async (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'bluewing-vpn-integration-'),
    );
    const prior = process.env.BLUEWING_DATA_DIR;
    process.env.BLUEWING_DATA_DIR = dir;
    const sockets = new Set<net.Socket>();
    const servers: net.Server[] = [];
    let core: VpnCoreProcess | undefined;
    let sb: ReturnType<typeof spawn> | undefined;
    t.after(async () => {
      for (const s of sockets) s.destroy();
      for (const server of servers) server.close();
      await core?.stop();
      if (sb) {
        const wait = new Promise((r) =>
          sb!.exitCode !== null ? r(null) : sb!.once('exit', r),
        );
        sb.kill();
        await wait;
      }
      if (prior === undefined) delete process.env.BLUEWING_DATA_DIR;
      else process.env.BLUEWING_DATA_DIR = prior;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let publicConnections = 0;
    const publicProxy = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      let stage = 0,
        pending = Buffer.alloc(0),
        targetPort = 0;
      s.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (stage === 0) {
          if (pending.length < 2) return;
          const count = pending[1];
          if (pending.length < count + 2) return;
          pending = pending.subarray(count + 2);
          s.write(Buffer.from([5, 0]));
          stage = 1;
        }
        if (stage === 1) {
          if (pending.length < 5) return;
          let end = 0;
          if (pending[3] === 3) end = 5 + pending[4];
          else if (pending[3] === 1) end = 8;
          else if (pending[3] === 4) end = 20;
          else {
            s.destroy();
            return;
          }
          if (pending.length < end + 2) return;
          targetPort = pending.readUInt16BE(end);
          pending = pending.subarray(end + 2);
          s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          stage = 2;
          publicConnections++;
        }
        if (stage === 2 && pending.length) {
          if (targetPort === 22) {
            s.write(pending);
            pending = Buffer.alloc(0);
          } else if (pending.includes('\r\n\r\n')) {
            const body = 'PUBLIC-ONLY';
            s.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
            );
            stage = 3;
          }
        }
      });
    });
    servers.push(publicProxy);
    const publicPort = await listen(publicProxy);
    const local = http.createServer((_, res) => res.end('DIRECT-ONLY'));
    servers.push(local);
    const localPort = await listen(local);
    const mixedPort = await freePort();
    const repo = new ProfileRepository(dir);
    let profile = repo.save({
      id: 'corp-fixture',
      name: 'Fixture',
      protocol: 'easyconnect',
      gateway: { host: 'vpn.example.com', port: 10443 },
      username: 'fixture',
      authMethod: 'auth/psw',
      loginDomain: '',
      rememberPassword: false,
      rememberSession: false,
      tls: {},
      targets: [
        {
          domains: ['dev.corp.example'],
          cidrs: ['127.0.0.2/32'],
          ports: ['80'],
        },
      ],
      hosts: {},
      bindInterface: '',
    });
    // Real native endpoints are bound by their owner; no external EZ4Connect process is used.
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'),
    );
    raw.profiles[0].socksPort = await freePort();
    raw.profiles[0].dnsPort = await freePort();
    fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(raw));
    repo.reload();
    profile = repo.get(profile.id);
    const policy = new CorporatePolicy(dir);
    policy.prepare(repo.list());
    policy.setProbe(profile.id, 'fixture', repo.list());
    const runtime = policy.runtime();
    core = new VpnCoreProcess(path.resolve('bin/bluewing-vpn-core.exe'));
    await core.request('configure', {
      endpoints: runtime.profiles.map((r) => ({
        profile: r.profile,
        user: r.socksUser,
        password: r.socksPassword,
      })),
    });
    const settings = {
      mixedPort,
      systemProxyBypassLan: true,
      tunEnabled: false,
      routingMode: 'rule',
      clashApiEnabled: false,
      dnsCache: false,
      logLevel: 'debug',
    } as AppSettings;
    const dns: DnsConfig = {
      mode: 'fakeip',
      remoteDns: 'udp://127.0.0.1:9',
      directDns: 'udp://127.0.0.1:9',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
      hosts: [
        { id: 'cn', domain: 'baidu.com', ip: '223.5.5.5', enabled: true },
        {
          id: 'public-fixture',
          domain: 'outside.public.example',
          ip: '198.51.100.23',
          enabled: true,
        },
      ],
    };
    const nodes: ProxyNode[] = [
      {
        id: 'public',
        name: 'Public fixture',
        type: 'socks',
        server: '127.0.0.1',
        port: publicPort,
        groupId: 'test',
      },
    ];
    const config = ConfigGenerator.generate(
      'public',
      nodes,
      [],
      [],
      dns,
      settings,
      undefined,
      runtime,
    );
    // The isolated test uses real predefined CN resolution instead of the all-domain fakeIP rule.
    config.dns.rules = config.dns.rules.filter(
      (r: any) => r.server !== 'fakeip-dns',
    );
    config.inbounds.find((r: any) => r.tag === 'speedtest-in').listen_port =
      await freePort();
    for (const rule of config.route.rules)
      if (rule.outbound === 'direct')
        Object.assign(rule, {
          override_address: '127.0.0.1',
          override_port: localPort,
        });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    const binary = path.resolve('bin/sing-box.exe');
    execFileSync(binary, ['check', '-c', file], {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' },
    });
    let log = '';
    sb = spawn(binary, ['run', '-c', file], { windowsHide: true, env: { ...process.env, ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true' } });
    sb.stdout?.on('data', (b) => (log += b));
    sb.stderr?.on('data', (b) => (log += b));
    let publicResponse;
    for (let i = 0; i < 30; i++) {
      try {
        publicResponse = await request(
          mixedPort,
          'http://outside.public.example/',
        );
        break;
      } catch {
        await sleep(100);
      }
    }
    // 该域名在 dns.hosts 中做了映射:合并后的生成器会把映射域名注入 direct 路由
    // 规则(Hosts 映射系统代理修复,先于代理兜底),连接按映射直连并经 override
    // 落到直连夹具,而不是按域名兜底走公网代理。
    assert.equal(publicResponse?.body, 'DIRECT-ONLY', log);
    const pid = sb.pid;
    const before = publicConnections;
    for (const url of [
      'http://127.0.0.2/',
      'http://127.0.0.2:9999/',
      'http://dev.corp.example/',
    ]) {
      try {
        const result = await request(mixedPort, url);
        assert.notEqual(result.body, 'PUBLIC-ONLY');
      } catch {
        /* Closed/refused is the expected offline result. */
      }
    }
    assert.equal(
      publicConnections,
      before,
      'company traffic escaped to public selector',
    );
    assert.equal(
      (await request(mixedPort, `http://baidu.com:${localPort}/`)).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, 'http://223.5.5.5/')).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, `http://127.0.0.1:${localPort}/`)).body,
      'DIRECT-ONLY',
    );
    assert.equal(
      (await request(mixedPort, 'http://outside.public.example/')).body,
      'DIRECT-ONLY',
    );
    const updated = repo.save({
      ...profile,
      targets: [
        ...profile.targets,
        { domains: ['new.corp.example'], cidrs: [], ports: ['80'] },
      ],
    });
    policy.update(
      profile.id,
      { targets: [], hosts: {}, dnsServers: [] },
      repo.list(),
    );
    await sleep(600);
    const afterUpdate = publicConnections;
    try {
      await request(mixedPort, 'http://new.corp.example/');
    } catch {}
    assert.equal(
      publicConnections,
      afterUpdate,
      'new company domain escaped during rule update',
    );
    assert.equal(sb.pid, pid);
    assert.equal(sb.exitCode, null);
    assert.equal(
      config.outbounds.find((o: any) => o.tag === 'proxy').default,
      'node-public',
    );
    assert.equal(updated.id, profile.id);
  },
);
test('A running public proxy installs a newly saved VPN on connect and skips the next routing reload', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-auto-routing-'));
  const prior = process.env.BLUEWING_DATA_DIR; process.env.BLUEWING_DATA_DIR = dir;
  Database.resetInstance();
  const db = Database.getInstance(), sb = SingBoxManager.getInstance();
  const proxy = http.createServer((_, res) => res.end('PUBLIC-PROXY')), sockets = new Set<net.Socket>();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let pending = '';
    socket.on('data', chunk => { pending += chunk.toString(); if (pending.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nPUBLIC-PROXY'); });
  });
  const proxyPort = await new Promise<number>(resolve => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as net.AddressInfo).port)));
  const mixedPort = await freePort(), speedPort = await freePort();
  db.saveSettings({ mixedPort, tunEnabled: false, routingMode: 'rule', clashApiEnabled: true, clashApiPort: await freePort() });
  db.saveRules([]); db.saveAppRules([]);
  // Hosts entries intentionally force direct routing; this fixture verifies
  // that an ordinary public destination keeps using the selected public proxy.
  db.saveDns({ mode: 'standard', remoteDns: 'udp://127.0.0.1:9', directDns: 'udp://127.0.0.1:9', enableDnsRouting: true, fakeIpRange: '198.18.0.0/15', servers: [], hosts: [] });
  db.addNode({ id: 'public-auto', name: 'Selected public node', type: 'http', server: '127.0.0.1', port: proxyPort, groupId: 'test' });
  const repo = new ProfileRepository(dir), native = new VpnCoreProcess(path.resolve('bin/bluewing-vpn-core.exe'));
  const originalSend = native.send.bind(native); let loginCommands = 0, applications = 0;
  // Real configure/listeners and sing-box, but never send a login to an external gateway.
  native.send = (type, data) => { if (type === 'connect') { loginCommands++; return; } originalSend(type, data); };
  const config = () => ConfigGenerator.generate(db.getActiveNodeId(), db.getNodes(), db.getRules(), db.getAppRules(), db.getDns(), db.getSettings());
  const vpn = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, {
    isEncryptionAvailable: () => false, encryptString: () => { throw new Error('disabled'); }, decryptString: () => '',
  }), native, {
    running: () => sb.getState() === 'running', pid: () => sb.getPid(), settings: () => db.getSettings(),
    applyRouting: async isCurrent => { applications++; if (!isCurrent()) return false; return sb.start(config()); },
  });
  sb.setConfigEnricher(async value => {
    applyCorporateConfig(value, await vpn.prepareRuntime(true));
    value.inbounds.find((i: any) => i.tag === 'speedtest-in').listen_port = speedPort;
  });
  const configured = () => vpn.publicCoreStarted(vpn.policy.runtime());
  const stopped = (state: string) => { if (['stopped', 'crashed', 'error'].includes(state)) vpn.publicCoreStopped(); };
  sb.on('configured', configured); sb.on('stateChange', stopped);
  t.after(async () => {
    sb.off('configured', configured); sb.off('stateChange', stopped);
    await vpn.dispose(); await sb.stop(); sb.setConfigEnricher(async () => {});
    for (const socket of sockets) socket.destroy(); proxy.close();
    LogManager.getInstance().destroy(); Database.resetInstance();
    if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await sb.start(config()), true);
  const before = sb.getPid(), url = 'http://outside.public.example/';
  const p = (await vpn.save({ id: 'auto-vpn', name: 'Office fixture', protocol: 'easyconnect', gateway: { host: 'vpn.example.com', port: 10443 }, username: 'example', authMethod: 'auth/psw', loginDomain: '', tls: { trustMode: 'strict' }, targets: [{ domains: ['office.corp.example'], cidrs: ['10.90.0.0/16'] }], hosts: {}, bindInterface: '' })).profile;
  assert.equal(sb.getPid(), before); assert.equal(applications, 0);
  assert.equal((await request(mixedPort, url)).body, 'PUBLIC-PROXY');
  await vpn.connect(p.id, 'fixture-only-password');
  assert.equal(applications, 1); assert.equal(loginCommands, 1);
  assert.equal(db.getActiveNodeId(), 'public-auto'); assert.equal(db.getSettings().routingMode, 'rule');
  assert.equal(vpn.snapshot().state.state, 'authenticating');
  const live = JSON.parse(sb.getLiveConfig());
  assert.ok(live.outbounds.some((o: any) => o.tag === `corp-out-${p.id}`));
  assert.equal((await request(mixedPort, url)).body, 'PUBLIC-PROXY');
  const installed = sb.getPid(); await vpn.disconnect(); await vpn.connect(p.id, 'fixture-only-password');
  assert.equal(applications, 1); assert.equal(loginCommands, 2); assert.equal(sb.getPid(), installed);
});

test('Runtime TUN permission fallback releases default-NIC binding without creating a TUN', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-vpn-route-fallback-'));
  const prior = process.env.BLUEWING_DATA_DIR; process.env.BLUEWING_DATA_DIR = dir;
  Database.resetInstance();
  const db = Database.getInstance(dir), manager: SingBoxManager = new (SingBoxManager as any)();
  t.mock.method(manager, 'isAdmin', () => false);
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }) as any);
  const sockets = new Set<net.Socket>(), server = http.createServer((_, response) => response.end('OS-ROUTE'));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const localPort = await listen(server), mixedPort = await freePort();
  t.after(async () => {
    await manager.stop(); for (const socket of sockets) socket.destroy(); server.close(); Database.resetInstance();
    if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.saveSettings({ mixedPort, tunEnabled: true, routingMode: 'direct', clashApiEnabled: false });
  const config = ConfigGenerator.generate('', [], [], [], { mode: 'standard', remoteDns: '223.5.5.5', directDns: '223.5.5.5', servers: [] } as DnsConfig, db.getSettings());
  config.inbounds.find((i: any) => i.tag === 'speedtest-in').listen_port = await freePort();
  assert.equal(config.route.auto_detect_interface, true);
  assert.equal(await manager.start(config), true);
  assert.equal(manager.wasTunStrippedLastStart(), true);
  const live = JSON.parse(manager.getLiveConfig());
  assert.equal(live.route.auto_detect_interface, false);
  assert.equal(live.inbounds.some((i: any) => i.type === 'tun'), false);
  assert.equal((await request(mixedPort, `http://127.0.0.1:${localPort}/`)).body, 'OS-ROUTE');
  assert.equal(db.getSettings().tunEnabled, true, 'Runtime fallback overwrote the saved user choice');
});
