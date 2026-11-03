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
import { CorporateVpnSession as CorporateVpnManager } from '../main/vpn/CorporateVpnSession';
import { applyCorporateConfig } from '../main/vpn/CorporateConfig';
import { VpnProfile } from '../types/corporateVpn';
import { ImportJournal } from '../main/db/backup/ImportJournal';
import { Database } from '../main/db/Database';
import { BackupService } from '../main/db/backup/BackupService';
import { captchaAnswer } from '../utils/vpnChallenge';
import { gatewayTrust } from '../main/vpn/GatewayTrust';
import { dataDirArgument, launchDataDir } from '../main/system/LaunchDataDir';
import { vpnRouting } from '../utils/vpnRouting';
import { VpnDiagnostics } from '../main/vpn/VpnDiagnostics';
import { PrivateRouteDiscovery, privateIPv4 } from '../main/vpn/PrivateRouteDiscovery';

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
  tls: { trustMode: 'strict' },
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

test('damaged resource caches are isolated independently and healthy company guards survive', t => {
  const dir = temp(t), repo = new ProfileRepository(dir);
  const p = repo.save(sample());
  const folder = path.join(dir, 'vpn-runtime'); fs.mkdirSync(folder, { recursive: true });
  const protectedTarget = { domains: ['retained.corp.example'], cidrs: ['10.66.0.0/16'] };
  fs.writeFileSync(path.join(folder, 'known-targets.json'), '\uFEFF' + JSON.stringify({ [p.id]: [protectedTarget] }));
  fs.writeFileSync(path.join(folder, 'resources.json'), '{');
  const policy = new CorporatePolicy(dir);
  assert.equal(policy.cacheWarnings.length, 1);
  assert.ok(fs.readdirSync(folder).some(file => file.startsWith('resources.json.invalid-')));
  policy.begin(p.id, repo.list());
  assert.ok(fs.readFileSync(policy.runtime().profiles[0].guardPath, 'utf8').includes('10.66.0.0/16'));
  policy.update(p.id, { targets: [protectedTarget], hosts: {}, dnsServers: ['10.66.0.53'] }, repo.list());
  const restarted = new CorporatePolicy(dir);
  assert.equal(restarted.cacheWarnings.length, 0);
  assert.equal(restarted.getResources(p.id)?.dnsServers[0], '10.66.0.53');
});

test('one invalid cache entry does not discard another company resources or break ordinary startup', t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample());
  const folder = path.join(dir, 'vpn-runtime'); fs.mkdirSync(folder, { recursive: true });
  const valid = { targets: [{ domains: ['kept.corp.example'], cidrs: ['10.22.0.0/16'] }], hosts: {}, dnsServers: ['10.22.0.53'] };
  fs.writeFileSync(path.join(folder, 'known-targets.json'), '[]');
  fs.writeFileSync(path.join(folder, 'resources.json'), JSON.stringify({ [p.id]: valid, broken: { targets: [{}] } }));
  const policy = new CorporatePolicy(dir);
  assert.equal(policy.cacheWarnings.length, 1, 'Recovery notices should be deduplicated');
  assert.deepEqual(policy.getResources(p.id)?.dnsServers, ['10.22.0.53']);
  policy.prepare(repo.list());
  assert.equal(policy.runtime().profiles.length, 1);
  assert.equal(policy.getResources('broken'), undefined);
});

test('Automatic private discovery defaults on, preserves opt-out and never accepts public scope', t => {
  const repo = new ProfileRepository(temp(t));
  const p = repo.save(sample());
  assert.equal(p.autoDiscoverPrivate, true);
  repo.save({ ...p, autoDiscoverPrivate: false });
  assert.equal(new ProfileRepository(repo.dir).get(p.id).autoDiscoverPrivate, false);
  assert.throws(() => validateProfile({ ...p, autoDiscoverPrivate: 'yes' }), /自动识别/);
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(privateIPv4(ip), true);
  for (const ip of ['1.1.1.1', '127.0.0.1', '169.254.1.1', '172.32.0.1', '198.18.0.1', '::1', 'fd00::1', '10.0.0.999']) assert.equal(privateIPv4(ip), false);
});

test('Discovery learns exact private TCP endpoints per gateway and forgets a path found locally', t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample());
  let cache = new PrivateRouteDiscovery(dir);
  assert.equal(cache.observe(p, '192.168.77.12', 22, 'vpn'), true);
  assert.equal(cache.observe(p, '192.168.77.12', 22, 'vpn'), false);
  cache = new PrivateRouteDiscovery(dir);
  assert.deepEqual(cache.targets(p), [{ domains: [], cidrs: ['192.168.77.12/32'], ports: ['22'], network: 'tcp' }]);
  assert.deepEqual(cache.targets({ ...p, gateway: { ...p.gateway, host: 'other.example.com' } }), []);
  assert.deepEqual(cache.targets({ ...p, id: 'other-company' }), []);
  for (const [ip, port] of [['1.1.1.1', 443], ['192.168.77.12', 0], ['192.168.77.12', 65536], ['192.168.77.12', '22']] as const)
    assert.equal(cache.observe(p, ip, port, 'vpn'), false);
  assert.equal(cache.observe({ ...p, autoDiscoverPrivate: false }, '192.168.77.13', 22, 'vpn'), false);
  assert.equal(cache.observe({ ...p, trafficMode: 'vpn' }, '192.168.77.13', 22, 'vpn'), false);
  assert.equal(cache.observe(p, '192.168.77.12', 22, 'direct'), true);
  assert.deepEqual(new PrivateRouteDiscovery(dir).targets(p), []);
  cache.observe(p, '10.99.0.1', 443, 'vpn'); cache.clear(p.id);
  assert.deepEqual(new PrivateRouteDiscovery(dir).targets(p), []);
});

