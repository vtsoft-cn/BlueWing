import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { execFileSync, spawn } from 'child_process';
import { CorporateVpnManager } from '../main/vpn/CorporateVpnManager';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { CredentialVault } from '../main/vpn/CredentialVault';
import { VpnCoreProcess } from '../main/vpn/VpnCoreProcess';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { AppSettings, DnsConfig } from '../types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const listen = (server: net.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise<void>(resolve => server.close(() => resolve())); return port; }
function request(port: number, url: string): Promise<string> {
  return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: url, headers: { Host: new URL(url).host }, agent: false }, response => { let b = ''; response.on('data', c => b += c); response.on('end', () => resolve(b)); response.on('error', reject); }); r.setTimeout(5000, () => r.destroy(new Error('request timeout'))); r.on('error', reject); });
}

test('Two company sessions with real routing preserve priority, peer connectivity and public outlets', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-multi-routing-'));
  const prior = process.env.BLUEWING_DATA_DIR; process.env.BLUEWING_DATA_DIR = dir;
  const servers: net.Server[] = [], sockets = new Set<net.Socket>(), attempts: string[] = [];
  let child: ReturnType<typeof spawn> | undefined, manager: CorporateVpnManager | undefined;
  t.after(async () => {
    await manager?.dispose();
    if (child) { const exited = new Promise(resolve => child!.exitCode !== null ? resolve(null) : child!.once('exit', resolve)); child.kill(); await exited; }
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close();
    if (prior === undefined) delete process.env.BLUEWING_DATA_DIR; else process.env.BLUEWING_DATA_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  class Core extends EventEmitter {
    id: string; commands: any[] = []; active = false; running = false;
    constructor(id: string) { super(); this.id = id; }
    available() { return true; } isRunning() { return this.running; }
    async start() { this.running = true; }
    async stop() { this.running = false; this.active = false; }
    async request(type: string, data: any) { this.commands.push({ type, ...data }); return { v: 1, type: 'endpointsReady', generation: 0 }; }
    send(type: string, data: any = {}) {
      this.commands.push({ type, ...data });
      if (type === 'disconnect') this.active = false;
      if (type === 'connect') { this.active = true; setImmediate(() => { this.emit('event', { v: 1, type: 'resources', profileId: this.id, generation: data.generation, data: { targets: [], hosts: {}, dnsServers: [] } }); this.emit('event', { v: 1, type: 'tunnelReady', profileId: this.id, generation: data.generation }); }); }
    }
  }
  const cores = new Map<string, Core>();
  const serve = async (name: string) => {
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      let stage = 0, buffer = Buffer.alloc(0), target = '', targetPort = 0;
      socket.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        if (stage === 0 && buffer.length >= 2 + buffer[1]) { buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, 2])); stage = 1; }
        if (stage === 1 && buffer.length >= 3 + buffer[1]) { const size = 3 + buffer[1] + buffer[2 + buffer[1]]; if (buffer.length < size) return; buffer = buffer.subarray(size); socket.write(Buffer.from([1, 0])); stage = 2; }
        if (stage === 2 && buffer.length >= 5) {
          const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : 7 + buffer[4]; if (buffer.length < length) return;
          target = buffer[3] === 1 ? [...buffer.subarray(4, 8)].join('.') : buffer.subarray(5, 5 + buffer[4]).toString(); targetPort = buffer.readUInt16BE(length - 2);
          attempts.push(name + ':' + target); buffer = buffer.subarray(length);
          const denied = ['alpha', 'beta'].includes(name) && (!cores.get(name)?.active || (name === 'alpha' && target === '192.168.77.12'));
          socket.write(Buffer.from([5, denied ? 4 : 0, 0, 1, 127, 0, 0, 1, 0, 1])); stage = denied ? 4 : 3; if (denied) socket.end();
        }
        if (stage === 3 && buffer.includes(Buffer.from('\r\n\r\n'))) {
          // Only the intended company can attest its probe. A public fallback
          // must never satisfy readiness before the watched rules are loaded.
          const body = targetPort === 1 && target.endsWith(`.${name}.bluewing.invalid`) ? target.split('.')[0] : name.toUpperCase();
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); stage = 4;
        }
      });
    }); servers.push(server); return listen(server);
  };
  const alphaPort = await serve('alpha'), betaPort = await serve('beta'), directPort = await serve('direct'), publicPort = await serve('public');
  const repo = new ProfileRepository(dir);
  for (const [id, network, priority] of [['alpha', '10.40.0.0/16', 100], ['beta', '10.80.0.0/16', 200]] as const)
    repo.save({ id, name: id, protocol: 'easyconnect', gateway: { host: id + '.example.com', port: 10443 }, username: 'fixture', tls: { trustMode: 'strict' }, targets: [{ domains: [id + '.corp.example'], cidrs: [network, '10.99.0.1/32'] }], hosts: {}, routingPriority: priority, bindInterface: 'isolated-fixture' });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'));
  for (const p of stored.profiles) { p.socksPort = p.id === 'alpha' ? alphaPort : betaPort; p.dnsPort = await freePort(); }
  fs.writeFileSync(path.join(dir, 'vpn-profiles.json'), JSON.stringify(stored)); repo.reload();
  const policy = new CorporatePolicy(dir), mixedPort = await freePort();
  manager = new CorporateVpnManager(repo, policy, new CredentialVault(dir, { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }), new Core('seed') as unknown as VpnCoreProcess,
    { running: () => child?.exitCode === null, pid: () => child?.pid, settings: () => ({ mixedPort, tunEnabled: true }), applyRouting: async () => { throw new Error('Unexpected public core restart'); } }, [],
    id => { const c = new Core(id); cores.set(id, c); return c as unknown as VpnCoreProcess; });
  const runtime = await manager.prepareRuntime();
  const config = ConfigGenerator.generate('public', [{ id: 'public', name: 'Public', type: 'socks', server: '127.0.0.1', port: publicPort, username: 'fixture', password: 'fixture', groupId: 'fixture' }], [], [],
    { mode: 'standard', directDns: '223.5.5.5', remoteDns: '223.5.5.5', servers: [] } as DnsConfig,
    { mixedPort, tunEnabled: false, routingMode: 'rule', clashApiEnabled: false, systemProxyBypassLan: true, logLevel: 'debug' } as AppSettings, undefined, runtime);
  config.outbounds[config.outbounds.findIndex((o: any) => o.tag === 'direct')] = { type: 'socks', tag: 'direct', server: '127.0.0.1', server_port: directPort, version: '5', username: 'fixture', password: 'fixture' };
  config.inbounds.find((i: any) => i.tag === 'speedtest-in').listen_port = await freePort();
  const file = path.join(dir, 'config.json'), binary = path.resolve('bin/sing-box.exe'); fs.writeFileSync(file, JSON.stringify(config));
  execFileSync(binary, ['check', '-c', file], { windowsHide: true });
  child = spawn(binary, ['run', '-c', file], { windowsHide: true }); let log = ''; child.stderr?.on('data', b => log += b);
  let ready = false; const until = Date.now() + 20000;
  while (Date.now() < until) { try { if ((await request(mixedPort, 'http://223.5.5.5/')) === 'DIRECT') { ready = true; break; } } catch {} if (child.exitCode !== null) break; await sleep(100); }
  assert.ok(ready, log); manager.publicCoreStarted(runtime); const pid = child.pid;
  await Promise.all([manager.connect('alpha', 'fixture'), manager.connect('beta', 'fixture')]);
  for (let i = 0; i < 100 && Object.values(manager.snapshot().states!).some(s => s.state !== 'connected'); i++) await sleep(100);
  assert.equal(manager.snapshot().states!.alpha.state, 'connected', JSON.stringify(manager.snapshot().states));
  assert.equal(manager.snapshot().states!.beta.state, 'connected', JSON.stringify(manager.snapshot().states));
  const detail = () => log + JSON.stringify({ attempts, states: manager!.snapshot().states, ports: repo.list().map(p => [p.id, p.socksPort]), rules: policy.runtime().profiles.map(r => ({ id: r.profile.id, route: JSON.parse(fs.readFileSync(r.routePath, 'utf8')), guard: JSON.parse(fs.readFileSync(r.guardPath, 'utf8')) })) });
  assert.equal(await request(mixedPort, 'http://10.40.1.1/'), 'ALPHA', detail());
  assert.equal(await request(mixedPort, 'http://10.80.1.1/'), 'BETA', log + JSON.stringify({ attempts, states: manager.snapshot().states, ports: repo.list().map(p => [p.id, p.socksPort]) }));
  assert.equal(await request(mixedPort, 'http://10.99.0.1/'), 'ALPHA');
  assert.equal(await request(mixedPort, 'http://192.168.77.12/'), 'BETA', 'Unknown-private discovery did not try the second connected VPN');
  assert.equal(await request(mixedPort, 'http://223.5.5.5/'), 'DIRECT');
  assert.equal(await request(mixedPort, 'http://1.1.1.1/'), 'PUBLIC');
  const alphaGeneration = manager.snapshot().states!.alpha.generation;
  cores.get('alpha')!.emit('event', { v: 1, type: 'error', code: 'VPN_TRANSPORT_DOWN', profileId: 'alpha', generation: alphaGeneration });
  await sleep(500); // Allow the core's watched source files to revoke alpha's routes.
  assert.equal(await request(mixedPort, 'http://10.99.0.1/'), '', 'A failed higher-priority company leaked its overlapping resource into beta');
  assert.equal(await request(mixedPort, 'http://10.80.1.1/'), 'BETA');
  await manager.disconnect('alpha');
  let moved = false; for (let i = 0; i < 30; i++) { try { if ((await request(mixedPort, 'http://10.99.0.1/')) === 'BETA') { moved = true; break; } } catch {} await sleep(100); } assert.ok(moved, log);
  assert.equal(manager.snapshot().states!.beta.state, 'connected');
  assert.equal(await request(mixedPort, 'http://10.80.1.1/'), 'BETA');
  assert.equal(child.pid, pid); assert.equal(child.exitCode, null);
  assert.ok(attempts.includes('alpha:192.168.77.12') && attempts.includes('beta:192.168.77.12'));
});
