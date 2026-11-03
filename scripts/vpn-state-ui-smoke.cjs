// Exercise the real preload and React view with isolated IPC. No VPN is started.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'work', 'corporate-vpn-tools', 'state-ui-smoke');
fs.mkdirSync(out, { recursive: true });
const binary = process.env.BLUEWING_ELECTRON_BINARY || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const preload = path.join(root, 'dist', 'preload', 'index.js');
if (!fs.existsSync(binary) || !fs.existsSync(preload)) throw new Error('Run npm ci and npm run build first.');
fs.writeFileSync(path.join(out, 'renderer.tsx'), `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VpnAccess, VpnAccessStatus} from '../../../src/renderer/pages/VpnAccess';
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <><button id="fixture-page" onClick={() => setVisible(v => !v)}>切换页面</button>
    <VpnAccessStatus onOpen={() => setVisible(true)}/>
    {visible && <VpnAccess settings={{mixedPort:2080,inboundAuth:false,tunEnabled:false}} coreState="running"/>}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
`);
require('esbuild').buildSync({
  entryPoints: [path.join(out, 'renderer.tsx')], bundle: true,
  outfile: path.join(out, 'renderer.js'), platform: 'browser', format: 'iife',
  loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
fs.writeFileSync(path.join(out, 'main.cjs'), String.raw`
const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path'), assert = require('node:assert/strict');
app.setPath('userData', path.join(__dirname, 'user-data'));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = {id:'fixture',name:'状态同步回归',protocol:'softether',gateway:{host:'vpn.example.com',port:5555},username:'fixture',authMethod:'auth/psw',loginDomain:'VPN',rememberPassword:true,rememberSession:false,tls:{},targets:[],hosts:{},bindInterface:'',socksPort:21080,dnsPort:21081};
let state = {state:'idle',profileId:profile.id,generation:0,coreAvailable:true,requiresCoreRebuild:false};
let warnings = [];
let window, connectCalls = 0, disconnectCalls = 0, holdCount = 0;
const held = [];
const snapshot = () => ({profiles:[profile],state,states:{[profile.id]:state},defaultProfileId:state.state==='connected'?profile.id:undefined,encryptionAvailable:true,passwordSaved:{[profile.id]:true},warnings});
function change(next) {
  state = {...state, ...next};
  window.webContents.send('vpn:state', state);
}
ipcMain.handle('vpn:snapshot', () => {
  const result = structuredClone(snapshot());
  if (holdCount > 0) { holdCount--; return new Promise(resolve => held.push(() => resolve(result))); }
  return result;
});
ipcMain.handle('evpn:getProfiles', () => []);
ipcMain.handle('evpn:getState', () => null);
ipcMain.handle('vpn:savePassword', () => {});
ipcMain.handle('vpn:connect', () => {
  connectCalls++;
  assert.equal(state.state, 'idle', 'The view offered a duplicate connection');
  change({state:'authenticating', generation:state.generation + 1});
});
ipcMain.handle('vpn:disconnect', async () => {
  disconnectCalls++;
  change({state:'stopping'}); await sleep(180); change({state:'idle'});
});
app.whenReady().then(async () => {
  window = new BrowserWindow({show:false, width:1280, height:900, webPreferences:{preload:__PRELOAD__, contextIsolation:true, sandbox:false, offscreen:true, backgroundThrottling:false}});
  const errors = [];
  window.webContents.on('console-message', event => { if(event.level==='error') errors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source);
  async function wait(source) {
    for(let i=0;i<100;i++) { if(await js(source)) return; await sleep(40); }
    throw new Error('UI state did not update: ' + source + '; ' + errors.join(' | '));
  }
  const hasButton = label => 'Array.from(document.querySelectorAll(".vpn-access button")).some(b => b.textContent.trim()===' + JSON.stringify(label) + ')';
  const clickButton = label => js('Array.from(document.querySelectorAll(".vpn-access button")).find(b => b.textContent.trim()===' + JSON.stringify(label) + ').click()');
  const connected = 'document.querySelector(".vpn-access")?.innerText.includes("VPN 隧道已连接") && document.querySelector(".vpn-multi-summary strong")?.textContent==="1"';
  await window.loadFile(path.join(__dirname, 'index.html'));
  await wait(hasButton('连接 VPN'));
  warnings = ['上次保存的部分 VPN 网络信息无法读取，公网连接可继续使用。']; change({});
  await wait('document.querySelector(".vpn-notice.warning")?.innerText.includes("公网连接可继续使用")');
  assert.equal(await js(hasButton('连接 VPN')), true, 'A cache notice blocked VPN login');
  warnings = []; change({});
  await clickButton('连接 VPN');
  await wait('document.querySelector(".vpn-access")?.innerText.includes("正在认证")');
  assert.equal(await js(hasButton('连接 VPN')), false);
  change({state:'connected'});
  await wait(connected); await wait(hasButton('断开连接'));
  assert.equal(connectCalls, 1);

  // Both view and global status must ignore the separate protocol-engine bus.
  await js('window.corpEvents=0; window.engineEvents=0; window.electronAPI.corporateVpn.onState(()=>window.corpEvents++); window.electronAPI.vpn.onStateChange(()=>window.engineEvents++); void 0;');
  window.webContents.send('evpn:state', null); await sleep(100);
  assert.equal(await js('window.corpEvents'), 0);
  assert.equal(await js('window.engineEvents'), 1);
  assert.equal(await js(connected), true);

  await js('document.querySelector("#fixture-page").click()');
  await wait('!document.querySelector(".vpn-access")');
  change({state:'reconnect_wait'});
  await wait('document.querySelector(".vpn-global-status")?.innerText.includes("等待重试")');
  change({state:'connected'});
  await wait('document.querySelector(".vpn-global-status")?.innerText.includes("已连接 1 个")');
  await js('document.querySelector("#fixture-page").click()');
  await wait(connected);
  assert.equal(connectCalls, 1, 'Switching pages started a new connection');
  assert.equal(disconnectCalls, 0, 'Switching pages disconnected the VPN');

  // Late snapshots from an earlier transition cannot replace newer state.
  holdCount = 2; change({state:'idle'});
  for(let i=0;i<100 && held.length<2;i++) await sleep(20);
  assert.equal(held.length, 2);
  change({state:'connected'}); await wait(connected);
  for(const release of held.splice(0)) release(); await sleep(120);
  assert.equal(await js(connected), true, 'An older snapshot restored disconnected UI');

  await clickButton('断开连接');
  await wait('document.querySelector(".vpn-access")?.innerText.includes("正在断开")');
  await wait(hasButton('连接 VPN'));
  await wait('document.querySelector(".vpn-multi-summary strong")?.textContent==="0"');
  assert.equal(disconnectCalls, 1);
  change({state:'failed',error:'PUBLIC_CORE_CHANGED',trafficProtected:true});
  await wait('document.querySelector(".vpn-access")?.innerText.includes("已知公司资源仍保持保护")');
  assert.equal(await js(hasButton('连接 VPN')), true);
  assert.deepEqual(errors, []);
  console.log('PASS: real preload + React: connection status, counts, disconnect, page switching, event isolation, stale snapshots, cache notices, interrupted core');
}).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
`.replace('__PRELOAD__', JSON.stringify(preload)));
const child = spawn(binary, [path.join(out, 'main.cjs')], { cwd: root, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