test('Learned endpoint guards preserve ports and never expand manual or gateway ownership', t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), policy = new CorporatePolicy(dir);
  policy.prepare(repo.list());
  const observation = { address: '192.168.77.12', port: 22, network: 'tcp', outlet: 'vpn' };
  assert.equal(policy.learn(p.id, observation, repo.list()), false);
  policy.setProbe(p.id, 'connected', repo.list());
  assert.equal(policy.learn(p.id, { ...observation, network: 'udp' }, repo.list()), false);
  assert.equal(policy.learn(p.id, observation, repo.list()), true);
  const runtime = policy.runtime().profiles[0], guard = JSON.parse(fs.readFileSync(runtime.discoveredGuardPath!, 'utf8'));
  assert.deepEqual(guard.rules, [{ ip_cidr: ['192.168.77.12/32'], network: ['tcp'], port: [22] }]);
  assert.ok(!fs.readFileSync(runtime.guardPath, 'utf8').includes('192.168.77.12'));
  assert.ok(!fs.readFileSync(runtime.routePath, 'utf8').includes('192.168.77.12'));
  policy.deactivate(repo.list(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.discoveredGuardPath!, 'utf8')), guard);
  const restarted = new CorporatePolicy(dir); restarted.prepare(repo.list());
  assert.equal(restarted.discovery.targets(p).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.discoveredGuardPath!, 'utf8')).rules, []);
  restarted.begin(p.id, repo.list());
  restarted.clearDiscovered(p, repo.list());
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.discoveredGuardPath!, 'utf8')).rules, []);
  assert.ok(fs.readFileSync(runtime.guardPath, 'utf8').includes('10.20.30.40'));
});

test('SoftEther validates HUB/auth and strips secrets and the legacy broad VPN outlet', (t) => {
  const repo = new ProfileRepository(temp(t));
  const p = repo.save({ ...sample(), protocol: 'softether', gateway: { host: 'vpn.example.com', port: 5555 }, loginDomain: 'VPN', routeChina: true, password: 'must-not-persist' });
  assert.equal('routeChina' in new ProfileRepository(repo.dir).get(p.id), false);
  assert.equal(p.loginDomain, 'VPN');
  assert.ok(!fs.readFileSync(path.join(repo.dir, 'vpn-profiles.json'), 'utf8').includes('must-not-persist'));
  assert.throws(() => validateProfile({ ...p, loginDomain: '' }), /HUB/);
  assert.throws(() => validateProfile({ ...p, authMethod: 'anonymous' }), /认证方式/);
  assert.equal(validateProfile({ ...p, authMethod: 'softether/radius' }).authMethod, 'softether/radius');
  for (const protocol of ['easyconnect', 'atrust'] as const)
    assert.equal('routeChina' in validateProfile({ ...sample(), protocol, routeChina: true }), false);
});

test('Upgrading old profiles revokes a watched domestic VPN outlet without broadening company guards', (t) => {
  const repo = new ProfileRepository(temp(t));
  const a = repo.save({ ...sample(), routeChina: true });
  const legacy = path.join(repo.dir, 'vpn-runtime', a.id, 'china-active.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ version: 3, rules: [{ ip_cidr: ['0.0.0.0/0'] }] }));
  const policy = new CorporatePolicy(repo.dir);
  policy.prepare(repo.list());
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')).rules, []);
  policy.setProbe(a.id, 'test', repo.list());
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')).rules, []);
  assert.ok(!fs.readFileSync(policy.runtime().profiles[0].guardPath, 'utf8').includes('0.0.0.0/0'));
});

test('Company-only rules discard previous broad outlets and remain idempotent', (t) => {
  const repo = new ProfileRepository(temp(t)); repo.save({ ...sample(), routeChina: true });
  const policy = new CorporatePolicy(repo.dir); const runtime = policy.prepare(repo.list());
  const config: any = { inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }], route: { rule_set: [], rules: [
    { action: 'reject', domain: ['blocked.cn'] }, { ip_is_private: true, outbound: 'direct' }, { rule_set: ['geosite-cn'], outbound: 'direct' },
    { type: 'logical', mode: 'and', rules: [{ rule_set: ['corp-china-old'] }, { rule_set: ['geosite-cn'] }], outbound: 'corp-out-old' },
  ] }, dns: { servers: [], rules: [] } };
  applyCorporateConfig(config, runtime); const before = structuredClone(config);
  applyCorporateConfig(config, runtime); assert.deepEqual(config, before);
  const rules = config.route.rules;
  const guard = rules.findIndex((r: any) => r.rule_set?.[0]?.startsWith('corp-guard-'));
  assert.ok(guard < rules.findIndex((r: any) => r.ip_is_private));
  assert.equal(rules[0].action, 'reject');
  assert.equal(JSON.stringify(config).includes('corp-china-'), false);
  assert.ok(config.dns.rules.every((r: any) => r.rule_set?.every((tag: string) => tag.startsWith('corp-dns-'))));
});
const unavailable = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('not available');
  },
  decryptString: () => '',
};

test('VPN routing modes default to smart, persist custom choices and prefer an enabled foreign proxy', (t) => {
  const repo = new ProfileRepository(temp(t)); const p = repo.save(sample());
  assert.equal(p.trafficMode, 'split');
  assert.deepEqual(vpnRouting(p, true), { domestic: 'direct', foreign: 'proxy', lan: 'direct' });
  assert.deepEqual(vpnRouting({ trafficMode: 'vpn' }, true), { domestic: 'vpn', foreign: 'proxy', lan: 'vpn' });
  assert.deepEqual(vpnRouting({ trafficMode: 'vpn' }, false), { domestic: 'vpn', foreign: 'vpn', lan: 'vpn' });
  const customRouting = { domestic: 'proxy', foreign: 'direct', lan: 'vpn' } as const;
  repo.save({ ...p, trafficMode: 'custom', customRouting });
  assert.deepEqual(new ProfileRepository(repo.dir).get(p.id).customRouting, customRouting);
  assert.deepEqual(vpnRouting({ trafficMode: 'custom', customRouting }, true), customRouting);
  assert.equal(vpnRouting({ trafficMode: 'custom', customRouting }, false).domestic, 'direct');
  assert.throws(() => validateProfile({ ...p, trafficMode: 'unknown' }), /分流模式/);
  assert.throws(() => validateProfile({ ...p, customRouting: { ...customRouting, lan: 'unknown' } }), /出口/);
});

