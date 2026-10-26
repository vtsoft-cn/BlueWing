import { isIP } from 'net';
import { VpnRuntime } from '../../types/corporateVpn';

/** Fixed managed layer. A company connection never enters the public selector. */
export function applyCorporateConfig(
  config: Record<string, any>,
  runtime?: VpnRuntime,
): void {
  // Callers that rebuild through the tray or selector fallback receive the same managed layer.
  config.outbounds = (config.outbounds || []).filter(
    (r: any) => !r.tag?.startsWith('corp-out-'),
  );
  config.route.rule_set = (config.route.rule_set || []).filter(
    (r: any) => !r.tag?.startsWith('corp-'),
  );
  config.route.rules = (config.route.rules || []).filter(
    (r: any) =>
      !r.rule_set?.some((tag: string) => tag.startsWith('corp-')) &&
      !(
        r.process_name?.length === 1 &&
        r.process_name[0] === 'bluewing-vpn-core.exe'
      ),
  );
  config.dns.servers = (config.dns.servers || []).filter(
    (r: any) => !r.tag?.startsWith('corp-dns-'),
  );
  config.dns.rules = (config.dns.rules || []).filter(
    (r: any) => !r.server?.startsWith('corp-dns-'),
  );
  if (!runtime?.profiles.length) return;
  const managedRules: any[] = [],
    dnsRules: any[] = [];
  for (const r of runtime.profiles) {
    const id = r.profile.id;
    config.outbounds.push({
      type: 'socks',
      tag: `corp-out-${id}`,
      server: '127.0.0.1',
      server_port: r.profile.socksPort,
      version: '5',
      username: r.socksUser,
      password: r.socksPassword,
      network: 'tcp',
    });
    for (const [kind, file] of [
      ['route', r.routePath],
      ['guard', r.guardPath],
      ['dns', r.dnsPath],
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
    dnsRules.push({
      rule_set: [`corp-dns-${id}`],
      action: 'route',
      server: `corp-dns-${id}`,
      disable_cache: true,
    });
  }
  // All authorized routes precede every guard; overlapping resources can use the active profile.
  for (const r of runtime.profiles)
    managedRules.push({
      rule_set: [`corp-guard-${r.profile.id}`],
      action: 'reject',
    });
  for (const arr of [config.dns.rules]) { if (!Array.isArray(arr)) { config.dns.rules = []; break; } }
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
    ...setup,
    ...blocked,
    { process_name: [runtime.coreProcessName], outbound: 'direct' },
    ...managedRules,
    ...ordinary,
    ...privateRules,
    ...domestic,
    ...apps,
  ];
  config.dns.rules = [...dnsRules, ...config.dns.rules];
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
