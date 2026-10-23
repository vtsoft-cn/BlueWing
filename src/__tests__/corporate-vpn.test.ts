import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import {
  ProfileRepository,
  validateProfile,
  targets,
  validateResources,
} from '../main/vpn/ProfileRepository';
import { CorporatePolicy, sourceRules } from '../main/vpn/CorporatePolicy';
import { CredentialVault } from '../main/vpn/CredentialVault';
import {
  FrameDecoder,
  childEnvironment,
  VpnCoreProcess,
} from '../main/vpn/VpnCoreProcess';
import { CorporateVpnManager } from '../main/vpn/CorporateVpnManager';
import { applyCorporateConfig } from '../main/vpn/CorporateConfig';
import { VpnProfile } from '../types/corporateVpn';
import { ImportJournal } from '../main/db/backup/ImportJournal';
import { Database } from '../main/db/Database';
import { BackupService } from '../main/db/backup/BackupService';
import { captchaAnswer } from '../utils/vpnChallenge';
import { dataDirArgument, launchDataDir } from '../main/system/LaunchDataDir';

export const sample = (): VpnProfile => ({
  id: '',
  name: '示例公司',
  protocol: 'easyconnect',
  gateway: { host: 'vpn.example.com', port: 10443 },
  username: 'example',
  authMethod: 'auth/psw',
  loginDomain: '',
  rememberPassword: false,
  rememberSession: false,
  tls: {},
  targets: [
    {
      domains: ['dev.corp.example'],
      cidrs: ['10.20.30.40'],
      ports: ['22', '80:90'],
    },
  ],
  hosts: { 'dev.corp.example': ['10.20.30.40'] },
  bindInterface: '',
  socksPort: 0,
  dnsPort: 0,
});
function temp(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-vpn-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const unavailable = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('not available');
  },
  decryptString: () => '',
};

