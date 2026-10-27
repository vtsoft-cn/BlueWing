// Actual Electron renderer with isolated fake IPC; never starts the product main process.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'work', 'corporate-vpn-tools', 'ui-smoke');
fs.mkdirSync(out, { recursive: true });
const binary =
  process.env.BLUEWING_ELECTRON_BINARY ||
  path.join(
    root,
    'work',
    'corporate-vpn-tools',
    'electron-runtime',
    'dist',
    'electron.exe',
  );
if (!fs.existsSync(binary))
  throw new Error(
    'Set BLUEWING_ELECTRON_BINARY to a verified Electron executable.',
  );
const profile = {
  id: 'fixture',
  name: '办公网络',
  protocol: 'easyconnect',
  gateway: { host: 'vpn.example.com', port: 10443 },
  username: 'example',
  authMethod: 'auth/psw',
  loginDomain: '',
  rememberPassword: false,
  rememberSession: false,
  tls: {},
  targets: [
    {
      domains: ['dev.corp.example'],
      cidrs: ['10.20.30.40/32'],
      ports: ['22', '80'],
      network: 'tcp',
    },
  ],
  hosts: {},
  bindInterface: '',
  socksPort: 21080,
  dnsPort: 21081,
};
fs.writeFileSync(
  path.join(out, 'fixture.json'),
  JSON.stringify([
    profile,
    {
      ...profile,
      id: 'fixture-atrust',
      name: '研发环境',
      protocol: 'atrust',
      gateway: { host: 'access.example.com', port: 10443 },
      socksPort: 21082,
      dnsPort: 21083,
    },
  ]),
);
const css = fs
  .readdirSync(path.join(root, 'dist', 'renderer', 'assets'))
  .find((file) => file.endsWith('.css'));
