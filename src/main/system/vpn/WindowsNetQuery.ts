import { spawn } from 'child_process';
import { LogManager } from '../../log/LogManager';

/**
 * Windows 网络状态查询与路由操作(PowerShell 封装)。
 *
 * 供三个 VPN 引擎共用:适配器发现(拿 Connection Name 作 bind_interface 目标)、
 * 适配器路由/DNS/地址查询、custody 模式下的系统路由移交(删除引擎装好的内网
 * 路由 + 为 VPN DNS 补 on-link 主机路由,让内网流量落回 TUN 由 vpn-corp 出站接管)。
 *
 * 约定:
 * - 所有 PS 脚本纯 ASCII,动态值一律经 psEscape 单引号内插,绝不能拼裸值;
 * - 查询输出统一 ConvertTo-Json -Compress -InputObject(空数组/单元素在 PS 5.1
 *   下形状不稳定,由 parseJsonList 归一化);
 * - 任何异常/超时都以"空结果"结算,绝不悬挂调用方(与 TunAdapter 同一纪律)。
 */

export interface AdapterInfo {
  name: string;
  interfaceIndex: number;
  description: string;
}

export interface AdapterNetwork {
  routes: string[];
  dnsServers: string[];
  domainSuffixes: string[];
  ipv4?: string;
  /** 适配器自身的直连子网(如 10.8.0.0/24),custody 移交时必须保留 */
  connectedPrefix?: string;
}

/** PS 单引号字符串转义:单引号翻倍 */
export function psEscape(s: string): string {
  return String(s ?? '').replace(/'/g, "''");
}

/** PS JSON 输出归一化:空输出/单对象/数组 → 统一为数组 */
export function parseJsonList(out: string): any[] {
  const trimmed = (out || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    return [];
  }
}

/** 判断 IPv4 地址是否落在 CIDR 内 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = String(cidr || '').split('/');
  const bits = Number(bitsRaw);
  const ipParts = String(ip || '').split('.');
  const netParts = String(net || '').split('.');
  if (ipParts.length !== 4 || netParts.length !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipNum = ipParts.reduce((acc, p) => (acc << 8) + (Number(p) || 0), 0) >>> 0;
  const netNum = netParts.reduce((acc, p) => (acc << 8) + (Number(p) || 0), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/**
 * 归一化适配器上的路由:剔除链路本地/组播/广播/回环、本机直连子网与其上的
 * on-link /32(本机地址/广播地址),返回企业内网 CIDR 与"是否全隧道"标记
 * (0/0、0/1、128.0.0.0/1、::/0)。
 */
export function classifyAdapterRoutes(
  prefixes: string[],
  connectedPrefix?: string
): { corp: string[]; fullTunnel: boolean } {
  const junk = /^(127\.|169\.254\.|224\.|239\.|255\.255\.255\.255|fe80:|ff..:)/i;
  const fullTunnelMarkers = ['0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1', '::/0'];
  let fullTunnel = false;
  const corp: string[] = [];
  for (const raw of prefixes) {
    const p = String(raw || '').trim();
    if (!p || junk.test(p)) continue;
    if (fullTunnelMarkers.includes(p)) {
      fullTunnel = true;
      continue;
    }
    if (connectedPrefix) {
      if (p === connectedPrefix) continue;
      const [addr, bits] = p.split('/');
      if (bits === '32' && ipInCidr(addr, connectedPrefix)) continue;
    }
    if (!corp.includes(p)) corp.push(p);
  }
  return { corp, fullTunnel };
}

/** 点分掩码 → 前缀长度;非法返回 -1 */
export function maskToPrefixLength(mask: string): number {
  const parts = String(mask || '').split('.');
  if (parts.length !== 4) return -1;
  let bits = 0;
  let seenZero = false;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return -1;
    for (let b = 7; b >= 0; b--) {
      const bit = (n >> b) & 1;
      if (bit === 1) {
        if (seenZero) return -1; // 非连续掩码
        bits++;
      } else {
        seenZero = true;
      }
    }
  }
  return bits;
}

/** IPv4 地址 + 前缀长度 → 网络地址 CIDR(如 10.8.0.6/24 → 10.8.0.0/24);非法返回 null */
export function toNetworkCidr(ip: string, prefixLength: number): string | null {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4 || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return null;
  const octets: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  for (let i = 0; i < 4; i++) {
    const bitsLeft = i * 8;
    let keep = 0;
    if (prefixLength >= bitsLeft + 8) keep = 255;
    else if (prefixLength > bitsLeft) keep = (0xff << (bitsLeft + 8 - prefixLength)) & 0xff;
    octets[i] &= keep;
  }
  return `${octets.join('.')}/${prefixLength}`;
}

