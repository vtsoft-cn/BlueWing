import { VpnCertificate, VpnProfile } from '../../types/corporateVpn';

/** First-use trust is bound to one gateway. Never replace a known pin or downgrade a known CA. */
export function gatewayTrust(
  tls: VpnProfile['tls'],
  certificate: VpnCertificate,
): VpnProfile['tls'] {
  const issues = certificate.trustIssues || [];
  if (
    tls.pinSha256 &&
    tls.pinSha256.toLowerCase() !== certificate.fingerprint.toLowerCase()
  )
    throw new Error('TLS_CERT_CHANGED');
  if (issues.includes('EXPIRED')) throw new Error('TLS_CERT_EXPIRED');
  if (issues.includes('NOT_YET_VALID'))
    throw new Error('TLS_CERT_NOT_YET_VALID');
  if (tls.pinSha256) return tls;
  if (certificate.chainTrusted) return { ...tls, autoTrustAnchor: 'system' };
  if (tls.caPem) throw new Error('TLS_UNTRUSTED');
  if (tls.autoTrustAnchor === 'system') throw new Error('TLS_CERT_CHANGED');
  if (
    !issues.includes('UNTRUSTED_AUTHORITY') ||
    issues.some(
      (issue) => !['UNTRUSTED_AUTHORITY', 'NAME_MISMATCH'].includes(issue),
    )
  )
    throw new Error('TLS_UNTRUSTED');
  return {
    ...tls,
    pinSha256: certificate.fingerprint.toLowerCase(),
    autoTrustAnchor: 'pin',
  };
}
