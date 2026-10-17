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
  // 兼容更名前的旧数据文件名,构建保全期间两者都认
  const db = ['bluewing.json']
    .map((f) => path.join(dir, f))
    .find((p) => fs.existsSync(p));
  if (!db) return false;
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
  // electron-builder 的 winCodeSign 缓存:只有当上次解压不完整(缺 rcedit-x64.exe,会导致
  // rename 提交必败 "Unable to commit changes")时才清理;完整缓存保留,避免每次构建
  // 都强制重新从 GitHub 下载(网络不通时构建直接失败)
  const winCodeSignDir = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign',
    'winCodeSign-2.6.0'
  );
  try {
    const rcedit = path.join(winCodeSignDir, 'rcedit-x64.exe');
    if (fs.existsSync(winCodeSignDir) && !fs.existsSync(rcedit)) {
      fs.rmSync(winCodeSignDir, { recursive: true, force: true });
      console.log('[preserve-data] 已清理不完整的 winCodeSign 缓存(避免 rename 撞车)');
    }
  } catch {}

  if (fs.existsSync(src) && hasUserData(src)) {
    copyDir(src, keep);
    console.log('[preserve-data] 已备份便携数据 → .data-preserve(仓库根)');
  } else {
    console.log('[preserve-data] 无有效便携数据需要备份');
  }
} else if (mode === 'restore') {
  if (!fs.existsSync(src) || !hasUserData(src)) {
    if (fs.existsSync(keep)) {
      copyDir(keep, src);
      // 一次性消费:还原成功即删除备份。否则用户此后主动清空数据时,
      // 下次构建 restore 又会把这份过期备份"复活"回去,与用户删除意图相悖。
      // 若构建中途崩溃(已清 data 未走到还原),备份未消费、保留给下次构建兜底。
      try {
        fs.rmSync(keep, { recursive: true, force: true });
      } catch {}
      console.log('[preserve-data] 构建清空了 data/,已从备份还原(备份已消费)');
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
