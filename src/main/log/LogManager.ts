import fs from 'fs';
import path from 'path';
import { BrowserWindow, dialog } from 'electron';
import { LogEntry } from '../../types';
import { Database } from '../db/Database';

export class LogManager {
  private static instance: LogManager;
  private logBuffer: LogEntry[] = [];
  private readonly maxBufferSize = 1000;
  private readonly maxFileSizeBytes = 10 * 1024 * 1024; // 10 MB per log file

  private logDir: string;
  private logFilePath: string;
  private mainWindow: BrowserWindow | null = null;

  // Asynchronous write queue to prevent main thread event loop blockage
  private writeQueue: string[] = [];
  private isWriting = false;
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.logDir = path.join(Database.getInstance().getDataDir(), 'logs');

    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (e) {
      console.error('Failed to create logs directory:', e);
    }

    this.logFilePath = path.join(this.logDir, 'bluewing.log');

    // 0. 清理旧轮转机制的历史归档文件(最多 5 份,向前兼容清理)
    this.cleanupLegacyArchives();

    // 1. Load historical logs from disk on startup
    this.loadHistoryFromDisk();

    // 2. Schedule periodic async queue flush (every 100ms)
    this.flushTimer = setInterval(() => {
      this.flushQueueAsync();
    }, 100);
    this.flushTimer.unref();

