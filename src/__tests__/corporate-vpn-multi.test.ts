import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import { EventEmitter } from 'events';
import { CorporateVpnManager } from '../main/vpn/CorporateVpnManager';
import { CorporateVpnSession } from '../main/vpn/CorporateVpnSession';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { ProfileRepository, validateProfile } from '../main/vpn/ProfileRepository';
import { CredentialVault } from '../main/vpn/CredentialVault';
import { VpnCoreProcess } from '../main/vpn/VpnCoreProcess';
import { PrivateRouteCandidate, PrivateRouteProxy } from '../main/vpn/PrivateRouteProxy';

class Core extends EventEmitter {
  commands: any[] = []; running = false;
  available() { return true; } isRunning() { return this.running; }
  async start() { this.running = true; }
  send(type: string, data: any = {}) { this.commands.push({ type, ...data }); }
  async request(type: string, data: any) { this.send(type, data); return { v: 1, type: 'endpointsReady', generation: 0 }; }
  async stop() { this.running = false; }
}
const unavailable = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const rules = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).rules;
async function fixture(t: any, retryDelays: number[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-multi-'));
  const profiles = new ProfileRepository(dir), policy = new CorporatePolicy(dir), cores = new Map<string, Core>();
  for (const [id, network, priority] of [['alpha', '10.40.0.0/16', 100], ['beta', '10.80.0.0/16', 200]] as const)
    profiles.save({ id, name: id, protocol: 'easyconnect', gateway: { host: id + '.example.com', port: 10443 }, username: 'fixture', authMethod: 'auth/psw', loginDomain: '', tls: { trustMode: 'strict' }, targets: [{ domains: [id + '.corp.example'], cidrs: [network] }], hosts: {}, routingPriority: priority });
  let manager!: CorporateVpnManager, applications = 0;
  manager = new CorporateVpnManager(profiles, policy, new CredentialVault(dir, unavailable), new Core() as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 1, settings: () => ({ mixedPort: 2080 }), applyRouting: async current => { applications++; if (!current()) return false; manager.publicCoreStarted(await manager.prepareRuntime()); return true; } }, retryDelays,
    id => { const core = new Core(); cores.set(id, core); return core as unknown as VpnCoreProcess; });
  t.mock.method(CorporateVpnSession.prototype as any, 'verifyPolicy', async () => {});
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  manager.publicCoreStarted(await manager.prepareRuntime());
  const emit = (id: string, type: string, data?: any, code?: string) => cores.get(id)!.emit('event', { v: 1, type, data, code, profileId: id, generation: manager.snapshot().states![id].generation });
  const ready = async (id: string) => { emit(id, 'resources', { targets: [], hosts: {}, dnsServers: [] }); emit(id, 'tunnelReady'); await settle(); };
  return { dir, profiles, policy, manager, cores, emit, ready, applications: () => applications };
}

test('Two profiles own separate native endpoints, states and independently revocable rules', async t => {
  const f = await fixture(t);
  await Promise.all([f.manager.connect('alpha', 'fixture-a'), f.manager.connect('beta', 'fixture-b')]);
  assert.notEqual(f.cores.get('alpha'), f.cores.get('beta'));
  for (const id of ['alpha', 'beta']) {
    const configured = f.cores.get(id)!.commands.filter(c => c.type === 'configure');
    assert.equal(configured.length, 1); assert.deepEqual(configured[0].endpoints.map((e: any) => e.profile.id), [id]);
    assert.equal(f.manager.snapshot().states![id].state, 'authenticating');
    await f.ready(id);
  }
  assert.equal(f.manager.snapshot().states!.alpha.state, 'connected');
  assert.equal(f.manager.snapshot().states!.beta.state, 'connected');
  await f.manager.disconnect('alpha');
  const runtime = f.policy.runtime();
  assert.equal(f.manager.snapshot().states!.beta.state, 'connected');
  assert.deepEqual(rules(runtime.profiles.find(r => r.profile.id === 'alpha')!.guardPath), []);
  assert.ok(rules(runtime.profiles.find(r => r.profile.id === 'beta')!.routePath).length > 0);
  assert.equal(f.cores.get('beta')!.commands.some(c => c.type === 'disconnect'), false);
  await f.manager.disconnect();
  assert.equal(f.manager.snapshot().states!.beta.state, 'idle');
});

test('unexpected public core exit retains each company guard until explicit disconnect or reconnect', async t => {
  const f = await fixture(t);
  for (const id of ['alpha', 'beta']) { await f.manager.connect(id, 'fixture'); await f.ready(id); }
  f.manager.publicCoreStopped(true);
  await settle();
  for (const id of ['alpha', 'beta']) {
    assert.equal(f.manager.snapshot().states![id].state, 'failed');
    assert.equal(f.manager.snapshot().states![id].error, 'PUBLIC_CORE_CHANGED');
    assert.equal(f.policy.isProtected(id), true);
    assert.equal(f.policy.isActive(id), false);
  }
  await f.manager.disconnect('alpha');
  assert.equal(f.policy.isProtected('alpha'), false);
  assert.equal(f.policy.isProtected('beta'), true);
  f.manager.publicCoreStarted(await f.manager.prepareRuntime());
  await f.manager.connect('beta', 'fixture'); await f.ready('beta');
  assert.equal(f.manager.snapshot().states!.beta.state, 'connected');
});

