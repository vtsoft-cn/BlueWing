import { VpnProfile } from '../../../types';

/** 引擎上报给管理器的网络事实(适配器确定后至少上报一次) */
export interface EngineNetworkInfo {
  adapterName: string;
  routes: string[];
  dnsServers: string[];
  domainSuffixes: string[];
  ipv4?: string;
  /** 引擎在 OS 路由表里装了内网路由(openvpn 因 --route-nopull 恒为 false) */
  installedOsRoutes: boolean;
}

export interface VpnEngineContext {
  profile: VpnProfile;
  /** 连接时的一次性输入(当前仅 openconnect 的 MFA 验证码) */
  mfaCode?: string;
  onConnected(): void;
  onNetworkInfo(info: EngineNetworkInfo): void;
  onError(message: string): void;
  /** 引擎进程/连接意外退出(用户主动断开不走此处) */
  onEngineExit(message: string): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface VpnEngine {
  readonly engineName: string;
  /** 启动引擎;返回后连接状态由回调驱动(RAS 同步完成,子进程引擎异步) */
  start(ctx: VpnEngineContext): Promise<void>;
  /** 优雅断开(清理系统连接项/杀子进程);幂等 */
  stop(): Promise<void>;
}
