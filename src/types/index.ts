import type { VpnProfile as CorporateVpnProfile } from './corporateVpn';
export type ProxyType =
  | 'vless'
  | 'vmess'
  | 'trojan'
  | 'shadowsocks'
  | 'shadowsocksr'
  | 'hysteria'
  | 'hysteria2'
  | 'tuic'
  | 'wireguard'
  | 'snell'
  | 'socks'
  | 'http'
  | 'naive';

export interface ProxyNode {
  id: string;
  name: string;
  type: ProxyType;
  server: string;
  port: number;
  groupId: string;
  starred?: boolean;
  ping?: number; // ms (-1 for timeout)
  httpLatency?: number; // ms (-1 for timeout)
  downloadSpeed?: number; // bits per second
  trafficUp?: number; // bytes
  trafficDown?: number; // bytes
  lastTested?: number; // timestamp
  
  // Auth & Security
  uuid?: string;
  username?: string;
  password?: string;
  method?: string; // SS / VMess cipher
  alterId?: number; // VMess
  network?: string; // tcp, udp
  flow?: string; // xtls-rprx-vision
  
  // TLS & Reality
  tls?: boolean;
  sni?: string;
  alpn?: string[];
  insecure?: boolean;
  reality?: boolean;
  publicKey?: string;
  shortId?: string;
  fingerprint?: string; // chrome, firefox, etc.
  
  // Transport
  transport?: 'tcp' | 'ws' | 'grpc' | 'http' | 'xhttp';
  transportPath?: string;
  transportHost?: string;
  xhttpMode?: 'auto' | 'download' | 'upload' | 'stream-up' | 'stream-one';
  xhttpExtraHeaders?: Record<string, string>;
  
  // WireGuard specific
  privateKey?: string;
  peerPublicKey?: string;
  localAddress?: string;
  presharedKey?: string;
  mtu?: number;
  reserved?: number[];
  
  // Hysteria / TUIC specific
  upMbps?: number;
  downMbps?: number;
  obfs?: string;
  congestionControl?: string; // bbr, cubic
  authStr?: string; // Hysteria 1
  protocol?: string; // Hysteria 1 protocol
  
  // Raw Sing-box Outbound JSON option fallback
  rawOutbound?: Record<string, any>;
}

export interface Subscription {
  id: string;
  name: string;
  url: string;
  nodeCount: number;
  lastUpdate: number;
  autoUpdate: boolean;
  updateIntervalHours: number;
  status: 'idle' | 'updating' | 'success' | 'error';
  errorMessage?: string;
  userInfo?: {
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
}

export interface RouteRule {
  id: string;
  name: string;
  enabled: boolean;
  domains?: string[]; // full:xxx, domain:xxx, geosite:xxx
  ip?: string[]; // cidr, geoip:xxx
  port?: string; // 80,443, 1000:2000
  sourcePort?: string;
  network?: string; // tcp, udp
  protocol?: string; // http, tls, dns, bittorrent
  processName?: string[]; // chrome.exe
  processPath?: string[];
  outbound: 'proxy' | 'direct' | 'block' | string; // 'proxy' or node ID
}

export interface AppRule {
  id: string;
  name: string;
  exePath: string;
  icon?: string;
  action: 'proxy' | 'direct' | 'block';
  enabled: boolean;
}

export interface DnsServerItem {
  id: string;
  tag: string;
  address: string; // e.g., https://1.1.1.1/dns-query, udp://223.5.5.5
  detour?: string; // 'direct' or 'proxy'
}

/** 应用内 Hosts 映射:域名 -> 指定 IP,由核心 DNS 直接返回,不修改系统 hosts 文件 */
export interface HostsRecord {
  id: string;
  domain: string; // e.g. example.com(精确匹配,与系统 hosts 语义一致)
  ip: string; // IPv4 或 IPv6
  enabled: boolean;
  remark?: string;
}

export interface DnsConfig {
  mode: 'standard' | 'fakeip';
  remoteDns: string;
  directDns: string;
  fakeIpRange: string;
  enableDnsRouting: boolean;
  servers: DnsServerItem[];
  /** 应用内 Hosts 映射记录(旧数据缺省时视为空) */
  hosts?: HostsRecord[];
}

export interface WebDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  remotePath: string; // default: "BlueWingConnect"
  autoSync: boolean;
  lastSyncTime?: number;
}

export interface AppSettings {
  // General
  theme: 'system' | 'light' | 'dark';
  language: 'zh-CN' | 'en-US';
  startOnBoot: boolean;
  startMinimized: boolean;
  autoConnectOnLaunch: boolean;
  closeToTray: boolean;
  
  // Inbound & Proxy
  mixedPort: number;
  allowLan: boolean;
  inboundAuth: boolean;
  inboundUser?: string;
  inboundPass?: string;
  systemProxyEnabled: boolean;
  systemProxyBypassLan: boolean;
  customBypassList?: string;
  
