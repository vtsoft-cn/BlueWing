import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CorporateVpnManager } from '../main/vpn/CorporateVpnManager';
import { CorporateVpnSession, signature } from '../main/vpn/CorporateVpnSession';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { CredentialVault } from '../main/vpn/CredentialVault';
import { VpnCoreProcess } from '../main/vpn/VpnCoreProcess';
import { SystemProxy } from '../main/system/SystemProxy';
import { WinInetProxy } from '../main/system/WinInetProxy';
import { LogManager } from '../main/log/LogManager';

class Core extends EventEmitter {
  commands: any[] = []; running = false; broken = false; gate?: Promise<void>; entered?: () => void;
  available() { return true; } isRunning() { return this.running; }
  async start() { this.running = true; this.entered?.(); await this.gate; }
  send(type: string, data: any = {}) { if (this.broken && type === 'disconnect') throw new Error('CORE_ENDPOINT_UNAVAILABLE'); this.commands.push({ type, ...data }); }
  async request(type: string, data: any) { this.send(type, data); return { v: 1, type: 'endpointsReady', generation: 0 }; }
  async stop() { this.running = false; }
}
const unavailable = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
const settle = () => new Promise<void>(r => setImmediate(r));
async function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-deep-audit-'));
  const repo = new ProfileRepository(dir), policy = new CorporatePolicy(dir), cores = new Map<string, Core>();
  for (const id of ['alpha', 'beta']) repo.save({ id, name: id, protocol: 'easyconnect', gateway: { host: id + '.example.com', port: 10443 }, username: 'fixture', authMethod: 'auth/psw', loginDomain: '', tls: { trustMode: 'strict' }, targets: [], hosts: {} });
  let manager!: CorporateVpnManager;
  manager = new CorporateVpnManager(repo, policy, new CredentialVault(dir, unavailable), new Core() as any,
    { running: () => true, pid: () => 1, settings: () => ({ mixedPort: 2080 }), applyRouting: async current => { if (!current()) return false; manager.publicCoreStarted(await manager.prepareRuntime()); return true; } }, [],
    id => { const core = new Core(); cores.set(id, core); return core as unknown as VpnCoreProcess; });
  t.mock.method(CorporateVpnSession.prototype as any, 'verifyPolicy', async () => {});
  t.after(async () => { for (const core of cores.values()) core.broken = false; await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  manager.publicCoreStarted(await manager.prepareRuntime());
  const ready = async (id: string) => {
    const generation = manager.snapshot().states![id].generation;
    for (const [type, data] of [['resources', { targets: [{ domains: [], cidrs: ['10.55.0.0/16'] }], hosts: {}, dnsServers: [] }], ['tunnelReady', undefined]]) cores.get(id)!.emit('event', { v: 1, type, data, profileId: id, generation });
    await settle();
  };
  return { dir, repo, policy, manager, cores, ready };
}

test('regression: disconnect-all must cancel a connection queued behind another login', async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const makeCore = (f.manager as any).createCore;
  (f.manager as any).createCore = (id: string) => { const core = makeCore(id); if (id === 'alpha') { core.gate = gate; core.entered = entered; } return core; };
  const alpha = f.manager.connect('alpha', 'fixture'), beta = f.manager.connect('beta', 'fixture');
  await waiting;
  await f.manager.disconnect();
  release();
  await Promise.all([alpha, beta]);
  const connects = f.cores.get('beta')?.commands.filter(c => c.type === 'connect').length || 0;
  assert.equal(connects, 0, 'a cancelled queued VPN logged in afterwards');
});

test('regression: closed control pipe must not prevent local disconnect cleanup', async t => {
  const f = await fixture(t); await f.manager.connect('alpha', 'fixture'); await f.ready('alpha');
  f.cores.get('alpha')!.broken = true;
  const result = await f.manager.disconnect('alpha').then(() => 'ok', e => e.message);
  assert.equal(result, 'ok');
  assert.equal(f.policy.isActive('alpha'), false);
});

test('regression: closed control pipe must not escape the synchronous fault handler', async t => {
  const f = await fixture(t); await f.manager.connect('alpha', 'fixture'); await f.ready('alpha');
  f.cores.get('alpha')!.broken = true;
  assert.doesNotThrow(() => f.cores.get('alpha')!.emit('fault', 'CORE_PIPE_CLOSED'));
});

test('regression: changing gateway identity must not reactivate resources from the old company', async t => {
  const f = await fixture(t);
  f.policy.update('alpha', { targets: [{ domains: ['old.corp.example'], cidrs: ['10.44.0.0/16'] }], hosts: {}, dnsServers: ['10.44.0.53'] }, f.repo.list());
  await f.manager.save({ ...f.repo.get('alpha'), gateway: { host: 'new-company.example.com', port: 10443 }, username: 'new-user', targets: [], hosts: {} });
  const cached = f.policy.getResources('alpha');
  f.policy.update('alpha', { targets: [], hosts: {}, dnsServers: [] }, f.repo.list());
  f.policy.begin('alpha', f.repo.list());
  const guard = fs.readFileSync(f.policy.runtime().profiles.find(p => p.profile.id === 'alpha')!.guardPath, 'utf8');
  assert.equal(cached, undefined, 'old resources survived a different gateway/account identity');
  assert.equal(guard.includes('10.44.0.0/16'), false);
});