    // Initial system start event
    this.addLog('info', '青翼连接 运行日志系统初始化完成', 'app');
  }

  public static getInstance(): LogManager {
    if (!LogManager.instance) {
      LogManager.instance = new LogManager();
    }
    return LogManager.instance;
  }

  public setMainWindow(window: BrowserWindow | null) {
    this.mainWindow = window;
  }

  /**
   * Load existing lines from bluewing.log on app startup into the memory buffer
   */
  private loadHistoryFromDisk() {
    try {
      if (!fs.existsSync(this.logFilePath)) return;

      const stats = fs.statSync(this.logFilePath);
      if (stats.size === 0) return;

      // 启动时超限:保留最新 5MB(总量恒 ≤ 10MB)
      if (stats.size > this.maxFileSizeBytes) {
        this.trimLogFileInPlace();
        return;
      }

      // Read last ~500KB to avoid reading massive historical files
      const readSize = Math.min(stats.size, 512 * 1024);
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(this.logFilePath, 'r');
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      fs.closeSync(fd);

      const content = buffer.toString('utf8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);

      const parsedEntries: LogEntry[] = [];
      // Regex parses [ISO_TIMESTAMP] [SOURCE] [LEVEL] message
      const logPattern = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/;

      for (const line of lines) {
        const match = line.match(logPattern);
        if (match) {
          const isoTime = match[1];
          const src = match[2].toLowerCase() as any;
          const lvl = match[3].toLowerCase() as any;
          const msg = match[4];

          const dateObj = new Date(isoTime);
          const timeFormatted = isNaN(dateObj.getTime())
            ? isoTime
            : dateObj.toLocaleTimeString('zh-CN', { hour12: false }) +
              '.' +
              String(dateObj.getMilliseconds()).padStart(3, '0');

          parsedEntries.push({
            id: 'hist-' + Math.random().toString(36).substring(2, 9),
            timestamp: isoTime,
            timeFormatted,
            level: ['debug', 'info', 'warn', 'error'].includes(lvl) ? lvl : 'info',
            source: ['core', 'app', 'system', 'net'].includes(src) ? src : 'app',
            message: msg,
          });
        }
      }

      // Keep up to maxBufferSize entries
      this.logBuffer = parsedEntries.slice(-this.maxBufferSize);
    } catch (e) {
      console.warn('Failed to load log history from disk:', e);
    }
  }

  /**
   * Main entry point to record a log message
   */
  public addLog(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    source: 'core' | 'app' | 'system' | 'net' = 'app'
  ) {
    const now = new Date();
    const timestamp = now.toISOString();
    const timeFormatted =
      now.toLocaleTimeString('zh-CN', { hour12: false }) +
      '.' +
      String(now.getMilliseconds()).padStart(3, '0');

    const cleanMessage = (message || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!cleanMessage) return;

    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 11),
      timestamp,
      timeFormatted,
      level,
      message: cleanMessage,
      source,
    };

    // 1. Maintain in-memory ring buffer
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // 2. Queue formatted line for asynchronous disk flush
    const line = `[${timestamp}] [${source.toUpperCase()}] [${level.toUpperCase()}] ${cleanMessage}\n`;
    this.writeQueue.push(line);

    // If queue is getting large, flush immediately
    if (this.writeQueue.length >= 30) {
      this.flushQueueAsync();
    }

    // 3. Broadcast to frontend renderer (Single Source of Truth, 单事件单投递)
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('log:added', entry);
      } catch {
        // Ignore dead webContents
      }
    }
  }

  /**
   * Asynchronously flushes queued log lines to disk without blocking the main event loop
   */
  private flushQueueAsync() {
    if (this.isWriting || this.writeQueue.length === 0) return;

    this.isWriting = true;
    const chunk = this.writeQueue.splice(0, this.writeQueue.length).join('');

    // Check file size for rotation before appending
    this.checkRotationAsync(() => {
      fs.appendFile(this.logFilePath, chunk, 'utf8', (err) => {
        this.isWriting = false;
        if (err) {
          console.error('Failed to append to log file:', err);
        }
        // If more items accumulated while writing, flush again
        if (this.writeQueue.length > 0) {
          setImmediate(() => this.flushQueueAsync());
        }
      });
    });
  }

  /**
   * Synchronously flush pending queue (used on quit or clear)
   */
  public flushSync() {
    if (this.writeQueue.length === 0) return;
    try {
      const chunk = this.writeQueue.splice(0, this.writeQueue.length).join('');
      fs.appendFileSync(this.logFilePath, chunk, 'utf8');
    } catch (e) {
      console.error('Failed to flush logs synchronously:', e);
    }
  }

  /**
   * Log file rotation check
   */
  private checkRotationAsync(callback: () => void) {
    fs.stat(this.logFilePath, (err, stats) => {
      if (!err && stats.size >= this.maxFileSizeBytes) {
        this.trimLogFileInPlace();
      }
      callback();
    });
  }

  /** 超过 10MB 时原地裁剪:保留最新 5MB 并写入标记行,日志总量恒 ≤ 10MB,不再产生多份归档 */
  private trimLogFileInPlace() {
    try {
      const stats = fs.statSync(this.logFilePath);
      if (stats.size <= this.maxFileSizeBytes) return;
      const keep = this.maxFileSizeBytes / 2;
      const fd = fs.openSync(this.logFilePath, 'r');
      const buf = Buffer.alloc(keep);
      fs.readSync(fd, buf, 0, keep, stats.size - keep);
      fs.closeSync(fd);
      let start = 0;
      while (start < keep && buf[start] !== 0x0a) start++;
      const marker = Buffer.from(
        `[TRIMMED] 日志超过 10MB 上限,较旧内容已裁剪,以下为最新部分\n`,
        'utf8'
      );
      fs.writeFileSync(this.logFilePath, Buffer.concat([marker, buf.subarray(start + 1)]));
    } catch (e) {
      console.warn('Failed to trim log file:', e);
    }
  }

  /** 启动时清理历史归档文件(轮转机制已由原地裁剪取代) */
  private cleanupLegacyArchives() {
    for (let i = 1; i <= 5; i++) {
      try {
        const oldFile = path.join(this.logDir, `bluewing.${i}.log`);
        if (fs.existsSync(oldFile)) fs.rmSync(oldFile, { force: true });
      } catch {}
    }
  }

  public getLogs(): LogEntry[] {
    return [...this.logBuffer];
  }

  public clearLogs() {
    this.flushSync();
    this.logBuffer = [];
    this.writeQueue = [];
    try {
      if (fs.existsSync(this.logFilePath)) {
        fs.writeFileSync(this.logFilePath, '', 'utf8');
      }
    } catch (e) {
      console.error('Failed to clear log file:', e);
    }
    this.addLog('info', '运行日志已由用户清空', 'app');
  }

  /**
   * Export logs using native OS save dialog
   */
  public async exportLogs(suggestedName?: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      this.flushSync();
      const defaultFilename =
        suggestedName ||
        `bluewing-log-${new Date().toISOString().slice(0, 10)}.log`;

      const options: Electron.SaveDialogOptions = {
        title: '导出 青翼连接 运行日志',
        defaultPath: defaultFilename,
        filters: [
          { name: 'Log 文本文件 (*.log)', extensions: ['log', 'txt'] },
          { name: 'JSON 结构化日志 (*.json)', extensions: ['json'] },
          { name: '所有文件 (*.*)', extensions: ['*'] },
        ],
      };

      const result = this.mainWindow
        ? await dialog.showSaveDialog(this.mainWindow, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { success: false };
      }

      const ext = path.extname(result.filePath).toLowerCase();
      if (ext === '.json') {
        const jsonData = JSON.stringify(this.logBuffer, null, 2);
        fs.writeFileSync(result.filePath, jsonData, 'utf8');
      } else {
        // Export complete file content from disk if exists, otherwise memory buffer
        if (fs.existsSync(this.logFilePath)) {
          const content = fs.readFileSync(this.logFilePath, 'utf8');
          fs.writeFileSync(result.filePath, content, 'utf8');
        } else {
          const text = this.logBuffer
            .map(
              (l) =>
                `[${l.timestamp}] [${l.source.toUpperCase()}] [${l.level.toUpperCase()}] ${l.message}`
            )
            .join('\n');
          fs.writeFileSync(result.filePath, text, 'utf8');
        }
      }

      this.addLog('info', `日志已成功导出至: ${result.filePath}`, 'app');
      return { success: true, filePath: result.filePath };
    } catch (e: any) {
      this.addLog('error', `导出日志失败: ${e.message}`, 'app');
      return { success: false, error: e.message };
    }
  }

  public getLogFilePath(): string {
    return this.logFilePath;
  }

  public destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushSync();
  }
}