  // TUN Mode
  tunEnabled: boolean;
  tunMtu: number;
  tunStack: 'native' | 'system' | 'gvisor' | 'mixed';
  tunAutoRoute: boolean;
  tunStrictRoute: boolean;
  tunDnsHijack: boolean;
  tunIPv6: boolean;
  tunEndpointIndependentNat?: boolean;

  // DNS
  dnsCache?: boolean;
  dnsOptimistic?: boolean;
  
  // Core & Routing
  routingMode: 'rule' | 'global' | 'direct';
  logLevel: 'panic' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  clashApiEnabled: boolean;
  clashApiPort: number;
  clashApiSecret?: string;
  
  // Speed Test
  testUrl: string;
  testTimeoutMs: number;
  testConcurrent: number;
  
  // WebDAV
  webdav: WebDAVConfig;
}

export type CoreState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'crashed';

/** 节点延迟探测结果:latency=-1 时 reason 携带分类后的失败原因;
 *  via=tcp-fallback 表示核心未运行、仅 TCP 兜底(不代表代理通道可用) */
export interface LatencyResult {
  latency: number; // ms; -1 = 失败
  via: 'proxy-probe' | 'tcp-fallback' | 'proxy-port' | 'direct' | 'watchdog'; // watchdog=墙钟兜底强制结算
  reason?: string;
}

export interface TrafficStats {
  uploadSpeed: number; // bytes/s
  downloadSpeed: number; // bytes/s
  totalUpload: number; // bytes
  totalDownload: number; // bytes
  latency: number; // ms
  uptime: number; // seconds
  activeConnections: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  timeFormatted?: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source: 'core' | 'app' | 'net' | 'system';
}

export interface SpeedTestResult {
  nodeId: string;
  nodeName: string;
  ping: number; // ms
  downloadSpeed?: number; // bits/s
  uploadSpeed?: number; // bits/s
  status: 'pending' | 'testing' | 'success' | 'error';
  errorMessage?: string;
}

export interface BackupData {
  corporateVpn?: CorporateVpnProfile[];
  schema_version: number;
  app_version: string;
  timestamp: number;
  nodes: ProxyNode[];
  subscriptions: Subscription[];
  routing: {
    mode: 'rule' | 'global' | 'direct';
    rules: RouteRule[];
    appRules: AppRule[];
  };
  dns: DnsConfig;
  settings: Partial<AppSettings>;
  appearance: {
    theme: string;
  };
  webdav?: Partial<WebDAVConfig>;
}

export interface InstalledAppInfo {
  name: string;
  exePath: string;
  icon?: string;
  publisher?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// VPN 接入(在应用内直接登录第三方 VPN 账号)
// ---------------------------------------------------------------------------

/** VPN 账号类型:ikev2/l2tp/sstp 走 Windows 原生 RAS(零依赖);openvpn 走打包的
 *  openvpn.exe;anyconnect/fortinet/globalprotect/pulse/nc/f5/array 走打包的
 *  openconnect.exe(Cisco AnyConnect / FortiClient SSL VPN / Palo Alto GlobalProtect /
 *  Pulse(Ivanti) / Juniper Network Connect / F5 BIG-IP / Array Networks 协议)。
 * softether 复用服务器自带的兼容端点(L2TP/SSTP/OpenVPN),由 softetherMode 决定实际引擎。
 * WireGuard 不在此列——它原生作为 sing-box 节点出站,在"节点"页手动添加即可。
 * EasyConnect/aTrust/UniVPN 为厂商私有协议,无开源实现,不支持应用内登录(UI 提示)。 */
export type VpnProfileType =
  | 'ikev2'
  | 'l2tp'
  | 'sstp'
  | 'openvpn'
  | 'anyconnect'
  | 'fortinet'
  | 'globalprotect'
  | 'pulse'
  | 'nc'
  | 'f5'
  | 'array'
  | 'softether'
  | 'wireguard';

/** SoftEther 服务器自带的客户端兼容端点(服务器默认同时开启),决定实际使用的引擎 */
export type SoftEtherMode = 'l2tp' | 'sstp' | 'openvpn';

export interface VpnProfile {
  id: string;
  name: string;
  type: VpnProfileType;
  /** 服务器地址(RAS 为主机名/IP;OpenVPN 为 .ovpn 内 remote;openconnect 为完整 URL) */
  server: string;
  port?: number;
  username?: string;
  /** 仅存在于内存与 IPC 通道;落库时由 Database 用 DPAPI 加密 */
  password?: string;

  // RAS(ikev2/l2tp/sstp)
  /** 默认 true:不接管默认路由,只放行服务端下发的内网段 */
  splitTunnel?: boolean;
  /** L2TP 预共享密钥 */
  l2tpPsk?: string;
  /** RAS 连接特定 DNS 后缀;同时作为内网域名后缀种子注入 DNS 规则 */
  dnsSuffix?: string;

  // openconnect(anyconnect/fortinet/globalprotect)
  /** openconnect 表单入口/用户组(部分网关登录页需要) */
  usergroup?: string;
  /** openconnect 服务器证书指纹钉扎(--servercert);证书校验失败时日志会给出可填的指纹 */
  servercert?: string;
  /** 登录需要第二因子(令牌/短信码);连接时在 UI 输入一次性验证码 */
  useMfa?: boolean;