test('Preview data directory survives scheduled-task elevation without inherited environment', () => {
  const dir = path.join(os.tmpdir(), "BlueWing 测试 O'Brien");
  const argument = dataDirArgument(dir);
  assert.ok(!/[\s'"`]/.test(argument));
  assert.equal(launchDataDir(['app', argument]), path.resolve(dir));
  assert.equal(
    launchDataDir(['app', argument], path.join(os.tmpdir(), 'old')),
    path.resolve(dir),
  );
  assert.equal(launchDataDir(['app'], dir), path.resolve(dir));
  assert.equal(launchDataDir(['app']), undefined);
  assert.throws(() => dataDirArgument('relative'));
  assert.throws(() => launchDataDir(['app', '--bluewing-data-dir64=bad!']));
  assert.throws(() => launchDataDir(['app', argument, argument]));
});
test('aTrust captcha uses natural image dimensions and ordered coordinate pairs', () => {
  assert.deepEqual(
    JSON.parse(
      captchaAnswer(
        [
          { x: 10, y: 20 },
          { x: 80, y: 40 },
        ],
        100,
        50,
      ),
    ),
    {
      coordinates: [
        [10, 20],
        [80, 40],
      ],
      width: 100,
      height: 50,
    },
  );
  assert.throws(() => captchaAnswer([{ x: 100, y: 0 }], 100, 50));
  assert.throws(() => captchaAnswer([], 0, 0));
});

test('VPN profiles normalize endpoints and reject URLs, path traversal and broad routes', () => {
  const p = validateProfile({
    ...sample(),
    gateway: { host: 'VPN.EXAMPLE.COM', port: 443 },
  });
  assert.equal(p.gateway.host, 'vpn.example.com');
  assert.ok(p.id);
  assert.equal(p.targets[0].cidrs[0], '10.20.30.40/32');
  for (const host of [
    'https://vpn.example.com',
    'user:pass@vpn.example.com',
    'vpn.example.com/path',
    'localhost\nother',
  ])
    assert.throws(() =>
      validateProfile({ ...sample(), gateway: { host, port: 443 } }),
    );
  assert.throws(() => validateProfile({ ...sample(), id: '../outside' }));
  assert.throws(() => targets([{ domains: [], cidrs: ['0.0.0.0/0'] }]));
  assert.throws(() =>
    targets([{ domains: ['x.example'], cidrs: [], ports: ['65536'] }]),
  );
  assert.throws(() => targets([{ domains: [], cidrs: ['10.0.0.1/33'] }]));
  assert.throws(() =>
    validateProfile({ ...sample(), tls: { pinSha256: 'bad' } }),
  );
  assert.throws(() =>
    validateResources({
      targets: [],
      hosts: {},
      dnsServers: ['https://example.com'],
    }),
  );
});
test('VPN repository persists profiles without arbitrary secret fields and reserves distinct stable ports', (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir);
  const a = repo.save({
      ...sample(),
      password: 'NEVER_PERSIST',
      session: 'SESSION_SECRET',
    }),
    b = repo.save({ ...sample(), name: '另一家公司', protocol: 'atrust' });
  assert.notEqual(a.socksPort, b.socksPort);
  assert.notEqual(a.dnsPort, b.socksPort);
  assert.equal(repo.save({ ...a, name: '改名' }).socksPort, a.socksPort);
  assert.equal(new ProfileRepository(dir).list().length, 2);
  const raw = fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8');
  assert.ok(!raw.includes('NEVER_PERSIST') && !raw.includes('SESSION_SECRET'));
});
test('VPN vault refuses plaintext/base64 fallback and distinguishes decryption failure', (t) => {
  const dir = temp(t),
    vault = new CredentialVault(dir, unavailable);
  assert.equal(vault.available(), false);
  assert.throws(
    () => vault.set('password', 'secret'),
    /CREDENTIAL_STORE_LOCKED/,
  );
  assert.ok(!fs.existsSync(path.join(dir, 'vpn-vault.json')));
  const provider = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('encrypted:' + s),
    decryptString: (b: Buffer) => {
      if (!b.toString().startsWith('encrypted:')) throw new Error();
      return b.toString().slice(10);
    },
  };
  const encrypted = new CredentialVault(dir, provider);
  encrypted.set('p:password:key', 'demo-secret');
  assert.equal(encrypted.get('p:password:key'), 'demo-secret');
  assert.throws(
    () => new CredentialVault(dir, unavailable).get('p:password:key'),
    /CREDENTIAL_STORE_LOCKED/,
  );
  encrypted.remove('p:');
  assert.equal(encrypted.get('p:password:key'), undefined);
  assert.equal(
    new CredentialVault(dir, {
      ...provider,
      getSelectedStorageBackend: () => 'basic_text',
    }).available(),
    false,
  );
});
test('NDJSON decoder handles UTF8 split frames and coalesced messages', () => {
  const events: any[] = [];
  const decoder = new FrameDecoder((e) => events.push(e));
  const bytes = Buffer.from(
    JSON.stringify({
      v: 1,
      type: 'challenge',
      generation: 2,
      data: { title: '动态码' },
    }) +
      '\n' +
      JSON.stringify({ v: 1, type: 'tunnelReady', generation: 2 }) +
      '\n',
  );
  for (const b of bytes) decoder.push(Buffer.from([b]));
  assert.equal(events.length, 2);
  assert.equal(events[0].data.title, '动态码');
  assert.throws(
    () => new FrameDecoder(() => {}).push(Buffer.from('human text\n')),
    /INVALID_JSON/,
  );
  assert.throws(
    () =>
      new FrameDecoder(() => {}).push(
        Buffer.from('{"v":9,"type":"hello","generation":0}\n'),
      ),
    /VERSION/,
  );
  assert.throws(
    () => new FrameDecoder(() => {}, 4).push(Buffer.from('12345')),
    /TOO_LARGE/,
  );
});
test('VPN child environment strips case-insensitive proxy and TLS keylog variables', () => {
  const env = childEnvironment({
    Path: 'C:/Windows',
    HTTP_PROXY: 'secret',
    https_proxy: 'secret',
    All_Proxy: 'secret',
    SSLKEYLOGFILE: 'keylog',
    BLUEWING_DATA_DIR: 'fixture',
  });
  assert.equal(env.Path, 'C:/Windows');
  assert.equal(env.BLUEWING_DATA_DIR, 'fixture');
  assert.equal(Object.keys(env).length, 2);
});
test('Company policy guards all ports, only activates selected profile and retains revoked targets across restart', (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    other = repo.save({ ...sample(), name: 'B' }),
    policy = new CorporatePolicy(dir);
  policy.prepare(repo.list());
  assert.deepEqual(
    JSON.parse(fs.readFileSync(policy.runtime().profiles[0].routePath, 'utf8'))
      .rules,
    [],
  );
  policy.setProbe(p.id, 'testnonce', repo.list());
  let runtime = policy.runtime();
  const rules = JSON.parse(
    fs.readFileSync(runtime.profiles[0].routePath, 'utf8'),
  ).rules;
  assert.ok(
    rules.some((r: any) => r.domain_suffix?.includes('dev.corp.example')),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(runtime.profiles[1].routePath, 'utf8')).rules,
    [],
  );
  const guard = JSON.parse(
    fs.readFileSync(runtime.profiles[0].guardPath, 'utf8'),
  );
  assert.ok(
    guard.rules.every((r: any) => !r.port && !r.port_range && !r.network),
  );
  policy.update(
    p.id,
    {
      targets: [{ domains: [], cidrs: ['10.30.40.0/24'], ports: ['443'] }],
      hosts: {},
      dnsServers: ['10.20.0.53'],
    },
    repo.list(),
  );
  policy.update(p.id, { targets: [], hosts: {}, dnsServers: [] }, repo.list());
  const restarted = new CorporatePolicy(dir);
  restarted.prepare(repo.list());
  assert.ok(
    fs
      .readFileSync(restarted.runtime().profiles[0].guardPath, 'utf8')
      .includes('10.30.40.0/24'),
  );
  assert.equal(restarted.runtime().profiles[1].profile.id, other.id);
});
test('Company resources preserve per-resource port/protocol grouping', () => {
  const result = sourceRules([
    { domains: ['a.example'], cidrs: [], ports: ['22'], network: 'tcp' },
    { domains: [], cidrs: ['10.0.0.0/24'], ports: ['80:90'], network: 'udp' },
  ]) as any;
  assert.equal(result.rules.length, 2);
  assert.deepEqual(result.rules[0].port, [22]);
  assert.equal(result.rules[0].port_range, undefined);
  assert.deepEqual(result.rules[1].port_range, ['80:90']);
  assert.deepEqual(result.rules[1].network, ['udp']);
});

