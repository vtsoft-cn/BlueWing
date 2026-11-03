/**
 * CredentialSecurity: Secure storage for passwords, tokens, and sensitive keys.
 * Uses Electron's safeStorage (backed by Windows DPAPI) when available,
 * Fails closed when OS encryption is unavailable. Tests inject a provider explicitly.
 */
export class CredentialSecurity {
  private static safeStorageModule: any = null;
  private static initialized = false;
  public static useProvider(provider: any): void {
    this.initialized = true;
    this.safeStorageModule = provider;
  }
  public static isLockedError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('CREDENTIAL_STORE_LOCKED');
  }
  public static available(): boolean {
    try {
      const storage = this.getSafeStorage();
      return !!storage?.isEncryptionAvailable?.() && storage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  private static getSafeStorage(): any {
    if (!this.initialized) {
      this.initialized = true;
      if (!process.versions.electron) return null;
      try {
        // Dynamic require so it doesn't fail when running in pure Node.js test environment
        const electron = require('electron');
        this.safeStorageModule = electron.safeStorage || null;
      } catch {
        this.safeStorageModule = null;
      }
    }
    return this.safeStorageModule;
  }

  /**
   * Encrypts a sensitive string. Returns an encrypted token string.
   */
  public static encrypt(plainText: string): string {
    if (!plainText) return '';
    const storage = this.getSafeStorage();
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text') {
      try {
        const buffer = storage.encryptString(plainText);
        return `enc:dpapi:${buffer.toString('base64')}`;
      } catch { throw new Error('CREDENTIAL_STORE_LOCKED：系统加密失败，未保存敏感信息'); }
    }
    throw new Error('CREDENTIAL_STORE_LOCKED：系统加密不可用，未保存敏感信息');
  }

  /**
   * Decrypts an encrypted token string. If the string is not encrypted (legacy plain text), returns it as-is.
   */
  public static decrypt(cipherText: string): string {
    if (!cipherText) return '';
    if (!cipherText.startsWith('enc:')) {
      // Legacy plain text value, return directly
      return cipherText;
    }

    if (cipherText.startsWith('enc:dpapi:')) {
      const b64 = cipherText.slice('enc:dpapi:'.length);
      const storage = this.getSafeStorage();
      if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(b64, 'base64');
          return storage.decryptString(buffer);
        } catch (err) {
          throw new Error('CREDENTIAL_STORE_LOCKED：无法解密此用户的凭据');
        }
      } else {
        throw new Error('CREDENTIAL_STORE_LOCKED：系统加密不可用');
      }
    }

    if (cipherText.startsWith('enc:b64:')) {
      const b64 = cipherText.slice('enc:b64:'.length);
      try {
        return Buffer.from(b64, 'base64').toString('utf8');
      } catch {
        return '';
      }
    }

    return cipherText;
  }

  /**
   * Checks whether a value is already encrypted.
   */
  public static isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith('enc:');
  }
}
