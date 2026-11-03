import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { CredentialSecurity } from './CredentialSecurity';

export interface BackupProtection { passphrase?: string; local?: boolean }
const MAX = 32 * 1024 * 1024;
const aad = Buffer.from('BlueWing backup v1');
function password(value?: string): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024)
    throw new Error('备份口令需要 12～1024 个字符');
  return value;
}
export function protectBackup(content: string, options: BackupProtection): string {
  if (Buffer.byteLength(content) > MAX) throw new Error('备份超过 32 MiB');
  if (options.local) return JSON.stringify({ format: 'bluewing-local-v1', ciphertext: CredentialSecurity.encrypt(content) });
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(password(options.passphrase), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    return JSON.stringify({ format: 'bluewing-encrypted-v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  } finally { key.fill(0); }
}
export function unprotectBackup(content: string, passphrase?: string): string {
  if (Buffer.byteLength(content) > 46 * 1024 * 1024) throw new Error('备份文件过大');
  let data: any;
  try { data = JSON.parse(content); } catch { return content; }
  if (data?.format === 'bluewing-local-v1') {
    if (typeof data.ciphertext !== 'string' || !data.ciphertext.startsWith('enc:dpapi:')) throw new Error('本机备份格式不正确');
    return CredentialSecurity.decrypt(data.ciphertext);
  }
  if (data?.format !== 'bluewing-encrypted-v1') return content;
  const bytes = (name: string, length?: number): Buffer => {
    const value = data[name];
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('加密备份格式不正确');
    const b = Buffer.from(value, 'base64');
    if ((length && b.length !== length) || b.length > MAX || b.toString('base64') !== value) throw new Error('加密备份格式不正确');
    return b;
  };
  const salt = bytes('salt', 16), iv = bytes('iv', 12), tag = bytes('tag', 16), ciphertext = bytes('ciphertext');
  const key = scryptSync(password(passphrase), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
  } catch { throw new Error('备份口令不正确或文件已损坏'); }
  finally { key.fill(0); }
}
