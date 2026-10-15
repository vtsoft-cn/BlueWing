import { Tray, Menu, nativeImage, NativeImage, BrowserWindow, app } from 'electron';
import { Database } from '../db/Database';
import { SingBoxManager } from '../core/SingBoxManager';
import { SystemProxy } from '../system/SystemProxy';
import { ConfigGenerator } from '../core/ConfigGenerator';
import { resourcePath, windowIconPath, trayIconPath } from '../branding';

export class TrayManager {
  private static instance: TrayManager;
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;

  private constructor() {}

  /** 任务栏窗口图标随代理状态切换:开启 → light,关闭 → dark */
  private applyWindowIcon(on: boolean): void {
    const p = windowIconPath(on);
    if (p && this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.setIcon(p);
      } catch {}
    }
  }

  public static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  private getTrayIcon(): NativeImage {
    // 初始状态未连接代理 → dark;找不到时回退应用主图标
    const p = trayIconPath(false) ?? resourcePath('icon.ico');
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
    this.tray.setToolTip('BlueBird - 未连接');

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
      this.mainWindow.show();
      this.mainWindow.focus();
    }
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
      isRunning ? `BlueBird - 已连接: ${activeNode?.name || '未知'}` : 'BlueBird - 未连接'
    );

    // 托盘图标随代理状态切换:开启代理 → light,关闭 → dark
    const proxyOn = isRunning && settings.systemProxyEnabled;
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
        label: `BlueBird v${app.getVersion()} (${isRunning ? '● 已连接' : '○ 未连接'})`,
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
              this.applyWindowIcon(false);
            }
          } else {
            // 连接意图保护:系统代理与 TUN 都未启用时自动补开,确保连接真实生效
            if (!settings.systemProxyEnabled && !settings.tunEnabled) {
              settings.systemProxyEnabled = true;
              db.saveSettings({ systemProxyEnabled: true });
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
              this.applyWindowIcon(true);
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
          db.saveSettings({ systemProxyEnabled: newState });
          if (core.getState() === 'running') {
            if (newState) {
              await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
              this.applyWindowIcon(true);
            } else {
              await SystemProxy.disable();
              this.applyWindowIcon(false);
            }
          } else if (newState) {
            // 核心未运行时勾选系统代理:自动连接,确保开关真实生效而不是只改设置
            const config = ConfigGenerator.generate(
              activeNodeId,
              nodes,
              db.getRules(),
              db.getAppRules(),
              db.getDns(),
              settings
            );
            const started = await core.start(config);
            if (started) {
              await SystemProxy.enable('127.0.0.1', settings.mixedPort, settings.systemProxyBypassLan, settings.customBypassList);
              this.applyWindowIcon(true);
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
          db.saveSettings({ tunEnabled: newState });
          if (core.getState() === 'running') {
            const config = ConfigGenerator.generate(
              activeNodeId,
              nodes,
              db.getRules(),
              db.getAppRules(),
              db.getDns(),
              { ...settings, tunEnabled: newState }
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
          this.mainWindow?.show();
          this.mainWindow?.focus();
        },
      },
      {
        label: '退出 BlueBird',
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