test('VPN mode defaults preserve explicit public routes and application exceptions after company protection', (t) => {
  const repo = new ProfileRepository(temp(t)); repo.save(sample());
  const policy = new CorporatePolicy(repo.dir); const runtime = policy.prepare(repo.list());
  const config: any = { inbounds: [], outbounds: [{ type: 'selector', tag: 'proxy', outbounds: ['node-one'], default: 'node-one' }],
    route: { rule_set: [], rules: [{ domain: ['special.example'], outbound: 'direct' },
      { rule_set: ['geosite-cn'], outbound: 'direct' }, { process_name: ['tool.exe'], outbound: 'direct' }] }, dns: { servers: [], rules: [] } };
  applyCorporateConfig(config, runtime);
  const rules = config.route.rules;
  const guard = rules.findIndex((r: any) => r.rule_set?.[0]?.startsWith('corp-guard-'));
  const explicit = rules.findIndex((r: any) => r.domain?.includes('special.example'));
  const fallback = rules.findLastIndex((r: any) => r.type === 'logical' && r.outbound === 'proxy');
  assert.ok(guard < explicit && explicit < fallback);
  assert.ok(rules.findIndex((r: any) => r.process_name?.includes('tool.exe')) < fallback);
});

test('SoftEther smart mode selects the network outlet for all TCP services while preserving explicit rules', t => {
  for (const variation of [
    { protocol: 'softether', trafficMode: 'split', autoDiscoverPrivate: true, expected: true },
    { protocol: 'softether', trafficMode: 'split', autoDiscoverPrivate: false, expected: false },
    { protocol: 'softether', trafficMode: 'custom', autoDiscoverPrivate: true, expected: false },
    { protocol: 'easyconnect', trafficMode: 'split', autoDiscoverPrivate: true, expected: false },
  ] as const) {
    const repo = new ProfileRepository(temp(t));
    const p = repo.save({ ...sample(), ...variation, loginDomain: 'fixture-hub' });
    const policy = new CorporatePolicy(repo.dir), runtime = policy.prepare(repo.list());
    const config: any = { inbounds: [], outbounds: [], dns: { servers: [], rules: [] },
      route: { rule_set: [], rules: [
        { domain: ['explicit.example'], outbound: 'direct' },
        { rule_set: ['geoip-cn'], outbound: 'direct' },
      ] } };
    applyCorporateConfig(config, runtime);
    const rules = config.route.rules;
    const index = rules.findIndex((r: any) => r.outbound === `corp-out-${p.id}` && r.rules?.some((c: any) => c.rules?.some((v: any) => v.rule_set?.includes('geosite-cn'))));
    assert.equal(index >= 0, variation.expected);
    if (index < 0) continue;
    assert.ok(rules.findIndex((r: any) => r.domain?.includes('explicit.example')) < index);
    assert.ok(index < rules.findIndex((r: any) => r.rule_set?.includes('geoip-cn')));
    assert.ok(rules[index].rules.some((r: any) => r.rule_set?.includes(`corp-internet-${p.id}`)), 'Discovery must follow the active Internet owner');
    assert.ok(!JSON.stringify(rules[index]).includes('"port"'), 'Automatic network selection must not depend on a service port');
    const before = structuredClone(config); applyCorporateConfig(config, runtime); assert.deepEqual(config, before);
  }
});

