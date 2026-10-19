import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import http from 'http';
import { EventEmitter } from 'events';
import { CoreState } from '../../types';
import { LogManager } from '../log/LogManager';
import { Database } from '../db/Database';

export function isRunningAsAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class SingBoxManager extends EventEmitter {
  private static instance: SingBoxManager;
  private process: ChildProcess | null = null;
  private state: CoreState = 'stopped';
  private configPath: string;
  private binaryPath: string;

  // Lifecycle concurrency mutex
  private mutex: Promise<void> = Promise.resolve();

  private log(level: 'info' | 'warn' | 'error' | 'debug', message: string, source: 'core' | 'app' | 'system' | 'net' = 'core') {
    LogManager.getInstance().addLog(level, message, source);
  }

  private constructor() {
    super();
    const dataDir = Database.getInstance().getDataDir();

    this.configPath = path.join(dataDir, 'config.json');
    this.binaryPath = this.locateBinary();
  }

  private locateBinary(): string {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'sing-box.exe'),
      path.join(path.dirname(process.execPath || ''), 'resources', 'bin', 'sing-box.exe'),
      path.join(path.dirname(process.execPath || ''), 'bin', 'sing-box.exe'),
      path.join(__dirname, '../../bin/sing-box.exe'),
      path.join(process.cwd(), 'bin', 'sing-box.exe'),
    ];

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return path.resolve(p);
      }
    }
    return path.resolve(process.cwd(), 'bin', 'sing-box.exe');
  }

  public static getInstance(): SingBoxManager {
    if (!SingBoxManager.instance) {
      SingBoxManager.instance = new SingBoxManager();
    }
    return SingBoxManager.instance;
  }

  public getState(): CoreState {
    return this.state;
  }

  public getPid(): number | undefined {
    return this.process?.pid;
  }

  public isAdmin(): boolean {
    return isRunningAsAdmin();
  }

  public getLiveConfig(): string {
    try {
      if (fs.existsSync(this.configPath)) {
        return fs.readFileSync(this.configPath, 'utf8');
      }
    } catch {}
    return '{}';
  }

  public async getVersion(): Promise<string> {
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(this.binaryPath)) {
          resolve('检测失败 (未找到核心文件)');
          return;
        }
        const proc = spawn(this.binaryPath, ['version']);
        let output = '';
        // 子进程偶发挂起(杀软扫描/句柄泄漏)会拖死调用方并残留进程(被下次启动误清为
        // "孤儿核心"),超时强杀兜底
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve('检测超时');
        }, 8000);
        proc.stdout?.on('data', (d) => (output += d.toString()));
        proc.on('close', () => {
          clearTimeout(timer);
          const match = output.match(/sing-box version ([^\s\n]+)/i);
          if (match) {
            resolve(match[1]);
          } else {
            resolve('检测失败');
          }
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          LogManager.getInstance().addLog('warn', `获取核心版本异常: ${err.message}`, 'core');
          resolve('检测失败');
        });
      } catch (e: any) {
        LogManager.getInstance().addLog('warn', `获取核心版本失败: ${e.message}`, 'core');
        resolve('检测失败');
      }
    });
  }

  /**
   * 清理上次异常退出残留的孤儿 sing-box 进程。
   * 仅按本应用二进制完整路径匹配,不会误杀用户自行安装的 sing-box。
   */
  public async cleanupOrphanCores(): Promise<number> {
    if (process.platform !== 'win32' || this.process?.pid) {
      return 0;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (count: number) => {
        if (!settled) {
          settled = true;
          resolve(count);
        }
      };
      try {
        // PS 单引号字符串内反斜杠为字面量,路径可直接内插
        const script = `Get-Process sing-box -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${this.binaryPath}' } | ForEach-Object { $_.Id }`;
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
        });
        let stdout = '';
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          finish(0);
        }, 3000);
        proc.stdout?.on('data', (d) => (stdout += d.toString()));
        proc.on('close', () => {
          clearTimeout(timer);
          const pids = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s));
          for (const pid of pids) {
            try {
              execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
            } catch {}
          }
          if (pids.length > 0) {
            this.log('warn', `已清理 ${pids.length} 个残留的孤儿 sing-box 进程 (PID: ${pids.join(', ')})`, 'core');
          }
          finish(pids.length);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          finish(0);
        });
      } catch {
        finish(0);
      }
    });
  }

  public async validate(config: Record<string, any>): Promise<{ valid: boolean; error?: string }> {
    const testConfigPath = `${this.configPath}.test.json`;
    try {
      fs.writeFileSync(testConfigPath, JSON.stringify(config, null, 2), 'utf8');
      return new Promise((resolve) => {
        const proc = spawn(this.binaryPath, ['check', '-c', testConfigPath]);
        let stderr = '';
        // check 挂起会永久占住 start() 的互斥锁(state 卡 starting、stop 排队永不执行,
        // 界面"无法停止"),超时强杀兜底
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          try { fs.unlinkSync(testConfigPath); } catch {}
          resolve({ valid: false, error: '配置校验超时 (sing-box check 未退出)' });
        }, 10000);
        proc.stderr?.on('data', (d) => (stderr += d.toString()));
        proc.on('close', (code) => {
          clearTimeout(timer);
          try { fs.unlinkSync(testConfigPath); } catch {}
          if (code === 0) {
            resolve({ valid: true });
          } else {
            resolve({ valid: false, error: stderr.trim() });
          }
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          try { fs.unlinkSync(testConfigPath); } catch {}
          resolve({ valid: false, error: err.message });
        });
      });
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  /**
   * Thread-safe Start with Port & API Readiness Probing
   */
  public async start(config: Record<string, any>): Promise<boolean> {
    return this.runWithMutex(async () => {
      if (this.state === 'running' || this.state === 'starting') {
        await this.stopInternal();
      }

      this.setState('starting');

      try {
        // Safety Check: If TUN mode is in config but not elevated, gracefully remove it to prevent fatal crash
        const admin = this.isAdmin();
        if (!admin && config.inbounds) {
          const hasTun = config.inbounds.some((i: any) => i.type === 'tun');
          if (hasTun) {
            config.inbounds = config.inbounds.filter((i: any) => i.type !== 'tun');
            this.log(
              'warn',
              '【权限保护】检测到当前以普通用户权限运行，已安全回退为系统代理模式（可在设置中以管理员身份重启启用 TUN 全局网卡）。',
              'system'
            );
          }
        }

        // Check config syntax before launching
        const validation = await this.validate(config);
        if (!validation.valid) {
          this.log('error', `配置校验失败: ${validation.error}`, 'core');
          this.setState('error');
          return false;
        }

        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

        const workingDir = path.dirname(this.binaryPath);
        this.log('info', `正在拉起核心引擎进程: ${this.binaryPath}`, 'core');

        this.process = spawn(this.binaryPath, ['run', '-c', this.configPath], {
          cwd: workingDir,
          windowsHide: true,
          // sing-box 对配置中 DNS 旧版地址过滤字段直接拒启(FATAL);
          // 豁免仅注入本应用拉起的核心子进程,不污染系统环境
          env: { ...process.env, ENABLE_DEPRECATED_LEGACY_DNS_ADDRESS_FILTER: 'true' },
        });

        this.process.stdout?.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              this.log(
                line.toLowerCase().includes('error') ? 'error' : 'info',
                line.trim(),
                'core'
              );
            }
          }
        });

        this.process.stderr?.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              let level: 'error' | 'warn' | 'info' = 'info';
              if (/\b(fatal|panic)\b/i.test(trimmed) || (/\berror\b/i.test(trimmed) && !/\bnoerror\b/i.test(trimmed))) {
                level = 'error';
              } else if (/\b(warn|warning)\b/i.test(trimmed)) {
                level = 'warn';
              }
              this.log(level, trimmed, 'core');
            }
          }
        });

        this.process.on('error', (err) => {
          this.log('error', `内核进程异常: ${err.message}`, 'core');
          this.setState('error');
        });

        this.process.on('close', (code, signal) => {
          const wasRunning = this.state === 'running';
          this.log(
            code === 0 ? 'info' : 'warn',
            `Sing-box 核心进程已退出 (代码: ${code}, 信号: ${signal || '无'})`,
            'core'
          );
          this.process = null;

          if (this.state !== 'stopping') {
            if (wasRunning && code !== 0) {
              this.setState('crashed');
            } else {
              this.setState('stopped');
            }
          }
        });

        // Extract mixed port and clash API port for readiness check
        const mixedPort = config.inbounds?.find((i: any) => i.type === 'mixed')?.listen_port || 2080;
        const clashPort = config.experimental?.clash_api?.external_controller
          ? parseInt(config.experimental.clash_api.external_controller.split(':')[1], 10)
          : 9090;

        // Active readiness probing: verify mixed port and process health
        const isReady = await this.waitForReady(mixedPort, clashPort, 5000);
        if (isReady && this.process && !this.process.killed) {
          this.setState('running');
          this.log('info', `青翼连接 核心引擎启动成功 (PID: ${this.process.pid}, 监听端口: ${mixedPort})`, 'core');
          // cache_file 会跨重启恢复上次持久化的选择器状态,静默覆盖配置中的 selector default,
          // 曾导致"界面已切换节点、核心仍走旧节点"(旧节点不可用时表现为全网络极慢);
          // 就绪后按应用记录的活跃节点校正,不阻塞启动
          this.syncActiveSelection(config, clashPort).catch(() => {});
          return true;
        } else {
          this.log('error', 'Sing-box 核心就绪超时或中途异常退出', 'core');
          await this.stopInternal();
          this.setState('error');
          return false;
        }
      } catch (e: any) {
        this.log('error', `启动异常: ${e.message}`, 'core');
        this.setState('error');
        return false;
      }
    });
  }

  /**
   * Thread-safe Stop with Graceful Termination & Resource Cleanup
   */
  public async stop(): Promise<void> {
    return this.runWithMutex(async () => {
      await this.stopInternal();
    });
  }

  private async stopInternal(): Promise<void> {
    if (!this.process && this.state === 'stopped') {
      return;
    }

    this.setState('stopping');
    this.log('info', '正在停止 Sing-box 核心进程...', 'core');
    const proc = this.process;
    const pid = proc?.pid;

    if (proc && pid) {
      try {
        // 1. Attempt graceful shutdown via SIGINT first (allows wintun & routes to unbind cleanly)
        proc.kill('SIGINT');
      } catch {}

      // Wait up to 1500ms for graceful exit
      const gracefulExit = await this.waitForExit(1500);

      // 2. Fallback to forced kill if not exited
      if (!gracefulExit && pid) {
        try {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } catch {}
      }
    }

    this.process = null;
    this.setState('stopped');
    this.log('info', 'Sing-box 核心进程已安全停止', 'core');
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (!this.process || Date.now() - start > timeoutMs) {
          clearInterval(interval);
          resolve(!this.process);
        }
      }, 50);
    });
  }

  /**
   * Probe TCP mixed-in port and Clash API readiness
   */
  private async waitForReady(mixedPort: number, clashPort: number, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.process || this.process.killed) {
        return false;
      }

      // Check if mixed port is accepting connections
      const portOpen = await this.checkPortOpen('127.0.0.1', mixedPort);
      if (portOpen) {
        return true;
      }

      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  private checkPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(250);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }

  /**
   * 核心就绪后把应用记录的活跃节点重新下发给 Clash API 选择器。
   * mixed 端口可连不代表 Clash API 已就绪,带短暂重试;失败静默放弃(配置 default 仍兜底)。
   */
  private async syncActiveSelection(config: Record<string, any>, clashPort: number): Promise<void> {
    if (!config.experimental?.clash_api?.external_controller) return;

    const selector = config.outbounds?.find((o: any) => o.type === 'selector' && o.tag === 'proxy');
    const db = Database.getInstance();
    const activeId = db.getActiveNodeId();
    const desired = `node-${activeId}`;
    if (!selector || !Array.isArray(selector.outbounds) || !selector.outbounds.includes(desired)) {
      return;
    }

    const secret: string | undefined = config.experimental.clash_api.secret || undefined;
    const friendlyName = db.getNodes().find((n) => n.id === activeId)?.name || activeId;

    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.state !== 'running') return;
      const current = await this.getClashSelection(clashPort, secret);
      if (current === undefined) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (current === desired) return;
      if (await this.putClashSelection(clashPort, desired, secret)) {
        this.log(
          'info',
          `已按应用记录校正核心选择器 -> ${friendlyName} (缓存残留的节点 ${current} 已被覆盖)`,
          'core'
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  private getClashSelection(clashPort: number, secret?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        const headers: Record<string, string> = {};
        if (secret) headers['Authorization'] = `Bearer ${secret}`;
        const req = http.request(
          { hostname: '127.0.0.1', port: clashPort, path: '/proxies/proxy', method: 'GET', headers, timeout: 1500 },
          (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => {
              try {
                const now = JSON.parse(body)?.now;
                resolve(typeof now === 'string' ? now : undefined);
              } catch {
                resolve(undefined);
              }
            });
          }
        );
        req.on('error', () => resolve(undefined));
        req.on('timeout', () => {
          req.destroy();
          resolve(undefined);
        });
        req.end();
      } catch {
        resolve(undefined);
      }
    });
  }

  private putClashSelection(clashPort: number, tag: string, secret?: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const payload = JSON.stringify({ name: tag });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        };
        if (secret) headers['Authorization'] = `Bearer ${secret}`;
        const req = http.request(
          { hostname: '127.0.0.1', port: clashPort, path: '/proxies/proxy', method: 'PUT', headers, timeout: 1500 },
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

  private runWithMutex<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(action, action);
    this.mutex = next.then(() => {}, () => {});
    return next;
  }

  private setState(state: CoreState) {
    this.state = state;
    this.emit('stateChange', state);
  }
}
