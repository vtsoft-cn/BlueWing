import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UniversalSubscriptionParser } from '../main/net/UniversalSubscriptionParser';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { ProxySelectionService } from '../main/core/ProxySelectionService';
import { SystemProxy } from '../main/system/SystemProxy';
import { TakeoverLinkage } from '../main/system/TakeoverLinkage';
import { TunAdapter } from '../main/system/TunAdapter';
import { ProxyNode, RouteRule, AppRule, DnsConfig, AppSettings } from '../types';
import { isValidIpLiteral, isValidDomain } from '../utils/ip';
import { vlessShareLink } from '../utils/vlessShareLink';

const execFileAsync = promisify(execFile);

// 收尾清理:本文件部分用例使用临时测试库,退出时移除,避免残留
process.on('exit', () => {
  fs.rmSync(path.resolve(__dirname, 'temp_db_core_test'), { recursive: true, force: true });
});

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
};

const defaultDns: DnsConfig = {
  mode: 'standard',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: 'udp://223.5.5.5',
  fakeIpRange: '198.18.0.0/15',
  enableDnsRouting: false,
  servers: [],
};

describe('UniversalSubscriptionParser', () => {
  test('Copy → delete → import preserves Reality Vision and transport/TLS settings in the effective outbound', () => {
    const nativeOutbound = (node: ProxyNode) => {
      const config = ConfigGenerator.generate(node.id, [node], [], [], defaultDns, defaultSettings);
      const outbound = { ...config.outbounds.find((o: any) => o.tag === `node-${node.id}`) };
      delete outbound.tag;
      return outbound;
    };
    for (const transport of ['tcp', 'ws', 'grpc', 'http', 'xhttp'] as const) {
      const node: ProxyNode = {
        id: 'original', name: '测试节点 & # / 中文', groupId: 'test', type: 'vless',
        server: transport === 'ws' ? '2001:db8::1' : 'proxy.example.com', port: 443,
        uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811', tls: true, reality: true,
        flow: transport === 'tcp' ? 'xtls-rprx-vision' : undefined,
        sni: 'tls.example.com', publicKey: 'fixture-public-key', shortId: 'abcdef', fingerprint: 'firefox',
        alpn: ['h2', 'http/1.1'], insecure: false, transport,
        transportPath: '/a?key=1&other=2', transportHost: 'cdn.example.com',
        ...(transport === 'xhttp' ? { xhttpMode: 'stream-one', xhttpExtraHeaders: { 'X-Fixture': 'value & more' } } : {}),
      };
      const copied = vlessShareLink(node);
      if (transport === 'tcp') assert.equal(new URL(copied).searchParams.get('flow'), 'xtls-rprx-vision');
      const restored = UniversalSubscriptionParser.parse(copied)[0];
      assert.ok(restored);
      assert.equal(restored.name, node.name);
      assert.deepEqual(nativeOutbound(restored), nativeOutbound(node), transport);
      if (transport === 'xhttp') assert.equal(restored.xhttpMode, 'stream-one');
    }
  });

  test('Copying native VLESS extensions uses importable JSON and never guesses a missing flow', () => {
    const node: ProxyNode = { id: 'raw', name: 'Native fixture', groupId: 'test', type: 'vless', server: 'proxy.example.com', port: 443,
      rawOutbound: { type: 'vless', server: 'proxy.example.com', server_port: 443, uuid: 'fixture', flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'tls.example.com' }, packet_encoding: 'xudp' } };
    const restored = UniversalSubscriptionParser.parse(vlessShareLink(node))[0];
    assert.deepEqual(restored.rawOutbound, { ...node.rawOutbound, tag: node.name });
    const plain = UniversalSubscriptionParser.parseVless('vless://fixture@proxy.example.com:443?security=tls&type=grpc&serviceName=service%2Fname&allowInsecure=1&extra=broken');
    assert.equal(plain?.flow, undefined);
    assert.equal(plain?.transportHost, 'service/name');
    assert.equal(plain?.insecure, true);
    assert.equal(plain?.xhttpExtraHeaders, undefined);
  });

  test('Parses VLESS Reality & XHTTP links', () => {
    const uri = 'vless://b831381d-6324-4d53-ad4f-8cda48b30811@example.com:443?security=reality&encryption=none&pbk=123456&headerType=none&type=xhttp&sni=example.com&sid=abcdef&fp=chrome&path=%2Fstream#TestVlessXhttp';
    const node = UniversalSubscriptionParser.parseVless(uri);
    assert.ok(node);
    assert.equal(node.type, 'vless');
    assert.equal(node.name, 'TestVlessXhttp');
    assert.equal(node.server, 'example.com');
    assert.equal(node.port, 443);
    assert.equal(node.uuid, 'b831381d-6324-4d53-ad4f-8cda48b30811');
    assert.equal(node.reality, true);
    assert.equal(node.publicKey, '123456');
    assert.equal(node.shortId, 'abcdef');
    assert.equal(node.transport, 'xhttp');
    assert.equal(node.transportPath, '/stream');
  });

  test('Parses Hysteria 1 and Hysteria 2 links', () => {
    const hy1Uri = 'hysteria://hy1.example.com:3456?auth=mysecret&protocol=udp&upmbps=50&downmbps=150&alpn=hysteria&peer=sni.hy1.com&insecure=1#Hy1Node';
    const hy1 = UniversalSubscriptionParser.parseHysteria1(hy1Uri);
    assert.ok(hy1);
    assert.equal(hy1.type, 'hysteria');
    assert.equal(hy1.name, 'Hy1Node');
    assert.equal(hy1.server, 'hy1.example.com');
    assert.equal(hy1.port, 3456);
    assert.equal(hy1.authStr, 'mysecret');
    assert.equal(hy1.protocol, 'udp');
    assert.equal(hy1.upMbps, 50);
    assert.equal(hy1.downMbps, 150);
    assert.equal(hy1.sni, 'sni.hy1.com');
    assert.equal(hy1.insecure, true);

    const hy2Uri = 'hysteria2://pass123@hy2.example.com:8443?sni=sni.hy2.com&obfs=salamander&obfs-password=obfspass#Hy2Node';
    const hy2 = UniversalSubscriptionParser.parseHysteria2(hy2Uri);
    assert.ok(hy2);
    assert.equal(hy2.type, 'hysteria2');
    assert.equal(hy2.name, 'Hy2Node');
    assert.equal(hy2.server, 'hy2.example.com');
    assert.equal(hy2.port, 8443);
    assert.equal(hy2.password, 'pass123');
    assert.equal(hy2.sni, 'sni.hy2.com');
    assert.equal(hy2.obfs, 'obfspass');
  });

  test('Parses SOCKS and HTTP proxy links', () => {
    const socksUri = 'socks5://user:pass@socks.example.com:1080#MySocks';
    const socks = UniversalSubscriptionParser.parseSocks(socksUri);
    assert.ok(socks);
    assert.equal(socks.type, 'socks');
    assert.equal(socks.name, 'MySocks');
    assert.equal(socks.server, 'socks.example.com');
    assert.equal(socks.port, 1080);
    assert.equal(socks.username, 'user');
    assert.equal(socks.password, 'pass');

    const httpUri = 'http://admin:secret@proxy.example.com:8080#MyHttp';
    const http = UniversalSubscriptionParser.parseHttp(httpUri);
    assert.ok(http);
    assert.equal(http.type, 'http');
    assert.equal(http.name, 'MyHttp');
    assert.equal(http.server, 'proxy.example.com');
    assert.equal(http.port, 8080);
    assert.equal(http.username, 'admin');
    assert.equal(http.password, 'secret');
  });

  test('Parses Clash YAML with Hysteria 1, 2, SOCKS, and HTTP', () => {
    const yaml = `
proxies:
  - name: "Clash Hy1"
    type: hysteria
    server: hy1.test
    port: 443
    auth-str: token123
    up: 100
    down: 200
  - name: "Clash Hy2"
    type: hysteria2
    server: hy2.test
    port: 8443
    password: passhy2
  - name: "Clash Socks"
    type: socks5
    server: socks.test
    port: 1080
    username: socksuser
    password: sockspass
  - name: "Clash Http"
    type: http
    server: http.test
    port: 8080
`;
    const nodes = UniversalSubscriptionParser.parse(yaml);
    assert.equal(nodes.length, 4);

    const hy1 = nodes.find((n) => n.name === 'Clash Hy1');
    assert.ok(hy1);
    assert.equal(hy1.type, 'hysteria');
    assert.equal(hy1.authStr, 'token123');
    assert.equal(hy1.upMbps, 100);

    const hy2 = nodes.find((n) => n.name === 'Clash Hy2');
    assert.ok(hy2);
    assert.equal(hy2.type, 'hysteria2');
    assert.equal(hy2.password, 'passhy2');

    const socks = nodes.find((n) => n.name === 'Clash Socks');
    assert.ok(socks);
    assert.equal(socks.type, 'socks');
    assert.equal(socks.username, 'socksuser');

    const http = nodes.find((n) => n.name === 'Clash Http');
    assert.ok(http);
    assert.equal(http.type, 'http');
  });
});