test('SoftEther packet routes are ready for the first unknown private ICMP/UDP packet without a learned subnet', t => {
  const repo = new ProfileRepository(temp(t));
  const p = repo.save({ ...sample(), protocol: 'softether', loginDomain: 'VPN', targets: [], hosts: {} });
  const policy = new CorporatePolicy(repo.dir);
  const before = policy.prepare(repo.list()).profiles[0].packet!;
  assert.equal(Buffer.from(before.privateKey, 'base64').length, 32);
  policy.setPacketEndpoint(p.id, { port: 32001, publicKey: before.publicKey, loopbackInterface: 'fixture-loopback', icmp: { port: 32002, publicKey: before.icmp!.publicKey } }, repo.list());
  policy.update(p.id, { targets: [{ domains: [], cidrs: ['192.168.30.0/24'], ports: ['1:65535'] }], hosts: {}, dnsServers: ['192.168.30.1'] }, repo.list());
  policy.setProbe(p.id, 'cold-first-packet', repo.list());
  const runtime = policy.runtime(), r = runtime.profiles[0];
  const config: any = { inbounds: [], outbounds: [], route: { rule_set: [], rules: [{ action: 'hijack-dns', network: 'udp', port: [53] }, { ip_is_private: true, outbound: 'direct' }] }, dns: { servers: [], rules: [] } };
  applyCorporateConfig(config, runtime);
  const endpoint = config.endpoints.find((e: any) => e.tag === `corp-packet-${p.id}`);
  assert.equal(endpoint.system, false);
  assert.equal(endpoint.bind_interface, 'fixture-loopback');
  const icmp = config.endpoints.find((e: any) => e.tag === `corp-packet-icmp-${p.id}`);
  assert.deepEqual(icmp.address, ['0.0.0.0/32'], 'A concrete address makes sing-tun synthesize ICMP replies');
  assert.notEqual(icmp.private_key, endpoint.private_key, 'Independent return paths must not share a roaming peer');
  assert.notEqual(icmp.peers[0].port, endpoint.peers[0].port);
  for (const [network, ep] of [['udp', endpoint], ['icmp', icmp]] as const) {
    const discovery = config.route.rules.find((rule: any) => rule.outbound === ep.tag && JSON.stringify(rule).includes('192.168.0.0/16'));
    assert.ok(discovery && JSON.stringify(discovery).includes(network));
    assert.ok(config.route.rules.indexOf(discovery) < config.route.rules.findIndex((rule: any) => rule.ip_is_private));
  }
  assert.deepEqual(policy.discovery.targets(p), [], 'First packet must not require previous observations');
  const known = JSON.parse(fs.readFileSync(r.routePath, 'utf8')).rules;
  assert.ok(known.some((rule: any) => rule.network?.includes('icmp') && !rule.port_range), 'Full network resources must allow ICMP without a TCP port');
  const probe = config.route.rules.find((rule: any) => rule.outbound === `corp-out-${p.id}` && rule.rules?.some((r: any) => r.domain_suffix?.includes('bluewing.invalid')));
  assert.ok(probe.rules.some((rule: any) => rule.rule_set?.includes(`corp-internet-${p.id}`)), 'Connection readiness must include packet policy activation');
  const dns = config.route.rules.findIndex((rule: any) => rule.outbound === endpoint.tag && rule.rules?.some((r: any) => r.port?.includes(53)));
  assert.ok(dns >= 0 && dns < config.route.rules.findIndex((rule: any) => rule.action === 'hijack-dns'));
  policy.deactivate(repo.list());
  assert.deepEqual(JSON.parse(fs.readFileSync(r.internetPath!, 'utf8')).rules, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.routePath, 'utf8')).rules, []);
  assert.ok(!fs.readFileSync(path.join(repo.dir, 'vpn-profiles.json'), 'utf8').includes(before.privateKey), 'Packet keys are per-launch and never user configuration');
});

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
test('Custom company routing survives restart, overrides server hosts and stays scoped to its profile', (t) => {
  const dir = temp(t), repo = new ProfileRepository(dir);
  const a = repo.save({
    ...sample(), name: 'Company A',
    targets: [{ domains: ['shared.corp.example'], cidrs: [], network: 'tcp' }],
    hosts: { 'shared.corp.example': ['10.20.30.40'] },
  });
  const b = repo.save({ ...sample(), name: 'Company B', targets: [], hosts: {} });
  const policy = new CorporatePolicy(dir);
  policy.update(a.id, {
    targets: [{ domains: ['auto.corp.example'], cidrs: [] }],
    hosts: { 'shared.corp.example': ['10.99.0.1'] }, dnsServers: ['10.0.0.53'],
  }, repo.list());
  const restored = new ProfileRepository(dir);
  assert.deepEqual(restored.get(a.id).targets, a.targets);
  assert.deepEqual(restored.get(a.id).hosts, a.hosts);
  assert.deepEqual(restored.get(b.id).targets, []);
  assert.deepEqual(restored.get(b.id).hosts, {});
  const restartedPolicy = new CorporatePolicy(dir);
  restartedPolicy.setProbe(a.id, 'nonce', restored.list());
  const runtime = restartedPolicy.runtime();
  const aRules = JSON.parse(fs.readFileSync(runtime.profiles.find(p => p.profile.id === a.id)!.routePath, 'utf8')).rules;
  assert.deepEqual(aRules[0].domain_suffix, ['shared.corp.example']);
  const fixedRules = aRules.filter((r: any) => r.domain_suffix?.includes('shared.corp.example') && r.ip_cidr);
  assert.deepEqual(fixedRules.map((r: any) => r.ip_cidr), [['10.20.30.40/32']]);
  assert.ok(!JSON.stringify(aRules).includes('10.99.0.1'));
  const bRuntime = runtime.profiles.find(p => p.profile.id === b.id)!;
  assert.deepEqual(JSON.parse(fs.readFileSync(bRuntime.routePath, 'utf8')).rules, []);
  assert.ok(!fs.readFileSync(bRuntime.dnsPath, 'utf8').includes('shared.corp.example'));
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
test('Company protection applies only to the selected attempt and restores saved targets on reconnect', (t) => {
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
  for (const r of policy.runtime().profiles)
    for (const file of [r.guardPath, r.dnsPath]) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rules, []);
  policy.begin(p.id, repo.list());
  assert.ok(JSON.parse(fs.readFileSync(policy.runtime().profiles[0].guardPath, 'utf8')).rules.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(policy.runtime().profiles[1].guardPath, 'utf8')).rules, []);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(restarted.runtime().profiles[0].guardPath, 'utf8')).rules, []);
  restarted.begin(p.id, repo.list());
  assert.ok(
    fs
      .readFileSync(restarted.runtime().profiles[0].guardPath, 'utf8')
      .includes('10.30.40.0/24'),
  );
  assert.equal(restarted.runtime().profiles[1].profile.id, other.id);
  restarted.deactivate(repo.list());
  for (const r of restarted.runtime().profiles)
    for (const file of [r.guardPath, r.dnsPath, r.routePath]) assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rules, []);
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

const untrustedCertificate = () => ({
  fingerprint: 'a'.repeat(64),
  subject: 'CN=fixture',
  issuer: 'CN=fixture',
  validTo: '2040-01-01T00:00:00Z',
  chainTrusted: false,
  trustIssues: ['UNTRUSTED_AUTHORITY', 'NAME_MISMATCH'],
});

