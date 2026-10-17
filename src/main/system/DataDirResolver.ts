import fs from 'fs';
import path from 'path';

/**
 * 数据目录解析与一次性迁移(应用启动最早期调用,早于 Database/LogManager 初始化)。
 *
 * 规则(按序):
 * 1. 便携优先:安装目录同级 data/ 可写即用之;
 *    前向迁移:可写但本地无数据库而 %APPDATA% 已有数据(从 Program Files 换装到
 *    其它位置的 reinstall)→ 把 %APPDATA% 整目录(含 Chromium 用户资料)迁到本地
 *    data/ 并删除 %APPDATA% 原目录,数据跟着安装位置走、不留副本;迁移失败则
 *    沿用 %APPDATA%(不丢数据);
 * 2. 不可写(如 per-machine 装在 Program Files)→ 回退 %APPDATA%;
 *    接续修正(数据搁浅修复):回退目录无数据库而安装目录 data/ 里有(安装器把旧数据
 *    还原到了新安装目录,但普通权限读不到也不可写)→ 把用户数据迁移到 %APPDATA%,
 *    配置接续不断;安装目录内残留副本普通权限删不动,留置无害。
 * 3. 迁移内容为用户数据(数据库/回退/核心配置/规则缓存/日志),Chromium 缓存类
 *    目录可再生,搁浅方向不搬;前向迁移整目录搬迁(保留登录态等资料)。
 */
export interface DataDirResult {
  dir: string;
  /** 本次启动是否执行了数据迁移 */
  migrated: boolean;
}

function hasDatabase(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, 'bluewing.json'));
  } catch {
    return false;
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

export function resolveDataDir(
  portableDataDir: string,
  fallbackDataDir: string,
  canWrite?: (dir: string) => boolean
): DataDirResult {
  const writable = canWrite ?? ((dir: string) => {
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

  const fallbackHasData = hasDatabase(fallbackDataDir);

  if (writable(portableDataDir)) {
    if (!hasDatabase(portableDataDir) && fallbackHasData) {
      // 前向迁移:整目录搬迁到安装目录 data/(含 Chromium 用户资料,保留登录态),
      // 成功后删除 %APPDATA% 原目录;任一步失败则沿用 %APPDATA%,绝不丢数据
      try {
        fs.cpSync(fallbackDataDir, portableDataDir, { recursive: true });
        if (hasDatabase(portableDataDir)) {
          fs.rmSync(fallbackDataDir, { recursive: true, force: true });
          return { dir: portableDataDir, migrated: true };
        }
      } catch {
        // 迁移失败:沿用 %APPDATA%
      }
      return { dir: fallbackDataDir, migrated: false };
    }
    return { dir: portableDataDir, migrated: false };
  }

  // 安装目录不可写:回退 %APPDATA%
  fs.mkdirSync(fallbackDataDir, { recursive: true });
  if (!fallbackHasData && hasDatabase(portableDataDir)) {
    // 数据搁浅:安装器还原到安装目录的旧数据迁移到 %APPDATA%(数据库写入成功才视为迁移完成)
    copyIfExists(portableDataDir, fallbackDataDir, 'bluewing.json');
    copyIfExists(portableDataDir, fallbackDataDir, 'bluewing.json.bak');
    copyIfExists(portableDataDir, fallbackDataDir, 'config.json');
    copyTreeIfExists(portableDataDir, fallbackDataDir, 'rules');
    copyTreeIfExists(portableDataDir, fallbackDataDir, 'logs');
    if (hasDatabase(fallbackDataDir)) {
      return { dir: fallbackDataDir, migrated: true };
    }
  }
  return { dir: fallbackDataDir, migrated: false };
}