describe('IP/Domain validators', () => {
  test('isValidIpLiteral accepts compressed and full IPv6, rejects malformed', () => {
    assert.ok(isValidIpLiteral('10.0.0.5'));
    assert.ok(isValidIpLiteral('255.255.255.255'));
    assert.ok(!isValidIpLiteral('256.1.1.1'));
    assert.ok(!isValidIpLiteral('1.2.3.4.5'));
    assert.ok(isValidIpLiteral('fd00::5'));
    assert.ok(isValidIpLiteral('::1'));
    assert.ok(isValidIpLiteral('::'));
    assert.ok(isValidIpLiteral('[fd00::5]'));
    assert.ok(isValidIpLiteral('2001:db8:1:2:3:4:5:6'));
    assert.ok(!isValidIpLiteral('fd00:::5'));
    assert.ok(!isValidIpLiteral('1:2:3:4:5:6:7:8:9'));
    assert.ok(!isValidIpLiteral('1:2:3:4:5:6:7')); // 无压缩时必须 8 组
    assert.ok(!isValidIpLiteral('gg::1'));
    assert.ok(!isValidIpLiteral(''));
  });

  test('isValidDomain accepts normal domains and single-label intranet hosts', () => {
    assert.ok(isValidDomain('example.com'));
    assert.ok(isValidDomain('a.b.example.com.'));
    assert.ok(isValidDomain('nas'));
    assert.ok(isValidDomain('xn--fiqs8s'));
    assert.ok(!isValidDomain('not a domain!'));
    assert.ok(!isValidDomain('-bad.example.com'));
    assert.ok(!isValidDomain(''));
  });
});