test('Upgrade startup preserves saved configuration and revokes previous-session routing files', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), old = new CorporatePolicy(dir);
  old.setProbe(p.id, 'old-session', repo.list());
  const files = ['vpn-profiles.json', 'vpn-vault.json', 'bluewing.json'];
  fs.writeFileSync(path.join(dir, 'vpn-vault.json'), JSON.stringify({ fixture: 'dpapi:fixture-encrypted' }));
  fs.writeFileSync(path.join(dir, 'bluewing.json'), JSON.stringify({ settings: { tunEnabled: true, routingMode: 'rule' }, activeNodeId: 'saved-node' }));
  const saved = files.map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
  const policy = new CorporatePolicy(dir), profiles = new ProfileRepository(dir);
  const manager = new CorporateVpnManager(profiles, policy, new CredentialVault(dir, unavailable), new FakeCore() as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }) });
  t.after(() => manager.dispose());
  assert.equal(manager.snapshot().state.state, 'idle');
  assert.equal(manager.snapshot().state.trafficProtected, false);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(dir, file), 'utf8')), saved);
  const r = policy.runtime().profiles[0];
  for (const file of [r.routePath, r.guardPath, r.dnsPath, r.internetPath!, r.internetDnsPath!, r.discoveredGuardPath!])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rules, []);
  assert.ok(profiles.get(p.id).targets.length > 0);
});

test('VPN attempts isolate guards, retain them on an unexpected drop and release them on explicit stop', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), policy = new CorporatePolicy(dir), core = new FakeCore();
  const manager = new CorporateVpnManager(repo, policy, new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }) }, []);
  t.after(() => manager.dispose());
  t.mock.method(manager as any, 'verifyPolicy', async () => {});
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'fixture-password');
  assert.equal(manager.snapshot().state.trafficProtected, true);
  const emit = (type: string, code?: string) => core.emit('event', { v: 1, type, code, generation: manager.snapshot().state.generation, profileId: p.id });
  emit('tunnelReady'); await new Promise<void>(resolve => setImmediate(resolve));
  emit('error', 'VPN_TRANSPORT_DOWN');
  assert.equal(manager.snapshot().state.state, 'failed');
  assert.equal(manager.snapshot().state.trafficProtected, true);
  const guard = policy.runtime().profiles[0].guardPath;
  assert.ok(JSON.parse(fs.readFileSync(guard, 'utf8')).rules.length > 0);
  await manager.disconnect();
  assert.equal(manager.snapshot().state.trafficProtected, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(guard, 'utf8')).rules, []);
  await manager.connect(p.id, 'fixture-password');
  emit('error', 'AUTH_FAILED');
  assert.equal(manager.snapshot().state.trafficProtected, false, 'An initial rejected login must not leave a hidden guard');
});

test('Discovery observations require the active generation and a cache error never disconnects VPN', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), core = new FakeCore(), policy = new CorporatePolicy(dir);
  const manager = new CorporateVpnManager(repo, policy, new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }) });
  t.after(() => manager.dispose());
  // The end-to-end probe is covered by the real-core integration test.
  t.mock.method(manager as any, 'verifyPolicy', async () => {});
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'fixture-password');
  const generation = manager.snapshot().state.generation;
  const data = { address: '192.168.77.12', port: 22, network: 'tcp', outlet: 'vpn' };
  const emit = (type: string, value = data, gen = generation, id = p.id) => core.emit('event', { v: 1, type, data: value, generation: gen, profileId: id });
  emit('privateRouteObserved'); // Authentication has not completed.
  assert.deepEqual(manager.snapshot().discoveredTargets?.[p.id], []);
  emit('tunnelReady'); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(manager.snapshot().state.state, 'connected');
  emit('privateRouteObserved', data, generation - 1);
  emit('privateRouteObserved', data, generation, 'other-company');
  emit('privateRouteObserved', { ...data, network: 'udp' });
  assert.deepEqual(manager.snapshot().discoveredTargets?.[p.id], []);
  emit('privateRouteObserved');
  assert.equal(manager.snapshot().discoveredTargets?.[p.id].length, 1);
  await assert.rejects(manager.clearDiscoveredTargets(p.id), /断开/);
  const broken = t.mock.method(policy.discovery, 'observe', () => { throw new Error('simulated cache disk failure'); });
  emit('privateRouteObserved', { ...data, address: '192.168.77.13' });
  assert.equal(manager.snapshot().state.state, 'connected');
  broken.mock.restore();
  await manager.disconnect();
  emit('privateRouteObserved', { ...data, address: '192.168.77.14' });
  assert.equal(manager.snapshot().discoveredTargets?.[p.id].length, 1);
  await manager.clearDiscoveredTargets(p.id);
  assert.deepEqual(manager.snapshot().discoveredTargets?.[p.id], []);
  assert.ok(repo.get(p.id).targets.length > 0, 'clearing discovery removed manual resources');
});

test('Automatic gateway trust binds first use, detects changed pins and never downgrades a known CA', () => {
  const certificate = untrustedCertificate();
  const pinned = gatewayTrust({ trustMode: 'auto' }, certificate);
  assert.equal(pinned.pinSha256, certificate.fingerprint);
  assert.equal(pinned.autoTrustAnchor, 'pin');
  assert.throws(
    () => gatewayTrust(pinned, { ...certificate, fingerprint: 'b'.repeat(64) }),
    /TLS_CERT_CHANGED/,
  );
  const trusted = gatewayTrust(
    {},
    { ...certificate, chainTrusted: true, trustIssues: [] },
  );
  assert.equal(trusted.autoTrustAnchor, 'system');
  assert.equal(trusted.pinSha256, undefined);
  assert.throws(() => gatewayTrust(trusted, certificate), /TLS_CERT_CHANGED/);
  assert.equal(
    gatewayTrust(trusted, {
      ...certificate,
      fingerprint: 'b'.repeat(64),
      chainTrusted: true,
      trustIssues: [],
    }).autoTrustAnchor,
    'system',
  );
  for (const issue of [
    'EXPIRED',
    'NOT_YET_VALID',
    'INVALID_CA',
    'CHAIN_INVALID',
  ])
    assert.throws(() =>
      gatewayTrust(
        {},
        { ...certificate, trustIssues: [...certificate.trustIssues, issue] },
      ),
    );
  assert.throws(
    () => gatewayTrust({ caPem: 'configured CA' }, certificate),
    /TLS_UNTRUSTED/,
  );
  assert.throws(
    () => gatewayTrust({}, { ...certificate, trustIssues: ['NAME_MISMATCH'] }),
    /TLS_UNTRUSTED/,
  );
});