test('Unsupported resource protocols remain guarded without becoming TCP routes', () => {
  const resources = validateResources({
    targets: [{ domains: ['corp.example'], cidrs: [], guardOnly: true }],
    hosts: {},
    dnsServers: [],
  });
  assert.deepEqual((sourceRules(resources.targets) as any).rules, []);
  assert.deepEqual((sourceRules(resources.targets, true) as any).rules, [
    { domain_suffix: ['corp.example'] },
  ]);
});
test('Managed company config precedes private/CN/application routing without changing public selector', (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir);
  repo.save(sample());
  const policy = new CorporatePolicy(dir);
  const runtime = policy.prepare(repo.list());
  const config: any = {
    inbounds: [{ type: 'tun' }],
    outbounds: [
      {
        type: 'selector',
        tag: 'proxy',
        outbounds: ['public'],
        default: 'public',
      },
    ],
    dns: { servers: [], rules: [{ server: 'fakeip' }] },
    route: {
      rule_set: [],
      rules: [
        { action: 'sniff' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: ['geosite-cn'], outbound: 'direct' },
        { process_name: ['browser.exe'], outbound: 'proxy' },
        { process_name: ['blocked.exe'], action: 'reject' },
      ],
    },
  };
  applyCorporateConfig(config, runtime);
  const rules = config.route.rules,
    company = rules.findIndex((r: any) => r.outbound?.startsWith('corp-out-')),
    guard = rules.findIndex((r: any) =>
      r.rule_set?.[0]?.startsWith('corp-guard-'),
    );
  assert.ok(
    company >
      rules.findIndex((r: any) => r.process_name?.[0] === 'blocked.exe'),
  );
  assert.ok(guard > company);
  assert.ok(company < rules.findIndex((r: any) => r.ip_is_private));
  assert.ok(
    company < rules.findIndex((r: any) => r.rule_set?.includes('geosite-cn')),
  );
  assert.ok(
    rules.findIndex((r: any) => r.rule_set?.includes('geosite-cn')) <
      rules.findIndex((r: any) => r.process_name?.[0] === 'browser.exe'),
  );
  assert.deepEqual(config.outbounds[0].outbounds, ['public']);
  assert.equal(config.outbounds[0].default, 'public');
  assert.equal(config.dns.rules[0].disable_cache, true);
  assert.equal(
    config.dns.rules[0].server,
    `corp-dns-${runtime.profiles[0].profile.id}`,
  );
  const first = JSON.stringify(config);
  applyCorporateConfig(config, runtime);
  assert.equal(
    JSON.stringify(config),
    first,
    'central enrichment must be idempotent',
  );
});
class FakeCore extends EventEmitter {
  commands: any[] = [];
  running = false;
  available() {
    return true;
  }
  isRunning() {
    return this.running;
  }
  async start() {
    this.running = true;
  }
  send(type: string, data: any = {}) {
    this.commands.push({ type, ...data });
  }
  async request(type: string, data: any) {
    this.send(type, data);
    return { v: 1, type: 'endpointsReady', generation: 0 };
  }
  async stop() {
    this.running = false;
  }
}