describe('ConfigGenerator', () => {
  const sampleNodes: ProxyNode[] = [
    {
      id: 'vless',
      name: 'VLESS Node',
      type: 'vless',
      server: '1.2.3.4',
      port: 443,
      groupId: 'default',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      tls: true,
      reality: true,
      publicKey: 'D2c3Bog_ZdPMNtG7LwJYkssQVs4HxZI-StoCNhxDJSs',
      shortId: '12345678',
      sni: 'cloudflare.com',
      transport: 'xhttp',
      xhttpMode: 'auto',
      transportPath: '/path',
    },
    {
      id: 'vmess',
      name: 'VMess Node',
      type: 'vmess',
      server: '2.3.4.5',
      port: 443,
      groupId: 'default',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      method: 'auto',
      tls: true,
      sni: 'vmess.example.com',
      transport: 'ws',
      transportPath: '/ws',
    },
    {
      id: 'trojan',
      name: 'Trojan Node',
      type: 'trojan',
      server: '3.4.5.6',
      port: 443,
      groupId: 'default',
      password: 'trojanpassword',
      tls: true,
      sni: 'trojan.example.com',
    },
    {
      id: 'ss',
      name: 'Shadowsocks Node',
      type: 'shadowsocks',
      server: '4.5.6.7',
      port: 8388,
      groupId: 'default',
      method: '2022-blake3-aes-128-gcm',
      password: 'bXlzZWNyZXRwYXNzd29yZA==',
    },
    {
      id: 'hy1',
      name: 'Hysteria 1 Node',
      type: 'hysteria',
      server: '5.6.7.8',
      port: 443,
      groupId: 'default',
      authStr: 'hy1auth',
      upMbps: 50,
      downMbps: 100,
      sni: 'hy1.example.com',
    },
    {
      id: 'hy2',
      name: 'Hysteria 2 Node',
      type: 'hysteria2',
      server: '6.7.8.9',
      port: 443,
      groupId: 'default',
      password: 'hy2password',
      sni: 'hy2.example.com',
      obfs: 'salamandersecret',
    },
    {
      id: 'tuic',
      name: 'TUIC Node',
      type: 'tuic',
      server: '7.8.9.10',
      port: 8443,
      groupId: 'default',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      password: 'tuicpassword',
      sni: 'tuic.example.com',
      congestionControl: 'bbr',
    },
    {
      id: 'socks',
      name: 'SOCKS Node',
      type: 'socks',
      server: '8.9.10.11',
      port: 1080,
      groupId: 'default',
      username: 'user',
      password: 'pass',
    },
    {
      id: 'http',
      name: 'HTTP Node',
      type: 'http',
      server: '9.10.11.12',
      port: 8080,
      groupId: 'default',
      username: 'user',
      password: 'pass',
    },
  ];

  test('Includes speedtest-in inbound and isolated speedtest-selector outbound', () => {
    const config = ConfigGenerator.generate('node-vless', sampleNodes, [], [], defaultDns, defaultSettings);

    // Inbounds check
    const speedInbound = config.inbounds.find((i: any) => i.tag === 'speedtest-in');
    assert.ok(speedInbound, 'speedtest-in inbound must be defined');
    assert.equal(speedInbound.listen_port, defaultSettings.mixedPort + 1);
    assert.equal(speedInbound.listen, '127.0.0.1');

    // Outbounds check
    const speedSelector = config.outbounds.find((o: any) => o.tag === 'speedtest-selector');
    assert.ok(speedSelector, 'speedtest-selector outbound must be defined');
    assert.equal(speedSelector.type, 'selector');
    assert.equal(speedSelector.default, 'direct');

    // Route check
    const speedRouteRule = config.route.rules.find((r: any) => r.inbound && r.inbound.includes('speedtest-in'));
    assert.ok(speedRouteRule, 'route rule mapping speedtest-in to speedtest-selector must exist');
    assert.equal(speedRouteRule.outbound, 'speedtest-selector');
  });

  test('No nodes or explicit direct mode keeps ordinary traffic and DNS local while preserving blocks', () => {
    for (const [nodes, routingMode] of [[[], 'rule'], [sampleNodes, 'direct']] as const) {
      const config = ConfigGenerator.generate('hy1', [...nodes], [
        { id: 'ordinary', name: 'Pinned route', enabled: true, domains: ['full:ordinary.example'], outbound: 'hy1' },
        { id: 'blocked', name: 'Block', enabled: true, domains: ['full:blocked.example'], outbound: 'block' },
      ], [], defaultDns, { ...defaultSettings, routingMode });
      const selector = config.outbounds.find((o: any) => o.tag === 'proxy');
      assert.deepEqual(selector.outbounds, ['direct']);
      assert.equal(selector.default, 'direct');
      assert.equal(config.route.final, 'direct');
      assert.equal(config.route.rules.find((r: any) => r.domain?.includes('ordinary.example')).outbound, 'direct');
      assert.equal(config.route.rules.find((r: any) => r.domain?.includes('blocked.example')).action, 'reject');
      const resolver = config.dns.servers.find((s: any) => s.tag === 'remote-dns');
      const directResolver = config.dns.servers.find((s: any) => s.tag === 'direct-dns');
      assert.equal(resolver.server, directResolver.server);
      assert.equal(resolver.type, directResolver.type);
      assert.equal(resolver.detour, undefined);
    }
  });

  test('Correctly formats Hysteria 1 vs Hysteria 2 schemas', () => {
    const config = ConfigGenerator.generate('hy1', sampleNodes, [], [], defaultDns, defaultSettings);

    const hy1Outbound = config.outbounds.find((o: any) => o.tag === 'node-hy1');
    assert.ok(hy1Outbound);
    assert.equal(hy1Outbound.type, 'hysteria');
    assert.equal(hy1Outbound.auth_str, 'hy1auth');
    assert.equal(hy1Outbound.up_mbps, 50);
    assert.equal(hy1Outbound.down_mbps, 100);
    assert.ok(hy1Outbound.tls);

    const hy2Outbound = config.outbounds.find((o: any) => o.tag === 'node-hy2');
    assert.ok(hy2Outbound);
    assert.equal(hy2Outbound.type, 'hysteria2');
    assert.equal(hy2Outbound.password, 'hy2password');
    assert.deepEqual(hy2Outbound.obfs, {
      type: 'salamander',
      password: 'salamandersecret',
    });
  });

  test('Points cache_file at an explicit path outside the install directory', () => {
    // 安装到 Program Files 等不可写目录时,默认相对路径 cache.db 会让核心启动即
    // FATAL (Access is denied);必须显式落到应用数据目录
    const config = ConfigGenerator.generate('vless', sampleNodes, [], [], defaultDns, defaultSettings);
    const cacheFile = config.experimental?.cache_file;
    assert.ok(cacheFile?.enabled, 'cache_file must be enabled');
    assert.ok(
      typeof cacheFile?.path === 'string' && cacheFile.path.endsWith('cache.db') && cacheFile.path.includes('/'),
      'cache_file.path must be an explicit absolute path, got: ' + cacheFile?.path
    );
  });

  test('Base rule-sets resolve to bundled local files (offline-first startup)', () => {
    // bin/rules 缺失时核心会退化为远程下载(被墙即反复重启),此测试锁死内置行为
    const config = ConfigGenerator.generate('vless', sampleNodes, [], [], defaultDns, defaultSettings);
    const tags = ['geosite-cn', 'geoip-cn', 'geosite-category-ads-all', 'geoip-private'];
    for (const tag of tags) {
      const rs = (config.route.rule_set || []).find((r: any) => r.tag === tag);
      assert.ok(rs, `rule_set ${tag} must exist`);
      assert.equal(rs.type, 'local', `rule_set ${tag} must be local, got ${rs.type}`);
      assert.ok(typeof rs.path === 'string' && rs.path.endsWith('/' + tag + '.srs'), `rule_set ${tag} path must point to bundled .srs, got: ${rs.path}`);
      assert.ok(fs.existsSync(rs.path), `bundled file must exist on disk: ${rs.path}`);
    }
  });

  test('Validates generated config against sing-box.exe check', async () => {
    const config = ConfigGenerator.generate('vless', sampleNodes, [], [], defaultDns, defaultSettings);
    const tempConfigPath = path.resolve(__dirname, 'temp_test_config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2), 'utf-8');

    const singBoxExe = path.resolve(__dirname, '../../bin/sing-box.exe');
    try {
      const { stdout, stderr } = await execFileAsync(singBoxExe, ['check', '-c', tempConfigPath]);
      assert.ok(true, 'sing-box check succeeded without error');
    } finally {
      if (fs.existsSync(tempConfigPath)) {
        fs.unlinkSync(tempConfigPath);
      }
    }
  });

  test('Compiles hosts records into predefined DNS rules ahead of all other rules', () => {
    const dnsWithHosts: DnsConfig = {
      ...defaultDns,
      mode: 'fakeip',
      hosts: [
        { id: 'h1', domain: 'Example.COM.', ip: '10.0.0.5', enabled: true },
        { id: 'h2', domain: 'example.com', ip: 'fd00::5', enabled: true },
        { id: 'h3', domain: 'disabled.com', ip: '1.2.3.4', enabled: false },
        { id: 'h4', domain: 'not a domain!', ip: '9.9.9.9', enabled: true },
        { id: 'h5', domain: 'valid.example.org', ip: 'not-an-ip', enabled: true },
      ],
    };
    const config = ConfigGenerator.generate('vless', sampleNodes, [], [], dnsWithHosts, defaultSettings);

    const predefined = config.dns.rules.filter((r: any) => r.action === 'predefined');
    assert.equal(predefined.length, 1, 'same domain v4+v6 merge into one rule');
    // hosts 规则必须先于 fakeip 规则,否则 fakeip 先行接管导致映射失效
    assert.ok(
      config.dns.rules[0].action === 'predefined',
      'predefined rule must be the first DNS rule'
    );
    const first = predefined[0];
    assert.deepEqual(first.domain, ['example.com']);
    assert.deepEqual(first.answer.sort(), [
      'example.com. 60 IN A 10.0.0.5',
      'example.com. 60 IN AAAA fd00::5',
    ]);
    assert.equal(first.rcode, 'NOERROR');
    // 禁用与非法记录全部跳过,不进入配置
    const allDomains = config.dns.rules.flatMap((r: any) => r.domain || []);
    assert.ok(!allDomains.includes('disabled.com'));
    assert.ok(!allDomains.includes('not a domain!'));
    assert.ok(!allDomains.includes('valid.example.org'));
  });

  test('Validates hosts-containing config against sing-box.exe check (fakeip mode)', async () => {
    const dnsWithHosts: DnsConfig = {
      ...defaultDns,
      mode: 'fakeip',
      hosts: [
        { id: 'h1', domain: 'git.internal.corp', ip: '10.20.30.40', enabled: true },
        { id: 'h2', domain: 'mirror.internal.corp', ip: 'fd00::10', enabled: true },
      ],
    };
    const config = ConfigGenerator.generate('vless', sampleNodes, [], [], dnsWithHosts, {
      ...defaultSettings,
      tunEnabled: true,
    });
    const tempConfigPath = path.resolve(__dirname, 'temp_test_hosts_config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2), 'utf-8');

    const singBoxExe = path.resolve(__dirname, '../../bin/sing-box.exe');
    try {
      await execFileAsync(singBoxExe, ['check', '-c', tempConfigPath]);
      assert.ok(true, 'sing-box check succeeded for hosts config');
    } finally {
      if (fs.existsSync(tempConfigPath)) {
        fs.unlinkSync(tempConfigPath);
      }
    }
  });
});

describe('ProxySelectionService', () => {
  test('Selecting a saved node leaves direct mode and rebuilds both routes and DNS', async (t) => {
    const { Database } = await import('../main/db/Database');
    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    Database.resetInstance();
    const db = Database.getInstance(path.resolve(__dirname, 'temp_db_core_test', 'direct-mode'));
    db.saveNodes([{ id: 'saved', name: 'Saved node', type: 'socks', server: '127.0.0.1', port: 1080, groupId: 'test' }]);
    db.saveSettings({ routingMode: 'direct' });
    const core = SingBoxManager.getInstance();
    t.mock.method(core, 'getState', () => 'running');
    t.mock.method(core, 'getLiveConfig', () => JSON.stringify({ route: { final: 'direct' }, outbounds: [{ tag: 'proxy', outbounds: ['direct'] }] }));
    const restart = t.mock.method(core, 'start', async (_config: any) => true);
    const select = t.mock.method(ProxySelectionService as any, 'putClashSelector', async () => { throw new Error('unexpected proxy switch'); });
    const result = await ProxySelectionService.selectNode('saved');
    assert.deepEqual(result, { success: true, hotSwitched: false });
    assert.equal(db.getActiveNodeId(), 'saved');
    assert.equal(db.getSettings().routingMode, 'rule');
    assert.equal(restart.mock.callCount(), 1);
    const config = restart.mock.calls[0].arguments[0];
    assert.equal(config.route.final, 'proxy');
    assert.equal(config.dns.servers.find((s: any) => s.tag === 'remote-dns').detour, 'proxy');
    assert.equal(select.mock.callCount(), 0);
  });

  test('First node added to a running node-free core requires a complete rebuild even without a mode change', async (t) => {
    const { Database } = await import('../main/db/Database');
    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    Database.resetInstance();
    const db = Database.getInstance(path.resolve(__dirname, 'temp_db_core_test', 'first-node'));
    db.saveSettings({ routingMode: 'rule' });
    const original = ConfigGenerator.generate('', [], [], [], db.getDns(), db.getSettings());
    db.addNode({ id: 'new', name: 'New node', type: 'socks', server: '127.0.0.1', port: 1080, groupId: 'test' });
    const core = SingBoxManager.getInstance();
    t.mock.method(core, 'getState', () => 'running');
    t.mock.method(core, 'getLiveConfig', () => JSON.stringify(original));
    const restart = t.mock.method(core, 'start', async (_config: any) => true);
    const select = t.mock.method(ProxySelectionService as any, 'putClashSelector', async () => { throw new Error('a PUT cannot change direct DNS or routes'); });
    assert.equal((await ProxySelectionService.selectNode('new')).success, true);
    assert.equal(restart.mock.callCount(), 1);
    assert.equal(restart.mock.calls[0].arguments[0].route.final, 'proxy');
    assert.equal(select.mock.callCount(), 0);
  });

  test('Direct is persistent with saved nodes and preserves the remembered node and credentials', async (t) => {
    const { Database } = await import('../main/db/Database');
    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    Database.resetInstance();
    const dir = path.resolve(__dirname, 'temp_db_core_test', 'select-direct');
    const db = Database.getInstance(dir);
    const node: ProxyNode = { id: 'saved', name: 'Saved node', type: 'socks', server: '127.0.0.1', port: 1080, password: 'fixture-password', groupId: 'test' };
    db.saveNodes([node]); db.saveSettings({ routingMode: 'rule' });
    const core = SingBoxManager.getInstance();
    t.mock.method(core, 'getState', () => 'running');
    t.mock.method(core, 'getLiveConfig', () => JSON.stringify({ route: { final: 'proxy' } }));
    const restart = t.mock.method(core, 'start', async (_config: any) => true);
    assert.equal((await ProxySelectionService.selectDirect()).success, true);
    const config = restart.mock.calls[0].arguments[0];
    assert.equal(config.route.final, 'direct');
    assert.equal(config.dns.servers.find((s: any) => s.tag === 'remote-dns').detour, undefined);
    Database.resetInstance();
    const reopened = Database.getInstance(dir);
    assert.equal(reopened.getSettings().routingMode, 'direct');
    assert.equal(reopened.getActiveNodeId(), 'saved');
    assert.deepEqual(reopened.getNodes(), [node]);
  });

  test('Switching an existing proxy selector stays hot; invalid choices do not leave direct mode', async (t) => {
    const { Database } = await import('../main/db/Database');
    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    Database.resetInstance();
    const db = Database.getInstance(path.resolve(__dirname, 'temp_db_core_test', 'hot-switch'));
    db.saveNodes([{ id: 'saved', name: 'Saved node', type: 'socks', server: '127.0.0.1', port: 1080, groupId: 'test' }]);
    db.saveSettings({ routingMode: 'global' });
    const core = SingBoxManager.getInstance();
    t.mock.method(core, 'getState', () => 'running');
    t.mock.method(core, 'getLiveConfig', () => JSON.stringify({ route: { final: 'proxy' }, outbounds: [{ tag: 'proxy', outbounds: ['node-saved'] }] }));
    const restart = t.mock.method(core, 'start', async () => { throw new Error('unexpected restart'); });
    t.mock.method(ProxySelectionService as any, 'putClashSelector', async () => true);
    assert.deepEqual(await ProxySelectionService.selectNode('saved'), { success: true, hotSwitched: true });
    assert.equal(db.getSettings().routingMode, 'global');
    assert.equal(restart.mock.callCount(), 0);
    db.saveSettings({ routingMode: 'direct' });
    assert.equal((await ProxySelectionService.selectNode('missing')).success, false);
    assert.equal(db.getSettings().routingMode, 'direct');
  });

  test('Selects node and maintains active node state', async () => {
    const { Database } = await import('../main/db/Database');
    // 隔离:必须使用临时目录数据库,否则测试节点会写入用户真实数据
    Database.resetInstance();
    const testDbDir = path.resolve(__dirname, 'temp_db_core_test');
    const db = Database.getInstance(testDbDir);
    const nodes: ProxyNode[] = [
      { id: 'node-1', name: 'N1', type: 'socks', server: '1.1.1.1', port: 1080, groupId: 'default' },
      { id: 'node-2', name: 'N2', type: 'socks', server: '2.2.2.2', port: 1080, groupId: 'default' },
    ];
    db.saveNodes(nodes);
    db.setActiveNodeId('node-1');
    assert.equal(ProxySelectionService.getActiveNodeId(), 'node-1');

    // Switch to node-2 (offline core mode - should gracefully succeed and persist ID)
    const result = await ProxySelectionService.selectNode('node-2');
    assert.ok(result.success);
    assert.equal(ProxySelectionService.getActiveNodeId(), 'node-2');
  });
});

describe('SingBoxManager selector re-sync after core start', () => {
  test('Direct selection overrides a stale cached node; a delayed sync cannot override a newer outlet choice', async (t) => {
    const { Database } = await import('../main/db/Database');
    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    Database.resetInstance();
    const db = Database.getInstance(path.resolve(__dirname, 'temp_db_core_test', 'selector-round'));
    db.saveNodes([{ id: 'saved', name: 'Saved', type: 'socks', server: '127.0.0.1', port: 1080, groupId: 'test' }]);
    db.saveSettings({ routingMode: 'direct' });
    const mgr = SingBoxManager.getInstance() as any;
    const state = mgr.state;
    mgr.state = 'running';
    try {
      const config = { experimental: { clash_api: { external_controller: '127.0.0.1:9999' } }, outbounds: [{ type: 'selector', tag: 'proxy', outbounds: ['direct'] }] };
      const get = t.mock.method(mgr, 'getClashSelection', async () => 'node-saved');
      const put = t.mock.method(mgr, 'putClashSelection', async (_port: number, _tag: string) => true);
      await mgr.syncActiveSelection(config, 9999);
      assert.equal(put.mock.calls[0].arguments[1], 'direct');
      put.mock.resetCalls();
      get.mock.mockImplementation(async () => {
        db.saveSettings({ routingMode: 'rule' });
        return 'node-saved';
      });
      await mgr.syncActiveSelection(config, 9999);
      assert.equal(put.mock.callCount(), 0, 'late direct sync must not overwrite a newly selected proxy');
    } finally { mgr.state = state; }
  });

  test('syncActiveSelection corrects cache-restored stale selection to app active node', async () => {
    const { Database } = await import('../main/db/Database');
    // 隔离:临时目录数据库,绝不触碰用户真实数据
    Database.resetInstance();
    const testDbDir = path.resolve(__dirname, 'temp_db_core_test');
    const db = Database.getInstance(testDbDir);
    db.saveNodes([
      { id: 'old-node', name: '旧节点', type: 'socks', server: '1.1.1.1', port: 1080, groupId: 'default' },
      { id: 'active-node', name: '应用所选节点', type: 'socks', server: '2.2.2.2', port: 1080, groupId: 'default' },
    ]);
    db.setActiveNodeId('active-node');

    // 模拟 sing-box Clash API:选择器持有 cache_file 恢复出的残留旧选择
    let current = 'node-old-node';
    const puts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/proxies/proxy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'proxy', now: current }));
      } else if (req.method === 'PUT' && req.url === '/proxies/proxy') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const name = JSON.parse(body).name;
          puts.push(name);
          current = name;
          res.writeHead(204);
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const clashPort = (server.address() as { port: number }).port;

    const { SingBoxManager } = await import('../main/core/SingBoxManager');
    const mgr = SingBoxManager.getInstance() as any;
    const config = {
      experimental: { clash_api: { external_controller: `127.0.0.1:${clashPort}` } },
      outbounds: [{ type: 'selector', tag: 'proxy', outbounds: ['node-old-node', 'node-active-node'] }],
    };

    const prevState = mgr.state;
    mgr.state = 'running';
    try {
      await mgr.syncActiveSelection(config, clashPort);
      assert.deepEqual(puts, ['node-active-node'], 'stale cached selection must be corrected via PUT');
      assert.equal(current, 'node-active-node');

      // 选择已一致时不得重复下发
      puts.length = 0;
      await mgr.syncActiveSelection(config, clashPort);
      assert.equal(puts.length, 0, 'no redundant PUT when selection already matches');
    } finally {
      mgr.state = prevState;
      server.close();
    }
  });
});