export interface ParsedPushReply {
  routes: string[];
  dnsServers: string[];
  domainSuffixes: string[];
  fullTunnel: boolean;
}

/**
 * 解析 OpenVPN 服务端 PUSH_REPLY(配合 --route-nopull 使用:引擎不落地任何路由,
 * 由本应用解析后经 sing-box 规则接管)。
 * 形如:PUSH: Received control message: 'PUSH_REPLY,route 10.1.2.0 255.255.255.0,dhcp-option DNS 10.1.2.53,...'
 */
export function parseOpenVpnPushReply(pushBody: string): ParsedPushReply {
  const result: ParsedPushReply = { routes: [], dnsServers: [], domainSuffixes: [], fullTunnel: false };
  const tokens = pushBody.split(',');
  for (const token of tokens) {
    const t = token.trim();
    if (t.startsWith('route ')) {
      const segs = t.split(/\s+/);
      const net = segs[1];
      const mask = segs[2] || '255.255.255.255';
      const prefix = maskToPrefixLength(mask);
      if (!net || prefix < 0) continue;
      const cidr = `${net}/${prefix}`;
      if (['0.0.0.0/0', '0.0.0.0/1', '128.0.0.0/1'].includes(cidr)) {
        result.fullTunnel = true;
        continue;
      }
      if (!result.routes.includes(cidr)) result.routes.push(cidr);
    } else if (t.startsWith('dhcp-option DNS ')) {
      const ip = t.slice('dhcp-option DNS '.length).trim();
      if (ip && !result.dnsServers.includes(ip)) result.dnsServers.push(ip);
    } else if (t.startsWith('dhcp-option DOMAIN ')) {
      const s = t.slice('dhcp-option DOMAIN '.length).trim().toLowerCase().replace(/^\.+/, '');
      if (s && !result.domainSuffixes.includes(s)) result.domainSuffixes.push(s);
    } else if (t.startsWith('redirect-gateway')) {
      result.fullTunnel = true;
    }
  }
  return result;
}

