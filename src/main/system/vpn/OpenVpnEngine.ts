import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Database } from '../../db/Database';
import { VpnProfile } from '../../../types';
import { VpnEngine, VpnEngineContext } from './EngineContract';
import { WindowsNetQuery, parseOpenVpnPushReply, classifyAdapterRoutes } from './WindowsNetQuery';

/**
 * OpenVPN 引擎(P2):驱动随应用分发的 openvpn.exe(2.6+,wintun 后端)。
 *
 * 关键设计:恒以 --route-nopull 运行——引擎不在 OS 路由表落地任何路由,
 * 推送内容从管理日志的 PUSH_REPLY 行解析(route/dhcp-option DNS/DOMAIN),
 * 交给 sing-box 的 vpn-corp 规则接管。好处:
 * - redirect-gateway 全隧道推送被自然忽略,不会与本应用 TUN 抢默认路由;
 * - 内网路由的生效与否完全由本应用的分流规则决定(数据经应用转发)。
 *
 * 适配器:连接成功后按 InterfaceDescription 匹配 OpenVPN 的 wintun/tap 网卡,
 * 其 Connection Name 即 sing-box bind_interface 的目标。
 */

export interface OpenVpnLineEvent {
  type: 'push' | 'connected' | 'auth-failed' | 'error';
  message?: string;
  push?: ReturnType<typeof parseOpenVpnPushReply>;
}

/** 管理输出行 → 事件(纯函数,供单测) */
export function parseOpenVpnLine(line: string): OpenVpnLineEvent | null {
  const l = line.trim();
  if (!l) return null;
  const pushMatch = l.match(/^PUSH: Received control message: 'PUSH_REPLY,(.*)'\s*$/);
  if (pushMatch) {
    return { type: 'push', push: parseOpenVpnPushReply(pushMatch[1]) };
  }
  if (l.includes('Initialization Sequence Completed')) {
    return { type: 'connected' };
  }
  if (l.includes('AUTH_FAILED')) {
    return { type: 'auth-failed', message: '认证失败:用户名或密码不正确 (AUTH_FAILED)' };
  }
  if (/Options error/i.test(l)) {
    return { type: 'error', message: `配置文件错误: ${l}` };
  }
  if (/Cannot open file|Error opening configuration file/i.test(l)) {
    return { type: 'error', message: `无法读取配置或证书文件: ${l}` };
  }
  if (/Cannot resolve host address/i.test(l)) {
    return { type: 'error', message: `无法解析服务器地址: ${l}` };
  }
  if (/Connection refused|connection timed out|TLS Error: TLS key negotiation failed/i.test(l)) {
    return { type: 'error', message: `无法连接服务器: ${l}` };
  }
  return null;
}

/**
 * 手动配置模式:由 服务器/端口/协议/CA证书 合成最小可用 .ovpn(纯函数,供单测)。
 * OpenVPN 的安全模型必须携带 CA/服务器证书(自签名网关不在系统信任库),
 * 这是"手动填写"仍需证书一项的原因。返回 null 表示必要项缺失。
 * 注意:证书必须以 <ca>...</ca> 内联标记包裹——OpenVPN 2.7 的内联文件语法要求
 * 显式 begin/end 标记,裸 PEM 块会被当指令行解析(报 Unrecognized option ---BEGIN)。
 */
export function buildManualOvpnConfig(input: {
  server?: string;
  port?: number;
  proto?: 'udp' | 'tcp';
  caText?: string;
}): string | null {
  const server = (input.server || '').trim();
  let ca = (input.caText || '').replace(/\r\n/g, '\n').trim();
  if (!server || !ca.includes('-----BEGIN CERTIFICATE-----')) return null;
  const proto = input.proto === 'tcp' ? 'tcp' : 'udp';
  const port = Number.isInteger(input.port) && (input.port as number) > 0 ? input.port : 1194;
  // 兼容用户粘贴时已带 <ca> 标记的输入;否则补包裹
  const hasInlineTag = /<ca>[\s\S]*<\/ca>/.test(ca);
  const caBlock = hasInlineTag ? ca : `<ca>\n${ca}\n</ca>`;
  // SoftEther 及大量老网关默认 AES-*-CBC(非 AEAD),2.7 默认 data-ciphers 不含它,
  // 协商即失败(OPTIONS ERROR: failed to negotiate cipher)。显式追加 CBC 兼容,
  // 现代服务端仍按协商优先级选 AEAD,不受影响。
  return [
    'client',
    `proto ${proto}`,
    `remote ${server} ${port}`,
    'dev tun',
    'data-ciphers DEFAULT:AES-128-CBC:AES-192-CBC:AES-256-CBC',
    'data-ciphers-fallback AES-128-CBC',
    // SoftEther 默认推送 redirect-gateway/dhcp-option,Windows 构建的 2.7 在
    // PUSH 上下文对这两项报硬错误(写入配置文件版,双保险)
    'pull-filter ignore "redirect-gateway"',
    'pull-filter ignore "dhcp-option"',
    caBlock,
    '',
  ].join('\n');
}

