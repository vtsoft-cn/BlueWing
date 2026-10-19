import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import dns from 'dns';
import { spawn } from 'child_process';
import { Database } from './db/Database';
import { resolveDataDir } from './system/DataDirResolver';
import { resourcePath } from './branding';
import { SingBoxManager } from './core/SingBoxManager';
import { ConfigGenerator } from './core/ConfigGenerator';
import { ProxySelectionService } from './core/ProxySelectionService';
import { RuleSetUpdater } from './core/RuleSetUpdater';
import { SystemProxy } from './system/SystemProxy';
import { TakeoverLinkage } from './system/TakeoverLinkage';
import { ProcessScanner } from './system/ProcessScanner';
import { TcpPing } from './net/TcpPing';
import { SpeedTestRunner } from './net/SpeedTestRunner';
import { WebDAVSyncService } from './net/WebDAVSyncService';
import { BackupMigrator } from './db/BackupMigrator';
import { BackupService } from './db/backup/BackupService';
import { SubscriptionFetcher } from './net/SubscriptionFetcher';
import { UniversalSubscriptionParser } from './net/UniversalSubscriptionParser';
import { TrayManager } from './tray/TrayManager';
import { TrafficStats, Subscription } from '../types';
import { LogManager } from './log/LogManager';

let mainWindow: BrowserWindow | null = null;
let trafficTimer: NodeJS.Timeout | null = null;
let startTime: number = 0;
let totalRx: number = 0;
let totalTx: number = 0;

// 数据目录:便携优先(exe 同级 data/),不可写回退 %APPDATA%;含前向迁移与搁浅迁移规则
// (详见 system/DataDirResolver.ts)。必须在 app ready 之前设置:Chromium 配置
// (缓存/Cookie)、Database、LogManager、SystemProxy 全部跟随此目录。
const exeDir = path.dirname(process.execPath || '');
const portableDataDir = path.join(exeDir, 'data');
const fallbackDataDir = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
  'BlueWingConnect'
);
const { dir: appDataDir } = resolveDataDir(portableDataDir, fallbackDataDir);
process.env.BLUEWING_DATA_DIR = appDataDir;
app.setPath('userData', appDataDir);

// 安装器在向导阶段被取消时,data/ 可能仍留在同级 BlueWingDataUpgrade 暂存里
// (安装器无法挂钩取消事件):启动时发现便携 data/ 没有数据库而暂存里有,
// 自动收回——否则用户面对空配置,且暂存会在下次安装时被当作过期遗留删除。
if (appDataDir === portableDataDir) {
  try {
    const stashDir = path.join(exeDir, '..', 'BlueWingDataUpgrade');
    if (
      !fs.existsSync(path.join(portableDataDir, 'bluewing.json')) &&
      fs.existsSync(path.join(stashDir, 'bluewing.json'))
    ) {
      fs.cpSync(stashDir, portableDataDir, { recursive: true });
      fs.rmSync(stashDir, { recursive: true, force: true });
    }
  } catch {
    // 收回失败不阻断启动:暂存原样保留,留给下次安装或启动重试
  }
}

// 单实例锁:已有实例在跑时,二次启动直接退出(不做任何清理,那是已运行实例的职责),
// 并由已运行实例在 second-instance 事件里弹出/聚焦已有窗口,而不是创建新窗口。
// 锁竞争兜底:提权重启等场景下,新实例可能在旧实例(退出清理含核心停止/代理还原,
// 偶发可达数十秒)完全释放锁之前启动——立即退出会表现为"应用退出后再也没起来"。
// 短等重试吸收时序抖动,10 秒仍拿不到锁才放弃;whenReady 在锁落定前绝不初始化,
// 保证重试期间不闪窗(与 --bb-shutdown 的零闪窗承诺同一约束)。
let isSecondaryInstance = false;
const lockSettled = (async (): Promise<boolean> => {
  if (app.requestSingleInstanceLock()) return true;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
})();

/**
 * 检测其他安装路径的青翼连接实例(如尚未卸载的旧版本)。
 * requestSingleInstanceLock 只能约束实现了锁的实例——旧版本没有锁代码,检测不到,
 * 双开会互相覆盖系统代理注册表/抢占核心端口。发现异路径实例时弹窗提示并退出。
 */
