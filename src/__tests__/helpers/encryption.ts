// Explicit per-process test provider. Production never falls back to this.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CredentialSecurity } from '../../main/security/CredentialSecurity';
const key = randomBytes(32);
export const testEncryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(value: Buffer) {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
CredentialSecurity.useProvider(testEncryption);
