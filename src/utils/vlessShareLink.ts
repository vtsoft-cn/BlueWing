import type { ProxyNode } from '../types';

/** Preserve connection-critical fields when a copied node is imported again. */
export function vlessShareLink(node: ProxyNode): string {
  if (node.type !== 'vless') throw new Error('Expected a VLESS node');
  // Native outbound extensions cannot all be represented in a standard URI.
  // The existing import dialog also accepts sing-box JSON without losing them.
  if (node.rawOutbound) {
    return JSON.stringify({ outbounds: [{ ...node.rawOutbound, tag: node.name }] });
  }
  const query = new URLSearchParams({
    encryption: 'none',
    security: node.reality ? 'reality' : node.tls ? 'tls' : 'none',
    type: node.transport || 'tcp',
    fp: node.fingerprint || 'chrome',
  });
  for (const [key, value] of [
    ['flow', node.flow],
    ['sni', node.sni],
    ['pbk', node.publicKey],
    ['sid', node.shortId],
    ['path', node.transportPath],
    ['host', node.transportHost],
    ['alpn', node.alpn?.join(',')],
    ['mode', node.xhttpMode],
  ] as const) if (value) query.set(key, value);
  if (node.transport === 'grpc') {
    const service = node.transportHost || node.transportPath;
    if (service) query.set('serviceName', service);
  }
  if (node.insecure !== undefined) query.set('allowInsecure', node.insecure ? '1' : '0');
  if (node.xhttpExtraHeaders) query.set('extra', JSON.stringify({ headers: node.xhttpExtraHeaders }));
  const host = node.server.includes(':') && !node.server.startsWith('[') ? `[${node.server}]` : node.server;
  return `vless://${encodeURIComponent(node.uuid || '')}@${host}:${node.port}?${query}#${encodeURIComponent(node.name)}`;
}