if (!css) throw new Error('Run npm run build first.');
fs.copyFileSync(
  path.join(root, 'dist', 'renderer', 'assets', css),
  path.join(out, 'style.css'),
);
fs.writeFileSync(
  path.join(out, 'preview.tsx'),
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {VpnAccess,VpnAccessStatus} from '../../../src/renderer/pages/VpnAccess';
import {Dashboard} from '../../../src/renderer/pages/Dashboard';
import {Nodes} from '../../../src/renderer/pages/Nodes';
import {Sidebar} from '../../../src/renderer/components/Sidebar';
import {ToastHost} from '../../../src/renderer/components/Toast';
import {ConfirmDialogHost} from '../../../src/renderer/components/ConfirmDialog';
const root=createRoot(document.getElementById('root'));
let proxySettings={mixedPort:2080,inboundAuth:false,tunEnabled:false,routingMode:'rule'},proxyState='running',currentPage='vpn-access',dashboardNodes=[];
const selectNode=()=>{proxySettings={...proxySettings,routingMode:'rule'};render();};
const selectDirect=()=>{proxySettings={...proxySettings,routingMode:'direct'};render();};
const render=()=>root.render(<div className="h-screen flex overflow-hidden bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
  <Sidebar currentTab={currentPage} onSelectTab={page=>{currentPage=page;render();}} theme="dark"/>
  <div className="flex-1 flex flex-col overflow-hidden min-w-0 no-drag">
    <div className="h-9 shrink-0"/>
    <VpnAccessStatus showSummary={false} onOpen={()=>{}}/>
    <main className={'flex-1 min-h-0 p-6 '+(currentPage==='vpn-access'?'overflow-hidden':'overflow-y-auto')}>
      <div className={'max-w-5xl mx-auto '+(currentPage==='vpn-access'?'h-full min-h-0':'')}>
        {currentPage==='dashboard'?<Dashboard nodes={dashboardNodes} activeNodeId="saved" coreState={proxyState} settings={proxySettings} onToggleConnect={()=>{proxyState=proxyState==='running'?'stopped':'running';render();}} onSelectNode={selectNode} onSelectDirect={selectDirect} traffic={{downloadSpeed:0,uploadSpeed:0,totalDownload:0,totalUpload:0,latency:0,uptime:0,activeConnections:0}} onUpdateSettings={value=>{proxySettings={...proxySettings,...value};render();}} onNavigate={page=>{currentPage=page;render();}} onRequestTunElevation={()=>{}}/>:currentPage==='nodes'?<Nodes nodes={dashboardNodes} activeNodeId="saved" onSelectNode={selectNode} onSelectDirect={selectDirect} directSelected={proxySettings.routingMode==='direct'||!dashboardNodes.length} subscriptions={[]}/>:<VpnAccess settings={proxySettings} coreState={proxyState} publicProxy={{enabled:proxySettings.routingMode!=='direct' && dashboardNodes.length>0,name:dashboardNodes[0]?.name}}/>}
      </div>
    </main>
  </div><ToastHost/><ConfirmDialogHost/>
</div>);
window.addEventListener('fixture:proxy',event=>{proxySettings={...proxySettings,...event.detail.settings};proxyState=event.detail.coreState||proxyState;currentPage=event.detail.page||currentPage;dashboardNodes=event.detail.nodes||dashboardNodes;render();});
render();
`,
);
require('esbuild').buildSync({
  entryPoints: [path.join(out, 'preview.tsx')],
  bundle: true,
  outfile: path.join(out, 'preview.js'),
  platform: 'browser',
  format: 'iife',
  loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(
  path.join(out, 'index.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>VPN 接入 UI 验证</title><link rel="stylesheet" href="style.css"></head><body><div id="root"></div><script src="preview.js"></script></body></html>',
);
fs.writeFileSync(
  path.join(out, 'preload.cjs'),
  `
const {contextBridge,ipcRenderer}=require('electron');
let profiles=require('./fixture.json');let passwords={},discoveredTargets={},states,disconnectCalls=[];
let state={state:'idle',generation:0,requiresCoreRebuild:false,coreAvailable:true},serial=0;
const listeners=new Set();
function emit(next){state={...state,...next};if(states){if(next.profileId)states[next.profileId]={...states[next.profileId],...next};state=Object.values(states).find(s=>s.state==='waiting_user')||Object.values(states).find(s=>s.state==='connected')||Object.values(states)[0];}for(const fn of listeners)fn(state);}
ipcRenderer.on('fixture:state',(_,next)=>emit(next));
ipcRenderer.on('fixture:profiles',(_,next)=>{profiles=next;emit({state:'idle',profileId:undefined,resources:undefined,challenge:undefined});});
ipcRenderer.on('fixture:discovered',(_,next)=>{discoveredTargets=next;emit({});});
ipcRenderer.on('fixture:multi',()=>{states=Object.fromEntries(profiles.map(p=>[p.id,{state:'idle',profileId:p.id,generation:0,coreAvailable:true,requiresCoreRebuild:false}]));disconnectCalls=[];emit({});});
contextBridge.exposeInMainWorld('electronAPI',{corporateVpn:{
snapshot:async()=>({profiles,state,states,defaultProfileId:states?[...profiles].sort((a,b)=>(a.routingPriority||100)-(b.routingPriority||100)).find(p=>states[p.id]?.state==='connected')?.id:undefined,fixtureDisconnectCalls:disconnectCalls,discoveredTargets,encryptionAvailable:true,passwordSaved:Object.fromEntries(profiles.map(p=>[p.id,!!passwords[p.id]]))}),
save:async(value)=>{const saved={...value,id:value.id||'new-fixture-'+(++serial)};const i=profiles.findIndex(p=>p.id===saved.id);if(i<0)profiles.push(saved);else profiles[i]=saved;emit({});return{profile:saved,requiresCoreRebuild:false};},
remove:async(id)=>{profiles=profiles.filter(p=>p.id!==id);emit({});},
connect:async(id,password)=>{if(!password&&!passwords[id])throw new Error('fixture password required');if(states){const generation=states[id].generation+1;emit({state:'waiting_user',profileId:id,generation,trafficProtected:true,challenge:{id:'otp-'+id,profileId:id,generation,kind:'otp',title:'请输入动态码',expiresAt:Date.now()+120000}});return;}if(state.requiresCoreRebuild){const generation=state.generation+1;emit({state:'starting',preparingRouting:true,profileId:id,generation});await new Promise(r=>setTimeout(r,1800));if(state.generation!==generation||state.state!=='starting')return;emit({requiresCoreRebuild:false,preparingRouting:false});}emit({state:'waiting_user',profileId:id,generation:state.generation+1,challenge:{id:'otp-fixture',profileId:id,generation:state.generation+1,kind:'otp',title:'请输入动态码',expiresAt:Date.now()+120000}});},
disconnect:async(id)=>{disconnectCalls.push(id||'all');if(states){for(const key of Object.keys(states))if(!id||key===id)states[key]={...states[key],state:'idle',generation:states[key].generation+1,challenge:undefined,trafficProtected:false};emit({});}else emit({state:'idle',generation:state.generation+1,challenge:undefined,preparingRouting:false,trafficProtected:false,error:undefined,errorDetail:undefined});},
discover:async(id)=>{const methods=[{authName:'企业认证',authType:'auth/psw',loginDomain:'custom0001',supported:true},{authName:'本地密码认证',authType:'auth/psw',loginDomain:'local',supported:true}];profiles=profiles.map(p=>p.id===id?{...p,authChoices:methods}:p);emit({});return methods;},
certificate:async()=>({fingerprint:'a'.repeat(64),subject:'Fixture Certificate',issuer:'Fixture CA',validTo:'2027-01-01',chainTrusted:!state.error,trustIssues:state.error?['UNTRUSTED_AUTHORITY','NAME_MISMATCH']:[]}),
respond:async(id,generation,value,profileId)=>{if(id.startsWith('otp-')&&value!=='123456')throw new Error('fixture OTP mismatch');if(id==='points-fixture'){const p=JSON.parse(value);if(p.width!==1||p.height!==1||!Array.isArray(p.coordinates)||p.coordinates.length!==1)throw new Error('fixture captcha mismatch');}emit({state:'connected',...(states?{profileId}:{}),challenge:undefined,resources:{targets:[{domains:['docs.corp.example'],cidrs:[],ports:['443'],network:'tcp'}],hosts:{},dnsServers:['10.20.0.53']}});},
savePassword:async(id,password,remember)=>{profiles=profiles.map(p=>p.id===id?{...p,rememberPassword:remember}:p);if(remember&&password)passwords[id]=password;if(!remember)delete passwords[id];emit({});},
clearCredentials:async(id)=>{delete passwords[id];emit({});},openDiagnostics:async()=>{},clearDiagnostics:async()=>{},clearDiscoveredTargets:async(id)=>{delete discoveredTargets[id];emit({});},apply:async()=>true,onState:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}
}});
`,
);
fs.writeFileSync(
  path.join(out, 'main.cjs'),
  `
