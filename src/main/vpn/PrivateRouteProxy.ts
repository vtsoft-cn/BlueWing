import net from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { privateIPv4 } from './PrivateRouteDiscovery';

export interface PrivateRouteCandidate { id: string; generation: number; port: number; user: string; password: string }

/** A bounded SOCKS reader that preserves pipelined application bytes. */
class Reader {
  private buffer = Buffer.alloc(0);
  private pending?: { size: number; resolve(value: Buffer): void; reject(error: Error): void };
  private error?: Error;
  constructor(private socket: net.Socket) {
    socket.on('data', this.data); socket.on('error', this.failed); socket.on('close', this.closed);
  }
  private data = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 65536) { this.failed(new Error('SOCKS_BUFFER_LIMIT')); this.socket.destroy(); return; }
    this.flush();
  };
  private failed = (error: Error) => { this.error = error; this.pending?.reject(error); this.pending = undefined; };
  private closed = () => this.failed(new Error('SOCKS_CLOSED'));
  private flush(): void {
    const p = this.pending;
    if (p && this.buffer.length >= p.size) { const value = this.buffer.subarray(0, p.size); this.buffer = this.buffer.subarray(p.size); this.pending = undefined; p.resolve(value); }
  }
  read(size: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.pending = { size, resolve, reject }; this.flush(); });
  }
  release(): void {
    this.socket.pause(); this.socket.off('data', this.data); this.socket.off('error', this.failed); this.socket.off('close', this.closed);
    if (this.buffer.length) this.socket.unshift(this.buffer); this.buffer = Buffer.alloc(0);
  }
}
const same = (a: Buffer, b: string) => a.length === Buffer.byteLength(b) && timingSafeEqual(a, Buffer.from(b));
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/** Only unknown private targets reach this layer; explicit company rules precede it. */
export class PrivateRouteProxy {
  private server?: net.Server;
  private opening?: Promise<{ port: number; user: string; password: string }>;
  private sockets = new Set<net.Socket>();
  private user = randomBytes(16).toString('hex');
  private password = randomBytes(32).toString('hex');
  private hints = new Map<string, { id: string; epoch: string; expires: number }>();
  constructor(private candidates: () => PrivateRouteCandidate[], private attemptMs = 11000, private totalMs = 15000,
    private allowSystemRoute?: () => boolean, private observedLocal?: (host: string, port: number) => void) {}
  start(): Promise<{ port: number; user: string; password: string }> {
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        if (this.sockets.size >= 256) { socket.destroy(); return; }
        this.track(socket); this.serve(socket).catch(() => socket.destroy());
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, user: this.user, password: this.password }));
    });
    this.opening.catch(() => { this.opening = undefined; });
    return this.opening;
  }
  private track(socket: net.Socket): void {
    this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket));
  }
  private async target(reader: Reader, atyp: number): Promise<Buffer> {
    if (atyp === 1) return reader.read(4);
    if (atyp === 3) { const size = await reader.read(1); if (!size[0]) throw new Error('EMPTY_HOST'); return Buffer.concat([size, await reader.read(size[0])]); }
    if (atyp === 4) return reader.read(16);
    throw new Error('INVALID_ADDRESS');
  }
  private async dial(candidate: PrivateRouteCandidate, request: Buffer, signal: AbortSignal, timeoutMs: number): Promise<net.Socket> {
    const socket = net.createConnection({ host: '127.0.0.1', port: candidate.port, signal }); this.track(socket);
    const reader = new Reader(socket), timer = setTimeout(() => socket.destroy(new Error('PRIVATE_ROUTE_TIMEOUT')), timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      socket.write(Buffer.from([5, 1, 2])); if ((await reader.read(2))[1] !== 2) throw new Error('SOCKS_AUTH_REQUIRED');
      const user = Buffer.from(candidate.user), password = Buffer.from(candidate.password);
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
      if ((await reader.read(2))[1] !== 0) throw new Error('SOCKS_AUTH_FAILED');
      socket.write(request); const header = await reader.read(4);
      if (header[0] !== 5 || header[1] !== 0) throw new Error('PRIVATE_ROUTE_UNREACHABLE');
      await this.target(reader, header[3]); await reader.read(2); reader.release(); return socket;
    } catch (error) { socket.destroy(); throw error; }
    finally { clearTimeout(timer); }
  }
  private async local(host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
    const socket = net.createConnection({ host, port, signal }); this.track(socket);
    const timer = setTimeout(() => socket.destroy(new Error('LOCAL_ROUTE_TIMEOUT')), 800);
    try { await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }); socket.pause(); return socket; }
    catch (error) { socket.destroy(); throw error; }
    finally { clearTimeout(timer); }
  }
  private async serve(socket: net.Socket): Promise<void> {
    socket.setTimeout(10000, () => socket.destroy());
    const reader = new Reader(socket), controller = new AbortController();
    socket.once('close', () => controller.abort());
    let remote: net.Socket | undefined, handedOff = false;
    try {
      const hello = await reader.read(2);
      if (hello[0] !== 5 || !(await reader.read(hello[1])).includes(2)) { socket.end(Buffer.from([5, 255])); return; }
      socket.write(Buffer.from([5, 2]));
      const auth = await reader.read(2), user = await reader.read(auth[1]), length = await reader.read(1), password = await reader.read(length[0]);
      if (auth[0] !== 1 || !same(user, this.user) || !same(password, this.password)) { socket.end(Buffer.from([1, 1])); return; }
      socket.write(Buffer.from([1, 0]));
      const header = await reader.read(4);
      if (header[0] !== 5 || header[1] !== 1 || ![1, 3].includes(header[3])) { socket.end(reply(7)); return; }
      const address = await this.target(reader, header[3]), portBytes = await reader.read(2), port = portBytes.readUInt16BE();
      const host = header[3] === 1 ? [...address].join('.') : address.subarray(1).toString('utf8');
      if (!port || (net.isIP(host) ? !privateIPv4(host) : !/^(?=.{1,253}$)[a-zA-Z0-9_.-]+$/.test(host))) { socket.end(reply(2)); return; }
      const request = Buffer.concat([header, address, portBytes]);
      let candidates = this.candidates();
      const epoch = candidates.map(c => `${c.id}:${c.generation}:${c.port}`).join('|'), key = `${host}:${port}`, hint = this.hints.get(key);
      const cached = hint && hint.epoch === epoch && hint.expires > Date.now();
      if (cached) candidates = [...candidates.filter(c => c.id === hint.id), ...candidates.filter(c => c.id !== hint.id)];
      // With no TUN, OS routes include other official VPN clients. Never make
      // this unbound dial under a TUN or it could re-enter this same dispatcher.
      if (!cached && candidates.length && privateIPv4(host) && this.allowSystemRoute?.()) {
        try { remote = await this.local(host, port, controller.signal); this.observedLocal?.(host, port); } catch { /* Try authorized VPN candidates next. */ }
      }
      const deadline = Date.now() + this.totalMs; socket.setTimeout(this.totalMs + 2000);
      for (const candidate of remote ? [] : candidates) {
        if (controller.signal.aborted || Date.now() >= deadline) break;
        try { remote = await this.dial(candidate, request, controller.signal, Math.min(this.attemptMs, deadline - Date.now())); }
        catch { continue; }
        if (controller.signal.aborted || socket.destroyed) { remote.destroy(); remote = undefined; break; }
        if (!this.candidates().some(c => c.id === candidate.id && c.generation === candidate.generation)) { remote.destroy(); remote = undefined; continue; }
        if (this.hints.size >= 256) this.hints.delete(this.hints.keys().next().value!);
        this.hints.set(key, { id: candidate.id, epoch, expires: Date.now() + 60000 }); break;
      }
      if (!remote) { socket.end(reply(4)); return; }
      // No application byte is forwarded before a single path has been selected.
      socket.setTimeout(0); socket.write(reply(0)); reader.release(); handedOff = true;
      const upstream = remote;
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
      socket.pipe(upstream); upstream.pipe(socket); socket.resume(); upstream.resume();
    } finally { if (!handedOff) { reader.release(); if (!socket.writableEnded) socket.destroy(); remote?.destroy(); } }
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy(); this.hints.clear();
    const server = this.server; this.server = undefined; this.opening = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
