// 图标源同步:src/icon/{dark,light} 是唯一图标事实来源。
// 每次构建前执行,重新生成 bin/{dark,light}.{ico,png}、bin/icon.ico 与渲染层 SVG,
// 防止改了源目录却忘同步导致打包带旧图标;素材缺失时直接失败终止构建。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_SRC = path.join(root, 'src', 'icon');
const BIN = path.join(root, 'bin');
const ASSETS = path.join(root, 'src', 'renderer', 'assets');
const VARIANTS = ['dark', 'light'];
const SIZES = [16, 32, 48, 64, 128, 256];

/** 将 PNG 尺寸梯合并为多尺寸 ICO(PNG 帧嵌入) */
function buildIco(dir) {
  const frames = SIZES.map((s) => {
    const p = path.join(dir, `icon_${s}x${s}.png`);
    if (!fs.existsSync(p)) {
      console.error(`[sync-icons] 缺少素材: ${p}`);
      process.exit(1);
    }
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
  return Buffer.concat([header, ...entries, ...blobs]);
}

for (const variant of VARIANTS) {
  const dir = path.join(ICON_SRC, variant);
  if (!fs.existsSync(dir)) {
    console.error(`[sync-icons] 缺少图标源目录: ${dir}`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(BIN, `${variant}.ico`), buildIco(dir));
  fs.copyFileSync(path.join(dir, 'icon_32x32.png'), path.join(BIN, `${variant}.png`));

  const svg = path.join(dir, `${variant}.svg`);
  if (!fs.existsSync(svg)) {
    console.error(`[sync-icons] 缺少素材: ${svg}`);
    process.exit(1);
  }
  fs.copyFileSync(svg, path.join(ASSETS, `${variant}.svg`));
}

// 应用主图标(installer/exe 默认身份)固定取 light 变体
fs.copyFileSync(path.join(BIN, 'light.ico'), path.join(BIN, 'icon.ico'));

console.log(
  '[sync-icons] 已从 src/icon 同步 → bin/{dark,light}.ico/.png + bin/icon.ico + src/renderer/assets/{dark,light}.svg'
);
