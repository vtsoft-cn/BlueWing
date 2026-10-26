import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { Database } from '../main/db/Database';
import {
  psEscape,
  parseJsonList,
  classifyAdapterRoutes,
  maskToPrefixLength,
  parseOpenVpnPushReply,
  toNetworkCidr,
  ipInCidr,
} from '../main/system/vpn/WindowsNetQuery';
import { rasEntryName, describeRasdialExitCode, patchPhonebookPsk } from '../main/system/vpn/RasVpnEngine';
import { parseOpenVpnLine, buildManualOvpnConfig, derToPem } from '../main/system/vpn/OpenVpnEngine';
import { parseOpenConnectLine, OPENCONNECT_PROTOCOL_MAP } from '../main/system/vpn/OpenConnectEngine';
import { resolveVpnEngineType, effectiveEngineProfile } from '../main/system/vpn/VpnEngineManager';
import { ProxyNode, RouteRule, AppRule, DnsConfig, AppSettings, VpnProfile, VpnSplitConfig } from '../types';

const TEST_DB_DIR = path.resolve(__dirname, 'temp_db_vpn_test');

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
  tunMtu: 9000,
  tunStack: 'native',
  tunAutoRoute: true,
  tunStrictRoute: false,
  tunDnsHijack: true,
  tunIPv6: false,
  tunEndpointIndependentNat: true,
  dnsCache: true,
  routingMode: 'rule',
  logLevel: 'warn',
  clashApiEnabled: true,
  clashApiPort: 9090,
  testUrl: 'http://cp.cloudflare.com/generate_204',
  testTimeoutMs: 5000,
  testConcurrent: 10,
  webdav: { serverUrl: '', username: '', password: '', remotePath: 'x', autoSync: false },
};

const sampleNode: ProxyNode = {
  id: 'node-test',
  name: 'Test Node',
  type: 'socks',
  server: '1.2.3.4',
  port: 1080,
  groupId: 'default',
};

const sampleDns: DnsConfig = {
  mode: 'standard',
  remoteDns: 'https://1.1.1.1/dns-query',
  directDns: '223.5.5.5',
  fakeIpRange: '198.18.0.0/15',
  enableDnsRouting: true,
  servers: [],
};

const sampleVpn: VpnSplitConfig = {
  adapterName: 'BlueWing VPN abc123',
  routes: ['10.1.0.0/16', '172.16.8.0/24'],
  dnsServers: ['10.1.2.53'],
  domainSuffixes: ['corp.example.com', '.double.dot'],
};

function generateWithVpn(vpn?: VpnSplitConfig | null, tunEnabled = false) {
  const settings = { ...defaultSettings, tunEnabled, tunStrictRoute: true };
  return ConfigGenerator.generate('node-test', [sampleNode], [], [], sampleDns, settings, undefined, undefined, vpn);
}

