import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import http from 'http';
import {
  VpnAuthMethod,
  VpnProfile,
  VpnRuntime,
  VpnSnapshot,
  VpnState,
  VpnCertificate,
} from '../../types/corporateVpn';
import { ProfileRepository } from './ProfileRepository';
import { CredentialVault } from './CredentialVault';
import { CorporatePolicy } from './CorporatePolicy';
import { VpnCoreEvent, VpnCoreProcess } from './VpnCoreProcess';
import { physicalInterface } from './PhysicalInterface';

interface PublicCore {
  running(): boolean;
  pid(): number | undefined;
  settings(): {
    mixedPort: number;
    inboundAuth?: boolean;
    inboundUser?: string;
    inboundPass?: string;
    tunEnabled?: boolean;
  };
}
function signature(runtime: VpnRuntime): string {
  return JSON.stringify(
    runtime.profiles.map((r) => ({
      id: r.profile.id,
      port: r.profile.socksPort,
      dns: r.profile.dnsPort,
    })),
  );
}
export class CorporateVpnManager extends EventEmitter {
  private state: VpnState = { state: 'idle', generation: 0 };
  private registered = '';
  private configured = '';
  private connectionTimeout?: NodeJS.Timeout;
  private disposing = false;
  private mutation: Promise<unknown> = Promise.resolve();
  private desired?: { id: string; password: string };
  private retries = 0;
  private reconnectTimer?: NodeJS.Timeout;
  constructor(
    readonly profiles: ProfileRepository,
    readonly policy: CorporatePolicy,
    readonly vault: CredentialVault,
    readonly core: VpnCoreProcess,
    private publicCore: PublicCore,
    private retryDelays = [2000, 5000, 10000, 30000, 30000],
  ) {
    super();
    policy.prepare(profiles.list());
    core.on('event', (e: VpnCoreEvent) => {
      this.event(e).catch(() => {
        if (e.generation === this.state.generation)
          this.fail('POLICY_APPLY_FAILED');
      });
    });
    core.on('exit', () => {
      this.configured = '';
      if (
        !this.disposing &&
        !['idle', 'failed', 'reconnect_wait'].includes(this.state.state)
      )
        this.fail('CORE_EXITED');
    });
    core.on('fault', (code) =>
      this.fail(
        code === 'CORE_PIPE_CLOSED' ? 'CORE_EXITED' : 'CORE_PROTOCOL_INVALID',
      ),
    );
  }
  private change(next: Partial<VpnState>): void {
    this.state = { ...this.state, ...next };
    this.emit('state', this.snapshot().state);
  }
  snapshot(): VpnSnapshot {
    return {
      profiles: this.profiles.list(),
      state: {
        ...structuredClone(this.state),
        coreAvailable: this.core.available(),
        requiresCoreRebuild:
          signature(this.policy.runtime()) !== this.registered,
      },
      encryptionAvailable: this.vault.available(),
    };
  }
  private exclusive<T>(job: () => Promise<T> | T): Promise<T> {
    const p = this.mutation.then(job, job);
    this.mutation = p.catch(() => {});
    return p;
  }
  async save(
    input: unknown,
  ): Promise<{ profile: VpnProfile; requiresCoreRebuild: boolean }> {
    return this.exclusive(() => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入 再编辑配置');
      const p = this.profiles.save(input);
      // Credentials are bound to the complete gateway/protocol identity, not just a display name.
      if (!p.rememberPassword) this.vault.remove(`${p.id}:password:`);
      if (!p.rememberSession) this.vault.remove(`${p.id}:session:`);
      this.policy.prepare(this.profiles.list());
      this.emit('state', this.snapshot().state);
      return {
        profile: p,
        requiresCoreRebuild:
          signature(this.policy.runtime()) !== this.registered,
      };
    });
  }
  async remove(id: string): Promise<void> {
    return this.exclusive(() => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入');
      // Cached target guards remain until an explicit full policy application.
      this.profiles.remove(id);
      this.vault.remove(`${id}:`);
      this.policy.prepare(this.profiles.list());
      this.emit('state', this.snapshot().state);
    });
  }
  clearCredentials(id: string): void {
    this.profiles.get(id);
    this.vault.remove(`${id}:`);
  }
  reloadProfiles(): void {
    this.profiles.reload();
    this.policy.prepare(this.profiles.list());
    this.emit('state', this.snapshot().state);
  }
  private credentialKey(p: VpnProfile, kind: string): string {
    return `${p.id}:${kind}:${p.protocol}:${p.gateway.host}:${p.gateway.port}:${p.username}:${p.loginDomain}:${p.authMethod}`;
  }
  async prepareRuntime(
    allowReassign = false,
    attempt = 0,
  ): Promise<VpnRuntime> {
    const runtime = this.policy.prepare(this.profiles.list());
    if (!runtime.profiles.length) return runtime;
    await this.core.start();
    const next = signature(runtime);
    if (this.configured !== next) {
      try {
        await this.core.request(
          'configure',
          {
            endpoints: runtime.profiles.map((r) => ({
              profile: r.profile,
              user: r.socksUser,
              password: r.socksPassword,
            })),
          },
          10000,
        );
      } catch (e) {
        if (
          allowReassign &&
          attempt < 5 &&
          e instanceof Error &&
          e.message === 'LOCAL_PORT_IN_USE'
        ) {
          this.profiles.reassignPorts();
          this.emit('state', this.snapshot().state);
          return this.prepareRuntime(true, attempt + 1);
        }
        throw e;
      }
      this.configured = next;
    }
    return runtime;
  }
  publicCoreStarted(runtime: VpnRuntime): void {
    this.registered = signature(runtime);
    this.emit('state', this.snapshot().state);
  }
  publicCoreStopped(): void {
    this.registered = '';
    this.disconnect().catch(() => {});
  }
  async connect(id: string, password: string): Promise<void> {
    return this.connectInternal(id, password, false);
  }
  private async connectInternal(
    id: string,
    password: string,
    retry: boolean,
  ): Promise<void> {
    return this.exclusive(async () => {
      if (typeof password !== 'string' || password.length > 4096)
        throw new Error('密码格式不正确');
      if (!['idle', 'failed', 'reconnect_wait'].includes(this.state.state))
        throw new Error('已有公司连接正在进行');
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      if (!retry) {
        this.retries = 0;
        this.desired = undefined;
      }
      if (
        !this.publicCore.running() ||
        signature(this.policy.runtime()) !== this.registered
      )
        throw new Error('请先应用接入分流并启动公网连接');
      const p = this.profiles.get(id);
      const generation = this.state.generation + 1;
      this.change({
        state: 'starting',
        profileId: id,
        generation,
        error: undefined,
        challenge: undefined,
        resources: undefined,
      });
      try {
        await this.prepareRuntime();
        if (this.publicCore.settings().tunEnabled && !p.bindInterface)
          p.bindInterface = await physicalInterface();
        if (
          this.state.generation !== generation ||
          this.state.state !== 'starting'
        )
          return;
        if (!this.publicCore.running()) throw new Error('PUBLIC_CORE_CHANGED');
        const key = this.credentialKey(p, 'password');
        const secret = password || this.vault.get(key) || '';
        if (!secret && p.authMethod !== 'auth/smsCheckCode')
          throw new Error('请输入密码');
        this.desired = { id, password: secret };
        if (p.rememberPassword && password) this.vault.set(key, password);
        const session = p.rememberSession
          ? this.vault.get(this.credentialKey(p, 'session'))
          : undefined;
        this.core.send('connect', {
          profile: p,
          password: secret,
          session,
          generation,
          profileId: id,
        });
        this.change({ state: 'authenticating' });
        this.armTimeout(45000, generation);
      } catch (e) {
        if (this.state.generation !== generation) return;
        this.fail(e instanceof Error ? e.message : '连接准备失败');
        throw e;
      }
    });
  }
  async disconnect(preserveIntent = false): Promise<void> {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!preserveIntent) {
      this.desired = undefined;
      this.retries = 0;
    }
    const generation = this.state.generation + 1;
    if (this.core.isRunning()) this.core.send('disconnect', { generation });
    this.policy.deactivate(this.profiles.list());
    this.change({
      state: 'idle',
      generation,
      challenge: undefined,
      error: undefined,
    });
  }
  async discover(id: string): Promise<VpnAuthMethod[]> {
    return this.exclusive(async () => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入 再获取认证方式');
      const p = this.profiles.get(id);
      if (p.protocol !== 'atrust')
        throw new Error('仅 aTrust 需要发现认证方式');
      if (this.publicCore.settings().tunEnabled && !p.bindInterface)
        p.bindInterface = await physicalInterface();
      const e = await this.core.request(
        'discoverAuth',
        { profile: p, generation: this.state.generation },
        35000,
      );
      if (!Array.isArray(e.data) || e.data.length > 128)
        throw new Error('认证方式响应不正确');
      return e.data.map((x: any) => ({
        authType: String(x.authType).slice(0, 100),
        authName: String(x.authName).slice(0, 100),
        loginDomain: String(x.loginDomain).slice(0, 100),
        supported: x.supported === true,
      }));
    });
  }
  async certificate(id: string): Promise<VpnCertificate> {
    return this.exclusive(async () => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入');
      const p = this.profiles.get(id);
      if (this.publicCore.settings().tunEnabled && !p.bindInterface)
        p.bindInterface = await physicalInterface();
      const e = await this.core.request(
          'serverCertificate',
          { profile: p },
          15000,
        ),
        d = e.data;
      if (
        !d ||
        typeof d.fingerprint !== 'string' ||
        !/^\w{64}$/.test(d.fingerprint)
      )
        throw new Error('证书信息不正确');
      return {
        fingerprint: d.fingerprint,
        subject: String(d.subject).slice(0, 500),
        issuer: String(d.issuer).slice(0, 500),
        validTo: String(d.validTo).slice(0, 100),
        chainTrusted: d.chainTrusted === true,
      };
    });
  }
  respond(id: string, generation: number, value: string): void {
    const challenge = this.state.challenge;
    if (
      !challenge ||
      challenge.id !== id ||
      generation !== this.state.generation ||
      Date.now() > challenge.expiresAt ||
      typeof value !== 'string' ||
      !value ||
      value.length > 65536
    )
      throw new Error('AUTH_CHALLENGE_EXPIRED');
    this.core.send('respond', { challengeId: id, generation, value });
    this.change({ state: 'authenticating', challenge: undefined });
    this.armTimeout(45000, generation);
  }
  private armTimeout(ms: number, generation: number): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = setTimeout(() => {
      if (this.state.generation === generation) {
        this.core.send('disconnect', { generation });
        this.fail('AUTH_TIMEOUT');
      }
    }, ms);
  }
  private fail(error: string): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    const generation = this.state.generation + 1;
    if (this.core.isRunning()) this.core.send('disconnect', { generation });
    this.policy.deactivate(this.profiles.list());
    this.change({ state: 'failed', generation, error, challenge: undefined });
    if (
      this.desired &&
      !this.disposing &&
      ['CORE_EXITED', 'VPN_TRANSPORT_DOWN', 'GATEWAY_UNREACHABLE'].includes(
        error,
      ) &&
      this.retries < this.retryDelays.length &&
      this.publicCore.running()
    ) {
      const intent = this.desired,
        delay = this.retryDelays[this.retries++];
      this.change({ state: 'reconnect_wait' });
      this.reconnectTimer = setTimeout(() => {
        if (this.desired === intent && this.state.generation === generation)
          this.connectInternal(intent.id, intent.password, true).catch(() => {
            if (
              this.desired?.id === intent.id &&
              ['idle', 'reconnect_wait'].includes(this.state.state)
            )
              this.fail('CORE_EXITED');
          });
      }, delay);
    } else this.desired = undefined;
  }
  private async event(e: VpnCoreEvent): Promise<void> {
    if (
      e.generation !== this.state.generation ||
      e.profileId !== this.state.profileId
    )
      return;
    if (e.type === 'challenge') {
      const d = e.data;
      if (
        !d ||
        typeof d.id !== 'string' ||
        !['otp', 'sms', 'image', 'structured', 'confirm-sms'].includes(
          d.kind,
        ) ||
        typeof d.expiresAt !== 'number' ||
        d.expiresAt > Date.now() + 125000 ||
        typeof d.title !== 'string' ||
        (d.imageBase64 && d.imageBase64.length > 1500000)
      )
        throw new Error('Invalid challenge');
      this.change({
        state: 'waiting_user',
        challenge: {
          id: d.id,
          kind: d.kind,
          title: d.title,
          expiresAt: d.expiresAt,
          imageBase64:
            typeof d.imageBase64 === 'string' ? d.imageBase64 : undefined,
          mime: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
            d.mime,
          )
            ? d.mime
            : 'image/jpeg',
          profileId: e.profileId!,
          generation: e.generation,
        },
      });
      this.armTimeout(Math.max(1, d.expiresAt - Date.now()), e.generation);
    } else if (e.type === 'resources') {
      const revision = this.policy.update(
        e.profileId!,
        e.data,
        this.profiles.list(),
      );
      this.change({
        state: 'applying_policy',
        resources: this.policy.getResources(e.profileId!),
        revision,
      });
    } else if (e.type === 'tunnelReady') {
      this.change({ state: 'applying_policy' });
      const generation = e.generation,
        pid = this.publicCore.pid(),
        nonce = randomBytes(16).toString('hex');
      const profile = this.profiles.get(e.profileId!);
      this.core.send('setProbe', { generation, value: nonce });
      this.policy.setProbe(profile.id, nonce, this.profiles.list());
      await this.verifyPolicy(
        `${nonce}.${profile.id}.bluewing.invalid`,
        nonce,
        generation,
        pid,
      );
      if (this.state.generation !== generation) return;
      if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
      this.change({ state: 'connected', challenge: undefined });
      this.retries = 0;
    } else if (e.type === 'sessionUpdated') {
      const p = this.profiles.get(e.profileId!);
      if (
        p.rememberSession &&
        typeof e.data === 'string' &&
        e.data.length < 1024 * 1024
      )
        this.vault.set(this.credentialKey(p, 'session'), e.data);
    } else if (e.type === 'error') {
      this.fail(e.code || 'VPN_TRANSPORT_DOWN');
    }
  }
  private async verifyPolicy(
    host: string,
    nonce: string,
    generation: number,
    pid: number | undefined,
  ): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if (this.state.generation !== generation)
        throw new Error('AUTH_CANCELLED');
      if (!this.publicCore.running() || this.publicCore.pid() !== pid)
        throw new Error('PUBLIC_CORE_CHANGED');
      const settings = this.publicCore.settings();
      const result = await new Promise<string>((resolve) => {
        const headers: Record<string, string> = { Host: host };
        if (settings.inboundAuth)
          headers['Proxy-Authorization'] =
            'Basic ' +
            Buffer.from(
              `${settings.inboundUser}:${settings.inboundPass}`,
            ).toString('base64');
        const req = http.get(
          {
            host: '127.0.0.1',
            port: settings.mixedPort,
            path: `http://${host}:1/`,
            headers,
            agent: false,
          },
          (res) => {
            let body = '';
            res.on('data', (b) => {
              body += b;
              if (body.length > 256) res.destroy();
            });
            res.on('end', () => resolve(body));
            res.on('error', () => resolve(''));
          },
        );
        req.setTimeout(500, () => req.destroy());
        req.on('error', () => resolve(''));
      });
      if (result === nonce) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('POLICY_APPLY_FAILED');
  }
  async dispose(): Promise<void> {
    this.disposing = true;
    await this.disconnect();
    await this.core.stop();
  }
}
