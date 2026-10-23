import http from 'http';
import { Database } from '../db/Database';
import { SingBoxManager } from './SingBoxManager';
import { LogManager } from '../log/LogManager';

export class ProxySelectionService {
  private static mutation: Promise<unknown> = Promise.resolve();
  private static exclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(job, job);
    this.mutation = next.catch(() => {});
    return next;
  }
  private static updateTray():void {if(process.versions.electron){const {TrayManager}=require('../tray/TrayManager') as typeof import('../tray/TrayManager');TrayManager.getInstance().updateMenu();}}
  /**
   * Gets currently active node ID from database state
   */
  public static getActiveNodeId(): string {
    return Database.getInstance().getActiveNodeId();
  }

  /**
   * Set active proxy node with zero-downtime Clash API hot-switching when core is running.
   */
  public static async selectNode(nodeId: string): Promise<{ success: boolean; hotSwitched: boolean; error?: string }> {
    return this.exclusive(() => this.selectNodeInternal(nodeId));
  }

  private static async selectNodeInternal(nodeId: string): Promise<{ success: boolean; hotSwitched: boolean; error?: string }> {
    const db = Database.getInstance();
    const nodes = db.getNodes();
    const target = nodes.find((n) => n.id === nodeId);

    if (!target) {
      return { success: false, hotSwitched: false, error: `节点不存在 (ID: ${nodeId})` };
    }

    const wasDirect = db.getSettings().routingMode === 'direct';
    // Choosing a node explicitly leaves standalone mode; merely adding one does not.
    if (wasDirect) db.saveSettings({ routingMode: 'rule' });
    db.setActiveNodeId(nodeId);

    const core = SingBoxManager.getInstance();
    const settings = db.getSettings();
    if (core.getState() !== 'running') {
      this.updateTray();
      return { success: true, hotSwitched: false };
    }

    // 2. Core is running: Attempt instantaneous hot-switch via Clash API selector
    const port = settings.clashApiPort || 9090;
    const secret = settings.clashApiSecret;
    const tag = `node-${nodeId}`;

    // A selector PUT cannot update the final route or DNS left by a node-free run.
    // Rebuild whenever the target is absent or the running config is still direct.
    let live: any;
    try { live = JSON.parse(core.getLiveConfig()); } catch {}
    const selector = live?.outbounds?.find((o: any) => o.tag === 'proxy');
    const canHotSwitch = !wasDirect && live?.route?.final === 'proxy' && selector?.outbounds?.includes(tag);
    const switched = canHotSwitch && await this.putClashSelector(port, 'proxy', tag, secret);
    if (switched) {
      LogManager.getInstance().addLog(
        'info',
        `已热切换活跃节点 -> ${target.name} (${target.type.toUpperCase()}) [零断流热重载]`,
        'core'
      );
      this.updateTray();
      return { success: true, hotSwitched: true };
    }

    // 3. Fallback: if hot-switch failed (e.g. selector not ready or node tag mismatch), gracefully reload core
    LogManager.getInstance().addLog(
      'warn',
      canHotSwitch ? `Clash API 热切换未就绪，重载配置以切换至节点: ${target.name}` : `网络出口发生变化，重新应用路由和 DNS: ${target.name}`,
      'core'
    );

    return this.rebuild();
  }

  /** Direct is a real saved choice, independent of the remembered proxy node. */
  public static async selectDirect(): Promise<{ success: boolean; hotSwitched: boolean; error?: string }> {
    return this.exclusive(async () => {
      const db = Database.getInstance();
      db.saveSettings({ routingMode: 'direct' });
      const core = SingBoxManager.getInstance();
      let live: any;
      try { live = JSON.parse(core.getLiveConfig()); } catch {}
      if (core.getState() !== 'running' || live?.route?.final === 'direct') {
        this.updateTray();
        return { success: true, hotSwitched: false };
      }
      return this.rebuild();
    });
  }

  private static async rebuild(): Promise<{ success: boolean; hotSwitched: boolean; error?: string }> {
    const db = Database.getInstance();
    try {
      // Dynamic import to avoid circular dependency
      const { ConfigGenerator } = await import('./ConfigGenerator');
      const config = ConfigGenerator.generate(
        db.getActiveNodeId(),
        db.getNodes(),
        db.getRules(),
        db.getAppRules(),
        db.getDns(),
        db.getSettings()
      );
      const restarted = await SingBoxManager.getInstance().start(config);
      this.updateTray();
      return { success: restarted, hotSwitched: false, ...(restarted ? {} : { error: '出口配置应用失败，请查看日志后重试连接' }) };
    } catch (e: any) {
      LogManager.getInstance().addLog('error', `切换节点失败: ${e.message}`, 'core');
      return { success: false, hotSwitched: false, error: e.message };
    }
  }

  private static putClashSelector(
    port: number,
    selectorTag: string,
    targetTag: string,
    secret?: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const payload = JSON.stringify({ name: targetTag });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        };
        if (secret) {
          headers['Authorization'] = `Bearer ${secret}`;
        }

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/proxies/${encodeURIComponent(selectorTag)}`,
            method: 'PUT',
            headers,
            timeout: 2500,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode === 204 || res.statusCode === 200);
          }
        );

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.write(payload);
        req.end();
      } catch {
        resolve(false);
      }
    });
  }
}
