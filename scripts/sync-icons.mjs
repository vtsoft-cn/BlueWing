// 图标分发:src/images 是唯一图标源(现成 png/ico 母本,无任何转换/缩放)。
// 每次构建前执行,把源文件原样分发到运行时位置;素材缺失时直接失败终止构建。
//
// 分发:
//   src/images/ico/app-{dark|light}-{on|off}.ico   → bin/app-*.ico    窗口/任务栏图标
//   src/images/ico/app-light-off.ico               → bin/icon.ico     应用主身份(安装器/exe/托盘兜底)
//   src/images/png/menu-{dark|light}-{on|off}.png  → bin/tray-*.png   托盘图标
//   界面 Logo:渲染层直接引用 src/images/png/app-*-off.png(Sidebar/About),不经本脚本
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SRC = path.join(root, 'src', 'images', 'ico');
const PNG_SRC = path.join(root, 'src', 'images', 'png');
const BIN = path.join(root, 'bin');
const THEMES = ['dark', 'light'];
const STATES = ['on', 'off'];

const mustExist = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`[sync-icons] 缺少素材: ${p}`);
    process.exit(1);
  }
};

for (const theme of THEMES) {
  for (const state of STATES) {
    const appIco = path.join(ICO_SRC, `app-${theme}-${state}.ico`);
    mustExist(appIco);
    fs.copyFileSync(appIco, path.join(BIN, `app-${theme}-${state}.ico`));

    const menuPng = path.join(PNG_SRC, `menu-${theme}-${state}.png`);
    mustExist(menuPng);
    fs.copyFileSync(menuPng, path.join(BIN, `tray-${theme}-${state}.png`));
  }
}

// 应用主身份图标固定取 light-off
fs.copyFileSync(path.join(ICO_SRC, 'app-light-off.ico'), path.join(BIN, 'icon.ico'));

console.log('[sync-icons] 已从 src/images 直接分发 → bin/app-*.ico ×4 + bin/tray-*.png ×4 + bin/icon.ico');
