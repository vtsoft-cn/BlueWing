/** 集成核验:真实电话簿上执行引擎的 PSK 直写方法,读回确认落盘 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Database } from '../src/main/db/Database';
import { RasVpnEngine } from '../src/main/system/vpn/RasVpnEngine';

Database.getInstance(path.join(os.tmpdir(), 'bw-ras-dialtest'));
const engine = new RasVpnEngine();
const ok = (engine as any).applyPhonebookPsk('BW PSK Check', 'psk789') as boolean;
console.log('applyPhonebookPsk ->', ok);
const pbk = fs.readFileSync(
  path.join(process.env.APPDATA || '', 'Microsoft', 'Network', 'Connections', 'Pbk', 'rasphone.pbk'),
  'latin1'
);
const m = pbk.match(/IpSecFlags=\d+[\s\S]{0,60}?L2tpPsk=[^\r\n]*/);
console.log('pbk around PSK ->', m ? m[0].replace(/\r?\n/g, ' | ') : 'NOT FOUND');
