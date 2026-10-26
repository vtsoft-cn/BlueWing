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
const output = path.resolve(
  root,
  process.env.BLUEWING_PREVIEW_OUTPUT || 'release-vpn-preview',
);
if (
  !output.toLowerCase().startsWith((root + path.sep).toLowerCase()) ||
  !path.basename(output).startsWith('release-')
)
  throw new Error(
    'Preview output must be a release-* directory inside the workspace.',
  );
if (!process.argv.includes('--refresh-archive'))
  execFileSync(
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
    'BlueWing VPN 接入开发测试版',
    '',
    '请先退出旧版 BlueWing，再运行 start-preview.cmd。',
    '启动器使用独立数据目录 %LOCALAPPDATA%\\BlueWingConnect-VpnPreview，兼容之前测试版的配置。',
    '需要原有代理时，可导入旧版 Windows 备份；单独使用 VPN 接入无需导入节点或订阅。',
    '无节点时，首页点击「启动直连分流」；也可保存 VPN 后点击「应用分流」启动，再连接 VPN。',
    '已有节点但希望普通公网直连：在「路由」选择「全局直连」，公司资源仍走当前 VPN，原节点配置保留。',
    '首页点击当前网络出口，或在「节点」页选择「本机直连（无需节点）」；保留节点也能直连。',
    '需要公网代理时选择任一代理节点，自动恢复规则分流；仅添加节点不改变当前直连选择。',
    '删除最后节点会保留本地分流入口并切换直连；出口变化会重载路由和 DNS，现有公网连接可能短暂重连。',
    '打开「VPN 接入」，点击「新增接入」选择协议，填写网关、端口和账号。',
    'aTrust 可点击「保存并获取认证方式」，选择登录方式后保存。',
    '首次保存后点击「应用分流」，公网会短暂重连；随后在连接面板输入密码并连接。',
    '每条 VPN 接入均有「高级分流」入口，用户可选填域名、IP/网段和固定解析，只保存到当前接入。',
    '用户补充规则优先于服务器资源、国内/LAN/应用规则；固定解析由用户配置覆盖服务器记录；明确阻止规则最高。',
    '默认自动处理证书：首次对未受信任的网关证书绑定指纹，后续检测变化。',
    '已记录指纹发生变化、证书过期或系统时间异常时停止连接并提示。',
    '连接面板可勾选「加密记住密码」，也可先保存密码再连接；验证码不保存。',
    '连接设置也可输入密码，点击「保存配置」一起加密保存；连接期间所有配置可打开只读查看。',
    '验证码可点「稍后填写」或 Escape 收起，再点击「继续填写验证码」恢复；收起保留本轮期限。',
    '取消连接后重新连接，使用新验证码请求的期限重新计时，不沿用上一轮输入和超时任务。',
    '「VPN 接入 → 应用代理」显示当前 SOCKS5 地址和端口，可分别复制到 Xshell；端口随设置更新。',
    '手动证书或物理网卡设置：编辑接入 → 高级选项。',
    '浏览器可用系统代理；Xshell 可配置以上 SOCKS5；无代理参数的程序需要在首页启用 TUN。',
    '当前支持 IPv4 TCP；外部 UDP、ICMP、IPv6 隧道和 CAS/OAuth 未开放。',
    '真实账号登录、Windows TUN、资源访问和公网并行使用仍需实机验收。',
    '这是内部开发测试构建，未签名；发布前还需完成集成产品的许可证决策。',
    '',
  ].join('\r\n'),
);
const archive = path.join(output, 'BlueWing-VPN-Access-Preview.zip');
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