describe('ConfigGenerator VPN 注入', () => {
  test('注入 vpn-corp 出站(bind_interface 指向 VPN 网卡)', () => {
    const config = generateWithVpn(sampleVpn);
    const outbound = config.outbounds.find((o: any) => o.tag === 'vpn-corp');
    assert.ok(outbound, 'vpn-corp outbound must exist');
    assert.equal(outbound.type, 'direct');
    assert.equal(outbound.bind_interface, sampleVpn.adapterName);
    // 注入 dns server
    const vpnDns = config.dns.servers.find((s: any) => s.tag === 'vpn-dns');
    assert.ok(vpnDns, 'vpn-dns server must exist');
    assert.equal(vpnDns.server, '10.1.2.53');
    assert.equal(vpnDns.detour, 'vpn-corp');
  });

  test('VPN 规则位于私网直连规则之前,且域名/进程规则齐备', () => {
    const config = generateWithVpn(sampleVpn);
    const rules = config.route.rules;
    const vpnCidrIdx = rules.findIndex((r: any) => r.outbound === 'vpn-corp' && Array.isArray(r.ip_cidr));
    const vpnDomainIdx = rules.findIndex((r: any) => r.outbound === 'vpn-corp' && Array.isArray(r.domain_suffix));
    const privateIdx = rules.findIndex((r: any) => r.ip_is_private === true);
    assert.ok(vpnCidrIdx >= 0, 'ip_cidr vpn rule must exist');
    assert.ok(vpnDomainIdx >= 0, 'domain_suffix vpn rule must exist');
    assert.ok(privateIdx > vpnCidrIdx, 'vpn rule must precede private-IP bypass');
    assert.ok(privateIdx > vpnDomainIdx);
    assert.deepEqual(rules[vpnCidrIdx].ip_cidr, ['10.1.0.0/16', '172.16.8.0/24']);
    assert.deepEqual(rules[vpnDomainIdx].domain_suffix, ['corp.example.com', 'double.dot']);

    const procRule = rules.find((r: any) => Array.isArray(r.process_name) && r.outbound === 'direct');
    assert.ok(procRule, 'engine process direct rule must exist');
    assert.ok(procRule.process_name.includes('openvpn.exe'));
  });

  test('内网域名 DNS 规则先于 fakeip 接管规则', () => {
    const config = ConfigGenerator.generate(
      'node-test',
      [sampleNode],
      [],
      [],
      { ...sampleDns, mode: 'fakeip' },
      defaultSettings,
      undefined,
      undefined,
      sampleVpn
    );
    const dnsRules = config.dns.rules;
    const vpnIdx = dnsRules.findIndex((r: any) => r.server === 'vpn-dns');
    const fakeipIdx = dnsRules.findIndex((r: any) => r.server === 'fakeip-dns');
    assert.ok(vpnIdx >= 0);
    assert.ok(fakeipIdx > vpnIdx, 'vpn dns rule must precede fakeip catch-all');
  });

  test('TUN 模式下 VPN 共存强制关闭 strict_route', () => {
    const config = generateWithVpn(sampleVpn, true);
    const tun = config.inbounds.find((i: any) => i.type === 'tun');
    assert.ok(tun, 'tun inbound must exist');
    assert.equal(tun.strict_route, false);
    // 无 VPN 时保留用户设置
    const noVpn = generateWithVpn(null, true);
    const tun2 = noVpn.inbounds.find((i: any) => i.type === 'tun');
    assert.equal(tun2.strict_route, true);
  });

  test('无 VPN 时不注入任何 vpn 元素', () => {
    const config = generateWithVpn(null);
    assert.ok(!config.outbounds.some((o: any) => o.tag === 'vpn-corp'));
    assert.ok(!config.dns.servers.some((s: any) => s.tag === 'vpn-dns'));
    assert.ok(!config.route.rules.some((r: any) => r.outbound === 'vpn-corp'));
  });

  test('Hosts 启用/VPN 分流时省略 default_domain_resolver(出站解析须经 dns.rules)', () => {
    // 无 hosts 无 vpn:保留字段(直连服务器解析,默认行为)
    const plain = ConfigGenerator.generate('node-test', [sampleNode], [], [], sampleDns, defaultSettings);
    assert.equal(plain.route.default_domain_resolver, 'direct-dns');

    // 启用 hosts 记录:省略字段 → 出站解析走规则管道,predefined 映射在系统代理模式才生效
    const withHosts = ConfigGenerator.generate(
      'node-test', [sampleNode], [], [],
      { ...sampleDns, hosts: [{ id: 'h', domain: 'a.test', ip: '1.2.3.4', enabled: true }] },
      defaultSettings
    );
    assert.equal(withHosts.route.default_domain_resolver, undefined);
    assert.ok(withHosts.dns.rules.some((r: any) => r.action === 'predefined'));

    // hosts 记录存在但全部停用:恢复字段
    const disabledHosts = ConfigGenerator.generate(
      'node-test', [sampleNode], [], [],
      { ...sampleDns, hosts: [{ id: 'h', domain: 'a.test', ip: '1.2.3.4', enabled: false }] },
      defaultSettings
    );
    assert.equal(disabledHosts.route.default_domain_resolver, 'direct-dns');

    // VPN 分流激活:同样省略(vpn-dns 规则需要对出站解析生效)
    const vpnCfg = generateWithVpn(sampleVpn);
    assert.equal(vpnCfg.route.default_domain_resolver, undefined);
  });

  test('Hosts 域名注入直连路由规则(带域名连接不先解析,兜底进代理会使映射落空)', () => {
    const withHosts = ConfigGenerator.generate(
      'node-test', [sampleNode], [], [],
      { ...sampleDns, hosts: [{ id: 'h1', domain: 'a.test', ip: '1.2.3.4', enabled: true }] },
      defaultSettings
    );
    const rules = withHosts.route.rules;
    const hostsIdx = rules.findIndex((r: any) => r.outbound === 'direct' && Array.isArray(r.domain) && r.domain.includes('a.test'));
    assert.ok(hostsIdx >= 0, 'hosts 直连规则必须存在');
    const privateIdx = rules.findIndex((r: any) => r.ip_is_private === true);
    assert.ok(privateIdx > hostsIdx, 'hosts 直连规则必须在私网直连之前(域名连接不触发 IP 规则解析)');
    // 非法/停用记录不生成规则
    const dirty = ConfigGenerator.generate(
      'node-test', [sampleNode], [], [],
      { ...sampleDns, hosts: [
        { id: 'x', domain: 'bad name', ip: '1.2.3.4', enabled: true },
        { id: 'y', domain: 'off.test', ip: '1.2.3.4', enabled: false },
      ] },
      defaultSettings
    );
    assert.ok(!dirty.route.rules.some((r: any) => r.outbound === 'direct' && Array.isArray(r.domain)));
    assert.equal(dirty.route.default_domain_resolver, 'direct-dns', '无有效 hosts 记录时恢复解析器字段');
  });
});

