import { isIP } from 'net';
import { VpnRuntime } from '../../types/corporateVpn';
import { vpnRouting } from '../../utils/vpnRouting';

function managedRule(rule: any): boolean {
  return (
    (rule.action === 'reject' && rule.domain_suffix?.length === 1 && rule.domain_suffix[0] === 'bluewing.invalid') ||
    rule.rule_set?.some((tag: string) => tag.startsWith('corp-')) ||
    rule.rules?.some(managedRule) || false
  );
}

/** Fixed managed layer. A company connection never enters the public selector. */
export function applyCorporateConfig(
  config: Record<string, any>,
  runtime?: VpnRuntime,
): void {
  // Callers that rebuild through the tray or selector fallback receive the same managed layer.
  config.outbounds = (config.outbounds || []).filter(
    (r: any) => !r.tag?.startsWith('corp-out-') && r.tag !== 'corp-private-out',

  );
  config.endpoints = (config.endpoints || []).filter((e: any) => !e.tag?.startsWith('corp-packet-'));
  config.route.rule_set = (config.route.rule_set || []).filter(
    (r: any) => !r.tag?.startsWith('corp-'),
  );
  config.route.rules = (config.route.rules || []).filter(
    (r: any) =>
      !managedRule(r) &&
      !(
        r.process_name?.length === 1 &&
        r.process_name[0] === 'bluewing-vpn-core.exe'
      ),
  );
  config.dns.servers = (config.dns.servers || []).filter(
    (r: any) => !r.tag?.startsWith('corp-dns-'),
  );
  config.dns.rules = (config.dns.rules || []).filter(
    (r: any) => !r.server?.startsWith('corp-dns-') && !managedRule(r),
  );
  if (!runtime?.profiles.length) return;
  const managedRules: any[] = [], probes: any[] = [], packetDiscovery: any[] = [], companyDNS: any[] = [],
    dnsRules: any[] = [], internetRules: any[] = [], internetFallback: any[] = [], internetDNS: any[] = [], discoveryRules: any[] = [], discoveryGuards: any[] = [];
  const publicProxy = config.outbounds.find((o: any) => o.tag === 'proxy');
  if (runtime.privateProxy) {
    const proxy = runtime.privateProxy;
    config.outbounds.push({ type: 'socks', tag: 'corp-private-out', server: '127.0.0.1', server_port: proxy.port, version: '5', username: proxy.user, password: proxy.password, network: 'tcp', connect_timeout: '20s' });
    config.route.rule_set.push({ type: 'local', tag: 'corp-private-active', format: 'source', path: proxy.rulePath.replace(/\\/g, '/') });
    discoveryRules.push({ rule_set: ['corp-private-active'], outbound: 'corp-private-out' });
  }
  const proxyEnabled = publicProxy?.type === 'selector'
    ? publicProxy.outbounds?.some((tag: string) => tag !== 'direct') && publicProxy.default !== 'direct'
    : !!publicProxy && publicProxy.type !== 'direct';
  for (const r of runtime.profiles) {
    const id = r.profile.id;
    const packetTag = r.packet?.port && r.packet.serverPublicKey ? `corp-packet-${id}` : undefined;
    const icmpTag = r.packet?.icmp?.port && r.packet.icmp.serverPublicKey ? `corp-packet-icmp-${id}` : undefined;
    if (packetTag && r.packet) {
      config.endpoints.push({ type: 'wireguard', tag: packetTag, system: false, mtu: 1280,
        bind_interface: r.packet.loopbackInterface, inet4_bind_address: '127.0.0.1',
        address: ['100.127.255.1/32'], private_key: r.packet.privateKey,
        peers: [{ address: '127.0.0.1', port: r.packet.port, public_key: r.packet.serverPublicKey, allowed_ips: ['0.0.0.0/0'] }],
      });
    }
    if (icmpTag && r.packet?.icmp) {
      // sing-tun forwards real ICMP only to a port with an unspecified address.
      // Use an independent authenticated peer so UDP sockets keep a valid source
      // and cannot race ICMP return-path ownership or WireGuard peer roaming.
      config.endpoints.push({ type: 'wireguard', tag: icmpTag, system: false, mtu: 1280,
        bind_interface: r.packet.icmp.loopbackInterface, inet4_bind_address: '127.0.0.1',
        address: ['0.0.0.0/32'], private_key: r.packet.icmp.privateKey,
        peers: [{ address: '127.0.0.1', port: r.packet.icmp.port, public_key: r.packet.icmp.serverPublicKey, allowed_ips: ['0.0.0.0/0'] }],
      });
    }
    // DNS follows the same per-company allow -> guard -> next-company order
    // as ordinary traffic. Both TCP and UDP precede global DNS interception.
    companyDNS.push({ type: 'logical', mode: 'and', rules: [
      { rule_set: [`corp-route-${id}`] }, { network: ['tcp'], port: [53] },
    ], outbound: `corp-out-${id}` });
    if (packetTag) companyDNS.push({ type: 'logical', mode: 'and', rules: [
      { rule_set: [`corp-route-${id}`] }, { network: ['udp'], port: [53], ip_version: 4 },
    ], outbound: packetTag });
    companyDNS.push({ type: 'logical', mode: 'and', rules: [
      { rule_set: [`corp-guard-${id}`] }, { network: ['tcp', 'udp'], port: [53] },
    ], action: 'reject' });
    probes.push({ type: 'logical', mode: 'and', rules: [
      { domain_suffix: ['bluewing.invalid'] }, { rule_set: [`corp-route-${id}`] },
      ...(r.internetPath ? [{ rule_set: [`corp-internet-${id}`] }] : []),
    ], outbound: `corp-out-${id}` });
    config.outbounds.push({
      type: 'socks',
      tag: `corp-out-${id}`,
      server: '127.0.0.1',
      server_port: r.profile.socksPort,
      version: '5',
      username: r.socksUser,
      password: r.socksPassword,
      network: 'tcp',
      connect_timeout: '15s',
    });
    for (const [kind, file] of [
      ['route', r.routePath],
      ['guard', r.guardPath],
      ['dns', r.dnsPath],
      ...(r.internetPath ? [['internet', r.internetPath]] : []),
      ...(r.internetDnsPath ? [['internet-dns', r.internetDnsPath]] : []),
      ...(r.discoveredGuardPath ? [['discovered-guard', r.discoveredGuardPath]] : []),
    ])
      config.route.rule_set.push({
        type: 'local',
        tag: `corp-${kind}-${id}`,
        format: 'source',
        path: file.replace(/\\/g, '/'),
      });
    config.dns.servers.push({
      type: 'tcp',
      tag: `corp-dns-${id}`,
      server: '127.0.0.1',
      server_port: r.profile.dnsPort,
    });
    managedRules.push({
      rule_set: [`corp-route-${id}`],
      network: ['tcp'],
      outbound: `corp-out-${id}`,
    });
    if (packetTag) managedRules.push({ rule_set: [`corp-route-${id}`], network: ['udp'], ip_version: 4, outbound: packetTag });
    if (icmpTag) managedRules.push({ rule_set: [`corp-route-${id}`], network: ['icmp'], ip_version: 4, outbound: icmpTag });
    // Preserve ownership at this priority even while this company is reconnecting.
    // Never leak an established company's failed target into a lower-priority VPN.
    managedRules.push({ rule_set: [`corp-guard-${id}`], action: 'reject' });
    dnsRules.push({
      rule_set: [`corp-dns-${id}`],
      action: 'route',
      server: `corp-dns-${id}`,
      disable_cache: true,
    });
    if (r.internetPath) {
      const policy = vpnRouting(r.profile, !!proxyEnabled);
      const active = (condition?: any) => ({ type: 'logical', mode: 'and', rules: [
        { rule_set: [`corp-internet-${id}`] }, ...(condition ? [condition] : []),
      ] });
      const cn = { type: 'logical', mode: 'or', rules: [
        { rule_set: ['geosite-cn', 'geoip-cn'] }, { domain_suffix: ['cn'] },
      ] };
      const automaticDirect = r.profile.protocol === 'softether' &&
        (r.profile.trafficMode || 'split') === 'split' && r.profile.autoDiscoverPrivate !== false;
      if (automaticDirect) for (const [network, tag] of [['udp', packetTag], ['icmp', icmpTag]]) if (tag) packetDiscovery.push({
        ...active({ ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], network: [network] }), outbound: tag,
      });
      const route = (outlet: 'direct' | 'proxy' | 'vpn', condition?: any, fallback = false) => {
        const rules = fallback ? internetFallback : internetRules;
        if (outlet === 'vpn') rules.push(
          { ...active(condition), rules: [...active(condition).rules, { network: ['tcp'] }], outbound: `corp-out-${id}` },
          ...(packetTag ? [{ ...active(condition), rules: [...active(condition).rules, { network: ['udp'], ip_version: 4 }], outbound: packetTag }] : []),
          ...(icmpTag ? [{ ...active(condition), rules: [...active(condition).rules, { network: ['icmp'], ip_version: 4 }], outbound: icmpTag }] : []),
          { ...active(condition), action: 'reject' },
        );
        else {
          // Apply one network policy to all TCP services, including public
          // company targets absent from DHCP routes. The native dispatcher
          // retains a successful local socket or retries the VPN before relay.
          if (outlet === 'direct' && automaticDirect) rules.push({
            ...active(condition),
            rules: [...active(condition).rules, { network: ['tcp'] }, {
              type: 'logical', mode: 'or', rules: [
                { domain_regex: ['.*'] },
                { type: 'logical', mode: 'and', rules: [
                  { ip_version: 4 },
                  { ip_cidr: ['0.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'], invert: true },
                ] },
              ],
            }],
            outbound: `corp-out-${id}`,
          });
          rules.push({ ...active(condition), outbound: outlet });
        }
      };
      // Keep the app's local endpoints reachable; explicit company rules still
      // precede this layer. Private/company overlaps are decided by those rules.
      internetRules.push({ ...active({ ip_cidr: ['127.0.0.0/8', '::1/128'] }), outbound: 'direct' });
      if (!runtime.privateProxy && (r.profile.trafficMode || 'split') === 'split' && r.profile.autoDiscoverPrivate !== false) {
        const condition = active({ ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] });
        discoveryRules.push({ ...condition, rules: [...condition.rules, { network: ['tcp'] }], outbound: `corp-out-${id}` });
      }
      if (r.discoveredGuardPath)
        discoveryGuards.push({ rule_set: [`corp-discovered-guard-${id}`], action: 'reject' });
      route(policy.lan, { ip_is_private: true });
      route(policy.domestic, cn);
      route(policy.foreign, undefined, true);
      if (r.profile.trafficMode && r.profile.trafficMode !== 'split') {
        const dns = (outlet: 'direct' | 'proxy' | 'vpn', condition?: any) => {
          internetDNS.push({ type: 'logical', mode: 'and', rules: [
            { rule_set: [`corp-internet-dns-${id}`] }, ...(condition ? [condition] : []),
          ], action: 'route',
            server: outlet === 'vpn' ? `corp-dns-${id}` : outlet === 'proxy' ? 'remote-dns' : 'direct-dns',
            disable_cache: true, ...(outlet === 'vpn' ? { strategy: 'ipv4_only' } : {}),
          });
        };
        dns(policy.lan, { type: 'logical', mode: 'or', rules: [
          { domain_suffix: ['local', 'lan', 'localhost'] }, { domain_regex: ['^[^.]+$'] },
        ] });
        dns(policy.domestic, { type: 'logical', mode: 'or', rules: [
          { rule_set: ['geosite-cn'] }, { domain_suffix: ['cn'] },
        ] });
        dns(policy.foreign);
      }
    }
  }
  const setup: any[] = [],
    blocked: any[] = [],
    ordinary: any[] = [],
    privateRules: any[] = [],
    apps: any[] = [],
    domestic: any[] = [];
  for (const rule of config.route.rules) {
    if (
      rule.inbound?.includes('speedtest-in') ||
      rule.action === 'sniff' ||
      rule.action === 'hijack-dns'
    )
      setup.push(rule);
    else if (rule.action === 'reject') blocked.push(rule);
    else if (rule.ip_is_private || rule.rule_set?.includes('geoip-private'))
      privateRules.push(rule);
    else if (
      rule.rule_set?.includes('geosite-cn') ||
      rule.rule_set?.includes('geoip-cn')
    )
      domestic.push(rule);
    else if (rule.process_name || rule.process_path) apps.push(rule);
    else ordinary.push(rule);
  }
  config.route.rules = [
    ...setup.filter(rule => rule.action !== 'hijack-dns'),
    ...blocked,
    { process_name: [runtime.coreProcessName], outbound: 'direct' },
    ...probes,
    { domain_suffix: ['bluewing.invalid'], action: 'reject' },
    ...companyDNS,
    ...setup.filter(rule => rule.action === 'hijack-dns'),
    ...managedRules,
    ...ordinary,
    ...discoveryRules,
    ...discoveryGuards,
    ...packetDiscovery,
    ...internetRules,
    ...privateRules,
    ...domestic,
    ...apps,
    ...internetFallback,
  ];
  const predefined = config.dns.rules.filter((r: any) => r.action === 'predefined');
  config.dns.rules = [...dnsRules, ...predefined, ...internetDNS,
    ...config.dns.rules.filter((r: any) => r.action !== 'predefined')];
  for (const inbound of config.inbounds) {
    if (inbound.type === 'tun') {
      // Never capture the fixed local endpoints or known gateway IPs into the company tunnel.
      const excluded = new Set<string>(inbound.route_exclude_address || []);
      for (const r of runtime.profiles) {
        const host = r.profile.gateway.host;
        if (isIP(host)) excluded.add(`${host}/${isIP(host) === 4 ? 32 : 128}`);
      }
      inbound.route_exclude_address = [...excluded];
    }
  }
}
