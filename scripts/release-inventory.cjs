// Capture the installed dependency graph and exact runtime hashes; no uploads.
const fs = require('node:fs'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'LICENSES');
const hash = data => createHash('sha256').update(data).digest('hex');
const relative = p => path.relative(root, p).replaceAll('\\', '/');
function licenses(dir, category, name) {
  if (!dir || !fs.existsSync(dir)) return [];
  const found = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const from = path.join(dir, file);
    if (!/^(licen[cs]e|copying|notice|copyright|patents)([._-].*)?$/i.test(file) || !fs.statSync(from).isFile()) continue;
    const to = path.join(out, category, name.replace(/[^a-zA-Z0-9._-]/g, '_'), file);
    fs.mkdirSync(path.dirname(to), {recursive:true}); if (!fs.existsSync(to) || !fs.readFileSync(to).equals(fs.readFileSync(from))) { if (fs.existsSync(to)) fs.chmodSync(to,0o600); fs.writeFileSync(to,fs.readFileSync(from)); }
    found.push(relative(to));
  }
  return found;
}
const npm = [];
const seen = new Set();
function npmPackage(name, parent) {
  const metadata = require.resolve(name + '/package.json', {paths:[parent]});
  if (seen.has(metadata)) return; seen.add(metadata);
  const pkg = JSON.parse(fs.readFileSync(metadata));
  npm.push({name:pkg.name,version:pkg.version,license:pkg.license,licenseFiles:licenses(path.dirname(metadata),'npm',pkg.name+'@'+pkg.version)});
  for (const dep of Object.keys(pkg.dependencies || {})) npmPackage(dep, path.dirname(metadata));
}
for (const name of Object.keys(require('../package.json').dependencies)) npmPackage(name, root);
const tool = path.join(root, 'work', 'corporate-vpn-tools');
const localGo = path.join(tool, 'toolchain', 'go', 'bin', 'go.exe');
const go = process.env.GO_BINARY || (fs.existsSync(localGo) ? localGo : 'go');
const env = {...process.env,GOTOOLCHAIN:'go1.26.10',GOPATH:process.env.GOPATH || path.join(tool,'gopath'),GOCACHE:process.env.GOCACHE || path.join(tool,'gocache')};
const modules = new Map();
for (const core of ['vpn','routing']) {
  const json = execFileSync(go,['list','-m','-json','all'],{cwd:path.join(root,'native',core),env,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  for (const text of json.trim().split(/\r?\n(?=\{)/)) {
    const m = JSON.parse(text); if (m.Main) continue;
    const key = m.Path+'@'+(m.Version || 'local');
    let item = modules.get(key);
    if (!item) {
      item = {name:m.Path,version:m.Version,replace:m.Replace ? {name:m.Replace.Path,version:m.Replace.Version} : undefined,cores:[],licenseFiles:licenses(m.Replace?.Dir || m.Dir,'go',key)};
      modules.set(key,item);
    }
    item.cores.push(core);
  }
}
const goRoot = execFileSync(go,['env','GOROOT'],{env,encoding:'utf8',windowsHide:true}).trim();
const runtimeLicenses = licenses(goRoot,'runtime','go1.26.10');
const binaries = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir,name);
    if (fs.statSync(file).isDirectory()) walk(file);
    else if (/\.(exe|dll|srs)$/i.test(name)) binaries.push({file:relative(file),sha256:hash(fs.readFileSync(file)),bytes:fs.statSync(file).size});
  }
}
walk(path.join(root,'bin'));
const report = {schemaVersion:1,scope:'npm production dependencies and both complete Go module build graphs (includes test/build-only modules)',npm:npm.sort((a,b)=>a.name.localeCompare(b.name)),go:[...modules.values()].sort((a,b)=>a.name.localeCompare(b.name)),goRuntimeLicenses:runtimeLicenses,binaries};
fs.writeFileSync(path.join(out,'inventory.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({npm:npm.length,go:modules.size,binaries:binaries.length,missingLicense:npm.concat([...modules.values()]).filter(x=>!x.licenseFiles.length).map(x=>x.name),note:'Hashes and license texts do not establish complete corresponding source or binary redistribution rights.'},null,2));
