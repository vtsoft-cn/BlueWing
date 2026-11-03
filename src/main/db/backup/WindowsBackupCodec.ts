/**
 * WindowsBackupCodec.ts
 * Codec for BlueWing Connect Windows native backup format (.bluewingbackup).
 * Schema version 3 with backward-compatibility for schema versions 1 and 2.
 * Supports partial category export/import, including non-secret corporate profiles.
 */

import {
  BackupData,
  ProxyNode,
  Subscription,
  RouteRule,
  AppRule,
  DnsConfig,
  AppSettings,
  BackupCategories,
} from '../../../types';
import { VpnProfile } from '../../../types/corporateVpn';
import { withoutSecrets } from '../../security/SecretFields';
import { BackupProtection, protectBackup, unprotectBackup } from '../../security/BackupProtection';

export class WindowsBackupCodec {
  public static readonly CURRENT_SCHEMA_VERSION = 3;

  public static encode(
    nodes: ProxyNode[],
    subscriptions: Subscription[],
    rules: RouteRule[],
    appRules: AppRule[],
    dns: DnsConfig,
    settings: AppSettings,
    categories: BackupCategories = { profiles: true, rules: true, settings: true },
    corporateVpn?: VpnProfile[],
    protection: BackupProtection = {}
  ): string {
    const backup: Partial<BackupData> = {
      schema_version: this.CURRENT_SCHEMA_VERSION,
      app_version: '1.0.3',
      timestamp: Date.now(),
    };
    if(categories.corporateVpn&&corporateVpn)backup.corporateVpn=corporateVpn;

    if (categories.profiles) {
      backup.nodes = nodes;
      backup.subscriptions = subscriptions;
    }

    if (categories.rules) {
      backup.routing = {
        mode: settings.routingMode || 'rule',
        rules,
        appRules,
      };
    }

    if (categories.settings) {
      backup.dns = dns;
      backup.settings = settings;
      backup.appearance = {
        theme: settings.theme || 'system',
      };
      backup.webdav = settings.webdav;
    }

    if (protection.passphrase || protection.local) return protectBackup(JSON.stringify(backup), protection);
    return JSON.stringify({ ...withoutSecrets(backup), secretsOmitted: true }, null, 2);
  }

  public static decode(content: string, passphrase?: string): Partial<BackupData> {
    const parsed = JSON.parse(unprotectBackup(content, passphrase));
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON structure in backup');
    }

    if (!parsed.schema_version && !parsed.nodes && !parsed.subscriptions && !parsed.routing && !parsed.settings) {
      throw new Error('Not a valid BlueWing Connect backup file');
    }

    return parsed;
  }
}
