import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, generateKeyPairSync } from 'crypto';
import {
  VpnProfile,
  VpnResources,
  VpnRuntime,
  VpnRuntimeProfile,
  VpnTarget,
} from '../../types/corporateVpn';
import { atomicJSON, validateResources, targets } from './ProfileRepository';
import { PrivateRouteDiscovery } from './PrivateRouteDiscovery';
import { orderedVpnProfiles } from '../../utils/vpnRouting';
import { profileIdentity } from './ProfileIdentity';

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
  readonly cacheWarnings: string[] = [];
  private credentials = new Map<string, { user: string; password: string; packet?: { privateKey: string; publicKey: string; icmp?: { privateKey: string; publicKey: string } } }>();
  private packetServers = new Map<string, { port: number; serverPublicKey: string; loopbackInterface?: string; icmp?: { port: number; serverPublicKey: string } }>();
  private resources = new Map<string, VpnResources>();
  private protectedTargets = new Map<string, VpnTarget[]>();
  private resourceIdentities = new Map<string, string>();
  private guardIdentities = new Map<string, string>();
  private runtimeIdentities = new Map<string, string>();
  private probes = new Map<string, string>();
  private activeIds = new Set<string>();
  private guardedIds = new Set<string>();
  private privateProxy?: VpnRuntime['privateProxy'];
  private current: VpnRuntime = {
    profiles: [],
    coreProcessName: 'bluewing-vpn-core.exe',
  };
  constructor(readonly dir: string) {
    this.discovery = new PrivateRouteDiscovery(dir);
    this.protectedTargets = this.loadCache('known-targets.json', targets, this.guardIdentities);
    this.resources = this.loadCache('resources.json', validateResources, this.resourceIdentities);
  }
  private loadCache<T>(name: string, validate: (input: unknown) => T, identities: Map<string, string>): Map<string, T> {
    const file = path.join(this.dir, 'vpn-runtime', name), result = new Map<string, T>();
    if (!fs.existsSync(file)) return result;
    let invalid = false;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid cache');
      for (const [id, value] of Object.entries(data)) {
        try {
          if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('invalid cache id');
          const bound = value as any;
          if (bound && typeof bound === 'object' && 'identity' in bound && 'value' in bound) {
            if (typeof bound.identity !== 'string' || !/^[a-f0-9]{64}$/.test(bound.identity)) throw new Error('invalid identity');
            result.set(id, validate(bound.value));
            identities.set(id, bound.identity);
          } else result.set(id, validate(value)); // Legacy cache: bind once to its existing profile.
        } catch { invalid = true; }
      }
    } catch { invalid = true; }
    if (invalid) {
      // Retain healthy entries and isolate the damaged derived file. Explicit
      // profile rules and any healthy guard cache still protect company targets.
      try { fs.renameSync(file, `${file}.invalid-${Date.now()}-${randomBytes(4).toString('hex')}`); } catch { /* Report the failure without blocking unrelated internet. */ }
      const warning = '上次保存的部分 VPN 网络信息无法读取。公网连接可继续使用，连接 VPN 后将重新获取资源；有效的公司保护规则已保留。';
      if (!this.cacheWarnings.includes(warning)) this.cacheWarnings.push(warning);
    }
    return result;
  }
  runtime(): VpnRuntime {
    return structuredClone(this.current);
  }
  getResources(id: string): VpnResources | undefined {
    return structuredClone(this.resources.get(id));
  }
  isProtected(id?: string): boolean {
    return !!id && this.guardedIds.has(id);
  }
  isActive(id: string): boolean { return this.activeIds.has(id); }
  setPacketEndpoint(id: string, value: { port: number; publicKey: string; loopbackInterface?: string; icmp?: { port: number; publicKey: string } }, profiles: VpnProfile[]): void {
    if (!profiles.some(p => p.id === id && p.protocol === 'softether') || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.publicKey !== 'string' || Buffer.from(value.publicKey, 'base64').length !== 32) throw new Error('PACKET_ENDPOINT_INVALID');
    if (value.loopbackInterface !== undefined && (typeof value.loopbackInterface !== 'string' || value.loopbackInterface.length > 128 || /[\x00-\x1f]/.test(value.loopbackInterface))) throw new Error('PACKET_INTERFACE_INVALID');
    if (value.icmp && (!Number.isInteger(value.icmp.port) || value.icmp.port < 1 || value.icmp.port > 65535 || typeof value.icmp.publicKey !== 'string' || Buffer.from(value.icmp.publicKey, 'base64').length !== 32)) throw new Error('PACKET_ENDPOINT_INVALID');
    this.packetServers.set(id, { port: value.port, serverPublicKey: value.publicKey, loopbackInterface: value.loopbackInterface,
      ...(value.icmp ? { icmp: { port: value.icmp.port, serverPublicKey: value.icmp.publicKey } } : {}) });
    this.prepare(profiles);
  }
  setPrivateProxy(proxy: NonNullable<VpnRuntime['privateProxy']>, profiles: VpnProfile[]): void {
    this.privateProxy = proxy;
    this.prepare(profiles);
  }
  begin(id: string, profiles: VpnProfile[]): void {
    this.activeIds.delete(id);
    this.guardedIds.add(id);
    this.probes.delete(id);
    this.prepare(profiles);
  }
  learn(id: string, data: any, profiles: VpnProfile[]): boolean {
    const profile = profiles.find(p => p.id === id);
    if (!this.activeIds.has(id) || !profile || data?.network !== 'tcp' || !this.discovery.observe(profile, data.address, data.port, data.outlet)) return false;
    this.prepare(profiles);
    return true;
  }
  clearDiscovered(profile: VpnProfile, profiles: VpnProfile[]): void {
    this.discovery.clear(profile.id);
    this.prepare(profiles);
  }
  setProbe(id: string, nonce: string, profiles: VpnProfile[]): void {
    this.activeIds.add(id);
    this.guardedIds.add(id);
    this.probes.set(id, nonce);
    this.prepare(profiles);
  }
  deactivate(profiles: VpnProfile[], preserveGuard = false, id?: string): void {
    if (id) {
      this.activeIds.delete(id);
      if (!preserveGuard) this.guardedIds.delete(id);
      this.probes.delete(id);
    } else {
      this.activeIds.clear();
      if (!preserveGuard) this.guardedIds.clear();
      this.probes.clear();
    }
    this.prepare(profiles);
  }
  update(id: string, input: unknown, profiles: VpnProfile[]): string {
    this.synchronizeIdentities(profiles);
    const value = validateResources(input);
    const old = this.resources.get(id);
    this.resources.set(id, value);
    try {
      this.prepare(profiles);
      atomicJSON(
        path.join(this.dir, 'vpn-runtime', 'resources.json'),
        this.boundCache(this.resources, this.resourceIdentities),
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
    this.synchronizeIdentities(profiles);
    const next: VpnRuntimeProfile[] = [];
    const ids = new Set(profiles.map(p => p.id));
    for (const map of [this.resources, this.protectedTargets, this.credentials, this.packetServers, this.resourceIdentities, this.guardIdentities, this.runtimeIdentities])
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    for (const id of this.guardedIds) if (!ids.has(id)) this.guardedIds.delete(id);
    for (const id of this.activeIds) if (!ids.has(id)) this.activeIds.delete(id);
    // A running core may still watch a removed profile until its next reload.
    for (const old of this.current.profiles.filter(r => !ids.has(r.profile.id)))
      for (const file of [old.routePath, old.guardPath, old.dnsPath, old.internetPath, old.internetDnsPath, old.discoveredGuardPath])
        if (file) this.publish(file, { version: 3, rules: [] });
    const ordered = orderedVpnProfiles(profiles);
    const internetOwner = ordered.find(p => this.activeIds.has(p.id))?.id;
    for (const profile of ordered) {
      const protectedNow = this.isProtected(profile.id);
      let credentials = this.credentials.get(profile.id);
      if (!credentials) {
        credentials = {
          user: randomBytes(16).toString('hex'),
          password: randomBytes(32).toString('hex'),
        };
        this.credentials.set(profile.id, credentials);
      }
      if (profile.protocol === 'softether' && !credentials.packet) {
        const pair = generateKeyPairSync('x25519');
        credentials.packet = {
          privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
          publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
        };
      }
      if (profile.protocol === 'softether' && credentials.packet && !credentials.packet.icmp) {
        const pair = generateKeyPairSync('x25519');
        credentials.packet.icmp = {
          privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64'),
          publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
        };
      }
      const res = this.resources.get(profile.id);
      const hostTargets = Object.entries({
        ...res?.hosts,
        ...profile.hosts,
      }).map(([d, ips]) => ({
        domains: [d],
        cidrs: ips.map((ip) => `${ip}/${ip.includes(':') ? 128 : 32}`),
      }));
      const current: VpnTarget[] = [
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
      this.guardIdentities.set(profile.id, profileIdentity(profile));
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
        internetOwner === profile.id ? [{ domain_regex: ['.*'] }] : [] });
      const nonce = this.probes.get(profile.id);
      this.publish(internetPath, { version: 3, rules: [
        ...(internetOwner === profile.id
          ? [{ type: 'logical', mode: 'or', rules: [
            { domain_regex: ['.*'] }, { ip_cidr: ['0.0.0.0/0', '::/0'] },
          ] }] : []),
        ...(nonce ? [{ domain_suffix: [`${nonce}.${profile.id}.bluewing.invalid`], port: [1] }] : []),
      ] });
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
      const icmpTargets = current.filter(t => !t.guardOnly && !t.network && (!t.ports?.length || t.ports.includes('1:65535')))
        .map(t => ({ ...t, ports: undefined, network: undefined }));
      const routeSource = sourceRules(
          this.activeIds.has(profile.id)
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
        );
      if (this.activeIds.has(profile.id) && profile.protocol === 'softether' && credentials.packet && this.packetServers.has(profile.id)) {
        const packetRules = (sourceRules(icmpTargets).rules as any[]).map(rule => ({ ...rule, network: ['icmp'] }));
        (routeSource.rules as any[]).push(...packetRules);
      }
      this.publish(routePath, routeSource);
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
        ...(profile.protocol === 'softether' && credentials.packet ? { packet: {
          ...credentials.packet, ...this.packetServers.get(profile.id),
          icmp: credentials.packet.icmp && { ...credentials.packet.icmp, ...this.packetServers.get(profile.id)?.icmp,
            loopbackInterface: this.packetServers.get(profile.id)?.loopbackInterface },
        } } : {}),
      });
    }
    atomicJSON(
      path.join(this.dir, 'vpn-runtime', 'known-targets.json'),
      this.boundCache(this.protectedTargets, this.guardIdentities),
    );
    if (this.privateProxy) this.publish(this.privateProxy.rulePath, { version: 3, rules:
      (ordered.find(p => p.id === internetOwner)?.trafficMode || 'split') === 'split' && next.some(r => this.activeIds.has(r.profile.id) && (r.profile.trafficMode || 'split') === 'split' && r.profile.autoDiscoverPrivate !== false)
        ? [{ ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], network: ['tcp'] }] : [] });
    this.current = { profiles: next, coreProcessName: 'bluewing-vpn-core.exe', ...(this.privateProxy ? { privateProxy: this.privateProxy } : {}) };
    return this.runtime();
  }
  private boundCache<T>(values: Map<string, T>, identities: Map<string, string>): Record<string, unknown> {
    return Object.fromEntries([...values].map(([id, value]) => [id, { identity: identities.get(id) || this.runtimeIdentities.get(id), value }]));
  }
  private synchronizeIdentities(profiles: VpnProfile[]): void {
    for (const profile of profiles) {
      const id = profile.id, identity = profileIdentity(profile);
      if (this.runtimeIdentities.has(id) && this.runtimeIdentities.get(id) !== identity) {
        this.credentials.delete(id); this.packetServers.delete(id);
        this.resources.delete(id); this.protectedTargets.delete(id);
        this.activeIds.delete(id); this.guardedIds.delete(id); this.probes.delete(id);
      }
      if (this.resourceIdentities.has(id) && this.resourceIdentities.get(id) !== identity) this.resources.delete(id);
      if (this.guardIdentities.has(id) && this.guardIdentities.get(id) !== identity) this.protectedTargets.delete(id);
      this.resourceIdentities.set(id, identity); this.guardIdentities.set(id, identity); this.runtimeIdentities.set(id, identity);
    }
  }
  private publish(file: string, value: Record<string, unknown>): void {
    // Generate only validated source schemas; never edit the watched destination in place.
    const data = JSON.stringify(value, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === data) return;
    atomicJSON(file, value);
  }
}
