import { safeStorage } from 'electron';
import { Database } from '../db/Database';
import { SingBoxManager } from '../core/SingBoxManager';
import { ProfileRepository } from './ProfileRepository';
import { CorporatePolicy } from './CorporatePolicy';
import { CredentialVault } from './CredentialVault';
import { CorporateVpnManager } from './CorporateVpnManager';
import { VpnCoreProcess } from './VpnCoreProcess';

let instance: CorporateVpnManager | undefined;
export function getCorporateVpn(): CorporateVpnManager {
  if (!instance) {
    const db = Database.getInstance(),
      dir = db.getDataDir();
    instance = new CorporateVpnManager(
      new ProfileRepository(dir),
      new CorporatePolicy(dir),
      new CredentialVault(dir, safeStorage),
      new VpnCoreProcess(),
      {
        running: () => SingBoxManager.getInstance().getState() === 'running',
        pid: () => SingBoxManager.getInstance().getPid(),
        settings: () => db.getSettings(),
      },
    );
  }
  return instance;
}
export function existingCorporateVpn(): CorporateVpnManager | undefined {
  return instance;
}