describe('SystemProxy.shouldAutoEnableSystemProxy (连接意图保护判定)', () => {
  const bothOff = { systemProxyEnabled: false, tunEnabled: false };

  test('用户显式发起连接且两开关全关 → 自动补开系统代理', () => {
    assert.equal(SystemProxy.shouldAutoEnableSystemProxy(true, bothOff), true);
  });

  test('设置/规则变更触发的核心重载(非用户发起)绝不补开——回归:连接中关闭系统代理被强制重开', () => {
    assert.equal(SystemProxy.shouldAutoEnableSystemProxy(false, bothOff), false);
  });

  test('系统代理已开启 → 不补开', () => {
    assert.equal(
      SystemProxy.shouldAutoEnableSystemProxy(true, { systemProxyEnabled: true, tunEnabled: false }),
      false
    );
  });

  test('TUN 已开启(TUN 用户不受影响) → 不补开', () => {
    assert.equal(
      SystemProxy.shouldAutoEnableSystemProxy(true, { systemProxyEnabled: false, tunEnabled: true }),
      false
    );
  });
});

describe('TakeoverLinkage.exclusivityPatch (TUN↔系统代理互斥联动)', () => {
  test('TUN 关→开 且系统代理开 → 联动关闭系统代理(空闲/连接中均生效)', () => {
    assert.deepEqual(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: false, systemProxyEnabled: true }, { tunEnabled: true, systemProxyEnabled: true }, true),
      { systemProxyEnabled: false }
    );
    assert.deepEqual(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: false, systemProxyEnabled: true }, { tunEnabled: true, systemProxyEnabled: true }, false),
      { systemProxyEnabled: false }
    );
  });

  test('连接中 TUN 开→关 且系统代理关 → 联动开启系统代理(避免两种接管同时为空)', () => {
    assert.deepEqual(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: true, systemProxyEnabled: false }, { tunEnabled: false, systemProxyEnabled: false }, true),
      { systemProxyEnabled: true }
    );
  });

  test('空闲时 TUN 开→关 不联动开代理——否则关个 TUN 会触发自动连接', () => {
    assert.equal(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: true, systemProxyEnabled: false }, { tunEnabled: false, systemProxyEnabled: false }, false),
      null
    );
  });

  test('TUN 未变化 → 不联动', () => {
    assert.equal(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: false, systemProxyEnabled: true }, { tunEnabled: false, systemProxyEnabled: false }, true),
      null
    );
  });

  test('系统代理已处于目标状态 → 不联动', () => {
    assert.equal(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: false, systemProxyEnabled: false }, { tunEnabled: true, systemProxyEnabled: false }, true),
      null
    );
    assert.equal(
      TakeoverLinkage.exclusivityPatch({ tunEnabled: true, systemProxyEnabled: true }, { tunEnabled: false, systemProxyEnabled: true }, true),
      null
    );
  });
});

