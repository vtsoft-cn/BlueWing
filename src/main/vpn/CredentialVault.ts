import fs from 'fs';
import path from 'path';
import { atomicJSON } from './ProfileRepository';

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export class CredentialVault {
  private data: Record<string, string> = {};
  private file: string;
  constructor(
    dir: string,
    private provider: EncryptionProvider,
  ) {
    this.file = path.join(dir, 'vpn-vault.json');
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !this.data ||
        typeof this.data !== 'object' ||
        Array.isArray(this.data)
      )
        throw new Error('CREDENTIAL_STORE_LOCKED');
    }
  }
  available(): boolean {
    return (
      this.provider.isEncryptionAvailable() &&
      this.provider.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  set(key: string, value: string): void {
    if (!this.available())
      throw new Error(
        'CREDENTIAL_STORE_LOCKED：系统加密不可用，请使用不记住密码模式',
      );
    const cipher = this.provider.encryptString(value);
    const next = { ...this.data, [key]: `dpapi:${cipher.toString('base64')}` };
    atomicJSON(this.file, next);
    this.data = next;
  }
  get(key: string): string | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (!this.available() || !value.startsWith('dpapi:'))
      throw new Error('CREDENTIAL_STORE_LOCKED');
    try {
      return this.provider.decryptString(Buffer.from(value.slice(6), 'base64'));
    } catch {
      throw new Error('CREDENTIAL_STORE_LOCKED');
    }
  }
  has(key: string): boolean {
    return (
      typeof this.data[key] === 'string' && this.data[key].startsWith('dpapi:')
    );
  }
  remove(prefix: string): void {
    const next = { ...this.data };
    for (const key of Object.keys(next))
      if (key.startsWith(prefix)) delete next[key];
    atomicJSON(this.file, next);
    this.data = next;
  }
}
