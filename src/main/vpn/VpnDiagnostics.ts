import fs from 'fs';
import path from 'path';
import { VpnProfile } from '../../types/corporateVpn';

/** Local-only records. Input values are recorded only after explicit full-mode opt-in. */
export class VpnDiagnostics {
  private modes = new Map<string, VpnProfile['diagnosticMode']>();
  private errors = new Map<string, string>();
  private folder: string;
  constructor(dir: string, private maxBytes = 10 * 1024 * 1024) {
    this.folder = path.resolve(dir, 'logs', 'vpn');
  }
  file(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('日志配置 ID 不正确');
    const file = path.join(this.folder, `${id}.log`);
    if (path.dirname(file) !== this.folder) throw new Error('日志路径不正确');
    return file;
  }
  info(profile: VpnProfile) {
    const file = this.file(profile.id);
    return { exists: fs.existsSync(file), path: file, mode: profile.diagnosticMode || 'off', error: this.errors.get(profile.id) };
  }
  begin(profile: VpnProfile, generation: number) {
    this.modes.set(profile.id, profile.diagnosticMode || 'off');
    this.write(profile.id, { event: 'connection-start', generation, protocol: profile.protocol,
      gateway: profile.gateway, username: profile.username, loginDomain: profile.loginDomain,
      authMethod: profile.authMethod, authName: profile.authName, diagnosticMode: profile.diagnosticMode || 'off' });
  }
  input(id: string, kind: 'password' | 'verification-code', value: string) {
    if (this.modes.get(id) === 'full') this.write(id, { event: 'submitted-input', kind, value });
  }
  trace(id: string, detail: unknown) {
    if (['detail', 'full'].includes(this.modes.get(id) || '')) this.write(id, { event: 'native-trace', detail });
  }
  write(id: string, detail: Record<string, unknown>) {
    try {
      const file = this.file(id);
      fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      if (fs.existsSync(file) && fs.statSync(file).size >= this.maxBytes) {
        const previous = `${file}.1`;
        fs.rmSync(previous, { force: true });
        fs.renameSync(file, previous);
      }
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
      this.errors.delete(id);
    } catch (e) {
      this.errors.set(id, e instanceof Error ? e.message : String(e));
    }
  }
  clear(id: string) {
    const file = this.file(id);
    for (const target of [file, `${file}.1`]) fs.rmSync(target, { force: true });
    this.errors.delete(id);
  }
}
