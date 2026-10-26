import { spawn, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { Database } from '../db/Database';
import { LogManager } from '../log/LogManager';
import { dataDirArgument } from './LaunchDataDir';

const TASK_NAME = 'BlueWingElevateRelaunch';

export class ElevatedRelaunch {
  /**
   * 以管理员身份重启应用。
   *
   * 守候进程必须脱离本应用的进程树承载:Electron 在 Windows 上以 kill-on-close
   * 作业对象管理子进程,应用一退出,直接 spawn 的任何子进程都会被连带杀死
   * (实测:子进程心跳在父进程退出瞬间戛然而止,守候脚本只来得及写下
   * "relaunch begin" 再无下文)。因此守候脚本经一次性计划任务承载——由任务
   * 计划程序服务拉起,完全独立于本应用的作业对象,应用退出后依然存活;以
   * Register-ScheduledTask cmdlet + EncodedCommand 注册,绕开 schtasks /tr
   * 的引号与长度限制。注册+触发完成(应用尚存活)后才退出应用。
   *
   * 守候脚本等本进程完全退出(含 before-quit 的核心停止/代理还原,上限 60s)
   * 后再以 RunAs 拉起提权实例(管理员 + ConsentPromptBehaviorAdmin=0 的机器
   * 静默提升、无 UAC 弹窗属正常),每步留痕 logs/elevate-relaunch.log;
   * UAC 被拒则回落普通权限重启,保证应用至少能回来;结束自删计划任务。
   */
  public static relaunch(): void {
    const execPath = process.execPath.replace(/'/g, "''");
    const dataArgument = dataDirArgument(Database.getInstance().getDataDir());
    const logsDir = path.join(Database.getInstance().getDataDir(), 'logs');
    const elevateLog = path.join(logsDir, 'elevate-relaunch.log').replace(/'/g, "''");
    const scriptPath = path.join(logsDir, 'elevate-relaunch.ps1');
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {}

    const script = [
      `try { Add-Content -Path '${elevateLog}' -Value ("[{0}] relaunch begin, oldPid=${process.pid}" -f (Get-Date -Format o)) } catch {}`,
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      'Start-Sleep -Milliseconds 800',
      `try { Start-Process -FilePath '${execPath}' -ArgumentList '${dataArgument} --bb-elevated-relaunch' -Verb RunAs -ErrorAction Stop; try { Add-Content -Path '${elevateLog}' -Value ("[{0}] runas-ok (部分机器 UAC 策略为静默提升,无弹窗属正常)" -f (Get-Date -Format o)) } catch {} }`,
      'catch {',
      `  try { Add-Content -Path '${elevateLog}' -Value ("[{0}] runas failed: {1}" -f (Get-Date -Format o), $_.Exception.Message) } catch {}`,
      '  Start-Sleep -Seconds 1',
      `  try { Start-Process -FilePath '${execPath}' -ArgumentList '${dataArgument} --bb-elevated-relaunch' } catch {}`,
      '}',
      `try { Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop } catch { try { schtasks /delete /tn ${TASK_NAME} /f | Out-Null } catch {} }`,
    ].join('\n');

    try {
      // 带 BOM 的 UTF-8:PowerShell 5.1 无 BOM 时按 ANSI 解析,中文留痕会乱码
      fs.writeFileSync(scriptPath, '\ufeff' + script, 'utf8');

      // VBS 启动器:wscript 为 GUI 子系统(自身零控制台),Run 窗口样式 0 再彻底隐藏
      // PowerShell——否则计划任务承载的守候脚本会弹出可见控制台窗口(用户实测所见)。
      // VBS 字符串内嵌引号必须双写("" 转义),路径两侧的引号也不例外
      const vbsPath = path.join(logsDir, 'elevate-relaunch.vbs');
      const vbs =
        `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${scriptPath}""", 0, False\n`;
      fs.writeFileSync(vbsPath, '\ufeff' + vbs, 'utf16le');
    } catch (e: any) {
      LogManager.getInstance().addLog('warn', `提权重启:守候脚本写入失败(${e?.message}),退回直接拉起`, 'app');
      this.directSpawn(script);
      return;
    }

    // 注册并触发一次性任务(经 cmdlet,避开 schtasks /tr 引号坑);EncodedCommand 传参零转义
    const escVbsPath = path.join(logsDir, 'elevate-relaunch.vbs').replace(/'/g, "''");
    const registerScript = [
      `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${escVbsPath}"'`,
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Force -ErrorAction Stop | Out-Null`,
      `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    ].join('\n');
    const encoded = Buffer.from(registerScript, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15_000 },
      (err) => {
        if (err) {
          LogManager.getInstance().addLog(
            'warn',
            `提权重启:计划任务注册/触发失败(${err.message}),退回直接拉起(应用退出时守候可能被终止)`,
            'app'
          );
          this.directSpawn(script);
          return;
        }
        // 任务已由任务计划程序承载(独立于本应用作业对象),现在退出是安全的
        LogManager.getInstance().addLog('info', '正在请求管理员权限并重启应用...', 'app');
        setTimeout(() => app.quit(), 200);
      }
    );
  }

  /** 兜底:直接拉起守候 PowerShell(受本应用作业对象约束,退出时可能被终止) */
  private static directSpawn(script: string): void {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    setTimeout(() => app.quit(), 200);
  }
}
