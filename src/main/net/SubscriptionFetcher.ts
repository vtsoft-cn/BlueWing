import { net } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SubscriptionFetchResult {
  content: string;
  userInfo?: {
    upload?: number;
    download?: number;
    total?: number;
    expire?: number;
  };
}

export class SubscriptionFetcher {
  private static readonly USER_AGENTS = [
    'sing-box/1.14.3',
    'ClashMeta/1.18.0',
    'v2rayN/6.23',
  ].join(' ');

  /**
   * 把各阶段的失败证据归类为简短中文原因(区分 DNS/超时/拒连/TLS/HTTP 状态),
   * 让用户能判断是所在网络拦截还是订阅服务器问题。
   * curl 的错误对象 code 为其退出码:6=DNS 7=拒连/连不上 28=超时 35+*=TLS。
   */
  private static classifyFailure(err: any, stage: string): string {
    const msg = String(err?.message || err?.name || err || '');
    const code = typeof err?.code === 'number' ? err.code : undefined;
    if (err?.name === 'AbortError' || /timed?out|timeout/i.test(msg) || code === 28) {
      return `${stage}:连接超时`;
    }
    if (code === 6 || /ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve|resolve.*fail/i.test(msg)) {
      return `${stage}:域名解析失败(当前网络无法解析该域名)`;
    }
    if (code === 7 || /ECONNREFUSED/i.test(msg)) {
      return `${stage}:连接被拒绝`;
    }
    if ((code !== undefined && [35, 53, 54, 58, 59, 60, 66, 77, 82, 83, 90, 91].includes(code)) || /certificate|SSL|TLS/i.test(msg)) {
      return `${stage}:TLS 握手/证书校验失败`;
    }
    return `${stage}:${msg || '未知错误'}`;
  }

  /**
   * Fetches subscription content with redirect following, standard headers, and fallback mechanisms
   */
  public static async fetch(url: string, mixedPort: number = 2080): Promise<SubscriptionFetchResult> {
    const trimmedUrl = url.trim();
    const failures: string[] = [];
    const record = (reason: string) => {
      if (reason && !failures.includes(reason)) failures.push(reason);
    };

    // 1. Try Electron net.fetch (Chromium network stack with automatic redirect following & system proxy)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await net.fetch(trimmedUrl, {
        headers: {
          'User-Agent': this.USER_AGENTS,
          'Accept': '*/*',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const content = await res.text();
        const userInfoHeader = res.headers.get('subscription-userinfo');
        const userInfo = this.parseUserInfo(userInfoHeader);
        if (content && content.length > 5) {
          return { content, userInfo };
        }
        record('网络层:响应内容为空');
      } else {
        record(`网络层:HTTP ${res.status}`);
      }
    } catch (e) {
      record(this.classifyFailure(e, '网络层'));
    }

    // 2. Try native Windows curl.exe (direct connection with -L to follow redirects and -k for SSL)
    try {
      const { stdout } = await execFileAsync(
        'curl.exe',
        ['-s', '-L', '-k', '-A', this.USER_AGENTS, '--max-time', '15', '-i', trimmedUrl],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      const parsed = this.parseCurlOutput(stdout);
      if (parsed.content && parsed.content.length > 5) {
        return parsed;
      }
      record('直连:响应内容为空');
    } catch (e) {
      record(this.classifyFailure(e, '直连'));
    }

    // 3. Fallback: Try curl with local proxy (mixed port or socks)
    const proxyList = [
      `http://127.0.0.1:${mixedPort}`,
      `socks5://127.0.0.1:${mixedPort}`,
      'socks5://127.0.0.1:10808',
      'http://127.0.0.1:10809',
    ];

    for (const proxy of proxyList) {
      try {
        const { stdout } = await execFileAsync(
          'curl.exe',
          ['-s', '-L', '-k', '-x', proxy, '-A', this.USER_AGENTS, '--max-time', '10', '-i', trimmedUrl],
          { maxBuffer: 10 * 1024 * 1024 }
        );
        const parsed = this.parseCurlOutput(stdout);
        if (parsed.content && parsed.content.length > 5) {
          return parsed;
        }
      } catch (e) {
        record(this.classifyFailure(e, `本地代理(${proxy.replace('127.0.0.1', '本机')})`));
      }
    }

    const detail = failures.length > 0 ? failures.slice(0, 3).join(';') : '未知原因';
    throw new Error(
      `无法连接到订阅服务器——${detail}。若当前网络无法直连订阅源,可先连接一个可用节点后重试(核心运行时会经本地代理自动重试)`
    );
  }

  private static parseCurlOutput(output: string): SubscriptionFetchResult {
    // Curl with -i separates headers and body with double newline \r\n\r\n
    // If there were redirects, there will be multiple header sections
    const sections = output.split(/\r?\n\r?\n/);
    const body = sections[sections.length - 1] || '';

    let userInfoHeader: string | undefined;
    for (let i = 0; i < sections.length - 1; i++) {
      const lines = sections[i].split(/\r?\n/);
      for (const line of lines) {
        if (/^subscription-userinfo\s*:/i.test(line)) {
          userInfoHeader = line.replace(/^subscription-userinfo\s*:/i, '').trim();
        }
      }
    }

    return {
      content: body.trim(),
      userInfo: this.parseUserInfo(userInfoHeader),
    };
  }

  private static parseUserInfo(header?: string | null): SubscriptionFetchResult['userInfo'] {
    if (!header) return undefined;
    const info: SubscriptionFetchResult['userInfo'] = {};
    const parts = header.split(';');
    for (const part of parts) {
      const [k, v] = part.trim().split('=');
      if (k && v) {
        const num = Number(v);
        if (!isNaN(num)) {
          if (k.toLowerCase() === 'upload') info.upload = num;
          if (k.toLowerCase() === 'download') info.download = num;
          if (k.toLowerCase() === 'total') info.total = num;
          if (k.toLowerCase() === 'expire') info.expire = num;
        }
      }
    }
    return info;
  }
}
