import { CredentialSecurity } from './CredentialSecurity';

const nodeFields = ['password', 'privateKey', 'presharedKey', 'authStr', 'obfs'];
const engineFields = ['password', 'l2tpPsk', 'privateKey', 'presharedKey'];
type Locked = (field: string) => void;

function fields<T>(value: T, names: string[], seal: boolean, locked?: Locked): T {
  const next = { ...value } as any;
  for (const name of names) if (typeof next[name] === 'string' && next[name]) {
    try { next[name] = seal ? CredentialSecurity.encrypt(next[name]) : CredentialSecurity.decrypt(next[name]); }
    catch (error) {
      if (seal || !locked || !CredentialSecurity.isLockedError(error)) throw error;
      locked(name); next[name] = '';
    }
  }
  return next;
}
export function storedNode<T>(node: T, seal: boolean, locked?: Locked): T {
  const next = fields(node, nodeFields, seal, locked) as any;
  // Keep configuration as ordinary JSON; only actual password/key values within
  // a raw outbound use the same protection as their structured equivalents.
  const walk = (value:any):any => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const result:any = {};
    for (const [key,item] of Object.entries(value)) {
      if (/^(password|private_key|pre_shared_key|auth_str)$/.test(key) && typeof item === 'string') result[key] = fields({[key]:item},[key],seal,locked)[key];
      else result[key] = walk(item);
    }
    return result;
  };
  if (next.rawOutbound && typeof next.rawOutbound === 'object') next.rawOutbound=walk(next.rawOutbound);
  return next;
}
export const storedEngine = <T>(profile: T, seal: boolean, locked?: Locked): T => fields(profile, engineFields, seal, locked);
export const storedSubscription = <T>(value: T, _seal: boolean, _locked?: Locked): T => ({...value});
export function storedSettings<T>(settings: T, seal: boolean, locked?: Locked): T {
  const next = fields(settings, ['inboundPass'], seal, locked) as any;
  if (next.webdav) next.webdav = fields(next.webdav, ['password', 'backupPassphrase'], seal, locked ? key => locked('webdav.' + key) : undefined);
  return next;
}

// Used only for shareable configuration. Full backups use authenticated encryption.
export function withoutSecrets<T>(value: T): T {
  const sensitive = /password|passwd|secret|token|cookie|authorization|private.?key|preshared.?key|pre.?shared.?key|l2tppsk|uuid|authstr|obfs|inboundpass|backuppassphrase|configtext|rawoutbound|xhttpextraheaders/i;
  const walk = (item: any, key = ''): any => {
    if (key === 'rememberPassword' || key === 'rememberSession') return false;
    if (sensitive.test(key)) return undefined;
    if (Array.isArray(item)) return item.map(v => walk(v));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k,v]) => [k, walk(v,k)]).filter(([,v]) => v !== undefined));
    if (key.toLowerCase() === 'url' && typeof item === 'string' && item) return ''; // Subscription URLs can carry opaque path credentials.
    return item;
  };
  return walk(value);
}
