const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  tools = path.join(root, 'work', 'corporate-vpn-tools'),
  local = path.join(tools, 'toolchain', 'go', 'bin', 'go.exe'),
  go = process.env.GO_BINARY || (fs.existsSync(local) ? local : 'go');
const result = spawnSync(
  go,
  [
    'test',
    '-buildvcs=false',
    ...process.argv.slice(2),
    './cmd/bluewing-vpn-core',
    './internal/bluewing',
    './internal/winproxy',
    './client/easyconnect/...',
    './client/atrust/...',
    './client/softether/...',
    './underlay',
    './stack/gvisor',
  ],
  {
    cwd: path.join(root, 'native', 'vpn'),
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      GOTOOLCHAIN: 'local',
      GOPATH: process.env.GOPATH || path.join(tools, 'gopath'),
      GOCACHE: process.env.GOCACHE || path.join(tools, 'gocache'),
    },
  },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
