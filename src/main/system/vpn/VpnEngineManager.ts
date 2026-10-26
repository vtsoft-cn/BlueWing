import { EventEmitter } from 'events';
import { Database } from '../../db/Database';
import { LogManager } from '../../log/LogManager';
import { VpnProfile, VpnRuntimeInfo, VpnSplitConfig } from '../../../types';
import { VpnEngine, VpnEngineContext, EngineNetworkInfo } from './EngineContract';
import { RasVpnEngine } from './RasVpnEngine';
import { OpenVpnEngine } from './OpenVpnEngine';
import { OpenConnectEngine, OPENCONNECT_PROTOCOL_MAP } from './OpenConnectEngine';
import { WindowsNetQuery, classifyAdapterRoutes } from './WindowsNetQuery';

/** 档案类型 → 引擎类别(纯函数,供单测):
 * - softether 解析为其兼容端点(l2tp/sstp/openvpn,默认 l2tp);
 * - openconnect 家族按协议映射表判定;
 * - wireguard 为 sing-box 原生隧道,无引擎进程(配置级接入)。
 * 返回 'ikev2'|'l2tp'|'sstp'|'openvpn'|'openconnect'|'wireguard' 之一,未知返回 null。 */
export function resolveVpnEngineType(profile: Pick<VpnProfile, 'type' | 'softetherMode'>): string | null {
  if (profile.type === 'wireguard') return 'wireguard';
  if (profile.type === 'softether') {
    const mode = profile.softetherMode || 'l2tp';
    return mode === 'l2tp' || mode === 'sstp' || mode === 'openvpn' ? mode : null;
  }
  if (profile.type === 'ikev2' || profile.type === 'l2tp' || profile.type === 'sstp' || profile.type === 'openvpn') {
    return profile.type;
  }
  return OPENCONNECT_PROTOCOL_MAP[profile.type] ? 'openconnect' : null;
}

/** 传给引擎的"生效档案":softether 以兼容端点类型改写 type,其余原样 */
export function effectiveEngineProfile(profile: VpnProfile): VpnProfile {
  if (profile.type !== 'softether') return profile;
  return { ...profile, type: profile.softetherMode || 'l2tp' } as VpnProfile;
}

/**
 * VPN 引擎编排(单连接模型:同一时刻只连一个档案)。
 *
 * 职责:
 * - 按档案类型分派到 RAS / OpenVPN / openconnect 引擎,驱动状态机
 *   connecting → connected/error → disconnected;
 * - 网络事实(网卡名/内网 CIDR/DNS/后缀)变化时发 'state' 事件,主进程据此
 *   重载核心配置注入 vpn-corp 数据面;
 * - custody 监控:TUN 模式 + 管理员权限下,把引擎装在 OS 路由表的内网路由
 *   移交给应用(删除路由 + 为 VPN DNS 补 on-link 主机路由),使内网流量
 *   落回 TUN 经 vpn-corp 出站——兑现"数据流必须经过当前应用";
 *   无权限/非 TUN 时保持 OS 路由直通(内网可达但不经应用统计),并明确告知。
 */
export class VpnEngineManager extends EventEmitter {
  private static instance: VpnEngineManager;

  private engine: VpnEngine | null = null;
  private runtime: VpnRuntimeInfo | null = null;
  private profileId = '';
  /** custody 移交是否已对本连接执行过(避免每轮重复日志) */
  private custodyApplied = false;
  private custodyDisabledReason = '';
  private custodyTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private switching = false;

  /** 由主进程注入的运行环境判定(避免反向依赖 index.ts / SingBoxManager) */
  private envProbe: () => { coreRunning: boolean; tunActive: boolean; isAdmin: boolean } = () => ({
    coreRunning: false,
    tunActive: false,
    isAdmin: false,
  });

  private constructor() {
    super();
  }

  public static getInstance(): VpnEngineManager {
    if (!VpnEngineManager.instance) {
      VpnEngineManager.instance = new VpnEngineManager();
    }
    return VpnEngineManager.instance;
  }

  /** 主进程注入环境判定(核心是否在跑、TUN 是否生效、是否有管理员权限) */
  public setEnvProbe(probe: () => { coreRunning: boolean; tunActive: boolean; isAdmin: boolean }): void {
    this.envProbe = probe;
  }

