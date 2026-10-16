// 图标源同步:src/icon 是唯一图标事实来源(主题 × 代理状态四变体)。
// 每次构建前执行,重新生成 bin/ 下全部图标派生物,防止改了源目录却忘同步;
// 素材缺失时直接失败终止构建。
//
// 产物:
//   bin/app-{dark|light}-{on|off}.ico   多尺寸(16~256),窗口/任务栏图标,随主题+状态
//   bin/tray-{dark|light}-{on|off}.png  256px,托盘图标,由 menu-* 圆形图标分发
//   bin/icon.ico                        应用主身份图标(安装器/exe),固定 light-off
//   src/renderer/assets/{dark,light}.png 界面 Logo(256px,取 off 中性版,仅随主题)
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_SRC = path.join(root, 'src', 'icon');
const BIN = path.join(root, 'bin');
const ASSETS = path.join(root, 'src', 'renderer', 'assets');
const THEMES = ['dark', 'light'];
const STATES = ['on', 'off'];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

const mustExist = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`[sync-icons] 缺少素材: ${p}`);
    process.exit(1);
  }
};

/** 用 PowerShell System.Drawing 把 1024 母图缩放出尺寸梯(HighQualityBicubic) */
function buildLadder(srcPng, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const src = srcPng.replace(/\\/g, '/');
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    ...ICO_SIZES.map((s) => {
      const out = path.join(outDir, `icon_${s}x${s}.png`).replace(/\\/g, '/');
      return `
    $src = [System.Drawing.Image]::FromFile('${src}');
    $bmp = New-Object System.Drawing.Bitmap(${s}, ${s});
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
    $g.DrawImage($src, 0, 0, ${s}, ${s});
    $g.Dispose(); $src.Dispose();
    $bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);
    $bmp.Dispose();`;
    }),
  ].join('');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

/** 单尺寸缩放(PowerShell System.Drawing,HighQualityBicubic) */
function resizePng(srcPng, outPng, size) {
  const src = srcPng.replace(/\\/g, '/');
  const out = outPng.replace(/\\/g, '/');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Drawing;
    $src = [System.Drawing.Image]::FromFile('${src}');
    $bmp = New-Object System.Drawing.Bitmap(${size}, ${size});
    $g = [System.Drawing.Graphics]::FromImage($bmp);
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;
    $g.DrawImage($src, 0, 0, ${size}, ${size});
    $g.Dispose(); $src.Dispose();
    $bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png);
    $bmp.Dispose();`,
    ],
    { stdio: 'ignore' }
  );
}

/** 将 PNG 尺寸梯合并为多尺寸 ICO(PNG 帧嵌入) */
function buildIco(ladderDir, outFile) {
  const frames = ICO_SIZES.map((s) => {
    const p = path.join(ladderDir, `icon_${s}x${s}.png`);
    mustExist(p);
    return { size: s, data: fs.readFileSync(p) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = [];
  const blobs = [];
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(f.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(f.data);
    offset += f.data.length;
  }
  fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...blobs]));
}

const ladderCache = path.join(root, 'temp', 'icon-ladder');
fs.rmSync(ladderCache, { recursive: true, force: true });

for (const theme of THEMES) {
  for (const state of STATES) {
    // 窗口图标:1024 母图 → 尺寸梯 → 多尺寸 ICO
    const appPng = path.join(ICON_SRC, `app-${theme}-${state}.png`);
    mustExist(appPng);
    const ladder = path.join(ladderCache, `app-${theme}-${state}`);
    buildLadder(appPng, ladder);
    buildIco(ladder, path.join(BIN, `app-${theme}-${state}.ico`));

    // 托盘图标:menu 圆形母图(256px)直接分发
    const menuPng = path.join(ICON_SRC, `menu-${theme}-${state}.png`);
    mustExist(menuPng);
    fs.copyFileSync(menuPng, path.join(BIN, `tray-${theme}-${state}.png`));
  }

  // 界面 Logo:取 off 中性版缩放为 256px PNG(仅随主题,不带状态环)
  const logoSrc = path.join(ICON_SRC, `app-${theme}-off.png`);
  mustExist(logoSrc);
  resizePng(logoSrc, path.join(ASSETS, `${theme}.png`), 256);
}

// 应用主身份图标固定取 light-off;清理旧命名模型的历史产物
fs.copyFileSync(path.join(BIN, 'app-light-off.ico'), path.join(BIN, 'icon.ico'));
for (const stale of ['dark.ico', 'light.ico', 'dark.png', 'light.png']) {
  fs.rmSync(path.join(BIN, stale), { force: true });
}
for (const stale of ['dark.svg', 'light.svg']) {
  fs.rmSync(path.join(ASSETS, stale), { force: true });
}

console.log('[sync-icons] 已从 src/icon 同步 → bin/app-*.{ico} ×4 + bin/tray-*.png ×4 + bin/icon.ico + 界面 Logo PNG ×2');
