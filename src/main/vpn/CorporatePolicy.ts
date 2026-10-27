import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import {
  VpnProfile,
  VpnResources,
  VpnRuntime,
  VpnRuntimeProfile,
  VpnTarget,
} from '../../types/corporateVpn';
import { atomicJSON, validateResources, targets } from './ProfileRepository';
import { PrivateRouteDiscovery } from './PrivateRouteDiscovery';

export function sourceRules(
  targets: VpnTarget[],
  guard = false,
): Record<string, unknown> {
  const rules = targets
    .filter((t) => guard || !t.guardOnly)
    .map((t) => {
      const r: Record<string, unknown> = {};
      if (t.domains.length) r.domain_suffix = t.domains;
      if (t.cidrs.length) r.ip_cidr = t.cidrs;
      if (!guard) {
        if (t.network) r.network = [t.network];
        if (t.ports?.length) {
          const single = t.ports.filter((p) => !p.includes(':')).map(Number),
            range = t.ports.filter((p) => p.includes(':'));
          if (single.length) r.port = single;
          if (range.length) r.port_range = range;
        }
      }
      return r;
    });
  return { version: 3, rules };
}
export class CorporatePolicy {
  readonly discovery: PrivateRouteDiscovery;
  private credentials = new Map<string, { user: string; password: string }>();
  private resources = new Map<string, VpnResources>();
  private protectedTargets = new Map<string, VpnTarget[]>();
  private probes = new Map<string, string>();
  private activeId?: string;
  private guardedId?: string;
  private current: VpnRuntime = {
    profiles: [],
    coreProcessName: 'bluewing-vpn-core.exe',
  };
  constructor(readonly dir: string) {
    this.discovery = new PrivateRouteDiscovery(dir);
    const known = path.join(dir, 'vpn-runtime', 'known-targets.json');
    if (fs.existsSync(known)) {
      for (const [id, value] of Object.entries(
        JSON.parse(fs.readFileSync(known, 'utf8')),
      ))
        if (/^[a-zA-Z0-9-]{1,64}$/.test(id))
          this.protectedTargets.set(id, targets(value));
    }
    const file = path.join(dir, 'vpn-runtime', 'resources.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, value] of Object.entries(data))
        if (/^[a-zA-Z0-9-]{1,64}$/.test(id))
          this.resources.set(id, validateResources(value));
    }
  }
  runtime(): VpnRuntime {
    return structuredClone(this.current);
  }
  getResources(id: string): VpnResources | undefined {
    return structuredClone(this.resources.get(id));
  }
  isProtected(id?: string): boolean {
    return !!id && this.guardedId === id;
  }
  begin(id: string, profiles: VpnProfile[]): void {
    this.activeId = undefined;
    this.guardedId = id;
    this.probes.clear();
    this.prepare(profiles);
  }
  learn(id: string, data: any, profiles: VpnProfile[]): boolean {
    const profile = profiles.find(p => p.id === id);
    if (this.activeId !== id || !profile || data?.network !== 'tcp' || !this.discovery.observe(profile, data.address, data.port, data.outlet)) return false;
    this.prepare(profiles);
    return true;
  }
  clearDiscovered(profile: VpnProfile, profiles: VpnProfile[]): void {
    this.discovery.clear(profile.id);
    this.prepare(profiles);
  }
  setProbe(id: string, nonce: string, profiles: VpnProfile[]): void {
    this.activeId = id;
    this.guardedId = id;
    this.probes.set(id, nonce);
    this.prepare(profiles);
  }
  deactivate(profiles: VpnProfile[], preserveGuard = false): void {
    this.activeId = undefined;
    if (!preserveGuard) this.guardedId = undefined;
    this.probes.clear();
    this.prepare(profiles);
  }
  update(id: string, input: unknown, profiles: VpnProfile[]): string {
    const value = validateResources(input);
    const old = this.resources.get(id);
    this.resources.set(id, value);
    try {
      this.prepare(profiles);
      atomicJSON(
        path.join(this.dir, 'vpn-runtime', 'resources.json'),
        Object.fromEntries(this.resources),
      );
    } catch (e) {
      if (old) this.resources.set(id, old);
      else this.resources.delete(id);
      throw e;
    }
    return createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex')
      .slice(0, 16);
  }
  prepare(profiles: VpnProfile[]): VpnRuntime {
    const next: VpnRuntimeProfile[] = [];
    const ids = new Set(profiles.map(p => p.id));
    if (this.guardedId && !ids.has(this.guardedId)) this.guardedId = undefined;
    if (this.activeId && !ids.has(this.activeId)) this.activeId = undefined;
    // A running core may still watch a removed profile until its next reload.
    for (const old of this.current.profiles.filter(r => !ids.has(r.profile.id)))
      for (const file of [old.routePath, old.guardPath, old.dnsPath, old.internetPath, old.internetDnsPath, old.discoveredGuardPath])
        if (file) this.publish(file, { version: 3, rules: [] });
    for (const profile of profiles) {
      const protectedNow = this.isProtected(profile.id);
      let credentials = this.credentials.get(profile.id);
      if (!credentials) {
        credentials = {
          user: randomBytes(16).toString('hex'),
          password: randomBytes(32).toString('hex'),
        };
        this.credentials.set(profile.id, credentials);
      }
      const res = this.resources.get(profile.id);
      const hostTargets = Object.entries({
        ...res?.hosts,
        ...profile.hosts,
      }).map(([d, ips]) => ({
        domains: [d],
        cidrs: ips.map((ip) => `${ip}/${ip.includes(':') ? 128 : 32}`),
      }));
      const current = [
        ...profile.targets,
        ...(res?.targets ?? []),
        ...hostTargets,
      ];
      const before = this.protectedTargets.get(profile.id) || [];
      // Keep revoked/previous destinations protected for the whole process lifetime.
      const all = [
        ...new Map(
          [...before, ...current].map((t) => [
            JSON.stringify({ domains: t.domains, cidrs: t.cidrs }),
            { domains: t.domains, cidrs: t.cidrs },
          ]),
        ).values(),
      ];
      if (all.length > 4096)
        throw new Error('公司目标保护集合超过上限，请先审查资源配置');
      this.protectedTargets.set(profile.id, all);
      const folder = path.join(this.dir, 'vpn-runtime', profile.id);
      const routePath = path.join(folder, 'route.json'),
        guardPath = path.join(folder, 'guard.json'),
        dnsPath = path.join(folder, 'dns.json'),
        internetPath = path.join(folder, 'internet-active.json'),
        internetDnsPath = path.join(folder, 'internet-dns-active.json'),
        discoveredGuardPath = path.join(folder, 'discovered-guard.json');
      this.publish(discoveredGuardPath, sourceRules(
        protectedNow && profile.autoDiscoverPrivate !== false && (profile.trafficMode || 'split') === 'split'
          ? this.discovery.targets(profile) : []));
      this.publish(internetDnsPath, { version: 3, rules:
        this.activeId === profile.id ? [{ domain_regex: ['.*'] }] : [] });
      this.publish(internetPath, { version: 3, rules:
        this.activeId === profile.id
          ? [{ type: 'logical', mode: 'or', rules: [
            { domain_regex: ['.*'] }, { ip_cidr: ['0.0.0.0/0', '::/0'] },
          ] }] : [] });
      // Revoke the previous preview's broad domestic outlet even if an older
      // public core is still watching its rule-set during an upgrade.
      const legacyChinaPath = path.join(folder, 'china-active.json');
      if (fs.existsSync(legacyChinaPath))
        this.publish(legacyChinaPath, { version: 3, rules: [] });
      this.publish(guardPath, sourceRules(protectedNow ? all : [], true));
      this.publish(
        dnsPath,
        sourceRules(
          (protectedNow ? all : [])
            .filter((t) => t.domains.length)
            .map((t) => ({ domains: t.domains, cidrs: [] })),
          true,
        ),
      );
      const nonce = this.probes.get(profile.id);
      this.publish(
        routePath,
        sourceRules(
          this.activeId === profile.id
            ? [
                ...current,
                ...(nonce
                  ? [
                      {
                        domains: [`${nonce}.${profile.id}.bluewing.invalid`],
                        cidrs: [],
                        ports: ['1'],
                      },
                    ]
                  : []),
              ]
            : [],
        ),
      );
      next.push({
        profile,
        socksUser: credentials.user,
        socksPassword: credentials.password,
        routePath,
        guardPath,
        dnsPath,
        internetPath,
        internetDnsPath,
        discoveredGuardPath,
      });
    }
    atomicJSON(
      path.join(this.dir, 'vpn-runtime', 'known-targets.json'),
      Object.fromEntries(this.protectedTargets),
    );
    this.current = { profiles: next, coreProcessName: 'bluewing-vpn-core.exe' };
    return this.runtime();
  }
  private publish(file: string, value: Record<string, unknown>): void {
    // Generate only validated source schemas; never edit the watched destination in place.
    const data = JSON.stringify(value, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === data) return;
    atomicJSON(file, value);
  }
}