  public getState(): VpnRuntimeInfo | null {
    return this.runtime ? { ...this.runtime } : null;
  }

  /** 当前连接是否激活(供 ConfigGenerator 注入判断) */
  public isConnected(): boolean {
    return this.runtime?.state === 'connected';
  }

  /** 供 ConfigGenerator 的注入数据:连接激活即有意义——
   *  WireGuard 型返回隧道参数(无 adapterName),引擎型需网卡名 */
  public getSplitConfig(): VpnSplitConfig | null {
    if (!this.runtime || this.runtime.state !== 'connected') return null;
    const db = Database.getInstance();
    const profile = db.getVpnProfiles().find((p) => p.id === this.runtime?.profileId);
    if (profile?.type === 'wireguard') {
      return {
        adapterName: '',
        routes: this.runtime.routes,
        dnsServers: this.runtime.dnsServers,
        domainSuffixes: this.runtime.domainSuffixes,
        wireguard: {
          server: profile.server,
          port: profile.port || 51820,
          privateKey: profile.privateKey || '',
          peerPublicKey: profile.peerPublicKey || '',
          presharedKey: profile.presharedKey,
          localAddress: profile.localAddress || '10.7.0.2/32',
          mtu: profile.wireguardMtu,
        },
      };
    }
    if (!this.runtime.adapterName) return null;
    return {
      adapterName: this.runtime.adapterName,
      routes: this.runtime.routes,
      dnsServers: this.runtime.dnsServers,
      domainSuffixes: this.runtime.domainSuffixes,
    };
  }

  public async connect(profileId: string, extra?: { mfaCode?: string }): Promise<boolean> {
    if (this.switching) return false;
    const db = Database.getInstance();
    const profile = db.getVpnProfiles().find((p) => p.id === profileId);
    if (!profile) {
      LogManager.getInstance().addLog('warn', 'VPN 连接失败:档案不存在', 'system');
      return false;
    }

    this.switching = true;
    try {
      if (this.runtime && this.runtime.state !== 'disconnected') {
        await this.disconnectInternal('切换 VPN 档案');
      }

      // WireGuard:sing-box 原生隧道,无引擎进程——校验后直接置为已连接,
      // 由主进程重载核心注入 vpn-wg endpoint 与分流规则(隧道随核心建立)
      if (profile.type === 'wireguard') {
        const missing: string[] = [];
        if (!profile.server) missing.push('服务器地址');
        if (!profile.privateKey) missing.push('私钥');
        if (!profile.peerPublicKey) missing.push('对端公钥');
        if (!profile.localAddress) missing.push('本机隧道地址');
        if (!profile.extraRoutes || profile.extraRoutes.length === 0) missing.push('内网网段(AllowedIPs)');
        if (missing.length > 0) {
          this.setRuntime({
            profileId: profile.id,
            profileName: profile.name,
            state: 'error',
            routes: [],
            dnsServers: [],
            domainSuffixes: [],
            since: Date.now(),
            message: `缺少必填项: ${missing.join('、')}`,
          });
          LogManager.getInstance().addLog('error', `WireGuard 档案缺少必填项: ${missing.join('、')}`, 'system');
          return false;
        }
        this.profileId = profile.id;
        this.custodyApplied = false;
        this.custodyDisabledReason = 'wireguard-native';
        const wgRoutes = (profile.extraRoutes || []).filter(Boolean);
        this.setRuntime({
          profileId: profile.id,
          profileName: profile.name,
          state: 'connected',
          routes: wgRoutes,
          dnsServers: profile.corpDns ? [profile.corpDns] : [],
          domainSuffixes: profile.dnsSuffix ? [profile.dnsSuffix] : [],
          since: Date.now(),
          message: '内网流量经 WireGuard 隧道,其余流量走代理节点',
        });
        db.upsertVpnProfile({ ...profile, lastConnected: Date.now() });
        LogManager.getInstance().addLog(
          'info',
          `WireGuard VPN 已启用:内网段 ${wgRoutes.join(', ')} 经原生隧道转发`,
          'system'
        );
        return true;
      }

      // softether 等别名类型解析为实际兼容端点后再分派引擎(凭据/补充网段原样继承)
      const engineProfile = effectiveEngineProfile(profile);
      this.engine = this.createEngine(engineProfile);
      if (!this.engine) {
        LogManager.getInstance().addLog('error', `不支持的 VPN 类型: ${profile.type}`, 'system');
        return false;
      }

      this.profileId = profile.id;
      this.custodyApplied = false;
      this.custodyDisabledReason = '';
      this.setRuntime({
        profileId: profile.id,
        profileName: profile.name,
        state: 'connecting',
        routes: [],
        dnsServers: [],
        domainSuffixes: [],
        since: Date.now(),
        message: '正在建立 VPN 连接...',
      });

      const ctx: VpnEngineContext = {
        profile: engineProfile,
        mfaCode: extra?.mfaCode,
        onConnected: () => {
          if (this.profileId !== profile.id) return;
          this.setRuntime({
            ...(this.runtime as VpnRuntimeInfo),
            state: 'connected',
            since: Date.now(),
            message: undefined,
          });
          db.upsertVpnProfile({ ...profile, lastConnected: Date.now() });
          this.clearWatchdog();
          this.startCustodyMonitor();
        },
        onNetworkInfo: (info: EngineNetworkInfo) => {
          if (this.profileId !== profile.id) return;
          this.applyNetworkInfo(profile, info);
        },
        onError: (message) => {
          if (this.profileId !== profile.id) return;
          this.setRuntime({ ...(this.runtime as VpnRuntimeInfo), state: 'error', message });
          LogManager.getInstance().addLog('error', `VPN 连接失败: ${message}`, 'system');
          this.clearWatchdog();
          void this.disconnectInternal('连接失败清理', true);
        },
        onEngineExit: (message) => {
          if (this.profileId !== profile.id) return;
          LogManager.getInstance().addLog('warn', `VPN 连接中断: ${message}`, 'system');
          this.setRuntime({
            ...(this.runtime as VpnRuntimeInfo),
            state: 'error',
            message: `连接中断: ${message}`,
          });
          this.engine = null;
          this.stopCustodyMonitor();
        },
        onLog: (level, message) => {
          LogManager.getInstance().addLog(level, `[VPN] ${message}`, 'system');
        },
      };

      this.armWatchdog();
      await this.engine.start(ctx);
      return true;
    } finally {
      this.switching = false;
    }
  }

