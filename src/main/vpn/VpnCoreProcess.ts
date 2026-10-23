import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';

export interface VpnCoreEvent {
  v: number;
  type: string;
  id?: string;
  generation: number;
  profileId?: string;
  data?: any;
  code?: string;
}
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) =>
        ![
          'http_proxy',
          'https_proxy',
          'all_proxy',
          'no_proxy',
          'ftp_proxy',
          'proxy',
          'sslkeylogfile',
        ].includes(k.toLowerCase()),
    ),
  );
}
export class FrameDecoder {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(
    private onFrame: (e: VpnCoreEvent) => void,
    private max = 4 * 1024 * 1024,
  ) {}
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    if (Buffer.byteLength(this.pending) > this.max)
      throw new Error('CORE_PROTOCOL_FRAME_TOO_LARGE');
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const raw = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (!raw.trim()) continue;
      let e: VpnCoreEvent;
      try {
        e = JSON.parse(raw);
      } catch {
        throw new Error('CORE_PROTOCOL_INVALID_JSON');
      }
      if (
        e.v !== 1 ||
        typeof e.type !== 'string' ||
        !Number.isSafeInteger(e.generation)
      )
        throw new Error('CORE_VERSION_UNSUPPORTED');
      this.onFrame(e);
    }
  }
}
export class VpnCoreProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (e: VpnCoreEvent) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(readonly binary = VpnCoreProcess.locate()) {
    super();
  }
  static locate(): string {
    const candidates = [
      path.join(process.resourcesPath || '', 'bin', 'bluewing-vpn-core.exe'),
      path.join(process.cwd(), 'bin', 'bluewing-vpn-core.exe'),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? candidates[1];
  }
  available(): boolean {
    return fs.existsSync(this.binary);
  }
  static verifyBinary(binary: string): void {
    const file = path.join(path.dirname(binary), 'vpn-core-manifest.json');
    if (!fs.existsSync(file))
      throw new Error('CORE_MANIFEST_MISSING：请重新构建VPN 接入 组件');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.controlProtocol !== 1 ||
      manifest.upstream?.commit !==
        '5d7f5b11fcf231f72a0ec0d888bf0f2eadcce1da' ||
      createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !==
        manifest.sha256
    )
      throw new Error('CORE_INTEGRITY_FAILED：VPN 接入 组件校验失败');
  }
  isRunning(): boolean {
    return !!this.child;
  }
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    if (!this.available())
      throw new Error('CORE_MISSING：VPN 接入 核心尚未构建');
    VpnCoreProcess.verifyBinary(this.binary);
    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.binary, ['--control=stdio-json'], {
        windowsHide: true,
        env: childEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      child.stdin.on('error', () => {
        if (this.child === child) this.emit('fault', 'CORE_PIPE_CLOSED');
      });
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('CORE_HELLO_TIMEOUT'));
        child.kill();
      }, 5000);
      const decoder = new FrameDecoder((e) => {
        if (!ready) {
          if (e.type !== 'hello' || e.data?.protocolVersion !== 1) {
            reject(new Error('CORE_VERSION_UNSUPPORTED'));
            child.kill();
            return;
          }
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        const request = e.id && this.pending.get(e.id);
        if (request && e.id) {
          clearTimeout(request.timer);
          this.pending.delete(e.id);
          if (e.type === 'error')
            request.reject(new Error(e.code || 'CORE_FAILED'));
          else request.resolve(e);
        }
        this.emit('event', e);
      });
      child.stdout.on('data', (chunk) => {
        try {
          decoder.push(chunk);
        } catch {
          this.emit('fault', 'CORE_PROTOCOL_INVALID');
          child.kill();
        }
      });
      // Never forward raw native stderr: upstream panic/logs can contain authentication material.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('CORE_SPAWN_FAILED'));
      });
      child.on('close', () => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!ready) reject(new Error('CORE_EXITED_BEFORE_READY'));
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('CORE_EXITED'));
        }
        this.pending.clear();
        this.emit('exit');
      });
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }
  send(type: string, data: Record<string, unknown> = {}): void {
    if (!this.child?.stdin.writable)
      throw new Error('CORE_ENDPOINT_UNAVAILABLE');
    const frame = JSON.stringify({ ...data, v: 1, type }) + '\n';
    if (Buffer.byteLength(frame) > 4 * 1024 * 1024)
      throw new Error('CORE_COMMAND_TOO_LARGE');
    this.child.stdin.write(frame, () => {});
  }
  async request(
    type: string,
    data: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<VpnCoreEvent> {
    await this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CORE_REQUEST_TIMEOUT'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(type, { ...data, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill(), 4000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.send('shutdown');
        child.stdin.end();
      } catch {
        child.kill();
      }
    });
  }
}
