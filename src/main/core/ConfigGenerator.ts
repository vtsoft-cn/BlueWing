import path from 'path';
import fs from 'fs';
import { ProxyNode, RouteRule, AppRule, DnsConfig, AppSettings } from '../../types';
import { isValidDomain, isValidIpLiteral } from '../../utils/ip';

export class ConfigGenerator {
  /**
   * Generates a complete, standard Sing-box JSON configuration strictly compliant with Sing-box 1.14
   */
  public static generate(
    activeNodeId: string,
    nodes: ProxyNode[],
    rules: RouteRule[],
    appRules: AppRule[],
    dns: DnsConfig,
    settings: AppSettings,
    forceDisableTun?: boolean
  ): Record<string, any> {
    const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];

    // 1. Inbounds
    const inbounds: any[] = [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: settings.allowLan ? '0.0.0.0' : '127.0.0.1',
        listen_port: settings.mixedPort || 2080,
      },
      {
        type: 'mixed',
        tag: 'speedtest-in',
        listen: '127.0.0.1',
        listen_port: (settings.mixedPort || 2080) + 1,
      },
    ];

    if (settings.inboundAuth && settings.inboundUser && settings.inboundPass) {
      inbounds[0].users = [
        {
          username: settings.inboundUser,
          password: settings.inboundPass,
        },
      ];
    }

    const useTun = settings.tunEnabled && !forceDisableTun;
    if (useTun) {
      const tunInbound: any = {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'BlueWingTun',
        address: settings.tunIPv6
          ? ['172.19.0.1/30', 'fdfe:dcba:9876::1/126']
          : ['172.19.0.1/30'],
        mtu: settings.tunMtu || 9000,
        auto_route: settings.tunAutoRoute !== false,
        strict_route: settings.tunStrictRoute || false,
        endpoint_independent_nat: settings.tunEndpointIndependentNat !== false,
      };

      // `native` 堆栈通过省略 stack 字段表达;显式选择 system/gvisor/mixed 时才写入 legacy stack
      if (settings.tunStack && settings.tunStack !== 'native') {
        tunInbound.stack = settings.tunStack;
      }

      inbounds.push(tunInbound);
    }

    // 2. Outbounds
    const outbounds: any[] = [];

    // System outbounds
    outbounds.push({ type: 'direct', tag: 'direct' });
    outbounds.push({ type: 'block', tag: 'block' });

    // Node outbounds;WireGuard 自 sing-box 1.11 起走 endpoint 架构,不再是普通出站
    const nodeTags: string[] = [];
    const endpoints: any[] = [];
    for (const node of nodes) {
      if (node.type === 'wireguard') {
        const ep = this.buildWireGuardEndpoint(node);
        if (ep) {
          endpoints.push(ep);
          nodeTags.push(ep.tag);
        }
        continue;
      }
      const nodeOutbound = this.buildNodeOutbound(node);
      if (nodeOutbound) {
        outbounds.push(nodeOutbound);
        nodeTags.push(nodeOutbound.tag);
      }
    }

    // 1) Main proxy selector (user live traffic)
    const validMainTag = (activeNode && nodeTags.includes(`node-${activeNode.id}`))
      ? `node-${activeNode.id}`
      : (nodeTags[0] || 'direct');

    outbounds.unshift({
      type: 'selector',
      tag: 'proxy',
      outbounds: nodeTags.length > 0 ? nodeTags : ['direct'],
      default: validMainTag,
    });

    // 2) Dedicated speedtest selector (isolated for speed testing, never touches 'proxy')
    outbounds.push({
      type: 'selector',
      tag: 'speedtest-selector',
      outbounds: ['direct', ...nodeTags],
      default: 'direct',
    });

    // 3. DNS Configuration (Sing-box 1.14 compliant)
    // Note: direct-dns must NOT have detour: 'direct' because detour to empty direct outbound is fatal in sing-box
    const dnsServers: any[] = [
      this.parseDnsServer('remote-dns', dns.remoteDns || 'https://1.1.1.1/dns-query', 'proxy'),
      this.parseDnsServer('direct-dns', dns.directDns || '223.5.5.5'),
      {
        tag: 'dns-local',
        type: 'local',
      },
    ];

    if (dns.servers && Array.isArray(dns.servers)) {
      for (const s of dns.servers) {
        if (!s || !s.tag || !s.address) continue;
        if (['remote-dns', 'direct-dns', 'dns-local', 'fakeip-dns'].includes(s.tag)) continue;
        dnsServers.push(this.parseDnsServer(s.tag, s.address, s.detour));
      }
    }

    if (dns.mode === 'fakeip') {
      dnsServers.unshift({
        tag: 'fakeip-dns',
        type: 'fakeip',
        inet4_range: dns.fakeIpRange || '198.18.0.0/15',
        inet6_range: 'fc00::/18',
      });
    }

    const dnsRules: any[] = [];

    // 应用内 Hosts 映射:生成 predefined DNS 规则直接返回固定记录(不修改系统 hosts)。
    // 必须排在 fakeip 规则之前,否则 fakeip 模式会先接管全部查询导致映射永不生效。
    for (const rule of this.buildHostsDnsRules(dns)) {
      dnsRules.push(rule);
    }

    if (dns.mode === 'fakeip') {
      dnsRules.push({
        inbound: useTun ? ['tun-in', 'mixed-in'] : ['mixed-in'],
        server: 'fakeip-dns',
      });
    }

    // Direct resolution rules for domestic domains
    dnsRules.push(
      {
        rule_set: ['geosite-cn'],
        server: 'direct-dns',
      },
      {
        domain_suffix: [
          '.cn',
          'baidu.com',
          'qq.com',
          'alipay.com',
          'taobao.com',
          'jd.com',
          'bilibili.com',
          'zhihu.com',
          '163.com',
          'sina.com.cn',
          'weibo.com',
        ],
        server: 'direct-dns',
      },
      {
        clash_mode: 'direct',
        server: 'direct-dns',
      },
      {
        clash_mode: 'global',
        server: 'remote-dns',
      }
    );

    const dnsConfig: any = {
      servers: dnsServers,
      rules: dnsRules,
      final: 'remote-dns',
      strategy: 'prefer_ipv4',
      reverse_mapping: true,
    };

    if (settings.dnsCache !== false) {
      dnsConfig.cache_capacity = 4096;
    }

    // 4. HTTP Clients for remote rule sets (Mandatory in Sing-box 1.14)
    // Note: Do not set detour: 'direct' here to avoid empty direct outbound error
    const http_clients = [
      {
        tag: 'default',
      },
    ];

    // 5. Route Rules & Rule Sets
    // 静态规则集优先使用本地文件(用户数据目录的最新更新版 > 安装包内置版,零网络依赖);
    // 单个文件缺失时该条回退远程 + cache_file 兜底,保证配置始终可生成
    const rulesDir = this.locateRulesDir();
    const mkRuleSet = (tag: string, file: string, remotePath: string): any => {
      if (rulesDir) {
        const localPath = path.join(rulesDir, file);
        if (fs.existsSync(localPath)) {
          return { tag, type: 'local', format: 'binary', path: localPath.replace(/\\/g, '/') };
        }
      }
      return {
        tag,
        type: 'remote',
        format: 'binary',
        url: `https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/${remotePath}`,
        http_client: 'default',
      };
    };

    const ruleSets: any[] = [
      mkRuleSet('geosite-cn', 'geosite-cn.srs', 'geosite/cn.srs'),
      mkRuleSet('geoip-cn', 'geoip-cn.srs', 'geoip/cn.srs'),
      mkRuleSet('geosite-category-ads-all', 'geosite-category-ads-all.srs', 'geosite/category-ads-all.srs'),
      mkRuleSet('geoip-private', 'geoip-private.srs', 'geoip/private.srs'),
    ];

    const routeRules: any[] = [
      {
        inbound: ['speedtest-in'],
        outbound: 'speedtest-selector',
      },
      {
        action: 'sniff',
      },
      {
        protocol: 'dns',
        action: 'hijack-dns',
      },
      {
        port: [53],
        action: 'hijack-dns',
      },
      {
        rule_set: ['geosite-category-ads-all'],
        action: 'reject',
      },
    ];

    // LAN & Private IP bypass
    if (settings.systemProxyBypassLan !== false) {
      routeRules.push(
        {
          ip_is_private: true,
          outbound: 'direct',
        },
        {
          rule_set: ['geoip-private'],
          outbound: 'direct',
        }
      );
    }

    // App rules (Windows process routing)
    for (const app of appRules) {
      if (!app.enabled) continue;
      const ruleItem: any = {};
      if (app.action === 'block') {
        ruleItem.action = 'reject';
      } else {
        ruleItem.outbound = app.action;
      }

      let procName = '';
      if (app.exePath) {
        const clean = app.exePath.trim().replace(/^["']|["']$/g, '');
        procName = path.basename(clean);
      } else if (app.name) {
        const cleanName = app.name.trim();
        procName = cleanName.endsWith('.exe') ? cleanName : `${cleanName}.exe`;
      }

      if (procName) {
        ruleItem.process_name = [procName];
      }
      routeRules.push(ruleItem);
    }

    // Custom Route Rules
    for (const r of rules) {
      if (!r.enabled) continue;
      const ruleObj: any = {};
      if (r.outbound === 'block') {
        ruleObj.action = 'reject';
      } else if (r.outbound === 'proxy' || r.outbound === 'direct') {
        ruleObj.outbound = r.outbound;
      } else if (nodes.some((n) => n.id === r.outbound)) {
        ruleObj.outbound = `node-${r.outbound}`;
      } else {
        ruleObj.outbound = 'proxy';
      }

      if (r.domains && r.domains.length > 0) {
        const full: string[] = [];
        const domain: string[] = [];
        const keyword: string[] = [];
        const regex: string[] = [];
        const geosite: string[] = [];

        for (const d of r.domains) {
          if (d.startsWith('full:')) full.push(d.slice(5));
          else if (d.startsWith('domain:')) domain.push(d.slice(7));
          else if (d.startsWith('keyword:')) keyword.push(d.slice(8));
          else if (d.startsWith('regexp:')) regex.push(d.slice(7));
          else if (d.startsWith('geosite:')) geosite.push(d.slice(8));
          else domain.push(d);
        }

        if (full.length > 0) ruleObj.domain = full;
        if (domain.length > 0) ruleObj.domain_suffix = domain;
        if (keyword.length > 0) ruleObj.domain_keyword = keyword;
        if (regex.length > 0) ruleObj.domain_regex = regex;
        if (geosite.length > 0) {
          ruleObj.rule_set = ruleObj.rule_set || [];
          for (const g of geosite) {
            const tag = `geosite-${g}`;
            ruleObj.rule_set.push(tag);
            if (!ruleSets.some((rs) => rs.tag === tag)) {
              ruleSets.push({
                tag,
                type: 'remote',
                format: 'binary',
                url: `https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/${g}.srs`,
                http_client: 'default',
              });
            }
          }
        }
      }

      if (r.ip && r.ip.length > 0) {
        const cidrs: string[] = [];
        const geoip: string[] = [];
        for (const ip of r.ip) {
          if (ip.startsWith('geoip:')) geoip.push(ip.slice(6));
          else cidrs.push(ip);
        }
        if (cidrs.length > 0) ruleObj.ip_cidr = cidrs;
        if (geoip.length > 0) {
          ruleObj.rule_set = ruleObj.rule_set || [];
          for (const g of geoip) {
            const tag = `geoip-${g}`;
            ruleObj.rule_set.push(tag);
            if (!ruleSets.some((rs) => rs.tag === tag)) {
              ruleSets.push({
                tag,
                type: 'remote',
                format: 'binary',
                url: `https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip/${g}.srs`,
                http_client: 'default',
              });
            }
          }
        }
      }

      if (r.port) {
        const ports = r.port.split(',').map((p) => p.trim()).filter(Boolean);
        const singlePorts: number[] = [];
        const portRanges: string[] = [];
        for (const p of ports) {
          if (p.includes(':')) portRanges.push(p);
          else if (!isNaN(Number(p))) singlePorts.push(Number(p));
        }
        if (singlePorts.length > 0) ruleObj.port = singlePorts;
        if (portRanges.length > 0) ruleObj.port_range = portRanges;
      }

      if (r.protocol) ruleObj.protocol = [r.protocol];
      if (r.network) ruleObj.network = [r.network];
      if (r.processName && r.processName.length > 0) ruleObj.process_name = r.processName;
      if (r.processPath && r.processPath.length > 0) ruleObj.process_path = r.processPath;

      routeRules.push(ruleObj);
    }

    // Mode-specific route rules
    if (settings.routingMode === 'rule') {
      routeRules.push(
        {
          rule_set: ['geosite-cn'],
          outbound: 'direct',
        },
        {
          rule_set: ['geoip-cn'],
          outbound: 'direct',
        }
      );
    }

    const finalOutbound = settings.routingMode === 'direct' ? 'direct' : 'proxy';

    const routeConfig: any = {
      default_domain_resolver: 'direct-dns',
      default_http_client: 'default',
      rules: routeRules,
      rule_set: ruleSets,
      final: finalOutbound,
      auto_detect_interface: true,
    };

    // 6. Root Configuration
    const rootConfig: Record<string, any> = {
      log: {
        level: settings.logLevel || 'info',
        timestamp: true,
      },
      dns: dnsConfig,
      inbounds,
      outbounds,
      route: routeConfig,
      http_clients,
    };
    if (endpoints.length > 0) {
      rootConfig.endpoints = endpoints;
    }

    // Rule-set 磁盘缓存:首次成功下载后,后续启动直接命中缓存,
    // 规则源(jsdelivr)被间歇性重置时核心仍可正常启动(下载失败降级为后台重试)
    rootConfig.experimental = {
      cache_file: {
        enabled: true,
      },
    };

    // Clash API for GUI stats/traffic tracking
    if (settings.clashApiEnabled !== false) {
      rootConfig.experimental.clash_api = {
        external_controller: `127.0.0.1:${settings.clashApiPort || 9090}`,
        external_ui: '',
        secret: settings.clashApiSecret || '',
      };
    }

    return rootConfig;
  }

  /** 定位本地规则目录:优先用户数据目录(更新规则按钮写入的最新数据),其次应用内置(随包分发);都找不到返回 null(回退远程规则) */
  private static locateRulesDir(): string | null {
    const dataRules = process.env.BLUEWING_DATA_DIR
      ? path.join(process.env.BLUEWING_DATA_DIR, 'rules')
      : '';
    const candidates = [
      dataRules,
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'rules') : '',
      path.join(path.dirname(process.execPath || ''), 'resources', 'bin', 'rules'),
      path.join(process.cwd(), 'bin', 'rules'),
      path.join(__dirname, '../../bin/rules'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(path.join(c, 'geosite-cn.srs'))) {
        return c;
      }
    }
    return null;
  }

  /**
   * 应用内 Hosts 映射 -> sing-box predefined DNS 规则(sing-box 1.14 无 dns.hosts 字段,
   * 经实测以 RFC 1035 字符串记录的 answer 形式通过 check)。同域名的 IPv4/IPv6
   * 合并为单条规则的多个 answer;非法记录跳过,保证配置始终可生成。
   */
  private static buildHostsDnsRules(dns: DnsConfig): any[] {
    // domain(lowercase) -> answer 记录数组;后写入的同 IP 版本覆盖先前的
    const grouped = new Map<string, string[]>();
    for (const h of dns.hosts || []) {
      if (!h || !h.enabled) continue;
      const domain = String(h.domain || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
      const ip = String(h.ip || '')
        .trim()
        .replace(/^\[|\]$/g, '');
      if (!domain || !isValidDomain(domain) || !isValidIpLiteral(ip)) continue;
      const type = ip.includes(':') ? 'AAAA' : 'A';
      const rr = `${domain}. 60 IN ${type} ${ip}`;
      const list = grouped.get(domain) || [];
      const idx = list.findIndex((r) => r.includes(` IN ${type} `));
      if (idx >= 0) list[idx] = rr;
      else list.push(rr);
      grouped.set(domain, list);
    }

    const rules: any[] = [];
    for (const [domain, answer] of grouped) {
      rules.push({
        domain: [domain],
        action: 'predefined',
        rcode: 'NOERROR',
        answer,
      });
    }
    return rules;
  }

  private static parseDnsServer(tag: string, address: string, detour?: string): any {
    if (!address) {
      const server: any = {
        tag,
        type: 'udp',
        server: '223.5.5.5',
        server_port: 53,
      };
      if (detour && detour !== 'direct') server.detour = detour;
      return server;
    }

    if (address.startsWith('https://')) {
      try {
        const url = new URL(address);
        const server: any = {
          tag,
          type: 'https',
          server: url.hostname,
          server_port: url.port ? parseInt(url.port, 10) : 443,
          path: url.pathname || '/dns-query',
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      } catch {
        const server: any = {
          tag,
          type: 'https',
          server: '1.1.1.1',
          server_port: 443,
          path: '/dns-query',
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      }
    }

    if (address.startsWith('tls://')) {
      try {
        const url = new URL(address);
        const server: any = {
          tag,
          type: 'tls',
          server: url.hostname,
          server_port: url.port ? parseInt(url.port, 10) : 853,
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      } catch {
        const server: any = {
          tag,
          type: 'tls',
          server: '8.8.8.8',
          server_port: 853,
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      }
    }

    if (address.startsWith('quic://')) {
      try {
        const url = new URL(address);
        const server: any = {
          tag,
          type: 'quic',
          server: url.hostname,
          server_port: url.port ? parseInt(url.port, 10) : 853,
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      } catch {
        const server: any = {
          tag,
          type: 'quic',
          server: 'dns.adguard-dns.com',
          server_port: 853,
        };
        if (detour && detour !== 'direct') server.detour = detour;
        return server;
      }
    }

    if (address === 'local') {
      const server: any = {
        tag,
        type: 'local',
      };
      if (detour && detour !== 'direct') server.detour = detour;
      return server;
    }

    const cleaned = address.replace(/^udp:\/\//, '');
    const colonIdx = cleaned.indexOf(':');
    if (colonIdx !== -1) {
      const server: any = {
        tag,
        type: 'udp',
        server: cleaned.substring(0, colonIdx),
        server_port: parseInt(cleaned.substring(colonIdx + 1), 10) || 53,
      };
      if (detour && detour !== 'direct') server.detour = detour;
      return server;
    }

    const server: any = {
      tag,
      type: 'udp',
      server: cleaned || '223.5.5.5',
      server_port: 53,
    };
    if (detour && detour !== 'direct') server.detour = detour;
    return server;
  }

  private static buildTransport(node: ProxyNode): any | undefined {
    if (!node.transport || node.transport === 'tcp') return undefined;

    if (node.transport === 'xhttp') {
      const transport: any = {
        type: 'httpupgrade',
      };
      if (node.transportPath) transport.path = node.transportPath;
      if (node.transportHost) transport.host = node.transportHost;
      if (node.xhttpExtraHeaders) transport.headers = node.xhttpExtraHeaders;
      return transport;
    }

    if (node.transport === 'ws') {
      const transport: any = {
        type: 'ws',
        path: node.transportPath || '/',
      };
      if (node.transportHost) {
        transport.headers = { Host: node.transportHost };
      }
      return transport;
    }

    if (node.transport === 'grpc') {
      return {
        type: 'grpc',
        service_name: node.transportHost || node.transportPath || 'GunService',
      };
    }

    if (node.transport === 'http') {
      const transport: any = {
        type: 'http',
        path: node.transportPath || '/',
      };
      if (node.transportHost) {
        transport.host = [node.transportHost];
      }
      return transport;
    }

    return undefined;
  }

  /** WireGuard 自 sing-box 1.11 起采用 endpoint 架构(非普通出站),selector 仍按 tag 引用 */
  private static buildWireGuardEndpoint(node: ProxyNode): any | null {
    if (!node.privateKey || !node.peerPublicKey) {
      console.warn(`[ConfigGenerator] WireGuard node "${node.name}" missing private/peer key, omitted safely.`);
      return null;
    }

    const peer: any = {
      address: node.server,
      port: node.port,
      public_key: node.peerPublicKey,
      allowed_ips: ['0.0.0.0/0', '::/0'],
    };
    if (node.presharedKey) peer.pre_shared_key = node.presharedKey;

    const endpoint: any = {
      type: 'wireguard',
      tag: `node-${node.id}`,
      address: node.localAddress ? [node.localAddress] : ['10.0.0.2/32'],
      private_key: node.privateKey,
      peers: [peer],
      mtu: node.mtu || 1420,
    };
    if (node.reserved) endpoint.reserved = node.reserved;
    return endpoint;
  }

  private static buildNodeOutbound(node: ProxyNode): any | null {
    if (node.rawOutbound) {
      return {
        ...node.rawOutbound,
        tag: `node-${node.id}`,
      };
    }

    const tag = `node-${node.id}`;

    switch (node.type) {      case 'vless': {
        const outbound: any = {
          type: 'vless',
          tag,
          server: node.server,
          server_port: node.port,
          uuid: node.uuid || '',
        };

        if (node.flow) outbound.flow = node.flow;

        if (node.tls || node.reality) {
          outbound.tls = {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
            utls: {
              enabled: true,
              fingerprint: node.fingerprint || 'chrome',
            },
          };

          if (node.alpn && node.alpn.length > 0) {
            outbound.tls.alpn = node.alpn;
          }

          if (node.reality) {
            outbound.tls.reality = {
              enabled: true,
              public_key: node.publicKey || '',
              short_id: node.shortId || '',
            };
          }
        }

        const transport = this.buildTransport(node);
        if (transport) outbound.transport = transport;

        return outbound;
      }

      case 'vmess': {
        const outbound: any = {
          type: 'vmess',
          tag,
          server: node.server,
          server_port: node.port,
          uuid: node.uuid || '',
          security: node.method || 'auto',
          alter_id: node.alterId || 0,
        };

        if (node.tls) {
          outbound.tls = {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
          };
        }

        const transport = this.buildTransport(node);
        if (transport) outbound.transport = transport;

        return outbound;
      }

      case 'trojan': {
        const outbound: any = {
          type: 'trojan',
          tag,
          server: node.server,
          server_port: node.port,
          password: node.password || '',
          tls: {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
          },
        };
        if (node.alpn) outbound.tls.alpn = node.alpn;
        const transport = this.buildTransport(node);
        if (transport) outbound.transport = transport;
        return outbound;
      }

      case 'shadowsocks': {
        return {
          type: 'shadowsocks',
          tag,
          server: node.server,
          server_port: node.port,
          method: node.method || 'aes-256-gcm',
          password: node.password || '',
          plugin: node.obfs || undefined,
        };
      }

      case 'shadowsocksr':
      case 'snell': {
        // Sing-box native core does not support ShadowsocksR or Snell outbound natively
        console.warn(`[ConfigGenerator] Node "${node.name}" (${node.type}) is not supported by native sing-box core, omitted safely.`);
        return null;
      }

      case 'hysteria': {
        const outbound: any = {
          type: 'hysteria',
          tag,
          server: node.server,
          server_port: node.port,
          auth_str: node.authStr || node.password || '',
          up_mbps: node.upMbps || 100,
          down_mbps: node.downMbps || 100,
          tls: {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
            alpn: node.alpn && node.alpn.length > 0 ? node.alpn : ['hysteria'],
          },
        };
        if (node.protocol) outbound.protocol = node.protocol;
        if (node.obfs) outbound.obfs = node.obfs;
        return outbound;
      }

      case 'hysteria2': {
        const outbound: any = {
          type: 'hysteria2',
          tag,
          server: node.server,
          server_port: node.port,
          password: node.password || '',
          tls: {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
          },
        };
        if (node.alpn && node.alpn.length > 0) outbound.tls.alpn = node.alpn;
        if (node.upMbps) outbound.up_mbps = node.upMbps;
        if (node.downMbps) outbound.down_mbps = node.downMbps;
        if (node.obfs) {
          outbound.obfs = {
            type: 'salamander',
            password: node.obfs,
          };
        }
        return outbound;
      }

      case 'tuic': {
        return {
          type: 'tuic',
          tag,
          server: node.server,
          server_port: node.port,
          uuid: node.uuid || '',
          password: node.password || '',
          congestion_control: node.congestionControl || 'bbr',
          udp_relay_mode: 'native',
          tls: {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
          },
        };
      }

      case 'naive': {
        // NaiveProxy:真实 Chrome TLS 指纹(Cronet);核心需 with_naive_outbound 构建,并要求 libcronet.dll 随行
        return {
          type: 'naive',
          tag,
          server: node.server,
          server_port: node.port,
          username: node.username || node.uuid || '',
          password: node.password || '',
          tls: {
            enabled: true,
            server_name: node.sni || node.server,
            insecure: node.insecure || false,
          },
        };
      }

      case 'socks': {
        const outbound: any = {
          type: 'socks',
          tag,
          server: node.server,
          server_port: node.port,
          version: '5',
        };
        if (node.username || node.uuid || node.password) {
          outbound.username = node.username || node.uuid || '';
          outbound.password = node.password || '';
        }
        return outbound;
      }

      case 'http': {
        const outbound: any = {
          type: 'http',
          tag,
          server: node.server,
          server_port: node.port,
        };
        if (node.username || node.uuid || node.password) {
          outbound.username = node.username || node.uuid || '';
          outbound.password = node.password || '';
        }
        return outbound;
      }

      default:
        return null;
    }
  }
}