  public async disconnect(): Promise<void> {
    await this.disconnectInternal('用户断开');
  }

  /**
   * preserveError:连接失败/超时路径的清理不把 error 态改写成 disconnected——
   * 否则用户永远看不到失败原因,页面直接回到"未连接"。
   */
  private async disconnectInternal(reason: string, preserveError = false): Promise<void> {
    this.clearWatchdog();
    this.stopCustodyMonitor();
    const engine = this.engine;
    this.engine = null;
    if (
      this.runtime &&
      this.runtime.state !== 'disconnected' &&
      !(preserveError && this.runtime.state === 'error')
    ) {
      this.setRuntime({
        profileId: this.runtime.profileId,
        profileName: this.runtime.profileName,
        state: 'disconnected',
        routes: [],
        dnsServers: [],
        domainSuffixes: [],
        since: Date.now(),
      });
      LogManager.getInstance().addLog('info', `VPN 已断开(${reason})`, 'system');
    }
    if (engine) {
      try {
        await engine.stop();
      } catch {}
    }
  }

  /** 应用退出时清理:停引擎、杀子进程 */
  public async shutdown(): Promise<void> {
    await this.disconnectInternal('应用退出');
  }

  private createEngine(profile: VpnProfile): VpnEngine | null {
    switch (resolveVpnEngineType(profile)) {
      case 'ikev2':
      case 'l2tp':
      case 'sstp':
        return new RasVpnEngine();
      case 'openvpn':
        return new OpenVpnEngine();
      case 'openconnect':
        // openconnect 家族:按协议映射表判定,新增协议类型自动覆盖
        return new OpenConnectEngine();
      default:
        return null;
    }
  }

