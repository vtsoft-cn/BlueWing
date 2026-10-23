const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const electronDist =
  process.env.BLUEWING_ELECTRON_DIST ||
  path.join(root, 'work', 'corporate-vpn-tools', 'electron-runtime', 'dist');
if (!fs.existsSync(path.join(electronDist, 'electron.exe')))
  throw new Error(
    'Set BLUEWING_ELECTRON_DIST to the verified Electron 44.8.0 distribution.',
  );
const output = path.join(root, 'release-vpn-preview');
if (!process.argv.includes('--refresh-archive')) execFileSync(
  process.execPath,
  [
    require.resolve('electron-builder/out/cli/cli.js'),
    '--dir',
    `--config.electronDist=${electronDist}`,
    '--config.electronVersion=44.8.0',
    `--config.directories.output=${output}`,
    '--config.npmRebuild=false',
    '--config.win.signAndEditExecutable=false',
  ],
  { cwd: root, windowsHide: true, stdio: 'inherit' },
);
fs.writeFileSync(
  path.join(output, 'start-preview.cmd'),
  '@echo off\r\nsetlocal\r\nset "BLUEWING_DATA_DIR=%LOCALAPPDATA%\\BlueWingConnect-VpnPreview"\r\nstart "" "%~dp0win-unpacked\\BlueWing Connect.exe"\r\n',
);
fs.writeFileSync(
  path.join(output, 'README.txt'),
  [
    'BlueWing VPN 接入开发测试版', '',
    '请先退出旧版 BlueWing，再运行 start-preview.cmd。',
    '启动器使用独立数据目录 %LOCALAPPDATA%\\BlueWingConnect-VpnPreview，兼容之前测试版的配置。',
    '首次使用时，在旧版导出 Windows 备份，再到测试版导入，恢复公网节点和分流配置。',
    '打开「VPN 接入」，点击「新增接入」选择协议，填写网关、端口和账号。',
    'aTrust 可点击「保存并获取认证方式」，选择登录方式后保存。',
    '首次保存后点击「应用分流」，公网会短暂重连；随后在连接面板输入密码并连接。',
    '修改域名、IP 和固定解析：编辑接入 → 分流范围。',
    '证书或物理网卡设置：编辑接入 → 高级选项。证书指纹需独立核对后使用。',
    '浏览器可用系统代理；无参数 curl 和 SSH 需要在首页按现有流程启用 TUN。',
    '当前支持 IPv4 TCP；外部 UDP、ICMP、IPv6 隧道和 CAS/OAuth 未开放。',
    '真实账号登录、Windows TUN、资源访问和公网并行使用仍需实机验收。',
    '这是内部开发测试构建，未签名；发布前还需完成集成产品的许可证决策。', '',
  ].join('\r\n'),
);
const archive = path.join(
  root,
  'release-vpn-preview',
  'BlueWing-Corporate-VPN-Preview.zip',
);
execFileSync(
  'tar.exe',
  [
    '-a',
    '-cf',
    archive,
    '-C',
    output,
    'win-unpacked',
    'start-preview.cmd',
    'README.txt',
  ],
  { windowsHide: true, stdio: 'inherit' },
);
console.log(
  JSON.stringify(
    { archive, launcher: path.join(output, 'start-preview.cmd') },
    null,
    2,
  ),
);
