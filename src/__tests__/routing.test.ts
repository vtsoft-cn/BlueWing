import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { SpeedTestRunner } from '../main/net/SpeedTestRunner';
import { ProcessScanner } from '../main/system/ProcessScanner';
import { ProxyNode, RouteRule, AppRule, DnsConfig, AppSettings } from '../types';
import { VpnRuntime } from '../types/corporateVpn';

const execFileAsync = promisify(execFile);

const defaultSettings: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  startOnBoot: false,
  startMinimized: false,
  autoConnectOnLaunch: false,
  closeToTray: true,
  mixedPort: 2080,
  allowLan: false,
  inboundAuth: false,
  systemProxyEnabled: false,
  systemProxyBypassLan: true,
  tunEnabled: false,
  tunStack: 'system',
  tunDevice: 'BlueWingTun',
  tunMtu: 9000,
  tunStrictRoute: false,
  tunEndpointIndependentNat: true,
  tunIPv6: false,
  tunAutoRoute: true,
  logLevel: 'warn',
  dnsCache: true,
};

const sampleNode: ProxyNode = {
  id: 'node-test',
  name: 'Test Node',
  type: 'socks',
  server: '1.2.3.4',
  port: 1080,
  groupId: 'default',
};

describe('ProcessScanner', () => {
  test('Returns list containing preset applications', async () => {
    const apps = await ProcessScanner.getRunningProcesses();
    assert.ok(Array.isArray(apps), 'Result must be an array');
    assert.ok(apps.length >= ProcessScanner.PRESET_APPS.length, 'Must contain at least preset apps');

    const chrome = apps.find((a) => a.exePath.toLowerCase().includes('chrome.exe'));
    assert.ok(chrome, 'Chrome must be in scanned / preset apps');

    const telegram = apps.find((a) => a.exePath.toLowerCase().includes('telegram.exe'));
    assert.ok(telegram, 'Telegram must be in scanned / preset apps');
  });
});

