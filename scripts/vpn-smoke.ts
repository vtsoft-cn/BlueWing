/**
 * 头less 冒烟:真实 PowerShell 上验证 WindowsNetQuery 的 PS 脚本语法与解析。
 * 用法:npx tsx scripts/vpn-smoke.ts
 */
import { WindowsNetQuery, psEscape, classifyAdapterRoutes } from '../src/main/system/vpn/WindowsNetQuery';
import { Database } from '../src/main/db/Database';
import path from 'path';
import os from 'os';

async function main() {
  // 隔离数据目录,避免 LogManager/Database 写入真实用户数据
  const tmp = path.join(os.tmpdir(), 'bw-vpn-smoke');
  Database.getInstance(tmp);

  console.log('== listUpAdapters ==');
  const adapters = await WindowsNetQuery.listUpAdapters();
  console.log(JSON.stringify(adapters, null, 2));

  if (adapters.length > 0) {
    console.log(`== getAdapterNetwork(${adapters[0].name}, if=${adapters[0].interfaceIndex}) ==`);
    const net = await WindowsNetQuery.getAdapterNetwork(adapters[0].interfaceIndex);
    console.log(JSON.stringify(net, null, 2));
    console.log('classify:', JSON.stringify(classifyAdapterRoutes(net.routes, net.connectedPrefix)));
  }

  console.log('== RAS 电话簿条目幂等创建/删除(Add/Remove-VpnConnection)==');
  const name = 'BlueWing VPN smoketest1';
  const addScript =
    `Remove-VpnConnection -Name '${psEscape(name)}' -Force -ErrorAction SilentlyContinue; ` +
    `$null = Add-VpnConnection -Name '${psEscape(name)}' ` +
    `-ServerAddress 'smoke.invalid' -TunnelType Ikev2 -SplitTunneling:$true -Force; ` +
    `if ($?) { 'ok' } else { 'fail' }`;
  const addOut = await WindowsNetQuery.runPowerShell(addScript, 15000);
  console.log('add:', JSON.stringify(addOut.trim()));
  const removeScript = `Remove-VpnConnection -Name '${psEscape(name)}' -Force -ErrorAction SilentlyContinue; 'done'`;
  const rmOut = await WindowsNetQuery.runPowerShell(removeScript, 10000);
  console.log('remove:', JSON.stringify(rmOut.trim()));

  console.log('SMOKE OK');
  process.exit(0);
}

void main();
