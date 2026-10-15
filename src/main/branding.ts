import path from 'path';
import fs from 'fs';

/**
 * 品牌图标定位。资源位于 resources/bin/(打包)或 <cwd>/bin(开发)。
 * 不再区分 on/off 状态变体:
 * - 界面 Logo(SVG)仅随主题切换 → dark.svg / light.svg
 * - 任务栏与托盘图标随代理状态切换 → 开启代理 = light,关闭 = dark
 */
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

/** 任务栏窗口图标(.ico):开启代理 → light,关闭 → dark */
export function windowIconPath(proxyOn: boolean): string | null {
  return resourcePath(`${proxyOn ? 'light' : 'dark'}.ico`);
}

/** 托盘图标(.png):开启代理 → light,关闭 → dark */
export function trayIconPath(proxyOn: boolean): string | null {
  return resourcePath(`${proxyOn ? 'light' : 'dark'}.png`);
}