describe('Routing and App Rules in ConfigGenerator', () => {
  test('Correctly formats app process routing rules (proxy, direct, reject)', () => {
    const appRules: AppRule[] = [
      { id: '1', name: 'Google Chrome', exePath: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"', action: 'proxy', enabled: true },
      { id: '2', name: 'Steam Client', exePath: 'D:\\Games\\Steam\\steam.exe', action: 'direct', enabled: true },
      { id: '3', name: 'Blocked App', exePath: 'malware.exe', action: 'block', enabled: true },
      { id: '4', name: 'Disabled App', exePath: 'disabled.exe', action: 'proxy', enabled: false },
    ];

    const dns: DnsConfig = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
    };

    const config = ConfigGenerator.generate('node-test', [sampleNode], [], appRules, dns, defaultSettings);
    const rules = config.route.rules;

    // 1. Chrome proxy rule
    const chromeRule = rules.find((r: any) => r.process_name && r.process_name.includes('chrome.exe'));
    assert.ok(chromeRule, 'Chrome rule must exist');
    assert.equal(chromeRule.outbound, 'proxy');

    // 2. Steam direct rule
    const steamRule = rules.find((r: any) => r.process_name && r.process_name.includes('steam.exe'));
    assert.ok(steamRule, 'Steam rule must exist');
    assert.equal(steamRule.outbound, 'direct');

    // 3. Blocked app reject rule
    const blockedRule = rules.find((r: any) => r.process_name && r.process_name.includes('malware.exe'));
    assert.ok(blockedRule, 'Blocked app rule must exist');
    assert.equal(blockedRule.action, 'reject');

    // 4. Disabled rule should not be included
    const disabledRule = rules.find((r: any) => r.process_name && r.process_name.includes('disabled.exe'));
    assert.equal(disabledRule, undefined, 'Disabled app rule must not be included');
  });

  test('ws transport falls back to SNI as Host when transport host is missing (CDN IP nodes)', () => {
    // 复现线上问题:旧版导入的 CF 优选 IP 节点无 transportHost,ws 升级以裸 IP 作 Host
    // 被 Cloudflare 以 403 (Direct IP access not allowed) 拒绝,必须回退 SNI
    const cdnNode: ProxyNode = {
      id: 'node-cdn',
      name: 'CF IP node',
      type: 'vless',
      server: '172.67.78.115',
      port: 2087,
      groupId: 'default',
      uuid: '5da33dc5-f22f-4501-8c6e-3506ad1e89f5',
      tls: true,
      sni: 'vtsoft.cn',
      transport: 'ws',
    };

    const dns: DnsConfig = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
    };

    const config = ConfigGenerator.generate('node-cdn', [cdnNode], [], [], dns, defaultSettings);
    const outbound = config.outbounds.find((o: any) => o.tag === 'node-node-cdn');
    assert.ok(outbound, 'vless outbound must exist');
    assert.equal(outbound.transport.type, 'ws');
    assert.equal(outbound.transport.headers?.Host, 'vtsoft.cn', 'ws Host must fall back to SNI');
  });

  test('CN direct rules precede app proxy rules; app block rules stay ahead of everything', () => {
    const appRules: AppRule[] = [
      { id: '1', name: 'Microsoft Edge', exePath: 'msedge.exe', action: 'proxy', enabled: true },
      { id: '2', name: 'Blocked App', exePath: 'malware.exe', action: 'block', enabled: true },
    ];

    const dns: DnsConfig = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
    };

    const config = ConfigGenerator.generate('node-test', [sampleNode], [], appRules, dns, {
      ...defaultSettings,
      routingMode: 'rule',
    });
    const rules: any[] = config.route.rules;

    const cnIdx = rules.findIndex((r: any) => r.rule_set?.includes('geosite-cn') && r.outbound === 'direct');
    const edgeIdx = rules.findIndex((r: any) => r.process_name?.includes('msedge.exe'));
    const blockIdx = rules.findIndex((r: any) => r.process_name?.includes('malware.exe'));

    assert.ok(cnIdx >= 0, 'geosite-cn direct rule must exist');
    assert.ok(edgeIdx >= 0, 'msedge proxy rule must exist');
    assert.ok(blockIdx >= 0, 'malware block rule must exist');
    assert.ok(cnIdx < edgeIdx, 'CN direct must be evaluated before app proxy rules');
    assert.ok(blockIdx < cnIdx, 'app block rule must stay ahead of all domain rules');
  });

  test('Company rules can take priority while both CN direct rules remain enabled', () => {
    const companyNode: ProxyNode = {
      id: 'company-vpn', name: 'Company VPN', type: 'socks',
      server: '127.0.0.1', port: 11080, groupId: 'default',
    };
    const customRules: RouteRule[] = [
      {
        id: 'company-domains', name: 'Company domains', enabled: true,
        domains: ['full:dev.corp.example', 'full:uat.corp.example', 'full:prod.corp.example'],
        outbound: companyNode.id,
      },
      {
        id: 'company-networks', name: 'Company networks', enabled: true,
        ip: ['10.20.30.0/24', '10.20.40.0/24', '10.20.50.0/24'],
        outbound: companyNode.id,
      },
      { id: 'rule-cn-domains', name: 'CN domains', enabled: true, domains: ['geosite:cn'], outbound: 'direct' },
      { id: 'rule-cn-ips', name: 'CN IPs', enabled: true, ip: ['geoip:cn'], outbound: 'direct' },
    ];
    const dns: DnsConfig = {
      mode: 'standard', remoteDns: 'https://1.1.1.1/dns-query', directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15', enableDnsRouting: true, servers: [],
    };
    const config = ConfigGenerator.generate(sampleNode.id, [sampleNode, companyNode], customRules, [], dns, {
      ...defaultSettings, routingMode: 'rule', systemProxyBypassLan: false,
    });
    const generated: any[] = config.route.rules;
    const companyDomainIndex = generated.findIndex(r => r.domain?.includes('dev.corp.example'));
    const companyIpIndex = generated.findIndex(r => r.ip_cidr?.includes('10.20.30.0/24'));
    const cnDomainIndex = generated.findIndex(r => r.rule_set?.includes('geosite-cn') && r.outbound === 'direct');
    const cnIpIndex = generated.findIndex(r => r.rule_set?.includes('geoip-cn') && r.outbound === 'direct');

    assert.ok(companyDomainIndex >= 0 && companyIpIndex > companyDomainIndex);
    assert.ok(cnDomainIndex > companyIpIndex, 'Company destinations must precede CN domain bypass');
    assert.ok(cnIpIndex > companyIpIndex, 'Company destinations must precede CN IP bypass');
    assert.equal(generated[companyDomainIndex].outbound, 'node-company-vpn');
    assert.equal(generated[companyIpIndex].outbound, 'node-company-vpn');
    assert.equal(config.route.final, 'proxy', 'Other traffic must keep the public proxy fallback');
    assert.equal(config.outbounds.find((o: any) => o.tag === 'proxy').default, 'node-node-test');
  });

  test('Adaptive HTTPS runs after explicit and managed routes, and stays out of global and TUN modes', () => {
    const dns: DnsConfig = {
      mode: 'standard', remoteDns: 'https://1.1.1.1/dns-query', directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15', enableDnsRouting: true, servers: [],
    };
    const explicit: RouteRule = {
      id: 'pinned', name: 'Pinned', enabled: true, domains: ['full:pinned.example.com'], outbound: 'proxy',
    };
    const settings: AppSettings = { ...defaultSettings, routingMode: 'rule' };
    const runtime = (trafficMode: 'split' | 'custom') => ({
      coreProcessName: 'bluewing-vpn-core.exe',
      profiles: [{
        profile: { id: 'company', trafficMode, gateway: { host: 'vpn.example.com' }, socksPort: 22101, dnsPort: 22102 },
        socksUser: 'fixture', socksPassword: 'fixture', routePath: 'route.json',
        guardPath: 'guard.json', dnsPath: 'dns.json', internetPath: 'internet.json',
      }],
    } as VpnRuntime);
    const generate = (overrides: Partial<AppSettings>, company?: VpnRuntime) =>
      ConfigGenerator.generate(sampleNode.id, [sampleNode], [explicit], [], dns, { ...settings, ...overrides }, false, company);
    const split = generate({}, runtime('split')).route.rules;
    const firstAdaptive = split.findIndex((rule: any) => rule.outbound === 'adaptive-public');
    assert.ok(firstAdaptive > split.findIndex((rule: any) => rule.domain?.includes('pinned.example.com')));
    assert.ok(firstAdaptive > split.findIndex((rule: any) => rule.rule_set?.includes('corp-guard-company')));
    assert.ok(split[firstAdaptive].rules.some((rule: any) => rule.rule_set?.includes('corp-internet-company')));
    assert.equal(split[firstAdaptive + 1].outbound, 'proxy');
    const custom = generate({}, runtime('custom')).route.rules;
    assert.equal(custom.filter((rule: any) => rule.outbound === 'adaptive-public').length, 1);
    assert.equal(custom.at(-1).outbound, 'adaptive-public');
    for (const override of [{ routingMode: 'global' }, { routingMode: 'direct' }, { tunEnabled: true }] as const) {
      const config = generate(override);
      assert.ok(!config.outbounds.some((outbound: any) => outbound.tag === 'adaptive-public'));
    }
  });

  test('Configures custom DNS servers and cache capacity in Sing-box', () => {
    const dns: DnsConfig = {
      mode: 'fakeip',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [
        { id: 'custom-1', tag: 'custom-dns', address: 'tls://8.8.8.8:853', detour: 'proxy' },
      ],
    };

    const config = ConfigGenerator.generate('node-test', [sampleNode], [], [], dns, defaultSettings);

    // Check DNS servers
    const customServer = config.dns.servers.find((s: any) => s.tag === 'custom-dns');
    assert.ok(customServer, 'Custom DNS server must be included');
    assert.equal(customServer.type, 'tls');
    assert.equal(customServer.server, '8.8.8.8');
    assert.equal(customServer.server_port, 853);
    assert.equal(customServer.detour, 'proxy');

    // Check FakeIP server
    const fakeIpServer = config.dns.servers.find((s: any) => s.tag === 'fakeip-dns');
    assert.ok(fakeIpServer, 'fakeip-dns server must be included');
    assert.equal(fakeIpServer.type, 'fakeip');

    // Check cache capacity
    assert.equal(config.dns.cache_capacity, 4096, 'DNS cache capacity must be set');
  });

  test('Validates app routing and custom DNS config with real sing-box.exe check', async () => {
    const appRules: AppRule[] = [
      { id: '1', name: 'Google Chrome', exePath: 'chrome.exe', action: 'proxy', enabled: true },
      { id: '2', name: 'Steam Client', exePath: 'steam.exe', action: 'direct', enabled: true },
      { id: '3', name: 'Blocked App', exePath: 'malware.exe', action: 'block', enabled: true },
    ];

    const dns: DnsConfig = {
      mode: 'fakeip',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [
        { id: 'custom-1', tag: 'custom-dns', address: 'tls://8.8.8.8:853', detour: 'proxy' },
      ],
    };

    const config = ConfigGenerator.generate('node-test', [sampleNode], [], appRules, dns, defaultSettings);
    const tempConfigPath = path.resolve(__dirname, 'temp_routing_test_config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2), 'utf-8');

    const singBoxExe = path.resolve(__dirname, '../../bin/sing-box.exe');
    try {
      await execFileAsync(singBoxExe, ['check', '-c', tempConfigPath]);
      assert.ok(true, 'sing-box check succeeded for app routing and DNS');
    } finally {
      if (fs.existsSync(tempConfigPath)) {
        fs.unlinkSync(tempConfigPath);
      }
    }
  });

  test('App process rules follow domain/IP rules and take precedence over automatic fallback', () => {
    // 修复回归:进程规则(chrome.exe→proxy)此前排在分流规则之前,导致国内站也被送进代理
    const dns: DnsConfig = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
    };
    const rules: RouteRule[] = [
      { id: 'rule-lan', name: '局域网直连', enabled: true, ip: ['geoip:private'], outbound: 'direct' },
      { id: 'rule-cn', name: '国内直连', enabled: true, domains: ['geosite:cn'], outbound: 'direct' },
    ];
    const appRules: AppRule[] = [
      { id: '1', name: 'Google Chrome', exePath: 'chrome.exe', action: 'proxy', enabled: true },
    ];
    const settings = { ...defaultSettings, routingMode: 'rule' as const };

    const config = ConfigGenerator.generate('node-test', [sampleNode], rules, appRules, dns, settings);
    const gen: any[] = config.route.rules;

    const appIdx = gen.findIndex((r) => r.process_name && r.process_name.includes('chrome.exe'));
    assert.ok(appIdx > -1, 'Chrome app rule must exist');

    // 所有 rule_set 类分流规则(自定义 geoip/geosite 与模式规则)必须排在进程规则之前
    const lastRuleSetIdx = Math.max(...gen.map((r, i) => (r.rule_set ? i : -1)));
    assert.ok(
      appIdx > lastRuleSetIdx,
      `app rule (index ${appIdx}) must come after the last routing rule (index ${lastRuleSetIdx})`
    );

    const adaptiveIdx = gen.findIndex((rule) => rule.outbound === 'adaptive-public');
    assert.ok(adaptiveIdx > appIdx, 'the explicit app rule must win over automatic fallback');
  });
  test('Remote rule-set fallback never mixes download_detour with http_client', () => {
    // 回归:本地规则文件缺失时回退远程规则集,旧代码同时写 http_client + 已废弃的
    // download_detour,sing-box 1.14.3 启动即 FATAL"http_client is conflict with
    // deprecated download_detour field"(sing-box check 查不出,仅启动时暴露)
    const dns: DnsConfig = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      servers: [],
    };
    const rules: RouteRule[] = [
      { id: 'r1', name: 'geosite telegram', enabled: true, domains: ['geosite:telegram'], outbound: 'proxy' },
      { id: 'r2', name: 'geoip google', enabled: true, ip: ['geoip:google'], outbound: 'proxy' },
    ];

    const origExists = fs.existsSync;
    (fs as any).existsSync = (p: any) =>
      typeof p === 'string' && /[\\/]rules([\\/]|$)/.test(p) ? false : origExists(p);
    try {
      const config = ConfigGenerator.generate('node-test', [sampleNode], rules, [], dns, defaultSettings);
      const remotes: any[] = config.route.rule_set.filter((rs: any) => rs.type === 'remote');
      assert.ok(remotes.length >= 4, `expected remote fallback rule-sets, got ${remotes.length}`);
      for (const rs of remotes) {
        assert.equal(rs.download_detour, undefined, `rule-set ${rs.tag} must not carry deprecated download_detour`);
        assert.equal(rs.http_client, 'default', `rule-set ${rs.tag} must keep default http_client`);
      }
    } finally {
      (fs as any).existsSync = origExists;
    }
  });
});

describe('SpeedTestRunner.classifyProbeFailure', () => {
  test('Classifies probe failures into actionable Chinese reasons', () => {
    assert.match(
      SpeedTestRunner.classifyProbeFailure('open connection to x:443: reality verification failed'),
      /REALITY/
    );
    assert.match(SpeedTestRunner.classifyProbeFailure('tls: certificate verification failure'), /TLS/);
    assert.match(SpeedTestRunner.classifyProbeFailure('exchange4: context deadline exceeded'), /超时/);
    assert.match(SpeedTestRunner.classifyProbeFailure('lookup node.example.com: no such host'), /域名解析/);
    assert.match(SpeedTestRunner.classifyProbeFailure('dial tcp: connection refused'), /拒绝/);
    assert.match(SpeedTestRunner.classifyProbeFailure(''), /未知/);
    // 未归类的原始错误应原样透出,不吞信息
    assert.match(SpeedTestRunner.classifyProbeFailure('something odd happened'), /something odd happened/);
  });
});