export class WindowsNetQuery {
  /** 执行 PS 脚本并收集原始输出;异常/超时以空串结算 */
  public static runPowerShell(script: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      try {
        const proc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true }
        );
        let out = '';
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve('');
        }, timeoutMs);
        proc.stdout?.on('data', (d) => (out += d.toString()));
        // PS 版本告警等可能走 stderr,不视为失败
        proc.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve('');
        });
      } catch (e: any) {
        LogManager.getInstance().addLog('warn', `网络状态查询异常: ${e?.message || e}`, 'system');
        resolve('');
      }
    });
  }

  private static async runPowerShellJson(script: string, timeoutMs: number): Promise<any[]> {
    const out = await WindowsNetQuery.runPowerShell(script, timeoutMs);
    return parseJsonList(out);
  }

  /** 枚举当前 Up 状态的物理/虚拟网卡 */
  public static async listUpAdapters(): Promise<AdapterInfo[]> {
    const script =
      `$r=@(Get-NetAdapter -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.Status -eq 'Up' } | ` +
      `Select-Object Name,InterfaceIndex,InterfaceDescription); ` +
      `ConvertTo-Json -Compress -InputObject $r`;
    const list = await WindowsNetQuery.runPowerShellJson(script, 8000);
    return list
      .filter((a) => a && a.Name !== undefined)
      .map((a) => ({
        name: String(a.Name),
        interfaceIndex: Number(a.InterfaceIndex) || 0,
        description: String(a.InterfaceDescription || ''),
      }));
  }

  /**
   * 按 InterfaceDescription(子串、大小写不敏感)匹配 Up 状态网卡。
   * 多块命中时取第一块(同型多适配器场景罕见,先到先得)。
   */
  public static async findAdapterByDescription(patterns: string[]): Promise<AdapterInfo | null> {
    if (!patterns.length) return null;
    const adapters = await WindowsNetQuery.listUpAdapters();
    const lowered = patterns.map((p) => p.toLowerCase());
    for (const pat of lowered) {
      const hit = adapters.find((a) => a.description.toLowerCase().includes(pat));
      if (hit) return hit;
    }
    return null;
  }

  /** 按连接名(Connection Name)子串匹配 Up 状态网卡 */
  public static async findAdapterByName(pattern: string): Promise<AdapterInfo | null> {
    if (!pattern) return null;
    const adapters = await WindowsNetQuery.listUpAdapters();
    return adapters.find((a) => a.name.toLowerCase().includes(pattern.toLowerCase())) || null;
  }

  /**
   * 查询一块网卡的完整网络信息(IPv4):路由表、DNS 服务器、连接特定后缀、本机地址
   * 与直连子网。三次查询合并为一次 PS 调用,减少进程开销。
   */
  public static async getAdapterNetwork(ifIndex: number): Promise<AdapterNetwork> {
    const script =
      `$i=${ifIndex}; ` +
      `$routes=@(Get-NetRoute -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty DestinationPrefix); ` +
      `$dns=@(Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty ServerAddresses); ` +
      `$suffix=(Get-DnsClient -InterfaceIndex $i -ErrorAction SilentlyContinue | ` +
      `Select-Object -First 1 -ExpandProperty ConnectionSpecificSuffix); ` +
      `$ip=@(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.IPAddress -notlike '169.254*' } | ` +
      `Select-Object IPAddress,PrefixLength | Select-Object -First 1); ` +
      `$o=[pscustomobject]@{routes=$routes;dns=$dns;suffix=$suffix;ip=$ip}; ` +
      `ConvertTo-Json -Compress -InputObject $o`;
    const rows = await WindowsNetQuery.runPowerShellJson(script, 10000);
    const o = rows[0] || {};
    const network: AdapterNetwork = {
      routes: Array.isArray(o.routes) ? o.routes.map(String).filter(Boolean) : [],
      dnsServers: Array.isArray(o.dns) ? o.dns.map(String).filter(Boolean) : [],
      domainSuffixes: [],
      // @(包一层)的单元素结果在 PS 5.1 JSON 里可能是数组也可能是裸对象,双形态兼容
      ipv4: undefined,
    };
    const ipObj = Array.isArray(o.ip) ? o.ip[0] : o.ip;
    if (ipObj && ipObj.IPAddress) {
      network.ipv4 = String(ipObj.IPAddress);
      const prefixLen = Number(ipObj.PrefixLength);
      if (network.ipv4 && Number.isInteger(prefixLen)) {
        const net = toNetworkCidr(network.ipv4, prefixLen);
        if (net) network.connectedPrefix = net;
      }
    }
    const suffix = String(o.suffix || '').trim().toLowerCase().replace(/\.$/, '');
    if (suffix && suffix !== '[无]' && !suffix.includes(' ')) {
      network.domainSuffixes.push(suffix);
    }
    return network;
  }

  /**
   * custody 移交:为 VPN DNS 补 on-link 主机路由(挥发性,ActiveStore),
   * 再删除适配器上指定的内网路由——路由被移除后,内网目的地不再有比 TUN
   * (0/1+128/0/1)更精确的 OS 路由,流量落回 TUN 经 vpn-corp 出站接管;
   * DNS 依赖保留的主机路由仍可在适配器内可达(sing-box vpn-dns detour 绑定适配器)。
   * 返回删除失败(通常是无管理员权限)的路由数。
   */
  public static async handOverRoutes(
    ifIndex: number,
    prefixesToRemove: string[],
    dnsIps: string[]
  ): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;

    // 1) 先补 DNS 主机路由,避免删除窗口内 vpn-dns 不可达
    for (const ip of dnsIps) {
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) continue;
      const script =
        `New-NetRoute -InterfaceIndex ${ifIndex} -DestinationPrefix '${psEscape(ip)}/32' ` +
        `-NextHop '0.0.0.0' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null; ` +
        `if ($?) { 'ok' } else { 'skip' }`;
      await WindowsNetQuery.runPowerShell(script, 8000);
    }

    // 2) 删除内网路由
    for (const prefix of prefixesToRemove) {
      const script =
        `$r = Get-NetRoute -InterfaceIndex ${ifIndex} -DestinationPrefix '${psEscape(prefix)}' ` +
        `-ErrorAction SilentlyContinue; ` +
        `if ($r) { $r | Remove-NetRoute -Confirm:$false -ErrorAction Stop; 'ok' } else { 'absent' }`;
      const out = await WindowsNetQuery.runPowerShell(script, 8000);
      const verdict = out.trim();
      if (verdict.endsWith('ok')) removed++;
      else if (verdict.endsWith('absent')) {
        // 本就不在(引擎未装/已删),视为已移交
      } else failed++;
    }
    return { removed, failed };
  }
}