test('Simultaneous MFA is bound to profile and generation; cancelling one does not cancel the other', async t => {
  const f = await fixture(t);
  for (const id of ['alpha', 'beta']) {
    await f.manager.connect(id, 'fixture');
    f.emit(id, 'challenge', { id: 'same-fixture-challenge', kind: 'otp', title: 'OTP', expiresAt: Date.now() + 60000 });
  }
  const generation = f.manager.snapshot().states!.alpha.generation;
  assert.throws(() => f.manager.respond('same-fixture-challenge', generation, '123456'), /EXPIRED/);
  f.manager.respond('same-fixture-challenge', generation, '123456', 'alpha');
  assert.equal(f.cores.get('alpha')!.commands.filter(c => c.type === 'respond').length, 1);
  assert.equal(f.cores.get('beta')!.commands.filter(c => c.type === 'respond').length, 0);
  const beta = f.manager.snapshot().states!.beta;
  await f.manager.disconnect('alpha');
  assert.deepEqual(f.manager.snapshot().states!.beta.challenge, beta.challenge);
  assert.equal(f.manager.snapshot().states!.beta.state, 'waiting_user');
  assert.throws(() => f.manager.respond('same-fixture-challenge', generation - 1, 'old', 'beta'), /EXPIRED/);
});

test('One reconnect timer and failure guard cannot tear down another connected company', async t => {
  const f = await fixture(t, [10]);
  for (const id of ['alpha', 'beta']) { await f.manager.connect(id, 'fixture'); await f.ready(id); }
  f.emit('alpha', 'error', undefined, 'VPN_TRANSPORT_DOWN');
  for (let i = 0; i < 60 && f.cores.get('alpha')!.commands.filter(c => c.type === 'connect').length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.cores.get('alpha')!.commands.filter(c => c.type === 'connect').length, 2);
  assert.equal(f.manager.snapshot().states!.beta.state, 'connected');
  assert.equal(f.cores.get('beta')!.commands.some(c => c.type === 'disconnect'), false);
  assert.equal(f.policy.isActive('beta'), true);
});

test('Editing an inactive profile and resolving its port collision preserves active peer ports and auth', async t => {
  const f = await fixture(t);
  await f.manager.connect('alpha', 'fixture'); await f.ready('alpha');
  const alpha = f.profiles.get('alpha');
  await assert.rejects(f.manager.save({ ...alpha, name: 'cannot edit live' }), /断开此/);
  await f.manager.save({ ...f.profiles.get('beta'), routingPriority: 25, trafficMode: 'vpn' });
  const create = (f.manager as any).createCore;
  (f.manager as any).createCore = (id: string) => {
    const core = create(id), request = core.request.bind(core); let first = true;
    core.request = async (type: string, data: any) => { if (type === 'configure' && first) { first = false; throw new Error('LOCAL_PORT_IN_USE'); } return request(type, data); };
    return core;
  };
  await f.manager.connect('beta', 'fixture'); await f.ready('beta');
  assert.equal(f.profiles.get('alpha').socksPort, alpha.socksPort);
  assert.equal(f.profiles.get('alpha').dnsPort, alpha.dnsPort);
  assert.equal(f.manager.snapshot().states!.alpha.state, 'connected');
  assert.equal(f.manager.snapshot().defaultProfileId, 'beta');
  assert.equal(f.policy.runtime().profiles[0].profile.id, 'beta');
  for (const r of f.policy.runtime().profiles) assert.equal(rules(r.internetPath!).some((rule: any) => rule.type === 'logical'), r.profile.id === 'beta');
  assert.deepEqual(rules(f.policy.runtime().privateProxy!.rulePath), [], 'A lower-priority discovery policy overrode the explicit default VPN mode');
});

test('Priority persists in backup, validates limits, and renaming preserves equal-priority order', async t => {
  const f = await fixture(t);
  await f.manager.save({ ...f.profiles.get('alpha'), name: 'Renamed' });
  assert.deepEqual(f.profiles.list().map(p => p.id), ['alpha', 'beta']);
  const imported = new ProfileRepository(path.join(f.dir, 'imported'));
  imported.import(f.profiles.export(), 'replace'); assert.equal(imported.get('beta').routingPriority, 200);
  for (const routingPriority of [0, -1, 1.5, 10000, '1']) assert.throws(() => validateProfile({ ...f.profiles.get('alpha'), routingPriority }), /优先级/);
});

