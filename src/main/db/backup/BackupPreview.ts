/**
 * BackupPreview.ts
 * Computes non-destructive dry-run preview comparing incoming backup data with existing database.
 */

import {
  ProxyNode,
  Subscription,
  RouteRule,
  AppRule,
  AppSettings,
  DnsConfig,
  BackupCategories,
  BackupPreviewResult,
  BackupPreviewItem,
} from '../../../types';
import { BackupFormatType } from './BackupValidator';
import { VpnProfile } from '../../../types/corporateVpn';
import { withoutSecrets } from '../../security/SecretFields';

export interface RawParsedBackupData {
  corporateVpn?: VpnProfile[];
  dns?: DnsConfig;
  format: BackupFormatType;
  nodes?: ProxyNode[];
  subscriptions?: Subscription[];
  rules?: RouteRule[];
  appRules?: AppRule[];
  settings?: Partial<AppSettings>;
  unparseableCount?: number;
  warnings?: string[];
}

export class BackupPreview {
  public static generatePreview(
    incoming: RawParsedBackupData,
    current: {
      nodes: ProxyNode[];
      subscriptions: Subscription[];
      rules: RouteRule[];
      appRules: AppRule[];
      settings: AppSettings;
      corporateVpn?: VpnProfile[];
    },
    requestedCategories?: Partial<BackupCategories>
  ): BackupPreviewResult {
    const categories: BackupCategories = {
      profiles: requestedCategories?.profiles ?? (!!incoming.nodes?.length || !!incoming.subscriptions?.length),
      rules: requestedCategories?.rules ?? (!!incoming.rules?.length || !!incoming.appRules?.length),
      settings: requestedCategories?.settings ?? (!!incoming.settings && Object.keys(incoming.settings).length > 0),
      ...((requestedCategories?.corporateVpn!==undefined||incoming.corporateVpn?.length)?{corporateVpn:requestedCategories?.corporateVpn??!!incoming.corporateVpn?.length}:{}),
    };

    const itemsPreview: BackupPreviewItem[] = [];
    const warnings: string[] = [...(incoming.warnings || [])];
    const corporateProfiles=categories.corporateVpn?incoming.corporateVpn||[]:[];
    let corporateAdd=0,corporateUpdate=0;
    for(const p of corporateProfiles){const match=current.corporateVpn?.some(c=>c.id===p.id||(c.protocol===p.protocol&&c.gateway.host===p.gateway.host&&c.gateway.port===p.gateway.port&&c.username===p.username));if(match)corporateUpdate++;else corporateAdd++;itemsPreview.push({type:'corporateVpn',name:p.name,action:match?'update':'add',detail:`${p.protocol} 配置；不包含密码和会话，导入后需应用公司分流`});}
    if(corporateProfiles.length)warnings.push('公司 VPN 仅导入非机密配置；密码和设备会话需重新输入。Android 备份不包含此分类。');

    // 1. Group / Subscription diffs
    let groupAdd = 0;
    let groupUpdate = 0;
    let groupSkip = 0;
    const incomingSubs = categories.profiles && incoming.subscriptions ? incoming.subscriptions : [];
    for (const sub of incomingSubs) {
      const match = current.subscriptions.find((s) => (sub.url && s.url === sub.url) || s.name === sub.name);
      if (match) {
        groupUpdate++;
        itemsPreview.push({
          type: 'group',
          name: sub.name,
          action: 'update',
          detail: `更新已有分组/订阅 (${sub.url ? 'URL 匹配' : '名称匹配'})`,
        });
      } else {
        groupAdd++;
        itemsPreview.push({
          type: 'group',
          name: sub.name,
          action: 'add',
          detail: sub.url ? `新增订阅: ${sub.url.substring(0, 40)}...` : '新增普通节点分组',
        });
      }
    }

    // 2. Node diffs
    let nodeAdd = 0;
    let nodeUpdate = 0;
    let nodeSkip = 0;
    const incomingNodes = categories.profiles && incoming.nodes ? incoming.nodes : [];
    for (const node of incomingNodes) {
      const match = current.nodes.find(
        (n) =>
          (node.server && n.server === node.server && n.port === node.port && n.type === node.type) ||
          (node.uuid && n.uuid === node.uuid) ||
          n.name === node.name
      );
      if (match) {
        nodeUpdate++;
        itemsPreview.push({
          type: 'node',
          name: node.name,
          action: 'update',
          detail: `更新节点 (${node.type.toUpperCase()} - ${node.server}:${node.port})`,
        });
      } else {
        nodeAdd++;
        itemsPreview.push({
          type: 'node',
          name: node.name,
          action: 'add',
          detail: `新增节点 (${node.type.toUpperCase()} - ${node.server}:${node.port})`,
        });
      }
    }

    // 3. Rule diffs
    let ruleAdd = 0;
    let ruleUpdate = 0;
    let ruleSkip = 0;
    const incomingRules = categories.rules && incoming.rules ? incoming.rules : [];
    for (const rule of incomingRules) {
      const match = current.rules.find((r) => r.name === rule.name);
      if (match) {
        ruleUpdate++;
        itemsPreview.push({
          type: 'rule',
          name: rule.name,
          action: 'update',
          detail: `更新路由规则 (出站: ${rule.outbound})`,
        });
      } else {
        ruleAdd++;
        itemsPreview.push({
          type: 'rule',
          name: rule.name,
          action: 'add',
          detail: `新增路由规则 (出站: ${rule.outbound})`,
        });
      }
    }

    // 4. AppRule diffs
    let appRuleAdd = 0;
    let appRuleUpdate = 0;
    let appRuleSkip = 0;
    const incomingAppRules = categories.rules && incoming.appRules ? incoming.appRules : [];
    for (const app of incomingAppRules) {
      const match = current.appRules.find((a) => a.exePath.toLowerCase() === app.exePath.toLowerCase());
      if (match) {
        appRuleUpdate++;
        itemsPreview.push({
          type: 'appRule',
          name: app.name,
          action: 'update',
          detail: `更新分应用代理规则 (${app.exePath})`,
        });
      } else {
        appRuleAdd++;
        itemsPreview.push({
          type: 'appRule',
          name: app.name,
          action: 'add',
          detail: `新增分应用代理规则 (${app.exePath})`,
        });
      }
    }

    // 5. Settings diff
    let settingsChanged = 0;
    const incomingSettings = categories.settings && incoming.settings ? incoming.settings : {};
    const settingKeys = Object.keys(incomingSettings) as (keyof AppSettings)[];
    for (const key of settingKeys) {
      if (incomingSettings[key] !== undefined && incomingSettings[key] !== current.settings[key]) {
        settingsChanged++;
        itemsPreview.push({
          type: 'setting',
          name: String(key),
          action: 'update',
          detail: `修改设置 ${String(key)}（敏感值不在预览中显示）`,
        });
      }
    }

    // Anti-wipe checks
    if (categories.profiles && current.nodes.length > 0 && incomingNodes.length === 0) {
      warnings.push('⚠️ 注意：当前本地存在节点配置，但选择导入的数据中节点数量为 0。系统已启用防误删保护，未导入空节点。');
    }
    if (categories.rules && current.rules.length > 0 && incomingRules.length === 0) {
      warnings.push('⚠️ 注意：当前本地存在路由规则，但选择导入的数据中规则数量为 0。系统已启用防误删保护，未清空现有规则。');
    }

    return {
      valid: true,
      format: incoming.format,
      categories,
      counts: {
        ...(categories.corporateVpn?{corporateVpn:{total:corporateProfiles.length,add:corporateAdd,update:corporateUpdate,skip:0}}:{}),
        groups: { total: incomingSubs.length, add: groupAdd, update: groupUpdate, skip: groupSkip },
        nodes: { total: incomingNodes.length, add: nodeAdd, update: nodeUpdate, skip: nodeSkip },
        rules: { total: incomingRules.length, add: ruleAdd, update: ruleUpdate, skip: ruleSkip },
        appRules: { total: incomingAppRules.length, add: appRuleAdd, update: appRuleUpdate, skip: appRuleSkip },
        settings: { total: settingKeys.length, changed: settingsChanged },
        unparseable: incoming.unparseableCount || 0,
      },
      itemsPreview,
      warnings,
    };
  }
}
