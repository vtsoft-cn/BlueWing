// Production HTML/preload/security wrapper only; never launches product main or VPN.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'work','corporate-vpn-tools','security-ui-smoke');
fs.mkdirSync(out,{recursive:true});
fs.mkdirSync(path.join(out,'private-config'),{recursive:true});
fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
const path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=__ROOT__,{guardedIpc}=require(path.join(root,'dist/main/security/IpcSecurity.js'));
app.setPath('userData',path.join(__dirname,'user-data'));app.disableHardwareAcceleration();
const page=path.join(root,'dist/renderer/index.html'),preload=path.join(root,'dist/preload/index.js');
let win;const ipc=guardedIpc(ipcMain,()=>win,()=>pathToFileURL(page).href);
const values={'nodes:getAll':[],'nodes:getActiveId':'','subs:getAll':[],'routing:getRules':[],'routing:getAppRules':[],
  'dns:get':{mode:'standard',servers:[],hosts:[]},'settings:get':{theme:'dark',mixedPort:2080,routingMode:'direct',webdav:{},tunEnabled:false},
  'core:getState':'stopped','core:getVersion':'fixture','evpn:getProfiles':[],'evpn:getState':null,
  'settings:credentialStatus':{mode:'normal',lockedRecords:0,lockedSettings:[],pendingChanges:false,message:''},
  'vpn:snapshot':{profiles:[],state:{state:'idle',generation:0},states:{},encryptionAvailable:true,passwordSaved:{}}};
for(const [channel,value]of Object.entries(values))ipc.handle(channel,()=>value);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  require(path.join(root,'dist/main/security/PrivateFiles.js')).privateDirectory(path.join(__dirname,'private-config'));
  assert.equal(safeStorage.isEncryptionAvailable(),true);
  const encrypted=safeStorage.encryptString('fixture-DPAPI-password');
  assert.equal(safeStorage.decryptString(encrypted),'fixture-DPAPI-password');
  assert.ok(!encrypted.toString().includes('fixture-DPAPI-password'));
  const {CredentialSecurity}=require(path.join(root,'dist/main/security/CredentialSecurity.js'));
  const wrapped=CredentialSecurity.encrypt('fixture-wrapper-password');
  assert.ok(wrapped.startsWith('enc:dpapi:'));
  assert.equal(CredentialSecurity.decrypt(wrapped),'fixture-wrapper-password');
  win=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  await win.loadFile(page);
  let loaded=false;for(let i=0;i<100;i++){loaded=await js('document.body.innerText.includes("启动直连分流")');if(loaded)break;await sleep(40);}
  assert.ok(loaded,'Production renderer failed to load: '+errors.join(' | '));
  assert.deepEqual(errors,[]);
  assert.equal(await js('typeof window.require'),'undefined');
  assert.ok(await js('document.querySelector("meta[http-equiv=Content-Security-Policy]").content.includes("default-src")'));
  await js('window.fixtureViolations=[];document.addEventListener("securitypolicyviolation",e=>window.fixtureViolations.push(e.violatedDirective));const s=document.createElement("script");s.textContent="window.fixtureInjected=1";document.body.appendChild(s);void 0;');
  await sleep(100);assert.equal(await js('window.fixtureInjected'),undefined);
  assert.ok((await js('window.fixtureViolations')).some(x=>x.startsWith('script-src')));
  const other=new BrowserWindow({show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await other.loadURL('data:text/html,<html><body>untrusted fixture</body></html>');
  assert.equal(await other.webContents.executeJavaScript('window.electronAPI.settings.get().then(()=>false,()=>true)'),true);
  other.destroy();win.destroy();
  console.log('PASS: production renderer + CSP + sandbox + main-window IPC guard + actual Windows credential encryption');
}).then(()=>app.quit()).catch(error=>{console.error(error.stack);app.exit(1);});
`.replace('__ROOT__',JSON.stringify(root)));
const child=spawn(process.env.BLUEWING_ELECTRON_BINARY||path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(out,'main.cjs')],{windowsHide:true,stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
const timer=setTimeout(()=>child.kill(),30000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
child.on('close',code=>{clearTimeout(timer);process.exitCode=code??1;});
