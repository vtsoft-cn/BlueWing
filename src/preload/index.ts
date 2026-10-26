import { contextBridge, ipcRenderer } from 'electron';
import { ProxyNode, Subscription, RouteRule, AppRule, DnsConfig, AppSettings, LogEntry, LatencyResult, VpnProfile as EngineVpnProfile, VpnRuntimeInfo } from '../types';
import { CorporateVpnAPI, VpnProfile, VpnState } from '../types/corporateVpn';

export const api = {
  corporateVpn: {
    snapshot: () => ipcRenderer.invoke('vpn:snapshot'),
    save: (profile: VpnProfile) => ipcRenderer.invoke('vpn:save', profile),
    remove: (id: string) => ipcRenderer.invoke('vpn:remove', id),
    connect: (id: string, password: string) => ipcRenderer.invoke('evpn:connect', id, password),
    disconnect: () => ipcRenderer.invoke('evpn:disconnect'),
    discover: (id: string) => ipcRenderer.invoke('vpn:discover', id),
    certificate: (id: string) => ipcRenderer.invoke('vpn:certificate', id),
    respond: (id: string, generation: number, value: string) => ipcRenderer.invoke('vpn:respond', id, generation, value),
    clearCredentials: (id: string) => ipcRenderer.invoke('vpn:clearCredentials', id),
    savePassword: (id: string, password: string, remember: boolean) => ipcRenderer.invoke('vpn:savePassword', id, password, remember),
    apply: () => ipcRenderer.invoke('vpn:apply'),
    onState: (callback: (state: VpnState) => void) => {
      const handler = (_: unknown, state: VpnState) => callback(state);
      ipcRenderer.on('evpn:state', handler);
      return () => ipcRenderer.removeListener('evpn:state', handler);
    },
  } satisfies CorporateVpnAPI,
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    // 页头手动拖动(绕开 Chromium 滚动后 app-region 失效缺陷,详见主进程注释)
    beginDrag: () => ipcRenderer.send('window:drag-begin'),
    endDrag: () => ipcRenderer.send('window:drag-end'),
  },

  // Sing-box core control
  core: {
    start: () => ipcRenderer.invoke('core:start'),
    stop: () => ipcRenderer.invoke('core:stop'),
    restart: () => ipcRenderer.invoke('core:restart'),
    getState: () => ipcRenderer.invoke('core:getState'),
    getVersion: () => ipcRenderer.invoke('core:getVersion'),
    getLiveConfig: (): Promise<string> => ipcRenderer.invoke('core:getLiveConfig'),
    validateConfig: () => ipcRenderer.invoke('core:validateConfig'),
    onStateChange: (callback: (state: string) => void) => {
      const sub = (_: any, state: string) => callback(state);
      ipcRenderer.on('core:stateChange', sub);
      return () => ipcRenderer.removeListener('core:stateChange', sub);
    },
    onLog: (callback: (log: LogEntry) => void) => {
      const sub = (_: any, log: any) => callback(log);
      ipcRenderer.on('log:added', sub);
      return () => ipcRenderer.removeListener('log:added', sub);
    },
    onTraffic: (callback: (traffic: any) => void) => {
      const sub = (_: any, t: any) => callback(t);
      ipcRenderer.on('core:traffic', sub);
      return () => ipcRenderer.removeListener('core:traffic', sub);
    },
  },

  // Nodes management
  nodes: {
    getAll: (): Promise<ProxyNode[]> => ipcRenderer.invoke('nodes:getAll'),
    /** 字段级补丁(测速/星标等),id 不可变 */
    update: (id: string, patch: Partial<ProxyNode>) =>
      ipcRenderer.invoke('nodes:updateFields', id, patch),
    /** 批量字段补丁(批量测速) */
    bulkUpdate: (patches: { id: string; patch: Partial<ProxyNode> }[]) =>
      ipcRenderer.invoke('nodes:bulkUpdateFields', patches),
    /** 编辑节点:同 id 整体替换 */
    replace: (node: ProxyNode) => ipcRenderer.invoke('nodes:updateFull', node),
    add: (node: ProxyNode) => ipcRenderer.invoke('nodes:add', node),
    remove: (id: string) => ipcRenderer.invoke('nodes:delete', id),
    getActiveId: (): Promise<string> => ipcRenderer.invoke('nodes:getActiveId'),
    setActiveId: (id: string) => ipcRenderer.invoke('nodes:setActiveId', id),
    selectDirect: (): Promise<boolean> => ipcRenderer.invoke('nodes:selectDirect'),
    ping: (host: string, port: number) => ipcRenderer.invoke('nodes:ping', host, port),
    batchPing: (nodes: { id: string; host: string; port: number }[]) =>
      ipcRenderer.invoke('nodes:batchPing', nodes),
    // 托盘菜单切换节点后同步 UI,避免界面显示过期节点
    onNodeChanged: (callback: (id: string) => void) => {
      const sub = (_: any, id: string) => callback(id);
      ipcRenderer.on('node:changed', sub);
      return () => ipcRenderer.removeListener('node:changed', sub);
    },
    // 主进程侧节点列表变更(订阅更新/备份导入/增删改)后刷新 UI,渲染层不再持有列表事实源
    onNodesChanged: (callback: (nodes: ProxyNode[]) => void) => {
      const sub = (_: any, nodes: ProxyNode[]) => callback(nodes);
      ipcRenderer.on('nodes:changed', sub);
      return () => ipcRenderer.removeListener('nodes:changed', sub);
    },
  },

  // Subscriptions
  subscriptions: {
    getAll: (): Promise<Subscription[]> => ipcRenderer.invoke('subs:getAll'),
    save: (subs: Subscription[]) => ipcRenderer.invoke('subs:save', subs),
    delete: (id: string) => ipcRenderer.invoke('subs:delete', id),
    update: (id: string) => ipcRenderer.invoke('subs:update', id),
    // 订阅更新(含后台自动更新)状态变化后刷新 UI
    onSubsChanged: (callback: (subs: Subscription[]) => void) => {
      const sub = (_: any, subs: Subscription[]) => callback(subs);
      ipcRenderer.on('subs:changed', sub);
      return () => ipcRenderer.removeListener('subs:changed', sub);
    },
  },

  // Routing
  routing: {
    getRules: (): Promise<RouteRule[]> => ipcRenderer.invoke('routing:getRules'),
    saveRules: (rules: RouteRule[]) => ipcRenderer.invoke('routing:saveRules', rules),
    getAppRules: (): Promise<AppRule[]> => ipcRenderer.invoke('routing:getAppRules'),
    saveAppRules: (rules: AppRule[]) => ipcRenderer.invoke('routing:saveAppRules', rules),
    getRunningApps: () => ipcRenderer.invoke('routing:getRunningApps'),
    /** 更新分流规则集数据(.srs)到用户数据目录,返回成功/失败清单与核心连接状态 */
    updateRuleSets: (): Promise<{ updated: string[]; failed: string[]; coreRunning: boolean }> =>
      ipcRenderer.invoke('rules:updateRuleSets'),
    // 备份导入替换规则后刷新 UI
    onRulesChanged: (callback: (rules: RouteRule[]) => void) => {
      const sub = (_: any, rules: RouteRule[]) => callback(rules);
      ipcRenderer.on('rules:changed', sub);
      return () => ipcRenderer.removeListener('rules:changed', sub);
    },
    onAppRulesChanged: (callback: (rules: AppRule[]) => void) => {
      const sub = (_: any, rules: AppRule[]) => callback(rules);
      ipcRenderer.on('apprules:changed', sub);
      return () => ipcRenderer.removeListener('apprules:changed', sub);
    },
  },

  // DNS
  dns: {
    get: (): Promise<DnsConfig> => ipcRenderer.invoke('dns:get'),
    save: (dns: DnsConfig) => ipcRenderer.invoke('dns:save', dns),
    testResolve: (
      domain: string
    ): Promise<{ success: boolean; ip?: string; allIps?: string[]; latency?: number; error?: string }> =>
      ipcRenderer.invoke('dns:testResolve', domain),
    // 备份导入替换 DNS 配置后刷新 UI
    onDnsChanged: (callback: (dns: DnsConfig) => void) => {
      const sub = (_: any, dns: DnsConfig) => callback(dns);
      ipcRenderer.on('dns:changed', sub);
      return () => ipcRenderer.removeListener('dns:changed', sub);
    },
  },

  // Logs
  logs: {
    getAll: (): Promise<LogEntry[]> => ipcRenderer.invoke('log:getAll'),
    clear: (): Promise<void> => ipcRenderer.invoke('log:clear'),
    exportLogs: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('log:export'),
    onLogAdded: (callback: (log: LogEntry) => void) => {
      const sub = (_: any, log: any) => callback(log);
      ipcRenderer.on('log:added', sub);
      return () => ipcRenderer.removeListener('log:added', sub);
    },
  },

  // Speed test
  speedTest: {
    testLatency: (url?: string, nodeId?: string): Promise<LatencyResult> =>
      ipcRenderer.invoke('speedtest:latency', url, nodeId),
    testDownload: (url?: string, nodeId?: string): Promise<number> =>
      ipcRenderer.invoke('speedtest:download', url, nodeId),
    cancel: (nodeId?: string): Promise<void> => ipcRenderer.invoke('speedtest:cancel', nodeId),
  },

  // WebDAV
  webdav: {
    test: (config: any) => ipcRenderer.invoke('webdav:test', config),
    backup: () => ipcRenderer.invoke('webdav:backup'),
    restore: () => ipcRenderer.invoke('webdav:restore'),
  },

  // Backup & Restore
  backup: {
    exportData: (categories?: any): Promise<string> => ipcRenderer.invoke('backup:export', categories),
    exportAndroid: (categories?: any): Promise<string> => ipcRenderer.invoke('backup:exportAndroid', categories),
    previewImport: (content: string, categories?: any): Promise<any> =>
      ipcRenderer.invoke('backup:previewImport', content, categories),
    importWithTransaction: (content: string, categories?: any, mode?: 'merge' | 'replace'): Promise<any> =>
      ipcRenderer.invoke('backup:importWithTransaction', content, categories, mode),
    createLocalBackup: (): Promise<{ success: boolean; filePath: string }> =>
      ipcRenderer.invoke('backup:createLocalBackup'),
    restoreLocalBackup: (): Promise<any> => ipcRenderer.invoke('backup:restoreLocalBackup'),
    getLatestLocalBackupInfo: (): Promise<{ exists: boolean; timestamp?: number; size?: number; filePath?: string }> =>
      ipcRenderer.invoke('backup:getLatestLocalBackupInfo'),
    importData: (content: string) => ipcRenderer.invoke('backup:import', content),
    importLinks: (text: string): Promise<ProxyNode[]> => ipcRenderer.invoke('backup:importLinks', text),
  },

  // Settings
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (settings: Partial<AppSettings>) => ipcRenderer.invoke('settings:save', settings),
    resetDefaults: (): Promise<AppSettings> => ipcRenderer.invoke('settings:resetDefaults'),
    // 托盘菜单切换系统代理/TUN 后同步 UI,避免设置页残留旧值、保存时把旧状态写回
    onSettingsChanged: (callback: (settings: AppSettings) => void) => {
      const sub = (_: any, s: AppSettings) => callback(s);
      ipcRenderer.on('settings:changed', sub);
      return () => ipcRenderer.removeListener('settings:changed', sub);
    },
  },

  // System
  system: {
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('system:openExternal', url),
    isAdmin: (): Promise<boolean> => ipcRenderer.invoke('system:isAdmin'),
    relaunchAsAdmin: (): Promise<void> => ipcRenderer.invoke('system:relaunchAsAdmin'),
    flushDns: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke('system:flushDns'),
    getAppVersion: (): Promise<string> => ipcRenderer.invoke('system:getAppVersion'),
    /** 在资源管理器中打开本地目录(不存在则创建;用于 VPN 引擎放置目录) */
    openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('system:openPath', p),
  },

  // VPN 接入(应用内直接登录第三方 VPN 账号)
  vpn: {
    getProfiles: (): Promise<EngineVpnProfile[]> => ipcRenderer.invoke('evpn:getProfiles'),
    saveProfile: (profile: EngineVpnProfile): Promise<boolean> => ipcRenderer.invoke('evpn:saveProfile', profile),
    deleteProfile: (id: string): Promise<boolean> => ipcRenderer.invoke('evpn:deleteProfile', id),
    connect: (id: string, extra?: { mfaCode?: string }): Promise<boolean> =>
      ipcRenderer.invoke('evpn:connect', id, extra),
    disconnect: (): Promise<void> => ipcRenderer.invoke('evpn:disconnect'),
    getState: (): Promise<VpnRuntimeInfo | null> => ipcRenderer.invoke('evpn:getState'),
    /** 引擎可用性(openvpn/openconnect 二进制是否存在)与放置目录 */
    getEngines: (): Promise<{
      openvpn: { available: boolean; dir: string };
      openconnect: { available: boolean; dir: string };
    }> => ipcRenderer.invoke('evpn:getEngines'),
    /** 自动获取 VPN 网关的服务器证书 PEM(依次尝试 443/992/5555 的 TLS 端口) */
    fetchServerCert: (host: string, ports?: number[]): Promise<{ pem?: string; port?: number; error?: string }> =>
      ipcRenderer.invoke('evpn:fetchServerCert', host, ports),
    onStateChange: (callback: (info: VpnRuntimeInfo | null) => void): (() => void) => {
      const sub = (_e: unknown, info: VpnRuntimeInfo | null) => callback(info);
      ipcRenderer.on('evpn:state', sub);
      return () => {
        ipcRenderer.removeListener('evpn:state', sub);
      };
    },
    onProfilesChanged: (callback: (profiles: EngineVpnProfile[]) => void): (() => void) => {
      const sub = (_e: unknown, profiles: EngineVpnProfile[]) => callback(profiles);
      ipcRenderer.on('evpn:profiles', sub);
      return () => {
        ipcRenderer.removeListener('evpn:profiles', sub);
      };
    },
  },

  // TUN 提权引导(自定义弹窗,不使用系统原生对话框)
  tun: {
    /** 弹窗确认"以管理员身份重启":落库(含互斥联动)并提权重启 */
    enableElevated: (): Promise<boolean> => ipcRenderer.invoke('tun:enableElevated'),
    /**
     * 主进程请求弹窗:开 TUN 被拦截(兜底路径,无上下文)或连接门禁
     * (context='connect':TUN 已开启但非管理员时点连接,取消=关 TUN 改系统代理连接)
     */
    onElevationRequired: (callback: (context?: string) => void): (() => void) => {
      const sub = (_e: unknown, context?: string) => callback(context);
      ipcRenderer.on('tun:elevation-required', sub);
      return () => {
        ipcRenderer.removeListener('tun:elevation-required', sub);
      };
    },
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
