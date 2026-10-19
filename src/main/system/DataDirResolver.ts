import fs from 'fs';
import path from 'path';

/**
 * 数据目录解析与一次性迁移(应用启动最早期调用,早于 Database/LogManager 初始化)。
 *
 * 规则(按序):
 * 0. 便携模式显式粘滞:仅当安装目录 data/ 存在 .portable-mode 标记,或本次为
 *    非提权运行且目录真实可写时,才选择便携目录。提权运行绝不由"目录变得可写"
 *    改变数据归属——管理员令牌让 Program Files 可写只是副作用,普通权限下次启动
 *    又不可写;若据此切换数据目录,应用会在两份数据间脑裂(实测:以管理员重启后
 *    应用切到安装器暂存在安装目录的旧数据,界面整体回到旧配置、TUN/节点全不对)。
 * 1. 有标记 → 便携(换装前向迁移/长期便携已写入标记,提权与否都稳定)。
 * 2. 无标记 + 提权运行 → 一律回退 %APPDATA%;若回退目录无数据而安装目录有
 *    (标记机制引入前的老便携用户提权运行),按搁浅恢复把用户数据拷到 %APPDATA%
 *    接续,绝不展示空应用。
 * 3. 无标记 + 非提权 + 可写 → 便携:全新自定义目录安装直接落位;换装场景
 *    (本地无库而 %APPDATA% 有数据)整目录前向迁移(含 Chromium 用户资料)并删除
 *    %APPDATA% 源目录;选择便携时写入标记,此后提权运行也稳定便携。
 * 4. 无标记 + 非提权 + 不可写(如 per-machine 装在 Program Files)→ 回退
 *    %APPDATA%;安装器还原到安装目录的旧数据按搁浅恢复(数据库/回退/核心配置/
 *    规则缓存/日志)迁移接续,Chromium 缓存类可再生目录不搬。
 */
export interface DataDirResult {
  dir: string;
  /** 本次启动是否执行了数据迁移 */
  migrated: boolean;
}

const PORTABLE_MARKER = '.portable-mode';

function hasDatabase(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'bluewing.json'));
  } catch {
    return false;
  }
}

function hasPortableMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, PORTABLE_MARKER));
  } catch {
    return false;
  }
}

function writePortableMarker(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, PORTABLE_MARKER), 'portable data home\n');
  } catch {
    // 标记写失败不阻断:下次非提权运行会再写
  }
}

function copyIfExists(src: string, dest: string, file: string): void {
  const s = path.join(src, file);
  const d = path.join(dest, file);
  if (fs.existsSync(s) && !fs.existsSync(d)) {
    fs.copyFileSync(s, d);
  }
}

function copyTreeIfExists(src: string, dest: string, sub: string): void {
  const s = path.join(src, sub);
  const d = path.join(dest, sub);
  if (!fs.existsSync(s) || fs.existsSync(d)) return;
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.cpSync(s, d, { recursive: true });
}

/** 搁浅恢复:把安装目录 data/ 里的用户数据(不含可再生缓存)拷到回退目录,数据库写入成功才算完成 */
function strandingRecovery(portableDataDir: string, fallbackDataDir: string): boolean {
  copyIfExists(portableDataDir, fallbackDataDir, 'bluewing.json');
  copyIfExists(portableDataDir, fallbackDataDir, 'bluewing.json.bak');
  copyIfExists(portableDataDir, fallbackDataDir, 'config.json');
  copyTreeIfExists(portableDataDir, fallbackDataDir, 'rules');
  copyTreeIfExists(portableDataDir, fallbackDataDir, 'logs');
  return hasDatabase(fallbackDataDir);
}

export function resolveDataDir(
  portableDataDir: string,
  fallbackDataDir: string,
  canWrite?: (dir: string) => boolean,
  isElevated?: boolean
): DataDirResult {
  const writable =
    canWrite ??
    ((dir: string) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
      } catch {
        return false;
      }
    });
  const elevated = isElevated ?? false;

  const fallbackHasData = hasDatabase(fallbackDataDir);
  const portableHasData = hasDatabase(portableDataDir);

  // 1. 标记粘滞:此前已明确选择便携模式(换装迁移/长期便携),提权与否都稳定
  if (hasPortableMarker(portableDataDir) && portableHasData) {
    return { dir: portableDataDir, migrated: false };
  }

  // 2. 提权运行:不由临时可写性改变数据归属,一律回退 %APPDATA%
  if (elevated) {
    fs.mkdirSync(fallbackDataDir, { recursive: true });
    if (!fallbackHasData && portableHasData && strandingRecovery(portableDataDir, fallbackDataDir)) {
      return { dir: fallbackDataDir, migrated: true };
    }
    return { dir: fallbackDataDir, migrated: false };
  }

  // 3. 非提权 + 可写 → 便携(全新落位或换装前向迁移),写入标记
  if (writable(portableDataDir)) {
    if (!portableHasData && fallbackHasData) {
      // 前向迁移:整目录搬迁到安装目录 data/(含 Chromium 用户资料,保留登录态),
      // 成功后删除 %APPDATA% 原目录;任一步失败则沿用 %APPDATA%,绝不丢数据
      try {
        fs.cpSync(fallbackDataDir, portableDataDir, { recursive: true });
        if (hasDatabase(portableDataDir)) {
          fs.rmSync(fallbackDataDir, { recursive: true, force: true });
          writePortableMarker(portableDataDir);
          return { dir: portableDataDir, migrated: true };
        }
      } catch {
        // 迁移失败:沿用 %APPDATA%
      }
      return { dir: fallbackDataDir, migrated: false };
    }
    writePortableMarker(portableDataDir);
    return { dir: portableDataDir, migrated: false };
  }

  // 4. 安装目录不可写:回退 %APPDATA%(安装器还原的旧数据按搁浅恢复接续)
  fs.mkdirSync(fallbackDataDir, { recursive: true });
  if (!fallbackHasData && portableHasData && strandingRecovery(portableDataDir, fallbackDataDir)) {
    return { dir: fallbackDataDir, migrated: true };
  }
  return { dir: fallbackDataDir, migrated: false };
}
