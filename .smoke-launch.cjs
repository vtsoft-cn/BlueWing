// 烟测启动器:绕过单实例锁的命令行标记方式不可用,改用 --bb-shutdown 冲突检查:
// 直接 spawn electron,传 isolated userData 的等价环境变量
const { spawn } = require('child_process');
const proc = spawn(
  require('path').join(process.cwd(), 'node_modules', '.bin', 'electron.cmd'),
  ['.'],
  {
    env: {
      ...process.env,
      BLUEWING_DATA_DIR: process.env.TEMP + '\bw-smoke-' + Date.now(),
      VITE_DEV_SERVER_URL: 'http://localhost:5227/',
    },
    stdio: 'ignore',
    detached: false,
  }
);
proc.unref();
setTimeout(() => process.exit(0), 2000);
