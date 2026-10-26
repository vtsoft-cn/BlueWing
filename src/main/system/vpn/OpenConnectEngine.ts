import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Database } from '../../db/Database';
import { VpnProfile } from '../../../types';
import { VpnEngine, VpnEngineContext } from './EngineContract';
import { WindowsNetQuery, classifyAdapterRoutes } from './WindowsNetQuery';

/**
 * openconnect 引擎(P3):Cisco AnyConnect / FortiClient SSL VPN /
 * Palo Alto GlobalProtect 协议的统一开源客户端(openconnect 官方 CLI)。
 *
 * openconnect 在 Windows 上以 wintun 后端运行(适配器名含 openconnect);
 * 登录采用 --passwd-on-stdin:首行为密码,启用 MFA 的档案第二行为一次性验证码
 * (openconnect 会按顺序消费两行)。证书校验失败时输出 --servercert 钉扎指纹,
 * 解析出来引导用户填入档案(不做自动信任)。
 *
 * 路由:openconnect 各版本在 Windows 上落地路由的行为不一致——引擎如实上报
 * 适配器上观测到的路由;若为空,用户可在档案 extraRoutes 手工补充内网段。
 */

/** openconnect 协议模式映射(档案类型 → openconnect --protocol 值);
 * 引擎二进制实测支持: anyconnect(default), nc, gp, pulse, f5, fortinet, array */
export const OPENCONNECT_PROTOCOL_MAP: Record<string, string> = {
  anyconnect: 'anyconnect',
  fortinet: 'fortinet',
  globalprotect: 'gp',
  pulse: 'pulse',
  nc: 'nc',
  f5: 'f5',
  array: 'array',
};

export interface OpenConnectLineEvent {
  type: 'connected' | 'cert-failed' | 'auth-failed' | 'connect-failed';
  ipv4?: string;
  certPin?: string;
  message?: string;
}

/** openconnect 输出行 → 事件(纯函数,供单测) */
export function parseOpenConnectLine(line: string): OpenConnectLineEvent | null {
  const l = line.trim();
  if (!l) return null;
  const connected = l.match(/^Connected as (\d{1,3}(?:\.\d{1,3}){3})/i);
  if (connected) {
    return { type: 'connected', ipv4: connected[1] };
  }
  if (/Server certificate verify failed/i.test(l)) {
    return { type: 'cert-failed', message: '服务器证书校验失败(自签名或不可信)' };
  }
  const pin = l.match(/pin-sha256:[A-Za-z0-9+/=]+/);
  if (pin) {
    return { type: 'cert-failed', certPin: pin[0], message: `服务器证书不可信,可将其指纹钉扎到档案: ${pin[0]}` };
  }
  if (/Failed to obtain WebVPN cookie|401 Unauthorized|Authentication failure/i.test(l)) {
    return { type: 'auth-failed', message: '认证失败:用户名、密码或验证码不正确' };
  }
  if (/Failed to connect to host|SSL connection failure|Unexpected HTTP response/i.test(l)) {
    return { type: 'connect-failed', message: `无法连接服务器: ${l}` };
  }
  return null;
}

export class OpenConnectEngine implements VpnEngine {
  public readonly engineName = 'openconnect';
  private proc: ChildProcess | null = null;
  private stopped = false;
  private exitNotified = false;
  private connectedNotified = false;

  /** 定位 openconnect.exe:安装包内置(bin/vpn/openconnect/ 或平铺 bin/vpn/)> 数据目录(用户自行放置) */
  public static locateBinary(): string | null {
    const dataDir = Database.getInstance().getDataDir();
    const bases = [
      path.join(process.resourcesPath || '', 'bin'),
      path.join(path.dirname(process.execPath || ''), 'resources', 'bin'),
      path.join(path.dirname(process.execPath || ''), 'bin'),
      path.join(process.cwd(), 'bin'),
      path.join(__dirname, '../../../bin'),
      path.join(dataDir, 'vpn-engines'),
    ];
    for (const base of bases) {
      for (const rel of ['vpn/openconnect/openconnect.exe', 'vpn/openconnect.exe', 'openconnect/openconnect.exe']) {
        const p = path.join(base, rel);
        if (fs.existsSync(p)) return path.resolve(p);
      }
    }
    return null;
  }

