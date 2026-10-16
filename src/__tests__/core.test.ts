import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UniversalSubscriptionParser } from '../main/net/UniversalSubscriptionParser';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { ProxySelectionService } from '../main/core/ProxySelectionService';
import { ProxyNode, RouteRule, AppRule, DnsConfig, AppSettings } from '../types';
import { isValidIpLiteral, isValidDomain } from '../utils/ip';

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