test('regression: changing protocol must invalidate SoftEther packet endpoints and routing signature', async t => {
  const f = await fixture(t);
  await f.manager.save({ ...f.repo.get('alpha'), protocol: 'softether', loginDomain: 'VPN' });
  f.policy.setPacketEndpoint('alpha', { port: 12345, publicKey: Buffer.alloc(32, 7).toString('base64'), loopbackInterface: 'fixture-loopback' }, f.repo.list());
  const before = signature(f.policy.runtime());
  await f.manager.save({ ...f.repo.get('alpha'), protocol: 'easyconnect' });
  const runtime = f.policy.runtime(), after = signature(runtime);
  assert.equal(runtime.profiles.find(p => p.profile.id === 'alpha')!.packet, undefined);
  assert.notEqual(before, after, 'a provider change did not invalidate the public routing topology');
});

test('regression: a failed proxy port transition must retain ownership of the original port', async t => {
  const original = { enabled: false, connections: [{ name: '', flags: 1, server: '', bypass: '', pac: '' }] };
  let owned: any = { managedByBlueWing: true, managedServer: '127.0.0.1:2080', originalSnapshot: original, updatedAt: 1 };
  t.mock.method(SystemProxy, 'initializeRecovery', async () => true);
  t.mock.method(SystemProxy as any, 'loadOwnership', () => structuredClone(owned));
  t.mock.method(SystemProxy as any, 'getFullRegistryStatus', async () => ({ enabled: true, server: '127.0.0.1:2080', connections: [{ name: '', flags: 3, server: '127.0.0.1:2080', bypass: '', pac: '' }] }));
  t.mock.method(SystemProxy as any, 'saveOwnership', (next: any) => { owned = structuredClone(next); return true; });
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }));
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async (r: any) => { if (r.action === 'enable') throw new Error('WinINet update rolled back'); return []; });
  assert.equal(await SystemProxy.enable('127.0.0.1', 2081), false);
  assert.equal(owned.managedServer, '127.0.0.1:2080', 'the remaining old proxy became unowned');
});

test('disconnecting one queued profile does not cancel its peer', async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), waiting = new Promise<void>(r => entered = r);
  const makeCore = (f.manager as any).createCore;
  (f.manager as any).createCore = (id: string) => { const core = makeCore(id); if (id === 'alpha') { core.gate = gate; core.entered = entered; } return core; };
  const alpha = f.manager.connect('alpha', 'fixture'), beta = f.manager.connect('beta', 'fixture');
  await waiting; await f.manager.disconnect('beta'); release();
  await Promise.all([alpha, beta]);
  assert.equal(f.cores.get('alpha')!.commands.filter(c => c.type === 'connect').length, 1);
  assert.equal(f.cores.get('beta')?.commands.some(c => c.type === 'connect') || false, false);
});

test('bound resource identities survive restart and reject a profile changed while the app was closed', async t => {
  const f = await fixture(t);
  f.policy.update('alpha', { targets: [{ domains: [], cidrs: ['10.44.0.0/16'] }], hosts: {}, dnsServers: ['10.44.0.53'] }, f.repo.list());
  const unchanged = new CorporatePolicy(f.dir); unchanged.prepare(f.repo.list());
  assert.deepEqual(unchanged.getResources('alpha')?.dnsServers, ['10.44.0.53']);
  f.repo.save({ ...f.repo.get('alpha'), gateway: { host: 'new-company.example.com', port: 10443 } });
  const changed = new CorporatePolicy(f.dir); changed.begin('alpha', f.repo.list());
  assert.equal(changed.getResources('alpha'), undefined);
  assert.equal(fs.readFileSync(changed.runtime().profiles.find(p => p.profile.id === 'alpha')!.guardPath, 'utf8').includes('10.44.0.0/16'), false);
});

test('resource and session events after disconnect cannot repopulate another identity', async t => {
  const f = await fixture(t); await f.manager.connect('alpha', 'fixture'); await f.ready('alpha');
  await f.manager.disconnect('alpha');
  await f.manager.save({ ...f.repo.get('alpha'), gateway: { host: 'new-company.example.com', port: 10443 } });
  const generation = f.manager.snapshot().states!.alpha.generation;
  f.cores.get('alpha')!.emit('event', { v: 1, type: 'resources', profileId: 'alpha', generation, data: { targets: [{ domains: [], cidrs: ['10.99.0.0/16'] }], hosts: {}, dnsServers: [] } });
  f.cores.get('alpha')!.emit('event', { v: 1, type: 'tunnelReady', profileId: 'alpha', generation });
  await settle();
  assert.equal(f.manager.snapshot().states!.alpha.state, 'idle');
  assert.equal(f.policy.getResources('alpha'), undefined);
  assert.equal(f.policy.isActive('alpha'), false);
});

test('a successful proxy transition retires aliases only after WinINet confirmation', async t => {
  let owned: any = { managedByBlueWing: true, managedServer: '127.0.0.1:2080', originalSnapshot: { enabled: false }, updatedAt: 1 };
  const saved: any[] = [];
  t.mock.method(SystemProxy, 'initializeRecovery', async () => true);
  t.mock.method(SystemProxy, 'captureOriginalSnapshot', async () => ({ enabled: false }));
  t.mock.method(SystemProxy as any, 'loadOwnership', () => structuredClone(owned));
  t.mock.method(SystemProxy as any, 'saveOwnership', (next: any) => { saved.push(structuredClone(next)); owned = structuredClone(next); return true; });
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }));
  t.mock.method(WinInetProxy, 'available', () => true);
  t.mock.method(WinInetProxy, 'run', async (r: any) => {
    assert.equal(r.action, 'enable');
    assert.deepEqual(owned.managedServers, ['127.0.0.1:2080', '127.0.0.1:2081']);
    return [];
  });
  assert.equal(await SystemProxy.enable('127.0.0.1', 2081), true);
  assert.equal(saved.length, 2);
  assert.deepEqual(owned.managedServers, ['127.0.0.1:2081']);
});