describe('ConfigGenerator 归一化助手', () => {
  test('normalizeDomainSuffixes 去句点/去重/过滤非法', () => {
    assert.deepEqual(
      ConfigGenerator.normalizeDomainSuffixes(['.corp.example.com', 'corp.example.com', 'a b', '', 'ok.cn']),
      ['corp.example.com', 'ok.cn']
    );
    assert.deepEqual(ConfigGenerator.normalizeDomainSuffixes(undefined), []);
  });

  test('normalizeCidrs 裸 IP 补齐前缀并过滤非法', () => {
    assert.deepEqual(ConfigGenerator.normalizeCidrs(['10.1.0.0/16', '8.8.8.8', 'bad/ip', '']), [
      '10.1.0.0/16',
      '8.8.8.8/32',
    ]);
  });
});

describe('WindowsNetQuery 纯逻辑', () => {
  test('psEscape 单引号翻倍', () => {
    assert.equal(psEscape("a'b"), "a''b");
    assert.equal(psEscape('plain'), 'plain');
  });

  test('parseJsonList 空串/单对象/数组归一化', () => {
    assert.deepEqual(parseJsonList(''), []);
    assert.deepEqual(parseJsonList('{"a":1}'), [{ a: 1 }]);
    assert.deepEqual(parseJsonList('[{"a":1},{"b":2}]').length, 2);
    assert.deepEqual(parseJsonList('not json'), []);
  });

  test('classifyAdapterRoutes 剔除链路本地/直连子网/on-link 主机路由,识别全隧道', () => {
    const { corp, fullTunnel } = classifyAdapterRoutes(
      [
        '10.1.0.0/16',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '224.0.0.0/4',
        '255.255.255.255/32',
        '10.8.0.0/24',
        '10.8.0.6/32',
        '10.8.0.255/32',
        '0.0.0.0/1',
        '128.0.0.0/1',
      ],
      '10.8.0.0/24'
    );
    assert.deepEqual(corp, ['10.1.0.0/16']);
    assert.equal(fullTunnel, true);
  });

  test('toNetworkCidr 主机地址归位到网络地址', () => {
    assert.equal(toNetworkCidr('10.8.0.6', 24), '10.8.0.0/24');
    assert.equal(toNetworkCidr('192.168.110.131', 24), '192.168.110.0/24');
    assert.equal(toNetworkCidr('172.16.5.9', 12), '172.16.0.0/12');
    assert.equal(toNetworkCidr('1.2.3.4', 32), '1.2.3.4/32');
    assert.equal(toNetworkCidr('1.2.3.4', 0), '0.0.0.0/0');
    assert.equal(toNetworkCidr('bad', 24), null);
    assert.equal(toNetworkCidr('1.2.3.4', 40), null);
  });

  test('ipInCidr 包含判断', () => {
    assert.equal(ipInCidr('10.8.0.255', '10.8.0.0/24'), true);
    assert.equal(ipInCidr('10.8.1.1', '10.8.0.0/24'), false);
    assert.equal(ipInCidr('8.8.8.8', '0.0.0.0/0'), true);
    assert.equal(ipInCidr('8.8.8.8', 'bad-cidr'), false);
  });

  test('maskToPrefixLength 点分掩码换算与非法识别', () => {
    assert.equal(maskToPrefixLength('255.255.0.0'), 16);
    assert.equal(maskToPrefixLength('255.255.255.255'), 32);
    assert.equal(maskToPrefixLength('0.0.0.0'), 0);
    assert.equal(maskToPrefixLength('255.0.255.0'), -1);
    assert.equal(maskToPrefixLength('abc'), -1);
  });

  test('parseOpenVpnPushReply 提取路由/DNS/域名并识别全隧道', () => {
    const parsed = parseOpenVpnPushReply(
      'route 10.1.2.0 255.255.255.0,route 172.16.0.0 255.240.0.0,redirect-gateway def1,dhcp-option DNS 10.1.2.53,dhcp-option DOMAIN corp.example.com,topology subnet,route-gateway 10.8.0.1'
    );
    assert.deepEqual(parsed.routes, ['10.1.2.0/24', '172.16.0.0/12']);
    assert.deepEqual(parsed.dnsServers, ['10.1.2.53']);
    assert.deepEqual(parsed.domainSuffixes, ['corp.example.com']);
    assert.equal(parsed.fullTunnel, true);
  });
});

