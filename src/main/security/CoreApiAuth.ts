import { randomBytes } from 'crypto';

// Owned by this application process, never exported in settings or backups.
const token = randomBytes(32).toString('hex');
export const coreApiSecret = (): string => token;
export const coreApiHeaders = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
