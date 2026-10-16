import path from 'path';
import fs from 'fs';

/**
 * 品牌图标定位。源文件即 src/images(开发),打包后位于 resources/images;
 * 按扩展名进入 ico/ 或 png/ 子目录直接引用,不再经构建期分发或改名。
 */

export function resourcePath(file: string): string | null {
  const sub = file.toLowerCase().endsWith('.ico') ? 'ico' : 'png';
  const dirs = [
    process.resourcesPath ? path.join(process.resourcesPath, 'images', sub) : '',
    process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'images', sub) : '',
    path.join(process.cwd(), 'src', 'images', sub),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 托盘图标(.png):随代理状态切换,连接 on.png / 断开 off.png(不随主题) */
export function trayIconPath(proxyOn: boolean): string | null {
  return resourcePath(proxyOn ? 'on.png' : 'off.png');
}
