import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Fingerprint,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  VpnAuthMethod,
  VpnCertificate,
  VpnProfile,
} from '../../types/corporateVpn';
import { vpnProviderList, vpnProviders } from '../vpn/providers';
import { Portal } from './Portal';
import { toast } from './Toast';

const lines = (value: string) =>
  value
    .split(/[\s,;，；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
export const newVpnProfile = (): VpnProfile => ({
  id: '',
  name: '',
  protocol: 'easyconnect',
  gateway: { host: '', port: 10443 },
  username: '',
  authMethod: 'auth/psw',
  loginDomain: '',
  rememberPassword: false,
  rememberSession: false,
  tls: {},
  targets: [],
  hosts: {},
  bindInterface: '',
  socksPort: 0,
  dnsPort: 0,
});
const tabs = [
  { id: 'connection', name: '连接设置', icon: KeyRound },
  { id: 'routing', name: '分流范围', icon: Network },
  { id: 'advanced', name: '高级选项', icon: Settings2 },
] as const;

export function VpnProfileEditor({
  profile,
  encryptionAvailable,
  onClose,
  onSaved,
  onRemoved,
}: {
  profile: VpnProfile;
  encryptionAvailable: boolean;
  onClose: () => void;
  onSaved: (profile: VpnProfile, keepOpen?: boolean) => Promise<void>;
  onRemoved: () => Promise<void>;
}) {
  const [form, setForm] = useState(() => structuredClone(profile));
  const [domains, setDomains] = useState(
    profile.targets.flatMap((t) => t.domains).join('\n'),
  );
  const [cidrs, setCidrs] = useState(
    profile.targets.flatMap((t) => t.cidrs).join('\n'),
  );
  const [hosts, setHosts] = useState(
    Object.entries(profile.hosts)
      .flatMap(([d, ips]) => ips.map((ip) => `${d} ${ip}`))
      .join('\n'),
  );
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('connection');
  const [methods, setMethods] = useState<VpnAuthMethod[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<'discard' | 'delete'>();
  const root = useRef<HTMLDivElement>(null);
  const initial = useRef(JSON.stringify({ form, domains, cidrs, hosts }));
  const dirty =
    JSON.stringify({ form, domains, cidrs, hosts }) !== initial.current;
  const provider = vpnProviders[form.protocol];
  const savedGateway =
    !!profile.id &&
    profile.protocol === form.protocol &&
    profile.gateway.host === form.gateway.host &&
    profile.gateway.port === form.gateway.port;
  const close = () => {
    if (!busy) {
      if (dirty) setConfirmation('discard');
      else onClose();
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmation) setConfirmation(undefined);
        else close();
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  });
  const run = async (operation: string, job: () => Promise<void>) => {
    setBusy(operation);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };
  const persist = async () => {
    if (
      !form.name.trim() ||
      !form.gateway.host.trim() ||
      !Number.isInteger(form.gateway.port) ||
      form.gateway.port < 1 ||
      form.gateway.port > 65535
    ) {
      setTab('connection');
      throw new Error('请填写配置名称、网关地址和有效端口。');
    }
    const fixed: Record<string, string[]> = {};
    for (const row of hosts
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const parts = row.split(/\s+/);
      if (parts.length !== 2) {
        setTab('routing');
        throw new Error('固定解析请按「域名 IP」填写，每行一条。');
      }
      (fixed[parts[0]] ??= []).push(parts[1]);
    }
    const unchanged =
      JSON.stringify(lines(domains)) ===
        JSON.stringify(profile.targets.flatMap((t) => t.domains)) &&
      JSON.stringify(lines(cidrs)) ===
        JSON.stringify(profile.targets.flatMap((t) => t.cidrs));
    const result = await window.electronAPI.corporateVpn.save({
      ...form,
      hosts: fixed,
      targets: unchanged
        ? profile.targets
        : [
            ...(lines(domains).length
              ? [
                  {
                    domains: [...new Set(lines(domains))],
                    cidrs: [],
                    network: 'tcp' as const,
                  },
                ]
              : []),
            ...(lines(cidrs).length
              ? [
                  {
                    domains: [],
                    cidrs: [...new Set(lines(cidrs))],
                    network: 'tcp' as const,
                  },
                ]
              : []),
          ],
    });
    setForm(result.profile);
    initial.current = JSON.stringify({
      form: result.profile,
      domains,
      cidrs,
      hosts,
    });
    return result;
  };
  const save = async () => {
    const result = await persist();
    await onSaved(result.profile);
    toast.success(
      result.requiresCoreRebuild
        ? '配置已保存，请应用接入分流后连接'
        : '接入配置已保存',
    );
  };
  return (
    <Portal>
      <div
        className="vpn-modal-backdrop no-drag"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div
          ref={root}
          className="vpn-surface vpn-editor"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vpn-editor-title"
          data-vpn-editor
        >
          <header className="vpn-editor-header">
            <div className="vpn-heading-icon">
              <Network size={21} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 id="vpn-editor-title">
                {profile.id ? '编辑接入' : '新增 VPN 接入'}
              </h2>
              <p>设置连接方式与需要通过 VPN 访问的资源</p>
            </div>
            <button
              type="button"
              className="vpn-icon-button"
              aria-label="关闭接入设置"
              disabled={!!busy}
              onClick={close}
            >
              <X size={19} />
            </button>
          </header>
          <div
            className="vpn-editor-tabs"
            role="tablist"
            aria-label="接入设置分类"
          >
            {tabs.map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                id={`vpn-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`vpn-panel-${id}`}
                onClick={() => setTab(id)}
              >
                <Icon size={16} />
                {name}
              </button>
            ))}
          </div>
          <form
            className="vpn-editor-form"
            onSubmit={(e) => {
              e.preventDefault();
              run('save', save);
            }}
          >
            <div className="vpn-editor-body">
              {error && (
                <div className="vpn-notice danger" role="alert">
                  {error}
                </div>
              )}
              <fieldset
                disabled={!!busy}
                className="min-w-0 disabled:opacity-60"
              >
                <section
                  role="tabpanel"
                  id="vpn-panel-connection"
                  aria-labelledby="vpn-tab-connection"
                  hidden={tab !== 'connection'}
                  className="vpn-editor-section"
                >
                  <div className="vpn-field">
                    <span className="vpn-field-label">接入协议</span>
                    <div
                      className="vpn-provider-options"
                      role="group"
                      aria-label="接入协议"
                    >
                      {vpnProviderList.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          className="vpn-provider-option"
                          aria-pressed={form.protocol === item.id}
                          onClick={() => {
                            setForm({
                              ...form,
                              protocol: item.id,
                              authMethod: 'auth/psw',
                              loginDomain: '',
                              rememberSession:
                                item.deviceSession && form.rememberSession,
                            });
                            setMethods([]);
                          }}
                        >
                          <span className={`vpn-provider-mark ${item.tone}`}>
                            {item.mark}
                          </span>
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.description}</small>
                          </span>
                          {form.protocol === item.id && (
                            <Check size={17} className="vpn-provider-check" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="vpn-field">
                    <span>
                      配置名称 <em>*</em>
                    </span>
                    <input
                      className="vpn-input"
                      aria-label="配置名称"
                      placeholder="例如：办公网络、研发环境"
                      maxLength={100}
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </label>
                  <div className="vpn-gateway-fields">
                    <label className="vpn-field">
                      <span>
                        网关地址 <em>*</em>
                      </span>
                      <input
                        className="vpn-input font-mono"
                        aria-label="网关地址"
                        placeholder="vpn.example.com"
                        value={form.gateway.host}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            gateway: { ...form.gateway, host: e.target.value },
                          })
                        }
                      />
                      <small>填写域名或 IP，不含 https://</small>
                    </label>
                    <label className="vpn-field">
                      <span>
                        端口 <em>*</em>
                      </span>
                      <input
                        type="number"
                        aria-label="网关端口"
                        min={1}
                        max={65535}
                        className="vpn-input font-mono"
                        value={form.gateway.port}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            gateway: {
                              ...form.gateway,
                              port: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="vpn-field">
                    <span>
                      {form.authMethod === 'auth/smsCheckCode'
                        ? '账号 / 手机号'
                        : '登录账号'}
                    </span>
                    <input
                      className="vpn-input"
                      aria-label="登录账号"
                      autoComplete="off"
                      placeholder="输入你的 VPN 账号"
                      value={form.username}
                      onChange={(e) =>
                        setForm({ ...form, username: e.target.value })
                      }
                    />
                  </label>
                  {provider.authDiscovery && (
                    <div className="vpn-auth-settings">
                      <div className="vpn-section-heading">
                        <div>
                          <h3>身份认证</h3>
                          <p>从已保存的网关获取可用登录方式</p>
                        </div>
                        <button
                          type="button"
                          className="vpn-button compact"
                          disabled={!!busy}
                          onClick={() =>
                            run('discover', async () => {
                              let profileId = form.id;
                              if (!savedGateway) {
                                const result = await persist();
                                profileId = result.profile.id;
                                await onSaved(result.profile, true);
                              }
                              setMethods(
                                await window.electronAPI.corporateVpn.discover(
                                  profileId,
                                ),
                              );
                              toast.success('认证方式已获取');
                            })
                          }
                        >
                          {busy === 'discover' ? (
                            <LoaderCircle
                              size={14}
                              className="animate-spin motion-reduce:animate-none"
                            />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          {savedGateway ? '获取认证方式' : '保存并获取认证方式'}
                        </button>
                      </div>
                      {!savedGateway && (
                        <p className="vpn-field-hint">
                          将先保存当前配置，再从网关发现可用的登录方式。
                        </p>
                      )}
                      {!!methods.length && (
                        <label className="vpn-field">
                          <span>网关认证方式</span>
                          <select
                            className="vpn-input"
                            aria-label="网关认证方式"
                            value={form.loginDomain + '|' + form.authMethod}
                            onChange={(e) => {
                              const [loginDomain, authMethod] =
                                e.target.value.split('|');
                              setForm({ ...form, loginDomain, authMethod });
                            }}
                          >
                            <option
                              value={form.loginDomain + '|' + form.authMethod}
                            >
                              当前：{form.loginDomain || '未指定登录域'}
                            </option>
                            {methods.map((method, i) => (
                              <option
                                key={i}
                                disabled={!method.supported}
                                value={
                                  method.loginDomain + '|' + method.authType
                                }
                              >
                                {method.authName} · {method.loginDomain}
                                {!method.supported && '（暂不支持）'}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <div className="vpn-two-columns">
                        <label className="vpn-field">
                          <span>登录域</span>
                          <input
                            className="vpn-input"
                            aria-label="登录域"
                            value={form.loginDomain}
                            placeholder="由网关提供"
                            onChange={(e) =>
                              setForm({ ...form, loginDomain: e.target.value })
                            }
                          />
                        </label>
                        <label className="vpn-field">
                          <span>认证方式</span>
                          <select
                            className="vpn-input"
                            aria-label="认证方式"
                            value={form.authMethod}
                            onChange={(e) =>
                              setForm({ ...form, authMethod: e.target.value })
                            }
                          >
                            <option value="auth/psw">账号密码</option>
                            <option value="auth/smsCheckCode">
                              短信验证码
                            </option>
                          </select>
                        </label>
                      </div>
                    </div>
                  )}
                  <div className="vpn-storage-settings">
                    <div className="flex gap-2 items-center">
                      <LockKeyhole size={15} />
                      <span>凭据保存</span>
                    </div>
                    <label>
                      <input
                        type="checkbox"
                        checked={form.rememberPassword}
                        disabled={!encryptionAvailable}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            rememberPassword: e.target.checked,
                          })
                        }
                      />
                      加密记住密码
                    </label>
                    {provider.deviceSession && (
                      <label>
                        <input
                          type="checkbox"
                          checked={form.rememberSession}
                          disabled={!encryptionAvailable}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              rememberSession: e.target.checked,
                            })
                          }
                        />
                        加密记住设备会话
                      </label>
                    )}
                    <p>
                      {encryptionAvailable
                        ? '密码和验证码在连接时输入。勾选后使用 Windows 系统加密保存。'
                        : '系统加密当前不可用，密码仅用于本次连接。'}
                    </p>
                  </div>
                </section>
                <section
                  role="tabpanel"
                  id="vpn-panel-routing"
                  aria-labelledby="vpn-tab-routing"
                  hidden={tab !== 'routing'}
                  className="vpn-editor-section"
                >
                  <div className="vpn-section-intro">
                    <Network size={19} />
                    <div>
                      <h3>按资源分流</h3>
                      <p>
                        连接后自动加载服务器授权资源，也可以在这里补充分流范围。
                      </p>
                    </div>
                  </div>
                  <div className="vpn-two-columns">
                    <label className="vpn-field">
                      <span>补充域名</span>
                      <textarea
                        className="vpn-input font-mono"
                        rows={5}
                        placeholder={'dev.example.com\nuat.example.com'}
                        value={domains}
                        onChange={(e) => setDomains(e.target.value)}
                      />
                      <small>每行一个域名，包含它的子域名</small>
                    </label>
                    <label className="vpn-field">
                      <span>补充 IP / 网段</span>
                      <textarea
                        className="vpn-input font-mono"
                        rows={5}
                        placeholder={'10.20.30.40\n10.20.40.0/24'}
                        value={cidrs}
                        onChange={(e) => setCidrs(e.target.value)}
                      />
                      <small>填写精确目标，避免覆盖整个家庭局域网</small>
                    </label>
                  </div>
                  <label className="vpn-field">
                    <span>
                      固定域名解析 <span className="vpn-optional">可选</span>
                    </span>
                    <textarea
                      className="vpn-input font-mono"
                      rows={4}
                      placeholder="dev.example.com 10.20.30.40"
                      value={hosts}
                      onChange={(e) => setHosts(e.target.value)}
                    />
                    <small>域名与 IP 之间用空格分隔，每行一条</small>
                  </label>
                  <div className="vpn-notice">
                    <ShieldCheck size={17} />
                    <p>
                      已知 VPN
                      目标在断线时保持阻断，其他流量沿用原来的出口规则。修改补充范围会保存为
                      TCP 全端口规则，访问权限仍由网关决定。
                    </p>
                  </div>
                </section>
                <section
                  role="tabpanel"
                  id="vpn-panel-advanced"
                  aria-labelledby="vpn-tab-advanced"
                  hidden={tab !== 'advanced'}
                  className="vpn-editor-section"
                >
                  <div className="vpn-section-intro">
                    <ShieldCheck size={19} />
                    <div>
                      <h3>证书与网络出口</h3>
                      <p>默认使用系统信任链和自动选择的物理网卡。</p>
                    </div>
                  </div>
                  <CertificateInspector
                    profile={form}
                    savedGateway={savedGateway}
                    onTrust={(pinSha256) =>
                      setForm({ ...form, tls: { ...form.tls, pinSha256 } })
                    }
                  />
                  <label className="vpn-field">
                    <span>
                      CA 证书 <span className="vpn-optional">PEM · 可选</span>
                    </span>
                    <textarea
                      className="vpn-input font-mono"
                      rows={3}
                      placeholder="-----BEGIN CERTIFICATE-----"
                      value={form.tls.caPem || ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          tls: {
                            ...form.tls,
                            caPem: e.target.value || undefined,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="vpn-field">
                    <span>
                      服务器证书 SHA256{' '}
                      <span className="vpn-optional">可选</span>
                    </span>
                    <input
                      className="vpn-input font-mono"
                      value={form.tls.pinSha256 || ''}
                      placeholder="64 位十六进制指纹"
                      onChange={(e) =>
                        setForm({
                          ...form,
                          tls: {
                            ...form.tls,
                            pinSha256: e.target.value || undefined,
                          },
                        })
                      }
                    />
                    <small>仅使用经过独立核对的指纹</small>
                  </label>
                  <div className="vpn-two-columns">
                    <label className="vpn-field">
                      <span>证书名称 / SNI</span>
                      <input
                        className="vpn-input"
                        placeholder="留空使用网关地址"
                        value={form.tls.serverName || ''}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            tls: {
                              ...form.tls,
                              serverName: e.target.value || undefined,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="vpn-field">
                      <span>物理网卡名称</span>
                      <input
                        className="vpn-input"
                        placeholder="自动选择，如 WLAN"
                        value={form.bindInterface}
                        onChange={(e) =>
                          setForm({ ...form, bindInterface: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {!!profile.id && (
                    <div className="vpn-credential-action">
                      <div>
                        <h3>已保存的凭据</h3>
                        <p>清除本配置保存的密码与设备会话</p>
                      </div>
                      <button
                        type="button"
                        className="vpn-button compact"
                        onClick={() =>
                          run('clear', async () => {
                            await window.electronAPI.corporateVpn.clearCredentials(
                              profile.id,
                            );
                            toast.success('已清除保存的密码和会话');
                          })
                        }
                      >
                        <KeyRound size={14} />
                        清除凭据
                      </button>
                    </div>
                  )}
                </section>
              </fieldset>
            </div>
            <footer className="vpn-editor-footer">
              {confirmation ? (
                <div className="vpn-editor-confirm" role="alert">
                  <p>
                    {confirmation === 'discard'
                      ? '有未保存的修改，确定放弃？'
                      : '删除此接入配置及保存的凭据？删除后需要重新应用分流。'}
                  </p>
                  <div>
                    <button
                      type="button"
                      className="vpn-button"
                      onClick={() => setConfirmation(undefined)}
                    >
                      继续编辑
                    </button>
                    <button
                      type="button"
                      className="vpn-button danger"
                      disabled={!!busy}
                      onClick={() =>
                        confirmation === 'discard'
                          ? onClose()
                          : run('delete', async () => {
                              await window.electronAPI.corporateVpn.remove(
                                profile.id,
                              );
                              await onRemoved();
                            })
                      }
                    >
                      {confirmation === 'discard' ? '放弃修改' : '确认删除'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    {!!profile.id && (
                      <button
                        type="button"
                        className="vpn-button text-danger"
                        disabled={!!busy}
                        onClick={() => setConfirmation('delete')}
                      >
                        <Trash2 size={15} />
                        删除接入
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="vpn-button"
                      disabled={!!busy}
                      onClick={close}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="vpn-button primary"
                      disabled={!!busy}
                    >
                      {busy === 'save' ? (
                        <LoaderCircle
                          size={16}
                          className="animate-spin motion-reduce:animate-none"
                        />
                      ) : (
                        <Save size={16} />
                      )}
                      保存配置
                    </button>
                  </div>
                </>
              )}
            </footer>
          </form>
        </div>
      </div>
    </Portal>
  );
}

function CertificateInspector({
  profile,
  savedGateway,
  onTrust,
}: {
  profile: VpnProfile;
  savedGateway: boolean;
  onTrust: (pin: string) => void;
}) {
  const [certificate, setCertificate] = useState<VpnCertificate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setCertificate(undefined);
    setConfirm(false);
  }, [profile.id, profile.gateway.host, profile.gateway.port]);
  return (
    <div className="vpn-certificate-panel">
      <div className="vpn-section-heading">
        <div>
          <h3 className="flex items-center gap-2">
            <Fingerprint size={16} />
            网关证书
          </h3>
          <p>读取已保存网关的证书信息</p>
        </div>
        <button
          type="button"
          className="vpn-button compact"
          disabled={!savedGateway || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              setCertificate(
                await window.electronAPI.corporateVpn.certificate(profile.id),
              );
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle
              size={14}
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Globe2 size={14} />
          )}
          读取证书
        </button>
      </div>
      {error && (
        <p className="vpn-inline-error" role="alert">
          {error}
        </p>
      )}
      {certificate && (
        <div className="vpn-certificate-details">
          <p
            className={
              certificate.chainTrusted ? 'vpn-success-text' : 'vpn-warning-text'
            }
          >
            {certificate.chainTrusted
              ? '系统信任链校验通过'
              : '系统信任链未通过，使用前需要核对证书'}
          </p>
          <dl>
            <dt>颁发给</dt>
            <dd>{certificate.subject}</dd>
            <dt>颁发者</dt>
            <dd>{certificate.issuer}</dd>
            <dt>有效期至</dt>
            <dd>{certificate.validTo}</dd>
            <dt>SHA256</dt>
            <dd className="font-mono break-all">{certificate.fingerprint}</dd>
          </dl>
          {confirm ? (
            <div className="space-y-2">
              <p>
                请与管理员提供的指纹独立核对。确认后将填入配置；证书变化时连接会失败。
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="vpn-button compact"
                  onClick={() => setConfirm(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="vpn-button compact primary"
                  onClick={() => {
                    onTrust(certificate.fingerprint);
                    setConfirm(false);
                    toast.info('指纹已填入，保存配置后生效');
                  }}
                >
                  已核对，填入指纹
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="vpn-button compact"
              onClick={() => setConfirm(true)}
            >
              使用此证书指纹
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
