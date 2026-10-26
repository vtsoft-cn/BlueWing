const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..'),
  source = path.join(root, 'native', 'vpn'),
  tools = path.join(root, 'work', 'corporate-vpn-tools');
const local = path.join(tools, 'toolchain', 'go', 'bin', 'go.exe');
const go = process.env.GO_BINARY || (fs.existsSync(local) ? local : 'go');
const env = {
  ...process.env,
  GOTOOLCHAIN: 'local',
  GOPATH: process.env.GOPATH || path.join(tools, 'gopath'),
  GOCACHE: process.env.GOCACHE || path.join(tools, 'gocache'),
};
const version = execFileSync(go, ['version'], {
  encoding: 'utf8',
  windowsHide: true,
  env,
}).trim();
if (!/go1\.25\.6\b/.test(version))
  throw new Error('Use the pinned Go 1.25.6 toolchain (GO_BINARY).');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin, { recursive: true });
execFileSync(
  go,
  [
    'build',
    '-buildvcs=false',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    path.join(bin, 'bluewing-vpn-core.exe'),
    './cmd/bluewing-vpn-core',
  ],
  { cwd: source, env, stdio: 'inherit', windowsHide: true },
);
const sourceFiles = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (name === '.cache' || name.endsWith('.exe')) continue;
    if (fs.statSync(file).isDirectory()) walk(file);
    else
      sourceFiles.push([
        path.relative(source, file).replace(/\\/g, '/'),
        createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      ]);
  }
}
walk(source);
const sourceSha256 = createHash('sha256')
  .update(JSON.stringify(sourceFiles))
  .digest('hex');
// Include the exact maintained fork, module locks and license beside the binary.
execFileSync(
  'tar.exe',
  [
    '-a',
    '-cf',
    path.join(bin, 'vpn-core-sources.zip'),
    '--exclude=*.exe',
    '--exclude=.cache',
    '-C',
    path.join(root, 'native'),
    'vpn',
  ],
  { windowsHide: true, stdio: 'inherit' },
);
fs.copyFileSync(
  path.join(source, 'LICENSE'),
  path.join(bin, 'VPN-CORE-LICENSE-AGPL-3.0.txt'),
);
fs.copyFileSync(
  path.join(source, 'client', 'softether', 'LICENSE-MIT'),
  path.join(bin, 'VPN-CORE-LICENSE-SOFTETHER-MIT.txt'),
);
const manifest = {
  schemaVersion: 1,
  name: 'bluewing-vpn-core',
  controlProtocol: 1,
  upstream: {
    repository: 'https://github.com/Mythologyli/zju-connect',
    tag: 'v1.3.1',
    commit: '5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da',
  },
  toolchain: version,
  additionalProviders: [{
    name: 'softether',
    repository: 'https://github.com/bclswl0827/govpn',
    tag: 'v0.2.4',
    commit: '78c78a37330f361c8f4922b0e7e126a3fc495742',
    license: 'MIT',
    source: 'client/softether',
  }],
  sourceSha256,
  sha256: createHash('sha256')
    .update(fs.readFileSync(path.join(bin, 'bluewing-vpn-core.exe')))
    .digest('hex'),
  sourceArchiveSha256: createHash('sha256')
    .update(fs.readFileSync(path.join(bin, 'vpn-core-sources.zip')))
    .digest('hex'),
  protocols: ['easyconnect', 'atrust', 'softether'],
  supportedAuth: {
    easyconnect: ['password', 'otp', 'image', 'sms'],
    atrust: ['auth/psw', 'auth/smsCheckCode', 'otp', 'image'],
    softether: ['auth/psw', 'softether/radius'],
  },
  udp: false,
  verification: {
    easyconnect: 'NOT_RUN_REAL_GATEWAY',
    atrust: 'NOT_RUN_REAL_GATEWAY',
    softether: 'NOT_RUN_REAL_GATEWAY',
    tun: 'NOT_RUN_REAL_WINDOWS',
  },
  license: 'AGPL-3.0',
  releaseLicenseDecision: 'PENDING',
};
fs.writeFileSync(
  path.join(bin, 'vpn-core-manifest.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(
  JSON.stringify(
    {
      binary: 'bin/bluewing-vpn-core.exe',
      sha256: manifest.sha256,
      sourceSha256,
    },
    null,
    2,
  ),
);
