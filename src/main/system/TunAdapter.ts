import { spawn } from 'child_process';
import { LogManager } from '../log/LogManager';

/**
 * TUN 网卡(wintun 适配器,固定连接名 BlueWingTun)的残留探测与清除。
 *
 * wintun 设备的删除是异步的:强杀(taskkill /F)持有网卡的 sing-box、或刚停止
 * 就立刻重启,都会留下"设备注册还在、设备对象已失效"的幽灵网卡;此时下一个
 * sing-box 创建网卡必然 FATAL 退出——
 *   create adapter: Cannot create a file when that file already exists.
 *   open existing adapter: Element not found.
 *
 * 设备身份识别(本机实测钉死):sing-tun 库创建的所有 wintun 设备在 PnP 里
 * FriendlyName 恒为 "sing-tun Tunnel"(与 interface_name 无关),按名字匹配
 * 永远落空;真正的身份标识是 NetCfg 注册表里该设备的 Connection Name ==
 * interface_name。因此按 InstanceId 前缀 SWD\WINTUN\ 枚举后用 Connection Name
 * 反查归属,只清理属于本应用(BlueWingTun)的设备,不触碰其他 sing-box 应用
 * (如 OwnBoxTun)或 WireGuard 的 wintun 适配器。清理用 pnputil /remove-device
 * (需管理员;非管理员调用失败,静默降级为等待设备自行清理)。
 */
export class TunAdapter {
  public static readonly ADAPTER_NAME = 'BlueWingTun';

  /** 从 Get-PnpDevice 输出解析设备实例 ID(每行一个;剔除 PS 提示/空行) */
  public static parseInstanceIds(stdout: string): string[] {
    return stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^(WARNING|ERROR|取消|错误)/i.test(s));
  }

  /**
   * 清除残留的 TUN 网卡设备并等待其消失。
   * 返回 found=是否发现残留;cleared=结束时是否已不存在(未发现视为已清除)。
   */
  public static async removeStale(timeoutMs: number): Promise<{ found: boolean; cleared: boolean }> {
    const ids = await TunAdapter.listInstances();
    if (ids.length === 0) return { found: false, cleared: true };

    for (const id of ids) {
      await TunAdapter.removeInstance(id);
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const remain = await TunAdapter.listInstances();
      if (remain.length === 0) return { found: true, cleared: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { found: true, cleared: false };
  }

  /** 枚举属于本应用(连接名 BlueWingTun)的 wintun 设备实例 ID(含隐藏/幻影设备) */
  private static listInstances(): Promise<string[]> {
    const name = TunAdapter.ADAPTER_NAME;
    const script =
      `$root='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Network\\{4D36E972-E325-11CE-BFC1-08002BE10318}'; ` +
      `Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.InstanceId -like 'SWD\\WINTUN\\*' } | ForEach-Object { ` +
      `$g=($_.InstanceId -split '\\\\')[-1]; ` +
      `$ck=Join-Path $root ($g+'\\Connection'); ` +
      `if (Test-Path $ck) { if ((Get-ItemProperty $ck -ErrorAction SilentlyContinue).Name -eq '${name}') { $_.InstanceId } } }`;
    return TunAdapter.runPowerShell(script, 5000).then((out) => TunAdapter.parseInstanceIds(out));
  }

  private static removeInstance(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // 设备实例 ID 含 & 和 \,必须经参数数组传递,绝不能拼进 shell 命令行
        const proc = spawn('pnputil.exe', ['/remove-device', id], { windowsHide: true });
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve(false);
        }, 5000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** PowerShell 输出收集;任何异常/超时都以空串结算,绝不悬挂调用方 */
  private static runPowerShell(script: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      try {
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
        });
        let out = '';
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve('');
        }, timeoutMs);
        proc.stdout?.on('data', (d) => (out += d.toString()));
        proc.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve('');
        });
      } catch (e: any) {
        LogManager.getInstance().addLog('warn', `TUN 网卡状态探测异常: ${e?.message || e}`, 'system');
        resolve('');
      }
    });
  }
}
