import http from 'http';
import { coreApiHeaders } from '../security/CoreApiAuth';
import https from 'https';
import tls from 'tls';
import net from 'net';
import { URL } from 'url';
import { TcpPing } from './TcpPing';
import { LatencyResult } from '../../types';

export interface NodeSpeedResult {
  nodeId: string;
  ping: number; // ms (-1 on failure)
  downloadSpeed?: number; // bits per second
  uploadSpeed?: number; // bits per second
  status: 'pending' | 'testing' | 'success' | 'error';
  errorMessage?: string;
}

export class SpeedTestRunner {
  // Map of active test task AbortControllers keyed by taskId or nodeId
  private static activeTasks: Map<string, AbortController> = new Map();

  /** 统一的 User-Agent,版本号取自应用版本(纯 Node 测试环境下回退) */
  private static userAgent(suffix = ''): string {
    let ver = '0.0.0';
    try {
      if(process.versions.electron)ver = (require('electron') as typeof import('electron')).app.getVersion();
    } catch {}
    return `BlueWingConnect/${ver}${suffix}`;
  }

  /**
   * Cancel specific test task or all active tests
   */
  public static cancel(nodeId?: string) {
    if (nodeId) {
      const ctrl = this.activeTasks.get(nodeId);
      if (ctrl) {
        ctrl.abort();
        this.activeTasks.delete(nodeId);
      }
    } else {
      for (const ctrl of this.activeTasks.values()) {
        ctrl.abort();
      }
      this.activeTasks.clear();
    }
  }

