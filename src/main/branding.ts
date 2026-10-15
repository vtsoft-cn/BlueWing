import path from 'path';
import fs from 'fs';

/**
 * 状态图标定位:文件名 = {on|off}-{light|dark}.ico / .png
 * core 已连接且系统代理开启 → on;否则 → off
 * 深浅色变体跟随界面主题
 * 资源位于 resources/bin/(打包)或 <cwd>/bin(开发)
 */
export function stateIconPath(on: boolean, dark: boolean): string | null {
  return locate(`${on ? 'on' : 'off'}-${dark ? 'dark' : 'light'}.ico`);
}

export function stateTrayPng(on: boolean, dark: boolean): string | null {
  return locate(`${on ? 'on' : 'off'}-${dark ? 'dark' : 'light'}.png`);
}

function locate(file: string): string | null {
  const dirs = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : '',
    process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'bin') : '',
    path.join(process.cwd(), 'bin'),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
