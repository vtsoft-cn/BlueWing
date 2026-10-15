// 构建前后保全便携数据目录:electron-builder 每次都会重建 win-unpacked,
// 会把用户数据(exe 同级 data/)一并清掉。用法:
//   node scripts/preserve-data.js backup  → 构建前,把 win-unpacked/data 备份到仓库根 .data-preserve(在构建输出之外,不会被清掉)
//   node scripts/preserve-data.js restore → 构建后,若 data 丢失/为空则从备份还原
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'release', 'win-unpacked', 'data');
// 保全目录必须放在构建输出目录(release)之外,否则会随构建一起被清空
const keep = path.join(root, '.data-preserve');

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true });
}

function hasUserData(dir) {
  const db = path.join(dir, 'ownbox.json');
  if (!fs.existsSync(db)) return false;
  try {
    const d = JSON.parse(fs.readFileSync(db, 'utf8'));
    // 空库(全默认)不算有效数据,避免空状态反向覆盖
    return (d.nodes || []).length > 0 || (d.subscriptions || []).length > 0 || (d.settings && d.settings.customBypassList);
  } catch {
    return false;
  }
}

const mode = process.argv[2];

if (mode === 'backup') {
  // electron-builder 的 winCodeSign 缓存:已存在的提交目录会让下次构建的 rename 提交必败
  // ("Unable to commit changes"),构建前清掉,让其走全新下载→解压→提交流程
  const winCodeSignDir = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
    'winCodeSign-2.6.0'
  );
  try {
    if (fs.existsSync(winCodeSignDir)) {
      fs.rmSync(winCodeSignDir, { recursive: true, force: true });
      console.log('[preserve-data] 已清理 winCodeSign 提交缓存(避免 rename 撞车)');
    }
  } catch {}

  if (fs.existsSync(src) && hasUserData(src)) {
    copyDir(src, keep);
    console.log('[preserve-data] 已备份便携数据 → release/.data-preserve');
  } else {
    console.log('[preserve-data] 无有效便携数据需要备份');
  }
} else if (mode === 'restore') {
  if (!fs.existsSync(src) || !hasUserData(src)) {
    if (fs.existsSync(keep)) {
      copyDir(keep, src);
      console.log('[preserve-data] 构建清空了 data/,已从备份还原');
    } else {
      console.log('[preserve-data] 无备份可还原');
    }
  } else {
    console.log('[preserve-data] data/ 完好,无需还原');
  }
} else {
  console.error('usage: node preserve-data.js backup|restore');
  process.exit(1);
}
