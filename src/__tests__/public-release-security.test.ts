import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { privateDirectory } from '../main/security/PrivateFiles';
import { RasCredentials, RAS_NATIVE_SOURCE, RAS_SETUP_SCRIPT, RAS_CLEAR_SCRIPT } from '../main/system/vpn/RasCredentials';
import { RasVpnEngine, rasEntryName } from '../main/system/vpn/RasVpnEngine';
import { testEncryption } from './helpers/encryption';
import { CredentialSecurity } from '../main/security/CredentialSecurity';
import { Database } from '../main/db/Database';
import { protectBackup, unprotectBackup } from '../main/security/BackupProtection';
import { WindowsBackupCodec } from '../main/db/backup/WindowsBackupCodec';
import { BackupService } from '../main/db/backup/BackupService';
import { BackupTransaction } from '../main/db/backup/BackupTransaction';
import { WebDAVClient } from '../main/net/WebDAVClient';
import { guardedIpc, assertIpcData } from '../main/security/IpcSecurity';
import { validateOpenVpnConfig, validateVpnId } from '../main/security/VpnConfigSecurity';
import { VpnDiagnostics } from '../main/vpn/VpnDiagnostics';
import { ConfigGenerator } from '../main/core/ConfigGenerator';
import { coreApiSecret, coreApiHeaders } from '../main/security/CoreApiAuth';

