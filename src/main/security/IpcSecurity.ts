import type { BrowserWindow, IpcMain } from 'electron';

export function assertIpcData(args: unknown[]): void {
  let size = 0, entries = 0;
  const visit = (item: unknown, depth: number) => {
    if (++entries > 500000 || depth > 32) throw new Error('IPC 参数过于复杂');
    if (typeof item === 'string') size += Buffer.byteLength(item);
    else if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('IPC 数值无效');
    else if (item && typeof item === 'object') {
      for (const [key, value] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('IPC 字段无效');
        size += key.length; visit(value, depth + 1);
      }
    } else if (typeof item === 'function' || typeof item === 'symbol') throw new Error('IPC 参数类型无效');
    if (size > 50 * 1024 * 1024) throw new Error('IPC 参数超过大小限制');
  };
  visit(args, 0);
}

export function guardedIpc(ipc: IpcMain, window: () => BrowserWindow | null, expectedPage: () => string): Pick<IpcMain, 'handle' | 'on'> {
  const valid = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => {
    const current = window();
    if (!current || current.isDestroyed() || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame) return false;
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(expectedPage());
      actual.hash = ''; expected.hash = '';
      return actual.href === expected.href;
    } catch { return false; }
  };
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (!valid(event)) throw new Error('IPC 来源被拒绝');
        assertIpcData(args);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        if (!valid(event)) return;
        try { assertIpcData(args); } catch { return; }
        listener(event, ...args);
      });
      return ipc;
    },
  };
}
