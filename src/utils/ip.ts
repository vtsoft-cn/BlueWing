/**
 * 主进程与渲染层共用的 IP / 域名字面量校验。
 * 注意:IPv6 不接受 IPv4 映射形式 (::ffff:1.2.3.4),需要 IPv4 时请直接填写 IPv4。
 */

/** IPv4 / IPv6 字面量校验,支持 "::" 压缩形式与方括号包裹的 v6 */
export function isValidIpLiteral(input: string): boolean {
  const v = String(input || '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!v) return false;

  // IPv4: 四段十进制,各段 0-255
  if (v.includes('.') && !v.includes(':')) {
    const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    return !!m && m.slice(1).every((p) => /^[0-9]+$/.test(p) && Number(p) <= 255);
  }

  // IPv6: 字符集约束 + "::" 至多出现一次 + 组数校验
  if (!/^[0-9A-Fa-f:.]+$/.test(v)) return false;
  const parts = v.split('::');
  if (parts.length > 2) return false;

  if (parts.length === 1) {
    // 无压缩:必须恰好 8 组
    const groups = v.split(':');
    return groups.length === 8 && groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g));
  }

  // 有压缩:"::" 两侧组数合计须小于 8(允许一侧为空,如 "::1"、"fd00::")
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] ? parts[1].split(':') : [];
  const validGroup = (g: string) => /^[0-9A-Fa-f]{1,4}$/.test(g);
  return head.every(validGroup) && tail.every(validGroup) && head.length + tail.length < 8;
}

/** 域名校验(单标签主机名如 "nas" 也放行,便于内网场景) */
export function isValidDomain(input: string): boolean {
  const v = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!v || v.length > 253) return false;
  const labels = v.split('.');
  return labels.every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
