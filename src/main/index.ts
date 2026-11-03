import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, nativeTheme, powerMonitor, screen, shell } from 'electron';
import { guardedIpc } from './security/IpcSecurity';
import { ConnectionIntent } from './core/ConnectionIntent';
import { coreApiSecret } from './security/CoreApiAuth';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';
import http from 'http';
import dns from 'dns';
import { spawn } from 'child_process';
import { Database } from './db/Database';
import { resolveDataDir } from './system/DataDirResolver';
import { launchDataDir } from './system/LaunchDataDir';
import { isRunningAsAdmin } from './system/Elevation';
import { resourcePath } from './branding';
import { SingBoxManager } from './core/SingBoxManager';
import { ConfigGenerator } from './core/ConfigGenerator';
import { ProxySelectionService } from './core/ProxySelectionService';
import { RuleSetUpdater } from './core/RuleSetUpdater';
import { SystemProxy } from './system/SystemProxy';
import { ProxyLifecycle } from './system/ProxyLifecycle';
import { TakeoverLinkage } from './system/TakeoverLinkage';
import { TunAdapter } from './system/TunAdapter';
import { ElevatedRelaunch } from './system/ElevatedRelaunch';
import { ProcessScanner } from './system/ProcessScanner';
import { TcpPing } from './net/TcpPing';
import { SpeedTestRunner } from './net/SpeedTestRunner';
import { WebDAVSyncService } from './net/WebDAVSyncService';
import { BackupMigrator } from './db/BackupMigrator';
import { BackupService } from './db/backup/BackupService';
import { SubscriptionFetcher } from './net/SubscriptionFetcher';
import { UniversalSubscriptionParser } from './net/UniversalSubscriptionParser';
import { TrayManager } from './tray/TrayManager';
import { TrafficStats, Subscription, VpnProfile as EngineVpnProfile, VpnRuntimeInfo } from '../types';
import { LogManager } from './log/LogManager';
import { existingCorporateVpn, getCorporateVpn, setVpnRoutingInitializer } from './vpn/VpnService';
import { applyCorporateConfig } from './vpn/CorporateConfig';
import { VpnEngineManager } from './system/vpn/VpnEngineManager';
import { OpenVpnEngine, derToPem } from './system/vpn/OpenVpnEngine';
import { OpenConnectEngine } from './system/vpn/OpenConnectEngine';
import tls from 'tls';

const coreConnectionIntent = new ConnectionIntent();
let mainWindow: BrowserWindow | null = null;
const ipcMain = guardedIpc(electronIpcMain, () => mainWindow, () =>
  !app.isPackaged && process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).href
    : pathToFileURL(path.join(__dirname, '../renderer/index.html')).href);
let trafficTimer: NodeJS.Timeout | null = null;
let startTime: number = 0;
let totalRx: number = 0;
let totalTx: number = 0;
let corporateEventsBound = false;

// 数据目录:便携优先(exe 同级 data/),不可写回退 %APPDATA%;含前向迁移与搁浅迁移规则
// (详见 system/DataDirResolver.ts)。必须在 app ready 之前设置:Chromium 配置
// (缓存/Cookie)、Database、LogManager、SystemProxy 全部跟随此目录。
const exeDir = path.dirname(process.execPath || '');
const portableDataDir = path.join(exeDir, 'data');
const fallbackDataDir = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming'),
  'BlueWingConnect'
);
const explicitDataDir=launchDataDir(process.argv,process.env.BLUEWING_DATA_DIR);
const appDataDir=explicitDataDir?path.resolve(explicitDataDir):resolveDataDir(portableDataDir, fallbackDataDir, undefined, isRunningAsAdmin()).dir;
process.env.BLUEWING_DATA_DIR = appDataDir;

