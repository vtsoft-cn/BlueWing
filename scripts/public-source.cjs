// A fresh source snapshot, never Git history, installed binaries or user data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).split('\0').filter(Boolean);
const allowedRoot = /^(src|native|scripts|build|docs|LICENSES|\.github)\//;
const allowedFile = /^(README\.md|ARCHITECTURE\.md|CHANGELOG\.md|LICENSE|COPYRIGHT\.md|THIRD_PARTY_NOTICES\.md|PRIVACY\.md|SECURITY\.md|PUBLIC_RELEASE_CHECKLIST\.md|PUBLIC_RELEASE_MATERIALS\.json|package(?:-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.ts|postcss\.config\.[cm]?js|tailwind\.config\.js|\.gitignore)$/;
const excluded = /(^|\/)(\.git|node_modules|\.cache|data|logs|snapshots|\.env[^/]*)(\/|$)|\.(exe|dll|zip|srs|pfx|p12|key|log|bluewingbackup)$/i;
const staging = fs.mkdtempSync(path.join(os.tmpdir(),'bluewing-public-source-'));
try {
  let count = 0;
  for (const file of [...new Set(files)].sort()) {
    if ((!allowedRoot.test(file) && !allowedFile.test(file)) || excluded.test(file)) continue;
    const from = path.join(root,file);
    if (!fs.existsSync(from)) continue;
    if (!fs.lstatSync(from).isFile()) throw new Error('Source snapshot refuses links/non-files: '+file);
    const to = path.join(staging,file); fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to); count++;
  }
  fs.writeFileSync(path.join(staging,'SOURCE_SNAPSHOT.md'),'# 源码快照\n\n不含私有 Git 历史、运行数据或 bin/ 第三方运行文件。源码和第三方许可证保留。\n完整运行版还需维护核心构建和已核对授权的运行库、规则。见 README.md、THIRD_PARTY_NOTICES.md 和 PUBLIC_RELEASE_CHECKLIST.md。\n');
  const output = path.join(root,'release-public-source'); fs.mkdirSync(output,{recursive:true});
  const archive = path.join(output,'BlueWing-source.zip');
  execFileSync('tar.exe',['-a','-cf',archive,'-C',staging,'.'],{windowsHide:true,stdio:'inherit'});
  console.log(JSON.stringify({archive,files:count,historyIncluded:false,runtimeBinariesIncluded:false},null,2));
} finally { fs.rmSync(staging,{recursive:true,force:true}); }
