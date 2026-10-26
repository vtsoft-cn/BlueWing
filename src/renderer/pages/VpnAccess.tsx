import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Eye,
  EyeOff,
  FileKey2,
  Globe2,
  HelpCircle,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Unplug,
  Waypoints,
  Trash2,
} from 'lucide-react';
import {
  VpnChallenge,
  VpnProfile,
  VpnState,
  VpnTarget,
} from '../../types/corporateVpn';
import { captchaAnswer } from '../../utils/vpnChallenge';
import { useVpnSnapshot } from '../vpn/useVpnSnapshot';
import { VpnProfile as EngineVpnProfile, VpnRuntimeInfo } from '../../types';
import { VpnProfileEditorModal } from './VpnProfileEditorModal';
import { vpnProviderList, vpnProviders } from '../vpn/providers';
import {
  newVpnProfile,
  VpnProfileEditor,
} from '../components/VpnProfileEditor';
import { Portal } from '../components/Portal';
import { confirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import './vpn-access.css';

const input = 'vpn-input';
const button = 'vpn-button';
const labels: Record<VpnState['state'], string> = {
  idle: '未连接',
  starting: '正在准备',
  authenticating: '正在认证',
  waiting_user: '等待验证',
  applying_policy: '正在应用分流',
  connected: '已连接',
  failed: '连接失败',
  stopping: '正在断开',
  reconnect_wait: '等待重试',
};
const errorLabels: Record<string, string> = {
  TLS_UNTRUSTED:
    '网关证书不受信任或名称不匹配。请在高级选项中配置 CA，或核对服务器证书。',
  AUTH_OR_TUNNEL_FAILED: '认证或隧道建立失败，请核对账号、认证方式和网关要求。',
  GATEWAY_UNREACHABLE: '无法连接网关，请检查服务器地址、端口和物理网络。',
  AUTH_TIMEOUT: '认证等待超时，请重新连接。',
  AUTH_CHALLENGE_EXPIRED: '验证码已过期，请重新连接。',
  AUTH_METHOD_UNSUPPORTED:
    '当前认证方式尚不支持，请编辑配置并选择已支持的方式。',
  CORE_EXITED: 'VPN 组件已退出，已知接入资源保持保护，请重新连接。',
  POLICY_APPLY_FAILED: '隧道已就绪，但尚未确认分流生效，请检查日志后重新连接。',
  VPN_TRANSPORT_DOWN: 'VPN 隧道已断开，请重新连接。',
};
const inProgress = (state: VpnState['state']) =>
  !['idle', 'failed', 'connected'].includes(state);

function ProviderMark({
  protocol,
  small = false,
}: {
  protocol: VpnProfile['protocol'];
  small?: boolean;
}) {
  const provider = vpnProviders[protocol];
  return (
    <span
      className={`vpn-provider-mark ${provider.tone}${small ? ' small' : ''}`}
      aria-hidden="true"
    >
      {provider.mark}
    </span>
  );
}
function ConnectionBadge({ state }: { state: VpnState['state'] }) {
  return (
    <span
      className={`vpn-state-badge ${state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : inProgress(state) ? 'pending' : ''}`}
    >
      {inProgress(state) ? (
        <LoaderCircle
          size={13}
          className="animate-spin motion-reduce:animate-none"
        />
      ) : state === 'connected' ? (
        <CheckCircle2 size={13} />
      ) : (
        <Circle size={11} />
      )}
      {labels[state]}
    </span>
  );
}

export const VpnAccess: React.FC = () => {
  const { snapshot, loading, error: loadError, refresh } = useVpnSnapshot();
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<VpnProfile>();
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [detailTab, setDetailTab] = useState<'resources' | 'help'>('resources');
  const [engineEditorOpen, setEngineEditorOpen] = useState(false);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  // ---- 协议引擎类档案(IKEv2/L2TP/SSTP/OpenVPN/WireGuard/…,与原生协议并列在同一列表) ----
  const [engineProfiles, setEngineProfiles] = useState<EngineVpnProfile[]>([]);
  const [engineRuntime, setEngineRuntime] = useState<VpnRuntimeInfo | null>(null);
  const [engineEditorFor, setEngineEditorFor] = useState<EngineVpnProfile | null | undefined>(undefined);
  const isEngine = (id: string): boolean => id.startsWith('eng-');
  const refreshEngineProfiles = useCallback(async (): Promise<EngineVpnProfile[]> => {
    if (!window.electronAPI?.vpn) return [];
    const list = await window.electronAPI.vpn.getProfiles();
    setEngineProfiles(list);
    return list;
  }, []);
  useEffect(() => {
    void refreshEngineProfiles();
    void window.electronAPI?.vpn?.getState().then(setEngineRuntime);
    const offState = window.electronAPI?.vpn?.onStateChange((info) => setEngineRuntime(info));
    const offProfiles = window.electronAPI?.vpn?.onProfilesChanged((list) => setEngineProfiles(list));
    return () => { offState?.(); offProfiles?.(); };
  }, [refreshEngineProfiles]);
  // 引擎类在主列表里的稳定 id 前缀(避免与 corporate id 撞)
  const engineKey = (id: string): string => `eng-${id}`;
  // 引擎档案的显示摘要
  const engineGatewayText = (p: EngineVpnProfile): string => {
    if (p.type === 'openvpn') return p.server ? `${p.server}${p.port ? ':' + p.port : ''}` : '内嵌 .ovpn';
    if (p.type === 'wireguard') return p.server;
    return p.server;
  };
  const ENGINE_LABELS: Record<string, string> = {
    ikev2: 'IKEv2', l2tp: 'L2TP/IPsec', sstp: 'SSTP', openvpn: 'OpenVPN',
    anyconnect: 'AnyConnect', fortinet: 'FortiClient', globalprotect: 'GlobalProtect',
    pulse: 'Pulse/Ivanti', nc: 'Juniper NC', f5: 'F5 BIG-IP', array: 'Array AG',
    softether: 'SoftEther', wireguard: 'WireGuard',
  };
  const engineBadge = (state?: string): { text: string; tone: string } => {
    switch (state) {
      case 'connecting': return { text: '连接中', tone: 'vpn-badge-warn' };
      case 'connected': return { text: '已连接', tone: 'vpn-badge-ok' };
      case 'disconnecting': return { text: '断开中', tone: '' };
      case 'error': return { text: '失败', tone: 'vpn-badge-bad' };
      default: return { text: '', tone: '' };
    }
  };
  const engineActive = !!(
    engineRuntime &&
    engineRuntime.state !== 'disconnected' &&
    engineRuntime.state !== 'error'
  );
  const engineStateFor = (id: string): VpnRuntimeInfo | null =>
    engineRuntime && engineRuntime.profileId === id && engineRuntime.state !== 'disconnected'
      ? engineRuntime
      : null;
  const requestEngineClose = async (): Promise<void> => {
    await window.electronAPI?.vpn?.disconnect();
    await refreshEngineProfiles();
  };
  const [expanded, setExpanded] = useState(false);
  const state = snapshot.state;
  const active = !['idle', 'failed'].includes(state.state);
  const engineItems = engineProfiles.map((p) => ({
    key: engineKey(p.id),
    engineProfile: p,
    name: p.name,
    host: engineGatewayText(p),
    label: ENGINE_LABELS[p.type] || p.type,
  }));
  const profiles = [
    // 协议引擎类档案(IKEv2/L2TP/SSTP/OpenVPN/WireGuard/…)
    ...engineItems
      .filter((item) =>
        `${item.name} ${item.host} ${item.label}`.toLowerCase().includes(search.toLowerCase()))
      .map((item) => ({
        engine: item.engineProfile,
        id: item.key,
        name: item.name,
        host: item.host,
        label: item.label,
      })),
    // 原生协议档案(EasyConnect/aTrust)
    ...snapshot.profiles
      .filter((profile) =>
        `${profile.name} ${profile.gateway.host} ${vpnProviders[profile.protocol].name}`
          .toLowerCase()
          .includes(search.toLowerCase()))
      .map((profile) => ({
        engine: undefined,
        id: profile.id,
        name: profile.name,
        host: `${profile.gateway.host}:${profile.gateway.port}`,
        label: vpnProviders[profile.protocol].name,
        profile,
      })),
  ];
  const selected = profiles.find((profile) => profile.id === selectedId);
  const selectedState =
    selected && !selected.engine && state.profileId === selected.id
      ? state.state
      : 'idle';
  useEffect(() => {
    if (!snapshot.profiles.some((profile) => profile.id === selectedId))
      setSelectedId(
        snapshot.profiles.find((profile) => profile.id === state.profileId)
          ?.id ||
          snapshot.profiles[0]?.id ||
          '',
      );
  }, [snapshot.profiles, selectedId, state.profileId]);
  useEffect(() => {
    setPassword('');
    setReveal(false);
    setActionError('');
    setExpanded(false);
  }, [selectedId]);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setActionError('');
    try {
      await job();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const resources =
    selected && state.profileId === selected.id ? state.resources : undefined;
  const resourceRows: Array<{ target: VpnTarget; source: string }> =
    selected && !selected.engine
      ? [
          ...(resources?.targets || []).map((target) => ({
            target,
            source: '服务器下发',
          })),
          ...selected.profile.targets.map((target) => ({ target, source: '手动补充' })),
          ...Object.entries(selected.profile.hosts).map(([domain, ips]) => ({
            target: { domains: [domain], cidrs: ips, network: 'tcp' as const },
            source: '固定解析',
          })),
        ]
      : [];


  const connectionError =
    actionError ||
    (state.profileId === selectedId && state.error
      ? errorLabels[state.error] || state.error
      : '');
  const connectDisabled =
    busy ||
    active ||
    !!state.requiresCoreRebuild ||
    state.coreAvailable === false;
  return (
    <div className="vpn-surface vpn-access">
      <header className="vpn-page-header">
        <div className="flex items-center gap-3">
          <div className="vpn-heading-icon">
            <Network size={23} />
          </div>
          <div>
            <h2>VPN 接入</h2>
            <p>统一管理不同协议的连接，让指定资源通过 VPN 访问。</p>
          </div>
        </div>
        {!!snapshot.profiles.length && (
          <button
            className="vpn-button"
            disabled={active || busy}
            onClick={() => setAddPickerOpen(true)}
          >
            <Plus size={16} />
            新增接入
          </button>
        )}
      </header>
      {loadError && (
        <div className="vpn-notice danger" role="alert">
          <p>{loadError}</p>
          <button
            className="vpn-button compact"
            onClick={() =>
              run(async () => {
                await refresh();
              })
            }
          >
            重新加载
          </button>
        </div>
      )}
      {state.coreAvailable === false && (
        <div className="vpn-notice warning">
          <FileKey2 size={18} />
          <p>VPN 接入组件未安装，请使用包含该组件的 BlueWing 构建。</p>
        </div>
      )}
      {state.requiresCoreRebuild && snapshot.profiles.length > 0 && (
        <div className="vpn-notice warning vpn-apply-banner">
          <RefreshCw size={18} />
          <div>
            <strong>接入配置已更新</strong>
            <p>应用分流后即可连接，此操作会短暂重连公网代理。</p>
          </div>
          <button
            className="vpn-button compact"
            disabled={busy || active}
            onClick={() =>
              run(async () => {
                if (
                  await confirmDialog({
                    title: '应用接入分流',
                    message:
                      '需要重启代理核心来注册 VPN 出口，现有公网连接会短暂重连。之后正常连接、断开 VPN 无需重启公网代理。',
                    confirmText: '应用并重连',
                  })
                ) {
                  if (!(await window.electronAPI.corporateVpn.apply()))
                    throw new Error('应用分流失败，请检查日志。');
                  await refresh();
                  toast.success('接入分流已应用');
                }
              })
            }
          >
            应用分流
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {loading ? (
        <div className="vpn-empty-state">
          <LoaderCircle
            size={27}
            className="animate-spin motion-reduce:animate-none"
          />
          <h3>正在加载接入配置</h3>
        </div>
      ) : snapshot.profiles.length === 0 ? (
        <div className="vpn-empty-state">
          <div className="vpn-empty-art">
            <Network size={35} />
            <span>
              <ShieldCheck size={17} />
            </span>
          </div>
          <h3>添加你的第一个 VPN 接入</h3>
          <p>
            保存网关和认证设置，连接后自动按资源分流。
            <br />
            其他流量继续使用原有出口。
          </p>
          <button
            className="vpn-button primary"
            onClick={() => setAddPickerOpen(true)}
          >
            <Plus size={17} />
            添加接入
          </button>
          <div className="vpn-supported-providers">
            {vpnProviderList.map((provider) => (
              <span key={provider.id}>
                <Check size={13} />
                {provider.name}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="vpn-workspace">
          <aside className="vpn-profile-list" aria-label="VPN 接入配置">
            <div className="vpn-list-heading">
              <h3>接入配置</h3>
              <span>
                {snapshot.profiles.length.toString().padStart(2, '0')}
              </span>
            </div>
            <label className="vpn-search">
              <Search size={15} />
              <input
                aria-label="搜索接入配置"
                placeholder="搜索名称或网关"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="vpn-profile-items">
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`vpn-profile-item ${selectedId === profile.id ? 'selected' : ''}`}
                  aria-pressed={selectedId === profile.id}
                  disabled={
                    (active && state.profileId !== profile.id) ||
                    (engineActive && engineRuntime?.profileId !== profile.id.replace(/^eng-/, ''))
                  }
                  title={
                    active && state.profileId !== profile.id
                      ? '请先断开当前接入后切换'
                      : profile.host
                  }
                  onClick={() => setSelectedId(profile.id)}
                >
                  <div className="vpn-profile-item-top">
                    {profile.engine ? (
                      <span className="vpn-provider-mark violet small" aria-hidden="true">
                        {ENGINE_LABELS[profile.engine.type]?.slice(0, 2).toUpperCase() || 'EN'}
                      </span>
                    ) : (
                      <ProviderMark protocol={profile.profile.protocol} small />
                    )}
                    <strong>{profile.name}</strong>
                    {profile.engine
                      ? engineStateFor(profile.engine.id)?.state === 'connected' && (
                          <CheckCircle2 size={15} className="vpn-success-text shrink-0" />
                        )
                      : state.profileId === profile.id &&
                        state.state === 'connected' && (
                          <CheckCircle2 size={15} className="vpn-success-text shrink-0" />
                        )}
                  </div>
                  <span className="vpn-profile-gateway">{profile.host}</span>
                  <span className="vpn-profile-protocol">
                    {profile.label}
                    {profile.engine
                      ? engineStateFor(profile.engine.id) && (
                          <span>{engineStateFor(profile.engine.id)!.state === 'connected' ? '已连接' : engineStateFor(profile.engine.id)!.state === 'connecting' ? '连接中' : ''}</span>
                        )
                      : state.profileId === profile.id && active && (
                          <span>{labels[state.state]}</span>
                        )}
                  </span>
                </button>
              ))}
              {!profiles.length && (
                <div className="vpn-search-empty">
                  <p>没有匹配的接入</p>
                  <button
                    className="vpn-text-button"
                    onClick={() => setSearch('')}
                  >
                    清空搜索
                  </button>
                </div>
              )}
            </div>
            <p className="vpn-list-footnote">
              <LockKeyhole size={13} />
              同一时间连接一个接入
            </p>
          </aside>
          {selected && selected.engine && (
            <div className="vpn-detail-column">
              <section className="vpn-connection-card" aria-label="连接面板">
                <header className="vpn-connection-header">
                  <div className="vpn-connection-identity">
                    <span className="vpn-provider-mark blue" aria-hidden="true">
                      {(ENGINE_LABELS[selected.engine.type] || 'EN').slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="vpn-connection-title">
                        <h3>{selected.name}</h3>
                        {(() => {
                          const rt = engineStateFor(selected.engine.id);
                          const st = rt?.state || 'disconnected';
                          const map: Record<string, string> = { connected: '已连接', connecting: '连接中', error: '失败', disconnecting: '断开中' };
                          return st !== 'disconnected' ? (
                            <span className={`vpn-state-badge ${st === 'connected' ? 'ok' : st === 'error' ? 'bad' : 'warn'}`}>{map[st]}</span>
                          ) : null;
                        })()}
                      </div>
                      <p>
                        {ENGINE_LABELS[selected.engine.type] || selected.engine.type}
                        <span>·</span>
                        <span className="font-mono">{selected.host}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="vpn-icon-button"
                      aria-label="编辑接入配置"
                      title="编辑接入配置"
                      onClick={() => setEngineEditorFor(selected.engine)}
                    >
                      <Pencil size={17} />
                    </button>
                    <button
                      className="vpn-icon-button"
                      aria-label="删除接入配置"
                      title="删除接入配置"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: '删除 VPN 账号', message: `确定要删除「${selected.name}」吗?正在连接时会先断开。`, danger: true }))) return;
                        await window.electronAPI?.vpn?.deleteProfile(selected.engine.id);
                        await refreshEngineProfiles();
                        setSelectedId('');
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  </div>
                </header>
                <div className="vpn-connection-body">
                  {(engineStateFor(selected.engine.id)?.state === 'error') && (
                    <div className="vpn-notice danger" role="alert">
                      {engineStateFor(selected.engine.id)!.message}
                    </div>
                  )}
                  <div className="vpn-connect-actions">
                    {(() => {
                      const rt = engineStateFor(selected.engine.id);
                      const st = rt?.state || 'disconnected';
                      return st === 'connected' || st === 'connecting' ? (
                        <button
                          className="vpn-button primary"
                          disabled={st === 'connecting'}
                          onClick={async () => {
                            await window.electronAPI?.vpn?.disconnect();
                            await refreshEngineProfiles();
                          }}
                        >
                          <Unplug size={16} />
                          {st === 'connected' ? '断开连接' : '连接中...'}
                        </button>
                      ) : (
                        <button
                          className="vpn-button primary"
                          onClick={async () => {
                            if (selected.engine.useMfa) {
                              // 引擎类 MFA:走引擎编辑弹窗补验证码(简化:直接连接,验证码在弹窗内补充)
                              setEngineEditorFor(selected.engine);
                              return;
                            }
                            await window.electronAPI?.vpn?.connect(selected.engine.id);
                            await refreshEngineProfiles();
                          }}
                        >
                          <Unplug size={16} />
                          连接
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </section>
            </div>
          )}
          {selected && !selected.engine && (
            <div className="vpn-detail-column">
              <section className="vpn-connection-card" aria-label="连接面板">
                <header className="vpn-connection-header">
                  <div className="vpn-connection-identity">
                    <ProviderMark protocol={selected.profile.protocol} />
                    <div className="min-w-0">
                      <div className="vpn-connection-title">
                        <h3>{selected.name}</h3>
                        <ConnectionBadge state={selectedState} />
                      </div>
                      <p>
                        {vpnProviders[selected.profile.protocol].name}
                        <span>·</span>
                        <span
                          className="font-mono"
                          title={`${selected.profile.gateway.host}:${selected.profile.gateway.port}`}
                        >
                          {selected.profile.gateway.host}:{selected.profile.gateway.port}
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    className="vpn-icon-button"
                    aria-label="编辑接入配置"
                    title="编辑接入配置"
                    disabled={active || busy}
                    onClick={() => setEditor(selected.profile)}
                  >
                    <Pencil size={17} />
                  </button>
                </header>
                <div className="vpn-connection-body">
                  <div className="vpn-connection-meta">
                    <span>
                      <KeyRound size={14} />
                      {selected.profile.username || '尚未填写账号'}
                    </span>
                    <span>
                      <ShieldCheck size={14} />
                      按资源分流
                    </span>
                    {selected.profile.loginDomain && (
                      <span>登录域：{selected.profile.loginDomain}</span>
                    )}
                  </div>
                  {connectionError && (
                    <div className="vpn-notice danger" role="alert">
                      {connectionError}
                    </div>
                  )}
                  <form
                    className="vpn-login-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (connectDisabled) return;
                      run(async () => {
                        const secret = password;
                        setPassword('');
                        setReveal(false);
                        await window.electronAPI.corporateVpn.connect(
                          selected.id,
                          secret,
                        );
                      });
                    }}
                  >
                    {!active && selected.profile.authMethod !== 'auth/smsCheckCode' && (
                      <label className="vpn-field">
                        <span>登录密码</span>
                        <div className="vpn-password-input">
                          <input
                            type={reveal ? 'text' : 'password'}
                            aria-label="登录密码"
                            autoComplete="off"
                            placeholder={
                              selected.profile.rememberPassword
                                ? '留空使用已保存的密码'
                                : '输入本次连接的密码'
                            }
                            value={password}
                            disabled={busy}
                            onChange={(event) =>
                              setPassword(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            aria-label={reveal ? '隐藏密码' : '显示密码'}
                            onClick={() => setReveal(!reveal)}
                          >
                            {reveal ? <EyeOff size={17} /> : <Eye size={17} />}
                          </button>
                        </div>
                      </label>
                    )}
                    {!active && selected.profile.authMethod === 'auth/smsCheckCode' && (
                      <div className="vpn-notice">
                        <KeyRound size={17} />
                        <p>连接后按提示输入短信验证码，无需填写密码。</p>
                      </div>
                    )}
                    {active && state.profileId === selected.id && (
                      <div className="vpn-session-status" role="status">
                        {selectedState === 'connected' ? (
                          <ShieldCheck size={27} />
                        ) : (
                          <LoaderCircle
                            size={25}
                            className="animate-spin motion-reduce:animate-none"
                          />
                        )}
                        <div>
                          <strong>
                            {selectedState === 'connected'
                              ? 'VPN 隧道已连接'
                              : labels[selectedState]}
                          </strong>
                          <p>
                            {selectedState === 'connected'
                              ? '接入资源经专属隧道访问，其他流量沿用现有出口。'
                              : selectedState === 'waiting_user'
                                ? '请完成弹窗中的身份验证。'
                                : '连接过程中可以随时取消。'}
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="vpn-connect-actions">
                      <p>
                        <LockKeyhole size={13} />
                        {selected.profile.rememberPassword
                          ? '已开启系统加密记忆'
                          : '密码仅用于本次连接'}
                      </p>
                      {active ? (
                        <button
                          type="button"
                          className="vpn-button"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await window.electronAPI.corporateVpn.disconnect();
                            })
                          }
                        >
                          <Unplug size={16} />
                          {selectedState === 'connected'
                            ? '断开连接'
                            : '取消连接'}
                        </button>
                      ) : (
                        <button
                          type="submit"
                          className="vpn-button primary"
                          disabled={connectDisabled}
                        >
                          {busy ? (
                            <LoaderCircle
                              size={16}
                              className="animate-spin motion-reduce:animate-none"
                            />
                          ) : (
                            <Plug size={16} />
                          )}
                          连接 VPN
                        </button>
                      )}
                    </div>
                  </form>
                </div>
                <div className="vpn-flow-strip">
                  <span>
                    <Network size={15} />
                    VPN 资源
                    <ArrowRight size={13} />
                    <strong>专属隧道</strong>
                  </span>
                  <span>
                    <Globe2 size={15} />
                    其他流量
                    <ArrowRight size={13} />
                    <strong>沿用原规则</strong>
                  </span>
                </div>
              </section>
              <section className="vpn-resource-card">
                <div
                  className="vpn-detail-tabs"
                  role="tablist"
                  aria-label="接入详情"
                >
                  <button
                    type="button"
                    role="tab"
                    id="vpn-resources-tab"
                    aria-controls="vpn-resources-panel"
                    aria-selected={detailTab === 'resources'}
                    onClick={() => setDetailTab('resources')}
                  >
                    <Waypoints size={15} />
                    接入资源<span>{resourceRows.length}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="vpn-help-tab"
                    aria-controls="vpn-help-panel"
                    aria-selected={detailTab === 'help'}
                    onClick={() => setDetailTab('help')}
                  >
                    <HelpCircle size={15} />
                    连接说明
                  </button>
                </div>
                {detailTab === 'resources' ? (
                  <div
                    id="vpn-resources-panel"
                    role="tabpanel"
                    aria-labelledby="vpn-resources-tab"
                    className="vpn-resource-body"
                  >
                    {!!resources?.dnsServers.length && (
                      <div className="vpn-dns-line">
                        <Server size={14} />
                        <span>VPN DNS</span>
                        <code>{resources.dnsServers.join(' / ')}</code>
                        <span className="vpn-cache-label">
                          {selectedState === 'connected'
                            ? '当前下发'
                            : '上次下发'}
                        </span>
                      </div>
                    )}
                    {resourceRows.length ? (
                      <>
                        <div className="vpn-resource-table-wrap">
                          <table className="vpn-resource-table">
                            <thead>
                              <tr>
                                <th>目标资源</th>
                                <th>来源 / 协议</th>
                              </tr>
                            </thead>
                            <tbody>
                              {resourceRows
                                .slice(0, expanded ? 100 : 4)
                                .map(({ target, source }, i) => (
                                  <tr key={i}>
                                    <td>
                                      <span
                                        title={[
                                          ...target.domains,
                                          ...target.cidrs,
                                        ].join(', ')}
                                      >
                                        {[
                                          ...target.domains,
                                          ...target.cidrs,
                                        ].join(', ')}
                                      </span>
                                      <small>
                                        {target.ports?.join(', ') || '全部端口'}
                                      </small>
                                    </td>
                                    <td>
                                      <span>{source}</span>
                                      <small>
                                        {target.guardOnly
                                          ? '协议暂不支持，仅保护'
                                          : (
                                              target.network || 'TCP / UDP'
                                            ).toUpperCase()}
                                      </small>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                        {resourceRows.length > 4 && (
                          <button
                            className="vpn-resource-expand"
                            onClick={() => setExpanded(!expanded)}
                          >
                            {expanded
                              ? '收起资源'
                              : `查看全部 ${resourceRows.length} 条资源`}
                            <ChevronDown
                              size={14}
                              className={expanded ? 'rotate-180' : ''}
                            />
                          </button>
                        )}
                        {expanded && resourceRows.length > 100 && (
                          <p className="vpn-field-hint">
                            仅展示前 100 条，全部 {resourceRows.length}{' '}
                            条规则均参与分流。
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="vpn-resources-empty">
                        <Waypoints size={23} />
                        <div>
                          <h4>连接后自动获取授权资源</h4>
                          <p>也可以在编辑配置中补充域名、IP 和固定解析。</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    id="vpn-help-panel"
                    role="tabpanel"
                    aria-labelledby="vpn-help-tab"
                    className="vpn-help-body"
                  >
                    <div>
                      <span>01</span>
                      <section>
                        <h4>保存配置，应用分流</h4>
                        <p>
                          新增或删除接入后应用一次分流，会短暂重连公网代理。
                        </p>
                      </section>
                    </div>
                    <div>
                      <span>02</span>
                      <section>
                        <h4>连接并完成身份验证</h4>
                        <p>动态码、短信和图片验证码会在连接时弹出。</p>
                      </section>
                    </div>
                    <div>
                      <span>03</span>
                      <section>
                        <h4>让更多应用自动分流</h4>
                        <p>
                          浏览器可使用系统代理；无参数 curl、SSH
                          等软件需在首页开启 TUN。当前支持 IPv4 TCP，ping
                          不作为连通性判断依据。
                        </p>
                      </section>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}
      {editor && (
        <VpnProfileEditor
          profile={editor}
          encryptionAvailable={snapshot.encryptionAvailable}
          onClose={() => setEditor(undefined)}
          onSaved={async (profile, keepOpen) => {
            await refresh();
            setSelectedId(profile.id);
            setEditor(keepOpen ? profile : undefined);
          }}
          onRemoved={async () => {
            await refresh();
            setEditor(undefined);
          }}
        />
      )}
      {addPickerOpen && (
        <Portal>
          <div className="vpn-modal-backdrop no-drag" onClick={(e) => { if (e.target === e.currentTarget) setAddPickerOpen(false); }}>
            <div className="vpn-surface" role="dialog" aria-modal="true" aria-label="选择接入类型" style={{ maxWidth: 460, width: '100%', borderRadius: 14, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <strong style={{ fontSize: 14 }}>选择接入类型</strong>
                <button className="vpn-button compact" onClick={() => setAddPickerOpen(false)}>关闭</button>
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                <button
                  className="vpn-button"
                  style={{ textAlign: 'left', padding: '12px 14px' }}
                  onClick={() => { setAddPickerOpen(false); setEditor(newVpnProfile()); }}
                >
                  <strong>EasyConnect / aTrust</strong>
                  <div style={{ fontSize: 11, color: 'var(--vpn-muted)', marginTop: 2 }}>
                    深信服系列网关,内置协议核心,支持密码/动态码/短信认证
                  </div>
                </button>
                <button
                  className="vpn-button"
                  style={{ textAlign: 'left', padding: '12px 14px' }}
                  onClick={() => { setAddPickerOpen(false); setEngineEditorOpen(true); }}
                >
                  <strong>协议引擎类</strong>
                  <div style={{ fontSize: 11, color: 'var(--vpn-muted)', marginTop: 2 }}>
                    IKEv2 / L2TP / SSTP / OpenVPN / SoftEther 兼容端点 / AnyConnect / FortiClient / GlobalProtect / Pulse / Juniper / F5 / Array / WireGuard
                  </div>
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
      {engineEditorFor !== undefined && (
        <VpnProfileEditorModal
          profile={engineEditorFor}
          onSave={async (profile) => {
            const ok = await window.electronAPI?.vpn?.saveProfile(profile);
            if (ok) {
              await refreshEngineProfiles();
              setSelectedId(engineKey(profile.id));
              toast.success('VPN 账号已保存');
            } else {
              toast.warn('保存失败:名称与服务器为必填项');
            }
            setEngineEditorFor(undefined);
          }}
          onClose={() => setEngineEditorFor(undefined)}
        />
      )}
    </div>
  );
};

export const VpnAccessStatus: React.FC<{
  onOpen: () => void;
  showSummary?: boolean;
}> = ({ onOpen, showSummary = true }) => {
  const { snapshot } = useVpnSnapshot();
  const { state } = snapshot;
  const challengeRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.challenge) return;
    const previous = document.activeElement as HTMLElement | null;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.electronAPI.corporateVpn
          .disconnect()
          .catch((e) => toast.error(String(e)));
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        challengeRoot.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ) || [],
      );
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    challengeRoot.current?.querySelector<HTMLElement>('input, button')?.focus();
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      previous?.focus();
    };
  }, [state.challenge?.id]);
  return (
    <>
      {showSummary && (state.profileId || snapshot.profiles.length > 0) && (
        <button onClick={onOpen} className="vpn-surface vpn-global-status">
          <Network size={14} />
          <span>VPN 接入</span>
          <ConnectionBadge state={state.state} />
          <span className="vpn-global-hint">查看接入</span>
          <ArrowRight size={13} />
        </button>
      )}
      {state.challenge && (
        <Portal>
          <div className="vpn-modal-backdrop vpn-challenge-backdrop no-drag">
            <div
              className="vpn-surface vpn-auth-dialog"
              ref={challengeRoot}
              role="dialog"
              aria-modal="true"
              aria-label="VPN 身份验证"
            >
              <div className="vpn-auth-label">
                <ShieldCheck size={16} />
                VPN 身份验证
              </div>
              <ChallengeForm
                key={state.challenge.id}
                challenge={state.challenge}
                onSubmit={(value) =>
                  window.electronAPI.corporateVpn
                    .respond(state.challenge!.id, state.generation, value)
                    .catch((e) => toast.error(String(e)))
                }
              />
            </div>
          </div>
        </Portal>
      )}
    </>
  );
};

function ChallengeForm({
  challenge,
  onSubmit,
}: {
  challenge: VpnChallenge;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [points, setPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [time, setTime] = useState(Date.now());
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = time >= challenge.expiresAt;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          challenge.kind === 'confirm-sms'
            ? 'confirm'
            : challenge.kind === 'structured'
              ? captchaAnswer(points, dimensions.width, dimensions.height)
              : value,
        );
      }}
      className="space-y-4"
    >
      <h3 className="text-base font-semibold">{challenge.title}</h3>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        剩余 {Math.max(0, Math.ceil((challenge.expiresAt - time) / 1000))} 秒
      </p>
      {challenge.imageBase64 && (
        <div>
          <div className="relative inline-block">
            <img
              alt="服务器验证码"
              onLoad={(e) =>
                setDimensions({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              className="max-w-full"
              src={`data:${['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(challenge.mime || '') ? challenge.mime : 'image/jpeg'};base64,${challenge.imageBase64}`}
              onClick={
                challenge.kind === 'structured'
                  ? (e) => {
                      const img = e.currentTarget,
                        r = img.getBoundingClientRect();
                      setPoints([
                        ...points,
                        {
                          x: Math.max(
                            0,
                            Math.min(
                              img.naturalWidth - 1,
                              Math.round(
                                ((e.clientX - r.left) * img.naturalWidth) /
                                  r.width,
                              ),
                            ),
                          ),
                          y: Math.max(
                            0,
                            Math.min(
                              img.naturalHeight - 1,
                              Math.round(
                                ((e.clientY - r.top) * img.naturalHeight) /
                                  r.height,
                              ),
                            ),
                          ),
                        },
                      ]);
                    }
                  : undefined
              }
            />
            {challenge.kind === 'structured' &&
              points.map((point, i) => (
                <span
                  key={i}
                  className="absolute pointer-events-none w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${(point.x / dimensions.width) * 100}%`,
                    top: `${(point.y / dimensions.height) * 100}%`,
                  }}
                >
                  {i + 1}
                </span>
              ))}
          </div>
          {challenge.kind === 'structured' && (
            <p className="text-xs mt-2">
              已选择 {points.length} 个点{' '}
              <button
                type="button"
                className="text-blue-500"
                onClick={() => setPoints([])}
              >
                重新选择
              </button>
            </p>
          )}
        </div>
      )}
      {!['structured', 'confirm-sms'].includes(challenge.kind) && (
        <input
          aria-label="验证码"
          autoFocus
          autoComplete="off"
          className={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={button}
          onClick={() =>
            window.electronAPI.corporateVpn
              .disconnect()
              .catch((e) => toast.error(String(e)))
          }
        >
          取消连接
        </button>
        <button
          type="submit"
          className={button + ' primary'}
          disabled={
            expired ||
            (challenge.kind === 'structured' && !points.length) ||
            (!['structured', 'confirm-sms'].includes(challenge.kind) && !value)
          }
        >
          {challenge.kind === 'confirm-sms' ? '发送短信' : '提交验证码'}
        </button>
      </div>
    </form>
  );
}