describe('引擎纯逻辑', () => {
  test('rasEntryName 生成 ASCII 稳定条目名', () => {
    const profile = { id: 'vpn-ab12cd34ef', name: 'x', type: 'ikev2' as const, server: 's', createdAt: 0 };
    assert.equal(rasEntryName(profile as VpnProfile), 'BlueWing VPN vpnab12cd34e');
    assert.equal(rasEntryName({ ...profile, id: '!!' } as VpnProfile), 'BlueWing VPN x');
  });

  test('describeRasdialExitCode 常见错误码可读化', () => {
    assert.equal(describeRasdialExitCode(0), '连接成功');
    assert.ok(describeRasdialExitCode(691).includes('认证失败'));
    assert.ok(describeRasdialExitCode(809).includes('网络连接'));
    assert.ok(describeRasdialExitCode(789).includes('预共享密钥'));
    assert.ok(describeRasdialExitCode(800).includes('无法建立'));
    assert.ok(describeRasdialExitCode(2333).includes('2333'));
  });

  test('patchPhonebookPsk:电话簿直写 L2TP PSK(应对 VpnClient cmdlet 静默丢参)', () => {
    const pbk = [
      '[Other Entry]',
      'IpSecFlags=0',
      'Server=x',
      '',
      '[BlueWing VPN abc]',
      'Encoding=1',
      'IpSecFlags=1',
      'Server=1.2.3.4',
      '',
      '[Another]',
      'IpSecFlags=0',
    ].join('\r\n');
    // 命中目标节:插到 IpSecFlags 之后并强制置 1,其他节不动
    const patched = patchPhonebookPsk(pbk, 'BlueWing VPN abc', 'psk123')!;
    assert.ok(patched.includes('IpSecFlags=1\r\nL2tpPsk=psk123'), 'PSK 紧随 IpSecFlags=1');
    assert.ok(!patched.includes('[Other Entry]\r\nIpSecFlags=1'), '其他节不受影响');
    assert.ok(patched.includes('[Another]'), '尾部节保留');
    // 已有 L2tpPsk 时替换;无 IpSecFlags 时补两行
    const rep = patchPhonebookPsk('[E]\r\nL2tpPsk=old\r\nX=1', 'E', 'new')!;
    assert.ok(rep.includes('L2tpPsk=new') && !rep.includes('old'));
    const noFlags = patchPhonebookPsk('[E]\r\nServer=1', 'E', 'p')!;
    assert.ok(noFlags.includes('IpSecFlags=1\r\nL2tpPsk=p'));
    // 条目不存在 → null
    assert.equal(patchPhonebookPsk('[A]\r\nIpSecFlags=1', 'Missing', 'p'), null);
  });

  test('parseOpenVpnLine 识别推送/连接成功/错误', () => {
    const push = parseOpenVpnLine("PUSH: Received control message: 'PUSH_REPLY,route 10.0.0.0 255.0.0.0'");
    assert.ok(push && push.type === 'push');
    assert.deepEqual(push?.push?.routes, ['10.0.0.0/8']);
    assert.equal(parseOpenVpnLine('Initialization Sequence Completed')?.type, 'connected');
    assert.equal(parseOpenVpnLine('AUTH_FAILED')?.type, 'auth-failed');
    assert.equal(parseOpenVpnLine('Options error: blah')?.type, 'error');
    assert.equal(parseOpenVpnLine('ordinary log line'), null);
  });

  test('推送选项的 Options error 携带 [PUSH-OPTIONS] 上下文(供引擎噪声分类)', () => {
    const ev = parseOpenVpnLine(
      "2026-10-23 12:36:29 us=62000 Options error: option 'route' cannot be used in this context ([PUSH-OPTIONS])"
    );
    assert.equal(ev?.type, 'error');
    assert.ok(ev?.message?.includes('[PUSH-OPTIONS]'), 'message must retain PUSH-OPTIONS context for noise classification');
  });

  const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----';

  test('buildManualOvpnConfig:手动字段合成最小 .ovpn', () => {
    const cfg = buildManualOvpnConfig({ server: '1.2.3.4', caText: PEM });
    assert.ok(cfg!.includes('client'));
    assert.ok(cfg!.includes('proto udp'));
    assert.ok(cfg!.includes('remote 1.2.3.4 1194'));
    // 证书必须 <ca> 内联包裹(OpenVPN 2.7 裸 PEM 会报 Unrecognized option ---BEGIN)
    assert.ok(cfg!.includes('<ca>\n' + PEM + '\n</ca>'), 'PEM must be wrapped in <ca> tags');
    // CBC 兼容:SoftEther/老网关默认 AES-*-CBC,2.7 默认 data-ciphers 协商即失败
    assert.ok(cfg!.includes('data-ciphers DEFAULT:AES-128-CBC:AES-192-CBC:AES-256-CBC'));
    assert.ok(cfg!.includes('data-ciphers-fallback AES-128-CBC'));
    // 自定义端口/协议 + CRLF 归一;已带 <ca> 标记的输入不重复包裹
    const tcp = buildManualOvpnConfig({ server: 'vpn.x.com', port: 443, proto: 'tcp', caText: PEM.replace(/\n/g, '\r\n') });
    assert.ok(tcp!.includes('proto tcp'));
    assert.ok(tcp!.includes('remote vpn.x.com 443'));
    assert.ok(tcp!.includes('\nAAAA\n'), 'CRLF 证书归一为 \n');
    const tagged = buildManualOvpnConfig({ server: 'a.b', caText: '<ca>\n' + PEM + '\n</ca>' });
    assert.equal(tagged!.match(/<ca>/g)!.length, 1, '已带标记时不重复包裹');
    // 必要项缺失
    assert.equal(buildManualOvpnConfig({ server: '', caText: PEM }), null);
    assert.equal(buildManualOvpnConfig({ server: 'a.b', caText: 'not-a-pem' }), null);
  });

  test('derToPem:DER 转 PEM(64 字符分行)', () => {
    const pem = derToPem(Buffer.alloc(100, 0x41));
    assert.ok(pem.startsWith('-----BEGIN CERTIFICATE-----\n'));
    assert.ok(pem.endsWith('-----END CERTIFICATE-----'));
    const body = pem.split('\n')[1];
    assert.equal(body.length, 64);
  });

  test('parseOpenConnectLine 识别连接成功/证书钉扎/认证失败', () => {
    assert.deepEqual(parseOpenConnectLine('Connected as 10.8.0.6, using SSL+DTLS'), {
      type: 'connected',
      ipv4: '10.8.0.6',
    });
    const cert = parseOpenConnectLine('To trust this server, add --servercert pin-sha256:AbCd1234=');
    assert.equal(cert?.type, 'cert-failed');
    assert.equal(cert?.certPin, 'pin-sha256:AbCd1234=');
    assert.equal(parseOpenConnectLine('Failed to obtain WebVPN cookie in relogin')?.type, 'auth-failed');
  });

  test('openconnect 协议映射覆盖全部 openconnect 家族档案类型', () => {
    // 与随包引擎 --version 声明的协议集一致:anyconnect, nc, gp, pulse, f5, fortinet, array
    assert.deepEqual(Object.keys(OPENCONNECT_PROTOCOL_MAP).sort(), [
      'anyconnect',
      'array',
      'f5',
      'fortinet',
      'globalprotect',
      'nc',
      'pulse',
    ]);
    assert.equal(OPENCONNECT_PROTOCOL_MAP.globalprotect, 'gp');
    assert.equal(OPENCONNECT_PROTOCOL_MAP.nc, 'nc');
  });

  test('WireGuard 型 VPN:注入 vpn-wg endpoint,内网 CIDR 路由到隧道且先于私网直连', () => {
    const wgVpn: VpnSplitConfig = {
      adapterName: '',
      routes: ['10.7.0.0/16'],
      dnsServers: ['10.7.0.1'],
      domainSuffixes: ['corp.wg'],
      wireguard: {
        server: '1.2.3.4', port: 51820, privateKey: 'KEY1', peerPublicKey: 'KEY2',
        localAddress: '10.7.0.2/32',
      },
    };
    const config = generateWithVpn(wgVpn);
    // endpoint 存在,allowed_ips 收敛为内网段(而非 0/0)
    const ep = config.endpoints?.find((e: any) => e.tag === 'vpn-wg');
    assert.ok(ep, 'vpn-wg endpoint must exist');
    assert.equal(ep.peers[0].allowed_ips[0], '10.7.0.0/16');
    // 无 vpn-corp 出站/无引擎进程直连规则(WG 无外部进程)
    assert.ok(!config.outbounds.some((o: any) => o.tag === 'vpn-corp'));
    assert.ok(!config.route.rules.some((r: any) => Array.isArray(r.process_name)));
    // 分流规则指向 vpn-wg 且先于 ip_is_private
    const rules = config.route.rules;
    const cidrIdx = rules.findIndex((r: any) => r.outbound === 'vpn-wg' && Array.isArray(r.ip_cidr));
    const domIdx = rules.findIndex((r: any) => r.outbound === 'vpn-wg' && Array.isArray(r.domain_suffix));
    const privateIdx = rules.findIndex((r: any) => r.ip_is_private === true);
    assert.ok(cidrIdx >= 0 && privateIdx > cidrIdx, 'WG cidr 规则须先于私网直连');
    assert.ok(domIdx >= 0);
    // 企业 DNS 经隧道查询
    const vpnDns = config.dns.servers.find((s: any) => s.tag === 'vpn-dns');
    assert.ok(vpnDns);
    assert.equal(vpnDns.detour, 'vpn-wg');
    // 解析器省略(vpn-dns 规则需对出站解析生效)
    assert.equal(config.route.default_domain_resolver, undefined);
  });

  test('resolveVpnEngineType:wireguard 归为原生隧道', () => {
    assert.equal(resolveVpnEngineType({ type: 'wireguard' }), 'wireguard');
  });

  test('resolveVpnEngineType:softether 按兼容端点解析,其余按类型/协议表', () => {
    assert.equal(resolveVpnEngineType({ type: 'softether', softetherMode: 'l2tp' }), 'l2tp');
    assert.equal(resolveVpnEngineType({ type: 'softether', softetherMode: 'sstp' }), 'sstp');
    assert.equal(resolveVpnEngineType({ type: 'softether', softetherMode: 'openvpn' }), 'openvpn');
    assert.equal(resolveVpnEngineType({ type: 'softether' }), 'l2tp', 'softether 默认 l2tp 端点');
    assert.equal(resolveVpnEngineType({ type: 'ikev2' }), 'ikev2');
    assert.equal(resolveVpnEngineType({ type: 'openvpn' }), 'openvpn');
    assert.equal(resolveVpnEngineType({ type: 'fortinet' }), 'openconnect');
    assert.equal(resolveVpnEngineType({ type: 'array' }), 'openconnect');
    assert.equal(resolveVpnEngineType({ type: 'nonsense' as any }), null);
  });

  test('effectiveEngineProfile:softether 改写为端点类型且凭据/网段继承', () => {
    const base: VpnProfile = {
      id: 'se-1',
      name: '公司 SoftEther',
      type: 'softether',
      server: 'vpn.example.com',
      username: 'hub01\\alice',
      password: 'pw',
      l2tpPsk: 'psk',
      extraRoutes: ['10.7.0.0/16'],
      createdAt: 1,
    };
    const l2tp = effectiveEngineProfile(base);
    assert.equal(l2tp.type, 'l2tp');
    assert.equal(l2tp.l2tpPsk, 'psk');
    assert.deepEqual(l2tp.extraRoutes, ['10.7.0.0/16']);
    const ovpn = effectiveEngineProfile({ ...base, softetherMode: 'openvpn' });
    assert.equal(ovpn.type, 'openvpn');
    // 非 softether 原样返回
    assert.equal(effectiveEngineProfile({ ...base, type: 'ikev2' }).type, 'ikev2');
  });
});

