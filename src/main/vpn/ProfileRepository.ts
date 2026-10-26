import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { domainToASCII } from 'url';
import { VpnProfile, VpnResources, VpnTarget } from '../../types/corporateVpn';
import { isValidDomain } from '../../utils/ip';

export function domain(input: unknown): string {
  if (typeof input !== 'string') throw new Error('域名格式不正确');
  if (/[\s\/:@?#\\]/.test(input.trim()))
    throw new Error('域名不能包含 URL、路径或空白');
  const value = domainToASCII(
    input.trim().replace(/^\*\./, '').replace(/\.$/, '').toLowerCase(),
  );
  if (!isValidDomain(value) || isIP(value)) throw new Error('域名格式不正确');
  return value;
}
export function cidr(input: unknown): string {
  if (typeof input !== 'string') throw new Error('IP/CIDR 格式不正确');
  const [ip, prefix, extra] = input.trim().split('/');
  const family = isIP(ip);
  const bits = family === 4 ? 32 : 128;
  if (
    !family ||
    extra !== undefined ||
    (prefix !== undefined && (!/^\d+$/.test(prefix) || +prefix > bits))
  )
    throw new Error('IP/CIDR 格式不正确');
  if (+String(prefix) === 0) throw new Error('公司网段不能为默认路由');
  return `${ip}/${prefix ?? bits}`;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('列表格式或大小不正确');
  return value;
}
export function targets(value: unknown): VpnTarget[] {
  return list(value, 4096).map((r: any) => {
    if (!r || typeof r !== 'object') throw new Error('公司资源格式不正确');
    const domains = list(r.domains ?? [], 256).map(domain);
    const cidrs = list(r.cidrs ?? [], 4096).map(cidr);
    if (!domains.length && !cidrs.length)
      throw new Error('公司资源至少需要域名或 IP');
    const ports =
      r.ports === undefined
        ? undefined
        : list(r.ports, 256).map((v) => {
            if (typeof v !== 'string' || !/^\d{1,5}(:\d{1,5})?$/.test(v))
              throw new Error('端口格式不正确');
            const p = v.split(':').map(Number);
            if (
              p.some((n) => n < 1 || n > 65535) ||
              (p.length === 2 && p[0] > p[1])
            )
              throw new Error('端口范围不正确');
            return v;
          });
    if (r.network && !['tcp', 'udp'].includes(r.network))
      throw new Error('不支持的资源网络类型');
    return {
      ...(r.guardOnly === true ? { guardOnly: true } : {}),
      domains: [...new Set(domains)],
      cidrs: [...new Set(cidrs)],
      ...(ports?.length ? { ports } : {}),
      ...(r.network ? { network: r.network } : {}),
    };
  });
}
export function hosts(value: unknown): Record<string, string[]> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 4096
  )
    throw new Error('Hosts 格式不正确');
  const result: Record<string, string[]> = {};
  for (const [key, ips] of Object.entries(value)) {
    result[domain(key)] = list(ips, 32).map((v) => {
      if (typeof v !== 'string' || !isIP(v)) throw new Error('Hosts IP 不正确');
      return v;
    });
  }
  return result;
}
export function validateProfile(input: unknown): VpnProfile {
  const p = input as VpnProfile;
  if (!p || typeof p !== 'object') throw new Error('配置格式不正确');
  if (!['easyconnect', 'atrust'].includes(p.protocol))
    throw new Error('不支持的 VPN 协议');
  if (p.id && !/^[a-zA-Z0-9-]{1,64}$/.test(p.id))
    throw new Error('配置 ID 不正确');
  const text = (v: unknown, max: number) => {
    if (typeof v !== 'string' || v.length > max || /[\x00-\x1f]/.test(v))
      throw new Error('配置文本不正确');
    return v.trim();
  };
  let host = text(p.gateway?.host, 253).replace(/^\[|\]$/g, '');
  if (!isIP(host)) host = domain(host);
  const port = p.gateway?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('网关端口不正确');
  const name = text(p.name, 100);
  if (!name) throw new Error('请输入配置名称');
  const tls = p.tls ?? {};
  if (
    tls.trustMode !== undefined &&
    !['auto', 'strict'].includes(tls.trustMode)
  )
    throw new Error('证书校验方式不正确');
  if (
    tls.caPem !== undefined &&
    (typeof tls.caPem !== 'string' ||
      tls.caPem.length > 262144 ||
      !tls.caPem.includes('-----BEGIN CERTIFICATE-----'))
  )
    throw new Error('CA 证书格式不正确');
  if (tls.pinSha256 && !/^[0-9a-fA-F]{64}$/.test(tls.pinSha256))
    throw new Error('证书 SHA256 必须为 64 位十六进制');
  return {
    id: p.id || randomUUID(),
    name,
    protocol: p.protocol,
    gateway: { host, port },
    username: text(p.username ?? '', 256),
    authMethod: text(p.authMethod ?? 'auth/psw', 100),
    loginDomain: text(p.loginDomain ?? '', 100),
    rememberPassword: p.rememberPassword === true,
    rememberSession: p.rememberSession === true,
    tls: {
      trustMode: tls.trustMode || 'auto',
      ...(['system', 'pin'].includes(tls.autoTrustAnchor || '')
        ? { autoTrustAnchor: tls.autoTrustAnchor }
        : {}),
      ...(tls.caPem ? { caPem: tls.caPem } : {}),
      ...(tls.pinSha256 ? { pinSha256: tls.pinSha256.toLowerCase() } : {}),
      ...(tls.serverName ? { serverName: domain(tls.serverName) } : {}),
    },
    targets: targets(p.targets ?? []),
    hosts: hosts(p.hosts ?? {}),
    bindInterface: text(p.bindInterface ?? '', 200),
    socksPort: 0,
    dnsPort: 0,
  };
}
export function validateResources(value: any): VpnResources {
  return {
    targets: targets(value?.targets),
    hosts: hosts(value?.hosts),
    dnsServers: list(value?.dnsServers, 16).map((v) => {
      if (typeof v !== 'string' || !isIP(v))
        throw new Error('公司 DNS 地址不正确');
      return v;
    }),
  };
}
export function atomicJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export class ProfileRepository {
  private file: string;
  private profiles: VpnProfile[] = [];
  constructor(readonly dir: string) {
    this.file = path.join(dir, 'vpn-profiles.json');
    this.reload();
  }
  reload(): void {
    this.profiles = [];
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        data.schemaVersion !== 1 ||
        !Array.isArray(data.profiles) ||
        data.profiles.length > 32
      )
        throw new Error('VPN 接入 配置版本不兼容');
      const ports = new Set<number>();
      this.profiles = data.profiles.map((raw: VpnProfile) => {
        const p = validateProfile(raw);
        for (const port of [raw.socksPort, raw.dnsPort]) {
          if (
            !Number.isInteger(port) ||
            port < 1024 ||
            port > 65535 ||
            ports.has(port)
          )
            throw new Error('VPN 接入 端口租约损坏');
          ports.add(port);
        }
        return { ...p, socksPort: raw.socksPort, dnsPort: raw.dnsPort };
      });
      if (new Set(this.profiles.map((p) => p.id)).size !== this.profiles.length)
        throw new Error('VPN 接入 ID 重复');
    }
  }
  list(): VpnProfile[] {
    return structuredClone(this.profiles);
  }
  get(id: string): VpnProfile {
    const p = this.profiles.find((p) => p.id === id);
    if (!p) throw new Error('VPN 接入 配置不存在');
    return structuredClone(p);
  }
  save(input: unknown): VpnProfile {
    const p = validateProfile(input);
    const old = this.profiles.find((v) => v.id === p.id);
    if (!old && this.profiles.length >= 32)
      throw new Error('最多保存 32 个接入配置');
    const used = new Set(
      this.profiles.flatMap((v) => [v.socksPort, v.dnsPort]),
    );
    let port = 21080;
    while (used.has(port) || used.has(port + 1)) port += 2;
    p.socksPort = old?.socksPort ?? port;
    p.dnsPort = old?.dnsPort ?? port + 1;
    const next = [...this.profiles.filter((v) => v.id !== p.id), p];
    atomicJSON(this.file, { schemaVersion: 1, profiles: next });
    this.profiles = next;
    return structuredClone(p);
  }
  remove(id: string): void {
    this.get(id);
    const next = this.profiles.filter((v) => v.id !== id);
    atomicJSON(this.file, { schemaVersion: 1, profiles: next });
    this.profiles = next;
  }
  export(): VpnProfile[] {
    return this.list().map((p) => ({
      ...p,
      rememberPassword: false,
      rememberSession: false,
      socksPort: 0,
      dnsPort: 0,
    }));
  }
  reassignPorts(): void {
    let port =
      Math.max(
        21078,
        ...this.profiles.flatMap((p) => [p.socksPort, p.dnsPort]),
      ) + 1;
    if (port + this.profiles.length * 2 > 65535)
      throw new Error('VPN 接入 本机端口租约已耗尽');
    const next = this.profiles.map((p) => ({
      ...p,
      socksPort: port++,
      dnsPort: port++,
    }));
    atomicJSON(this.file, { schemaVersion: 1, profiles: next });
    this.profiles = next;
  }
  import(input: unknown, mode: 'merge' | 'replace'): number {
    const incoming = list(input, 32).map(validateProfile);
    if (!incoming.length) return 0;
    const next = mode === 'replace' ? [] : this.list();
    const identity = (p: VpnProfile) =>
      JSON.stringify([
        p.protocol,
        p.gateway,
        p.username,
        p.authMethod,
        p.loginDomain,
      ]);
    const used = new Set(
      this.profiles.flatMap((p) => [p.socksPort, p.dnsPort]),
    );
    for (const p of incoming) {
      p.rememberPassword = false;
      p.rememberSession = false;
      const old = this.profiles.find((v) => identity(v) === identity(p));
      if (old) {
        p.id = old.id;
        p.socksPort = old.socksPort;
        p.dnsPort = old.dnsPort;
      } else {
        if (
          this.profiles.some((v) => v.id === p.id) ||
          next.some((v) => v.id === p.id)
        )
          p.id = randomUUID();
        let port = 21080;
        while (used.has(port) || used.has(port + 1)) port += 2;
        p.socksPort = port;
        p.dnsPort = port + 1;
        used.add(port);
        used.add(port + 1);
      }
      const idx = next.findIndex((v) => v.id === p.id);
      if (idx >= 0) next[idx] = p;
      else next.push(p);
    }
    if (next.length > 32) throw new Error('最多保存 32 个接入配置');
    atomicJSON(this.file, { schemaVersion: 1, profiles: next });
    this.profiles = next;
    return incoming.length;
  }
}