test('Passwords save without a login, persist encrypted, restore on reconnect and clear when disabled', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    core = new FakeCore();
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('fixture:' + value),
    decryptString: (value: Buffer) => value.toString().slice(8),
  };
  const manager = new CorporateVpnManager(
    repo,
    new CorporatePolicy(dir),
    new CredentialVault(dir, encryption),
    core as unknown as VpnCoreProcess,
    {
      running: () => true,
      pid: () => 1,
      settings: () => ({ mixedPort: 12345 }),
    },
  );
  t.after(() => manager.dispose());
  await manager.savePassword(p.id, 'fixture-saved-secret', true);
  assert.equal(manager.snapshot().passwordSaved?.[p.id], true);
  assert.equal(core.commands.filter((c) => c.type === 'connect').length, 0);
  assert.ok(
    !JSON.stringify(manager.snapshot()).includes('fixture-saved-secret'),
  );
  assert.ok(
    !fs
      .readFileSync(path.join(dir, 'vpn-vault.json'), 'utf8')
      .includes('fixture-saved-secret'),
  );
  assert.ok(
    !fs
      .readFileSync(path.join(dir, 'vpn-profiles.json'), 'utf8')
      .includes('fixture-saved-secret'),
  );
  const reloaded = new CorporateVpnManager(
    new ProfileRepository(dir),
    new CorporatePolicy(dir),
    new CredentialVault(dir, encryption),
    core as unknown as VpnCoreProcess,
    {
      running: () => true,
      pid: () => 1,
      settings: () => ({ mixedPort: 12345 }),
    },
  );
  t.after(() => reloaded.dispose());
  reloaded.publicCoreStarted(await reloaded.prepareRuntime());
  await reloaded.connect(p.id, '');
  assert.equal(
    core.commands.find((c) => c.type === 'connect').password,
    'fixture-saved-secret',
  );
  await reloaded.disconnect();
  await reloaded.savePassword(p.id, '', false);
  assert.equal(reloaded.snapshot().passwordSaved?.[p.id], false);
  await assert.rejects(reloaded.connect(p.id, ''), /请输入密码/);
});

test('Unavailable system encryption cannot enable password memory', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save(sample()),
    manager = new CorporateVpnManager(
      repo,
      new CorporatePolicy(dir),
      new CredentialVault(dir, unavailable),
      new FakeCore() as unknown as VpnCoreProcess,
      {
        running: () => true,
        pid: () => 1,
        settings: () => ({ mixedPort: 12345 }),
      },
    );
  t.after(() => manager.dispose());
  await assert.rejects(
    manager.savePassword(p.id, 'fixture-secret', true),
    /CREDENTIAL_STORE_LOCKED/,
  );
  assert.equal(repo.get(p.id).rememberPassword, false);
  assert.ok(!fs.existsSync(path.join(dir, 'vpn-vault.json')));
});

test('Automatic pin is persisted before credentials are sent and a changed certificate stops login', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save({ ...sample(), tls: { trustMode: 'auto' } }),
    core = new FakeCore();
  let certificate = untrustedCertificate();
  const request = core.request.bind(core);
  core.request = async (type, data) =>
    type === 'serverCertificate'
      ? ({
          v: 1,
          type: 'serverCertificate',
          generation: 0,
          data: certificate,
        } as any)
      : request(type, data);
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
  manager.publicCoreStarted(await manager.prepareRuntime());
  const send = core.send.bind(core);
  core.send = (type, data = {}) => {
    if (type === 'connect')
      assert.equal(repo.get(p.id).tls.pinSha256, certificate.fingerprint);
    send(type, data);
  };
  await manager.connect(p.id, 'fixture-secret');
  assert.equal(
    core.commands.find((c) => c.type === 'connect').profile.tls.pinSha256,
    certificate.fingerprint,
  );
  await manager.disconnect();
  certificate = { ...certificate, fingerprint: 'b'.repeat(64) };
  await assert.rejects(
    manager.connect(p.id, 'fixture-secret'),
    /TLS_CERT_CHANGED/,
  );
  assert.equal(core.commands.filter((c) => c.type === 'connect').length, 1);
  assert.equal(repo.get(p.id).tls.pinSha256, 'a'.repeat(64));
  await manager.save({
    ...repo.get(p.id),
    gateway: { host: 'new.example.com', port: 10443 },
  });
  assert.equal(repo.get(p.id).tls.pinSha256, undefined);
  assert.equal(repo.get(p.id).tls.autoTrustAnchor, undefined);
});

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