describe('Database VPN 档案存取', () => {
  beforeEach(() => {
    Database.resetInstance();
    if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    Database.resetInstance();
    if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  test('新增/更新/删除档案,密码加密落盘、明文读回', () => {
    const db = Database.getInstance(TEST_DB_DIR);
    const profile: VpnProfile = {
      id: 'vpn-1',
      name: '公司 VPN',
      type: 'ikev2',
      server: 'vpn.corp.example.com',
      username: 'alice',
      password: 's3cret"quoted',
      createdAt: Date.now(),
    };
    db.upsertVpnProfile(profile);
    assert.equal(db.getVpnProfiles().length, 1);
    assert.equal(db.getVpnProfiles()[0].password, 's3cret"quoted');

    // 落盘内容必须是密文(b64 兜底)
    const raw = JSON.parse(fs.readFileSync(path.join(TEST_DB_DIR, 'bluewing.json'), 'utf8'));
    assert.ok(raw.vpnProfiles[0].password.startsWith('enc:'), 'on-disk password must be encrypted');

    // 更新
    db.upsertVpnProfile({ ...profile, name: '公司 VPN 2' });
    assert.equal(db.getVpnProfiles()[0].name, '公司 VPN 2');

    // 重新加载实例:密码解密回明文
    Database.resetInstance();
    const db2 = Database.getInstance(TEST_DB_DIR);
    assert.equal(db2.getVpnProfiles().length, 1);
    assert.equal(db2.getVpnProfiles()[0].password, 's3cret"quoted');

    // 删除
    assert.equal(db2.deleteVpnProfile('vpn-1'), true);
    assert.equal(db2.getVpnProfiles().length, 0);
    assert.equal(db2.deleteVpnProfile('vpn-1'), false);
  });
});
