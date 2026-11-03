import { SystemProxy } from './SystemProxy';
import { Database } from '../db/Database';
import { LogManager } from '../log/LogManager';
import { AppSettings } from '../../types';

/**
 * TUN 与系统代理的互斥联动(用户预期"二选一"):
 * - 用户把 TUN 从关切到开 → 系统代理联动关闭(TUN 已全量接管,系统代理冗余);
 * - 用户把 TUN 从开切到关 → 系统代理联动开启(避免两种接管方式同时为空,空转断网)。
 * 联动只在用户显式切换 TUN 的那次操作发生;核心重载路径一律不触碰开关
 * (与连接意图保护的 userInitiated 约束同一原则)。
 * 另有保护性例外:TUN 因权限不足被剥除时自动开启系统代理兜底——
 * 此前"已安全回退为系统代理模式"的日志在代理开关为关时是空话,流量实际无任何出口。
 */
export class TakeoverLinkage {
  /**
   * 纯函数:根据 TUN 开关的前后变化计算系统代理的联动补丁。
   * - TUN 关→开:系统代理联动关闭(空闲/连接中均适用,纯减法无副作用);
   * - TUN 开→关:仅连接中联动开启系统代理——空闲时开代理会触发"开代理自动
   *   拉起核心"的既有语义,用户只是关个 TUN 却被自动连接,出乎意料;
   *   空闲状态由"已连接但未接管"横幅兜底提示即可。
   * 返回需合并进设置的补丁;无联动需要时返回 null。
   */
  public static exclusivityPatch(
    prev: Pick<AppSettings, 'tunEnabled' | 'systemProxyEnabled'>,
    next: Pick<AppSettings, 'tunEnabled' | 'systemProxyEnabled'>,
    coreRunning: boolean
  ): Partial<AppSettings> | null {
    if (next.tunEnabled && !prev.tunEnabled && next.systemProxyEnabled) {
      return { systemProxyEnabled: false };
    }
    if (coreRunning && !next.tunEnabled && prev.tunEnabled && !next.systemProxyEnabled) {
      return { systemProxyEnabled: true };
    }
    return null;
  }

  /**
   * 反向联动(单选语义的另一半):TUN 开着时用户开系统代理 → 联动关 TUN。
   * 关代理不反向开 TUN——关代理是"停止接管"的手势,自动拉起 TUN 出乎意料
   * (且 TUN 需要管理员权限,静默开出来只会被剥除)。
   */
  public static proxyTogglePatch(
    prev: Pick<AppSettings, 'tunEnabled' | 'systemProxyEnabled'>,
    next: Pick<AppSettings, 'tunEnabled' | 'systemProxyEnabled'>
  ): Partial<AppSettings> | null {
    if (next.systemProxyEnabled && !prev.systemProxyEnabled && next.tunEnabled) {
      return { tunEnabled: false };
    }
    return null;
  }

  /**
   * 保护性兜底:核心启动时 TUN 因非管理员权限被剥除,而系统代理开关为关——
   * 自动开启系统代理,兑现"安全回退系统代理模式"的承诺,避免连接空转无出口。
   * 返回是否发生了设置变更(调用方据此广播 settings:changed)。
   */
  public static async ensureProxyWhenTunStripped(isCurrent: () => boolean = () => true): Promise<boolean> {
    if (!isCurrent()) return false;
    const db = Database.getInstance();
    const settings = db.getSettings();
    if (!settings.tunEnabled || settings.systemProxyEnabled) return false;

    db.saveSettings({ systemProxyEnabled: true });
    const enabled = await SystemProxy.enable(
      '127.0.0.1',
      settings.mixedPort,
      settings.systemProxyBypassLan,
      settings.customBypassList,
      isCurrent
    );
    if (!enabled) {
      db.saveSettings({ systemProxyEnabled: false });
      LogManager.getInstance().addLog('error', 'TUN 未生效，系统代理恢复保护也未就绪，请检查网络恢复日志', 'system');
      return false;
    }
    LogManager.getInstance().addLog(
      'warn',
      'TUN 因权限不足未生效,已自动开启系统代理兜底(以管理员身份重启后可用 TUN)',
      'system'
    );
    return true;
  }
}
