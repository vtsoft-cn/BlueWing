const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root,f));
const hash = b => createHash('sha256').update(b).digest('hex');
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.license,'AGPL-3.0-only');
for (const file of ['LICENSE','COPYRIGHT.md','PRIVACY.md','SECURITY.md','THIRD_PARTY_NOTICES.md','LICENSES/AGPL-3.0.txt','LICENSES/GPL-3.0.txt','LICENSES/upstream/Wintun-prebuilt.txt']) assert.ok(read(file).length > 100,file);
const materials = JSON.parse(read('PUBLIC_RELEASE_MATERIALS.json'));
assert.equal(materials.maintainerRightsConfirmed,true);
const cores=[];
for (const [core,binary] of [['vpn','bluewing-vpn-core.exe'],['routing','sing-box.exe']]) {
  const manifest=JSON.parse(read(`bin/${core}-core-manifest.json`));
  assert.equal(hash(read('bin/'+binary)),manifest.sha256,`${core} binary mismatch`);
  assert.equal(hash(read(`bin/${core}-core-sources.zip`)),manifest.sourceArchiveSha256,`${core} source archive mismatch`);
  assert.ok(manifest.toolchain.includes('go1.26.10 '),`${core} Go toolchain`);
  const sourceFiles=[],base=path.join(root,'native',core);
  function walk(dir){for(const name of fs.readdirSync(dir).sort()){if(name==='.cache'||name.endsWith('.exe'))continue;const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else sourceFiles.push([path.relative(base,file).replaceAll('\\','/'),hash(fs.readFileSync(file))]);}}
  walk(base); assert.equal(hash(Buffer.from(JSON.stringify(sourceFiles))),manifest.sourceSha256,`${core} source drift; rebuild core`);
  cores.push({core,revision:manifest.revision});
}
const inventory=JSON.parse(read('LICENSES/inventory.json'));
for(const item of inventory.binaries)assert.equal(hash(read(item.file)),item.sha256,'Outdated inventory: '+item.file);
const pending=[];
for(const category of ['binaryRedistribution','releaseOperations'])for(const [key,value] of Object.entries(materials[category]))if(value!==true||!materials.evidence[key])pending.push(key);
console.log(JSON.stringify({technicalChecks:'PASS',cores,publicBinaryReleaseReady:pending.length===0,pending,sourceSnapshotCommand:'npm run public:source'},null,2));
if(process.argv.includes('--public')&&pending.length){console.error('Public binary distribution blocked: missing reviewed release evidence.');process.exitCode=1;}