function temp(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-security-'));
  t.after(() => { CredentialSecurity.useProvider(testEncryption); Database.resetInstance(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const node: any = { id:'fixture',name:'fixture',type:'trojan',server:'192.0.2.1',port:443,groupId:'default',password:'fixture-node-password',privateKey:'fixture-private-key',rawOutbound:{custom_header:'fixture-custom-token'} };
const settings: any = { theme:'dark',mixedPort:2080,allowLan:false,tunEnabled:false,routingMode:'direct',webdav:{serverUrl:'https://backup.example',username:'fixture',password:'fixture-webdav-secret',backupPassphrase:'fixture-backup-passphrase',remotePath:'backup',autoSync:false} };

test('RAS Unicode credential pipe and native structure compile without putting secrets in argv', {skip:process.platform !== 'win32'}, async t => {
  const secret="fixture-秘密'$(not-executed)\ncredential";
  let command='';const original=childProcess.spawn.bind(childProcess);
  t.mock.method(childProcess,'spawn',((exe:any,args:any,options:any)=>{command=[exe,...args].join(' ');return original(exe,args,options);}) as any);
  // Compile P/Invoke metadata, but never call RAS or change any connection/credential.
  const probe=`$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$data=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition @'\n${RAS_NATIVE_SOURCE}\n'@\n@{ok=($data.password -ceq $data.psk);code=[Runtime.InteropServices.Marshal]::SizeOf([type][BlueWingRasCredentials+Credentials])}|ConvertTo-Json -Compress`;
  assert.deepEqual(await RasCredentials.run(probe,{user:'示例用户',password:secret,psk:secret}),{ok:true,code:1068});
  assert.ok(!command.includes(secret));
  await assert.rejects(()=>RasCredentials.run(RAS_SETUP_SCRIPT,{password:'x'.repeat(257)}),/格式|长度/);
});

test('RAS setup errors fail closed without dialing and clear the owned credentials', async t => {
  const calls:any[]=[];let dialed=false;
  t.mock.method(RasCredentials,'run',async(script:string,data:any)=>{calls.push({script,data});return {ok:script===RAS_CLEAR_SCRIPT,code:5};});
  const engine:any=new RasVpnEngine();engine.rasdial=async()=>{dialed=true;return 0;};
  const errors:string[]=[];
  await engine.start({profile:{id:'fixture',type:'l2tp',server:'vpn.example',username:'fixture-user',password:'fixture-password',l2tpPsk:'fixture-psk'},onError:(e:string)=>errors.push(e)} as any);
  assert.equal(dialed,false);assert.equal(calls[0].script,RAS_SETUP_SCRIPT);assert.equal(calls[1].script,RAS_CLEAR_SCRIPT);
  assert.ok(errors[0].includes('5'));assert.ok(!errors[0].includes('fixture-password'));
});

test('RAS dialing uses only the owned entry name and cleans credentials on failure', async t => {
  const calls:string[]=[];t.mock.method(RasCredentials,'run',async(script:string)=>{calls.push(script);return {ok:true};});
  const profile:any={id:'fixture',type:'l2tp',server:'vpn.example',username:'fixture-user',password:'fixture-password',l2tpPsk:'fixture-psk'};
  const engine:any=new RasVpnEngine();let args:string[]=[];engine.rasdial=async(value:string[])=>{args=value;return 691;};
  await engine.start({profile,onError:()=>{}} as any);
  assert.deepEqual(args,[rasEntryName(profile)]);assert.deepEqual(calls,[RAS_SETUP_SCRIPT,RAS_CLEAR_SCRIPT]);
});

test('OS encryption errors never create a reversible fallback', t => {
  t.after(() => CredentialSecurity.useProvider(testEncryption));
  for (const provider of [null,{isEncryptionAvailable:()=>false},{isEncryptionAvailable:()=>true,encryptString(){throw Error('failure')}},{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text'}]) {
    CredentialSecurity.useProvider(provider);
    assert.throws(() => CredentialSecurity.encrypt('fixture-secret'), /CREDENTIAL_STORE_LOCKED/);
  }
});

test('credential directory removes explicit grants to other Windows accounts', {skip:process.platform !== 'win32'}, t => {
  const dir=temp(t),target=path.join(dir,"credentials ' fixture");
  fs.mkdirSync(target);
  execFileSync('icacls.exe',[target,'/grant','*S-1-1-0:(OI)(CI)F'],{stdio:'ignore',windowsHide:true});
  privateDirectory(target);
  const encoded=Buffer.from(target,'utf16le').toString('base64');
  const script=`$target=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $acl=[IO.Directory]::GetAccessControl($target); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @($acl.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid}).Count`;
  const otherGrants=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}).trim();
  assert.equal(otherGrants,'0');
  assert.throws(()=>privateDirectory(path.parse(target).root));
});
test('only passwords and keys are encrypted; ordinary configuration remains normal JSON', t => {
  const dir=temp(t), file=path.join(dir,'bluewing.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:2,nodes:[node],subscriptions:[{id:'sub',url:'https://sub.example/fixture-url-token'}],settings}));
  const db=Database.getInstance(dir);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).schemaVersion,2,'Opening configuration must not migrate it');
  db.flush();
  for (const name of ['bluewing.json','bluewing.json.bak']) {
    const disk=fs.readFileSync(path.join(dir,name),'utf8');
    for (const secret of ['fixture-node-password','fixture-private-key','fixture-webdav-secret','fixture-backup-passphrase']) assert.ok(!disk.includes(secret),name);
  }
  assert.equal(db.getNodes()[0].password,node.password);
  assert.equal(db.getNodes()[0].rawOutbound?.custom_header,'fixture-custom-token');
  const disk=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(typeof disk.nodes[0].rawOutbound,'object');assert.equal(disk.subscriptions[0].url,'https://sub.example/fixture-url-token');
  assert.equal(db.getSettings().webdav.backupPassphrase,settings.webdav.backupPassphrase);
});
test('a locked credential store cannot replace existing database or backup', t => {
  const dir=temp(t);let db=Database.getInstance(dir);db.saveNodes([node]);db.flush();
  const file=path.join(dir,'bluewing.json'), previous=fs.readFileSync(file);
  Database.resetInstance();CredentialSecurity.useProvider(null);
  db=Database.getInstance(dir);
  assert.equal(db.credentialStatus().mode,'locked');
  assert.equal(db.getNodes()[0].credentialsUnavailable,true);
  db.saveSettings({theme:'light'});
  assert.equal(db.credentialStatus().pendingChanges,true);
  db.flushPending();
  assert.deepEqual(fs.readFileSync(file),previous);
});

test('temporary encryption failure keeps edits usable in memory and persists after recovery', t => {
  const dir=temp(t),db=Database.getInstance(dir),file=path.join(dir,'bluewing.json'),before=fs.readFileSync(file);
  CredentialSecurity.useProvider(null);
  db.saveNodes([node]);
  assert.equal(db.getNodes()[0].password,node.password);
  assert.equal(db.credentialStatus().mode,'session');
  assert.deepEqual(fs.readFileSync(file),before);
  CredentialSecurity.useProvider(testEncryption);
  db.flush();assert.equal(db.credentialStatus().mode,'normal');
  assert.ok(!fs.readFileSync(file,'utf8').includes(node.password));
});

test('restarting after temporary password unavailability rereads the preserved original data', t => {
  const dir=temp(t);let db=Database.getInstance(dir);db.saveNodes([node]);
  Database.resetInstance();CredentialSecurity.useProvider(null);db=Database.getInstance(dir);
  db.addNode({...node,id:'temporary',password:'new-session-secret'});db.flushPending();
  CredentialSecurity.useProvider(testEncryption);Database.resetInstance();db=Database.getInstance(dir);
  assert.equal(db.credentialStatus().mode,'normal');assert.equal(db.getNodes().length,1);
  assert.equal(db.getNodes()[0].password,node.password);
});

test('UUIDs, URLs and configuration stay readable while nested passwords and keys are protected', t => {
  const dir=temp(t),db=Database.getInstance(dir);
  const uuid='00000000-0000-4000-8000-000000000001';
  db.saveNodes([{...node,uuid,rawOutbound:{server:'proxy.example',uuid,password:'nested-password'}}]);
  db.upsertVpnProfile({id:'vpn',type:'wireguard',name:'fixture',server:'vpn.example',createdAt:0,configText:'client\nremote vpn.example',privateKey:'fixture-key'});
  const disk=JSON.parse(fs.readFileSync(path.join(dir,'bluewing.json'),'utf8'));
  assert.equal(disk.nodes[0].uuid,uuid);assert.equal(disk.nodes[0].rawOutbound.uuid,uuid);
  assert.match(disk.nodes[0].rawOutbound.password,/^enc:dpapi:/);
  assert.equal(disk.vpnProfiles[0].configText,'client\nremote vpn.example');assert.match(disk.vpnProfiles[0].privateKey,/^enc:dpapi:/);
});

test('obsolete encryption of ordinary configuration is skipped without attempting compatibility decryption', t => {
  const dir=temp(t),file=path.join(dir,'bluewing.json');
  const raw=JSON.stringify({schemaVersion:3,nodes:[{...node,password:undefined,uuid:'enc:dpapi:obsolete'}],subscriptions:[{id:'sub',url:'enc:dpapi:obsolete'}]});
  fs.writeFileSync(file,raw);let decryptCalls=0;
  CredentialSecurity.useProvider({isEncryptionAvailable:()=>true,decryptString(){decryptCalls++;throw Error('must not decode obsolete metadata');}});
  const db=Database.getInstance(dir);
  assert.equal(decryptCalls,0);assert.equal(db.credentialStatus().mode,'reconfigure');
  assert.equal(db.getNodes().length,0);assert.equal(db.getSubscriptions().length,0);
  db.flushPending();assert.equal(fs.readFileSync(file,'utf8'),raw);
});
test('shareable configuration excludes credentials and opaque subscription URLs', () => {
  const content=WindowsBackupCodec.encode([node],[{id:'s',url:'https://sub.example/opaque-token'}] as any,[],[],{} as any,settings);
  const data=JSON.parse(content);
  assert.equal(data.secretsOmitted,true);
  for(const secret of [node.password,node.privateKey,'fixture-custom-token','opaque-token',settings.webdav.password,settings.webdav.backupPassphrase]) assert.ok(!content.includes(secret));
  assert.equal(data.nodes[0].server,node.server);assert.equal(data.settings.theme,'dark');
});
test('portable backups require a strong passphrase and authenticate both content and envelope', () => {
  const original=JSON.stringify({schema_version:3,nodes:[node],unicode:'多设备备份'}), passphrase='fixture-backup-passphrase';
  const encrypted=protectBackup(original,{passphrase});
  assert.ok(!encrypted.includes(node.password));assert.equal(unprotectBackup(encrypted,passphrase),original);
  assert.throws(()=>protectBackup(original,{passphrase:'short'}),/口令/);
  assert.throws(()=>unprotectBackup(encrypted,'fixture-wrong-passphrase'),/口令/);
  const data=JSON.parse(encrypted);data.ciphertext=data.ciphertext.slice(0,-4)+'AAAA';
  assert.throws(()=>unprotectBackup(JSON.stringify(data),passphrase),/损坏/);
  data.salt='';assert.throws(()=>unprotectBackup(JSON.stringify(data),passphrase),/格式/);
});
test('local recovery preserves secrets using OS encryption and portable import uses its own passphrase', async t => {
  const dir=temp(t),db=Database.getInstance(dir);db.saveNodes([node]);db.saveSettings(settings);
  const saved=await BackupService.createLocalBackup();
  assert.ok(!fs.readFileSync(saved.filePath,'utf8').includes(node.password));
  db.saveNodes([{...node,password:'changed'}]);await BackupService.restoreLocalBackup();assert.equal(db.getNodes()[0].password,node.password);
  const exported=await BackupService.exportWindowsBackup(undefined,{passphrase:'fixture-backup-passphrase'});
  assert.throws(()=>BackupService.parseRawContent(exported),/口令/);
  assert.equal(BackupService.parseRawContent(exported,'fixture-backup-passphrase').nodes?.[0].password,node.password);
});
test('import does not reuse a WebDAV password with a different server', t => {
  const dir=temp(t),db=Database.getInstance(dir);db.saveSettings(settings);
  BackupTransaction.execute({settings:{webdav:{...settings.webdav,serverUrl:'https://other.example',password:undefined,backupPassphrase:undefined}} as any},{profiles:false,rules:false,settings:true});
  assert.equal(db.getSettings().webdav.password,undefined);
  assert.equal(db.getSettings().webdav.backupPassphrase,undefined);
  const preview=fs.readFileSync(path.join(dir,'bluewing.json'),'utf8');assert.ok(!preview.includes(settings.webdav.password));
});

test('rotating a legacy local backup never creates a new plaintext .bak copy', async t => {
  const dir=temp(t),db=Database.getInstance(dir);db.saveNodes([node]);
  const target=path.join(dir,'BlueWing_latest.bluewingbackup');
  fs.writeFileSync(target,JSON.stringify({schema_version:3,nodes:[node]}));
  await BackupService.createLocalBackup();
  for(const file of [target,target+'.bak']){
    const text=fs.readFileSync(file,'utf8');
    assert.equal(JSON.parse(text).format,'bluewing-local-v1');
    assert.ok(!text.includes(node.password));
    assert.equal(BackupService.parseRawContent(text).nodes?.[0].password,node.password);
  }
});
test('WebDAV rejects HTTP and credentials embedded in URLs before any request', () => {
  for (const url of ['http://backup.example','http://127.0.0.1','https://user:secret@backup.example','file:///etc/passwd']) assert.throws(()=>new WebDAVClient(url),/HTTPS/);
  assert.doesNotThrow(()=>new WebDAVClient('https://backup.example/path','fixture','fixture-secret'));
});
test('every diagnostic level omits supplied credentials and authentication payloads', t => {
  const dir=temp(t),log=new VpnDiagnostics(dir);
  log.begin({id:'fixture',diagnosticMode:'full',gateway:{host:'vpn.example',port:443},username:'fixture'} as any,1);
  log.input('fixture','password','fixture-secret');
  log.trace('fixture',{requestHeaders:{Authorization:'fixture-header'},responseBody:'fixture-cookie',url:'https://user:fixture-password@vpn.example/auth?sid=fixture-sid',status:200});
  const data=fs.readFileSync(log.file('fixture'),'utf8');
  for(const secret of ['fixture-secret','fixture-header','fixture-cookie','fixture-password','fixture-sid']) assert.ok(!data.includes(secret));
  assert.ok(data.includes('200'));
});
test('IPC checks main frame, window identity, page URL and structured payload before dispatch', () => {
  const handlers=new Map<string,any>(), listeners=new Map<string,any>();
  const raw:any={handle:(c:string,h:any)=>handlers.set(c,h),on:(c:string,h:any)=>listeners.set(c,h)};
  const frame:any={url:'file:///C:/fixture/index.html'},contents:any={mainFrame:frame};
  const window:any={isDestroyed:()=>false,webContents:contents};
  const ipc=guardedIpc(raw,()=>window,()=>frame.url);let calls=0;
  ipc.handle('fixture',()=>++calls);ipc.on('event',()=>++calls);
  assert.equal(handlers.get('fixture')({sender:contents,senderFrame:frame},{}),1);
  for(const event of [{sender:{},senderFrame:frame},{sender:contents,senderFrame:{url:frame.url}}]) assert.throws(()=>handlers.get('fixture')(event),/来源/);
  listeners.get('event')({sender:{},senderFrame:frame});assert.equal(calls,1);
  assert.throws(()=>assertIpcData([JSON.parse('{"__proto__":{"polluted":true}}')]),/字段/);
  assert.throws(()=>assertIpcData([NaN]),/数值/);
  const nested:any={};nested.self=nested;assert.throws(()=>assertIpcData([nested]),/复杂/);
});
test('OpenVPN refuses executable hooks, plugins and external config/key inclusion', () => {
  assert.doesNotThrow(()=>validateOpenVpnConfig('client\ndev tun\nremote vpn.example 443\nauth-user-pass\n<ca>\nfixture\n</ca>'));
  for(const directive of ['plugin evil.dll','up powershell.exe','script-security 2','setenv opt plugin evil.dll','config other.ovpn','ca private-file.pem','auth-user-pass other.auth','pkcs11-providers evil.dll']) assert.throws(()=>validateOpenVpnConfig('client\n'+directive));
  for(const id of ['../escape','a/b','a\\b','']) assert.throws(()=>validateVpnId(id));
});
test('actual core requires its per-launch token and does not grant an external Origin access', async t => {
  const dir=temp(t);const reserved=net.createServer();await new Promise<void>(r=>reserved.listen(0,'127.0.0.1',r));
  const port=(reserved.address() as net.AddressInfo).port;await new Promise<void>(r=>reserved.close(()=>r()));
  const cfg=ConfigGenerator.generate('',[],[],[],{mode:'standard',hosts:[],remoteDns:'https://1.1.1.1/dns-query',directDns:'1.1.1.1'} as any,settings);
  assert.match(coreApiSecret(),/^[0-9a-f]{64}$/);assert.equal(cfg.experimental.clash_api.secret,coreApiSecret());
  const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify({outbounds:[{type:'direct',tag:'direct'}],experimental:{clash_api:{...cfg.experimental.clash_api,external_controller:`127.0.0.1:${port}`}}}));
  const child=spawn(path.resolve('bin/sing-box.exe'),['run','-c',file],{windowsHide:true,stdio:'ignore'});
  t.after(async()=>{child.kill();await new Promise(r=>child.once('close',r));});
  const url=`http://127.0.0.1:${port}/version`;let ready=false;
  for(let i=0;i<100;i++){try{const response=await fetch(url);assert.equal(response.status,401);ready=true;break;}catch{await new Promise(r=>setTimeout(r,30));}}
  assert.ok(ready);assert.equal((await fetch(url,{headers:coreApiHeaders()})).status,200);
  const external=await fetch(url,{headers:{...coreApiHeaders(),Origin:'https://untrusted.example'}});
  assert.equal(external.headers.get('access-control-allow-origin'),null);
});