test('A scoped readiness probe survives a shared-core rebuild and validates the replacement core', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-rebuild-probe-'));
  const server = http.createServer((_req, response) => response.end('fresh-core-nonce'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let running = false, pid = 10;
  const session = new CorporateVpnSession(new ProfileRepository(dir), new CorporatePolicy(dir), new CredentialVault(dir, unavailable), new Core() as unknown as VpnCoreProcess,
    { running: () => running, pid: () => pid, settings: () => ({ mixedPort: (server.address() as net.AddressInfo).port }) }, [], 'alpha');
  t.after(async () => { await session.dispose(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const replaced = setTimeout(() => { pid = 11; running = true; }, 150); t.after(() => clearTimeout(replaced));
  await (session as any).verifyPolicy('nonce.alpha.bluewing.invalid', 'fresh-core-nonce', 0, 10);
  assert.equal(pid, 11);
});

async function peer(t: any, accepts: boolean, received: string[], handshakeDelay = 0) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let stage = 0, buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (stage === 0 && buffer.length >= 2 + buffer[1]) { buffer = buffer.subarray(2 + buffer[1]); if (handshakeDelay) setTimeout(() => { if (!socket.destroyed) socket.write(Buffer.from([5, 2])); }, handshakeDelay); else socket.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buffer.length >= 3 + buffer[1]) { const size = 3 + buffer[1] + buffer[2 + buffer[1]]; if (buffer.length < size) return; buffer = buffer.subarray(size); socket.write(Buffer.from([1, 0])); stage = 2; }
      if (stage === 2 && buffer.length >= 10) { buffer = buffer.subarray(10); socket.write(Buffer.from([5, accepts ? 0 : 4, 0, 1, 0, 0, 0, 0, 0, 0])); stage = accepts ? 3 : 4; if (!accepts) socket.end(); }
      if (stage === 3 && buffer.length) { received.push(buffer.toString()); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nWINNER'); stage = 4; }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return (server.address() as net.AddressInfo).port;
}
async function through(proxy: { port: number; user: string; password: string }, host = '192.168.77.12'): Promise<{ reply: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxy.port }); let buffer = Buffer.alloc(0), stage = 0, result = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('test timeout')); }, 5000);
    socket.on('error', reject); socket.once('connect', () => socket.write(Buffer.from([5, 1, 2])));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) { buffer = buffer.subarray(2); const u = Buffer.from(proxy.user), p = Buffer.from(proxy.password); socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); stage = 1; }
      if (stage === 1 && buffer.length >= 2) { buffer = buffer.subarray(2); socket.write(Buffer.concat([Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number), 0, 80]), Buffer.from('GET /once HTTP/1.1\r\nHost: fixture\r\n\r\n')])); stage = 2; }
      if (stage === 2 && buffer.length >= 10) { const reply = buffer[1]; buffer = buffer.subarray(10); if (reply) { clearTimeout(timer); socket.destroy(); resolve({ reply, body: '' }); return; } stage = 3; }
      if (stage === 3) { result += buffer.toString(); buffer = Buffer.alloc(0); if (result.endsWith('WINNER')) { clearTimeout(timer); socket.destroy(); resolve({ reply: 0, body: result }); } }
    });
  });
}
test('Unknown-private fallback sends pipelined business bytes only to the winning VPN and rejects public targets', async t => {
  const first: string[] = [], second: string[] = [];
  const a = await peer(t, false, first), b = await peer(t, true, second);
  let candidates: PrivateRouteCandidate[] = [{ id: 'a', generation: 1, port: a, user: 'fixture', password: 'fixture' }, { id: 'b', generation: 1, port: b, user: 'fixture', password: 'fixture' }];
  const proxy = new PrivateRouteProxy(() => candidates, 500, 2000), endpoint = await proxy.start(); t.after(() => proxy.stop());
  const result = await through(endpoint); assert.equal(result.reply, 0); assert.ok(result.body.endsWith('WINNER'));
  assert.deepEqual(first, []); assert.equal(second.length, 1); assert.equal(second[0].match(/GET \/once/g)?.length, 1);
  assert.notEqual((await through(endpoint, '1.1.1.1')).reply, 0); assert.equal(second.length, 1);
  candidates = []; assert.notEqual((await through(endpoint)).reply, 0);
});

test('The first private TCP request survives a cold provider handshake and sends its payload once', { timeout: 8000 }, async t => {
  const received: string[] = [], port = await peer(t, true, received, 3700);
  const proxy = new PrivateRouteProxy(() => [{ id: 'cold', generation: 1, port, user: 'fixture', password: 'fixture' }]);
  const endpoint = await proxy.start(); t.after(() => proxy.stop());
  const result = await through(endpoint, '192.168.110.45');
  assert.equal(result.reply, 0);
  assert.ok(result.body.endsWith('WINNER'));
  assert.equal(received.length, 1);
  assert.equal(received[0].match(/GET \/once/g)?.length, 1);
});