  public async start(ctx: VpnEngineContext): Promise<void> {
    this.stopped = false;
    const { profile } = ctx;

    const binary = OpenConnectEngine.locateBinary();
    if (!binary) {
      ctx.onError('未找到 openconnect 引擎 (openconnect.exe)。请在"VPN 接入"页按提示安装引擎后重试');
      return;
    }
    const protocol = OPENCONNECT_PROTOCOL_MAP[profile.type as string];
    if (!protocol) {
      ctx.onError(`不支持的 openconnect 协议类型: ${profile.type}`);
      return;
    }
    if (!profile.server) {
      ctx.onError('缺少服务器地址');
      return;
    }
    if (!profile.username) {
      ctx.onError('缺少用户名');
      return;
    }
    if (profile.useMfa && !ctx.mfaCode) {
      ctx.onError('该账号启用了双因素认证,连接时需要输入一次性验证码');
      return;
    }

    // 服务器地址归一为 URL(openconnect 接受 https://host[:port][/group])
    const server = profile.server.startsWith('http') ? profile.server : `https://${profile.server}`;

    const args = [
      `--protocol=${protocol}`,
      `--server=${server}`,
      `--user=${profile.username}`,
      '--passwd-on-stdin',
      '--no-dtls',
      '--reconnect-timeout=60',
      '--non-interactive',
    ];
    if (profile.port) args.push(`--serverport=${profile.port}`);
    if (profile.usergroup) args.push(`--usergroup=${profile.usergroup}`);
    if (profile.servercert) args.push(`--servercert=${profile.servercert}`);

    ctx.onLog('info', `正在启动 openconnect 引擎: ${binary}`);
    this.proc = spawn(binary, args, {
      cwd: path.dirname(binary),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 密码(及可选的第二因子)经 stdin 顺序写入;随后保持开路,不提前 EOF
    try {
      this.proc.stdin?.write(`${profile.password || ''}\n`);
      if (profile.useMfa && ctx.mfaCode) {
        this.proc.stdin?.write(`${ctx.mfaCode}\n`);
      }
    } catch {}

    this.proc.stdout?.on('data', (d) => this.handleOutput(ctx, d.toString()));
    this.proc.stderr?.on('data', (d) => this.handleOutput(ctx, d.toString()));
    this.proc.on('error', (err) => {
      ctx.onError(`openconnect 引擎启动失败: ${err.message}`);
    });
    this.proc.on('close', (code) => {
      this.proc = null;
      if (!this.stopped && !this.exitNotified) {
        this.exitNotified = true;
        ctx.onEngineExit(`openconnect 进程退出(代码 ${code ?? '未知'})`);
      }
    });
  }

  private handleOutput(ctx: VpnEngineContext, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const event = parseOpenConnectLine(line);
      if (!event) continue;
      switch (event.type) {
        case 'connected':
          void this.handleConnected(ctx, event.ipv4);
          break;
        case 'cert-failed':
        case 'auth-failed':
        case 'connect-failed':
          ctx.onError(event.message || 'openconnect 连接失败');
          break;
      }
    }
  }

  private async handleConnected(ctx: VpnEngineContext, ipv4?: string): Promise<void> {
    if (this.connectedNotified) return;
    this.connectedNotified = true;

    // 适配器名 openconnect 官方 Windows 构建固定含 "openconnect";就绪略滞后,轮询
    let adapter = await this.findOpenConnectAdapter();
    for (let i = 0; i < 10 && !adapter && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      adapter = await this.findOpenConnectAdapter();
    }

    if (!adapter) {
      ctx.onError('openconnect 已连接但未能定位其虚拟网卡');
      await this.stop();
      return;
    }

    const network = await WindowsNetQuery.getAdapterNetwork(adapter.interfaceIndex);
    const { corp, fullTunnel } = classifyAdapterRoutes(network.routes, network.connectedPrefix);
    // 直连子网(含 VPN 网关/DNS)补回内网段供分流(classify 为 custody 安全已剔除)
    const routes = corp.concat(network.connectedPrefix && !corp.includes(network.connectedPrefix) ? [network.connectedPrefix] : []);
    if (fullTunnel) {
      ctx.onLog(
        'warn',
        '检测到全隧道路由(默认路由经 VPN)。TUN 模式下会与本应用抢默认路由,建议在档案中改用分流或补充内网段'
      );
    }
    ctx.onLog('info', `openconnect 连接建立:网卡 ${adapter.name},内网段 ${routes.length} 个`);
    ctx.onConnected();
    ctx.onNetworkInfo({
      adapterName: adapter.name,
      routes,
      dnsServers: network.dnsServers,
      domainSuffixes: network.domainSuffixes.concat(ctx.profile.dnsSuffix ? [ctx.profile.dnsSuffix] : []),
      ipv4: ipv4 || network.ipv4,
      installedOsRoutes: corp.length > 0,
    });
  }

  private async findOpenConnectAdapter() {
    const byName = await WindowsNetQuery.findAdapterByName('openconnect');
    if (byName) return byName;
    return WindowsNetQuery.findAdapterByDescription(['openconnect']);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (proc?.pid) {
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
      } catch {}
    }
    this.proc = null;
  }
}
