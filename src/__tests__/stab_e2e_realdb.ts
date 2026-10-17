/**
 * 一次性端到端校验(不计入 npm test):用生产数据库的真实节点/规则/设置
 * 走新代码生成配置,验证 CDN IP 节点的 ws Host 兜底与规则顺序,并过 sing-box check。
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ConfigGenerator } from '../main/core/ConfigGenerator';

const dataDir = 'C:/Users/Admin/Desktop/BlueWing/release/win-unpacked/data';
process.env.BLUEWING_DATA_DIR = dataDir;

const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'bluewing.json'), 'utf8'));
const config = ConfigGenerator.generate(
  db.activeNodeId,
  db.nodes,
  db.rules || [],
  db.appRules || [],
  db.dns,
  db.settings
);

const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/;
let checked = 0;
let withHost = 0;
for (const o of config.outbounds) {
  if (o.type === 'vless' && o.transport?.type === 'ws' && ipRe.test(o.server)) {
    checked++;
    if (o.transport.headers?.Host === o.tls?.server_name) withHost++;
  }
}
console.log(`vless+ws+IP-server outbounds: ${checked}, with Host=SNI: ${withHost}`);
if (checked === 0 || checked !== withHost) {
  throw new Error('Host fallback missing on some CDN IP nodes');
}

const rules: any[] = config.route.rules;
const idx = (pred: (r: any) => boolean) => rules.findIndex(pred);
const blockIdx = idx((r) => r.process_name && r.action === 'reject');
const cnIdx = idx((r) => r.rule_set?.includes('geosite-cn') && r.outbound === 'direct');
const edgeIdx = idx((r) => r.process_name?.includes('msedge.exe'));
console.log(`rule order: block@${blockIdx} < cnDirect@${cnIdx} < appProxy@${edgeIdx}`);
if (cnIdx < 0 || edgeIdx < cnIdx || (blockIdx >= 0 && cnIdx < blockIdx)) {
  throw new Error('route rule ordering wrong');
}

const tmp = path.join(dataDir, 'e2e-check-config.json');
fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
const singbox = 'C:/Users/Admin/Desktop/BlueWing/bin/sing-box.exe';
execFileSync(singbox, ['check', '-c', tmp]);
fs.unlinkSync(tmp);
console.log('sing-box check: PASS');
