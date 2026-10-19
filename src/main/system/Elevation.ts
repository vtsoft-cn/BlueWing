import { execSync } from 'child_process';

/**
 * 当前进程是否以管理员(提权令牌)运行。
 * 独立最小模块:数据目录解析在应用启动最早期调用,不得牵扯核心/数据库依赖。
 */
export function isRunningAsAdmin(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
