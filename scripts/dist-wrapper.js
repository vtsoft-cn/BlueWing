// electron-builder 打包包装:Windows 下"解压 electron 发行包 → rename 暂存目录"之间零等待,
// Defender 实时扫描刚写入的 electron.exe(约 170MB)会短暂持有目录句柄,单次 rename 以
// EPERM 确定性失败(本机实测连续 5 次全败,进程退出句柄释放后手动改名即成)。
// 此处在加载 electron-builder CLI 之前,给 fs/promises.rename 与 fs.rename 包一层
// EPERM/EBUSY/ENOTEMPTY 退避重试,实测约 2.4 秒 / 6 次内稳定通过。
// 注:app-builder-lib(26.15.3)extractArchive 在 proper-lockfile 持锁状态下 rename,
// 但其锁文件为暂存目录的兄弟项(<dir>.lock),并不阻塞改名,故保留原锁行为不动。
const path = require('path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const MAX_ATTEMPTS = 40;

const fsp = require('fs/promises');
const origRename = fsp.rename.bind(fsp);
fsp.rename = async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await origRename(from, to);
    } catch (err) {
      if (RETRY_CODES.has(err.code) && attempt < MAX_ATTEMPTS) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[dist-wrapper] rename 重试 ${to} (${err.code} 第 ${attempt} 次)`);
        }
        await new Promise((r) => setTimeout(r, Math.min(400 * attempt, 2000)));
        continue;
      }
      throw err;
    }
  }
};

const fs = require('fs');
const origRenameCb = fs.rename.bind(fs);
fs.rename = function renameWithRetryCb(from, to, cb) {
  let attempt = 0;
  const tryIt = () =>
    origRenameCb(from, to, (err) => {
      if (err && RETRY_CODES.has(err.code) && attempt++ < MAX_ATTEMPTS) {
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[dist-wrapper] rename 重试 ${to} (${err.code} 第 ${attempt} 次)`);
        }
        return setTimeout(tryIt, Math.min(400 * attempt, 2000));
      }
      cb(err);
    });
  tryIt();
};

// 透传命令行参数给 electron-builder CLI(占位 argv[1] 供 yargs 解析)
process.argv = [process.argv[0], 'electron-builder', ...process.argv.slice(2)];
require(path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js'));