const {app,BrowserWindow,safeStorage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
app.setPath('userData',path.join(__dirname,'user-data'));app.disableHardwareAcceleration();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 const {CredentialVault}=require(${JSON.stringify(path.join(root, 'dist', 'main', 'vpn', 'CredentialVault.js'))});
 const vaultDir=path.join(__dirname,'system-encryption-fixture');fs.mkdirSync(vaultDir,{recursive:true});
 const vault=new CredentialVault(vaultDir,safeStorage);assert.equal(vault.available(),true);
 vault.set('fixture:password','fixture-dpapi-value');
 assert.equal(new CredentialVault(vaultDir,safeStorage).get('fixture:password'),'fixture-dpapi-value');
 assert.equal(fs.readFileSync(path.join(vaultDir,'vpn-vault.json'),'utf8').includes('fixture-dpapi-value'),false);vault.remove('fixture:');
 const w=new BrowserWindow({width:1200,height:780,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false,offscreen:true,backgroundThrottling:false}});
 const errors=[];w.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
 const js=async source=>{try{return await w.webContents.executeJavaScript(source);}catch(error){throw new Error('UI script failed: '+source+'; '+error.message+'; renderer: '+errors.join(' | '));}};
 async function wait(condition){for(let i=0;i<80;i++){if(await js(condition))return;await sleep(50);}throw new Error('UI condition failed: '+condition);}
 async function click(selector){await js('document.querySelector('+JSON.stringify(selector)+').click()');await sleep(80);}
 async function textClick(text){await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(text)+').click()');await sleep(80);}
 async function input(label,value){const selector='input[aria-label='+JSON.stringify(label)+']';await js('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');await sleep(60);}
 async function capture(name){await sleep(250);fs.writeFileSync(path.join(__dirname,name+'.png'),(await w.webContents.capturePage()).toPNG());}
 const noOverflow=()=>js('document.documentElement.scrollWidth<=window.innerWidth && document.body.scrollWidth<=window.innerWidth');
 await w.loadFile(path.join(__dirname,'index.html'));await wait('!!document.querySelector(".vpn-connection-title")');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{page:"dashboard",coreState:"stopped",nodes:[]}}))');await wait('document.body.innerText.includes("启动直连分流")');
 assert.equal(await js('document.body.innerText.includes("无需代理节点")'),true);await textClick('启动直连分流');await wait('document.body.innerText.includes("直连分流已启动")');await capture('vpn-access-no-node-dashboard');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{settings:{routingMode:"direct"},nodes:[{id:"saved",name:"Saved fixture",type:"socks",server:"127.0.0.1",port:12345}]}}))');await wait('document.body.innerText.includes("本机直连，无需代理节点")');
 assert.equal(await noOverflow(),true);
 await click('[aria-label="选择网络出口"]');await textClick('Saved fixtureSOCKS · 127.0.0.1:12345');await wait('!document.body.innerText.includes("本机直连，无需代理节点")');
 await click('[aria-label="选择网络出口"]');await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}))');assert.equal(await js('document.activeElement.textContent.includes("Saved fixture")'),true);await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait('!document.querySelector("[role=dialog][aria-label=选择网络出口]")');assert.equal(await js('document.activeElement.getAttribute("aria-label")'), '选择网络出口');
 await click('[aria-label="选择网络出口"]');await textClick('本机直连（无需节点）普通公网直连，公司资源继续走 VPN 接入');await wait('document.body.innerText.includes("本机直连，无需代理节点")');await capture('vpn-access-direct-choice');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{page:"nodes",settings:{routingMode:"rule"}}}))');
 await textClick('本机直连（无需节点）普通公网使用本机网络，公司资源按 VPN 接入配置分流选择直连');assert.equal(await js('document.querySelector("button[aria-pressed=true]").textContent.includes("本机直连")'),true);await capture('vpn-access-nodes-direct-choice');
 await js('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.fixtureCopied=value;}}});window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{nodes:[{id:"saved",name:"Vision fixture",type:"vless",server:"proxy.example.com",port:443,uuid:"b831381d-6324-4d53-ad4f-8cda48b30811",tls:true,reality:true,flow:"xtls-rprx-vision",publicKey:"fixture-public-key",shortId:"abcd",sni:"tls.example.com",transport:"tcp"}]}}))');
 await click('[title="复制节点分享链接"]');assert.equal(await js('new URL(window.fixtureCopied).searchParams.get("flow")'),'xtls-rprx-vision');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{page:"vpn-access",settings:{routingMode:"rule"}}}))');await wait('!!document.querySelector(".vpn-connection-title")');
 assert.equal(await noOverflow(),true);assert.equal(await js('document.querySelector(".vpn-connect-actions .primary").getBoundingClientRect().bottom < window.innerHeight'),true);
 await capture('vpn-access-light');await js('document.documentElement.classList.add("dark")');await capture('vpn-access-dark');
 w.setSize(980,680);await sleep(150);assert.equal(await noOverflow(),true);await capture('vpn-access-compact');w.setSize(1200,780);await sleep(150);
 await js('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.fixtureCopied=value;}}});document.querySelector(".vpn-proxy-card").scrollIntoView({block:"center"});');
 assert.equal(await js('document.querySelector(".vpn-proxy-fields").textContent.includes("2080")'),true);
 await click('[aria-label="复制代理地址"]');assert.equal(await js('window.fixtureCopied'),'127.0.0.1');
 await click('[aria-label="复制代理端口"]');assert.equal(await js('window.fixtureCopied'),'2080');await capture('vpn-access-application-proxy');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{settings:{mixedPort:29999,inboundAuth:true,tunEnabled:true},coreState:"stopped"}}))');
 await wait('document.querySelector(".vpn-proxy-fields").textContent.includes("29999")');
 await click('[aria-label="复制代理端口"]');assert.equal(await js('window.fixtureCopied'),'29999');
 assert.equal(await js('document.querySelector(".vpn-proxy-card").textContent.includes("代理未运行") && document.querySelector(".vpn-proxy-card").textContent.includes("已启用代理认证")'),true);
 await js('navigator.clipboard.writeText=async()=>{throw new Error("fixture copy denied")};void 0;');await click('[aria-label="复制代理端口"]');await wait('document.body.innerText.includes("复制失败，请手动复制代理端口")');
 await js('window.dispatchEvent(new CustomEvent("fixture:proxy",{detail:{settings:{mixedPort:2080,inboundAuth:false,tunEnabled:false},coreState:"running"}}));document.querySelector(".vpn-detail-column").scrollTop=0;');
 await input('搜索接入配置','aTrust');assert.equal(await js('document.querySelectorAll(".vpn-profile-item").length'),1);await input('搜索接入配置','');
 await click('[aria-label="编辑接入配置"]');await wait('!!document.querySelector("[data-vpn-editor]")');await input('配置名称','办公网络 - 已编辑');
 await input('配置登录密码','fixture-editor-password');assert.equal(await js('document.querySelector(".vpn-storage-settings input[type=checkbox]").checked'),true);await capture('vpn-access-editor-password');
 await click('#vpn-tab-routing');assert.equal(await js('document.querySelector("#vpn-panel-routing").hidden'),false);await capture('vpn-access-routing');
 assert.equal(await js('document.querySelector("input[aria-label=自动识别私网目标]").checked'),true);await click('[aria-label="自动识别私网目标"]');
 await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');
 assert.deepEqual(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles[0].targets[0].ports)'),['22','80']);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.passwordSaved.fixture)'),true);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>JSON.stringify(s.profiles).includes("fixture-editor-password"))'),false);
 await textClick('高级分流');await wait('document.querySelector("#vpn-tab-routing").getAttribute("aria-selected")==="true"');
 assert.equal(await js('document.querySelector("input[aria-label=自动识别私网目标]").checked'),false);await click('[aria-label="自动识别私网目标"]');await capture('vpn-access-auto-discovery-settings');
 assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'分流优先级');
 for(const [label,value] of [['自定义域名','https://custom.corp.example/business/login'],['自定义 IP / 网段','10.80.30.40'],['固定域名解析','custom.corp.example 10.80.30.40']]){
   await js('(()=>{const el=document.querySelector('+JSON.stringify('textarea[aria-label="'+label+'"]')+');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');await sleep(60);
 }
 assert.equal(await js('document.querySelector("#vpn-panel-routing").textContent.includes("用户自定义 → 服务器资源")'),true);await capture('vpn-access-company-routing');
 await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');await textClick('高级分流');
 await wait('!!document.querySelector("textarea[aria-label=自定义域名]")');assert.equal(await js('document.querySelector("textarea[aria-label=自定义域名]").value'),'custom.corp.example');
 assert.equal(await js('document.querySelector("textarea[aria-label=固定域名解析]").value'),'custom.corp.example 10.80.30.40');await textClick('取消');
 await js('Array.from(document.querySelectorAll(".vpn-profile-item")).find(b=>b.textContent.includes("研发环境")).click()');await sleep(80);await textClick('高级分流');
 await wait('!!document.querySelector("textarea[aria-label=自定义域名]")');assert.equal(await js('document.querySelector("textarea[aria-label=自定义域名]").value.includes("custom.corp.example")'),false);
 assert.equal(await js('document.querySelector("textarea[aria-label=固定域名解析]").value'),'');await textClick('取消');
 await js('Array.from(document.querySelectorAll(".vpn-profile-item")).find(b=>b.textContent.includes("办公网络")).click()');await sleep(80);
 await textClick('新增接入');await wait('!!document.querySelector("[data-vpn-editor]")');
 await js('Array.from(document.querySelectorAll(".vpn-provider-option")).find(b=>b.textContent.includes("aTrust")).click()');
 await input('配置名称','测试接入');await input('网关地址','new.example.com');await input('登录账号','fixture-user');await capture('vpn-access-editor');
 await js('document.querySelector(".vpn-editor-footer button[type=submit]").focus();document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
 assert.equal(await js('document.activeElement.getAttribute("aria-label")'),'关闭接入设置');
 await textClick('保存并获取认证方式');await wait('!!document.querySelector("select[aria-label=网关认证方式]")');
 await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');assert.equal(await js('document.querySelector(".vpn-connection-title").textContent.includes("测试接入")'),true);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles.length)'),3);
 await click('[aria-label="编辑接入配置"]');await textClick('获取认证方式');await wait('!!document.querySelector("select[aria-label=网关认证方式]")');
 await click('#vpn-tab-advanced');await textClick('读取证书');await wait('document.body.innerText.includes("系统信任链校验通过")');
 await click('#vpn-tab-connection');await input('配置名称','未保存的修改');await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
 await wait('document.body.innerText.includes("有未保存的修改")');await textClick('放弃修改');await wait('!document.querySelector("[data-vpn-editor]")');
 assert.equal(await js('document.querySelector(".vpn-connection-title").textContent.includes("测试接入")'),true);
 await click('[aria-label="编辑接入配置"]');await textClick('删除接入');await textClick('确认删除');await wait('!document.querySelector("[data-vpn-editor]")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles.length)'),2);
 w.webContents.send('fixture:profiles',[]);await wait('document.body.innerText.includes("添加你的第一个 VPN 接入")');await capture('vpn-access-empty');
 await textClick('添加接入');await wait('!!document.querySelector("[data-vpn-editor]")');
 await js('Array.from(document.querySelectorAll(".vpn-provider-option")).find(b=>b.textContent.includes("SoftEther")).click()');
 assert.equal(await js('document.querySelector("input[aria-label=网关端口]").value'),'5555');
 assert.equal(await js('Array.from(document.querySelectorAll("input")).find(el=>el.getAttribute("aria-label")==="Virtual HUB").value'),'VPN');
 await input('配置名称','SoftEther fixture');await input('网关地址','vpn.example.com');await input('登录账号','fixture-user');
 await click('#vpn-tab-routing');
 assert.equal(await js('document.querySelector("#vpn-panel-routing").innerText.includes("公司 VPN 无需具备公网访问权限")'),true);await capture('vpn-access-softether-routing');
 assert.equal(await js('document.querySelectorAll(".vpn-mode-option").length'),3);
 assert.equal(await js('document.querySelector(".vpn-mode-option[aria-pressed=true]").textContent.includes("智能分流")'),true);
 await js('Array.from(document.querySelectorAll(".vpn-mode-option")).find(el=>el.textContent.includes("全部走 VPN")).click()');
 assert.equal(await js('document.querySelector("#vpn-panel-routing").textContent.includes("国外网站优先走代理")'),true);await capture('vpn-access-mode-vpn');
 await js('Array.from(document.querySelectorAll(".vpn-mode-option")).find(el=>el.textContent.includes("自定义")).click()');
 await js('(()=>{const el=Array.from(document.querySelectorAll("select")).find(el=>el.getAttribute("aria-label")==="国内公网出口");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,"vpn");el.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await capture('vpn-access-mode-custom');
 await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles[0].protocol)'), 'softether');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>"routeChina" in s.profiles[0])'), false);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles[0].trafficMode)'), 'custom');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles[0].customRouting.domestic)'), 'vpn');
 await click('[aria-label="编辑接入配置"]');await click('#vpn-tab-routing');
 assert.equal(await js('document.querySelector(".vpn-mode-option[aria-pressed=true]").textContent.includes("自定义")'),true);await textClick('取消');
 w.webContents.send('fixture:profiles',require('./fixture.json'));await wait('!!document.querySelector(".vpn-connection-title")');
 await input('登录密码','fixture-only-secret');await click('input[aria-label="加密记住密码"]');
 await wait('window.electronAPI.corporateVpn.snapshot().then(s=>s.passwordSaved.fixture===true)');assert.equal(await js('document.querySelector("input[aria-label=登录密码]").value'),'');
 await input('登录密码','fixture-replacement');await textClick('保存密码');await wait('document.querySelector("input[aria-label=登录密码]").value===""');
 w.webContents.send('fixture:state',{state:'failed',profileId:'fixture',error:'TLS_UNTRUSTED'});await wait('document.body.innerText.includes("检查网关证书")');await textClick('检查网关证书');
 await wait('document.body.innerText.includes("可能使用了自签名证书")');assert.equal(await js('document.querySelector("#vpn-tab-advanced").getAttribute("aria-selected")'),'true');await capture('vpn-access-certificate');
 await click('[aria-label="关闭接入设置"]');await wait('!document.querySelector("[data-vpn-editor]")');
 await textClick('连接 VPN');await wait('!!document.querySelector("input[aria-label=验证码]")');await capture('vpn-access-otp');
 await input('验证码','123456');const firstChallenge=await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.challenge)');
 await textClick('稍后填写');await wait('document.querySelector(".vpn-auth-dialog").getClientRects().length===0');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.state)'),'waiting_user');
 await click('.vpn-global-status');await wait('document.querySelector(".vpn-auth-dialog").getClientRects().length>0');
 assert.equal(await js('document.querySelector("input[aria-label=验证码]").value'),'123456');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.challenge.expiresAt)'),firstChallenge.expiresAt);
 await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await wait('document.querySelector(".vpn-auth-dialog").getClientRects().length===0');await click('.vpn-global-status');
 w.webContents.send('fixture:state',{challenge:{...firstChallenge,expiresAt:Date.now()-1}});await wait('document.body.innerText.includes("本轮验证已超时")');
 await js('document.querySelector(".vpn-auth-dialog form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await sleep(60);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.state)'),'waiting_user');
 await js('Array.from(document.querySelectorAll(".vpn-auth-dialog button")).find(b=>b.textContent.trim()==="取消连接").click()');await wait('!document.querySelector(".vpn-auth-dialog")');
 w.webContents.send('fixture:state',{state:'idle',profileId:'fixture-other',requiresCoreRebuild:true});await wait('document.body.innerText.includes("连接时自动准备分流")');
 assert.equal(await js('document.querySelector(".vpn-connect-actions button[type=submit]").disabled'),false);
 assert.equal(await js('Array.from(document.querySelector(".vpn-access").querySelectorAll("button")).some(b=>b.textContent.trim()==="应用分流")'),false);
 await input('登录密码','fixture-auto-routing');await textClick('连接 VPN');await wait('document.querySelector(".vpn-session-status").textContent.includes("正在准备分流")');
 assert.equal(await js('Array.from(document.querySelectorAll(".vpn-connect-actions button")).find(b=>b.textContent.includes("取消连接")).disabled'),false);await capture('vpn-access-auto-routing');
 await textClick('取消连接');await sleep(1900);assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.state)'), 'idle');assert.equal(await js('document.querySelector(".vpn-auth-dialog")'),null);
 await input('登录密码','fixture-auto-routing');await textClick('连接 VPN');await wait('!!document.querySelector(".vpn-auth-dialog")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.requiresCoreRebuild)'),false);
 await js('Array.from(document.querySelectorAll(".vpn-auth-dialog button")).find(b=>b.textContent.trim()==="取消连接").click()');await wait('!document.querySelector(".vpn-auth-dialog")');
 await textClick('连接 VPN');await wait('!!document.querySelector("input[aria-label=验证码]")');
 assert.equal(await js('document.querySelector("input[aria-label=验证码]").value'),'');
 assert.equal(await js('Number(document.querySelector("[role=timer]").textContent.match(/[0-9]+/)[0])>=118'),true);
 await input('验证码','old-round-value');const freshChallenge=await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.challenge)');
 w.webContents.send('fixture:state',{generation:freshChallenge.generation+1,challenge:{...freshChallenge,generation:freshChallenge.generation+1,expiresAt:Date.now()+120000}});
 await wait('document.querySelector("input[aria-label=验证码]").value===""');
 await input('验证码','123456');await textClick('提交验证码');await wait('document.body.innerText.includes("VPN 隧道已连接")');
 await capture('vpn-access-connected');assert.equal(await js('document.querySelector("[aria-label=查看接入配置]").disabled'),false);
 await click('[aria-label="查看接入配置"]');await wait('document.querySelector("#vpn-editor-title").textContent==="查看接入"');
 assert.equal(await js('document.querySelector("input[aria-label=配置名称]").matches(":disabled")'),true);
 assert.equal(await js('document.querySelector("textarea[aria-label=自定义域名]").matches(":disabled")'),true);
 assert.equal(await js('document.querySelector(".vpn-editor-footer button[type=submit]")'),null);
 assert.equal(await js('document.querySelector("input[aria-label=配置登录密码]").value'),'');
 await click('#vpn-tab-advanced');assert.equal(await js('document.querySelector("#vpn-panel-advanced").hidden'),false);await capture('vpn-access-readonly');
 await textClick('关闭');await textClick('高级分流');await wait('document.querySelector("#vpn-tab-routing").getAttribute("aria-selected")==="true"');
 const readOnlyProfiles=await js('window.electronAPI.corporateVpn.snapshot().then(s=>JSON.stringify(s.profiles))');
 await js('document.querySelector(".vpn-editor-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await sleep(50);
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>JSON.stringify(s.profiles))'),readOnlyProfiles);await textClick('关闭');
 w.webContents.send('fixture:state',{state:'waiting_user',generation:2,challenge:{id:'points-fixture',profileId:'fixture',generation:2,kind:'structured',title:'请按顺序点击验证码中的文字',imageBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',mime:'image/png',expiresAt:Date.now()+120000}});
 await wait('!!document.querySelector("img[alt=服务器验证码]") && document.querySelector("img[alt=服务器验证码]").naturalWidth===1');
 await js('(()=>{const img=document.querySelector("img[alt=服务器验证码]"),r=img.getBoundingClientRect();img.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:r.left+0.1,clientY:r.top+0.1}));})()');
 await sleep(80);await textClick('提交验证码');await wait('document.body.innerText.includes("VPN 隧道已连接")');
 await textClick('断开连接');await wait('!!document.querySelector("input[aria-label=登录密码]")');assert.equal(await js('document.querySelector("input[aria-label=登录密码]").value'),'');
 await wait('document.querySelector(".vpn-routing-overview").textContent.includes("此接入未接管流量")');
 w.webContents.send('fixture:state',{state:'failed',trafficProtected:true,error:'VPN_TRANSPORT_DOWN'});
 await wait('document.querySelector(".vpn-routing-overview").textContent.includes("已知目标受保护")');
 await textClick('恢复普通分流');await wait('document.querySelector(".vpn-routing-overview").textContent.includes("此接入未接管流量")');
 const baseFixture=require('./fixture.json')[0];
 w.webContents.send('fixture:profiles', [{...baseFixture,id:'fixture-atrust',name:'aTrust 办公',protocol:'atrust',loginDomain:'local',authName:'本地密码认证'},{...baseFixture,id:'fixture-other',name:'另一个接入'}]);
 await wait('document.querySelector(".vpn-connection-title")?.textContent.includes("aTrust 办公")');
 await textClick('获取登录方式');await wait('document.querySelectorAll(".vpn-auth-choice").length===2');
 assert.equal(await js('document.querySelector(".vpn-auth-choice[aria-pressed=true]").textContent.includes("本地密码认证")'),true);
 await js('document.querySelectorAll(".vpn-auth-choice")[0].click()');await wait('document.querySelector(".vpn-auth-choice[aria-pressed=true]").textContent.includes("企业认证")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.profiles.find(p=>p.id==="fixture-atrust").loginDomain)'), 'custom0001');
 await click('[aria-label="编辑接入配置"]');await click('#vpn-tab-advanced');
 await js('(()=>{const el=document.querySelector("select[aria-label=本机诊断日志]");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(el,"full");el.dispatchEvent(new Event("change",{bubbles:true}));})()');
 await wait('document.querySelector("#vpn-panel-advanced").textContent.includes("明文密码、验证码")');await js('document.querySelector("select[aria-label=本机诊断日志]").scrollIntoView({block:"center"});');await capture('vpn-access-diagnostics-settings');
 await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');await wait('document.querySelector(".vpn-diagnostics-bar").textContent.includes("含明文凭据")');
 w.webContents.send('fixture:state',{state:'failed',profileId:'fixture-atrust',generation:20,error:'ATRUST_TRUSTED_ENDPOINT_REQUIRED',errorDetail:{stage:'authCheck',serverCode:'75500503',message:'authCheck failed with code 75500503: Client is not installed or web-only mode.'}});
 await wait('!!document.querySelector(".vpn-error-detail[open]")');assert.equal(await noOverflow(),true);
 await js('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.fixtureCopied=value;}}});void 0;');await textClick('复制错误详情');assert.equal(await js('JSON.parse(window.fixtureCopied).serverCode'),'75500503');
 await js('document.querySelector(".vpn-detail-column").scrollTop=0;');await capture('vpn-access-atrust-login-diagnostic');
 w.webContents.send('fixture:state',{state:'connected',profileId:'fixture-atrust',generation:21,error:undefined,errorDetail:undefined});await wait('document.body.innerText.includes("VPN 隧道已连接")');
 await js('Array.from(document.querySelectorAll(".vpn-profile-item")).find(b=>b.textContent.includes("另一个接入")).click()');await wait('document.querySelector(".vpn-connection-title").textContent.includes("另一个接入")');
 await input('登录密码','fixture-switch-password');await textClick('连接 VPN');await wait('!!document.querySelector(".vpn-auth-dialog")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.state.profileId)'), 'fixture-other');
 await js('Array.from(document.querySelectorAll(".vpn-auth-dialog button")).find(b=>b.textContent.trim()==="取消连接").click()');await wait('!document.querySelector(".vpn-auth-dialog")');
 w.webContents.send('fixture:discovered',{'fixture-other':[{domains:[],cidrs:['10.99.0.20/32'],ports:['22'],network:'tcp'}]});
 await wait('!!document.querySelector(".vpn-learned-summary")');assert.equal(await js('document.querySelector(".vpn-resource-card").textContent.includes("自动识别")'),true);
 await js('document.querySelector(".vpn-resource-card").scrollIntoView({block:"end"})');await capture('vpn-access-auto-discovery-learned');
 w.webContents.send('fixture:state',{state:'connected',profileId:'fixture-other',generation:30});await wait('document.body.innerText.includes("VPN 隧道已连接")');
 assert.equal(await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="清空识别记录").disabled'),true);
 w.webContents.send('fixture:state',{state:'idle',generation:31});await wait('!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="清空识别记录").disabled');
 await textClick('清空识别记录');await wait('!document.querySelector(".vpn-learned-summary")');
 const manyProfiles=Array.from({length:30},(_,i)=>({...baseFixture,id:'scroll-fixture-'+i,name:'办公网络 '+String(i+1).padStart(2,'0')}));
 w.webContents.send('fixture:profiles',manyProfiles);
 await wait('document.querySelectorAll(".vpn-profile-item").length===30');
 const paneState=()=>js('(()=>{const list=document.querySelector(".vpn-profile-items"),detail=document.querySelector(".vpn-detail-column"),main=document.querySelector("main");return {left:list.scrollTop,right:detail.scrollTop,leftScrollable:list.scrollHeight>list.clientHeight,rightScrollable:detail.scrollHeight>detail.clientHeight,mainScrollable:main.scrollHeight>main.clientHeight,mainTop:main.scrollTop,bodyTop:document.scrollingElement.scrollTop,headerTop:document.querySelector(".vpn-page-header").getBoundingClientRect().top,searchTop:document.querySelector(".vpn-search").getBoundingClientRect().top};})()');
 const initialScroll=await paneState();
 assert.equal(initialScroll.leftScrollable,true);assert.equal(initialScroll.rightScrollable,true);assert.equal(initialScroll.mainScrollable,false);
 const pageKey=async(selector,keyCode)=>{await js('document.querySelector('+JSON.stringify(selector)+').focus()');w.webContents.sendInputEvent({type:'keyDown',keyCode});w.webContents.sendInputEvent({type:'keyUp',keyCode});await sleep(250);};
 await pageKey('.vpn-profile-items','PageDown');
 const leftScrolled=await paneState();assert.ok(leftScrolled.left>0);assert.equal(leftScrolled.right,0);assert.equal(leftScrolled.searchTop,initialScroll.searchTop);
 await pageKey('.vpn-detail-column','PageDown');
 const bothScrolled=await paneState();assert.ok(bothScrolled.right>0);assert.equal(bothScrolled.left,leftScrolled.left);assert.equal(bothScrolled.headerTop,initialScroll.headerTop);
 await pageKey('.vpn-profile-items','End');await pageKey('.vpn-detail-column','End');
 const atEnd=await paneState();await pageKey('.vpn-detail-column','PageDown');
 const afterEnd=await paneState();assert.equal(afterEnd.right,atEnd.right);assert.equal(afterEnd.left,atEnd.left);assert.equal(afterEnd.mainTop,0);assert.equal(afterEnd.bodyTop,0);assert.equal(afterEnd.headerTop,initialScroll.headerTop);
 await capture('vpn-access-independent-scroll-dark');
 await js('document.querySelector(".vpn-profile-item:last-child").click()');
 await wait('document.querySelector(".vpn-connection-title").textContent.includes("办公网络 30")');
 assert.equal((await paneState()).right,0);assert.equal((await paneState()).left,atEnd.left);
 w.webContents.send('fixture:state',{requiresCoreRebuild:true});await wait('!!document.querySelector(".vpn-apply-banner")');
 assert.equal((await paneState()).mainScrollable,false);
 w.setSize(980,680);await sleep(200);assert.equal(await noOverflow(),true);assert.equal((await paneState()).mainScrollable,false);assert.equal((await paneState()).rightScrollable,true);
 await capture('vpn-access-independent-scroll-compact');
 await js('document.documentElement.classList.remove("dark")');await capture('vpn-access-independent-scroll-light');
 w.setSize(1200,780);await js('document.documentElement.classList.add("dark")');
 w.webContents.send('fixture:profiles',[{...baseFixture,id:'multi-a',name:'公司 A',routingPriority:100},{...baseFixture,id:'multi-b',name:'公司 B',routingPriority:200}]);
 await wait('document.querySelectorAll(".vpn-profile-item").length===2');w.webContents.send('fixture:multi');
 await wait('!!document.querySelector(".vpn-multi-summary")');
 await js('document.querySelector(".vpn-profile-item").click()');await input('登录密码','fixture-multi-a');await textClick('连接 VPN');
 await wait('document.querySelector(".vpn-auth-dialog").textContent.includes("公司 A")');await input('验证码','123456');await textClick('提交验证码');
 await wait('document.querySelector(".vpn-multi-summary").textContent.includes("已连接 1")');
 await js('document.querySelectorAll(".vpn-profile-item")[1].click()');await wait('document.querySelector(".vpn-connection-title").textContent.includes("公司 B")');
 await click('[aria-label="编辑接入配置"]');await click('#vpn-tab-routing');await input('分流优先级','50');await textClick('保存配置');await wait('!document.querySelector("[data-vpn-editor]")');
 await input('登录密码','fixture-multi-b');await textClick('连接 VPN');await wait('document.querySelector(".vpn-auth-dialog").textContent.includes("公司 B")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.states["multi-a"].state)'), 'connected');
 assert.deepEqual(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.fixtureDisconnectCalls)'), []);
 await input('验证码','123456');await textClick('提交验证码');await wait('document.querySelector(".vpn-multi-summary").textContent.includes("已连接 2")');
 assert.equal(await js('document.querySelectorAll(".vpn-profile-item .vpn-success-text").length'),2);
 assert.ok(await js('document.querySelector(".vpn-multi-summary").textContent.includes("默认策略：公司 B")'));await capture('vpn-access-multi-connected');
 await textClick('断开连接');await wait('document.querySelector(".vpn-multi-summary").textContent.includes("已连接 1")');
 assert.equal(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.states["multi-a"].state)'), 'connected');
 assert.deepEqual(await js('window.electronAPI.corporateVpn.snapshot().then(s=>s.fixtureDisconnectCalls)'), ['multi-b']);
 await textClick('断开全部');await wait('document.querySelector(".vpn-multi-summary").textContent.includes("已连接 0")');
 assert.deepEqual(errors,[]);
 const report={renderer:'Electron',noNodeDashboard:true,directModeDashboard:true,light:true,dark:true,compact980:true,noHorizontalOverflow:true,connectVisibleAt780:true,applicationProxy:true,proxyPortUpdates:true,proxyAddressCopy:true,proxyPortCopy:true,proxyStatusAndAuth:true,proxyCopyFailure:true,search:true,editorTabs:true,preserveResourcePorts:true,advancedRoutingShortcut:true,customRoutingSaved:true,customRoutingScoped:true,routingPriorityVisible:true,createAtrust:true,saveAndDiscover:true,authDiscovery:true,certificate:true,certificateErrorShortcut:true,passwordSavedBeforeLogin:true,explicitPasswordSave:true,editorPasswordSave:true,realSystemEncryption:true,discardUnsaved:true,deleteProfile:true,keyboardFocusTrap:true,emptyState:true,manualOTP:true,challengeHideResume:true,challengeEscapeResume:true,challengeNewRoundReset:true,challengeExpiredSubmitBlocked:true,connectedReadOnlyView:true,atrustClickCaptcha:true,passwordCleared:true,errors};
 Object.assign(report,{automaticPrivateDiscoveryDefault:true,automaticDiscoveryOptOutPersisted:true,learnedEndpointVisible:true,learnedClearReadOnly:true,learnedClearScoped:true,independentColumnScroll:true,fixedPageHeader:true,fixedListSearch:true,keyboardColumnScroll:true,profileSwitchResetsDetails:true,compactScroll980:true});
 Object.assign(report,{inactiveVpnUsesNormalRouting:true,failedVpnGuardCanBeReleased:true});
 Object.assign(report,{multipleConnections:true,scopedDisconnect:true,independentMFA:true,priorityEditableForInactivePeer:true,disconnectAll:true});
 fs.writeFileSync(path.join(__dirname,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));w.destroy();app.quit();
}).catch(error=>{console.error(error.stack);app.exit(1);});
`,
);
const child = spawn(binary, [path.join(out, 'main.cjs')], {
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: 'inherit',
});
const timer = setTimeout(() => child.kill(), 60000);
child.on('close', (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
child.on('error', (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
