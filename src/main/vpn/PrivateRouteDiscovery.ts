import fs from 'fs';
import path from 'path';
import { isIP } from 'net';
import { VpnProfile, VpnTarget } from '../../types/corporateVpn';
import { atomicJSON } from './ProfileRepository';

export function privateIPv4(value: unknown): value is string {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function identity(p: VpnProfile): string {
  return JSON.stringify([p.protocol, p.gateway.host, p.gateway.port, p.username, p.loginDomain, p.authMethod, p.tls.serverName || '']);
}

/** Exact private addresses only; no guessed subnets, credentials or business payloads. */
export class PrivateRouteDiscovery {
  private entries: Record<string, { identity: string; endpoints: Array<{ address: string; port: number }> }> = {};
  private file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'vpn-runtime', 'discovered-targets.json');
    if (!fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.schemaVersion !== 1 || !data.entries || typeof data.entries !== 'object') return;
      for (const [id, entry] of Object.entries(data.entries).slice(0, 32)) {
        const value = entry as any;
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || typeof value?.identity !== 'string' || value.identity.length > 1200 || !Array.isArray(value.endpoints)) continue;
        const endpoints = new Map<string, { address: string; port: number }>();
        for (const e of value.endpoints.slice(0, 256))
          if (privateIPv4(e?.address) && Number.isInteger(e.port) && e.port > 0 && e.port <= 65535)
            endpoints.set(`${e.address}:${e.port}`, { address: e.address, port: e.port });
        this.entries[id] = { identity: value.identity, endpoints: [...endpoints.values()] };
      }
    } catch { /* An invalid discovery cache must not prevent a VPN login. */ }
  }
  targets(p: VpnProfile): VpnTarget[] {
    const entry = this.entries[p.id];
    return entry?.identity === identity(p)
      ? entry.endpoints.map(e => ({ domains: [], cidrs: [`${e.address}/32`], ports: [String(e.port)], network: 'tcp' })) : [];
  }
  observe(p: VpnProfile, address: unknown, port: unknown, outlet: unknown): boolean {
    if (!privateIPv4(address) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535 || (outlet !== 'direct' && outlet !== 'vpn') || p.autoDiscoverPrivate === false || (p.trafficMode || 'split') !== 'split') return false;
    const endpoints = this.entries[p.id]?.identity === identity(p) ? this.entries[p.id].endpoints : [];
    const exists = endpoints.some(e => e.address === address && e.port === port);
    if ((outlet === 'vpn' && (exists || endpoints.length >= 256)) || (outlet === 'direct' && !exists)) return false;
    const nextEndpoints = outlet === 'vpn' ? [...endpoints, { address, port: Number(port) }] : endpoints.filter(e => e.address !== address || e.port !== port);
    const next = { ...this.entries, [p.id]: { identity: identity(p), endpoints: nextEndpoints } };
    atomicJSON(this.file, { schemaVersion: 1, entries: next });
    this.entries = next;
    return true;
  }
  clear(id: string): void {
    const next = { ...this.entries };
    delete next[id];
    atomicJSON(this.file, { schemaVersion: 1, entries: next });
    this.entries = next;
  }
}
