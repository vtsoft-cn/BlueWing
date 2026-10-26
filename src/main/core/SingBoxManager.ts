import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import http from 'http';
import { EventEmitter } from 'events';
import { CoreState } from '../../types';
import { LogManager } from '../log/LogManager';
import { Database } from '../db/Database';
import { isRunningAsAdmin } from '../system/Elevation';
import { TunAdapter } from '../system/TunAdapter';

export class SingBoxManager extends EventEmitter {
  private static instance: SingBoxManager;
  private process: ChildProcess | null = null;
  private state: CoreState = 'stopped';
  private configPath: string;
  private binaryPath: string;
  /** 本次 start() 是否因非管理员权限剥除了配置中的 TUN 入站(供上层兜底联动) */
  private tunStrippedLastStart = false;
  /** 当前/最近一次核心进程是否输出了 TUN 网卡配置失败特征行(幽灵网卡冲突) */
  private tunFatalSeen = false;

  // Lifecycle concurrency mutex
  private mutex: Promise<void> = Promise.resolve();
  private configEnricher?: (config:Record<string,any>)=>Promise<void>;
  public setConfigEnricher(enricher:(config:Record<string,any>)=>Promise<void>):void {this.configEnricher=enricher;}

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

  /** 最近一次 start():配置含 TUN 但因非管理员权限被剥除时为 true */
  public wasTunStrippedLastStart(): boolean {
    return this.tunStrippedLastStart;
  }

  /**
   * 取走"最近一次核心失败是否为 TUN 网卡冲突"标记(读后即清)。
   * 特征行形如 FATAL ... configure tun interface: (create adapter: ...
   * already exists ... | open existing adapter: Element not found.)——
   * wintun 网卡设备残留/异步删除未完成时按固定名创建必撞,进程在启动约 15s 后
   * 整体退出。上层据此决定是否清除幽灵网卡后重试。
   */
  public consumeTunAdapterFatal(): boolean {
    const seen = this.tunFatalSeen;
    this.tunFatalSeen = false;
    return seen;
  }

  private noteCoreOutputLine(line: string): void {
    if (!this.tunFatalSeen && /configure tun interface/i.test(line)) {
      this.tunFatalSeen = true;
    }
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
        const value=JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const redact=(item:any):void=>{if(!item||typeof item!=='object')return;for(const key of Object.keys(item)){if(/^(password|private_key|pre_shared_key|secret|uuid|username)$/i.test(key))item[key]='[REDACTED]';else redact(item[key]);}};
        redact(value);
        return JSON.stringify(value,null,2);
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
        proc.on('close', async () => {
          clearTimeout(timer);
          const pids = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s));
          const livePid = this.process?.pid;
          for (const pid of pids) {
            // 枚举期间刚被本实例拉起的核心不是孤儿:PS 枚举与用户点击连接可能并发,
            // 严禁误杀(this.process 已就位的核心)
            if (livePid && Number(pid) === livePid) continue;
            try {
              execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
            } catch {}
          }
          if (pids.length > 0) {
            this.log('warn', `已清理 ${pids.length} 个残留的孤儿 sing-box 进程 (PID: ${pids.join(', ')})`, 'core');
            // 被强杀的孤儿若持有 TUN 网卡,必然留下幽灵设备(按固定名创建网卡的
            // 下一个核心会在启动 15s 后 FATAL)。立即做 PnP 级清除(需管理员);
            // 失败静默——连接失败路径还有"清除+自动重连"兜底
            try {
              if (livePid === undefined && Database.getInstance().getSettings().tunEnabled) {
                const res = await TunAdapter.removeStale(4000);
                if (res.found) {
                  this.log(
                    res.cleared ? 'info' : 'warn',
                    res.cleared
                      ? '已清除残留的 TUN 网卡设备 (BlueWingTun)'
                      : 'TUN 网卡设备仍在异步清理中,若首次连接失败将自动重试',
                    'core'
                  );
                }
              }
            } catch {}
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
        const proc = spawn(this.binaryPath, ['check', '-c', testConfigPath], {
          // 与 run 一致:配置在 hosts/VPN 分流激活时省略 default_domain_resolver,
          // check 子进程必须携带同一 deprecated 豁免,否则启动前校验即 FATAL
          windowsHide: true,
          env: {
            ...process.env,
            ENABLE_DEPRECATED_LEGACY_DNS_ADDRESS_FILTER: 'true',
            ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true',
          },
        });
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
        await this.configEnricher?.(config);
        const admin = this.isAdmin();
        this.tunStrippedLastStart = false;
        this.tunFatalSeen = false;
        if (!admin && config.inbounds) {
          const hasTun = config.inbounds.some((i: any) => i.type === 'tun');
          if (hasTun) {
            config.inbounds = config.inbounds.filter((i: any) => i.type !== 'tun');
            this.tunStrippedLastStart = true;
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
          // sing-box 对配置中 DNS 旧版地址过滤字段直接拒启(FATAL);DNS 旧版"缺省
          // 域名解析器"移除后,出站解析改为绕过 dns.rules(Hosts 映射/VPN 内网 DNS
          // 在系统代理模式失效),该 env 恢复"经规则解析"行为。两变量均仅注入本
          // 应用拉起的核心子进程,不污染系统环境;仅当配置缺省相应字段时生效。
          env: {
            ...process.env,
            ENABLE_DEPRECATED_LEGACY_DNS_ADDRESS_FILTER: 'true',
            ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER: 'true',
          },
        });

        this.process.stdout?.on('data', (data) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              this.noteCoreOutputLine(line);
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
              this.noteCoreOutputLine(trimmed);
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

        // TUN 模式的就绪判定必须等到网卡真正出现在系统接口中:sing-box 的 mixed
        // 端口毫秒级就绪,而 TUN 入站撞上残留网卡时最长约 15s 后才 FATAL 退出——
        // 只探端口会把"必死"的核心先宣告为已连接(用户所见"连上后过一会就断")。
        // 18s 覆盖 sing-box 的 15s 入站超时;进程死亡也会立即终止等待。
        const tunInbound = config.inbounds?.find((i: any) => i.type === 'tun');
        const tunName: string | undefined = tunInbound?.interface_name;
        const isReady = await this.waitForReady(mixedPort, clashPort, tunName ? 18_000 : 5000, tunName);
        if (isReady && this.process && !this.process.killed) {
          this.setState('running');
          this.emit('configured',config);
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
   * Probe TCP mixed-in port readiness; with a TUN inbound additionally require the
   * TUN interface to actually come up (see start() for why port-only probing lies).
   */
  private async waitForReady(
    mixedPort: number,
    clashPort: number,
    timeoutMs: number,
    tunName?: string
  ): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!this.process || this.process.killed) {
        return false;
      }

      // Check if mixed port is accepting connections
      const portOpen = await this.checkPortOpen('127.0.0.1', mixedPort);
      if (portOpen && (!tunName || this.isTunInterfaceUp(tunName))) {
        return true;
      }

      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  /** TUN 网卡是否已带地址出现在系统网络接口中(名字做前缀匹配,容忍系统附加后缀) */
  private isTunInterfaceUp(name: string): boolean {
    const faces = os.networkInterfaces();
    return Object.keys(faces).some(
      (k) => (k === name || k.startsWith(name)) && (faces[k]?.length ?? 0) > 0
    );
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
