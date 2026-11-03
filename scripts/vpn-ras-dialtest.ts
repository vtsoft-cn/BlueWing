/**
 * RAS 引擎拨号管线本地验证:对 127.0.0.1(L2TP UDP 500 无人监听)走完整引擎路径,
 * 观察 Add-VpnConnection → rasdial → 错误码上抛的真实表现。
 * 用法:npx tsx scripts/vpn-ras-dialtest.ts
 */
import path from 'path';
import os from 'os';
import { Database } from '../src/main/db/Database';
import { RasVpnEngine, describeRasdialExitCode } from '../src/main/system/vpn/RasVpnEngine';
import { VpnEngineContext } from '../src/main/system/vpn/EngineContract';
import { VpnProfile } from '../src/types';

async function main() {
  Database.getInstance(path.join(os.tmpdir(), 'bw-ras-dialtest'));

  const profile: VpnProfile = {
    id: 'dialtest3',
    name: '拨号链路测试',
    type: 'l2tp',
    server: '127.0.0.1',
    username: 'hub1\\alice',
    password: 'pw',
    l2tpPsk: 'testpsk',
    createdAt: Date.now(),
  };

  const engine = new RasVpnEngine();
  const ctx: VpnEngineContext = {
    profile,
    onConnected: () => console.log('[event] CONNECTED'),
    onNetworkInfo: (i) => console.log('[event] NETWORK', JSON.stringify(i)),
    onError: (m) => console.log('[event] ERROR:', m),
    onEngineExit: (m) => console.log('[event] EXIT:', m),
    onLog: (lv, m) => console.log(`[log:${lv}] ${m}`),
  };

  const t0 = Date.now();
  await engine.start(ctx);
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('常见错误码参考: 691 认证/PSK, 809 UDP被拦/NAT, 678 无响应, 812 策略, -1 超时');
  // 退出前清掉条目
  await engine.stop();
  process.exit(0);
}

void main();
