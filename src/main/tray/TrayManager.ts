import { Tray, Menu, nativeImage, NativeImage, BrowserWindow, app } from 'electron';
import { Database } from '../db/Database';
import { SingBoxManager } from '../core/SingBoxManager';
import { SystemProxy } from '../system/SystemProxy';
import { TakeoverLinkage } from '../system/TakeoverLinkage';
import { ConfigGenerator } from '../core/ConfigGenerator';
import { resourcePath, trayIconPath } from '../branding';

export class TrayManager {
  private static instance: TrayManager;
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;

  private constructor() {}

  public static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  private getTrayIcon(): NativeImage {
    // 初始未连接代理 → off;找不到时回退应用主图标
    const p = trayIconPath(false) ?? resourcePath('ico.ico');
    if (p) {
      try {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          return img.resize({ width: 16, height: 16 });
        }
      } catch {}
    }
    return nativeImage.createEmpty();
  }

  public init(window: BrowserWindow): void {
    this.mainWindow = window;

    const icon = this.getTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('青翼连接 BlueWing Connect - 未连接');

    this.tray.on('click', () => {
      this.toggleWindow();
    });

    this.updateMenu();
  }

  public toggleWindow(): void {
    if (!this.mainWindow) return;
    if (this.mainWindow.isVisible()) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
        this.mainWindow.focus();
      } else if (this.mainWindow.isFocused()) {
        this.mainWindow.hide();
      } else {
        this.mainWindow.focus();
      }
    } else {
      this.showFromTray();
    }
  }

  /** 从托盘恢复窗口:关闭进托盘时已摘除任务栏按钮,显示前挂回,避免窗口无任务栏入口 */
  public showFromTray(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.setSkipTaskbar(false);
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  public updateMenu(): void {
    if (!this.tray) return;

    const db = Database.getInstance();
    const core = SingBoxManager.getInstance();
    const nodes = db.getNodes();
    const activeNodeId = db.getActiveNodeId();
    const activeNode = nodes.find((n) => n.id === activeNodeId) || nodes[0];
    const settings = db.getSettings();
    const isRunning = core.getState() === 'running';

    this.tray.setToolTip(
      isRunning
        ? `青翼连接 BlueWing Connect - 已连接: ${activeNode?.name || '未知'}`
        : '青翼连接 BlueWing Connect - 未连接'
    );

    // 托盘图标:任一接管方式生效即视为开启(系统代理与 TUN 互斥二选一,
    // 只看 systemProxyEnabled 会在 TUN 模式下误显"未开启"图标)
    const proxyOn = isRunning && (settings.systemProxyEnabled || settings.tunEnabled);
    const statePng = trayIconPath(proxyOn);
    if (statePng) {
      try {
        const img = nativeImage.createFromPath(statePng);
        if (!img.isEmpty()) {
          this.tray.setImage(img.resize({ width: 16, height: 16 }));
        }
      } catch {}
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `青翼连接 BlueWing Connect v${app.getVersion()} (${isRunning ? '● 已连接' : '○ 未连接'})`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: isRunning ? '断开连接' : '立即连接',
        click: async () => {
          if (isRunning) {
            await core.stop();
            if (settings.systemProxyEnabled) {
              await SystemProxy.disable();
            }
          } else {
            // 连接意图保护:用户显式连接且系统代理与 TUN 都未启用时自动补开,确保连接真实生效
            if (SystemProxy.shouldAutoEnableSystemProxy(true, settings)) {
              settings.systemProxyEnabled = true;
              db.saveSettings({ systemProxyEnabled: true });
              this.mainWindow?.webContents.send('settings:changed', db.getSettings());
            }
            const config = ConfigGenerator.generate(
              activeNodeId,
              nodes,
              db.getRules(),
              db.getAppRules(),
              db.getDns(),
              settings
            );
            const started = await core.start(config);
            if (started && settings.systemProxyEnabled) {
              await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
            }
            // 与主进程 handleCoreStart 同一套 TUN 剥除兜底:权限不足被剥除且代理为关时
            // 自动开启系统代理,避免托盘连接后无任何流量出口
            if (started && core.wasTunStrippedLastStart() && (await TakeoverLinkage.ensureProxyWhenTunStripped())) {
              this.mainWindow?.webContents.send('settings:changed', db.getSettings());
            }
          }
          this.updateMenu();
          this.mainWindow?.webContents.send('core:stateChange', core.getState());
        },
      },
      {
        label: `当前节点: ${activeNode?.name || '无'}`,
        submenu: nodes.map((n) => ({
          label: `${n.name} (${n.type.toUpperCase()})`,
          type: 'radio',
          checked: n.id === activeNodeId,
          click: async () => {
            const { ProxySelectionService } = await import('../core/ProxySelectionService');
            await ProxySelectionService.selectNode(n.id);
            this.updateMenu();
            this.mainWindow?.webContents.send('node:changed', n.id);
          },
        })),
      },
      { type: 'separator' },
      {
        label: '系统代理',
        type: 'checkbox',
        checked: settings.systemProxyEnabled,
        click: async () => {
          const newState = !settings.systemProxyEnabled;
          // 反向联动(二选一):TUN 开着时开系统代理 → 联动关 TUN
          const patch = newState
            ? TakeoverLinkage.proxyTogglePatch(settings, { tunEnabled: settings.tunEnabled, systemProxyEnabled: newState })
            : null;
          db.saveSettings({ systemProxyEnabled: newState, ...(patch || {}) });
          if (core.getState() === 'running') {
            if (newState) {
              await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
            } else {
              await SystemProxy.disable();
            }
            // TUN 被联动关闭:按新设置重载核心(去掉 TUN 入站)
            if (patch) {
              const config = ConfigGenerator.generate(
                activeNodeId,
                nodes,
                db.getRules(),
                db.getAppRules(),
                db.getDns(),
                db.getSettings()
              );
              await core.start(config);
            }
          } else if (newState) {
            // 核心未运行时勾选系统代理:自动连接,确保开关真实生效而不是只改设置
            const config = ConfigGenerator.generate(
              activeNodeId,
              nodes,
              db.getRules(),
              db.getAppRules(),
              db.getDns(),
              db.getSettings()
            );
            const started = await core.start(config);
            if (started) {
              await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
            }
          }
          this.updateMenu();
          this.mainWindow?.webContents.send('settings:changed', db.getSettings());
        },
      },
      {
        label: 'TUN 模式 (虚拟网卡)',
        type: 'checkbox',
        checked: settings.tunEnabled,
        click: async () => {
          const newState = !settings.tunEnabled;
          // 非管理员下开 TUN:与设置页同一套引导——唤醒主窗口并通知渲染层弹
          // 自定义提权引导弹窗(TUN 不可能生效时明确告知,而不是静默走
          // "剥除+代理回退"三步舞);取消则完全不开启
          if (newState && !core.isAdmin()) {
            this.showFromTray();
            this.mainWindow?.webContents.send('tun:elevation-required');
            return;
          }
          // TUN↔系统代理互斥联动(二选一):切 TUN 时联动拨系统代理开关,
          // 与设置页 settings:save 的归一化同一规则
          const patch = TakeoverLinkage.exclusivityPatch(
            settings,
            { tunEnabled: newState, systemProxyEnabled: settings.systemProxyEnabled },
            core.getState() === 'running'
          );
          db.saveSettings({ tunEnabled: newState, ...(patch || {}) });
          if (patch?.systemProxyEnabled === false) {
            await SystemProxy.disable();
          } else if (patch?.systemProxyEnabled === true && core.getState() === 'running') {
            await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
          }
          if (core.getState() === 'running') {
            const config = ConfigGenerator.generate(
              activeNodeId,
              nodes,
              db.getRules(),
              db.getAppRules(),
              db.getDns(),
              db.getSettings()
            );
            await core.start(config);
          }
          this.updateMenu();
          this.mainWindow?.webContents.send('settings:changed', db.getSettings());
        },
      },
      { type: 'separator' },
      {
        label: '打开主界面',
        click: () => {
          this.showFromTray();
        },
      },
      {
        label: '退出 青翼连接',
        click: async () => {
          await core.stop();
          await SystemProxy.disable();
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  public destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
