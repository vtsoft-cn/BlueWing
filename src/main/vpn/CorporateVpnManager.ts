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
import { gatewayTrust } from './GatewayTrust';
import { VpnDiagnostics } from './VpnDiagnostics';

interface PublicCore {
  running(): boolean;
  pid(): number | undefined;
  applyRouting?(isCurrent: () => boolean): Promise<boolean>;
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
    [...runtime.profiles].sort((a, b) => a.profile.id.localeCompare(b.profile.id)).map((r) => ({
      id: r.profile.id,
      port: r.profile.socksPort,
      dns: r.profile.dnsPort,
      trafficMode: r.profile.trafficMode || 'split',
      customRouting: r.profile.customRouting,
      autoDiscoverPrivate: r.profile.autoDiscoverPrivate !== false,
    })),
  );
}
export class CorporateVpnManager extends EventEmitter {
  readonly diagnostics: VpnDiagnostics;
  private state: VpnState = { state: 'idle', generation: 0 };
  private registered = '';
  private configured = '';
  private connectionTimeout?: NodeJS.Timeout;
  private timeoutRevision = 0;
  private disposing = false;
  private mutation: Promise<unknown> = Promise.resolve();
  private desired?: { id: string; password: string };
  private retries = 0;
  private sessionWasReady = false;
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
    this.diagnostics = new VpnDiagnostics(profiles.dir);
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
        trafficProtected: this.policy.isProtected(this.state.profileId),
        coreAvailable: this.core.available(),
        requiresCoreRebuild:
          signature(this.policy.runtime()) !== this.registered,
      },
      encryptionAvailable: this.vault.available(),
      diagnostics: Object.fromEntries(this.profiles.list().map(p => [p.id, this.diagnostics.info(p)])),
      discoveredTargets: Object.fromEntries(this.profiles.list().map(p => [p.id, this.policy.discovery.targets(p)])),
      passwordSaved: Object.fromEntries(
        this.profiles
          .list()
          .map((p) => [
            p.id,
            p.rememberPassword &&
              this.vault.has(this.credentialKey(p, 'password')),
          ]),
      ),
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
      let value = input as VpnProfile;
      const before = this.profiles.list().find((p) => p.id === value?.id);
      if (
        before &&
        (before.protocol !== value.protocol ||
          before.gateway.host !== value.gateway?.host ||
          before.gateway.port !== value.gateway?.port ||
          before.tls.serverName !== value.tls?.serverName ||
          before.tls.caPem !== value.tls?.caPem)
      ) {
        const tls = { ...value.tls };
        if (
          before.tls.autoTrustAnchor === 'pin' &&
          tls.pinSha256 === before.tls.pinSha256
        )
          delete tls.pinSha256;
        delete tls.autoTrustAnchor;
        value = { ...value, tls };
      }
      if (before && (before.protocol !== value.protocol || before.gateway.host !== value.gateway?.host || before.gateway.port !== value.gateway?.port))
        value = { ...value, authChoices: [], authName: '' };
      const p = this.profiles.save(value);
      if (this.state.profileId === p.id) this.policy.deactivate(this.profiles.list());
      // Credentials are bound to the complete gateway/protocol identity, not just a display name.
      if (!p.rememberPassword) this.vault.remove(`${p.id}:password:`);
      if (!p.rememberSession) this.vault.remove(`${p.id}:session:`);
      this.policy.prepare(this.profiles.list());
      if (this.state.profileId === p.id) this.change({ error: undefined, errorDetail: undefined, state: 'idle' });
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
      // Revoke watched files immediately, even before the public core reloads.
      this.profiles.remove(id);
      this.policy.discovery.clear(id);
      this.vault.remove(`${id}:`);
      this.policy.prepare(this.profiles.list());
      this.emit('state', this.snapshot().state);
    });
  }
  clearCredentials(id: string): void {
    this.profiles.get(id);
    this.vault.remove(`${id}:`);
    this.emit('state', this.snapshot().state);
  }
  async savePassword(
    id: string,
    password: string,
    remember: boolean,
  ): Promise<void> {
    return this.exclusive(() => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开 VPN 再修改保存的密码');
      if (
        typeof password !== 'string' ||
        password.length > 4096 ||
        typeof remember !== 'boolean'
      )
        throw new Error('密码保存参数不正确');
      const profile = this.profiles.get(id);
      if (remember) {
        if (!this.vault.available())
          throw new Error(
            'CREDENTIAL_STORE_LOCKED：系统加密不可用，无法记住密码',
          );
        if (password)
          this.vault.set(this.credentialKey(profile, 'password'), password);
      } else this.vault.remove(`${id}:password:`);
      this.profiles.save({ ...profile, rememberPassword: remember });
      this.emit('state', this.snapshot().state);
    });
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
    // A failed routing startup is reported by the awaiting connect operation.
    // Explicit public-core stops cancel the VPN intent in handleCoreStop first.
    if (this.state.state === 'starting' && this.state.preparingRouting) return;
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
        this.sessionWasReady = false;
      }
      let p = this.profiles.get(id);
      const needsRouting = !this.publicCore.running() || signature(this.policy.runtime()) !== this.registered;
      this.clearConnectionTimeout();
      const generation = this.state.generation + 1;
      this.diagnostics.begin(p, generation);
      this.change({
        state: 'starting',
        profileId: id,
        generation,
        error: undefined,
        errorDetail: undefined,
        challenge: undefined,
        resources: undefined,
        preparingRouting: needsRouting,
      });
      const isCurrent = () => this.state.generation === generation && this.state.state === 'starting';
      try {
        const key = this.credentialKey(p, 'password');
        const secret = password || (p.rememberPassword ? this.vault.get(key) : undefined) || '';
        if (!secret && p.authMethod !== 'auth/smsCheckCode') throw new Error('请输入密码');
        this.policy.begin(p.id, this.profiles.list());
        if (needsRouting) {
          const applied = await this.publicCore.applyRouting?.(isCurrent);
          if (!isCurrent()) return;
          if (!applied || !this.publicCore.running() || signature(this.policy.runtime()) !== this.registered)
            throw new Error('ROUTING_PREPARE_FAILED');
          p = this.profiles.get(id); // A new endpoint may have been reassigned during preparation.
        }
        this.change({ preparingRouting: false });
        await this.prepareRuntime();
        if (this.publicCore.settings().tunEnabled && !p.bindInterface)
          p.bindInterface = await physicalInterface();
        if (
          this.state.generation !== generation ||
          this.state.state !== 'starting'
        )
          return;
        if (!this.publicCore.running()) throw new Error('PUBLIC_CORE_CHANGED');
        p = await this.trustedProfile(p, generation);
        if (
          this.state.generation !== generation ||
          this.state.state !== 'starting'
        )
          return;
        this.diagnostics.input(id, 'password', secret);
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
    this.clearConnectionTimeout();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!preserveIntent) {
      this.desired = undefined;
      this.retries = 0;
      this.sessionWasReady = false;
    }
    const generation = this.state.generation + 1;
    if (this.core.isRunning()) this.core.send('disconnect', { generation });
    this.policy.deactivate(this.profiles.list(), preserveIntent);
    this.change({
      state: 'idle',
      generation,
      challenge: undefined,
      error: undefined,
      errorDetail: undefined,
      preparingRouting: false,
    });
  }
  async discover(id: string): Promise<VpnAuthMethod[]> {
    return this.exclusive(async () => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入 再获取认证方式');
      let p = this.profiles.get(id);
      if (p.protocol !== 'atrust')
        throw new Error('仅 aTrust 需要发现认证方式');
      if (this.publicCore.settings().tunEnabled && !p.bindInterface)
        p.bindInterface = await physicalInterface();
      p = await this.trustedProfile(p, this.state.generation);
      const e = await this.core.request(
        'discoverAuth',
        { profile: p, generation: this.state.generation },
        35000,
      );
      if (!Array.isArray(e.data) || e.data.length > 128)
        throw new Error('认证方式响应不正确');
      const methods: VpnAuthMethod[] = e.data.map((x: any) => ({
        authType: String(x.authType).slice(0, 100),
        authName: String(x.authName).slice(0, 100),
        loginDomain: String(x.loginDomain).slice(0, 100),
        supported: x.supported === true,
      }));
      const latest = this.profiles.get(id);
      const selected = methods.find(m => m.loginDomain === latest.loginDomain && m.authType === latest.authMethod);
      this.profiles.save({ ...latest, authChoices: methods, authName: selected?.authName || latest.authName });
      this.emit('state', this.snapshot().state);
      return methods;
    });
  }
  async certificate(id: string): Promise<VpnCertificate> {
    return this.exclusive(async () => {
      if (!['idle', 'failed'].includes(this.state.state))
        throw new Error('请先断开VPN 接入');
      return this.inspectCertificate(this.profiles.get(id));
    });
  }
  private async trustedProfile(
    profile: VpnProfile,
    generation: number,
  ): Promise<VpnProfile> {
    if (profile.tls.trustMode === 'strict') return profile;
    const certificate = await this.inspectCertificate(profile);
    if (this.state.generation !== generation) throw new Error('AUTH_CANCELLED');
    const tls = gatewayTrust(profile.tls, certificate);
    if (JSON.stringify(tls) !== JSON.stringify(profile.tls)) {
      const saved = this.profiles.save({
        ...this.profiles.get(profile.id),
        tls,
      });
      this.emit('state', this.snapshot().state);
      return { ...saved, bindInterface: profile.bindInterface };
    }
    return profile;
  }
  private async inspectCertificate(p: VpnProfile): Promise<VpnCertificate> {
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
      !/^[a-fA-F0-9]{64}$/.test(d.fingerprint)
    )
      throw new Error('证书信息不正确');
    return {
      fingerprint: d.fingerprint,
      subject: String(d.subject).slice(0, 500),
      issuer: String(d.issuer).slice(0, 500),
      validTo: String(d.validTo).slice(0, 100),
      chainTrusted: d.chainTrusted === true,
      validFrom:
        typeof d.validFrom === 'string' ? d.validFrom.slice(0, 100) : undefined,
      dnsNames: Array.isArray(d.dnsNames)
        ? d.dnsNames
            .filter((v: unknown) => typeof v === 'string')
            .slice(0, 128)
            .map((v: string) => v.slice(0, 253))
        : [],
      ipAddresses: Array.isArray(d.ipAddresses)
        ? d.ipAddresses
            .filter((v: unknown) => typeof v === 'string')
            .slice(0, 128)
            .map((v: string) => v.slice(0, 64))
        : [],
      trustIssues: Array.isArray(d.trustIssues)
        ? d.trustIssues.filter((v: unknown) =>
            [
              'UNTRUSTED_AUTHORITY',
              'NAME_MISMATCH',
              'EXPIRED',
              'NOT_YET_VALID',
              'INVALID_CA',
              'CHAIN_INVALID',
            ].includes(String(v)),
          )
        : [],
    };
  }
  respond(id: string, generation: number, value: string): void {
    const challenge = this.state.challenge;
    if (
      !challenge ||
      this.state.state !== 'waiting_user' ||
      challenge.id !== id ||
      challenge.profileId !== this.state.profileId ||
      challenge.generation !== generation ||
      generation !== this.state.generation ||
      Date.now() >= challenge.expiresAt ||
      typeof value !== 'string' ||
      !value ||
      value.length > 65536
    )
      throw new Error('AUTH_CHALLENGE_EXPIRED');
    if (this.state.profileId && challenge.kind !== 'confirm-sms') this.diagnostics.input(this.state.profileId, 'verification-code', value);
    this.core.send('respond', { challengeId: id, generation, value });
    this.change({ state: 'authenticating', challenge: undefined });
    this.armTimeout(45000, generation);
  }
  private clearConnectionTimeout(): void {
    this.timeoutRevision++;
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = undefined;
  }
  private armTimeout(ms: number, generation: number, code = 'AUTH_TIMEOUT'): void {
    this.clearConnectionTimeout();
    const revision = this.timeoutRevision;
    this.connectionTimeout = setTimeout(() => {
      if (this.state.generation === generation && this.timeoutRevision === revision) {
        this.fail(code);
      }
    }, ms);
  }
  private fail(error: string, errorDetail?: VpnState['errorDetail']): void {
    this.clearConnectionTimeout();
    const generation = this.state.generation + 1;
    if (this.core.isRunning()) this.core.send('disconnect', { generation });
    const keepGuard = this.sessionWasReady || (!!this.desired && ['CORE_EXITED', 'VPN_TRANSPORT_DOWN', 'GATEWAY_UNREACHABLE'].includes(error));
    this.policy.deactivate(this.profiles.list(), keepGuard);
    if (this.state.profileId) this.diagnostics.write(this.state.profileId, { event: 'connection-error', generation: this.state.generation, code: error, ...errorDetail });
    this.change({ state: 'failed', generation, error, errorDetail, challenge: undefined, preparingRouting: false });
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
    if (e.type === 'diagnostic') {
      if (e.data && typeof e.data === 'object') this.diagnostics.trace(e.profileId!, e.data);
    } else if (e.type === 'privateRouteObserved') {
      if (!['connected', 'applying_policy'].includes(this.state.state)) return;
      try {
        if (this.policy.learn(e.profileId!, e.data, this.profiles.list())) {
          this.diagnostics.write(e.profileId!, { event: 'private-route-observed', address: e.data.address, port: e.data.port, outlet: e.data.outlet });
          this.change({});
        }
      } catch (error) {
        this.diagnostics.write(e.profileId!, { event: 'private-route-cache-error', message: error instanceof Error ? error.message : String(error) });
      }
    } else if (e.type === 'challenge') {
      const d = e.data;
      if (!['starting', 'authenticating', 'waiting_user'].includes(this.state.state)) return;
      if (
        !d ||
        typeof d.id !== 'string' ||
        !['otp', 'sms', 'image', 'structured', 'confirm-sms'].includes(
          d.kind,
        ) ||
        typeof d.expiresAt !== 'number' ||
        !Number.isFinite(d.expiresAt) ||
        d.expiresAt > Date.now() + 125000 ||
        typeof d.title !== 'string' ||
        (d.imageBase64 && d.imageBase64.length > 1500000)
      )
        throw new Error('Invalid challenge');
      // Replayed/expired prompts never replace the current round or extend its deadline.
      if (d.expiresAt <= Date.now() || this.state.challenge?.id === d.id) return;
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
      this.armTimeout(Math.max(1, d.expiresAt - Date.now()), e.generation, 'AUTH_CHALLENGE_EXPIRED');
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
      this.sessionWasReady = true;
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
      this.clearConnectionTimeout();
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
      const d = e.data;
      const detail = d && typeof d.message === 'string' && typeof d.stage === 'string'
        ? { stage: d.stage, message: d.message, serverCode: typeof d.serverCode === 'string' ? d.serverCode : undefined } : undefined;
      this.fail(e.code || 'VPN_TRANSPORT_DOWN', detail);
    }
  }
  diagnosticFile(id: string): string {
    const info = this.diagnostics.info(this.profiles.get(id));
    if (!info.exists) throw new Error('尚无诊断日志，请先尝试连接');
    return info.path;
  }
  clearDiagnostics(id: string): void {
    this.profiles.get(id);
    this.diagnostics.clear(id);
    this.emit('state', this.snapshot().state);
  }
  async clearDiscoveredTargets(id: string): Promise<void> {
    return this.exclusive(() => {
      if (!['idle', 'failed'].includes(this.state.state)) throw new Error('请先断开 VPN 再清空自动识别记录');
      this.policy.clearDiscovered(this.profiles.get(id), this.profiles.list());
      this.change({});
    });
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
