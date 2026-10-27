import { safeStorage } from 'electron';
import { Database } from '../db/Database';
import { SingBoxManager } from '../core/SingBoxManager';
import { ProfileRepository } from './ProfileRepository';
import { CorporatePolicy } from './CorporatePolicy';
import { CredentialVault } from './CredentialVault';
import { CorporateVpnManager } from './CorporateVpnManager';
import { VpnCoreProcess } from './VpnCoreProcess';

let instance: CorporateVpnManager | undefined;
let routingInitializer: ((isCurrent: () => boolean) => Promise<boolean>) | undefined;
export function setVpnRoutingInitializer(initializer: (isCurrent: () => boolean) => Promise<boolean>): void {
  routingInitializer = initializer;
}
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
        settings: () => {
          const settings = db.getSettings();
          const core = SingBoxManager.getInstance();
          if (core.getState() === 'running') {
            try { return { ...settings, tunEnabled: JSON.parse(core.getLiveConfig()).inbounds?.some((i: any) => i.type === 'tun') === true }; } catch { /* Use the saved mode until a live config is available. */ }
          }
          return settings;
        },
        applyRouting: async isCurrent => {
          if (!routingInitializer) throw new Error('ROUTING_PREPARE_FAILED');
          return routingInitializer(isCurrent);
        },
      },
    );
  }
  return instance;
}
export function existingCorporateVpn(): CorporateVpnManager | undefined {
  return instance;
}