test('Cancel during certificate inspection neither binds trust nor sends a late password', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save({ ...sample(), tls: { trustMode: 'auto' } }),
    core = new FakeCore();
  let release!: () => void, inspecting!: () => void;
  const ready = new Promise<void>((resolve) => (inspecting = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const request = core.request.bind(core);
  core.request = async (type, data) => {
    if (type !== 'serverCertificate') return request(type, data);
    inspecting();
    await gate;
    return {
      v: 1,
      type: 'serverCertificate',
      generation: 0,
      data: untrustedCertificate(),
    } as any;
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
  manager.publicCoreStarted(await manager.prepareRuntime());
  const connecting = manager.connect(p.id, 'fixture-secret');
  await ready;
  await manager.disconnect();
  release();
  await connecting;
  assert.equal(repo.get(p.id).tls.pinSha256, undefined);
  assert.equal(
    core.commands.filter((command) => command.type === 'connect').length,
    0,
  );
  assert.equal(manager.snapshot().state.state, 'idle');
});

test('aTrust discovery applies first-use trust before querying authentication methods', async (t) => {
  const dir = temp(t),
    repo = new ProfileRepository(dir),
    p = repo.save({
      ...sample(),
      protocol: 'atrust',
      tls: { trustMode: 'auto' },
    }),
    core = new FakeCore();
  core.request = async (type, data) => {
    if (type === 'serverCertificate')
      return { v: 1, type, generation: 0, data: untrustedCertificate() } as any;
    assert.equal(type, 'discoverAuth');
    assert.equal(data.profile.tls.pinSha256, 'a'.repeat(64));
    assert.equal(repo.get(p.id).tls.pinSha256, 'a'.repeat(64));
    return {
      v: 1,
      type,
      generation: 0,
      data: [
        {
          authType: 'auth/psw',
          authName: 'fixture',
          loginDomain: 'local',
          supported: true,
        },
      ],
    } as any;
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
  const methods = await manager.discover(p.id);
  assert.equal(methods[0].loginDomain, 'local');
  assert.deepEqual(new ProfileRepository(dir).get(p.id).authChoices, methods);
  assert.equal(new ProfileRepository(dir).get(p.id).tls.pinSha256, 'a'.repeat(64));
  assert.equal(
    core.commands.filter((command) => command.type === 'connect').length,
    0,
  );
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
test('Cancelling authentication gives the next challenge a fresh deadline and ignores previous-round timeouts', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 23) });
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), core = new FakeCore();
  const manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess, {
    running: () => true, pid: () => 123, settings: () => ({ mixedPort: 12345 }),
  });
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'fixture-password');
  const oldGeneration = manager.snapshot().state.generation;
  const challenge = (generation: number, id: string, expiresAt: number) => core.emit('event', {
    v: 1, type: 'challenge', profileId: p.id, generation,
    data: { id, kind: 'otp', title: '验证码', expiresAt },
  });
  challenge(oldGeneration, 'old', Date.now() + 30000);
  t.mock.timers.tick(20000);
  await manager.disconnect();
  await manager.connect(p.id, 'fixture-password');
  const generation = manager.snapshot().state.generation, expiresAt = Date.now() + 120000;
  challenge(generation, 'fresh', expiresAt);
  t.mock.timers.tick(11000);
  core.emit('event', { v: 1, type: 'error', profileId: p.id, generation: oldGeneration, code: 'AUTH_CHALLENGE_EXPIRED' });
  assert.equal(manager.snapshot().state.state, 'waiting_user');
  assert.equal(manager.snapshot().state.challenge?.expiresAt, expiresAt);
  assert.throws(() => manager.respond('old', oldGeneration, '123456'), /EXPIRED/);
  challenge(generation, 'fresh', Date.now() + 120000);
  assert.equal(manager.snapshot().state.challenge?.expiresAt, expiresAt, 'reopening/replaying the same challenge must not extend its deadline');
  t.mock.timers.tick(108999);
  manager.respond('fresh', generation, '123456');
  challenge(generation, 'second-step', Date.now() + 60000);
  t.mock.timers.tick(1);
  assert.equal(manager.snapshot().state.state, 'waiting_user', 'previous challenge timer cannot expire a subsequent step');
  const disconnects = core.commands.filter(c => c.type === 'disconnect').length;
  t.mock.timers.tick(59999);
  assert.equal(manager.snapshot().state.error, 'AUTH_CHALLENGE_EXPIRED');
  assert.equal(core.commands.filter(c => c.type === 'disconnect').length, disconnects + 1);
  assert.throws(() => manager.respond('second-step', generation, '123456'), /EXPIRED/);
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
test('Only explicit full diagnostics records exact submitted input, and clear removes rotated logs', t => {
  const dir = temp(t), repo = new ProfileRepository(dir), log = new VpnDiagnostics(dir, 100);
  const secret = '  fixture-password\\n!\n', otp = ' 123456 ';
  for (const diagnosticMode of ['off', 'detail', 'full'] as const) {
    const p = repo.save({ ...sample(), diagnosticMode });
    log.begin(p, 1); log.input(p.id, 'password', secret); log.input(p.id, 'verification-code', otp);
    const all = [log.file(p.id) + '.1', log.file(p.id)].filter(fs.existsSync).flatMap(f => fs.readFileSync(f, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const inputs = all.filter(e => e.event === 'submitted-input');
    assert.equal(inputs.length, diagnosticMode === 'full' ? 2 : 0);
    if (diagnosticMode === 'full') assert.deepEqual(inputs.map(e => e.value), [secret, otp]);
    assert.ok(!JSON.stringify(repo.list()).includes('fixture-password'));
    assert.ok(repo.export().every(profile => profile.diagnosticMode === 'off'));
    const imported = new ProfileRepository(path.join(dir, 'imported-' + diagnosticMode));
    imported.import([p], 'replace');
    assert.equal(imported.list()[0].diagnosticMode, 'off');
    log.clear(p.id); assert.equal(log.info(p).exists, false); assert.equal(fs.existsSync(log.file(p.id) + '.1'), false);
  }
  assert.throws(() => log.file('../outside'), /ID/);
  assert.throws(() => validateProfile({ ...sample(), diagnosticMode: 'unknown' }), /诊断/);
});

test('VPN diagnostics correlate the active generation and preserve original trusted-endpoint failures', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), core = new FakeCore();
  const p = repo.save({ ...sample(), protocol: 'atrust', diagnosticMode: 'full', loginDomain: 'custom', authName: '示例认证' });
  const manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 1, settings: () => ({ mixedPort: 12345 }) });
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.connect(p.id, 'example-local-password');
  const generation = manager.snapshot().state.generation;
  const emit = (type: string, data: any, gen = generation, code?: string) => core.emit('event', { v: 1, type, profileId: p.id, generation: gen, data, code });
  emit('diagnostic', { responseBody: 'stale-content' }, generation - 1);
  emit('diagnostic', { responseBody: 'original-cookie-123' });
  emit('challenge', { id: 'otp', kind: 'otp', title: 'code', expiresAt: Date.now() + 30000 });
  manager.respond('otp', generation, '654321');
  assert.throws(() => manager.respond('otp', generation, 'stale-otp'), /EXPIRED/);
  const detail = { stage: 'authCheck', serverCode: '75500503', message: 'authCheck failed with code 75500503: client is not installed' };
  emit('error', detail, generation, 'ATRUST_TRUSTED_ENDPOINT_REQUIRED');
  assert.deepEqual(manager.snapshot().state.errorDetail, detail);
  const text = fs.readFileSync(manager.diagnosticFile(p.id), 'utf8');
  for (const expected of ['example-local-password', '654321', 'original-cookie-123', '75500503']) assert.ok(text.includes(expected));
  for (const stale of ['stale-content', 'stale-otp']) assert.ok(!text.includes(stale));
  assert.ok(!JSON.stringify(manager.snapshot()).includes('example-local-password'));
  await manager.save({ ...p, diagnosticMode: 'off' });
  assert.equal(manager.snapshot().state.errorDetail, undefined);
  manager.clearDiagnostics(p.id); assert.throws(() => manager.diagnosticFile(p.id), /尚无/);
});
test('Connecting prepares newly saved VPN routing once and leaves the public outlet alone on save', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), core = new FakeCore();
  let applications = 0, manager!: CorporateVpnManager;
  manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess, {
    running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }),
    applyRouting: async isCurrent => {
      applications++; assert.equal(isCurrent(), true);
      assert.equal(manager.snapshot().state.preparingRouting, true);
      assert.ok(!core.commands.some(c => c.type === 'connect'));
      manager.publicCoreStarted(await manager.prepareRuntime(true));
      return true;
    },
  });
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  const p = (await manager.save(sample())).profile;
  assert.equal(applications, 0); assert.equal(core.commands.length, 0);
  assert.equal(manager.snapshot().state.requiresCoreRebuild, true);
  await assert.rejects(manager.connect(p.id, ''), /请输入密码/);
  assert.equal(applications, 0, 'missing credentials must not restart the public proxy');
  const attempts = await Promise.allSettled([manager.connect(p.id, 'fixture-secret'), manager.connect(p.id, 'duplicate')]);
  assert.equal(attempts[0].status, 'fulfilled'); assert.equal(attempts[1].status, 'rejected');
  assert.equal(applications, 1);
  assert.equal(core.commands.filter(c => c.type === 'connect').length, 1);
  assert.equal(manager.snapshot().state.preparingRouting, false);
  await manager.disconnect();
  await manager.save({ ...p, name: 'Renamed only' });
  await manager.connect(p.id, 'fixture-secret');
  assert.equal(applications, 1, 'reconnect and rename must not reload routing');
});

