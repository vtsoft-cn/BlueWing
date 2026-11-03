import path from 'path';
import fs from 'fs';
import { ProxyNode, Subscription, RouteRule, AppRule, DnsConfig, AppSettings, VpnProfile } from '../../types';
import { CredentialSecurity } from '../security/CredentialSecurity';
import { storedNode, storedEngine, storedSubscription, storedSettings } from '../security/SecretFields';
import { ImportJournal } from './backup/ImportJournal';

export class Database {
  public static readonly CURRENT_SCHEMA_VERSION = 3;
  private static instance: Database | null = null;
  private static customDir: string | null = null;

  private dataDir: string;
  private dbPath: string;

  private activeNodeId: string = '';
  private nodes: ProxyNode[] = [];
  private subscriptions: Subscription[] = [];
  private rules: RouteRule[] = [];
  private appRules: AppRule[] = [];
  private dns: DnsConfig;
  private settings: AppSettings;
  private vpnProfiles: VpnProfile[] = [];

  private saveTimer: NodeJS.Timeout | null = null;
  private lockedRecords = 0;
  private lockedSettings: string[] = [];
  private sessionOnly = false;
  private pendingChanges = false;
  private reconfigureRecords = 0;

  public credentialStatus() {
    return {
      mode: this.lockedRecords || this.lockedSettings.length ? 'locked' as const : this.sessionOnly ? 'session' as const : this.reconfigureRecords ? 'reconfigure' as const : 'normal' as const,
      lockedRecords: this.lockedRecords, lockedSettings: [...this.lockedSettings], pendingChanges: this.pendingChanges,
      message: this.lockedRecords || this.lockedSettings.length
        ? '已保存的密码暂时无法读取，原始配置已保留。软件可继续使用，本次修改仅在会话中生效。'
        : this.sessionOnly ? '系统加密暂不可用，本次修改仅在当前会话使用，尚未保存。原始配置保持不变。'
        : this.reconfigureRecords ? '检测到不再支持的旧加密配置，已跳过这些记录并保留原文件，请重新添加配置。密码和密钥仍使用安全存储。' : '',
    };
  }


  private constructor(customDir?: string) {
    if (customDir) {
      this.dataDir = customDir;
    } else {
      // 便携模式:主进程设置 BLUEWING_DATA_DIR(exe 同级 data/);未设置时回退 %APPDATA%\BlueWingConnect
      const appData =
        process.env.BLUEWING_DATA_DIR ||
        path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'), 'BlueWingConnect');
      this.dataDir = appData;
    }

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.dbPath = path.join(this.dataDir, 'bluewing.json');

    // Default DNS
    this.dns = {
      mode: 'standard',
      remoteDns: 'https://1.1.1.1/dns-query',
      directDns: '223.5.5.5',
      fakeIpRange: '198.18.0.0/15',
      enableDnsRouting: true,
      hosts: [],
      servers: [
        { id: '1', tag: 'remote-dns', address: 'https://1.1.1.1/dns-query', detour: 'proxy' },
        { id: '2', tag: 'direct-dns', address: '223.5.5.5', detour: 'direct' },
      ],
    };

    // Default Settings
    this.settings = {
      theme: 'system',
      language: 'zh-CN',
      startOnBoot: false,
      startMinimized: false,
      autoConnectOnLaunch: false,
      closeToTray: true,

      mixedPort: 2080,
      allowLan: false,
      inboundAuth: false,
      systemProxyEnabled: true,
      systemProxyBypassLan: true,
      customBypassList: '',

      tunEnabled: false,
      tunMtu: 9000,
      tunStack: 'native',
      tunAutoRoute: true,
      tunStrictRoute: false,
      tunDnsHijack: true,
      tunIPv6: false,
      tunEndpointIndependentNat: true,

      dnsCache: true,
      dnsOptimistic: true,

      routingMode: 'rule',
      logLevel: 'info',
      clashApiEnabled: true,
      clashApiPort: 9090,

      testUrl: 'http://cp.cloudflare.com/generate_204',
      testTimeoutMs: 5000,
      testConcurrent: 10,

      webdav: {
        serverUrl: '',
        username: '',
        password: '',
        remotePath: 'BlueWingConnect',
        autoSync: false,
      },
    };

    // Default Route Rules
    this.rules = [
      {
        id: 'rule-lan',
        name: '局域网直连 (Private IPs)',
        enabled: true,
        ip: ['geoip:private'],
        outbound: 'direct',
      },
      {
        id: 'rule-cn-domains',
        name: '国内域名直连 (GeoSite CN)',
        enabled: true,
        domains: ['geosite:cn'],
        outbound: 'direct',
      },
      {
        id: 'rule-cn-ips',
        name: '国内 IP 直连 (GeoIP CN)',
        enabled: true,
        ip: ['geoip:cn'],
        outbound: 'direct',
      },
      {
        id: 'rule-adblock',
        name: '广告与恶意域名拦截 (GeoSite Category Ads)',
        enabled: true,
        domains: ['geosite:category-ads-all'],
        outbound: 'block',
      },
    ];

    // Default App Rules
    this.appRules = [
      { id: 'app-chrome', name: 'Google Chrome', exePath: 'chrome.exe', action: 'proxy', enabled: true },
      { id: 'app-edge', name: 'Microsoft Edge', exePath: 'msedge.exe', action: 'proxy', enabled: true },
      { id: 'app-telegram', name: 'Telegram Desktop', exePath: 'Telegram.exe', action: 'proxy', enabled: true },
      { id: 'app-discord', name: 'Discord', exePath: 'Discord.exe', action: 'proxy', enabled: true },
      { id: 'app-steam', name: 'Steam Client', exePath: 'steam.exe', action: 'direct', enabled: true },
    ];

    this.nodes = [];
    this.activeNodeId = '';

    ImportJournal.recover(this.dataDir);
    this.load();
  }

