import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { LogManager } from '../log/LogManager';
import { Database } from '../db/Database';
import { AppSettings } from '../../types';
import { WinInetConnection, WinInetProxy } from './WinInetProxy';

export interface ProxySnapshot {
  enabled: boolean;
  server?: string;
  override?: string;
  connections?: WinInetConnection[];
}

interface OwnershipState {
  managedByBlueWing: boolean;
  managedServer?: string;
  originalSnapshot: ProxySnapshot;
  updatedAt: number;
}

export class SystemProxy {
  private static REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  private static stateFile: string = '';
  private static corporateRouting = false;
  public static setCorporateRouting(enabled:boolean):void { this.corporateRouting=enabled; }
  public static corporateBypassList():string { return 'localhost;127.*;[::1]'; }

  /**
   * 连接意图保护判定:仅当"用户显式发起连接"且系统代理与 TUN 全关时才自动补开
   * 系统代理——否则连接后流量没有任何出口,界面却显示"已连接"。
   * 设置/规则变更触发的核心重载必须传 userInitiated=false:连接中用户主动关闭
   * 系统代理的意图不能被重载推翻(此前重载即被强制重开,UI 与注册表错位)。
   */
  public static shouldAutoEnableSystemProxy(
    userInitiated: boolean,
    settings: Pick<AppSettings, 'systemProxyEnabled' | 'tunEnabled'>
  ): boolean {
    return userInitiated && !settings.systemProxyEnabled && !settings.tunEnabled;
  }

  private static getStateFilePath(): string {
    if (!this.stateFile) {
      this.stateFile = path.join(Database.getInstance().getDataDir(), 'proxy_ownership.json');
    }
    return this.stateFile;
  }

