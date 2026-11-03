import { createHash } from 'crypto';
import { VpnProfile } from '../../types/corporateVpn';

/** Resource and runtime identity; automatic certificate pinning does not change it. */
export function profileIdentity(p: VpnProfile): string {
  return createHash('sha256').update(JSON.stringify([
    p.protocol, p.gateway.host, p.gateway.port, p.username,
    p.loginDomain, p.authMethod, p.tls.serverName || '',
  ])).digest('hex');
}

export function credentialKey(p: VpnProfile, kind: 'password' | 'session'): string {
  return `${p.id}:${kind}:v2:${profileIdentity(p)}`;
}

/** Detection only. Unbound legacy secrets are never reused or migrated silently. */
export function legacyCredentialKey(p: VpnProfile, kind: 'password' | 'session'): string {
  return `${p.id}:${kind}:${p.protocol}:${p.gateway.host}:${p.gateway.port}:${p.username}:${p.loginDomain}:${p.authMethod}`;
}