test('Profile ordering and password changes do not invalidate installed VPN outbounds', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), a = repo.save(sample()); repo.save({ ...sample(), name: 'Second' });
  const manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), new FakeCore() as unknown as VpnCoreProcess,
    { running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }) });
  t.after(() => manager.dispose());
  manager.publicCoreStarted(await manager.prepareRuntime());
  await manager.save({ ...a, name: 'Renamed' });
  await manager.savePassword(a.id, '', false);
  assert.equal(manager.snapshot().state.requiresCoreRebuild, false);
  await manager.connect(a.id, 'fixture-secret');
  assert.equal(manager.snapshot().state.state, 'authenticating');
});

test('Cold start prepares routing without a proxy node and refuses login when preparation fails', async t => {
  for (const success of [true, false]) {
    const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), core = new FakeCore();
    let running = false, manager!: CorporateVpnManager;
    manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess, {
      running: () => running, pid: () => running ? 7 : undefined, settings: () => ({ mixedPort: 12345 }),
      applyRouting: async () => {
        if (success) { running = true; manager.publicCoreStarted(await manager.prepareRuntime(true)); }
        else manager.publicCoreStopped();
        return success;
      },
    });
    t.after(() => manager.dispose());
    if (success) await manager.connect(p.id, 'fixture-secret');
    else await assert.rejects(manager.connect(p.id, 'fixture-secret'), /ROUTING_PREPARE_FAILED/);
    assert.equal(manager.snapshot().state.state, success ? 'authenticating' : 'failed');
    assert.equal(core.commands.some(c => c.type === 'connect'), success);
  }
});

test('Cancelling automatic routing prevents late credentials and stale success from logging into VPN', async t => {
  const dir = temp(t), repo = new ProfileRepository(dir), p = repo.save(sample()), core = new FakeCore();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
  const manager = new CorporateVpnManager(repo, new CorporatePolicy(dir), new CredentialVault(dir, unavailable), core as unknown as VpnCoreProcess, {
    running: () => true, pid: () => 7, settings: () => ({ mixedPort: 12345 }),
    applyRouting: async isCurrent => { entered(); await gate; assert.equal(isCurrent(), false); return true; },
  });
  t.after(() => manager.dispose());
  const pending = manager.connect(p.id, 'must-not-send');
  await ready; await manager.disconnect(); release(); await pending;
  assert.equal(manager.snapshot().state.state, 'idle');
  assert.equal(manager.snapshot().state.preparingRouting, false);
  assert.ok(!core.commands.some(c => c.type === 'connect'));
});
