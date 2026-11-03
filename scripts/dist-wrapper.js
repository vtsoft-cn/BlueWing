// electron-builder 打包包装:
// 1) Windows 下"解压 electron 发行包 → rename 暂存目录"之间零等待,Defender 实时
//    扫描刚写入的 electron.exe(约 170MB)会短暂持有目录句柄,单次 rename 以 EPERM
//    确定性失败(本机实测连续 5 次全败)。此处先给 fs.rename 包一层 EPERM/EBUSY
//    重试再加载 electron-builder CLI,实测约 2.4 秒/6 次内通过。
//    app-builder-lib 的 proper-lockfile 锁文件为暂存目录的兄弟项(*.lock),不阻塞
//    改名,保留原锁行为。
// 2) electron-builder 26.15 NSIS 模板两处确定性缺陷,构建期打精确单行补丁
//    (锚点不匹配即报错中止,防止静默失效;npm install 后自动重打,幂等):
//    a. 安装模式页"为所有人安装 + 非管理员"时向下一步按钮发 BCM_SETSHIELD 显示
//       UAC 盾牌,但安装器无 comctl32 v6 清单,按钮按旧样式渲染,盾牌表现为
//       多余的异常图标、与文字重叠 → 改为不显示盾牌;
//    b. 提权内层实例(UAC)跳过安装模式页用 Abort;从其目录页点上一步会再次
//       触发该跳过并被一路跳过到无页可退,向导直接退出 → 跳过时同时禁用上一步。
const path = require('path');
const fsSync = require('fs');

const ROOT = path.join(__dirname, '..');
const publish = process.argv.find((arg, index) => arg === '--publish' ? process.argv[index + 1] !== 'never' : arg.startsWith('--publish=') && arg !== '--publish=never');
if (publish) {
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'release-check.cjs'), '--public'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
} else if (!process.argv.some(arg => arg === '--publish' || arg.startsWith('--publish='))) {
  process.argv.push('--publish', 'never');
}

// ---- NSIS 模板补丁(幂等,锚点失配即抛错) ----
function patchTemplates() {
  const baseDir = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
  const contents = new Map();
  const patches = [
    {
      name: '在干净模板中安装目录页 PRE/SHOW/LEAVE 钩子',
      file: 'assistedInstaller.nsh',
      find:
        '    !insertmacro skipPageIfUpdated\n' +
        '    !insertmacro MUI_PAGE_DIRECTORY',
      replace:
        '    !define MUI_PAGE_CUSTOMFUNCTION_PRE bbDirPre\n' +
        '    !define MUI_PAGE_CUSTOMFUNCTION_SHOW bbDirShow\n' +
        '    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE bbRejectRootDir\n' +
        '    !insertmacro MUI_PAGE_DIRECTORY',
    },
    {
      name: '隐藏下一步按钮的 UAC 盾牌(无 comctl6 清单时渲染破损)',
      file: 'multiUserUi.nsh',
      find: 'SendMessage $0 ${BCM_SETSHIELD} 0 1 ; display SHIELD',
      replace:
        'SendMessage $0 ${BCM_SETSHIELD} 0 0 ; patch: shield hidden (broken rendering without comctl6 manifest)',
    },
    {
      name: '提权内层实例跳过模式页时禁用上一步(否则点上一步会一路跳过并退出向导)',
      file: 'multiUserUi.nsh',
      find: '# inner Process (and Admin) - skip selection, inner process is always used for elevation (machine-wide)',
      replace:
        '# inner Process (and Admin) - skip selection, inner process is always used for elevation (machine-wide)\n' +
        '\t\t  GetDlgItem $0 $HWNDPARENT 3 ; patch: disable Back button - aborting this skipped page on back-nav exits the wizard\n' +
        '\t\t  EnableWindow $0 0',
    },
  ];
  for (const p of patches) {
    const file = path.join(baseDir, p.file);
    if (!contents.has(p.file)) {
      // 归一化行尾:模板可能被外部工具以 CRLF 写回,统一 LF 保证锚点匹配
      const normalized = fsSync.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      contents.set(p.file, normalized);
      fsSync.writeFileSync(file, normalized, 'utf8');
    }
    let src = contents.get(p.file);
    if (src.includes(p.replace)) {
      console.log(`[dist-wrapper] 模板补丁已就位:${p.name}`);
      continue;
    }
    if (!src.includes(p.find)) {
      throw new Error(`[dist-wrapper] 模板补丁锚点未找到(electron-builder 版本可能已更新,请复核):${p.name}`);
    }
    src = src.replace(p.find, p.replace);
    contents.set(p.file, src);
    fsSync.writeFileSync(file, src);
    console.log(`[dist-wrapper] 模板补丁已应用:${p.name}`);
  }
}
patchTemplates();

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