  /** 引擎上报网络事实 → 合并档案 extraRoutes,更新运行态并触发 custody */
  private applyNetworkInfo(profile: VpnProfile, info: EngineNetworkInfo): void {
    if (!this.runtime) return;
    const extra = Array.isArray(profile.extraRoutes) ? profile.extraRoutes : [];
    const routes = info.routes.concat(extra.filter((r) => r && !info.routes.includes(r)));
    this.setRuntime({
      ...this.runtime,
      adapterName: info.adapterName,
      routes,
      dnsServers: info.dnsServers,
      domainSuffixes: info.domainSuffixes.filter((s, i, arr) => arr.indexOf(s) === i),
      ipv4: info.ipv4,
    });
    LogManager.getInstance().addLog(
      'info',
      `VPN 网络信息:网卡 ${info.adapterName},内网段 ${routes.length} 个,DNS ${info.dnsServers.join(', ') || '无'}`,
      'system'
    );
    if (this.runtime.state === 'connected') {
      this.runCustodyPass(info.installedOsRoutes);
    }
  }

  private setRuntime(next: VpnRuntimeInfo): void {
    this.runtime = next;
    this.emit('state', { ...next });
  }

  /**
   * custody:把 OS 路由表里的内网路由移交应用接管。
   * 仅在引擎实际装了路由、核心 TUN 生效且有管理员权限时执行;
   * 移交后每 10s 复查(引擎重连/续租可能重装路由)。
   */
  private startCustodyMonitor(): void {
    this.stopCustodyMonitor();
    this.custodyTimer = setInterval(() => {
      if (!this.runtime || this.runtime.state !== 'connected' || !this.runtime.adapterName) return;
      const installed = true; // 复查模式下无法区分,恒视为可能有 OS 路由
      void this.runCustodyPass(installed);
    }, 10_000);
    this.custodyTimer.unref();
  }

  private stopCustodyMonitor(): void {
    if (this.custodyTimer) {
      clearInterval(this.custodyTimer);
      this.custodyTimer = null;
    }
  }

  private async runCustodyPass(assumeInstalledRoutes: boolean): Promise<void> {
    if (!assumeInstalledRoutes) return; // openvpn(--route-nopull)从未装过 OS 路由
    if (this.custodyDisabledReason) return;
    const rt = this.runtime;
    if (!rt || !rt.adapterName || rt.routes.length === 0) return;

    const env = this.envProbe();
    if (!env.coreRunning || !env.tunActive) return; // 非 TUN 场景:OS 路由直通即可
    if (!env.isAdmin) {
      this.custodyDisabledReason = 'no-admin';
      LogManager.getInstance().addLog(
        'info',
        '内网流量将直接经 VPN 网卡转发(不经应用统计);以管理员身份运行且开启 TUN 可改为经应用接管',
        'system'
      );
      return;
    }

    try {
      const adapter = await WindowsNetQuery.findAdapterByName(rt.adapterName);
      if (!adapter) return;
      const network = await WindowsNetQuery.getAdapterNetwork(adapter.interfaceIndex);
      const { corp } = classifyAdapterRoutes(network.routes, network.connectedPrefix);
      if (corp.length === 0) return; // 路由已移交/本就未装
      const res = await WindowsNetQuery.handOverRoutes(adapter.interfaceIndex, corp, rt.dnsServers);
      if (res.failed > 0 && res.removed === 0) {
        this.custodyDisabledReason = 'remove-failed';
        LogManager.getInstance().addLog('warn', '内网路由移交失败,保持系统路由直通(不影响可用性)', 'system');
        return;
      }
      if (!this.custodyApplied && res.removed > 0) {
        this.custodyApplied = true;
        LogManager.getInstance().addLog(
          'info',
          `内网流量已改为经应用接管(移交 ${res.removed} 条系统路由,VPN DNS 保留专用路由)`,
          'system'
        );
      }
    } catch {
      // 单轮失败静默:下一轮复查会重试
    }
  }

  /** 连接看门狗:connecting 悬挂超过 90s 判失败 */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.runtime && this.runtime.state === 'connecting') {
        this.setRuntime({
          ...this.runtime,
          state: 'error',
          message: '连接超时(90 秒内未完成握手)',
        });
        LogManager.getInstance().addLog('error', 'VPN 连接超时,已停止本次尝试', 'system');
        void this.disconnectInternal('连接超时', true);
      }
    }, 90_000);
    this.watchdogTimer.unref();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
