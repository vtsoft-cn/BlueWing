import { ConnectionIntent } from "../main/core/ConnectionIntent";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { CorporateVpnManager } from '../main/vpn/CorporateVpnManager';
import { CorporatePolicy } from '../main/vpn/CorporatePolicy';
import { ProfileRepository } from '../main/vpn/ProfileRepository';
import { CredentialVault } from '../main/vpn/CredentialVault';
import { credentialKey, legacyCredentialKey, profileIdentity } from '../main/vpn/ProfileIdentity';
import { VpnEngineManager } from '../main/system/vpn/VpnEngineManager';
import { RasVpnEngine } from '../main/system/vpn/RasVpnEngine';
import { RasCredentials } from '../main/system/vpn/RasCredentials';
import { WindowsNetQuery } from '../main/system/vpn/WindowsNetQuery';
import { Database } from '../main/db/Database';
import { LogManager } from '../main/log/LogManager';

class Core extends EventEmitter {
  commands: any[] = []; running = false;
  available() { return true; } isRunning() { return this.running; }
  async start() { this.running = true; }
  send(type: string, data: any) { this.commands.push({ type, ...data }); }
  async request(type: string, data: any) { this.send(type, data); return { data: {} }; }
  async stop() { this.running = false; }
}
const encryption = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from('fixture:' + s), decryptString: (b: Buffer) => b.toString().slice(8) };