  private static loadOwnership(): OwnershipState | null {
    try {
      const p = this.getStateFilePath();
      if (fs.existsSync(p)) {
        // 容错剥离 UTF-8 BOM:外部工具/编辑器写入的带 BOM JSON 会导致
        // JSON.parse 失败、所有权被误判为 null(代理清理与还原全部跳过)
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw.replace(/^\uFEFF/, ''));
      }
    } catch {}
    return null;
  }

  private static saveOwnership(state: OwnershipState | null) {
    try {
      const p = this.getStateFilePath();
      if (!state) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else {
        fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
      }
    } catch {}
  }

  /**
   * Safely execute reg.exe commands via parameterized spawn without cmd.exe shell expansion
   */
  private static execReg(args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      try {
        const proc = spawn('reg.exe', args, { windowsHide: true });
        let stdout = '';
        proc.stdout?.on('data', (d) => (stdout += d.toString()));
        proc.on('close', (code) => resolve({ stdout, code: code || 0 }));
        proc.on('error', () => resolve({ stdout: '', code: -1 }));
      } catch {
        resolve({ stdout: '', code: -1 });
      }
    });
  }

  /**
   * Capture initial Windows system proxy configuration before BlueWing Connect modifies it
   */
  public static async captureOriginalSnapshot(): Promise<ProxySnapshot> {
    const current = await this.getFullRegistryStatus();
    const existing = this.loadOwnership();

    if (!existing) {
      this.saveOwnership({
        managedByBlueWing: false,
        originalSnapshot: current,
        updatedAt: Date.now(),
      });
      LogManager.getInstance().addLog(
        'info',
        `已持久化记录系统原始代理状态 (启用: ${current.enabled ? '是' : '否'}${current.server ? `, 服务器: ${current.server}` : ''})`,
        'system'
      );
    }
    return existing ? existing.originalSnapshot : current;
  }

  /**
   * Enable Windows system proxy safely using parameterized calls
   */
  public static async enable(
    host: string = '127.0.0.1',
    port: number = 2080,
    bypassLan: boolean = true,
    customBypassList?: string
  ): Promise<boolean> {
    try {
      const original = await this.captureOriginalSnapshot();
      const proxyServer = `${host}:${port}`;

      let bypassList = bypassLan
        ? '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*'
        : '<local>;localhost;127.*';

      if (customBypassList && customBypassList.trim()) {
        const customParts = customBypassList
          .split(/[\r\n,;，；]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        // Windows 绕过匹配中 *.example.com 只覆盖子域名,自动补裸域保证整站直连
        for (const part of [...customParts]) {
          if (part.startsWith('*.')) {
            const bare = part.slice(2);
            if (bare && !customParts.includes(bare)) {
              customParts.push(bare);
            }
          }
        }
        if (customParts.length > 0) {
          bypassList = `${bypassList};${customParts.join(';')}`;
        }
      }

      // Company domains, including single-label hosts and private IPs, must enter sing-box.
      // Non-company LAN still uses its DIRECT rules there.
      if (this.corporateRouting) bypassList = this.corporateBypassList();

      if (WinInetProxy.available()) {
        await WinInetProxy.run({action:'enable',server:proxyServer,bypass:bypassList});
        this.saveOwnership({managedByBlueWing:true,managedServer:proxyServer,originalSnapshot:original,updatedAt:Date.now()});
        LogManager.getInstance().addLog('info',`Windows 连接级系统代理已同步并回读验证 (${proxyServer})`,'system');
        return true;
      }

      // Safe parameterized registry updates (No shell injection possible)
      await this.execReg(['add', this.REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
      await this.execReg(['add', this.REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', proxyServer, '/f']);
      await this.execReg(['add', this.REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', bypassList, '/f']);

      // Record ownership
      this.saveOwnership({
        managedByBlueWing: true,
        managedServer: proxyServer,
        originalSnapshot: original,
        updatedAt: Date.now(),
      });

      // Refresh system WinINet
      await this.refreshWinINet();
      LogManager.getInstance().addLog(
        'info',
        `Windows 系统代理已开启 (服务器: ${proxyServer})`,
        'system'
      );
      return true;
    } catch (e: any) {
      LogManager.getInstance().addLog('error', `开启系统代理失败: ${e.message}`, 'system');
      return false;
    }
  }

  /**
   * Disable Windows system proxy safely
   */
  public static async disable(): Promise<boolean> {
    try {
      if (WinInetProxy.available()) {
        const ownership=this.loadOwnership();
        if(ownership?.managedServer)await WinInetProxy.run({action:'disable',managedServer:ownership.managedServer});
        if(ownership){ownership.managedByBlueWing=false;this.saveOwnership(ownership);}
        return true;
      }
      await this.execReg(['add', this.REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);

      // 清除死回环地址:仅当 ProxyServer 是本应用写入的受管服务器时删除,
      // 不触碰用户自有代理配置;避免禁用后注册表残留 127.0.0.1:<port> 死值
      const state = this.loadOwnership();
      if (state?.managedServer) {
        const current = await this.getFullRegistryStatus();
        if (current.server === state.managedServer) {
          await this.execReg(['delete', this.REG_KEY, '/v', 'ProxyServer', '/f']);
        }
      }
      await this.refreshWinINet();

      if (state) {
        state.managedByBlueWing = false;
        this.saveOwnership(state);
      }

      LogManager.getInstance().addLog('info', 'Windows 系统代理已关闭', 'system');
      return true;
    } catch (e: any) {
      LogManager.getInstance().addLog('error', `关闭系统代理失败: ${e.message}`, 'system');
      return false;
    }
  }

  /**
   * Restore user's original proxy configuration upon quitting BlueWing Connect with ownership verification
   */
  public static async restoreOriginal(): Promise<void> {
    const state = this.loadOwnership();
    if (!state) {
      await this.disable();
      return;
    }

    try {
      // 1. Check ownership: Verify current registry proxy server matches what BlueWing Connect set
      const current = await this.getFullRegistryStatus();
      if (state.managedServer && current.server && current.server !== state.managedServer) {
        LogManager.getInstance().addLog(
          'warn',
          `检测到系统代理已被外部程序或用户手动修改为 "${current.server}"，取消强制还原以保护用户当前网络。`,
          'system'
        );
        this.saveOwnership(null);
        return;
      }

      // 2. Restore original snapshot
      const orig = state.originalSnapshot;
      if (orig?.connections && WinInetProxy.available()) {
        await WinInetProxy.run({action:'restore',managedServer:state.managedServer,connections:orig.connections});
        this.saveOwnership(null);
        return;
      }
      if (orig && orig.enabled) {
        await this.execReg(['add', this.REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
        if (orig.server) {
          await this.execReg(['add', this.REG_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', orig.server, '/f']);
        }
        if (orig.override) {
          await this.execReg(['add', this.REG_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', orig.override, '/f']);
        }
        LogManager.getInstance().addLog(
          'info',
          `已恢复系统原始代理配置 (启用: 是, 服务器: ${orig.server || '无'})`,
          'system'
        );
      } else {
        await this.execReg(['add', this.REG_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
        // If original had no ProxyServer, safely delete the key so no dead loopback stays
        if (!orig?.server) {
          await this.execReg(['delete', this.REG_KEY, '/v', 'ProxyServer', '/f']);
        }
        LogManager.getInstance().addLog('info', '已恢复系统原始代理配置 (启用: 否)', 'system');
      }

      await this.refreshWinINet();
      this.saveOwnership(null);
    } catch (e: any) {
      LogManager.getInstance().addLog('warn', `恢复系统原始代理失败: ${e.message}`, 'system');
    }
  }

  /**
   * Check for residual BlueWing Connect proxy on startup (e.g. after crash or sudden reboot)
   */
  public static async checkAndCleanResidual(expectedPort: number = 2080): Promise<boolean> {
    try {
      const current = await this.getFullRegistryStatus();
      if (current.enabled && current.server && current.server.includes(`127.0.0.1:${expectedPort}`)) {
        LogManager.getInstance().addLog(
          'warn',
          `检测到上次异常退出残留的 青翼连接 系统代理配置 (127.0.0.1:${expectedPort})，正在自动安全重置...`,
          'system'
        );
        await this.restoreOriginal();
        return true;
      }
    } catch {}
    return false;
  }

  private static async getFullRegistryStatus(): Promise<ProxySnapshot> {
    if (WinInetProxy.available()) {
      const connections=await WinInetProxy.run({action:'query'});
      const lan=connections.find(c=>c.name==='');
      if(!lan)throw new Error('WinINet LAN configuration missing');
      return {enabled:(lan.flags&2)!==0,server:lan.server,override:lan.bypass,connections};
    }
    let enabled = false;
    let server: string | undefined;
    let override: string | undefined;

    try {
      const { stdout: enableOut } = await this.execReg(['query', this.REG_KEY, '/v', 'ProxyEnable']);
      enabled = enableOut.includes('0x1');
    } catch {}

    try {
      const { stdout: serverOut } = await this.execReg(['query', this.REG_KEY, '/v', 'ProxyServer']);
      const match = serverOut.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/);
      if (match) server = match[1].trim();
    } catch {}

    try {
      const { stdout: overrideOut } = await this.execReg(['query', this.REG_KEY, '/v', 'ProxyOverride']);
      const match = overrideOut.match(/ProxyOverride\s+REG_SZ\s+([^\r\n]+)/);
      if (match) override = match[1].trim();
    } catch {}

    return { enabled, server, override };
  }

  private static async refreshWinINet(): Promise<void> {
    return new Promise((resolve) => {
      // Refresh system WinINet via rundll32 inetsrv/wininet or powershell with short timeout
      const notifyScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinINet {
  [DllImport("wininet.dll", SetLastError = true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
"@;
[WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);
[WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);
`;
      try {
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(notifyScript,'utf16le').toString('base64')], {
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 10000);
        proc.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }
}