test('Port collisions preserve leases on reconnect and reassign only on explicit policy rebuild', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    core = new FakeCore();
  let conflicts = 2;
  core.request = async (type: string, data: any) => {
    if (type === 'configure' && conflicts-- > 0)
      throw new Error('LOCAL_PORT_IN_USE');
    core.send(type, data);
    return { v: 1, type: 'endpointsReady', generation: 0 };
  };
  const manager = new CorporateVpnManager(
    repo,
    new CorporatePolicy(dir),
    new CredentialVault(dir, unavailable),
    core as unknown as VpnCoreProcess,
    {
      running: () => true,
      pid: () => 1,
      settings: () => ({ mixedPort: 12345 }),
    },
  );
  t.after(() => manager.dispose());
  await assert.rejects(manager.prepareRuntime(), /LOCAL_PORT_IN_USE/);
  assert.equal(repo.get(p.id).socksPort, p.socksPort);
  const runtime = await manager.prepareRuntime(true);
  assert.notEqual(repo.get(p.id).socksPort, p.socksPort);
  assert.equal(runtime.profiles[0].profile.socksPort, repo.get(p.id).socksPort);
});

test('Repeated transport failures stop after the configured retry budget', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    core = new FakeCore();
  const manager = new CorporateVpnManager(
    repo,
    new CorporatePolicy(dir),
    new CredentialVault(dir, unavailable),
    core as unknown as VpnCoreProcess,
    {
      running: () => true,
      pid: () => 1,
      settings: () => ({ mixedPort: 12345 }),
    },
    [1, 1],
  );
  t.after(() => manager.dispose());
  const baseSend = core.send.bind(core);
  let attempts = 0;
  core.send = (type, data = {}) => {
    baseSend(type, data);
    if (type === 'connect') {
      attempts++;
      queueMicrotask(() =>
        core.emit('event', {
          v: 1,
          type: 'error',
          profileId: p.id,
          generation: data.generation,
          code: 'VPN_TRANSPORT_DOWN',
        }),
      );
    }
  };
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'fixture-secret');
  for (
    let i = 0;
    i < 100 && !(attempts === 3 && manager.snapshot().state.state === 'failed');
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 3);
  assert.equal(manager.snapshot().state.state, 'failed');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(attempts, 3);
});
test('Cancel while core startup is pending never sends a late login', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    core = new FakeCore(),
    manager = new CorporateVpnManager(
      repo,
      new CorporatePolicy(dir),
      new CredentialVault(dir, unavailable),
      core as unknown as VpnCoreProcess,
      {
        running: () => true,
        pid: () => 1,
        settings: () => ({ mixedPort: 12345 }),
      },
    );
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  core.start = async () => gate;
  const login = manager.connect(p.id, 'temporary-secret');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(manager.snapshot().state.state, 'starting');
  await manager.disconnect();
  release();
  await login;
  assert.equal(manager.snapshot().state.state, 'idle');
  assert.ok(!core.commands.some((c) => c.type === 'connect'));
});
test('Transport failure retries are bounded and user disconnect cancels the pending retry', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    core = new FakeCore(),
    manager = new CorporateVpnManager(
      repo,
      new CorporatePolicy(dir),
      new CredentialVault(dir, unavailable),
      core as unknown as VpnCoreProcess,
      {
        running: () => true,
        pid: () => 1,
        settings: () => ({ mixedPort: 12345 }),
      },
      [30],
    );
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'temporary-secret');
  const generation = manager.snapshot().state.generation;
  core.emit('event', {
    v: 1,
    type: 'error',
    generation,
    profileId: p.id,
    code: 'VPN_TRANSPORT_DOWN',
  });
  assert.equal(manager.snapshot().state.state, 'reconnect_wait');
  await manager.disconnect();
  const before = core.commands.filter((c) => c.type === 'connect').length;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(
    core.commands.filter((c) => c.type === 'connect').length,
    before,
  );
  assert.equal(manager.snapshot().state.state, 'idle');
});
test('Manager waits for user challenge, rejects stale/duplicate answers and never alters public selection', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    policy = new CorporatePolicy(dir),
    core = new FakeCore();
  let pid = 123;
  const manager = new CorporateVpnManager(
    repo,
    policy,
    new CredentialVault(dir, unavailable),
    core as unknown as VpnCoreProcess,
    {
      running: () => true,
      pid: () => pid,
      settings: () => ({ mixedPort: 12345 }),
    },
  );
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'SENSITIVE_PASSWORD');
  assert.equal(manager.snapshot().state.state, 'authenticating');
  const generation = manager.snapshot().state.generation;
  core.emit('event', {
    v: 1,
    type: 'challenge',
    profileId: p.id,
    generation: generation - 1,
    data: { id: 'stale' },
  });
  assert.equal(manager.snapshot().state.challenge, undefined);
  core.emit('event', {
    v: 1,
    type: 'challenge',
    profileId: p.id,
    generation,
    data: {
      id: 'otp-1',
      kind: 'otp',
      title: '验证码',
      expiresAt: Date.now() + 60000,
    },
  });
  assert.equal(manager.snapshot().state.state, 'waiting_user');
  manager.respond('otp-1', generation, '123456');
  assert.throws(
    () => manager.respond('otp-1', generation, '123456'),
    /EXPIRED/,
  );
  await manager.disconnect();
  core.emit('event', {
    v: 1,
    type: 'tunnelReady',
    profileId: p.id,
    generation,
  });
  assert.equal(manager.snapshot().state.state, 'idle');
  assert.equal(pid, 123);
  assert.ok(!JSON.stringify(manager.snapshot()).includes('SENSITIVE_PASSWORD'));
});
test('VPN backup excludes remember flags, changes conflicting IDs and preserves local port ownership', (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    original = repo.save({
      ...sample(),
      id: 'fixed',
      rememberPassword: true,
      rememberSession: true,
    });
  const exported = repo.export();
  assert.equal(exported[0].rememberPassword, false);
  assert.equal(exported[0].rememberSession, false);
  assert.equal(exported[0].socksPort, 0);
  repo.import(
    [
      {
        ...sample(),
        id: 'fixed',
        gateway: { host: 'another.example.com', port: 443 },
        rememberPassword: true,
      },
    ],
    'merge',
  );
  const all = repo.list();
  assert.equal(all.length, 2);
  assert.notEqual(all[1].id, original.id);
  assert.notEqual(all[1].socksPort, original.socksPort);
  repo.import([], 'replace');
  assert.equal(repo.list().length, 2);
});
test('Import journal restores both stores after interruption and rejects paths outside its fixed files', (t) => {
  const dir = temp(t),
    dbPath = path.join(dir, 'bluewing.json'),
    profilePath = path.join(dir, 'vpn-profiles.json');
  fs.writeFileSync(dbPath, 'old-db');
  fs.writeFileSync(profilePath, 'old-profile');
  ImportJournal.begin(dir);
  fs.writeFileSync(dbPath, 'new-db');
  fs.writeFileSync(profilePath, 'new-profile');
  assert.equal(ImportJournal.recover(dir), true);
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'old-db');
  assert.equal(fs.readFileSync(profilePath, 'utf8'), 'old-profile');
  fs.writeFileSync(
    path.join(dir, 'backup-import-journal.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { name: '../outside', previous: null },
        { name: 'bluewing.json', previous: null },
        { name: 'vpn-profiles.json', previous: null },
      ],
    }),
  );
  assert.throws(() => ImportJournal.recover(dir));
});
test('Windows backup imports DNS and company category separately without exposing VPN secrets', async (t) => {
  const dir = temp(t);
  t.after(() => Database.resetInstance());
  const db = Database.getInstance(dir),
    repo = new ProfileRepository(dir);
  const p = repo.save(sample());
  const originalDns = {
    ...db.getDns(),
    hosts: [
      {
        id: 'test-host',
        domain: 'local.example',
        ip: '10.20.30.40',
        enabled: true,
      },
    ],
  };
  db.saveDns(originalDns);
  db.flush();
  const backup = await BackupService.exportWindowsBackup({
    profiles: false,
    rules: false,
    settings: true,
    corporateVpn: true,
  });
  const json = JSON.parse(backup);
  assert.equal(json.corporateVpn.length, 1);
  assert.equal(json.corporateVpn[0].rememberPassword, false);
  assert.ok(!('password' in json.corporateVpn[0]));
  db.saveDns({ ...db.getDns(), hosts: [] });
  repo.save({ ...p, name: 'Keep local name' });
  db.flush();
  await BackupService.importWithTransaction(
    backup,
    { profiles: false, rules: false, settings: true, corporateVpn: false },
    'replace',
  );
  assert.deepEqual(db.getDns().hosts, originalDns.hosts);
  assert.equal(new ProfileRepository(dir).get(p.id).name, 'Keep local name');
  const result = await BackupService.importWithTransaction(
    backup,
    { profiles: false, rules: false, settings: false, corporateVpn: true },
    'merge',
  );
  assert.equal(result.importedCounts.corporateVpn, 1);
  assert.equal(new ProfileRepository(dir).get(p.id).name, p.name);
  assert.ok(!fs.existsSync(path.join(dir, 'backup-import-journal.json')));
});
test('Company import failure rolls main database back with profile store', async (t) => {
  const dir = temp(t);
  t.after(() => Database.resetInstance());
  const db = Database.getInstance(dir),
    repo = new ProfileRepository(dir);
  repo.save(sample());
  db.flush();
  const before = fs.readFileSync(path.join(dir, 'bluewing.json'), 'utf8'),
    beforeProfiles = fs.readFileSync(
      path.join(dir, 'vpn-profiles.json'),
      'utf8',
    );
  const backup = await BackupService.exportWindowsBackup({
    profiles: false,
    rules: false,
    settings: true,
    corporateVpn: true,
  });
  const raw = JSON.parse(backup);
  raw.settings.mixedPort = 29999;
  const method = ProfileRepository.prototype.import;
  ProfileRepository.prototype.import = function () {
    throw new Error('simulated disk failure');
  };
  try {
    await assert.rejects(
      BackupService.importWithTransaction(JSON.stringify(raw), {
        profiles: false,
        rules: false,
        settings: true,
        corporateVpn: true,
      }),
      /simulated disk failure/,
    );
  } finally {
    ProfileRepository.prototype.import = method;
  }
  assert.equal(
    fs.readFileSync(path.join(dir, 'bluewing.json'), 'utf8'),
    before,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8'),
    beforeProfiles,
  );
  assert.notEqual(db.getSettings().mixedPort, 29999);
});