describe('TakeoverLinkage.proxyTogglePatch (开代理反向联动关 TUN)', () => {
  test('TUN 开着时开系统代理 → 联动关 TUN', () => {
    assert.deepEqual(
      TakeoverLinkage.proxyTogglePatch({ tunEnabled: true, systemProxyEnabled: false }, { tunEnabled: true, systemProxyEnabled: true }),
      { tunEnabled: false }
    );
  });

  test('关系统代理不反向开 TUN——关代理是"停止接管"的手势,静默拉起 TUN 出乎意料', () => {
    assert.equal(
      TakeoverLinkage.proxyTogglePatch({ tunEnabled: false, systemProxyEnabled: true }, { tunEnabled: false, systemProxyEnabled: false }),
      null
    );
  });

  test('TUN 本来就关 → 开代理无需联动', () => {
    assert.equal(
      TakeoverLinkage.proxyTogglePatch({ tunEnabled: false, systemProxyEnabled: false }, { tunEnabled: false, systemProxyEnabled: true }),
      null
    );
  });

  test('代理开关未变化 → 不联动', () => {
    assert.equal(
      TakeoverLinkage.proxyTogglePatch({ tunEnabled: true, systemProxyEnabled: true }, { tunEnabled: true, systemProxyEnabled: true }),
      null
    );
  });
});

describe('TunAdapter.parseInstanceIds (TUN 幽灵网卡设备实例 ID 解析)', () => {
  test('解析多行实例 ID,剔除空行与 PowerShell 提示行', () => {
    const out = ['HTROOT\\0000', '', 'WARNING: 模拟提示', 'ERROR: 模拟错误', 'ROOT\\NET\\0007'].join('\r\n');
    assert.deepEqual(TunAdapter.parseInstanceIds(out), ['HTROOT\\0000', 'ROOT\\NET\\0007']);
  });

  test('空输出与纯空白输出返回空数组', () => {
    assert.deepEqual(TunAdapter.parseInstanceIds(''), []);
    assert.deepEqual(TunAdapter.parseInstanceIds('  \r\n  \r\n'), []);
  });

  test('实例 ID 中的反斜杠与 & 原样保留(pnputil 参数传递依赖)', () => {
    assert.deepEqual(TunAdapter.parseInstanceIds('ROOT\\NET\\0003&A1\n'), ['ROOT\\NET\\0003&A1']);
  });
});
