// Load the actual production main entry before ready with an encrypted database.
// All network takeover, orphan cleanup and tray actions are stubbed in this harness.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),base=fs.mkdtempSync(path.join(os.tmpdir(),'bluewing-startup-'));
const electron=path.join(root,'node_modules/electron/dist/electron.exe');
const seed=String.raw`
const {app,safeStorage}=require('electron'),fs=require('fs'),path=require('path');
app.setPath('userData',__DATA__);app.whenReady().then(()=>{
 const protectedValue='enc:dpapi:'+safeStorage.encryptString('fixture-password').toString('base64');
 const node=__MODE__==='reconfigure'?{id:'fixture',name:'Fixture',type:'vless',uuid:protectedValue,server:'192.0.2.1',port:443}:{id:'fixture',name:'Fixture',type:'trojan',password:protectedValue,server:'192.0.2.1',port:443};
 fs.writeFileSync(path.join(__DATA__,'bluewing.json'),JSON.stringify({schemaVersion:3,nodes:[node],subscriptions:[],activeNodeId:'fixture',settings:{autoConnectOnLaunch:['locked','reconfigure'].includes(__MODE__),systemProxyEnabled:false,tunEnabled:false,closeToTray:__MODE__==='normal'}}));
}).then(()=>app.quit()).catch(e=>{console.error(e);app.exit(1);});`;
const main=String.raw`
const {app,BrowserWindow,dialog}=require('electron'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=__ROOT__,data=__DATA__,mode=__MODE__;process.env.BLUEWING_DATA_DIR=data;app.setPath('userData',data);
const childProcess=require('node:child_process'),{EventEmitter}=require('node:events');
const spawn=childProcess.spawn;
childProcess.spawn=(command,args,...options)=>{
 // Keep a separately installed BlueWing instance outside this fixture.
 if(command==='powershell.exe'&&args?.some(arg=>arg.includes("Get-Process 'BlueWing Connect'"))){
  const child=new EventEmitter();
  queueMicrotask(()=>child.emit('close',0));
  return child;
 }
 return spawn(command,args,...options);
};
const file=path.join(data,'bluewing.json'),before=fs.readFileSync(file);let beforeReadyReads=0,networkStarts=0,restoreCalls=0;
const shutdownOrder=[];
let releaseRestore;
const restoreGate=new Promise(resolve=>{releaseRestore=resolve;});
const {Database}=require(path.join(root,'dist/main/db/Database.js'));
const original=Database.getInstance.bind(Database);Database.getInstance=(...args)=>{if(!app.isReady())beforeReadyReads++;return original(...args);};
if(mode==='disk-error')Database.prototype.flushPending=()=>{throw Error('Simulated disk failure during shutdown');};
if(mode==='locked')require(path.join(root,'dist/main/security/CredentialSecurity.js')).CredentialSecurity.useProvider(null);
const {SystemProxy}=require(path.join(root,'dist/main/system/SystemProxy.js'));
for(const key of ['initializeRecovery','enable','disable','recoverIfUnavailable'])SystemProxy[key]=async()=>true;
SystemProxy.checkAndCleanResidual=()=>{};
SystemProxy.restoreOriginal=async()=>{
 restoreCalls++;
 if(mode==='normal')await restoreGate;
 shutdownOrder.push('proxy');
 return mode!=='disk-error'||restoreCalls>1;
};
const {SingBoxManager}=require(path.join(root,'dist/main/core/SingBoxManager.js'));
SingBoxManager.prototype.cleanupOrphanCores=async()=>{};
SingBoxManager.prototype.stop=async()=>{shutdownOrder.push('core');};
SingBoxManager.prototype.start=async()=>{networkStarts++;throw Error('Unexpected network startup');};
require(path.join(root,'dist/main/tray/TrayManager.js')).TrayManager.prototype.init=()=>{};
require(path.join(root,'dist/main/system/vpn/VpnEngineManager.js')).VpnEngineManager.prototype.shutdown=async()=>{shutdownOrder.push('vpn');};
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
dialog.showErrorBox=(title,message)=>{throw Error('Unexpected startup error dialog');};
process.on('uncaughtException',e=>{console.error(e.stack);app.exit(1);});
process.on('unhandledRejection',e=>{console.error(e);app.exit(1);});
app.on('browser-window-created',(_,win)=>{win.webContents.once('did-finish-load',async()=>{
 try{
  assert.equal(beforeReadyReads,0);assert.equal(networkStarts,0);
  const status=await win.webContents.executeJavaScript('window.electronAPI.settings.credentialStatus()');
  assert.equal(status.mode,mode==='disk-error'?'normal':mode);
  const nodes=await win.webContents.executeJavaScript('window.electronAPI.nodes.getAll()');
  if(mode==='normal'||mode==='disk-error')assert.equal(nodes[0].password,'fixture-password');
  else{
   for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('!!document.querySelector("[role=alert]")'))break;await new Promise(r=>setTimeout(r,30));}
   assert.ok(await win.webContents.executeJavaScript('!!document.querySelector("[role=alert]")'));
   if(mode==='locked'){
    assert.equal(nodes[0].credentialsUnavailable,true);
    await win.webContents.executeJavaScript('window.electronAPI.nodes.add({id:"temporary",name:"Temporary",type:"socks",server:"127.0.0.1",port:12345,password:"session-only-secret"})');
    assert.equal(Database.getInstance().getNodes().length,2);
   }else assert.equal(nodes.length,0);
  }
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(networkStarts,0);
  if(mode==='normal'){
   win.close();
   assert.equal(win.isDestroyed(),false);
  }
  app.once('will-quit',()=>{
   assert.deepEqual(fs.readFileSync(file),before);
   assert.deepEqual(shutdownOrder,mode==='disk-error'?['proxy','vpn','core','proxy']:['proxy','vpn','core']);
   console.log('PASS actual main startup and shutdown: '+mode);
  });
  app.quit();
  if(mode==='normal'){
   await new Promise(resolve=>setImmediate(resolve));
   app.quit();
   assert.equal(restoreCalls,1);
   assert.deepEqual(shutdownOrder,[]);
   releaseRestore();
  }
 }catch(e){console.error(e.stack);app.exit(1);}
});});
require(path.join(root,'dist/main/index.js'));`;
function run(file){return new Promise((resolve,reject)=>{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[file],{cwd:root,env,windowsHide:true,stdio:'inherit'});const timer=setTimeout(()=>{child.kill();reject(Error('Startup smoke timeout: '+path.basename(file)));},30000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Startup smoke failed: '+path.basename(file)+' ('+code+')'));});});}
(async()=>{for(const mode of ['normal','locked','reconfigure','disk-error']){const dir=path.join(base,mode);fs.mkdirSync(dir,{recursive:true});for(const [name,template]of [['seed',seed],['main',main]]){const file=path.join(base,mode+'-'+name+'.cjs');fs.writeFileSync(file,template.replaceAll('__ROOT__',JSON.stringify(root)).replaceAll('__DATA__',JSON.stringify(dir)).replaceAll('__MODE__',JSON.stringify(mode)));await run(file);}}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