  /**
   * Test node latency without touching user's active proxy selector.
   * Uses Sing-box Clash API node outbound probe directly, or fallback TCP ping.
   *
   * 关键区分:Clash API「连不上」(核心未运行)才回退 TCP ping;
   * API 正常应答但探测失败(节点出站真实报错)时如实返回 -1 + 分类原因,
   * 绝不用 TCP ping 的成功掩盖"代理通道已坏"(用户所见"ping 通但节点不可用"即此)。
   */
  public static async testLatency(
    testUrl: string = 'http://cp.cloudflare.com/generate_204',
    timeoutMs: number = 5000,
    proxyPort?: number,
    nodeId?: string,
    clashPort: number = 9090,
    nodeServer?: string,
    nodePort?: number
  ): Promise<LatencyResult> {
    const taskId = nodeId || `latency-${Date.now()}-${Math.random()}`;
    const abortCtrl = new AbortController();
    this.activeTasks.set(taskId, abortCtrl);

    try {
      // 墙钟看门狗:经 createConnection 提供的隧道 socket 上 options.timeout 会失效(Node 实证),
      // 任何探测链路都必须在有限时间内结算,否则渲染层永久 await
      let watchdog: NodeJS.Timeout | undefined;
      const deadline = new Promise<LatencyResult>((r) => {
        watchdog = setTimeout(() => {
          abortCtrl.abort();
          r({ latency: -1, via: 'watchdog' });
        }, timeoutMs * 2 + 3000);
      });
      const result = await Promise.race([
        this.testLatencyCore(testUrl, timeoutMs, proxyPort, nodeId, clashPort, nodeServer, nodePort, abortCtrl.signal),
        deadline,
      ]);
      if (watchdog) clearTimeout(watchdog);
      return result;
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  private static async testLatencyCore(
    testUrl: string,
    timeoutMs: number,
    proxyPort?: number,
    nodeId?: string,
    clashPort: number = 9090,
    nodeServer?: string,
    nodePort?: number,
    signal: AbortSignal = new AbortController().signal
  ): Promise<LatencyResult> {
    // 1. If nodeId is specified, test via Sing-box Clash API outbound delay probe
    if (nodeId) {
      try {
        const clashDelay = await this.testViaClashApi(nodeId, testUrl, timeoutMs, clashPort, signal);
        if (clashDelay > 0) return { latency: clashDelay, via: 'proxy-probe' };
      } catch (err: any) {
        // API 已应答但该节点出站探测失败:节点代理通道真实故障,带核心原始错误返回
        if (err?.probeFailed) {
          return { latency: -1, via: 'proxy-probe', reason: this.classifyProbeFailure(err.message) };
        }
        // Clash API 本身连不上(核心未运行等):回退直连 TCP ping,仅衡量服务器可达性
        if (nodeServer && nodePort) {
          try {
            const tcpRes = await TcpPing.ping(nodeServer, nodePort, timeoutMs);
            return { latency: tcpRes.time, via: 'tcp-fallback' };
          } catch {
            return { latency: -1, via: 'tcp-fallback' };
          }
        }
        return { latency: -1, via: 'tcp-fallback' };
      }
    }

    // 2. Test via current active proxyPort if specified
    if (proxyPort) {
      try {
        const proxyDelay = await this.testViaHttp(testUrl, timeoutMs, proxyPort, signal);
        if (proxyDelay > 0) return { latency: proxyDelay, via: 'proxy-port' };
      } catch {
        // Fall through to direct
      }
    }

    // 3. Fallback direct test
    return { latency: await this.testViaHttp(testUrl, timeoutMs, undefined, signal), via: 'direct' };
  }

  /**
   * 把节点出站探测的真实失败原因归类为可操作的中文提示。
   * Clash API 的 delay 探测失败会把 sing-box 核心错误原样带回,
   * 如 "reality verification failed"——REALITY 无法穿透 CDN(域名被 Cloudflare
   * 等接管后 TLS 在边缘终结),是"TCP 可达但节点不可用"的最常见根因。
   */
  public static classifyProbeFailure(msg: string): string {
    const m = String(msg || '');
    if (/reality verification failed/i.test(m)) {
      return 'REALITY 握手失败:节点域名可能被 CDN(如 Cloudflare)接管或服务端参数变更,可将节点地址改为服务器 IP 试探';
    }
    if (/tls|certificate|x509|handshake/i.test(m)) {
      return 'TLS 握手失败:节点证书或加密参数可能已变更';
    }
    if (/timeout|context deadline/i.test(m)) {
      return '代理通道超时:服务器可达但代理无响应';
    }
    if (/lookup|no such host|ENOTFOUND|dns/i.test(m)) {
      return '节点域名解析失败:核心无法解析节点服务器地址';
    }
    if (/refused/i.test(m)) {
      return '节点拒绝连接:服务端可能未监听或已封禁本机 IP';
    }
    return m ? `探测失败:${m}` : '探测失败:未知原因';
  }

  /**
   * Test download speed using isolated speedtest-selector without touching user's 'proxy' selector.
   */
  public static async testDownload(
    downloadUrl: string = 'http://speed.cloudflare.com/__down?bytes=5000000',
    durationSec: number = 4,
    proxyPort?: number,
    nodeId?: string,
    clashPort: number = 9090,
    onProgress?: (speedBps: number) => void
  ): Promise<number> {
    const taskId = nodeId || `dl-${Date.now()}-${Math.random()}`;
    const abortCtrl = new AbortController();
    this.activeTasks.set(taskId, abortCtrl);

    // Speedtest uses dedicated loopback port (mixedPort + 1, e.g. 2081)
    const speedtestPort = proxyPort ? proxyPort + 1 : undefined;

    try {
      if (nodeId && speedtestPort) {
        // Set isolated speedtest-selector in Clash API (NEVER touches 'proxy' selector)
        const selectorSet = await this.setSpeedtestSelector(nodeId, clashPort);
        if (!selectorSet) {
          // 切换失败(核心未就绪等):直接放弃,避免静默测出"本机直连"的错误速度
          console.warn(`[SpeedTest] Failed to set speedtest-selector for node ${nodeId}, abort test`);
          return 0;
        }

        try {
          const speed = await this.withDownloadWatchdog(
            this.doDownload(downloadUrl, durationSec, speedtestPort, abortCtrl.signal, onProgress),
            durationSec,
            abortCtrl
          );
          return speed;
        } finally {
          // Reset speedtest-selector to 'direct'
          this.resetSpeedtestSelector(clashPort).catch(() => {});
        }
      }

      // If no nodeId, download via active proxyPort or direct
      return await this.withDownloadWatchdog(
        this.doDownload(downloadUrl, durationSec, proxyPort, abortCtrl.signal, onProgress),
        durationSec,
        abortCtrl
      );
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  /**
   * 下载墙钟看门狗:经 createConnection 提供的隧道 socket 上 options.timeout 会失效(Node 实证),
   * 硬时限保证 testDownload 必然结算;到期 abort 摧毁在途 socket,避免黑洞链路永久挂死
   */
  private static withDownloadWatchdog(
    p: Promise<number>,
    durationSec: number,
    abortCtrl: AbortController
  ): Promise<number> {
    let watchdog: NodeJS.Timeout | undefined;
    return new Promise<number>((resolve) => {
      watchdog = setTimeout(() => {
        abortCtrl.abort();
        resolve(0);
      }, (durationSec + 8) * 1000);
      p.then(
        (v) => {
          if (watchdog) clearTimeout(watchdog);
          resolve(v);
        },
        () => {
          if (watchdog) clearTimeout(watchdog);
          resolve(0);
        }
      );
    });
  }

  /**
   * Query delay for specific node outbound via Clash API
   */
  private static testViaClashApi(
    nodeId: string,
    testUrl: string,
    timeoutMs: number,
    clashPort: number,
    signal: AbortSignal
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        return reject(new Error('Aborted'));
      }

      const tag = `node-${nodeId}`;
      const url = `http://127.0.0.1:${clashPort}/proxies/${encodeURIComponent(tag)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(testUrl)}`;

      const req = http.get(url, { timeout: timeoutMs, headers: coreApiHeaders() }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (typeof data.delay === 'number' && data.delay > 0) {
              resolve(data.delay);
            } else {
              // API 正常应答但探测失败:打上标记,调用方不得用 TCP ping 掩盖
              const err = new Error(data.message || 'No delay data');
              (err as any).probeFailed = true;
              reject(err);
            }
          } catch (e) {
            (e as any).probeFailed = true;
            reject(e);
          }
        });
      });