  public static getInstance(customDir?: string): Database {
    if (customDir && customDir !== Database.customDir) {
      Database.customDir = customDir;
      Database.instance = new Database(customDir);
      return Database.instance;
    }
    if (!Database.instance) {
      Database.instance = new Database(Database.customDir || undefined);
    }
    return Database.instance;
  }

  public static resetInstance(): void {
    if (Database.instance && Database.instance.saveTimer) {
      clearTimeout(Database.instance.saveTimer);
      Database.instance.saveTimer = null;
    }
    Database.instance = null;
    Database.customDir = null;
  }

  /** 数据目录唯一事实来源:备份/日志/核心等模块一律从这里取,禁止各自回退到 %APPDATA% */
  public getDataDir(): string {
    return this.dataDir;
  }
  public flushPending(): void { if (this.pendingChanges || this.saveTimer) this.flush(); }
  public reloadFromDisk():void {if(this.saveTimer){clearTimeout(this.saveTimer);this.saveTimer=null;}this.load();}

  public replaceForImport(next: { nodes: ProxyNode[]; subscriptions: Subscription[]; rules: RouteRule[]; appRules: AppRule[]; dns: DnsConfig; settings: AppSettings; activeNodeId: string }): void {
    const previous = { nodes: this.nodes, subscriptions: this.subscriptions, rules: this.rules, appRules: this.appRules, dns: this.dns, settings: this.settings, activeNodeId: this.activeNodeId };
    Object.assign(this, next);
    try { this.flush(); }
    catch (error) { Object.assign(this, previous); throw error; }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        // Guard against zero-byte corrupted files
        const stat = fs.statSync(this.dbPath);
        if (stat.size === 0) {
          console.warn('Database file is 0 bytes, recovering from backup...');
          this.recoverFromBackup();
          return;
        }

        let raw = '';
        try {
          raw = fs.readFileSync(this.dbPath, 'utf8');
        } catch (readErr: any) {
          console.error('Failed to read database file:', readErr);
          this.recoverFromBackup();
          return;
        }

        try {
          const data = JSON.parse(raw);
          this.applyData(data);

          // Auto-migrate schema if version is older
          if (!data.schemaVersion || data.schemaVersion < Database.CURRENT_SCHEMA_VERSION) {
            console.log('Legacy configuration loaded; storage format will update on the next explicit save');
            // Opening a configuration is read-only. Upgrade encryption only on
            // a real save, after Electron and its OS credential store are ready.
          }
        } catch (jsonErr: any) {
          if (String(jsonErr?.message).includes('CREDENTIAL_STORE_LOCKED')) throw jsonErr;
          console.error('Database JSON parse error, isolating corrupt file:', jsonErr);
          const corruptPath = `${this.dbPath}.corrupted.${Date.now()}`;
          try {
            fs.copyFileSync(this.dbPath, corruptPath);
          } catch {}
          this.recoverFromBackup();
        }
      } else {
        this.flush();
      }
    } catch (e) {
      console.error('Failed to load database:', e);
      if (String((e as Error)?.message).includes('CREDENTIAL_STORE_LOCKED')) throw e;
    }
  }

  private applyData(data: any, tolerateLocked = true): void {
    let lockedRecords = 0;
    let reconfigureRecords = 0;
    const ordinary = (value:any, keys:string[]):boolean => {
      if (keys.some(key=>typeof value?.[key] === 'string' && value[key].startsWith('enc:'))) { reconfigureRecords++; return false; }
      return true;
    };
    const lockedSettings: string[] = [];
    const decode = <T>(value: T, fn: (value:T, seal:boolean, onLocked?:(field:string)=>void)=>T): T => {
      let unavailable = false;
      const next = fn(value, false, tolerateLocked ? () => { unavailable = true; } : undefined);
      if (unavailable) { lockedRecords++; return { ...next, credentialsUnavailable: true }; }
      return next;
    };
    // Stage all decryption before replacing any live data, including strict retry.
    const nodes = Array.isArray(data.nodes) ? data.nodes.filter((n:any)=>ordinary(n,['uuid','rawOutbound','xhttpExtraHeaders'])).map((n:ProxyNode)=>decode(n, storedNode)).filter((n:any)=>n?.id) : this.nodes;
    const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions.filter((s:any)=>ordinary(s,['url'])).map((s:Subscription)=>decode(s, storedSubscription)).filter((s:any)=>s?.id) : this.subscriptions;
    const vpnProfiles = Array.isArray(data.vpnProfiles) ? data.vpnProfiles.filter((p:any)=>ordinary(p,['configText'])).map((p:VpnProfile)=>decode(p,storedEngine)).filter((p:any)=>p?.id&&p.server) : this.vpnProfiles;
    const settings = data.settings && typeof data.settings === 'object'
      ? {...this.settings,...storedSettings(data.settings,false,tolerateLocked ? key=>lockedSettings.push(key) : undefined)} : this.settings;
    this.nodes = nodes; this.subscriptions = subscriptions; this.vpnProfiles = vpnProfiles; this.settings = settings;
    this.lockedRecords = lockedRecords; this.lockedSettings = lockedSettings;
    this.reconfigureRecords = reconfigureRecords;
    this.sessionOnly = !!lockedRecords || !!lockedSettings.length; this.pendingChanges = false;
    if (Array.isArray(data.rules)) this.rules = data.rules.filter((r:any)=>r?.id);
    if (Array.isArray(data.appRules)) this.appRules = data.appRules.filter((r:any)=>r?.id);
    if (data.dns && typeof data.dns === 'object') this.dns = {...this.dns,...data.dns};
    if (typeof data.activeNodeId === 'string') this.activeNodeId = data.activeNodeId;
  }

  private recoverFromBackup(): void {
    const bakPath = `${this.dbPath}.bak`;
    if (fs.existsSync(bakPath)) {
      try {
        const raw = fs.readFileSync(bakPath, 'utf8');
        const data = JSON.parse(raw);
        this.applyData(data);
        console.log('Successfully recovered database from .bak backup');
        this.flush();
        return;
      } catch (e) {
        if (String((e as Error)?.message).includes('CREDENTIAL_STORE_LOCKED')) throw e;
        console.error('Failed to recover from .bak backup:', e);
      }
    }
    // If no backup exists or backup corrupted, initialize with default empty state
    this.flush();
  }

  /**
   * Saves database state. If debounceMs > 0, coalesces multiple writes to prevent disk I/O thrashing.
   */
  public save(debounceMs = 0): void {
    if (debounceMs > 0) {
     
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
      }
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        try { this.flush(); } catch { console.error('Deferred configuration save failed; existing file retained'); }
      }, debounceMs);
    } else {
      this.flush();
    }
  }

  /**
   * High-frequency debounced save (default 300ms window).
   */
  public saveDebounced(debounceMs = 300): void {
    this.save(debounceMs);
  }

  /**
   * Immediately flushes any pending changes to disk atomically.
   */
  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.lockedRecords || this.lockedSettings.length) {
      this.pendingChanges = true;
      return; // Never replace unreadable ciphertext with empty UI placeholders.
    }

    const tempPath = `${this.dbPath}.tmp`;
    const bakPath = `${this.dbPath}.bak`;
    try {
      // Encrypt sensitive fields on disk
      const diskSettings = storedSettings(this.settings, true);

      const data = {
        schemaVersion: Database.CURRENT_SCHEMA_VERSION,
        activeNodeId: this.activeNodeId,
        nodes: this.nodes.map(n => storedNode(n, true)),
        subscriptions: this.subscriptions.map(s => storedSubscription(s, true)),
        rules: this.rules,
        appRules: this.appRules,
        dns: this.dns,
        settings: diskSettings,
        vpnProfiles: this.vpnProfiles.map(p => storedEngine(p, true)),
      };

      const jsonStr = JSON.stringify(data, null, 2);

      // 1. Atomic write to temporary file
      fs.writeFileSync(tempPath, jsonStr, 'utf8');

      // 2. Create/update backup file from currently working dbPath
      if (fs.existsSync(this.dbPath)) {
        try {
          const previous = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
          if (Array.isArray(previous.nodes)) previous.nodes = previous.nodes.map((n: ProxyNode) => storedNode(storedNode(n, false), true));
          if (Array.isArray(previous.subscriptions)) previous.subscriptions = previous.subscriptions.map((s: Subscription) => storedSubscription(storedSubscription(s, false), true));
          if (Array.isArray(previous.vpnProfiles)) previous.vpnProfiles = previous.vpnProfiles.map((p: VpnProfile) => storedEngine(storedEngine(p, false), true));
          if (previous.settings) previous.settings = storedSettings(storedSettings(previous.settings, false), true);
          const backupTemp = `${bakPath}.tmp`;
          fs.writeFileSync(backupTemp, JSON.stringify(previous), { mode: 0o600 });
          fs.renameSync(backupTemp, bakPath);
        } catch (error) { if (String((error as Error)?.message).includes('CREDENTIAL_STORE_LOCKED')) throw error; }
      }

      // 3. Rename temp file to target file
      fs.renameSync(tempPath, this.dbPath);
      this.sessionOnly = false; this.pendingChanges = false;
      this.reconfigureRecords = 0;
     
    } catch (e) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      if (CredentialSecurity.isLockedError(e)) {
        this.sessionOnly = true; this.pendingChanges = true;
        console.warn('Credential storage temporarily unavailable; configuration kept in memory, original file retained');
        return;
      }
      console.error('Failed to save database atomically:', e);
      throw e;
    }
  }

  public getActiveNodeId(): string {
    return this.activeNodeId;
  }

  public setActiveNodeId(id: string): void {
    this.activeNodeId = id;
    this.save();
  }

  public getNodes(): ProxyNode[] {
    return this.nodes;
  }

  public saveNodes(nodes: ProxyNode[]): void {
    this.nodes = nodes;
    if (this.nodes.length === 0) {
      this.activeNodeId = '';
    } else if (!this.nodes.some((n) => n.id === this.activeNodeId)) {
      this.activeNodeId = this.nodes[0].id;
    }
    this.save();
  }

  // ---- 定向节点操作(渲染层不再全量回传列表,主进程为唯一事实源) ----

  public addNode(node: ProxyNode): void {
    this.nodes.push(node);
    // 空列表首节点即活跃,与 saveNodes 回落语义一致
    if (!this.activeNodeId) this.activeNodeId = node.id;
    this.save();
  }

  /** 编辑节点:同 id 整体替换 */
  public updateNode(node: ProxyNode): boolean {
    const idx = this.nodes.findIndex((n) => n.id === node.id);
    if (idx < 0) return false;
    this.nodes[idx] = { ...node, id: this.nodes[idx].id };
    this.save();
    return true;
  }

  /** 字段级补丁(测速/星标等),id 不可变;高频调用走去抖落盘 */
  public updateNodeFields(id: string, patch: Partial<ProxyNode>): boolean {
    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx < 0) return false;
    this.nodes[idx] = { ...this.nodes[idx], ...patch, id };
    this.saveDebounced();
    return true;
  }

  public bulkUpdateNodeFields(patches: { id: string; patch: Partial<ProxyNode> }[]): number {
    if (patches.length === 0) return 0;
    const map = new Map(patches.map((p) => [p.id, p.patch]));
    let applied = 0;
    this.nodes = this.nodes.map((node) => {
      const patch = map.get(node.id);
      if (!patch) return node;
      applied++;
      return { ...node, ...patch, id: node.id };
    });
    if (applied > 0) this.saveDebounced();
    return applied;
  }

  public deleteNode(id: string): boolean {
    if (!this.nodes.some((n) => n.id === id)) return false;
    this.saveNodes(this.nodes.filter((n) => n.id !== id));
    return true;
  }

  public getSubscriptions(): Subscription[] {
    return this.subscriptions;
  }

  public saveSubscriptions(subs: Subscription[]): void {
    this.subscriptions = subs;
    this.save();
  }

  /**
   * 级联删除订阅及其全部节点(节点以 groupId === 订阅 id 关联)。
   * 单次落盘;活跃节点被删时由 saveNodes 语义回落(列表清空归空,否则取首节点)。
   */
  public deleteSubscriptionCascade(id: string): boolean {
    if (!this.subscriptions.some((s) => s.id === id)) return false;
    this.subscriptions = this.subscriptions.filter((s) => s.id !== id);
    this.saveNodes(this.nodes.filter((n) => n.groupId !== id));
    return true;
  }

  public getRules(): RouteRule[] {
    return this.rules;
  }

  public saveRules(rules: RouteRule[]): void {
    this.rules = rules;
    this.save();
  }

  public getAppRules(): AppRule[] {
    return this.appRules;
  }

  public saveAppRules(appRules: AppRule[]): void {
    this.appRules = appRules;
    this.save();
  }

  // ---- VPN 账号(应用内直接登录第三方 VPN) ----

  public getVpnProfiles(): VpnProfile[] {
    return this.vpnProfiles;
  }

  /** 新增或按 id 整体替换 */
  public upsertVpnProfile(profile: VpnProfile): void {
    const idx = this.vpnProfiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) this.vpnProfiles[idx] = { ...profile, id: this.vpnProfiles[idx].id };
    else this.vpnProfiles.push(profile);
    this.save();
  }

  public deleteVpnProfile(id: string): boolean {
    if (!this.vpnProfiles.some((p) => p.id === id)) return false;
    this.vpnProfiles = this.vpnProfiles.filter((p) => p.id !== id);
    this.save();
    return true;
  }

  public getDns(): DnsConfig {
    return this.dns;
  }

  public saveDns(dns: DnsConfig): void {
    // 旧版本数据可能没有 hosts 字段,统一归一化避免 undefined 下发
    this.dns = { ...dns, hosts: Array.isArray(dns.hosts) ? dns.hosts : [] };
    this.save();
  }

  public getSettings(): AppSettings {
    return this.settings;
  }

  public saveSettings(settings: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.save();
  }

  public resetSettings(): AppSettings {
    this.settings = {
      theme: 'system',
      language: 'zh-CN',
      startOnBoot: false,
      startMinimized: false,
      autoConnectOnLaunch: false,
      closeToTray: true,

      mixedPort: 2080,
      allowLan: false,
      inboundAuth: false,
      systemProxyEnabled: true,
      systemProxyBypassLan: true,
      customBypassList: '',

      tunEnabled: false,
      tunMtu: 9000,
      tunStack: 'native',
      tunAutoRoute: true,
      tunStrictRoute: false,
      tunDnsHijack: true,
      tunIPv6: false,
      tunEndpointIndependentNat: true,

      dnsCache: true,
      dnsOptimistic: true,

      routingMode: 'rule',
      logLevel: 'info',
      clashApiEnabled: true,
      clashApiPort: 9090,

      testUrl: 'http://cp.cloudflare.com/generate_204',
      testTimeoutMs: 5000,
      testConcurrent: 10,

      webdav: {
        serverUrl: '',
        username: '',
        password: '',
        remotePath: 'BlueWingConnect',
        autoSync: false,
      },
    };
    this.save();
    return this.settings;
  }
}