/** 纯函数:DER 证书 → PEM 文本(供自动抓取证书使用) */
export function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

export class OpenVpnEngine implements VpnEngine {
  public readonly engineName = 'openvpn';
  private proc: ChildProcess | null = null;
  private stopped = false;
  private exitNotified = false;
  private pushed: ReturnType<typeof parseOpenVpnPushReply> | null = null;
  private connectedNotified = false;
  private ctxRef: VpnEngineContext | null = null;

  /** 定位 openvpn.exe:安装包内置(bin/vpn/openvpn/ 或平铺 bin/vpn/)> 数据目录(用户自行放置) */
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
      for (const rel of ['vpn/openvpn/openvpn.exe', 'vpn/openvpn.exe', 'openvpn/openvpn.exe']) {
        const p = path.join(base, rel);
        if (fs.existsSync(p)) return path.resolve(p);
      }
    }
    return null;
  }

  public async start(ctx: VpnEngineContext): Promise<void> {
    this.ctxRef = ctx;
    this.stopped = false;
    const { profile } = ctx;

    const binary = OpenVpnEngine.locateBinary();
    if (!binary) {
      ctx.onError('未找到 OpenVPN 引擎 (openvpn.exe)。请在"VPN 接入"页按提示安装引擎后重试');
      return;
    }
    // 配置来源:完整 .ovpn 全文,或手动字段(服务器/端口/协议/CA)合成
    const manualConfig = buildManualOvpnConfig({
      server: profile.server,
      port: profile.port,
      proto: profile.ovpnProto,
      caText: profile.ovpnCaText,
    });
    const configContent = (profile.configText || '').trim() || manualConfig;
    if (!configContent) {
      ctx.onError(
        '缺少连接配置:请粘贴 .ovpn 全文,或填写"手动配置"(服务器地址 + CA 证书,证书可自动获取)'
      );
      return;
    }
    if (profile.authUserPass && !profile.username) {
      ctx.onError('已启用用户名密码认证,但未填写用户名');
      return;
    }

    const vpnDir = path.join(Database.getInstance().getDataDir(), 'vpn');
    fs.mkdirSync(vpnDir, { recursive: true });
    const configPath = path.join(vpnDir, `${profile.id}.ovpn`);
    fs.writeFileSync(configPath, configContent, 'utf8');

    const args = [
      '--config', configPath,
      '--route-nopull',
      // SoftEther 等网关会推送 redirect-gateway/dhcp-option;route-nopull 只忽略
      // route 类推送,Windows 构建的 2.7 对 PUSH 上下文里的这两项仍报 Options
      // error 并退出。用 pull-filter 精准丢弃(其余推送如拓扑/内网 DNS 域名保留,
      // 本应用走"内网段经应用接管"的数据面,不需要引擎落任何路由/DNS)。
      '--pull-filter', 'ignore', 'redirect-gateway',
      '--pull-filter', 'ignore', 'dhcp-option',
      '--connect-retry-max', '3',
      '--connect-timeout', '20',
      '--verb', '3',
    ];

    if (profile.authUserPass && profile.username) {
      const authPath = path.join(vpnDir, `${profile.id}.auth`);
      fs.writeFileSync(
        authPath,
        `${profile.username}\n${profile.password || ''}\n`,
        'utf8'
      );
      args.push('--auth-user-pass', authPath);
    }

    ctx.onLog('info', `正在启动 OpenVPN 引擎: ${binary}`);
    this.proc = spawn(binary, args, {
      cwd: path.dirname(binary),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (d) => this.handleOutput(ctx, d.toString(), false));
    this.proc.stderr?.on('data', (d) => this.handleOutput(ctx, d.toString(), false));
    this.proc.on('error', (err) => {
      ctx.onError(`OpenVPN 引擎启动失败: ${err.message}`);
    });
    this.proc.on('close', (code) => {
      this.proc = null;
      if (!this.stopped && !this.exitNotified) {
        this.exitNotified = true;
        ctx.onEngineExit(`OpenVPN 进程退出(代码 ${code ?? '未知'})`);
      }
    });
  }

  private handleOutput(ctx: VpnEngineContext, chunk: string, _isStderr: boolean): void {
    for (const line of chunk.split(/\r?\n/)) {
      const event = parseOpenVpnLine(line);
      if (!event) continue;
      switch (event.type) {
        case 'push':
          if (event.push) {
            // 多条 PUSH_REPLY 逐条合并(连接前配置推送 + 连接后更新)
            const merged = this.pushed || { routes: [], dnsServers: [], domainSuffixes: [], fullTunnel: false };
            for (const r of event.push.routes) if (!merged.routes.includes(r)) merged.routes.push(r);
            for (const d of event.push.dnsServers) if (!merged.dnsServers.includes(d)) merged.dnsServers.push(d);
            for (const s of event.push.domainSuffixes) if (!merged.domainSuffixes.includes(s)) merged.domainSuffixes.push(s);
            if (event.push.fullTunnel) merged.fullTunnel = true;
            this.pushed = merged;
          }
          break;
        case 'connected':
          void this.handleConnected(ctx);
          break;
        case 'auth-failed':
        case 'error': {
          // [PUSH-OPTIONS] 上下文的 Options error 是"服务端推送了本端不适用的选项"
          // (如 block-outside-dns、与设备类型不符的路由),OpenVPN 仅告警并继续;
          // 连接已建立后的同类噪声同理。真正致命的失败必然以进程退出暴露(onEngineExit)。
          const pushNoise = (event.message || '').includes('[PUSH-OPTIONS]');
          if (pushNoise || this.connectedNotified) {
            ctx.onLog('warn', event.message || line);
          } else {
            ctx.onError(event.message || 'OpenVPN 连接失败');
          }
          break;
        }
      }
    }
  }

  private async handleConnected(ctx: VpnEngineContext): Promise<void> {
    if (this.connectedNotified) return;
    this.connectedNotified = true;

    // 适配器就绪略晚于 "Initialization Sequence Completed",短暂轮询
    let adapter = await WindowsNetQuery.findAdapterByDescription([
      'openvpn wintun',
      'wintun userspace tunnel',
      'tap-windows adapter',
    ]);
    for (let i = 0; i < 10 && !adapter && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      adapter = await WindowsNetQuery.findAdapterByDescription([
        'openvpn wintun',
        'wintun userspace tunnel',
        'tap-windows adapter',
      ]);
    }

    if (!adapter) {
      ctx.onError('OpenVPN 已连接但未能定位其虚拟网卡');
      await this.stop();
      return;
    }

    const network = await WindowsNetQuery.getAdapterNetwork(adapter.interfaceIndex);
    const push = this.pushed;
    // 路由优先取 PUSH_REPLY 解析(--route-nopull 下 OS 表没有);DNS 兜底查适配器;
    // 直连子网(含 VPN 网关/DNS)补回内网段
    const baseRoutes =
      push && push.routes.length > 0 ? push.routes : classifyAdapterRoutes(network.routes, network.connectedPrefix).corp;
    const routes =
      network.connectedPrefix && !baseRoutes.includes(network.connectedPrefix)
        ? baseRoutes.concat([network.connectedPrefix])
        : baseRoutes;
    const dnsServers = push && push.dnsServers.length > 0 ? push.dnsServers : network.dnsServers;
    const suffixes = (push ? push.domainSuffixes : []).concat(network.domainSuffixes);

    if (push?.fullTunnel) {
      ctx.onLog('warn', '服务端下发了全隧道路由(redirect-gateway),已按分流模式忽略——仅内网段经 VPN');
    }
    ctx.onLog('info', `OpenVPN 连接建立:网卡 ${adapter.name},内网段 ${routes.length} 个`);
    ctx.onConnected();
    ctx.onNetworkInfo({
      adapterName: adapter.name,
      routes,
      dnsServers,
      domainSuffixes: suffixes,
      ipv4: network.ipv4,
      installedOsRoutes: false,
    });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (proc?.pid) {
      try {
        // Windows 下 Node 的 proc.kill() 即 TerminateProcess;openvpn 无优雅信号通道
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { windowsHide: true });
      } catch {}
    }
    this.proc = null;
  }
}
