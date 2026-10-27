import { EventEmitter } from 'events';
import path from 'path';
import { VpnProfile, VpnRuntime, VpnSnapshot, VpnState } from '../../types/corporateVpn';
import { ProfileRepository } from './ProfileRepository';
import { CorporatePolicy } from './CorporatePolicy';
import { CredentialVault } from './CredentialVault';
import { VpnCoreProcess } from './VpnCoreProcess';
import { CorporateVpnSession, PublicCore, signature } from './CorporateVpnSession';
import { PrivateRouteProxy } from './PrivateRouteProxy';
import { VpnDiagnostics } from './VpnDiagnostics';
import { orderedVpnProfiles } from '../../utils/vpnRouting';

/** One native process per profile: upstream TLS/auth globals never cross companies. */
export class CorporateVpnManager extends EventEmitter {
  readonly diagnostics: VpnDiagnostics;
  private sessions = new Map<string, CorporateVpnSession>();
  private editor?: CorporateVpnSession;
  private seedUsed = false;
  private registered = '';
  private registeredRuntime?: VpnRuntime;
  private mutation: Promise<unknown> = Promise.resolve();
  private privateProxy: PrivateRouteProxy;
  private disposing = false;
  constructor(
    readonly profiles: ProfileRepository,
    readonly policy: CorporatePolicy,
    readonly vault: CredentialVault,
    readonly core: VpnCoreProcess,
    private publicCore: PublicCore,
    private retryDelays?: number[],
    private createCore?: (id: string) => VpnCoreProcess,
  ) {
    super();
    this.diagnostics = new VpnDiagnostics(profiles.dir);
    policy.prepare(profiles.list());
    this.privateProxy = new PrivateRouteProxy(() => policy.runtime().profiles
      .filter(r => policy.isActive(r.profile.id) && (r.profile.trafficMode || 'split') === 'split' && r.profile.autoDiscoverPrivate !== false)
      .map(r => ({ id: r.profile.id, port: r.profile.socksPort, user: r.socksUser, password: r.socksPassword,
        generation: this.sessions.get(r.profile.id)?.snapshot().state.generation ?? 0 })), 3500, 15000,
      () => !this.publicCore.settings().tunEnabled,
      (host, port) => {
        let changed = false;
        for (const r of policy.runtime().profiles) {
          try { changed = policy.learn(r.profile.id, { address: host, port, network: 'tcp', outlet: 'direct' }, profiles.list()) || changed; } catch { /* Cache writes cannot interrupt a local flow. */ }
        }
        if (changed) this.changed();
      });
  }
  private changed(): void { if (!this.disposing) this.emit('state', this.snapshot().state); }
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(job, job); this.mutation = next.catch(() => {}); return next;
  }
  private session(id: string): CorporateVpnSession {
    this.profiles.get(id);
    let session = this.sessions.get(id);
    if (!session) {
      const core = this.createCore ? this.createCore(id) : !this.seedUsed ? this.core : new VpnCoreProcess(this.core.binary);
      this.seedUsed = true;
      session = new CorporateVpnSession(this.profiles, this.policy, this.vault, core, this.publicCore, this.retryDelays, id);
      this.sessions.set(id, session);
      session.on('state', () => this.changed());
      if (this.registeredRuntime) session.publicCoreStarted(this.registeredRuntime);
    }
    return session;
  }
  private editorSession(): CorporateVpnSession {
    if (!this.editor) {
      this.editor = new CorporateVpnSession(this.profiles, this.policy, this.vault, new VpnCoreProcess(this.core.binary), this.publicCore, this.retryDelays, '__editor__');
      this.editor.on('state', () => this.changed());
    }
    return this.editor;
  }
  private requireEditable(id?: string): void {
    const state = id && this.sessions.get(id)?.snapshot().state.state;
    if (state && !['idle', 'failed'].includes(state)) throw new Error('请先断开此 VPN 再修改配置，其他接入不受影响');
  }
  snapshot(): VpnSnapshot {
    const profiles = orderedVpnProfiles(this.profiles.list());
    const requiresCoreRebuild = signature(this.policy.runtime()) !== this.registered;
    const states = Object.fromEntries(profiles.map(p => [p.id, this.sessions.get(p.id)?.snapshot().state
      ?? { state: 'idle' as const, generation: 0, coreAvailable: this.core.available(), trafficProtected: false, requiresCoreRebuild }]));
    const rank: Record<VpnState['state'], number> = { waiting_user: 0, starting: 1, authenticating: 2, applying_policy: 3, reconnect_wait: 4, connected: 5, stopping: 6, failed: 7, idle: 8 };
    const aggregate = Object.values(states).sort((a, b) => rank[a.state] - rank[b.state])[0] || { state: 'idle' as const, generation: 0 };
    return {
      profiles, states, defaultProfileId: profiles.find(p => this.policy.isActive(p.id))?.id,
      state: { ...aggregate, requiresCoreRebuild, coreAvailable: this.core.available() }, encryptionAvailable: this.vault.available(),
      passwordSaved: Object.fromEntries(profiles.map(p => [p.id, p.rememberPassword && this.vault.has(`${p.id}:password:${p.protocol}:${p.gateway.host}:${p.gateway.port}:${p.username}:${p.loginDomain}:${p.authMethod}`)])),
      diagnostics: Object.fromEntries(profiles.map(p => [p.id, this.diagnostics.info(p)])),
      discoveredTargets: Object.fromEntries(profiles.map(p => [p.id, this.policy.discovery.targets(p)])),
    };
  }
  async prepareRuntime(_allowReassign = false): Promise<VpnRuntime> {
    if (this.disposing) throw new Error('VPN_MANAGER_STOPPING');
    const runtime = this.policy.prepare(this.profiles.list());
    if (runtime.profiles.length) {
      const endpoint = await this.privateProxy.start();
      this.policy.setPrivateProxy({ ...endpoint, rulePath: path.join(this.profiles.dir, 'vpn-runtime', 'private-discovery-active.json') }, this.profiles.list());
    }
    return this.policy.runtime();
  }
  publicCoreStarted(runtime: VpnRuntime): void {
    this.registeredRuntime = runtime; this.registered = signature(runtime);
    for (const session of this.sessions.values()) session.publicCoreStarted(runtime);
    this.changed();
  }
  publicCoreStopped(): void {
    this.registered = ''; this.registeredRuntime = undefined;
    for (const session of this.sessions.values()) session.publicCoreStopped();
    this.changed();
  }
  async connect(id: string, password: string): Promise<void> {
    return this.exclusive(async () => { if (this.disposing) throw new Error('VPN_MANAGER_STOPPING'); await this.prepareRuntime(); await this.session(id).connect(id, password); });
  }
  async disconnect(id?: string): Promise<void> {
    if (id) {
      this.profiles.get(id);
      const session = this.sessions.get(id);
      if (session) await session.disconnect();
      else this.policy.deactivate(this.profiles.list(), false, id);
    } else {
      await Promise.all([...this.sessions.values()].map(session => session.disconnect()));
      this.policy.deactivate(this.profiles.list());
    }
    this.changed();
  }
  async save(input: unknown): Promise<{ profile: VpnProfile; requiresCoreRebuild: boolean }> {
    return this.exclusive(async () => {
      const id = (input as VpnProfile)?.id; this.requireEditable(id);
      const result = await (id && this.sessions.get(id) || this.editorSession()).save(input);
      this.changed(); return { ...result, requiresCoreRebuild: signature(this.policy.runtime()) !== this.registered };
    });
  }
  async remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.requireEditable(id); await this.editorSession().remove(id);
      const session = this.sessions.get(id); this.sessions.delete(id); await session?.dispose(); this.changed();
    });
  }
  reloadProfiles(): void {
    this.profiles.reload(); const ids = new Set(this.profiles.list().map(p => p.id));
    for (const [id, session] of this.sessions) if (!ids.has(id)) { this.sessions.delete(id); session.dispose().catch(() => {}); }
    this.policy.prepare(this.profiles.list()); this.changed();
  }
  async discover(id: string) { this.requireEditable(id); return this.session(id).discover(id); }
  async certificate(id: string) { this.requireEditable(id); return this.session(id).certificate(id); }
  respond(id: string, generation: number, value: string, profileId?: string): void {
    const matches = [...this.sessions.values()].filter(s => { const c = s.snapshot().state.challenge; return c?.id === id && c.generation === generation && (!profileId || c.profileId === profileId); });
    if (matches.length !== 1) throw new Error('AUTH_CHALLENGE_EXPIRED');
    matches[0].respond(id, generation, value);
  }
  clearCredentials(id: string): void { this.requireEditable(id); this.session(id).clearCredentials(id); }
  async savePassword(id: string, password: string, remember: boolean): Promise<void> { this.requireEditable(id); await this.session(id).savePassword(id, password, remember); }
  diagnosticFile(id: string): string { const info = this.diagnostics.info(this.profiles.get(id)); if (!info.exists) throw new Error('尚无诊断日志，请先尝试连接'); return info.path; }
  clearDiagnostics(id: string): void { this.profiles.get(id); this.diagnostics.clear(id); this.changed(); }
  async clearDiscoveredTargets(id: string): Promise<void> { this.requireEditable(id); this.policy.clearDiscovered(this.profiles.get(id), this.profiles.list()); this.changed(); }
  async dispose(): Promise<void> {
    this.disposing = true; await this.disconnect();
    await Promise.all([...this.sessions.values()].map(session => session.dispose()));
    await this.editor?.dispose(); await this.privateProxy.stop(); this.sessions.clear();
  }
}
