import path from 'path';

const prefix = '--bluewing-data-dir64=';

/** Scheduled-task/RunAs relaunches do not reliably preserve environment variables. */
export function dataDirArgument(dir: string): string {
  if (!path.isAbsolute(dir))
    throw new Error('BlueWing data directory must be absolute');
  return prefix + Buffer.from(path.resolve(dir), 'utf8').toString('base64url');
}

export function launchDataDir(
  argv: string[],
  environment?: string,
): string | undefined {
  const values = argv.filter((arg) => arg.startsWith(prefix));
  if (values.length > 1)
    throw new Error('Duplicate BlueWing data directory argument');
  let value = environment?.trim();
  if (values.length) {
    const encoded = values[0].slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded))
      throw new Error('Invalid BlueWing data directory argument');
    value = Buffer.from(encoded, 'base64url').toString('utf8');
  }
  if (!value) return undefined;
  if (!path.isAbsolute(value) || value.includes('\0'))
    throw new Error('BlueWing data directory must be absolute');
  return path.resolve(value);
}
