import { spawn } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { Database } from '../db/Database';
import { LogManager } from '../log/LogManager';

export class ElevatedRelaunch {
  /**
   * 以管理员身份重启应用:由独立 PowerShell 守候,等本进程完全退出(含 before-quit
   * 的核心停止/系统代理还原清理)后再拉起提权实例,避免新旧实例争抢单实例锁。
   * 守候等待上限 60s,每步留痕到 logs/elevate-relaunch.log 便于排查;用户拒绝
   * UAC 则回落普通权限重启,至少保证应用能回来(单实例锁侧另有 10s 重试兜底)。
   */
  public static relaunch(): void {
    const execPath = process.execPath.replace(/'/g, "''");
    const elevateLog = path
      .join(Database.getInstance().getDataDir(), 'logs', 'elevate-relaunch.log')
      .replace(/'/g, "''");
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
    spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { detached: true, stdio: 'ignore' }
    ).unref();
    LogManager.getInstance().addLog('info', '正在请求管理员权限并重启应用...', 'app');
    setTimeout(() => app.quit(), 200);
  }
}