test('stop barrier invalidates old startup and prevents cleanup callbacks from reviving it', () => {
  const intents = new ConnectionIntent();
  const old = intents.begin();
  const finish = intents.beginStop();
  const duringStop = intents.begin();
  assert.equal(old(), false);
  assert.equal(duringStop(), false);
  const finishSecond = intents.beginStop();
  finish();
  assert.equal(intents.isStopping, true);
  finishSecond();
  assert.equal(duringStop(), false);
  assert.equal(intents.isStopping, false);
  assert.equal(intents.begin()(), true);
});
async function fixture(t: any, username = 'fixture', loginDomain = 'VPN') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-third-audit-'));
  const repo = new ProfileRepository(dir), policy = new CorporatePolicy(dir), vault = new CredentialVault(dir, encryption), core = new Core();
  const profile = repo.save({ id: 'alpha', name: 'fixture', protocol: 'atrust', gateway: { host: 'gateway.example.com', port: 443 }, username, loginDomain, authMethod: 'auth/psw', rememberPassword: true, tls: { trustMode: 'strict', serverName: 'tenant-a.example.com' }, targets: [], hosts: {} });
  let manager!: CorporateVpnManager;
  manager = new CorporateVpnManager(repo, policy, vault, core as any, {
    running: () => true, pid: () => 1, settings: () => ({ mixedPort: 2080, tunEnabled: false }),
    applyRouting: async current => { if (!current()) return false; manager.publicCoreStarted(await manager.prepareRuntime()); return true; },
  }, [], () => core as any);
  await manager.prepareRuntime();
  manager.publicCoreStarted(policy.runtime());
  await manager.savePassword(profile.id, 'fixture-secret-never-a-real-password', true);
  t.after(async () => { await manager.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { repo, policy, vault, core, manager, profile };
}

test('control: unchanged identity can use its explicitly saved password', async t => {
  const f = await fixture(t);
  assert.equal(f.manager.snapshot().passwordSaved?.alpha, true);
  await f.manager.connect('alpha', '');
  assert.ok(f.core.commands.find(c => c.type === 'connect')?.password);
});

test('an unavailable password store cannot block a manually entered VPN password', async t => {
  const f=await fixture(t);
  t.mock.method(f.vault,'available',()=>false);
  t.mock.method(f.vault,'get',()=>{throw Error('No stored passwords can be read');});
  t.mock.method(f.vault,'set',()=>{throw Error('No password can be saved');});
  await f.manager.connect('alpha','manual-session-password');
  assert.equal(f.core.commands.find(c=>c.type==='connect')?.password,'manual-session-password');
  assert.notEqual(f.manager.snapshot().state.state,'failed');
});

test('legacy credentials are preserved but require explicit rebinding to the full identity', async t => {
  const f = await fixture(t);
  f.vault.remove(`${f.profile.id}:`);
  const legacy = legacyCredentialKey(f.profile, 'password');
  f.vault.set(legacy, 'fixture-legacy-secret');
  assert.equal(f.manager.snapshot().passwordSaved?.alpha, false);
  assert.ok(f.manager.snapshot().warnings?.some(w => w.includes('重新输入一次密码')));
  await assert.rejects(f.manager.connect('alpha', ''), /CREDENTIAL_REENTRY_REQUIRED/);
  assert.equal(f.core.commands.some(c => c.type === 'connect'), false);
  assert.equal(f.vault.get(legacy), 'fixture-legacy-secret');
  await f.manager.savePassword('alpha', 'fixture-rebound-secret', true);
  assert.equal(f.vault.needsReentry(f.profile), false);
  assert.equal(f.vault.get(credentialKey(f.profile, 'password')), 'fixture-rebound-secret');
  assert.notEqual(credentialKey(f.profile, 'session'), credentialKey({ ...f.profile, tls: { ...f.profile.tls, serverName: 'other.example' } }, 'session'));
});

test('regression: TLS server identity change must not reuse the previous tenant credential', async t => {
  const f = await fixture(t);
  const next = { ...f.profile, tls: { ...f.profile.tls, serverName: 'tenant-b.example.com' } };
  assert.notEqual(profileIdentity(f.profile), profileIdentity(next));
  await f.manager.save(next);
  const shownSaved = f.manager.snapshot().passwordSaved?.alpha;
  let oldSecretQueued = false;
  try { await f.manager.connect('alpha', ''); oldSecretQueued = !!f.core.commands.find(c => c.type === 'connect')?.password; } catch {}
  console.log('changed TLS tenant:', { shownSaved, oldSecretQueued });
  assert.deepEqual({ shownSaved, oldSecretQueued }, { shownSaved: false, oldSecretQueued: false });
});

test('regression: separators in username and login domain must not collide in the vault', async t => {
  const f = await fixture(t, 'svc:ops', 'VPN');
  const next = { ...f.profile, username: 'svc', loginDomain: 'ops:VPN' };
  assert.notEqual(profileIdentity(f.profile), profileIdentity(next));
  await f.manager.save(next);
  const shownSaved = f.manager.snapshot().passwordSaved?.alpha;
  let oldSecretQueued = false;
  try { await f.manager.connect('alpha', ''); oldSecretQueued = !!f.core.commands.find(c => c.type === 'connect')?.password; } catch {}
  console.log('changed account/domain:', { shownSaved, oldSecretQueued });
  assert.deepEqual({ shownSaved, oldSecretQueued }, { shownSaved: false, oldSecretQueued: false });
});

test('regression: IPv6 gateway and username separators must not collide across different servers', async t => {
  const f = await fixture(t);
  const first = { ...f.repo.get('alpha'), gateway: { host: '2001:db8::1', port: 443 }, username: '543:joe' };
  await f.manager.save(first);
  await f.manager.savePassword('alpha', 'fixture-only-old-gateway-secret', true);
  const next = { ...f.repo.get('alpha'), gateway: { host: '2001:db8::1:443', port: 543 }, username: 'joe' };
  assert.notEqual(profileIdentity(first), profileIdentity(next));
  await f.manager.save(next);
  const shownSaved = f.manager.snapshot().passwordSaved?.alpha;
  let oldSecretQueued = false;
  try { await f.manager.connect('alpha', ''); oldSecretQueued = !!f.core.commands.find(c => c.type === 'connect')?.password; } catch {}
  console.log('different IPv6 gateway:', { shownSaved, oldSecretQueued });
  assert.deepEqual({ shownSaved, oldSecretQueued }, { shownSaved: false, oldSecretQueued: false });
});

function entryFunctions(names: string[]): string {
  const source = ts.createSourceFile('index.ts', fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  return ts.transpileModule(source.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text || '')).map(s => s.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test('regression: manual public-core stop must cancel the in-flight two-second startup retry', async () => {
  let state = 'stopped', starts = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(r => entered = r);
  const core = { getState: () => state, isAdmin: () => true, consumeTunAdapterFatal: () => false, wasTunStrippedLastStart: () => false,
    start: async () => { starts++; state = starts === 1 ? 'error' : 'running'; return starts > 1; }, stop: async () => { state = 'stopped'; } };
  const settings = { tunEnabled: false, systemProxyEnabled: true };
  const db = { credentialStatus:()=>({mode:'normal',lockedSettings:[]}), getSettings: () => settings, getNodes: () => [], getActiveNodeId: () => '', getRules: () => [], getAppRules: () => [], getDns: () => ({}) };
  const vpn = { prepareRuntime: async () => ({ profiles: [] }), publicCoreStarted() {}, disconnect: async () => {} };
  const context: any = { quitState: 'running', coreConnectionIntent: new ConnectionIntent(),
    cancelTunAutoRecovery() {},
    Database: { getInstance: () => db }, SingBoxManager: { getInstance: () => core }, getCorporateVpn: () => vpn, existingCorporateVpn: () => vpn,
    LogManager: { getInstance: () => ({ addLog() {} }) }, TrayManager: { getInstance: () => ({ updateMenu() {} }) },
    SystemProxy: { shouldAutoEnableSystemProxy: () => false, setCorporateRouting() {}, recoverIfUnavailable: async () => true },
    VpnEngineManager: { getInstance: () => ({ getSplitConfig: () => undefined }) }, ConfigGenerator: { generate: () => ({ inbounds: [] }) },
    proxyLifecycle: { stop: async () => true, settled: async () => true }, lastCoreStartOkAt: 0, lastCoreStartHadTun: false, tunFatalRetryCount: 0,
    broadcastSettingsChanged() {}, scheduleTunFatalRetry() {}, setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 2000); release = fn; entered(); return 1; },
  };
  vm.runInNewContext(entryFunctions(['handleCoreStart', 'handleCoreStop']), context);
  const starting = context.handleCoreStart({ userInitiated: true });
  await waiting;
  await context.handleCoreStop();
  assert.equal(state, 'stopped');
  release(); await starting;
  console.log('public core after explicit stop:', { state, starts });
  assert.equal(state, 'stopped', 'an earlier startup retry revived a cancelled core');
});

test('regression: RAS network-info completion must not resurrect a disconnected session', async t => {
  const profile: any = { id: 'ras-fixture', name: 'fixture', type: 'ikev2', server: 'fixture.example.com', username: 'fixture' };
  const manager: VpnEngineManager = new (VpnEngineManager as any)();
  manager.setEnvProbe(() => ({ coreRunning: false, tunActive: false, isAdmin: false }));
  t.mock.method(Database, 'getInstance', () => ({ getVpnProfiles: () => [profile], upsertVpnProfile() {} }) as any);
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }) as any);
  t.mock.method(WindowsNetQuery, 'runPowerShell', async () => 'ok');
  t.mock.method(WindowsNetQuery, 'findAdapterByDescription', async () => ({ name: 'fixture-adapter', interfaceIndex: 123 }) as any);
  t.mock.method(RasCredentials, 'run', async () => ({ ok: true }));
  t.mock.method(RasVpnEngine.prototype as any, 'rasdial', async () => 0);
  let release!: (info: any) => void, entered!: () => void;
  const waiting = new Promise<void>(r => entered = r);
  t.mock.method(WindowsNetQuery, 'getAdapterNetwork', () => { entered(); return new Promise<any>(r => release = r); });
  t.after(async () => manager.shutdown());
  const connecting = manager.connect(profile.id);
  await waiting;
  await manager.disconnect();
  assert.equal(manager.getState()?.state, 'disconnected');
  release({ routes: [], dnsServers: [], domainSuffixes: [], ipv4: '10.44.0.2', connectedPrefix: '10.44.0.0/24' });
  await connecting;
  console.log('RAS state after disconnect and late network completion:', manager.getState()?.state);
  assert.equal(manager.getState()?.state, 'disconnected');
});

test('regression: WireGuard must not report connected with the routing core stopped', async t => {
  const profile: any = { id: 'wg-fixture', name: 'fixture', type: 'wireguard', server: '192.0.2.1', privateKey: Buffer.alloc(32, 1).toString('base64'), peerPublicKey: Buffer.alloc(32, 2).toString('base64'), localAddress: '10.7.0.2/32', extraRoutes: ['10.77.0.0/16'] };
  t.mock.method(Database, 'getInstance', () => ({ getVpnProfiles: () => [profile], upsertVpnProfile() {} }) as any);
  t.mock.method(LogManager, 'getInstance', () => ({ addLog() {} }) as any);
  const manager: VpnEngineManager = new (VpnEngineManager as any)();
  manager.setEnvProbe(() => ({ coreRunning: false, tunActive: false, isAdmin: false }));
  t.after(async () => manager.shutdown());
  await manager.connect(profile.id);
  console.log('WireGuard while routing core stopped:', manager.getState()?.state);
  assert.notEqual(manager.getState()?.state, 'connected');
  assert.equal(manager.getState()?.state, 'enabled');
  assert.ok(manager.getSplitConfig()?.wireguard);
});
