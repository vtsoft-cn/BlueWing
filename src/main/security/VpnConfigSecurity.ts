// Supported OpenVPN directives exclude code loading, shell hooks, management and
// external config/file inclusion. Inline certificate/key data remain supported.
const allowed = new Set(('client dev dev-type proto remote remote-random remote-random-hostname resolv-retry nobind persist-key persist-tun remote-cert-tls verify-x509-name auth-nocache auth-user-pass cipher data-ciphers data-ciphers-fallback auth verb mute connect-retry connect-retry-max connect-timeout server-poll-timeout key-direction tls-version-min tls-version-max tls-cipher tls-ciphersuites tls-auth tls-crypt ca cert key reneg-sec tun-mtu mssfix sndbuf rcvbuf keepalive ping ping-restart float explicit-exit-notify pull pull-filter route-nopull route route-ipv6 redirect-gateway dhcp-option fast-io allow-compression comp-lzo compress tls-client auth-retry connect-retry').split(' '));
const inline = new Set(['ca','cert','key','tls-auth','tls-crypt']);
export function validateVpnId(id: string): void {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('VPN 配置 ID 不正确');
}
export function validateOpenVpnConfig(content: string): void {
  if (content.length > 2 * 1024 * 1024) throw new Error('OpenVPN 配置过大');
  let block = '';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (block) { if (line === `</${block}>`) block = ''; continue; }
    const opening = /^<([^>]+)>$/.exec(line);
    if (opening) {
      if (!inline.has(opening[1])) throw new Error(`不支持的 OpenVPN 内联块：${opening[1]}`);
      block = opening[1]; continue;
    }
    const [option, ...args] = line.replace(/^--/, '').split(/\s+/);
    if (!allowed.has(option) || /[\\\r\n]/.test(option)) throw new Error(`OpenVPN 配置包含不允许的指令：${option}`);
    if (inline.has(option) && args[0] !== '[inline]') throw new Error('证书与密钥必须使用内联块，不能读取外部文件');
    if (option === 'auth-user-pass' && args.length) throw new Error('认证信息请填写在账号密码字段中');
  }
  if (block) throw new Error('OpenVPN 内联块未结束');
}
