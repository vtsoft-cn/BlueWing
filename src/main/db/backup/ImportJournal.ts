import fs from 'fs';
import path from 'path';
import { atomicJSON } from '../../vpn/ProfileRepository';

/** Crash recovery rolls profile storage and the main DB back together. No VPN vault is exported. */
export class ImportJournal {
  static begin(dir: string): void {
    const file = path.join(dir, 'backup-import-journal.json');
    if (fs.existsSync(file)) throw new Error('已有未恢复的导入事务');
    const entries = [
      'bluewing.json',
      'bluewing.json.bak',
      'vpn-profiles.json',
    ].map((name) => ({
      name,
      previous: fs.existsSync(path.join(dir, name))
        ? fs.readFileSync(path.join(dir, name), 'utf8')
        : null,
    }));
    atomicJSON(file, { version: 1, entries });
  }
  static commit(dir: string): void {
    fs.rmSync(path.join(dir, 'backup-import-journal.json'), { force: true });
  }
  static recover(dir: string): boolean {
    const file = path.join(dir, 'backup-import-journal.json');
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      data.version !== 1 ||
      !Array.isArray(data.entries) ||
      data.entries.length !== 3 ||
      new Set(data.entries.map((e: any) => e.name)).size !== 3
    )
      throw new Error('导入恢复记录损坏');
    for (const e of data.entries)
      if (
        !['bluewing.json', 'bluewing.json.bak', 'vpn-profiles.json'].includes(
          e.name,
        ) ||
        (e.previous !== null && typeof e.previous !== 'string')
      )
        throw new Error('导入恢复记录不正确');
    for (const e of data.entries) {
      const target = path.join(dir, e.name);
      if (e.previous === null) fs.rmSync(target, { force: true });
      else {
        const temp = target + '.recovery.tmp';
        fs.writeFileSync(temp, e.previous, { mode: 0o600 });
        fs.renameSync(temp, target);
      }
    }
    this.commit(dir);
    return true;
  }
}
