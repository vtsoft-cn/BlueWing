import path from 'path';
import fs from 'fs';

/**
 * 品牌图标定位。资源位于 resources/bin/(打包)或 <cwd>/bin(开发)。
 * 图标语义(src/icon/Windows 设计规范):
 * - 界面 Logo(SVG)仅随主题切换
 * - 窗口/任务栏图标(app-*.ico)与托盘图标(tray-*.png)随 主题 × 代理状态 四变体切换
 */
export type IconTheme = 'dark' | 'light';

export function resourcePath(file: string): string | null {
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

/** 任务栏窗口图标(.ico):主题 × 代理状态 */
export function windowIconPath(theme: IconTheme, proxyOn: boolean): string | null {
  return resourcePath(`app-${theme}-${proxyOn ? 'on' : 'off'}.ico`);
}

/** 托盘图标(.png):主题 × 代理状态 */
export function trayIconPath(theme: IconTheme, proxyOn: boolean): string | null {
  return resourcePath(`tray-${theme}-${proxyOn ? 'on' : 'off'}.png`);
}
