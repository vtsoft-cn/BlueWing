import { AppSettings } from '../../types';
import { SystemProxy } from './SystemProxy';

type Settings = Pick<AppSettings, 'systemProxyEnabled' | 'mixedPort' | 'systemProxyBypassLan' | 'customBypassList'>;
type Owner = Pick<typeof SystemProxy, 'enable' | 'restoreOriginal' | 'recoverIfUnavailable'>;

/** One boundary for configured, stopped and unexpectedly lost routing cores. */
export class ProxyLifecycle {
  private revision = 0;
  private pending: Promise<boolean> = Promise.resolve(true);
  constructor(
    private core: { running(): boolean; pid(): number | undefined },
    private settings: () => Settings,
    private owner: Owner = SystemProxy,
  ) {}
  invalidate(): void { this.revision++; }
  configured(config: Record<string, any>): Promise<boolean> {
    const revision = ++this.revision, pid = this.core.pid();
    const settings = this.settings();
    const current = () => this.revision === revision && this.core.running() && this.core.pid() === pid;
    if (!current()) return this.pending = Promise.resolve(false);
    const port = config.inbounds?.find((i: any) => i.type === 'mixed')?.listen_port || settings.mixedPort;
    this.pending = settings.systemProxyEnabled
      ? this.owner.enable('127.0.0.1', port, settings.systemProxyBypassLan, settings.customBypassList,
        () => current() && this.settings().systemProxyEnabled)
      : this.owner.restoreOriginal();
    return this.pending;
  }
  unavailable(): Promise<boolean> {
    this.invalidate();
    return this.pending = this.owner.recoverIfUnavailable();
  }
  stop(): Promise<boolean> {
    this.invalidate();
    return this.pending = this.owner.restoreOriginal();
  }
  settled(): Promise<boolean> { return this.pending; }
}