// 启动黑匣子:早于一切子系统(LogManager 尚未就绪)用裸 fs 记面包屑,
// 提权重启等"退出后再也没起来"类故障在每一步留下定位证据
const bootLog = (msg: string): void => {
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.appendFileSync(
      path.join(appDataDir, 'boot.log'),
      `[${new Date().toISOString()}] pid=${process.pid} admin=${isRunningAsAdmin()} ${msg}\n`
    );
  } catch {}
};
bootLog(`boot: dataDir=${appDataDir}`);
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
// 提权重启竞态标志:由 ElevatedRelaunch 守候脚本传给提权实例。只有这种场景
// 下"旧实例正在退出清理(可达数十秒)、锁即将释放",重试拿锁才有意义。
const isElevatedRelaunch = process.argv.includes('--bb-elevated-relaunch');
const lockSettled = (async (): Promise<boolean> => {
  if (app.requestSingleInstanceLock()) {
    bootLog('single-instance lock acquired (first try)');
    return true;
  }
  // 锁被健康实例持有(用户双击图标唤起窗口的常规场景):它不会退出,重试
  // 注定失败——且每次重调 requestSingleInstanceLock 都会让运行中实例收到
  // second-instance,把用户刚点 X 收进托盘的窗口又拽出来(表现为"关闭钮
  // 连点多次才生效")。第一次调用已经完成了唤起通知,立即退出即可。
  if (!isElevatedRelaunch) {
    bootLog('single-instance lock held by running instance, exiting');
    return false;
  }
  bootLog('single-instance lock held by another instance, retrying');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (app.requestSingleInstanceLock()) {
      bootLog(`single-instance lock acquired on retry ${i + 1}`);
      return true;
    }
  }
  bootLog('single-instance lock NOT acquired after 10s retries, exiting');
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  LogManager.getInstance().setMainWindow(mainWindow);
  if (!corporateEventsBound) {
    corporateEventsBound = true;
    getCorporateVpn().on('state', (state) => mainWindow?.webContents.send('vpn:state', state));
  }

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
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === mainWindow?.webContents && permission === 'clipboard-sanitized-write'));
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
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
  bootLog('whenReady');
  if (!(await lockSettled)) {
    isSecondaryInstance = true;
    app.exit(0);
    return;
  }
  if (process.argv.includes('--bb-shutdown')) {
    // --bb-shutdown 作为首实例 = 没有运行中的实例可通知;立即退出,绝不启动完整
    // 应用(否则安装器的信号任务会凭空拉起应用主窗口一闪而过,用户看到"闪退")
    bootLog('bb-shutdown first instance, exiting');
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
  bootLog('foreign-instance check passed');

  initializeCoreLifecycle();
  createWindow();
  bootLog('main window created');

  // A suspended transport cannot retain a truthful connected state. Require a fresh
  // company login after waking; the public proxy lifecycle remains independent.
  powerMonitor.on('suspend', () => {
    existingCorporateVpn()?.disconnect().catch(() => {});
  });

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
      const secret = coreApiSecret();

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
  await SystemProxy.initializeRecovery();
  if (!settings.autoConnectOnLaunch || Database.getInstance().credentialStatus().mode !== 'normal') {
    SystemProxy.checkAndCleanResidual(settings.mixedPort || 2080);
  } else {
    // 自启连接是用户的常设意愿,等同显式发起(允许连接意图保护兜底)
    handleCoreStart({ userInitiated: true }).catch(error => bootLog('auto-connect failed: ' + String(error)));
  }
}).catch(error => {
  bootLog('initialization failed: ' + String(error));
  dialog.showErrorBox('BlueWing 启动未完成', '初始化未能完成，原始配置已保留。请从启动日志查看原因。');
  app.quit();
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
      Database.getInstance().flushPending();
    } catch (err) { console.error('Configuration save failed during quit; continuing network cleanup'); }
    try {
      await Promise.allSettled([existingCorporateVpn()?.dispose(), VpnEngineManager.getInstance().shutdown()]);
      for (const cleanup of [() => handleCoreStop(), () => SystemProxy.restoreOriginal(), () => LogManager.getInstance().destroy(), () => TrayManager.getInstance().destroy()]) {
        try { await cleanup(); } catch { console.error('A shutdown step failed; continuing remaining cleanup'); }
      }
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
  const finishStopping = coreConnectionIntent.beginStop();
  cancelTunAutoRecovery('停止核心');
  try {
  const core = SingBoxManager.getInstance();
  await proxyLifecycle.stop();
  try {
    await existingCorporateVpn()?.disconnect();
  } finally {
    await core.stop();
    await SystemProxy.recoverIfUnavailable();
  }
  LogManager.getInstance().addLog('info', '代理核心引擎已停止连接', 'core');
  TrayManager.getInstance().updateMenu();
  return true;
  } finally { finishStopping(); }
}

/**
 * 节点集合变化后,若原活跃节点已被删除(saveNodes 回落只改数据库,不碰运行中的核心):
 * - 广播 node:changed 同步渲染层高亮(此前仅手动切换路径广播,删除路径渲染层会停留在已删节点);
 * - 核心运行中:热切换到回落节点(运行配置本就含全部节点 outbound,通常瞬时完成,失败自动重载核心);
 * - 节点被全部删除:切换本机直连，保留 VPN 和系统代理入口。
 * - 无节点运行时首次添加节点:保留直连，直到用户明确选择代理节点。
 * coreAlreadyConsistent:订阅更新按服务器地址保留活跃节点时,运行中核心仍走同一服务器,不打断连接。
 */
async function syncActiveNodeAfterNodesReplaced(
  prevActiveId: string,
  options?: { coreAlreadyConsistent?: boolean }
): Promise<void> {
  const db = Database.getInstance();
  // 原活跃节点仍在列表(普通编辑/测速/排序):无需任何同步
  if (prevActiveId && db.getNodes().some((n) => n.id === prevActiveId)) return;

  const newActiveId = db.getActiveNodeId();
  mainWindow?.webContents.send('node:changed', newActiveId);

  if (options?.coreAlreadyConsistent) return;
  if (SingBoxManager.getInstance().getState() !== 'running') return;

  if (!prevActiveId || !newActiveId) {
    LogManager.getInstance().addLog(
      'info',
      !newActiveId ? '节点列表已清空，切换为本机直连，公司 VPN 分流保持启用' : '已添加代理节点，当前保持本机直连；选择节点后切换代理',
      'app'
    );
    const result = await ProxySelectionService.selectDirect();
    broadcastSettingsChanged();
    if (!result.success) LogManager.getInstance().addLog('error', result.error || '本机直连应用失败', 'core');
    return;
  }

  const target = db.getNodes().find((n) => n.id === newActiveId);
  LogManager.getInstance().addLog(
    'info',
    `活跃节点被删除,已自动切换至: ${target?.name ?? newActiveId}`,
    'app'
  );
  if (db.getSettings().routingMode !== 'direct') {
    const result = await ProxySelectionService.selectNode(newActiveId);
    if (!result.success) LogManager.getInstance().addLog('error', result.error || '节点切换失败', 'core');
  }
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
  const wasRunning=SingBoxManager.getInstance().getState()==='running';
  await existingCorporateVpn()?.disconnect();
  const res = await fn();
  if (!res || (res as any).success !== false) {
    existingCorporateVpn()?.reloadProfiles();
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
    mainWindow?.webContents.send('subs:changed', db.getSubscriptions());
    broadcastSettingsChanged();
    mainWindow?.webContents.send('rules:changed', db.getRules());
    mainWindow?.webContents.send('apprules:changed', db.getAppRules());
    mainWindow?.webContents.send('dns:changed', db.getDns());
    if(wasRunning){
      const applied=await handleCoreStart({userInitiated:false});
      if(res&&typeof res==='object')Object.assign(res,{runtimeApplied:applied});
      if(!applied)LogManager.getInstance().addLog('warn','备份已保存，但运行配置未应用，请检查日志后重新连接','app');
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// TUN 网卡冲突自动恢复
// wintun 网卡(BlueWingTun)设备删除是异步的:强杀持有网卡的孤儿核心、或停止后
// 快速重启,都会让下一个 sing-box 撞上幽灵设备而在启动约 15s 后 FATAL 退出
// (实测:提权重启后首次连接必断、手动再连即好)。以下把"手动再连"自动化:
// - 启动失败且特征为 TUN 网卡冲突 → 清除幽灵设备后立即重试(handleCoreStart);
// - 连续失败 → 有界延迟自动重连(设备异步清理需要时间,上限 2 次);
// - 启动成功后 30s 内异常退出 → 延迟自动重连一次。
// 用户任何手动连接/断开与核心成功运行都会取消待执行的定时器,不与用户意图对抗。
// ---------------------------------------------------------------------------
const TUN_FATAL_RETRY_MAX = 2;
const TUN_FATAL_RETRY_DELAY_MS = 20_000;
let tunFatalRetryTimer: NodeJS.Timeout | null = null;
let tunFatalRetryCount = 0;
let tunCrashReconnectTimer: NodeJS.Timeout | null = null;
let lastCoreStartOkAt = 0;
let lastCoreStartHadTun = false;

function cancelTunAutoRecovery(reason: string): void {
  const hadPending = tunFatalRetryTimer !== null || tunCrashReconnectTimer !== null;
  if (tunFatalRetryTimer) {
    clearTimeout(tunFatalRetryTimer);
    tunFatalRetryTimer = null;
  }
  if (tunCrashReconnectTimer) {
    clearTimeout(tunCrashReconnectTimer);
    tunCrashReconnectTimer = null;
  }
  if (hadPending) {
    LogManager.getInstance().addLog('info', `TUN 自动重连已取消: ${reason}`, 'core');
  }
}

/** 两次启动尝试均因 TUN 网卡冲突失败:设备异步清理需要时间,计划有界延迟重连 */
function scheduleTunFatalRetry(): void {
  if (tunFatalRetryTimer) return;
  if (tunFatalRetryCount >= TUN_FATAL_RETRY_MAX) {
    LogManager.getInstance().addLog(
      'warn',
      'TUN 网卡冲突自动重连已达上限,请稍后手动点击连接重试(或重启系统清理网卡设备)',
      'core'
    );
    return;
  }
  tunFatalRetryCount++;
  LogManager.getInstance().addLog(
    'warn',
    `TUN 网卡设备仍在异步清理,${TUN_FATAL_RETRY_DELAY_MS / 1000} 秒后自动重连 (第 ${tunFatalRetryCount}/${TUN_FATAL_RETRY_MAX} 次),无需手动操作`,
    'core'
  );
  tunFatalRetryTimer = setTimeout(() => {
    tunFatalRetryTimer = null;
    LogManager.getInstance().addLog('info', 'TUN 网卡清理等待完成,正在自动重连...', 'core');
    handleCoreStart({ userInitiated: true }).catch(() => {});
  }, TUN_FATAL_RETRY_DELAY_MS);
}

async function handleCoreStart(options?: { userInitiated?: boolean; shouldContinue?: () => boolean }): Promise<boolean> {
  if (coreConnectionIntent.isStopping) return false;
  if (options?.shouldContinue && !options.shouldContinue()) return false;
  const isCurrent = coreConnectionIntent.begin(options?.shouldContinue);
  const db = Database.getInstance();
  const core = SingBoxManager.getInstance();
  const settings = db.getSettings();
  const nodes = db.getNodes();
  const activeNodeId = db.getActiveNodeId();
  if ((settings.routingMode !== 'direct' && (nodes.find(n => n.id === activeNodeId) || nodes[0])?.credentialsUnavailable) || db.credentialStatus().lockedSettings.includes('inboundPass')) {
    LogManager.getInstance().addLog('warn', '所选节点或代理认证凭据暂时不可读取，原配置已保留。请重新填写密码或添加节点。', 'app');
    return false;
  }

  if (nodes.length === 0) {
    LogManager.getInstance().addLog(
      'info',
      '未配置代理节点，普通流量使用本机直连，VPN 资源继续按接入配置分流。',
      'app'
    );
  }

  // TUN 连接门禁:设置已启用 TUN 但当前非管理员——此前会静默剥除 TUN 入站并兜底
  // 开系统代理,TUN 开关停留在"假开启"且用户全程无感(用户实测所见:未提示就开了
  // 系统代理)。改为拒绝启动并弹既有提权引导(connect 上下文):确认=以管理员
  // 重启;取消=关闭 TUN 改用系统代理连接。手动/托盘/自启等 userInitiated 路径
  // 全部收口于此;核心运行中的配置重载(非 userInitiated)不受影响。
  if (options?.userInitiated && settings.tunEnabled && !core.isAdmin()) {
    LogManager.getInstance().addLog(
      'info',
      'TUN 模式已开启,但应用未以管理员身份运行:请选择以管理员重启启用 TUN,或改用系统代理连接',
      'app'
    );
    // 弹窗挂在主窗口内:窗口可能隐藏在托盘,先恢复显示并聚焦
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(false);
      mainWindow.show();
      mainWindow.focus();
    }
    mainWindow?.webContents.send('tun:elevation-required', 'connect');
    return false;
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

  const corporateRuntime = await getCorporateVpn().prepareRuntime(true);
  if (!isCurrent()) return false;
  SystemProxy.setCorporateRouting(corporateRuntime.profiles.length > 0);
  const config = ConfigGenerator.generate(
    activeNodeId,
    nodes,
    db.getRules(),
    db.getAppRules(),
    db.getDns(),
    settings,
    undefined,
    corporateRuntime,
    VpnEngineManager.getInstance().getSplitConfig()
  );

  LogManager.getInstance().addLog('info', '正在启动 Sing-box 核心代理引擎...', 'app');
  let started = await core.start(config, isCurrent);
  if (!started) {
    if (!isCurrent()) return false;
    // 规则源下载被间歇性重置等瞬时故障:自动重试一次,避免用户手动反复点击
    LogManager.getInstance().addLog('warn', '核心首次启动失败,2 秒后自动重试一次...', 'core');
    // TUN 网卡冲突(幽灵设备,特征见 SingBoxManager.consumeTunAdapterFatal):
    // 重试前主动做 PnP 级清除,大概率一次救回
    if (core.consumeTunAdapterFatal()) {
      LogManager.getInstance().addLog('info', '检测到 TUN 网卡设备冲突,正在清除残留设备后重试...', 'core');
      const res = await TunAdapter.removeStale(8000);
      LogManager.getInstance().addLog(
        res.cleared ? 'info' : 'warn',
        res.cleared ? 'TUN 网卡残留设备已清除' : 'TUN 网卡设备清除未完成,仍将重试',
        'core'
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (!isCurrent()) return false;
    started = await core.start(config, isCurrent);
  }
  if (!isCurrent()) return false;
  if (started) {
    getCorporateVpn().publicCoreStarted(corporateRuntime);
    LogManager.getInstance().addLog('info', '代理核心引擎已就绪', 'core');
    // TUN 早期崩溃自动重连的判定基准(见 stateChange 订阅);config 经权限剥除
    // 后就地变更,此处读到的是真实生效的入站
    lastCoreStartOkAt = Date.now();
    lastCoreStartHadTun =
      Array.isArray(config.inbounds) && config.inbounds.some((i: any) => i.type === 'tun');
    tunFatalRetryCount = 0;
    if (!(await proxyLifecycle.settled())) {
      LogManager.getInstance().addLog('warn', '核心已启动，但系统代理同步未完成，请查看网络恢复日志', 'system');
    }
    if (!isCurrent()) return false;
    // 保护性兜底:配置含 TUN 但因非管理员权限被剥除,且系统代理为关——自动开启
    // 系统代理,兑现"已安全回退为系统代理模式"的日志承诺,避免连接空转无出口
    if (core.wasTunStrippedLastStart() && (await TakeoverLinkage.ensureProxyWhenTunStripped(isCurrent))) {
      broadcastSettingsChanged();
    }
  } else {
    // 两次尝试均失败且特征为 TUN 网卡冲突:设备异步清理需要时间,计划有界自动
    // 重连(把用户"过一会再点一次连接"自动化);其余失败保持原有手动提示语义
    if (core.consumeTunAdapterFatal()) scheduleTunFatalRetry();
    LogManager.getInstance().addLog('error', 'Sing-box 核心启动失败，请检查配置或日志详情', 'core');
  }
  TrayManager.getInstance().updateMenu();
  return started;
}

// -------------------------------------------------------------
// VPN 接入(应用内直接登录第三方 VPN 账号)
// -------------------------------------------------------------
// 环境判定注入:custody 移交需要"TUN 实际生效"(核心在跑 + 设置开 TUN + 管理员)
VpnEngineManager.getInstance().setEnvProbe(() => ({
  coreRunning: SingBoxManager.getInstance().getState() === 'running',
  tunActive:
    SingBoxManager.getInstance().getState() === 'running' &&
    Database.getInstance().getSettings().tunEnabled &&
    SingBoxManager.getInstance().isAdmin(),
  isAdmin: SingBoxManager.getInstance().isAdmin(),
}));

// VPN 状态变化:推送渲染层;网络事实(网卡/内网段/DNS)签名变化且核心在跑时,
// 防抖重载配置注入/撤除 vpn-corp 数据面(非 userInitiated,不触碰代理开关)
let vpnNetworkSignature = '';
let vpnReloadTimer: NodeJS.Timeout | null = null;
VpnEngineManager.getInstance().on('state', (info: VpnRuntimeInfo) => {
  mainWindow?.webContents.send('evpn:state', info);
  const sig =
    ['connected', 'enabled'].includes(info.state)
      ? [info.adapterName || '', ...[...info.routes].sort(), ...info.dnsServers, ...info.domainSuffixes].join('|')
      : '';
  if (sig === vpnNetworkSignature) return;
  vpnNetworkSignature = sig;
  if (SingBoxManager.getInstance().getState() !== 'running') return;
  if (vpnReloadTimer) clearTimeout(vpnReloadTimer);
  vpnReloadTimer = setTimeout(() => {
    vpnReloadTimer = null;
    if (SingBoxManager.getInstance().getState() === 'running') {
      LogManager.getInstance().addLog(
        'info',
        'VPN 网络信息变化,重载核心配置以更新内网分流规则',
        'app'
      );
      handleCoreStart();
    }
  }, 800);
  vpnReloadTimer.unref?.();
});

function broadcastVpnProfilesChanged(): void {
  mainWindow?.webContents.send('evpn:profiles', Database.getInstance().getVpnProfiles());
}

ipcMain.handle('evpn:getProfiles', () => Database.getInstance().getVpnProfiles());
ipcMain.handle('evpn:saveProfile', (_, profile: EngineVpnProfile) => {
  const db = Database.getInstance();
  if (!profile || !profile.id || !profile.server || !profile.name) return false;
  db.upsertVpnProfile(profile);
  broadcastVpnProfilesChanged();
  return true;
});
ipcMain.handle('evpn:deleteProfile', async (_, id: string) => {
  const db = Database.getInstance();
  const manager = VpnEngineManager.getInstance();
  if (manager.getState()?.profileId === id && manager.getState()?.state !== 'disconnected') {
    await manager.disconnect();
  }
  const deleted = db.deleteVpnProfile(id);
  if (deleted) broadcastVpnProfilesChanged();
  return deleted;
});
ipcMain.handle('evpn:connect', (_, id: string, extra?: { mfaCode?: string }) =>
  VpnEngineManager.getInstance().connect(id, extra)
);
ipcMain.handle('evpn:disconnect', () => VpnEngineManager.getInstance().disconnect());
ipcMain.handle('evpn:getState', () => VpnEngineManager.getInstance().getState());
ipcMain.handle('evpn:getEngines', () => {
  const dataDir = Database.getInstance().getDataDir();
  return {
    openvpn: {
      available: OpenVpnEngine.locateBinary() !== null,
      dir: path.join(dataDir, 'vpn-engines', 'openvpn'),
    },
    openconnect: {
      available: OpenConnectEngine.locateBinary() !== null,
      dir: path.join(dataDir, 'vpn-engines', 'openconnect'),
    },
  };
});
ipcMain.handle('system:openPath', (_, p: string) => {
  if (typeof p !== 'string' || !p) return false;
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
  shell.openPath(p);
  return true;
});

// 自动获取 VPN 网关证书:对 SoftEther 等自签名网关,OpenVPN 端点(UDP 1194)无法
// 直接 TLS 探测,但原生/管理监听端口(443/992/5555)说的是 TLS——逐个尝试握手,
// 拿到证书即返回 PEM(与 OpenVPN 端点使用同一服务器证书)
function fetchServerCert(host: string, ports: number[]): Promise<{ pem?: string; port?: number; error?: string }> {
  return new Promise((resolve) => {
    if (!host || !ports.length) {
      resolve({ error: '缺少主机地址' });
      return;
    }
    const tryPort = (idx: number): void => {
      if (idx >= ports.length) {
        resolve({ error: '所有端口均未能完成 TLS 握手(443/992/5555)' });
        return;
      }
      const port = ports[idx];
      const socket = tls.connect(
        { host, port, rejectUnauthorized: false, timeout: 5000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.destroy();
          if (cert && cert.raw && cert.raw.length > 0) {
            resolve({ pem: derToPem(cert.raw), port });
          } else {
            tryPort(idx + 1);
          }
        }
      );
      socket.on('error', () => {
        socket.destroy();
        tryPort(idx + 1);
      });
      socket.on('timeout', () => {
        socket.destroy();
        tryPort(idx + 1);
      });
    };
    tryPort(0);
  });
}
ipcMain.handle('evpn:fetchServerCert', (_, host: string, ports?: number[]) =>
  fetchServerCert(String(host || '').trim(), Array.isArray(ports) && ports.length ? ports : [443, 992, 5555])
);

// -------------------------------------------------------------
// IPC Handlers
// -------------------------------------------------------------

// Corporate VPN IPC is intentionally narrow and restricted to the top-level app frame.
for (const [name, handler] of Object.entries({
  snapshot: () => getCorporateVpn().snapshot(),
  save: (profile: unknown) => getCorporateVpn().save(profile),
  remove: (id: string) => getCorporateVpn().remove(id),
  connect: (id: string, password: string) => getCorporateVpn().connect(id, password),
  disconnect: (id?: string) => getCorporateVpn().disconnect(id),
  discover: (id: string) => getCorporateVpn().discover(id),
  certificate: (id: string) => getCorporateVpn().certificate(id),
  respond: (id: string, generation: number, value: string, profileId?: string) => getCorporateVpn().respond(id, generation, value, profileId),
  clearCredentials: (id: string) => getCorporateVpn().clearCredentials(id),
  savePassword: (id: string, password: string, remember: boolean) => getCorporateVpn().savePassword(id, password, remember),
  openDiagnostics: async (id: string) => {
    const error = await shell.openPath(getCorporateVpn().diagnosticFile(id));
    if (error) throw new Error(error);
  },
  clearDiagnostics: (id: string) => getCorporateVpn().clearDiagnostics(id),
  clearDiscoveredTargets: (id: string) => getCorporateVpn().clearDiscoveredTargets(id),
  apply: () => handleCoreStart({ userInitiated: true }),
})) {
  ipcMain.handle(`vpn:${name}`, (event, ...args: any[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('VPN IPC sender rejected');
    return (handler as (...args:any[])=>unknown)(...args);
  });
}

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
  ElevatedRelaunch.relaunch();
  return true;
});

// TUN 提权引导弹窗的"以管理员身份重启"确认:落库(含互斥联动)→广播→提权重启。
// 由渲染层自定义弹窗触发(不再使用系统原生对话框)
ipcMain.handle('tun:enableElevated', () => {
  const db = Database.getInstance();
  const settings = db.getSettings();
  const patch = TakeoverLinkage.exclusivityPatch(
    settings,
    { tunEnabled: true, systemProxyEnabled: settings.systemProxyEnabled },
    true
  );
  db.saveSettings({ tunEnabled: true, ...(patch || {}) });
  broadcastSettingsChanged();
  LogManager.getInstance().addLog('info', '已保存 TUN 设置,正在以管理员身份重启应用...', 'app');
  ElevatedRelaunch.relaunch();
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
// 用户手动连接/重启会取消待执行的 TUN 自动重连(用户意图优先,避免定时器
// 迟到触发一次多余的停止-重启)
ipcMain.handle('core:start', async () => {
  cancelTunAutoRecovery('用户手动连接');
  return handleCoreStart({ userInitiated: true });
});
ipcMain.handle('core:stop', async () => {
  cancelTunAutoRecovery('用户手动断开');
  return handleCoreStop();
});
ipcMain.handle('core:restart', async () => {
  cancelTunAutoRecovery('用户手动重启');
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
    db.getSettings(),
    undefined,
    getCorporateVpn().policy.runtime(),
    VpnEngineManager.getInstance().getSplitConfig()
  );
  return SingBoxManager.getInstance().validate(config);
});

// Forward core state change
setVpnRoutingInitializer(isCurrent => handleCoreStart({
  userInitiated: SingBoxManager.getInstance().getState() !== 'running',
  shouldContinue: isCurrent,
}));
const proxyLifecycle = new ProxyLifecycle({
  running: () => SingBoxManager.getInstance().getState() === 'running',
  pid: () => SingBoxManager.getInstance().getPid(),
}, () => Database.getInstance().getSettings());
function initializeCoreLifecycle(): void {
SingBoxManager.getInstance().setConfigEnricher(async config=>{
  const runtime=await getCorporateVpn().prepareRuntime(true);
  SystemProxy.setCorporateRouting(runtime.profiles.length>0);
  applyCorporateConfig(config,runtime);
});
SingBoxManager.getInstance().on('configured', config => {
  getCorporateVpn().publicCoreStarted(getCorporateVpn().policy.runtime());
  proxyLifecycle.configured(config).catch(() => {});
});
SingBoxManager.getInstance().on('stateChange', (state) => {
  if (['stopped','crashed','error'].includes(state)) {
    // Explicit stops already disconnected above; every other terminal state
    // must retain company guards, including an unexpected exit with code 0.
    existingCorporateVpn()?.publicCoreStopped(true);
    proxyLifecycle.unavailable().catch(() => {});
  }
  if (state === 'stopping') proxyLifecycle.invalidate();
  mainWindow?.webContents.send('core:stateChange', state);
  if (state === 'crashed') {
    // TUN 模式启动初期(30s 内)异常退出:多为网卡设备/路由的清理竞态,
    // 延迟自动重连一次即可恢复;用户已在等重试(fatal 梯次)时不重复
    if (
      lastCoreStartHadTun &&
      Date.now() - lastCoreStartOkAt < 30_000 &&
      !tunCrashReconnectTimer &&
      !tunFatalRetryTimer
    ) {
      LogManager.getInstance().addLog(
        'warn',
        'TUN 模式启动初期核心异常退出,12 秒后自动重连(无需手动操作)',
        'core'
      );
      tunCrashReconnectTimer = setTimeout(() => {
        tunCrashReconnectTimer = null;
        handleCoreStart({ userInitiated: true }).catch(() => {});
      }, 12_000);
    }
    return;
  }
  // 核心成功运行或正在停止:待执行的自动重连已无意义(用户操作覆盖/已恢复)
  if (state === 'running' || state === 'stopping') {
    cancelTunAutoRecovery(state === 'running' ? '核心已成功运行' : '核心正在停止');
  }
});

}

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
ipcMain.handle('nodes:add', async (_, node) => {
  const db = Database.getInstance();
  const prevActiveId = db.getActiveNodeId();
  db.addNode(node);
  await syncActiveNodeAfterNodesReplaced(prevActiveId);
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
  mainWindow?.webContents.send('node:changed', Database.getInstance().getActiveNodeId());
  broadcastSettingsChanged();
  return res.success;
});
ipcMain.handle('nodes:selectDirect', async () => {
  const res = await ProxySelectionService.selectDirect();
  broadcastSettingsChanged();
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
ipcMain.handle('backup:export', (_, categories, passphrase) => BackupService.exportWindowsBackup(categories, { passphrase }));
ipcMain.handle('backup:exportAndroid', (_, categories) => BackupService.exportAndroidBackup(categories));
ipcMain.handle('backup:previewImport', (_, content, categories, passphrase) => BackupService.previewImport(content, categories, passphrase));
ipcMain.handle('backup:importWithTransaction', (_, content, categories, mode, passphrase) =>
  runBackupImport(() => BackupService.importWithTransaction(content, categories, mode, passphrase))
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
ipcMain.handle('backup:importLinks', async (_, text) => {
  const nodes = BackupMigrator.parseNodeLinks(text);
  if (nodes.length > 0) {
    const db = Database.getInstance();
    const prevActiveId = db.getActiveNodeId();
    db.saveNodes([...db.getNodes(), ...nodes]);
    await syncActiveNodeAfterNodesReplaced(prevActiveId);
    TrayManager.getInstance().updateMenu();
    broadcastNodesChanged();
  }
  return nodes;
});

// Settings
ipcMain.handle('settings:get', () => Database.getInstance().getSettings());
ipcMain.handle('settings:credentialStatus', () => Database.getInstance().credentialStatus());
ipcMain.handle('settings:save', async (_, s) => {
  const db = Database.getInstance();
  const prevSettings = { ...db.getSettings() };

  // TUN↔系统代理互斥联动(二选一):用户切换开关的这次保存,落库前归一化另一侧,
  // 后续既有的 proxyChanged/coreConfigChanged 分支自然完成注册表开关与核心重载;
  // 核心重载路径不经过此处,不会触碰开关(与连接意图保护同一约束)。
  let linkageApplied = false;
  // 非管理员下开 TUN:还原本次开关并通过事件让渲染层弹自定义引导弹窗
  // (TUN 不可能生效,静默剥除+代理回退的三步舞曾让用户看到"系统代理怎么又开了");
  // 用户确认提权走 tun:enableElevated(落库+联动+提权重启),取消则现状不变
  let tunElevationRequired = false;
  if (s.tunEnabled !== undefined && s.tunEnabled !== prevSettings.tunEnabled) {
    if (s.tunEnabled && !SingBoxManager.getInstance().isAdmin()) {
      tunElevationRequired = true;
      s.tunEnabled = prevSettings.tunEnabled; // 还原开关;渲染层乐观状态靠广播纠正
    }
    if (s.tunEnabled !== prevSettings.tunEnabled) {
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
  }
  // 反向联动(单选语义另一半):TUN 开着时用户开系统代理 → 联动关 TUN
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

  // 联动或还原改写了渲染层未提交的字段(其本地乐观状态已过期),回推全量设置纠正
  if (linkageApplied || (s.tunEnabled !== undefined && s.tunEnabled !== prevSettings.tunEnabled)) {
    broadcastSettingsChanged();
  }

  // 非管理员开 TUN 被拦截:通知渲染层弹自定义提权引导弹窗(设置页/Dashboard 的
  // 正常路径会在保存前预检直接弹窗,此处兜底覆盖绕过预检的路径)
  if (tunElevationRequired) {
    mainWindow?.webContents.send('tun:elevation-required');
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
      await proxyLifecycle.configured(JSON.parse(core.getLiveConfig()));
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