async function warnAndExitIfForeignInstance(): Promise<void> {
  if (process.platform !== 'win32') return;
  return new Promise((resolve) => {
    const script = `Get-Process 'BlueWing Connect' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Group-Object Path | ForEach-Object { $_.Name }`;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let stdout = '';
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve();
    }, 3000);
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.on('close', () => {
      clearTimeout(timer);
      const paths = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && s.toLowerCase() !== process.execPath.toLowerCase());
      if (paths.length > 0) {
        dialog.showMessageBoxSync({
          type: 'warning',
          title: '检测到另一个青翼连接实例',
          message: `检测到另一个安装路径的 青翼连接 BlueWing Connect 正在运行,两个实例会互相覆盖系统代理设置:\n\n${paths.join('\n')}\n\n请先退出另一个实例,再打开本版本。`,
          buttons: ['确定'],
        });
        LogManager.getInstance().addLog(
          'warn',
          `检测到其他安装路径的青翼连接实例,已退出本实例: ${paths.join(' | ')}`,
          'app'
        );
        app.exit(0);
      }
      resolve();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function getWindowIcon(): string {
  return resourcePath('ico.ico') ?? '';
}

function createWindow(): void {
  const iconPath = getWindowIcon();

  // 窗口底色跟随主题设置,避免内容绘制前的颜色闪变(system 用 Electron nativeTheme 判定)
  let themeSetting: string = 'system';
  try {
    themeSetting = Database.getInstance().getSettings().theme || 'system';
  } catch {}
  const darkStart = themeSetting === 'dark' || (themeSetting === 'system' && nativeTheme.shouldUseDarkColors);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    // 页头(36px)占用纵向空间,最小/最大高度相应上移,保证内容区可用高度不变
    minHeight: 680,
    // 窗口尺寸上限:配合禁用最大化,避免在大屏上过度铺开
    maxWidth: 1600,
    maxHeight: 1040,
    frame: false,
    title: '青翼连接 BlueWing Connect',
    // 固定尺寸窗口:只保留最小化/关闭,不提供最大化
    maximizable: false,
    show: false,
    backgroundColor: darkStart ? '#020617' : '#f8fafc',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  LogManager.getInstance().setMainWindow(mainWindow);

  // 页头拖动兜底:窗口失焦(如 Alt+Tab)或关闭时停止移动循环,避免失控
  mainWindow.on('blur', stopHeaderDrag);
  mainWindow.on('closed', stopHeaderDrag);

  // Open any external http(s) links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('close', (e) => {
    // 退出流程中必须放行窗口关闭,否则 app.quit() 会被此处中止,
    // 界面隐藏进托盘但所有进程残留(用户表现为"退出了但进程还在")
    const settings = Database.getInstance().getSettings();
    if (settings.closeToTray && !isAppQuitting) {
      e.preventDefault();
      // Windows 下在 close 事件里同步 hide(),shell 会为这个"正在关闭"的窗口在
      // 任务栏残留一个点击无响应的死按钮(窗口已隐藏但按钮不消失):
      // 显式摘除任务栏按钮再隐藏,所有恢复显示路径统一挂回
      mainWindow?.setSkipTaskbar(true);
      mainWindow?.hide();
    }
  });

  TrayManager.getInstance().init(mainWindow);
}

let isAppQuitting = false;

