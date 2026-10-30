import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Fingerprint,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  VpnAuthMethod,
  VpnCertificate,
  VpnProfile,
} from '../../types/corporateVpn';
import { vpnProviders } from '../vpn/providers';
import { vpnTrafficModes } from '../../utils/vpnRouting';
import { VpnTargetsFields } from './VpnTargetsFields';
import { Button } from './ui';
import { Portal } from './Portal';
import { Select } from './Select';
import { toast } from './Toast';
import { useModalExit } from '../hooks/useModalExit';
import { modalOverlayClass, modalPopClass, useMaskDrag } from './ModalShell';

const lines = (value: string) =>
  value
    .split(/[\s,;，；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const companyDomains = (value: string) => lines(value).map(entry => {
  if (!/^https?:\/\//i.test(entry)) return entry;
  const url = new URL(entry);
  if (url.username || url.password) throw new Error('公司网址请勿包含账号或密码');
  return url.hostname;
});
export const newVpnProfile = (): VpnProfile => ({
  id: '',
  name: '',
  protocol: 'easyconnect',
  gateway: { host: '', port: 10443 },
  username: '',
  authMethod: 'auth/psw',
  loginDomain: '',
  trafficMode: 'split',
  autoDiscoverPrivate: true,
  routingPriority: 100,
  customRouting: { domestic: 'direct', foreign: 'proxy', lan: 'direct' },
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
  { id: 'routing', name: '高级分流', icon: Network },
  { id: 'advanced', name: '高级选项', icon: Settings2 },
] as const;

export function VpnProfileEditor({
  profile,
  encryptionAvailable,
  onClose,
  onSaved,
  initialTab = 'connection',
  readOnly = false,
  passwordSaved = false,
}: {
  profile: VpnProfile;
  encryptionAvailable: boolean;
  onClose: () => void;
  onSaved: (profile: VpnProfile, keepOpen?: boolean) => Promise<void>;
  initialTab?: 'connection' | 'routing' | 'advanced';
  readOnly?: boolean;
  passwordSaved?: boolean;
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
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>(initialTab);
  const [methods, setMethods] = useState<VpnAuthMethod[]>(profile.authChoices || []);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [confirmation, setConfirmation] = useState<'discard'>();
  const root = useRef<HTMLDivElement>(null);
  const initial = useRef(JSON.stringify({ form, domains, cidrs, hosts, password: '' }));
  const dirty =
    JSON.stringify({ form, domains, cidrs, hosts, password }) !== initial.current;
  const provider = vpnProviders[form.protocol];
  const savedGateway =
    !!profile.id &&
    profile.protocol === form.protocol &&
    profile.gateway.host === form.gateway.host &&
    profile.gateway.port === form.gateway.port;
  const hasSavedPassword = passwordSaved && savedGateway && form.rememberPassword &&
    profile.username === form.username && profile.authMethod === form.authMethod && profile.loginDomain === form.loginDomain;
  // 收场动画:无未保存修改直接动画关闭;有修改先就地确认(编辑器保持可见,不播动画)
  const { exiting, requestClose: animatedClose } = useModalExit(onClose);
  const maskDrag = useMaskDrag();
  const close = () => {
    if (busy) return;
    if (dirty && !readOnly) {
      setConfirmation('discard');
      return;
    }
    animatedClose();
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (Array.from(root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') || [])
      .find((input) => input.getClientRects().length && !input.matches(':disabled')) || root.current?.querySelector<HTMLButtonElement>('button'))
      ?.focus();
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
    if (readOnly) throw new Error('连接期间配置只读，请先断开 VPN 再修改。');
    if (password && !encryptionAvailable) throw new Error('系统加密不可用，无法保存密码。');
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
      JSON.stringify(companyDomains(domains)) ===
        JSON.stringify(profile.targets.flatMap((t) => t.domains)) &&
      JSON.stringify(lines(cidrs)) ===
        JSON.stringify(profile.targets.flatMap((t) => t.cidrs));
    const result = await window.electronAPI.corporateVpn.save({
      ...form,
      hosts: fixed,
      targets: unchanged
        ? profile.targets
        : [
            ...(companyDomains(domains).length
              ? [
                  {
                    domains: [...new Set(companyDomains(domains))],
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
    if (password) {
      try {
        await window.electronAPI.corporateVpn.savePassword(result.profile.id, password, true);
        setPassword('');
        setShowPassword(false);
      } catch (error) {
        await onSaved(result.profile, true);
        throw new Error(`接入配置已保存，但密码保存失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    initial.current = JSON.stringify({
      form: result.profile,
      domains,
      cidrs,
      hosts,
      password: '',
    });
    return result;
  };
  const save = async () => {
    const result = await persist();
    await onSaved(result.profile);
    toast.success(
      result.requiresCoreRebuild
        ? '配置已保存，连接 VPN 时自动准备分流'
        : `已保存「${result.profile.name}」的接入配置`,
    );
  };
  return (
    <Portal>
      <div
        {...maskDrag}
        className={`vpn-modal-backdrop no-drag ${modalOverlayClass(exiting)}`}
          {...maskDrag}
      >
        <div
          ref={root}
          className={`vpn-surface vpn-editor ${modalPopClass(exiting)}`}
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
                {readOnly ? '查看接入' : profile.id ? '编辑接入' : '新增 VPN 接入'}
              </h2>
              <p>{readOnly ? 'VPN 连接期间只读，断开后可修改配置。' : '设置连接方式与需要通过 VPN 访问的资源'}</p>
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
              if (!readOnly) run('save', save);
            }}
          >
            <div className="vpn-editor-body">
              {error && (
                <div className="vpn-notice danger" role="alert">
                  {error}
                </div>
              )}
              <fieldset
                disabled={!!busy || readOnly}
                className={`min-w-0 ${readOnly ? 'vpn-readonly-fields' : 'disabled:opacity-60'}`}
              >
                <section
                  role="tabpanel"
                  id="vpn-panel-connection"
                  aria-labelledby="vpn-tab-connection"
                  hidden={tab !== 'connection'}
                  className="vpn-editor-section"
                >

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
                  {form.protocol === 'softether' && (
                    <>
                      <div className="vpn-two-columns">
                        <label className="vpn-field">
                          <span>Virtual HUB <em>*</em></span>
                          <input className="vpn-input" aria-label="Virtual HUB" value={form.loginDomain}
                            placeholder="例如 VPN，由管理员提供" maxLength={100}
                            onChange={(e) => setForm({ ...form, loginDomain: e.target.value })} />
                        </label>
                        <label className="vpn-field">
                          <span>认证方式</span>
                          <select className="vpn-input" aria-label="SoftEther 认证方式" value={form.authMethod}
                            onChange={(e) => setForm({ ...form, authMethod: e.target.value })}>
                            <option value="auth/psw">标准密码认证</option>
                            <option value="softether/radius">RADIUS / 域账号密码</option>
                          </select>
                        </label>
                      </div>
                      <div className="vpn-notice"><Network size={17} /><p>
                        内置原生协议，无需同时运行 SoftEther VPN Client。自动获取虚拟地址与 DNS；
                        公司网段或域名可在「高级分流」补充，不改变系统默认网关。
                      </p></div>
                    </>
                  )}
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
                              const discovered: VpnAuthMethod[] = await window.electronAPI.corporateVpn.discover(profileId);
                              setMethods(discovered);
                              setForm(current => ({ ...current, authChoices: discovered,
                                authName: discovered.find(m => m.loginDomain === current.loginDomain && m.authType === current.authMethod)?.authName || current.authName }));
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
                          <Select
                            className="w-full"
                            ariaLabel="网关认证方式"
                            value={form.loginDomain + '|' + form.authMethod}
                            onChange={(v) => {
                              const [loginDomain, authMethod] = v.split('|');
                              const method = methods.find((m) => m.loginDomain === loginDomain && m.authType === authMethod);
                              setForm({ ...form, loginDomain, authMethod, authName: method?.authName || '', authChoices: methods });
                            }}
                            options={[
                              ...(!methods.some((m) => m.loginDomain === form.loginDomain && m.authType === form.authMethod)
                                ? [{
                                    value: form.loginDomain + '|' + form.authMethod,
                                    label: form.authName || '当前入口尚未匹配，请获取认证方式',
                                  }]
                                : []),
                              ...methods.map((method) => ({
                                value: method.loginDomain + '|' + method.authType,
                                label: `${method.authName}${method.supported ? '' : '（暂不支持）'}`,
                                disabled: !method.supported,
                              })),
                            ]}
                          />
                        </label>
                      )}
                      <details className="vpn-auth-parameters">
                      <summary>手动配置认证参数</summary>
                      <p className="vpn-field-hint">通常选择上面的认证入口即可。仅在管理员提供参数时手动填写。</p>
                      <div className="vpn-two-columns">
                        <label className="vpn-field">
                          <span>登录域</span>
                          <input
                            className="vpn-input"
                            aria-label="登录域"
                            value={form.loginDomain}
                            placeholder="由网关提供"
                            onChange={(e) =>
                              setForm({ ...form, loginDomain: e.target.value, authName: '' })
                            }
                          />
                        </label>
                        <label className="vpn-field">
                          <span>认证方式</span>
                          <Select
                            className="w-full"
                            ariaLabel="认证方式"
                            value={form.authMethod}
                            onChange={(v) => setForm({ ...form, authMethod: v, authName: '' })}
                            options={[
                              { value: 'auth/psw', label: '账号密码' },
                              { value: 'auth/smsCheckCode', label: '短信验证码' },
                            ]}
                          />
                        </label>
                      </div>
                      </details>
                    </div>
                  )}
                  {form.authMethod !== 'auth/smsCheckCode' && (
                    <div className="vpn-field">
                      <label htmlFor="vpn-editor-password">登录密码 <span className="vpn-optional">可选</span></label>
                      <div className="vpn-editor-password">
                        <input
                          id="vpn-editor-password"
                          aria-label="配置登录密码"
                          className="vpn-input"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="new-password"
                          maxLength={4096}
                          disabled={!encryptionAvailable}
                          placeholder={hasSavedPassword ? '已加密保存；留空保留已有密码' : '输入密码，随配置加密保存'}
                          value={password}
                          onChange={event => {
                            setPassword(event.target.value);
                            if (event.target.value) setForm({ ...form, rememberPassword: true });
                          }}
                        />
                        <button type="button" className="vpn-icon-button" aria-label={showPassword ? '隐藏配置密码' : '显示配置密码'} onClick={() => setShowPassword(!showPassword)}>
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                      <small>{readOnly ? '已保存的密码不回显。' : '填写后随「保存配置」一起加密保存，验证码仍在连接时输入。'}</small>
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
                        className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                        checked={form.rememberPassword}
                        disabled={!encryptionAvailable}
                        onChange={(e) => {
                          setForm({
                            ...form,
                            rememberPassword: e.target.checked,
                          });
                          if (!e.target.checked) { setPassword(''); setShowPassword(false); }
                        }}
                      />
                      加密记住密码
                    </label>
                    {provider.deviceSession && (
                      <label>
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded text-blue-600 focus:ring-0"
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
                        ? '使用 Windows 系统加密保存密码；验证码不保存。'
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
                      <h3>选择流量如何连接</h3>
                      <p>
                        仅保存到「{form.name || '当前接入'}」，其他公司的配置独立。
                        自动读取服务器资源，也可按实际访问自动选择可用网络出口。
                      </p>
                    </div>
                  </div>
                  <div className="vpn-notice">
                    <Globe2 size={18} />
                    <p>{form.trafficMode === 'vpn'
                      ? '默认流量通过 VPN。已启用公网代理时，国外网站优先走代理；VPN 需要允许相应目标。'
                      : form.trafficMode === 'custom'
                        ? '按下方设置分配出口。公司目标始终优先走 VPN，访问失败时不会回退公网。'
                        : '公司目标通过 VPN；国内公网使用本机网络，国外网站使用已开启的公网代理。公司 VPN 无需具备公网访问权限。'}
                      {' '}{form.protocol === 'softether' ? '开启 TUN 后支持 IPv4 TCP、UDP 和 ping；未开启代理时，智能分流的普通公网使用本机网络。' : '当前 VPN 隧道支持 IPv4 TCP；未开启代理时，智能分流的普通公网使用本机网络。'}</p>
                  </div>
                  <div className="vpn-mode-options" role="group" aria-label="分流模式">
                    {vpnTrafficModes.map(mode => (
                      <button type="button" key={mode.id} className="vpn-mode-option"
                        aria-pressed={(form.trafficMode || 'split') === mode.id}
                        onClick={() => setForm({ ...form, trafficMode: mode.id })}>
                        <span className="vpn-mode-option-top"><strong>{mode.name}</strong>
                          {mode.recommended ? <span className="vpn-mode-recommended">默认</span> : null}</span>
                        <small>{mode.summary}</small>
                        {(form.trafficMode || 'split') === mode.id && <Check size={15} />}
                      </button>
                    ))}
                  </div>
                  <label className="vpn-field"><span>分流优先级</span>
                    <input type="number" className="vpn-input" aria-label="分流优先级" min={1} max={9999}
                      value={form.routingPriority ?? 100} onChange={e => setForm({ ...form, routingPriority: Number(e.target.value) })}/>
                    <small>数字越小越优先；同优先级按接入列表顺序。多个 VPN 同时连接时，重叠资源及默认公网策略按此顺序选择，明确的公司资源仍优先。</small>
                  </label>
                  {(form.trafficMode || 'split') === 'split' && (
                    <div className="vpn-auto-discovery">
                      <label>
                        <input type="checkbox" aria-label={form.protocol === 'softether' ? '自动选择可用出口' : '自动识别私网目标'}
                          checked={form.autoDiscoverPrivate !== false}
                          onChange={e => setForm({ ...form, autoDiscoverPrivate: e.target.checked })}/>
                        <strong>{form.protocol === 'softether' ? '自动选择可用出口' : '自动识别私网目标'}</strong><span className="vpn-mode-recommended">默认</span>
                      </label>
                      {form.protocol === 'softether' ? <>
                        <p>公司资源走 VPN；其余选择直连的 TCP 连接先尝试本机，不可达时尝试当前 VPN。所有端口使用相同逻辑，已开启的国外代理仍优先。</p>
                        <p>开启 TUN 后，私网 UDP 和 ping 从第一次请求就进入 VPN，无需预先学习；本机局域网仍按系统路由访问。TCP 在同一次连接中完成出口选择，建立后持续使用同一出口。</p>
                      </> : <>
                        <p>只在访问未知私网 IP 或已解析为私网的域名时判断路径。本机可达就直连；多个接入开启此功能时，按优先级尝试已连接的 VPN。首次访问可能需要几秒，不影响普通公网。</p>
                        <p>只记住验证过的 IP、端口和 TCP 协议；重新连接后重新判断。公网公司地址、特殊域名和同地址冲突请在下方明确配置。</p>
                      </>}
                    </div>
                  )}
                  {form.trafficMode === 'custom' && (
                    <div className="vpn-custom-outlets">
                      {([['domestic', '国内公网'], ['foreign', '国外网站'], ['lan', '其他局域网']] as const).map(([key, label]) => (
                        <label className="vpn-field" key={key}><span>{label}</span>
                          <select className="vpn-input" aria-label={`${label}出口`}
                            value={form.customRouting?.[key] || (key === 'foreign' ? 'proxy' : 'direct')}
                            onChange={e => setForm({ ...form, customRouting: {
                              domestic: 'direct', foreign: 'proxy', lan: 'direct', ...form.customRouting,
                              [key]: e.target.value,
                            } })}>
                            <option value="direct">本机网络</option>
                            <option value="vpn">此 VPN</option>
                            <option value="proxy">公网代理（未启用时直连）</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="vpn-section-heading"><div><h3>公司资源</h3>
                    <p>{form.protocol === 'softether' ? '自动发现虚拟网段；其他资源可补充。' : '连接后自动读取网关授权资源，也可以手动补充。'}
                      不知道网段时，填写一个公司网址或服务器 IP 也可以。</p></div></div>
                  <VpnTargetsFields
                    domains={domains}
                    onDomains={setDomains}
                    cidrs={cidrs}
                    onCidrs={setCidrs}
                    hosts={hosts}
                    onHosts={setHosts}
                  />
                  <div className="vpn-notice">
                    <ShieldCheck size={17} />
                    <p>
                      优先顺序：明确阻止 → 此接入的用户自定义 → 服务器资源 → 国内、局域网及应用规则。
                      同一域名的固定解析以用户填写的 IP 为准。点击「保存配置」后保留，重启无需重新填写。
                    </p>
                  </div>
                  <div className="vpn-notice">
                    <Network size={17} />
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
                      <p>默认自动处理网关证书，并自动选择物理网卡。</p>
                    </div>
                  </div>
                  <label className="vpn-field">
                    <span>证书处理方式</span>
                    <Select
                      className="w-full"
                      ariaLabel="证书处理方式"
                      value={form.tls.trustMode || 'auto'}
                      onChange={(v) =>
                        setForm({
                          ...form,
                          tls: {
                            ...form.tls,
                            trustMode: v as 'auto' | 'strict',
                          },
                        })
                      }
                      options={[
                        { value: 'auto', label: '自动处理（首次记住网关证书）' },
                        { value: 'strict', label: '严格校验（系统 CA 或已固定指纹）' },
                      ]}
                    />
                    <small>
                      优先使用系统信任链；首次遇到未受信任证书时自动绑定指纹。已记录的指纹变化时会停止连接，自定义
                      CA 按配置校验。
                    </small>
                  </label>
                  <CertificateInspector
                    profile={form}
                    savedGateway={savedGateway}
                    autoInspect={initialTab === 'advanced'}
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
                  <label className="vpn-field">
                    <span>本机诊断日志</span>
                    <select className="vpn-input" aria-label="本机诊断日志"
                      value={form.diagnosticMode || 'off'}
                      onChange={e => setForm({ ...form, diagnosticMode: e.target.value as VpnProfile['diagnosticMode'] })}>
                      <option value="off">基础错误（默认）</option>
                      <option value="detail">连接诊断（请求路径、状态和耗时）</option>
                      <option value="full">完整诊断（含密码和验证码）</option>
                    </select>
                    <small>保存在本机独立文件，可在连接页面打开或清空。每个文件最多约 10 MB，保留一份轮换文件。</small>
                  </label>
                  {form.diagnosticMode === 'full' && <div className="vpn-notice danger" role="status"><p>
                    完整诊断会记录提交的明文密码、验证码及原始认证请求和响应（含 Cookie、令牌）。仅在本机保存，请勿直接分享此日志。
                  </p></div>}
                </section>
              </fieldset>
            </div>
            <footer className="vpn-editor-footer">
              {confirmation ? (
                <div className="vpn-editor-confirm" role="alert">
                  <p>有未保存的修改，确定放弃？</p>
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
                      onClick={animatedClose}
                    >
                      放弃修改
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-end gap-3">
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={close}
                  >
                    {readOnly ? '关闭' : '取消'}
                  </Button>
                  {!readOnly && (
                    <Button type="submit" disabled={!!busy}>
                      {busy === 'save' ? (
                        <LoaderCircle
                          size={16}
                          className="animate-spin motion-reduce:animate-none"
                        />
                      ) : (
                        <Check size={16} />
                      )}
                      保存配置
                    </Button>
                  )}
                </div>
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
  autoInspect,
}: {
  profile: VpnProfile;
  savedGateway: boolean;
  onTrust: (pin: string) => void;
  autoInspect?: boolean;
}) {
  const [certificate, setCertificate] = useState<VpnCertificate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setCertificate(undefined);
    setConfirm(false);
    setBusy(false);
    return () => {
      sequence.current++;
    };
  }, [profile.id, profile.gateway.host, profile.gateway.port]);
  const read = async () => {
    const version = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const value = await window.electronAPI.corporateVpn.certificate(
        profile.id,
      );
      if (version === sequence.current) setCertificate(value);
    } catch (e) {
      if (version === sequence.current) setError(String(e));
    } finally {
      if (version === sequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (autoInspect && savedGateway) void read();
  }, [
    autoInspect,
    savedGateway,
    profile.id,
    profile.gateway.host,
    profile.gateway.port,
  ]);
  const issues: Record<string, string> = {
    UNTRUSTED_AUTHORITY: '签发者未被系统信任，可能使用了自签名证书。',
    NAME_MISMATCH: '证书名称与当前网关地址不匹配。',
    EXPIRED: '服务器证书已过期。',
    NOT_YET_VALID: '服务器证书尚未到生效时间。',
    INVALID_CA: '保存的 CA 证书无法读取。',
    CHAIN_INVALID: '证书链未通过校验。',
  };
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
          onClick={read}
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
            {!!certificate.trustIssues?.length && (
              <>
                <dt>校验结果</dt>
                <dd>
                  <ul className="vpn-certificate-issues">
                    {certificate.trustIssues.map((issue) => (
                      <li key={issue}>{issues[issue] || '证书校验未通过。'}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            <dt>颁发给</dt>
            <dd>{certificate.subject}</dd>
            <dt>颁发者</dt>
            <dd>{certificate.issuer}</dd>
            {!!certificate.dnsNames?.length && (
              <>
                <dt>域名</dt>
                <dd>{certificate.dnsNames.join(', ')}</dd>
              </>
            )}
            {!!certificate.ipAddresses?.length && (
              <>
                <dt>IP 地址</dt>
                <dd>{certificate.ipAddresses.join(', ')}</dd>
              </>
            )}
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