  // openvpn
  /** .ovpn 配置全文(内联证书;remote/auth 等连接级参数可留空由服务端配置覆盖) */
  configText?: string;
  /** .ovpn 使用 auth-user-pass 认证(用账号密码字段) */
  authUserPass?: boolean;
  /** 手动配置模式(无 configText 时):协议,默认 udp */
  ovpnProto?: 'udp' | 'tcp';
  /** 手动配置模式:服务器证书 PEM(含 BEGIN/END 行;可经"自动获取证书"抓取) */
  ovpnCaText?: string;

  /** 手动补充的内网 CIDR(引擎未上报或需要覆盖时的兜底,与自动上报合并) */
  extraRoutes?: string[];
  /** 用户自定义的公司域名(每行一个;以 domain_suffix 语义路由到 VPN 出站,含子域名) */
  customDomains?: string[];
  /** 固定域名解析(域名→IP 列表;predefined DNS+路由到 VPN,与 corporate 同语义) */
  hosts?: Record<string, string[]>;

  // softether:服务器兼容端点选择(l2tp/sstp/openvpn),默认 l2tp
  softetherMode?: SoftEtherMode;

  // wireguard(VPN 形态:内网分流,AllowedIPs 语义见 extraRoutes;
  // 注意与"节点"页的 WireGuard 节点不同——那是全量出口形态)
  privateKey?: string;
  peerPublicKey?: string;
  presharedKey?: string;
  /** 本机隧道地址,如 10.7.0.2/32 */
  localAddress?: string;
  wireguardMtu?: number;
  /** 企业内网 DNS(可选,查询经 WireGuard 隧道) */
  corpDns?: string;

  createdAt: number;
  lastConnected?: number;
}

export type VpnConnectionState = 'disconnected' | 'connecting' | 'enabled' | 'connected' | 'disconnecting' | 'error';

/** VPN 连接运行态(单连接模型:同一时刻只连一个) */
export interface VpnRuntimeInfo {
  profileId: string;
  profileName: string;
  state: VpnConnectionState;
  /** VPN 虚拟网卡的 Windows 连接名(vpn-corp 出站 bind_interface 的目标) */
  adapterName?: string;
  /** 引擎上报/解析出的内网 CIDR(已归一化、已剔除全隧道路由) */
  routes: string[];
  /** VPN 侧 DNS 服务器 */
  dnsServers: string[];
  /** 内网域名后缀(DNS 规则用) */
  domainSuffixes: string[];
  /** VPN 分配的本机地址 */
  ipv4?: string;
  /** 状态说明/错误信息 */
  message?: string;
  /** 进入当前状态的时间戳 */
  since: number;
}

/** ConfigGenerator 注入用:由 VpnEngineManager 从运行态推导 */
export interface VpnSplitConfig {
  /** 外部引擎 VPN 的虚拟网卡名(vpn-corp 出站 bind_interface 目标);
   *  WireGuard 型 VPN 无外部网卡,此字段为空并携带 wireguard 隧道参数 */
  adapterName?: string;
  routes: string[];
  /** 引擎 VPN 的固定域名解析(域名→IP;注入 predefined DNS+VPN 路由) */
  hosts?: Record<string, string[]>;
  dnsServers: string[];
  domainSuffixes: string[];
  /** WireGuard 型 VPN:sing-box 原生 endpoint(无外部进程/网卡,内网流量经此隧道) */
  wireguard?: {
    server: string;
    port: number;
    privateKey: string;
    peerPublicKey: string;
    presharedKey?: string;
    localAddress: string;
    mtu?: number;
  };
}

export interface BackupCategories {
  corporateVpn?: boolean; // Company configuration only; never credentials or sessions
  profiles: boolean; // 分组和配置 (groups + nodes)
  rules: boolean;    // 路由规则 (rules + appRules)
  settings: boolean; // 设置 (settings + dns + webdav)
}

export interface BackupPreviewItem {
  type: 'group' | 'node' | 'rule' | 'appRule' | 'setting' | 'corporateVpn';
  name: string;
  action: 'add' | 'update' | 'skip';
  detail?: string;
}

export interface BackupPreviewResult {
  valid: boolean;
  format: 'bluewing_windows' | 'bluewing_android' | 'singbox_config' | 'unknown';
  categories: BackupCategories;
  counts: {
    corporateVpn?: { total:number; add:number; update:number; skip:number };
    groups: { total: number; add: number; update: number; skip: number };
    nodes: { total: number; add: number; update: number; skip: number };
    rules: { total: number; add: number; update: number; skip: number };
    appRules: { total: number; add: number; update: number; skip: number };
    settings: { total: number; changed: number };
    unparseable: number;
  };
  itemsPreview: BackupPreviewItem[];
  warnings: string[];
  error?: string;
}

export interface BackupImportResult {
  success: boolean;
  message: string;
  snapshotPath?: string;
  importedCounts: {
    corporateVpn?: number;
    groups: number;
    nodes: number;
    rules: number;
    appRules: number;
    settings: number;
  };
}

