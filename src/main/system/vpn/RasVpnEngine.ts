import { spawn } from 'child_process';
import path from 'path';
import { VpnProfile, VpnProfileType } from '../../../types';
import { VpnEngine, VpnEngineContext } from './EngineContract';
import { WindowsNetQuery, classifyAdapterRoutes } from './WindowsNetQuery';
import { RasCredentials, RAS_SETUP_SCRIPT, RAS_CLEAR_SCRIPT } from './RasCredentials';

/**
 * Windows 原生 RAS 引擎(IKEv2 / L2TP / SSTP)——零第三方二进制依赖。
 *
 * 连接:Add-VpnConnection 建电话簿条目(按用户,无需管理员)→ rasdial 拨号
 * (凭据经私有管道交给 Windows RAS 安全存储,argv 不含秘密)→ 轮询 WAN Miniport 适配器
 * Up → 查询路由/DNS 上报。断开:rasdial /disconnect + Remove-VpnConnection
 * 清掉电话簿条目,系统不残留。
 *
 * splitTunnel(默认开):-SplitTunneling $true 让 RAS 只落地服务端下发的内网
 * 路由、不接管默认路由;配合应用侧 custody 移交或 OS 路由直通两种模式。
 */

const TUNNEL_TYPE_MAP: Record<string, string> = {
  ikev2: 'Ikev2',
  l2tp: 'L2tp',
  sstp: 'Sstp',
};

const ADAPTER_DESC_MAP: Record<string, string> = {
  ikev2: 'WAN Miniport (IKEv2)',
  l2tp: 'WAN Miniport (L2TP)',
  sstp: 'WAN Miniport (SSTP)',
};

/** rasdial 常见退出码 → 可读原因 */
export function describeRasdialExitCode(code: number): string {
  switch (code) {
    case 0:
      return '连接成功';
    case 691:
      return '认证失败:用户名、密码或 L2TP 预共享密钥不正确';
    case 623:
      return '电话簿条目未找到';
    case 628:
      return '连接被服务器关闭(隧道协议或证书协商失败)';
    case 678:
      return '服务器无响应(地址或端口不可达)';
    case 692:
      return '硬件/端口错误';
    case 721:
      return '远端无应答';
    case 809:
      return '无法建立计算机与 VPN 服务器之间的网络连接(防火墙/NAT 或 UDP 500/4500 被拦)';
    case 789:
      return 'L2TP 安全协商失败:预共享密钥不匹配,或 UDP 500/4500 被拦截';
    case 800:
      return '无法建立 VPN 连接(服务器不可达或连接类型不匹配)';
    case 812:
      return '服务器策略拒绝该连接(认证方法不匹配)';
    case 13801:
      return 'IKEv2 服务器证书校验失败或未配置为接受 EAP';
    case 13806:
      return 'IKEv2 机器证书不可用';
    default:
      return `RAS 拨号失败(错误码 ${code})`;
  }
}

/** 电话簿条目名:ASCII + 档案 id,稳定可重拨、可幂等删除 */
export function rasEntryName(profile: VpnProfile): string {
  const safeId = profile.id.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'x';
  return `BlueWing VPN ${safeId}`;
}

export class RasVpnEngine implements VpnEngine {
  public readonly engineName = 'ras';
  private profile: VpnProfile | null = null;
  private entryName = '';
  private stopped = false;

  public async start(ctx: VpnEngineContext): Promise<void> {
    this.profile = ctx.profile;
    this.stopped = false;
    const { profile } = ctx;
    const tunnelType = TUNNEL_TYPE_MAP[profile.type as string];
    if (!tunnelType) {
      ctx.onError(`不支持的 RAS 隧道类型: ${profile.type}`);
      return;
    }
    if (!profile.server) {
      ctx.onError('缺少服务器地址');
      return;
    }
    this.entryName = rasEntryName(profile);

    // Secrets enter the Windows credential store via stdin and RasSetCredentialsW.
    const prepared = await RasCredentials.run(RAS_SETUP_SCRIPT, {
      entry:this.entryName, server:profile.server, tunnel:tunnelType,
      split:profile.splitTunnel !== false, suffix:profile.dnsSuffix || '',
      user:profile.username || '', password:profile.password || '',
      psk:profile.type === 'l2tp' ? profile.l2tpPsk || '' : '',
    });
    if (!prepared.ok) {
      ctx.onError('安全保存 Windows VPN 凭据或创建条目失败' + (prepared.code ? ' (RAS ' + prepared.code + ')' : ''));
      await this.cleanupEntry();
      return;
    }
    if (this.stopped) { await this.cleanupEntry(); return; }

    // rasdial reads cached Windows credentials; no username/password in argv.
    const dialCode = await this.rasdial([this.entryName]);
    if (dialCode !== 0) {
      ctx.onError(describeRasdialExitCode(dialCode));
      await this.cleanupEntry();
      return;
    }
    if (this.stopped) {
      await this.cleanupEntry();
      return;
    }

    // 3) 轮询 WAN Miniport 适配器 Up(RAS 拨号成功到适配器就绪有短暂延迟)
    const descPattern = ADAPTER_DESC_MAP[profile.type as string] || '';
    let adapter = await WindowsNetQuery.findAdapterByDescription([descPattern]);
    for (let i = 0; i < 10 && !adapter && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      adapter = await WindowsNetQuery.findAdapterByDescription([descPattern]);
    }
    if (!adapter) {
      ctx.onError('拨号成功但未能定位 VPN 网卡(WAN Miniport)');
      await this.disconnect();
      return;
    }

    // 4) 上报网络事实:直连子网(含 VPN 网关/DNS)计入内网段供分流;
    //    classify 内部已把直连子网从"可移交路由"中剔除(custody 安全),此处补回
    const network = await WindowsNetQuery.getAdapterNetwork(adapter.interfaceIndex);
    if (this.stopped) return;
    const { corp, fullTunnel } = classifyAdapterRoutes(network.routes, network.connectedPrefix);
    const routes = corp.concat(network.connectedPrefix && !corp.includes(network.connectedPrefix) ? [network.connectedPrefix] : []);
    ctx.onLog(
      'info',
      `RAS 连接建立:网卡 ${adapter.name},内网段 ${routes.length} 个${fullTunnel ? '(服务端下发了全隧道路由,已按分流处理)' : ''}`
    );
    ctx.onConnected();
    ctx.onNetworkInfo({
      adapterName: adapter.name,
      routes,
      dnsServers: network.dnsServers,
      domainSuffixes: network.domainSuffixes.concat(profile.dnsSuffix ? [profile.dnsSuffix] : []),
      ipv4: network.ipv4,
      installedOsRoutes: true,
    });
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    if (!this.entryName) return;
    await this.rasdial([this.entryName, '/disconnect']);
    await this.cleanupEntry();
  }

  private async cleanupEntry(): Promise<void> {
    if (!this.entryName) return;
    await RasCredentials.run(RAS_CLEAR_SCRIPT, {entry:this.entryName}, 10000);
  }

  /** 直拉 rasdial.exe(参数化 argv,不经 shell 拼接);返回退出码,异常返回 -1 */
  private rasdial(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rasdial.exe'), args, { windowsHide: true });
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve(-1);
        }, 90000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(-1);
        });
      } catch {
        resolve(-1);
      }
    });
  }
}
