const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), os = require('node:os'), { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const root = path.resolve(__dirname, '..');
const release = path.resolve(root, process.argv[2] || 'release-network-audit-fixed');
const resources = path.join(release, 'win-unpacked', 'resources');
let count = 0;
function verifyDist(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) verifyDist(file);
    else { assert.deepEqual(asar.extractFile(path.join(resources, 'app.asar'), path.relative(root, file)), fs.readFileSync(file), file); count++; }
  }
}
verifyDist(path.join(root, 'dist'));
const verified = [];
for (const [kind, binary, source] of [['vpn', 'bluewing-vpn-core.exe', 'vpn'], ['routing', 'sing-box.exe', 'routing']]) {
  const manifestFile = `${kind}-core-manifest.json`, archive = `${kind}-core-sources.zip`;
  for (const file of [binary, manifestFile, archive]) assert.deepEqual(fs.readFileSync(path.join(resources, 'bin', file)), fs.readFileSync(path.join(root, 'bin', file)), file);
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'bin', manifestFile)));
  assert.equal(hash(fs.readFileSync(path.join(resources, 'bin', binary))), manifest.sha256);
  assert.equal(hash(fs.readFileSync(path.join(resources, 'bin', archive))), manifest.sourceArchiveSha256);
  const sources = [], base = path.join(root, 'native', source);
  function walk(dir) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); if (name === '.cache' || name.endsWith('.exe')) continue; if (fs.statSync(file).isDirectory()) walk(file); else sources.push([path.relative(base, file).replaceAll('\\', '/'), hash(fs.readFileSync(file))]); } }
  walk(base); assert.equal(hash(JSON.stringify(sources)), manifest.sourceSha256, `${kind} source drift`);
  verified.push({ kind, revision: manifest.revision, sourceFiles: sources.length, binarySHA256: manifest.sha256 });
}
assert.deepEqual(fs.readFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.md')), fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));
// Exercise the shipped release entry point without reading/modifying real proxy settings.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluewing-release-contract-'));
try {
  const helper = path.join(resources, 'bin', 'bluewing-vpn-core.exe');
  const absent = spawnSync(helper, ['--release-network', path.join(tmp, 'absent.json')], { windowsHide: true, timeout: 5000 });
  assert.equal(absent.status, 0);
  fs.writeFileSync(path.join(tmp, 'invalid.json'), 'broken');
  const invalid = spawnSync(helper, ['--release-network', path.join(tmp, 'invalid.json')], { windowsHide: true, timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.equal(fs.readFileSync(path.join(tmp, 'invalid.json'), 'utf8'), 'broken');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
const installer = path.join(release, 'BlueWingConnect-NetworkAuditFixed-Setup.exe');
assert.ok(fs.statSync(installer).size > 20e6);
console.log(JSON.stringify({ result: 'PASS', distFiles: count, cores: verified, installer, installerBytes: fs.statSync(installer).size, installerSHA256: hash(fs.readFileSync(installer)) }, null, 2));