app.whenReady().then(async () => {
  // 锁未落定前不得做任何初始化(重试期间 app 可能已 ready,必须在此等待)
  if (!(await lockSettled)) {
    isSecondaryInstance = true;
    app.exit(0);
    return;
  }
  if (process.argv.includes('--bb-shutdown')) {
    // --bb-shutdown 作为首实例 = 没有运行中的实例可通知;立即退出,绝不启动完整
    // 应用(否则安装器的信号任务会凭空拉起应用主窗口一闪而过,用户看到"闪退")
    app.exit(0);
    return;
  }
  app.on('second-instance', (_e, commandLine) => {
    // 安装器升级信号:让位于安装流程,退出前由 before-quit 统一清理
    // (还原系统代理、停止核心),避免被强杀导致系统代理残留断网
    if (commandLine.includes('--bb-shutdown')) {
      LogManager.getInstance().addLog('info', '收到安装器升级请求,还原系统代理后退出', 'system');
      app.quit();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // 窗口可能处于关闭进托盘的隐藏状态(任务栏按钮已摘除),显示前挂回
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
  });

  await warnAndExitIfForeignInstance();

  createWindow();

  let lastSampleTime = 0;
  let lastDownloadTotal = 0;
  let lastUploadTotal = 0;
  let hasSampledBefore = false;

  // Real traffic & connections polling loop
  trafficTimer = setInterval(async () => {
    const core = SingBoxManager.getInstance();
    if (core.getState() === 'running') {
      if (!startTime) {
        startTime = Date.now();
        lastSampleTime = Date.now();
        hasSampledBefore = false;
      }
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const settings = Database.getInstance().getSettings();
      const port = settings.clashApiPort || 9090;
      const secret = settings.clashApiSecret;

      let rx = 0;
      let tx = 0;
      let activeConnections = 0;

      try {
        const stats = await fetchClashConnections(port, secret);
        const now = Date.now();
        const elapsedSec = (now - lastSampleTime) / 1000;

        if (hasSampledBefore && elapsedSec > 0) {
          rx = Math.max(0, Math.round((stats.downloadTotal - lastDownloadTotal) / elapsedSec));
          tx = Math.max(0, Math.round((stats.uploadTotal - lastUploadTotal) / elapsedSec));
        }

        lastDownloadTotal = stats.downloadTotal;
        lastUploadTotal = stats.uploadTotal;
        lastSampleTime = now;
        hasSampledBefore = true;

        totalRx = stats.downloadTotal;
        totalTx = stats.uploadTotal;
        activeConnections = stats.connectionsCount;
      } catch {
        // Core might be starting up or shutting down; output true 0, never mock
        rx = 0;
        tx = 0;
        activeConnections = 0;
      }

      // Real node latency from active node if tested
      const activeNodeId = Database.getInstance().getActiveNodeId();
      const activeNode = Database.getInstance().getNodes().find((n) => n.id === activeNodeId);
      const latency = activeNode && activeNode.ping && activeNode.ping > 0 ? activeNode.ping : 0;

      const traffic: TrafficStats = {
        downloadSpeed: rx,
        uploadSpeed: tx,
        totalDownload: totalRx,
        totalUpload: totalTx,
        latency,
        uptime,
        activeConnections,
      };

      mainWindow?.webContents.send('core:traffic', traffic);
    } else {
      startTime = 0;
      hasSampledBefore = false;
    }
  }, 1000);

  // 清理上次异常退出残留的核心进程,避免占用端口导致本次启动失败
  await SingBoxManager.getInstance().cleanupOrphanCores();

  // 订阅自动更新调度(此前 UI 的"自动更新"开关没有任何后端实现)
  const autoUpdateInitial = setTimeout(() => {
    checkSubscriptionAutoUpdates();
    const timer = setInterval(checkSubscriptionAutoUpdates, 30 * 60 * 1000);
    timer.unref();
  }, 60 * 1000);
  autoUpdateInitial.unref();

  // Check and clean residual system proxy if core is not active
  const settings = Database.getInstance().getSettings();
  if (!settings.autoConnectOnLaunch) {
    SystemProxy.checkAndCleanResidual(settings.mixedPort || 2080);
  } else {
    // 自启连接是用户的常设意愿,等同显式发起(允许连接意图保护兜底)
    handleCoreStart({ userInitiated: true });
  }
});

app.on('before-quit', async (e) => {
  if (isSecondaryInstance) {
    return;
  }
  if (!isAppQuitting) {
    e.preventDefault();
    isAppQuitting = true;
    if (trafficTimer) {
      clearInterval(trafficTimer);
      trafficTimer = null;
    }
    try {
      Database.getInstance().flush();
      await handleCoreStop();
      await SystemProxy.restoreOriginal();
      await LogManager.getInstance().destroy();
      TrayManager.getInstance().destroy();
    } catch (err) {
      console.error('Error during cleanup on quit:', err);
    }
    app.quit();
  }
});

function fetchClashConnections(
  port: number,
  secret?: string
): Promise<{ downloadTotal: number; uploadTotal: number; connectionsCount: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (secret) {
      headers['Authorization'] = `Bearer ${secret}`;
    }
    const req = http.get(
      `http://127.0.0.1:${port}/connections`,
      { headers, timeout: 800 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              downloadTotal: typeof parsed.downloadTotal === 'number' ? parsed.downloadTotal : 0,
              uploadTotal: typeof parsed.uploadTotal === 'number' ? parsed.uploadTotal : 0,
              connectionsCount: Array.isArray(parsed.connections) ? parsed.connections.length : 0,
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function handleCoreStop(): Promise<boolean> {
  const core = SingBoxManager.getInstance();
  const settings = Database.getInstance().getSettings();
  await core.stop();
  if (settings.systemProxyEnabled) {
    await SystemProxy.disable();
    LogManager.getInstance().addLog('info', 'Windows 系统代理已关闭', 'system');
  }
  LogManager.getInstance().addLog('info', '代理核心引擎已停止连接', 'core');
  TrayManager.getInstance().updateMenu();
  return true;
}

/**
 * 节点集合变化后,若原活跃节点已被删除(saveNodes 回落只改数据库,不碰运行中的核心):
 * - 广播 node:changed 同步渲染层高亮(此前仅手动切换路径广播,删除路径渲染层会停留在已删节点);
 * - 核心运行中:热切换到回落节点(运行配置本就含全部节点 outbound,通常瞬时完成,失败自动重载核心);
 * - 节点被全部删除:停核心并断开系统代理,避免核心继续用已删节点出流量而界面显示无节点。
 * coreAlreadyConsistent:订阅更新按服务器地址保留活跃节点时,运行中核心仍走同一服务器,不打断连接。
 */
async function syncActiveNodeAfterNodesReplaced(
  prevActiveId: string,
  options?: { coreAlreadyConsistent?: boolean }
): Promise<void> {
  const db = Database.getInstance();
  // 原活跃节点仍在列表(普通编辑/测速/排序):无需任何同步
  if (!prevActiveId || db.getNodes().some((n) => n.id === prevActiveId)) return;

  const newActiveId = db.getActiveNodeId();
  mainWindow?.webContents.send('node:changed', newActiveId);

  if (options?.coreAlreadyConsistent) return;
  if (SingBoxManager.getInstance().getState() !== 'running') return;

  if (!newActiveId) {
    LogManager.getInstance().addLog(
      'warn',
      '节点列表已全部删除,停止代理核心并断开系统代理',
      'app'
    );
    await handleCoreStop();
    return;
  }

  const target = db.getNodes().find((n) => n.id === newActiveId);
  LogManager.getInstance().addLog(
    'info',
    `活跃节点被删除,已自动切换至: ${target?.name ?? newActiveId}`,
    'app'
  );
  await ProxySelectionService.selectNode(newActiveId);
}

/**
 * 节点列表任何主进程侧变更后统一广播全量列表。
 * 渲染层不再回传全量列表(旧 nodes:save 与订阅自动更新并发时会用过期列表覆盖新节点,
 * 且自动更新后渲染层列表过期、点击旧节点报"节点不存在"),以主进程为唯一事实源。
 */
function broadcastNodesChanged(): void {
  mainWindow?.webContents.send('nodes:changed', Database.getInstance().getNodes());
}

/**
 * 主进程侧改动设置(连接意图保护补开/托盘开关等)后同步渲染层,
 * 避免 UI 开关与数据库/注册表真实状态错位(渲染层只知道自己发起的保存)。
 */
function broadcastSettingsChanged(): void {
  mainWindow?.webContents.send('settings:changed', Database.getInstance().getSettings());
}

/**
 * 备份导入/恢复会整体替换节点(乃至订阅/规则/DNS/设置):成功后同步托盘与全部
 * 渲染层状态,并在活跃节点被替换时同步运行中核心(与删除路径同一套回落语义)。
 */
async function runBackupImport<T>(fn: () => Promise<T> | T): Promise<T> {
  const db = Database.getInstance();
  const prevActiveId = db.getActiveNodeId();
  const res = await fn();
  if (!res || (res as any).success !== false) {
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
    mainWindow?.webContents.send('subs:changed', db.getSubscriptions());
    broadcastSettingsChanged();
    mainWindow?.webContents.send('rules:changed', db.getRules());
    mainWindow?.webContents.send('apprules:changed', db.getAppRules());
    mainWindow?.webContents.send('dns:changed', db.getDns());
    syncActiveNodeAfterNodesReplaced(prevActiveId).catch((e: any) =>
      LogManager.getInstance().addLog(
        'error',
        `备份导入后同步切换活跃节点失败: ${e?.message || e}`,
        'app'
      )
    );
  }
  return res;
}

async function handleCoreStart(options?: { userInitiated?: boolean }): Promise<boolean> {
  const db = Database.getInstance();
  const core = SingBoxManager.getInstance();
  const settings = db.getSettings();
  const nodes = db.getNodes();
  const activeNodeId = db.getActiveNodeId();

  if (nodes.length === 0) {
    LogManager.getInstance().addLog(
      'warn',
      '【提示】当前节点列表中暂无可用节点。建议先添加或更新订阅后再进行连接。',
      'app'
    );
  }

  // 连接意图保护:仅用户显式发起的连接(core:start/重启/自启/托盘连接)且系统代理与
  // TUN 都未启用时,才自动补开系统代理开关——否则点"连接"后流量没有任何出口,
  // 界面却显示"已连接"。设置/规则变更触发的重载绝不能触碰用户的代理开关:
  // 连接中主动关闭系统代理的意图必须被尊重(此前重载即被强制重开,注册表与 UI 错位)。
  if (SystemProxy.shouldAutoEnableSystemProxy(options?.userInitiated === true, settings)) {
    settings.systemProxyEnabled = true;
    db.saveSettings({ systemProxyEnabled: true });
    broadcastSettingsChanged();
    LogManager.getInstance().addLog(
      'info',
      '系统代理开关未启用,已自动开启以使本次连接生效(可在首页随时关闭)',
      'app'
    );
  }

  const config = ConfigGenerator.generate(
    activeNodeId,
    nodes,
    db.getRules(),
    db.getAppRules(),
    db.getDns(),
    settings
  );

  LogManager.getInstance().addLog('info', '正在启动 Sing-box 核心代理引擎...', 'app');
  let started = await core.start(config);
  if (!started) {
    // 规则源下载被间歇性重置等瞬时故障:自动重试一次,避免用户手动反复点击
    LogManager.getInstance().addLog('warn', '核心首次启动失败,2 秒后自动重试一次...', 'core');
    await new Promise((r) => setTimeout(r, 2000));
    started = await core.start(config);
  }
  if (started) {
    LogManager.getInstance().addLog('info', '代理核心引擎已就绪并接管网络流量', 'core');
    if (settings.systemProxyEnabled) {
      await SystemProxy.enable(
        '127.0.0.1',
        settings.mixedPort,
        settings.systemProxyBypassLan,
        settings.customBypassList
      );
      LogManager.getInstance().addLog('info', `Windows 系统代理已开启 (127.0.0.1:${settings.mixedPort})`, 'system');
    }
    // 保护性兜底:配置含 TUN 但因非管理员权限被剥除,且系统代理为关——自动开启
    // 系统代理,兑现"已安全回退为系统代理模式"的日志承诺,避免连接空转无出口
    if (core.wasTunStrippedLastStart() && (await TakeoverLinkage.ensureProxyWhenTunStripped())) {
      broadcastSettingsChanged();
    }
  } else {
    LogManager.getInstance().addLog('error', 'Sing-box 核心启动失败，请检查配置或日志详情', 'core');
  }
  TrayManager.getInstance().updateMenu();
  return started;
}

// -------------------------------------------------------------
// IPC Handlers
// -------------------------------------------------------------

// Logs
ipcMain.handle('log:getAll', () => LogManager.getInstance().getLogs());
ipcMain.handle('log:clear', () => {
  LogManager.getInstance().clearLogs();
  return true;
});
ipcMain.handle('log:export', async () => {
  return LogManager.getInstance().exportLogs();
});

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());

// 页头手动拖动:Chromium/Electron 缺陷(electron#40610 等)——内容区一旦发生滚动,
// draggable regions 缓存与实际位置错位且不再重发,-webkit-app-region 的页头拖动随之失效
// (渲染层任何强制重算手段均无效,实测仅 scrollTop 归零才恢复)。因此页头不再依赖
// app-region,改为渲染层 pointerdown 通知主进程,由主进程跟随光标移动窗口,完全绕开该缺陷。
// 本应用为固定尺寸窗口(不可最大化),不涉及磁贴吸附,无原生标题栏拖动的额外能力损失。
let headerDrag: { win: BrowserWindow; offX: number; offY: number; w: number; h: number; last: Electron.Point; timer: NodeJS.Timeout; startedAt: number } | null = null;
const stopHeaderDrag = () => {
  if (!headerDrag) return;
  clearInterval(headerDrag.timer);
  headerDrag = null;
};
ipcMain.on('window:drag-begin', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || headerDrag) return;
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  headerDrag = {
    win,
    offX: pt.x - b.x,
    offY: pt.y - b.y,
    w: b.width,
    h: b.height,
    last: pt,
    startedAt: Date.now(),
    timer: setInterval(() => {
      const d = headerDrag;
      if (!d || d.win.isDestroyed()) return stopHeaderDrag();
      // 兜底:渲染层异常导致 pointerup 丢失时,30 秒后强制结束,避免窗口无限跟随光标
      if (Date.now() - d.startedAt > 30_000) return stopHeaderDrag();
      const p = screen.getCursorScreenPoint();
      if (p.x === d.last.x && p.y === d.last.y) return;
      d.last = p;
      d.win.setBounds({ x: p.x - d.offX, y: p.y - d.offY, width: d.w, height: d.h });
    }, 10),
  };
});
ipcMain.on('window:drag-end', stopHeaderDrag);
ipcMain.handle('system:openExternal', (_, url: string) => {
  if (url && (url.startsWith('http:') || url.startsWith('https:'))) {
    shell.openExternal(url);
    return true;
  }
  return false;
});
ipcMain.handle('system:isAdmin', () => SingBoxManager.getInstance().isAdmin());
ipcMain.handle('system:relaunchAsAdmin', () => {
  const execPath = process.execPath.replace(/'/g, "''");
  const elevateLog = path.join(Database.getInstance().getDataDir(), 'logs', 'elevate-relaunch.log').replace(/'/g, "''");
  // 由独立 PowerShell 守候:等本进程完全退出(含 before-quit 的核心停止/系统代理
  // 还原清理)后再拉起提权实例,避免新旧实例争抢单实例锁。
  // 修复:旧实现仅等 15s,清理偶发超时(核心停止挂起等)时提权实例过早启动,
  // 撞单实例锁后静默退出——表现为"应用退出了但没以管理员启动"。现等待上限提至
  // 60s,每步留痕到 logs/elevate-relaunch.log 便于排查;用户拒绝 UAC 则回落
  // 普通权限重启,至少保证应用能回来(单实例锁侧另有 10s 重试兜底吸收残余抖动)。
  const script = [
    `try { Add-Content -Path '${elevateLog}' -Value ("[{0}] relaunch begin, oldPid=${process.pid}" -f (Get-Date -Format o)) } catch {}`,
    `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 800',
    `try { Start-Process -FilePath '${execPath}' -Verb RunAs -ErrorAction Stop }`,
    'catch {',
    `  try { Add-Content -Path '${elevateLog}' -Value ("[{0}] runas failed: {1}" -f (Get-Date -Format o), $_.Exception.Message) } catch {}`,
    '  Start-Sleep -Seconds 1',
    `  try { Start-Process -FilePath '${execPath}' } catch {}`,
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  LogManager.getInstance().addLog('info', '正在请求管理员权限并重启应用...', 'app');
  setTimeout(() => app.quit(), 200);
  return true;
});
ipcMain.handle('system:flushDns', async () => {
  return new Promise((resolve) => {
    const cp = spawn('ipconfig.exe', ['/flushdns'], { windowsHide: true });
    cp.on('close', (code) => {
      if (code === 0) {
        LogManager.getInstance().addLog('info', 'Windows 本地 DNS 缓存已成功刷新 (ipconfig /flushdns)', 'system');
        resolve({ success: true, message: 'Windows 本地 DNS 缓存已成功刷新！' });
      } else {
        LogManager.getInstance().addLog('warn', `刷新 DNS 缓存返回代码: ${code}`, 'system');
        resolve({ success: false, message: `刷新失败，退出代码: ${code}` });
      }
    });
    cp.on('error', (err) => {
      LogManager.getInstance().addLog('warn', `刷新 DNS 缓存失败: ${err.message}`, 'system');
      resolve({ success: false, message: err.message });
    });
  });
});
ipcMain.handle('system:getAppVersion', () => app.getVersion());

// Core
ipcMain.handle('core:start', async () => handleCoreStart({ userInitiated: true }));
ipcMain.handle('core:stop', async () => handleCoreStop());
ipcMain.handle('core:restart', async () => {
  await handleCoreStop();
  return handleCoreStart({ userInitiated: true });
});
ipcMain.handle('core:getState', () => SingBoxManager.getInstance().getState());
ipcMain.handle('core:getVersion', () => SingBoxManager.getInstance().getVersion());
ipcMain.handle('core:getLiveConfig', () => SingBoxManager.getInstance().getLiveConfig());
ipcMain.handle('core:validateConfig', () => {
  const db = Database.getInstance();
  const config = ConfigGenerator.generate(
    db.getActiveNodeId(),
    db.getNodes(),
    db.getRules(),
    db.getAppRules(),
    db.getDns(),
    db.getSettings()
  );
  return SingBoxManager.getInstance().validate(config);
});

// Forward core state change
SingBoxManager.getInstance().on('stateChange', (state) => {
  mainWindow?.webContents.send('core:stateChange', state);
});

// Nodes
// 渲染层全部走定向操作;主进程变更后广播 nodes:changed,渲染层订阅刷新。
// 字段补丁不触发托盘重建(托盘只展示名称/类型,补丁不触及);增/删/整体替换才更新托盘。
ipcMain.handle('nodes:getAll', () => Database.getInstance().getNodes());
ipcMain.handle('nodes:updateFields', (_, id, patch) => {
  const ok = Database.getInstance().updateNodeFields(id, patch);
  if (ok) broadcastNodesChanged();
  return ok;
});
ipcMain.handle('nodes:bulkUpdateFields', (_, patches) => {
  const applied = Database.getInstance().bulkUpdateNodeFields(patches);
  if (applied > 0) broadcastNodesChanged();
  return applied;
});
ipcMain.handle('nodes:updateFull', (_, node) => {
  const ok = Database.getInstance().updateNode(node);
  if (ok) {
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
  }
  return ok;
});
ipcMain.handle('nodes:add', (_, node) => {
  Database.getInstance().addNode(node);
  TrayManager.getInstance().updateMenu();
  broadcastNodesChanged();
  return true;
});
ipcMain.handle('nodes:delete', (_, id) => {
  const db = Database.getInstance();
  const prevActiveId = db.getActiveNodeId();
  const deleted = db.deleteNode(id);
  if (deleted) {
    // 节点列表变化后同步托盘菜单,避免显示过期列表
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
    // 活跃节点被删除时同步运行中核心与渲染层;普通删除场景原活跃节点仍在,零开销返回
    syncActiveNodeAfterNodesReplaced(prevActiveId).catch((e: any) =>
      LogManager.getInstance().addLog(
        'error',
        `删除节点后同步切换活跃节点失败: ${e?.message || e}`,
        'app'
      )
    );
  }
  return deleted;
});
ipcMain.handle('nodes:getActiveId', () => Database.getInstance().getActiveNodeId());
ipcMain.handle('nodes:setActiveId', async (_, id) => {
  const res = await ProxySelectionService.selectNode(id);
  mainWindow?.webContents.send('node:changed', id);
  return res.success;
});
ipcMain.handle('nodes:ping', (_, host, port) => TcpPing.ping(host, port));
ipcMain.handle('nodes:batchPing', (_, list) => TcpPing.batchPing(list, 10));

// Subscriptions
ipcMain.handle('subs:getAll', () => Database.getInstance().getSubscriptions());
ipcMain.handle('subs:save', (_, subs) => {
  const db = Database.getInstance();
  // 渲染层全量回传可能基于过期快照:保留主进程侧后台自动更新的状态字段,
  // 避免并发时把 status/lastUpdate/nodeCount 回退(增删改语义不受影响)
  const cur = new Map(db.getSubscriptions().map((s) => [s.id, s]));
  const merged = subs.map((s: Subscription) => {
    const c = cur.get(s.id);
    return c
      ? { ...s, status: c.status, lastUpdate: c.lastUpdate, nodeCount: c.nodeCount, errorMessage: c.errorMessage }
      : s;
  });
  db.saveSubscriptions(merged);
});
ipcMain.handle('subs:delete', (_, id) => {
  const db = Database.getInstance();
  const prevActiveId = db.getActiveNodeId();
  const deleted = db.deleteSubscriptionCascade(id);
  // 节点列表变化后同步托盘菜单,避免显示过期列表
  if (deleted) {
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
    // 级联删除可能删掉活跃节点:同步运行中核心与渲染层
    syncActiveNodeAfterNodesReplaced(prevActiveId).catch((e: any) =>
      LogManager.getInstance().addLog(
        'error',
        `删除订阅后同步切换活跃节点失败: ${e?.message || e}`,
        'app'
      )
    );
  }
  return deleted;
});

// 正在更新中的订阅(防止手动更新与自动调度并发重入)。
// 后到者共享同一次在途更新的 Promise 并等待其真实结果:
// 若像互斥锁那样直接返回 false,手动刷新撞上后台自动更新时会立刻弹出
// 上一次失败遗留的 errorMessage,看起来像"没有重新刷新、直接报订阅地址有问题"。
const subscriptionUpdatesInFlight = new Map<string, Promise<boolean>>();

function updateSubscriptionById(id: string): Promise<boolean> {
  const inFlight = subscriptionUpdatesInFlight.get(id);
  if (inFlight) return inFlight;
  const p = doUpdateSubscription(id).finally(() => {
    subscriptionUpdatesInFlight.delete(id);
  });
  subscriptionUpdatesInFlight.set(id, p);
  return p;
}

/** 到期检查:对开启"自动更新"且超出更新间隔的订阅执行后台更新 */
function checkSubscriptionAutoUpdates(): void {
  const db = Database.getInstance();
  const due = db.getSubscriptions().filter(
    (s) =>
      s.autoUpdate &&
      s.url &&
      Date.now() - (s.lastUpdate || 0) > (s.updateIntervalHours || 24) * 3600_000
  );
  if (due.length === 0) return;
  LogManager.getInstance().addLog('info', `订阅自动更新: ${due.length} 个订阅已到期,开始后台更新`, 'app');
  (async () => {
    for (const s of due) {
      const ok = await updateSubscriptionById(s.id);
      LogManager.getInstance().addLog(
        ok ? 'info' : 'warn',
        `订阅自动更新 ${s.name}: ${ok ? '成功' : '失败'}`,
        'app'
      );
    }
  })();
}

async function doUpdateSubscription(id: string): Promise<boolean> {
  const db = Database.getInstance();
  const subs = db.getSubscriptions();
  const target = subs.find((s) => s.id === id);
  if (!target || !target.url) return false;

  // 拉取期间订阅被删除:丢弃结果,防止写回过期数组把已删订阅及其节点复活
  const subDeleted = () => !db.getSubscriptions().some((s) => s.id === id);

  try {
    target.status = 'updating';
    db.saveSubscriptions(subs);

    const settings = db.getSettings();
    const result = await SubscriptionFetcher.fetch(target.url, settings.mixedPort);

    if (subDeleted()) return false;

    const newNodes = UniversalSubscriptionParser.parse(result.content);

    if (newNodes.length > 0) {
      newNodes.forEach((n) => (n.groupId = target.id));

      // 按服务器地址匹配旧节点,继承测速数据(ping/延迟/下载速度)
      const oldGroupNodes = db.getNodes().filter((n) => n.groupId === target.id);
      const nodeKey = (n: { server?: string; port?: number }) => `${n.server || ''}:${n.port || ''}`;
      const oldByKey = new Map(oldGroupNodes.filter((n) => n.server).map((n) => [nodeKey(n), n]));
      const prevActiveId = db.getActiveNodeId();
      const oldActive = oldGroupNodes.find((n) => n.id === prevActiveId);
      for (const n of newNodes) {
        const old = n.server ? oldByKey.get(nodeKey(n)) : undefined;
        if (old) {
          if (old.ping !== undefined) n.ping = old.ping;
          if (old.httpLatency !== undefined) n.httpLatency = old.httpLatency;
          if (old.downloadSpeed !== undefined) n.downloadSpeed = old.downloadSpeed;
        }
      }

      const otherNodes = db.getNodes().filter((n) => n.groupId !== target.id);
      db.saveNodes([...otherNodes, ...newNodes]);

      // 保持活跃节点:更新后 ID 会变,按服务器地址映射到新节点
      let keptActiveOnSameServer = false;
      if (oldActive && oldActive.server) {
        const matched = newNodes.find((n) => nodeKey(n) === nodeKey(oldActive));
        if (matched) {
          db.setActiveNodeId(matched.id);
          keptActiveOnSameServer = true;
          LogManager.getInstance().addLog(
            'info',
            `订阅更新完成,活跃节点已自动保持: ${matched.name}`,
            'app'
          );
        } else {
          LogManager.getInstance().addLog(
            'warn',
            `订阅更新后原活跃节点 ${oldActive.name} 已不存在,已回落到列表首节点`,
            'app'
          );
        }
      }

      target.nodeCount = newNodes.length;
      target.lastUpdate = Date.now();
      target.status = 'success';
      target.errorMessage = undefined;
      db.saveSubscriptions(subs);
      // 节点列表已整体替换,同步托盘菜单与渲染层(含后台自动更新场景)
      TrayManager.getInstance().updateMenu();
      broadcastNodesChanged();
      mainWindow?.webContents.send('subs:changed', subs);
      // 活跃节点随更新被删/重映射:同步渲染层;运行中核心仅在未能保留原服务器时才切换
      syncActiveNodeAfterNodesReplaced(prevActiveId, {
        coreAlreadyConsistent: keptActiveOnSameServer,
      }).catch((e: any) =>
        LogManager.getInstance().addLog(
          'error',
          `订阅更新后同步切换活跃节点失败: ${e?.message || e}`,
          'app'
        )
      );
      return true;
    } else {
      target.status = 'error';
      target.errorMessage = '未能从订阅源解析出有效节点';
      db.saveSubscriptions(subs);
      mainWindow?.webContents.send('subs:changed', subs);
      return false;
    }
  } catch (e: any) {
    if (subDeleted()) return false;
    target.status = 'error';
    target.errorMessage = e.message || '更新订阅失败';
    db.saveSubscriptions(subs);
    mainWindow?.webContents.send('subs:changed', subs);
    return false;
  }
}

ipcMain.handle('subs:update', (_, id) => updateSubscriptionById(id));

// Routing & Apps
ipcMain.handle('routing:getRules', () => Database.getInstance().getRules());
ipcMain.handle('routing:saveRules', (_, rules) => {
  Database.getInstance().saveRules(rules);
  // 核心运行中:自动重载使新规则立即生效(修复:此前改动需手动重连才生效)
  if (SingBoxManager.getInstance().getState() === 'running') {
    handleCoreStart();
  }
});
ipcMain.handle('routing:getAppRules', () => Database.getInstance().getAppRules());
ipcMain.handle('routing:saveAppRules', (_, rules) => {
  Database.getInstance().saveAppRules(rules);
  if (SingBoxManager.getInstance().getState() === 'running') {
    handleCoreStart();
  }
});
ipcMain.handle('routing:getRunningApps', () => ProcessScanner.getRunningProcesses());
ipcMain.handle('rules:updateRuleSets', async () => {
  const res = await RuleSetUpdater.updateAll();
  // 有更新且核心运行中:重载配置使新规则数据立即生效
  if (res.updated.length > 0 && SingBoxManager.getInstance().getState() === 'running') {
    await handleCoreStart();
  }
  return res;
});

// DNS
ipcMain.handle('dns:get', () => Database.getInstance().getDns());
ipcMain.handle('dns:save', (_, dns) => {
  Database.getInstance().saveDns(dns);
  if (SingBoxManager.getInstance().getState() === 'running') {
    handleCoreStart();
  }
});
ipcMain.handle('dns:testResolve', async (_, domain: string) => {
  const start = Date.now();
  try {
    const addresses = await dns.promises.resolve4(domain);
    const duration = Date.now() - start;
    return {
      success: true,
      ip: addresses[0] || '无返回记录',
      allIps: addresses,
      latency: duration,
    };
  } catch (e: any) {
    try {
      const res = await dns.promises.lookup(domain);
      const duration = Date.now() - start;
      return {
        success: true,
        ip: res.address,
        allIps: [res.address],
        latency: duration,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || '域名解析失败',
        latency: Date.now() - start,
      };
    }
  }
});

// Speed Test
ipcMain.handle('speedtest:latency', (_, url, nodeId) => {
  const db = Database.getInstance();
  const settings = db.getSettings();
  const node = nodeId ? db.getNodes().find((n) => n.id === nodeId) : undefined;
  const testUrl = url || settings.testUrl || 'http://cp.cloudflare.com/generate_204';
  const timeoutMs = settings.testTimeoutMs || 5000;
  return SpeedTestRunner.testLatency(
    testUrl,
    timeoutMs,
    settings.mixedPort,
    nodeId,
    settings.clashApiPort || 9090,
    node?.server,
    node?.port
  );
});
ipcMain.handle('speedtest:download', (_, url, nodeId) => {
  const settings = Database.getInstance().getSettings();
  const downloadUrl = url || 'http://speed.cloudflare.com/__down?bytes=5000000';
  return SpeedTestRunner.testDownload(
    downloadUrl,
    4,
    settings.mixedPort,
    nodeId,
    settings.clashApiPort || 9090
  );
});
ipcMain.handle('speedtest:cancel', (_, nodeId) => SpeedTestRunner.cancel(nodeId));

// WebDAV
ipcMain.handle('webdav:test', async (_, cfg) => {
  return WebDAVSyncService.testConnection(cfg);
});
ipcMain.handle('webdav:backup', async () => {
  const res = await WebDAVSyncService.backup();
  if (!res.success) {
    throw new Error(res.message);
  }
  return true;
});
ipcMain.handle('webdav:restore', async () => {
  const res = await runBackupImport(() => WebDAVSyncService.restore());
  if (!res.success) {
    throw new Error(res.message);
  }
  return true;
});

// Backup
ipcMain.handle('backup:export', (_, categories) => BackupService.exportWindowsBackup(categories));
ipcMain.handle('backup:exportAndroid', (_, categories) => BackupService.exportAndroidBackup(categories));
ipcMain.handle('backup:previewImport', (_, content, categories) => BackupService.previewImport(content, categories));
ipcMain.handle('backup:importWithTransaction', (_, content, categories, mode) =>
  runBackupImport(() => BackupService.importWithTransaction(content, categories, mode))
);
ipcMain.handle('backup:createLocalBackup', () => BackupService.createLocalBackup());
ipcMain.handle('backup:restoreLocalBackup', () =>
  runBackupImport(() => BackupService.restoreLocalBackup())
);
ipcMain.handle('backup:getLatestLocalBackupInfo', () => BackupService.getLatestLocalBackupInfo());
ipcMain.handle('backup:import', (_, content) =>
  runBackupImport(() =>
    BackupService.importWithTransaction(content, { profiles: true, rules: true, settings: true })
  )
);
ipcMain.handle('backup:importLinks', (_, text) => {
  const nodes = BackupMigrator.parseNodeLinks(text);
  if (nodes.length > 0) {
    const db = Database.getInstance();
    db.saveNodes([...db.getNodes(), ...nodes]);
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
  }
  return nodes;
});

// Settings
ipcMain.handle('settings:get', () => Database.getInstance().getSettings());
ipcMain.handle('settings:save', async (_, s) => {
  const db = Database.getInstance();
  const prevSettings = { ...db.getSettings() };

  // TUN↔系统代理互斥联动(二选一):用户切换 TUN 的这次保存,联动调整系统代理开关。
  // 在落库前归一化,后续既有的 proxyChanged 分支自然完成注册表开关/核心拉起;
  // 核心重载路径不经过此处,不会触碰开关(与连接意图保护同一约束)。
  let linkageApplied = false;
  if (s.tunEnabled !== undefined && s.tunEnabled !== prevSettings.tunEnabled) {
    const patch = TakeoverLinkage.exclusivityPatch(
      prevSettings,
      {
        tunEnabled: s.tunEnabled,
        systemProxyEnabled: s.systemProxyEnabled ?? prevSettings.systemProxyEnabled,
      },
      SingBoxManager.getInstance().getState() === 'running'
    );
    if (patch) {
      Object.assign(s, patch);
      linkageApplied = true;
      LogManager.getInstance().addLog(
        'info',
        patch.systemProxyEnabled === false
          ? 'TUN 已开启,系统代理已联动关闭(TUN 全量接管流量)'
          : 'TUN 已关闭,系统代理已联动开启',
        'app'
      );
    }
  }
  // 反向联动(单选语义另一半):TUN 开着时用户开系统代理 → 联动关 TUN;
  // 落库前归一化,后续 coreConfigChanged(tunEnabled 变化)自然触发去 TUN 重载
  if (s.systemProxyEnabled !== undefined && s.systemProxyEnabled !== prevSettings.systemProxyEnabled) {
    const patch = TakeoverLinkage.proxyTogglePatch(prevSettings, {
      tunEnabled: s.tunEnabled ?? prevSettings.tunEnabled,
      systemProxyEnabled: s.systemProxyEnabled,
    });
    if (patch) {
      Object.assign(s, patch);
      linkageApplied = true;
      LogManager.getInstance().addLog(
        'info',
        '系统代理已开启,TUN 已联动关闭(二选一)',
        'app'
      );
    }
  }
  db.saveSettings(s);
  const currentSettings = db.getSettings();

  // 联动改写了渲染层未提交的字段(其本地乐观状态已过期),回推全量设置纠正
  if (linkageApplied) {
    broadcastSettingsChanged();
  }

  // 主题变化 → 立即刷新托盘/任务栏图标(图标随主题 × 代理状态)
  if (prevSettings.theme !== currentSettings.theme) {
    TrayManager.getInstance().updateMenu();
  }

  // 1. Windows Startup
  if (s.startOnBoot !== undefined) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!s.startOnBoot,
        path: process.execPath,
      });
    } catch (e) {
      console.warn('Failed to set login item settings:', e);
    }
  }

  // 2. System Proxy sync — 仅当相关设置值真正变化时执行(渲染器每次都提交全量设置,
  //    若按"字段存在"判断,改主题等无关保存也会触发代理开关/核心拉起)
  const core = SingBoxManager.getInstance();
  let coreAutoStarted = false;
  const valueChanged = (keys: string[]) =>
    keys.some((k) => (s as any)[k] !== undefined && (s as any)[k] !== (prevSettings as any)[k]);

  const proxyChanged = valueChanged([
    'systemProxyEnabled',
    'mixedPort',
    'systemProxyBypassLan',
    'customBypassList',
  ]);
  if (proxyChanged) {
    if (!currentSettings.systemProxyEnabled) {
      await SystemProxy.disable();
    } else if (core.getState() === 'running') {
      await SystemProxy.enable(
        '127.0.0.1',
        currentSettings.mixedPort,
        currentSettings.systemProxyBypassLan,
        currentSettings.customBypassList
      );
    } else {
      // 核心未运行时打开系统代理开关:自动拉起核心,确保开关真实生效而不是只改设置
      await handleCoreStart();
      coreAutoStarted = true;
    }
  }

  // 3. Core dynamic reload if running — 仅当影响核心配置的设置变化时重载。
  //    纯系统代理开关变化不重载核心(代理只改注册表,与核心配置无关;此前误重载,
  //    还会经连接意图保护把刚关掉的代理又强制重开);"开代理但核心没跑"已在上方
  //    分支单独拉起核心。
  const coreConfigChanged = valueChanged([
    'mixedPort',
    'allowLan',
    'inboundAuth',
    'inboundUser',
    'inboundPass',
    'tunEnabled',
    'tunMtu',
    'tunStack',
    'tunAutoRoute',
    'tunStrictRoute',
    'tunDnsHijack',
    'tunIPv6',
    'tunEndpointIndependentNat',
    'dnsCache',
    'dnsOptimistic',
    'routingMode',
    'logLevel',
    'clashApiEnabled',
    'clashApiPort',
    'clashApiSecret',
  ]);
  if (core.getState() === 'running' && !coreAutoStarted && coreConfigChanged) {
    await handleCoreStart();
  }

  TrayManager.getInstance().updateMenu();
  return true;
});

ipcMain.handle('settings:resetDefaults', async () => {
  const db = Database.getInstance();
  const newSettings = db.resetSettings();
  const core = SingBoxManager.getInstance();
  if (core.getState() === 'running') {
    await handleCoreStart();
  }
  TrayManager.getInstance().updateMenu();
  return newSettings;
});