      const onAbort = () => {
        req.destroy();
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      req.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      req.on('timeout', () => {
        signal.removeEventListener('abort', onAbort);
        req.destroy();
        reject(new Error('Clash API timeout'));
      });
    });
  }

  /**
   * Switch the dedicated speedtest-selector in Clash API
   */
  private static setSpeedtestSelector(nodeId: string, clashPort: number): Promise<boolean> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({ name: `node-${nodeId}` });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: clashPort,
          path: '/proxies/speedtest-selector',
          method: 'PUT',
          headers: {
            ...coreApiHeaders(), 'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
          },
          timeout: 2000,
        },
        (res) => resolve(res.statusCode === 204 || res.statusCode === 200)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Reset the dedicated speedtest-selector back to 'direct'
   */
  private static resetSpeedtestSelector(clashPort: number): Promise<boolean> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({ name: 'direct' });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: clashPort,
          path: '/proxies/speedtest-selector',
          method: 'PUT',
          headers: {
            ...coreApiHeaders(), 'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(payload)),
          },
          timeout: 1000,
        },
        (res) => resolve(res.statusCode === 204 || res.statusCode === 200)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * HTTP/HTTPS latency test with full CONNECT tunneling support
   */
  private static testViaHttp(
    testUrl: string,
    timeoutMs: number,
    proxyPort?: number,
    signal?: AbortSignal
  ): Promise<number> {
    const startTime = Date.now();
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(-1);

      try {
        const urlObj = new URL(testUrl);
        const isHttps = urlObj.protocol === 'https:';

        if (proxyPort && isHttps) {
          // HTTPS over HTTP proxy requires HTTP CONNECT tunnel
          this.createConnectTunnel('127.0.0.1', proxyPort, urlObj.hostname, 443, timeoutMs)
            .then((socket) => {
              if (signal?.aborted) {
                socket.destroy();
                return resolve(-1);
              }

              const tlsSocket = tls.connect({
                socket,
                servername: urlObj.hostname,
                rejectUnauthorized: false,
              });

              const req = https.request(
                {
                  createConnection: () => tlsSocket,
                  method: 'GET',
                  path: urlObj.pathname + urlObj.search,
                  headers: {
                    Host: urlObj.host,
                    'User-Agent': this.userAgent(),
                  },
                  timeout: timeoutMs,
                },
                (res) => {
                  res.resume();
                  const duration = Date.now() - startTime;
                  resolve(duration > 0 ? duration : 1);
                }
              );

              signal?.addEventListener('abort', () => {
                req.destroy();
                resolve(-1);
              }, { once: true });

              req.on('error', () => resolve(-1));
              req.on('timeout', () => {
                req.destroy();
                resolve(-1);
              });
              req.end();
            })
            .catch(() => resolve(-1));
          return;
        }

        // Plain HTTP or Direct HTTPS
        let options: any;
        if (proxyPort) {
          options = {
            method: 'GET',
            host: '127.0.0.1',
            port: proxyPort,
            path: testUrl,
            headers: {
              Host: urlObj.host,
              'User-Agent': this.userAgent(),
            },
            timeout: timeoutMs,
          };
        } else {
          options = {
            method: 'GET',
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            headers: {
              'User-Agent': this.userAgent(),
            },
            timeout: timeoutMs,
          };
        }

        const client = proxyPort ? http : (isHttps ? https : http);
        const req = client.request(options, (res) => {
          res.resume();
          const duration = Date.now() - startTime;
          resolve(duration > 0 ? duration : 1);
        });

        signal?.addEventListener('abort', () => {
          req.destroy();
          resolve(-1);
        }, { once: true });

        req.on('timeout', () => {
          req.destroy();
          resolve(-1);
        });

        req.on('error', () => resolve(-1));
        req.end();
      } catch {
        resolve(-1);
      }
    });
  }

  /**
   * HTTP download speed measurement with progress reporting.
   * Supports HTTPS-over-proxy via HTTP CONNECT tunneling and relative redirects.
   */
  private static doDownload(
    downloadUrl: string,
    durationSec: number,
    proxyPort?: number,
    signal?: AbortSignal,
    onProgress?: (speedBps: number) => void,
    originUrl?: string,
    hop = 0
  ): Promise<number> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(0);

      let urlObj: URL;
      try {
        // originUrl 使相对路径重定向 (/path) 能正确解析为绝对地址
        urlObj = new URL(downloadUrl, originUrl);
      } catch {
        return resolve(0);
      }

      const isHttps = urlObj.protocol === 'https:';
      const timeoutMs = (durationSec + 4) * 1000;
      const headers = {
        Host: urlObj.host,
        'User-Agent': this.userAgent(' SpeedTest'),
      };

      const handleResponse = (req: http.ClientRequest, res: http.IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          req.destroy();
          // 重定向链封顶:被劫持/异常代理可用无限 302 让测速永不结束
          if (hop >= 5) return resolve(0);
          this.doDownload(res.headers.location, durationSec, proxyPort, signal, onProgress, urlObj.href, hop + 1).then(resolve);
          return;
        }

        let totalBytes = 0;
        const startTime = Date.now();

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed > 0) {
            const currentSpeed = (totalBytes * 8) / elapsed;
            if (onProgress) onProgress(currentSpeed);
          }
          if (elapsed >= durationSec || signal?.aborted) {
            req.destroy();
          }
        });

        res.on('end', () => {
          const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
          resolve((totalBytes * 8) / elapsed);
        });

        req.on('error', () => {
          const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
          resolve(totalBytes > 0 ? (totalBytes * 8) / elapsed : 0);
        });
      };

      if (proxyPort && isHttps) {
        // HTTPS 经本地代理必须走 CONNECT 隧道,否则会绕过代理直连目标,测出的是本机带宽
        this.createConnectTunnel('127.0.0.1', proxyPort, urlObj.hostname, Number(urlObj.port) || 443, timeoutMs)
          .then((socket) => {
            if (signal?.aborted) {
              socket.destroy();
              return resolve(0);
            }
            const tlsSocket = tls.connect({
              socket,
              servername: urlObj.hostname,
              rejectUnauthorized: false,
            });
            const req = https.request(
              {
                createConnection: () => tlsSocket,
                method: 'GET',
                path: urlObj.pathname + urlObj.search,
                headers,
                timeout: timeoutMs,
              },
              (res) => handleResponse(req, res)
            );
            signal?.addEventListener('abort', () => {
              req.destroy();
              resolve(0);
            }, { once: true });
            req.on('error', () => resolve(0));
            req.on('timeout', () => {
              req.destroy();
              // destroy() 在 TLS 握手黑洞(代理接受 CONNECT 后不应答)时永不触发 error,必须显式结算
              resolve(0);
            });
            req.end();
          })
          .catch(() => resolve(0));
        return;
      }

      try {
        let options: any;
        if (proxyPort) {
          // Plain HTTP via local proxy
          options = {
            method: 'GET',
            host: '127.0.0.1',
            port: proxyPort,
            path: urlObj.href,
            headers,
            timeout: timeoutMs,
          };
        } else {
          options = {
            method: 'GET',
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            headers: { 'User-Agent': this.userAgent(' SpeedTest') },
            timeout: timeoutMs,
          };
        }

        const client = isHttps ? https : http;
        const req = client.request(options, (res) => handleResponse(req, res));

        signal?.addEventListener('abort', () => {
          req.destroy();
          resolve(0);
        }, { once: true });

        req.on('error', () => resolve(0));

        req.setTimeout(timeoutMs, () => {
          req.destroy();
          resolve(0);
        });

        req.end();
      } catch {
        resolve(0);
      }
    });
  }

  /**
   * Establishes a raw TCP tunnel via HTTP CONNECT to an upstream proxy
   */
  private static createConnectTunnel(
    proxyHost: string,
    proxyPort: number,
    targetHost: string,
    targetPort: number,
    timeoutMs: number
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: {
          Host: `${targetHost}:${targetPort}`,
        },
        timeout: timeoutMs,
      });

      req.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`CONNECT failed with status ${res.statusCode}`));
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CONNECT timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  }
}
