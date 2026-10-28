import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
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
  Settings2,
  Server,
  ShieldCheck,
  Unplug,
  Waypoints,
  Trash2,
  X,
} from 'lucide-react';
import {
  VpnChallenge,
  VpnProfile,
  VpnProtocol,
  VpnState,
  VpnTarget,
} from '../../types/corporateVpn';
import { AppSettings } from '../../types';
import { captchaAnswer } from '../../utils/vpnChallenge';
import { orderedVpnProfiles, vpnRouting, vpnTrafficModes } from '../../utils/vpnRouting';
import { useVpnSnapshot } from '../vpn/useVpnSnapshot';
import { VpnProfile as EngineVpnProfile, VpnProfileType, VpnRuntimeInfo } from '../../types';
import { VpnProfileEditorModal, TYPE_GROUPS } from './VpnProfileEditorModal';
import { vpnProviderList, vpnProviders } from '../vpn/providers';
import {
  newVpnProfile,
  VpnProfileEditor,
} from '../components/VpnProfileEditor';
import { Portal } from '../components/Portal';
import { ModalCloseX, modalOverlayClass, modalPopClass, useMaskDrag } from '../components/ModalShell';
import { useModalExit } from '../hooks/useModalExit';
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
  TLS_CERT_CHANGED:
    '网关证书与之前记录的不一致，已停止发送登录信息。请检查网关地址，并确认是否更换过证书。',
  TLS_CERT_EXPIRED: '网关证书已过期，请检查系统时间或联系网关管理员更新证书。',
  TLS_CERT_NOT_YET_VALID: '网关证书尚未生效，请检查电脑的日期和时间。',
  TLS_UNTRUSTED:
    '网关证书不受信任或名称不匹配。请在高级选项中配置 CA，或核对服务器证书。',
  AUTH_OR_TUNNEL_FAILED: '认证或隧道建立失败，请核对账号、认证方式和网关要求。',
  ATRUST_TRUSTED_ENDPOINT_REQUIRED: '网关要求可信终端，当前接入未通过终端识别（75500503）。这一步发生在密码认证之后；请使用官方 aTrust 客户端完成接入，当前协议暂不兼容此网关要求。',
  GATEWAY_UNREACHABLE: '无法连接网关，请检查服务器地址、端口和物理网络。',
  AUTH_TIMEOUT: '认证等待超时，请重新连接。',
  ROUTING_PREPARE_FAILED: '分流准备未完成，VPN 尚未登录。请检查代理核心日志后重试；原有节点和接入配置已保留。',
  AUTH_CHALLENGE_EXPIRED: '验证码已过期，请重新连接。',
  AUTH_METHOD_UNSUPPORTED:
    '当前认证方式尚不支持，请编辑配置并选择已支持的方式。',
  CORE_EXITED: 'VPN 组件已退出，已知接入资源保持保护，请重新连接。',
  POLICY_APPLY_FAILED: '隧道已就绪，但尚未确认分流生效，请检查日志后重新连接。',
  VPN_TRANSPORT_DOWN: 'VPN 隧道已断开，请重新连接。',
  AUTH_FAILED: '账号或密码验证失败，请核对密码与认证方式。',
  SOFTETHER_HUB_NOT_FOUND: '未找到 Virtual HUB，请核对名称及大小写。',
  SOFTETHER_DHCP_FAILED: 'SoftEther 已认证，但未能获取虚拟地址，请检查网关 DHCP 配置。',
  SOFTETHER_TRANSPORT_UNSUPPORTED: '网关要求的传输方式暂不支持，需要启用单连接加密 TCP 模式。',
  SOFTETHER_CLIENT_VERSION_UNSUPPORTED: '网关要求的客户端协议版本高于当前兼容范围，请更新 BlueWing 或使用受支持的客户端。',
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

export const VpnAccess: React.FC<{
  settings: Pick<AppSettings, 'mixedPort' | 'inboundAuth' | 'tunEnabled'>;
  coreState: string;
  publicProxy?: { enabled: boolean; name?: string; mode?: 'rule' | 'global' | 'direct' };
}> = ({ settings, coreState, publicProxy = { enabled: false } }) => {
  const { snapshot, loading, error: loadError, refresh } = useVpnSnapshot();
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<VpnProfile>();
  const [editorTab, setEditorTab] = useState<'connection' | 'routing' | 'advanced'>(
    'connection',
  );
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState('');
  const [detailTab, setDetailTab] = useState<'resources' | 'help'>('resources');
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
  const detailRef = useRef<HTMLDivElement>(null);
  const stateFor = (id: string): VpnState => snapshot.states?.[id] || (snapshot.state.profileId === id ? snapshot.state : {
    state: 'idle', generation: 0, coreAvailable: snapshot.state.coreAvailable, requiresCoreRebuild: snapshot.state.requiresCoreRebuild,
  });
  const state = stateFor(selectedId);
  const connectedCount = Object.values(snapshot.states || { legacy: snapshot.state }).filter(s => s.state === 'connected').length;
  const runningCount = Object.values(snapshot.states || { legacy: snapshot.state }).filter(s => !['idle', 'failed'].includes(s.state)).length;
  const defaultProfile = snapshot.profiles.find(p => p.id === snapshot.defaultProfileId);
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
  const selectedActive = active && state.profileId === selectedId;
  const selectedProtected = state.trafficProtected === true && state.profileId === selectedId;
  const selectedDiagnostic = selected && snapshot.diagnostics?.[selected.id];
  const errorDetail = state.profileId === selectedId ? state.errorDetail : undefined;
  const effectivePublicPolicy = defaultProfile || (selected && !selected.engine ? selected.profile : undefined);
  // 列表与空状态按「corporate + 引擎」总数判定,只加引擎类档案也要出现在页面上
  const totalCount = snapshot.profiles.length + engineProfiles.length;
  useEffect(() => {
    // 选中守卫基于统一列表(含引擎项),否则点选引擎项会被弹回 corporate 项
    if (profiles.some((profile) => profile.id === selectedId)) return;
    setSelectedId(
      profiles.find(
        (profile) => !profile.engine && profile.id === state.profileId,
      )?.id ||
        profiles[0]?.id ||
        '',
    );
  }, [profiles, selectedId, state.profileId]);
  useEffect(() => {
    setPassword('');
    setReveal(false);
    setActionError('');
    setExpanded(false);
    detailRef.current?.scrollTo(0, 0);
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
          ...selected.profile.targets.map((target) => ({ target, source: '用户自定义' })),
          ...Object.entries(selected.profile.hosts).map(([domain, ips]) => ({
            target: { domains: [domain], cidrs: ips, network: 'tcp' as const },
          ...(snapshot.discoveredTargets?.[selected.profile.id] || []).map((target) => ({ target, source: '自动识别' })),
            source: '用户固定解析',
          })),
          ...(resources?.targets || []).map((target) => ({
            target,
            source: selected.profile.protocol === 'softether' ? '网络发现' : '网关下发',
          })),
        ]
      : [];

  const connectionError =
    actionError ||
    (state.profileId === selectedId && state.error
      ? errorLabels[state.error] || state.error
      : '');
  // 左侧卡片列表直接删除:连接中先断开(引擎是单会话,无参断开;corporate 按档断开),
  // 再走各自后端删除;成功后清空选中,由选中守卫自动落到下一项
  const handleDeleteProfile = async (
    item: (typeof profiles)[number],
    e: React.MouseEvent,
  ): Promise<void> => {
    e.stopPropagation();
    const kind = item.engine ? 'VPN 接入' : 'VPN 账号';
    if (
      !(await confirmDialog({
        title: `删除${kind}`,
        message: `确定要删除「${item.name}」吗?正在连接时会先断开,删除后不可恢复。`,
        danger: true,
      }))
    ) {
      return;
    }
    run(async () => {
      if (item.engine) {
        if (engineStateFor(item.engine.id)) {
          try { await window.electronAPI?.vpn?.disconnect(); } catch { /* 断开失败不阻塞删除 */ }
        }
        await window.electronAPI?.vpn?.deleteProfile(item.engine.id);
        await refreshEngineProfiles();
      } else {
        if (!['idle', 'failed'].includes(stateFor(item.id).state)) {
          try { await window.electronAPI.corporateVpn.disconnect(item.id); } catch { /* 同上 */ }
        }
        await window.electronAPI.corporateVpn.remove(item.id);
        await refresh();
      }
      setSelectedId('');
      toast.success(`已删除「${item.name}」`);
    });
  };
  const connectDisabled =
    busy ||
    cancelling ||
    selectedActive ||
    state.coreAvailable === false;
  const passwordSaved = !!(selected && snapshot.passwordSaved?.[selected.id]);
  const openEditor = (
    profile: VpnProfile,
    tab: 'connection' | 'routing' | 'advanced' = 'connection',
  ) => {
    setEditorTab(tab);
    setEditor(profile);
  };
  const storePassword = (remember: boolean) =>
    run(async () => {
      if (!selected) return;
      const saving = remember && !!password;
      await window.electronAPI.corporateVpn.savePassword(
        selected.id,
        password,
        remember,
      );
      await refresh();
      if (saving) {
        setPassword('');
        setReveal(false);
      }
      toast.success(
        saving
          ? '密码已加密保存，下次连接可留空'
          : remember
            ? '已开启密码记忆，连接时自动保存'
            : '已清除此接入保存的密码',
      );
    });
  return (
    <div className="vpn-surface vpn-access">
      <header className="vpn-page-header">
        <div className="flex items-center gap-3">
          <div className="vpn-heading-icon">
            <Network size={23} />
          </div>
          <div>
            <h2>VPN 接入</h2>
            <p>连接公司网络，同时为国内公网和国外网站选择合适的出口。</p>
          </div>
        </div>
        {!!totalCount && (
          <button
            className="vpn-button"
            disabled={busy}
            onClick={() => setAddPickerOpen(true)}
          >
            <Plus size={16} />
            新增接入
          </button>
        )}
      </header>
      {snapshot.states && <div className="vpn-multi-summary" role="status" aria-label="多 VPN 连接状态">
        <span><Network size={15} />已连接 <strong>{connectedCount}</strong> 个接入
          {defaultProfile && <small>默认策略：{defaultProfile.name} · 优先级 {defaultProfile.routingPriority ?? 100}</small>}</span>
        {runningCount > 0 && <button className="vpn-text-button" disabled={busy} onClick={() => run(async () => { await window.electronAPI.corporateVpn.disconnect(); await refresh(); })}>断开全部</button>}
      </div>}
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
      {!active && state.requiresCoreRebuild && snapshot.profiles.length > 0 && (
        <div className="vpn-notice vpn-apply-banner" role="status">
          <RefreshCw size={18} />
          <div>
            <strong>连接时自动准备分流</strong>
            <p>{coreState === 'running'
              ? '点击“连接 VPN”即可。必要的配置更新可能使现有公网连接短暂重连。'
              : '点击“连接 VPN”将自动启动本地分流服务，无需代理节点。'}</p>
          </div>
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
      ) : totalCount === 0 ? (
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
                {totalCount.toString().padStart(2, '0')}
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
            <div className="vpn-profile-items" role="region" aria-label="VPN 接入列表" tabIndex={0}>
              {profiles.map((profile) => { const itemState = stateFor(profile.id); return (
                // 卡片容器不能用 <button>:内部要嵌删除按钮,button 嵌 button 非法
                <div
                  key={profile.id}
                  role="button"
                  tabIndex={0}
                  className={`vpn-profile-item ${selectedId === profile.id ? 'selected' : ''}`}
                  aria-pressed={selectedId === profile.id}
                  title={profile.host}
                  onClick={() => setSelectedId(profile.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedId(profile.id);
                    }
                  }}
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
                      : itemState.state === 'connected' && (
                          <CheckCircle2 size={15} className="vpn-success-text shrink-0" />
                        )}
                    <button
                      className="vpn-item-delete"
                      aria-label={`删除${profile.engine ? 'VPN 接入' : 'VPN 账号'} ${profile.name}`}
                      title="删除"
                      onClick={(e) => { void handleDeleteProfile(profile, e); }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <span className="vpn-profile-gateway">
                    {profile.host}
                  </span>
                  <span className="vpn-profile-protocol">
                    {profile.label}
                    {!['idle'].includes(itemState.state) && (
                      <span>{labels[itemState.state]}</span>
                    )}
                  </span>
                </div>
              ); })}
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
              <Network size={13} />
              支持多个接入同时连接
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
                          连接 VPN
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
                    aria-label={active ? '查看接入配置' : '编辑接入配置'}
                    title={active ? '查看接入配置（连接期间只读）' : '编辑接入配置'}
                    disabled={busy}
                    onClick={() => openEditor(selected.profile)}
                  >
                    {active ? <Eye size={17} /> : <Pencil size={17} />}
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
                      {selected.profile.tls.pinSha256
                        ? '证书指纹已固定'
                        : selected.profile.tls.trustMode === 'strict'
                          ? '严格证书校验'
                          : '首次自动记住网关证书'}
                    </span>
                    {selected.profile.protocol === 'atrust' ? (
                      <span>认证入口：{selected.profile.authName || selected.profile.authChoices?.find((m) => m.loginDomain === selected.profile.loginDomain && m.authType === selected.profile.authMethod)?.authName || '尚未获取'}</span>
                    ) : selected.profile.loginDomain && (
                      <span>登录域：{selected.profile.loginDomain}</span>
                    )}
                  </div>
                  {selected.profile.protocol === 'atrust' && <div className="vpn-auth-entry">
                    <div className="vpn-section-heading"><div><h3>登录方式</h3><p>选择与官方客户端一致的入口，切换后按该入口重新验证。</p></div>
                      <button type="button" className="vpn-button compact" disabled={busy || active} onClick={() => run(async () => {
                        await window.electronAPI.corporateVpn.discover(selected.id); await refresh();
                      })}><RefreshCw size={14} />{selected.profile.authChoices?.length ? '刷新入口' : '获取登录方式'}</button>
                    </div>
                    {!!selected.profile.authChoices?.length && <div className="vpn-auth-choices" role="group" aria-label="登录方式">
                      {selected.profile.authChoices.map((method, index) => <button type="button" key={index}
                        className={`vpn-auth-choice ${method.loginDomain === selected.profile.loginDomain && method.authType === selected.profile.authMethod ? 'selected' : ''}`}
                        aria-pressed={method.loginDomain === selected.profile.loginDomain && method.authType === selected.profile.authMethod}
                        disabled={busy || active || !method.supported}
                        onClick={() => run(async () => {
                          await window.electronAPI.corporateVpn.save({ ...selected.profile, authMethod: method.authType, loginDomain: method.loginDomain, authName: method.authName });
                          setPassword(''); setReveal(false); await refresh();
                        })}><KeyRound size={16} /><span>{method.authName}<small>{!method.supported ? '暂不支持此方式' : method.authType === 'auth/smsCheckCode' ? '短信验证码' : '账号密码'}</small></span></button>)}
                    </div>}
                    {!!selected.profile.authChoices?.length && !selected.profile.authChoices.some((m) => m.loginDomain === selected.profile.loginDomain && m.authType === selected.profile.authMethod) &&
                      <p className="vpn-inline-error">当前配置的入口不在最新列表中，请选择正确的登录方式。</p>}
                    <details className="vpn-auth-parameters"><summary>认证参数</summary><code>登录域：{selected.profile.loginDomain || '未指定'} · 方式：{selected.profile.authMethod}</code></details>
                  </div>}
                  {connectionError && (
                    <div
                      className="vpn-notice danger vpn-connection-error"
                      role="alert"
                    >
                      <p>{connectionError}</p>
                      {selectedProtected && state.state === 'failed' && (
                        <div>
                          <p>VPN 异常断开，此接入的已知资源暂时受保护。重新连接可恢复 VPN，或停止此接入并恢复普通分流。</p>
                          <button type="button" className="vpn-button compact" disabled={busy}
                            onClick={() => run(async () => { await window.electronAPI.corporateVpn.disconnect(selected.id); await refresh(); })}>恢复普通分流</button>
                        </div>
                      )}
                      {errorDetail && <details className="vpn-error-detail" open={state.error === 'ATRUST_TRUSTED_ENDPOINT_REQUIRED'}>
                        <summary>原始错误 · {errorDetail.stage}{errorDetail.serverCode ? ` · ${errorDetail.serverCode}` : ''}</summary>
                        <pre>{errorDetail.message}</pre>
                        <button type="button" className="vpn-text-button" onClick={() => run(async () => {
                          await navigator.clipboard.writeText(JSON.stringify({ code: state.error, ...errorDetail }, null, 2)); toast.success('已复制原始错误');
                        })}><Copy size={13} />复制错误详情</button>
                      </details>}
                      {state.profileId === selectedId &&
                        [
                          'TLS_UNTRUSTED',
                          'TLS_CERT_CHANGED',
                          'TLS_CERT_EXPIRED',
                          'TLS_CERT_NOT_YET_VALID',
                        ].includes(state.error || '') &&
                        !active && (
                          <button
                            type="button"
                            className="vpn-button compact"
                            disabled={busy}
                            onClick={() => openEditor(selected.profile, 'advanced')}
                          >
                            <ShieldCheck size={14} />
                            检查网关证书
                          </button>
                        )}
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
                    {!selectedActive && selected.profile.authMethod !== 'auth/smsCheckCode' && (
                      <div className="vpn-field">
                        <div className="vpn-password-label">
                          <label htmlFor="vpn-login-password">登录密码</label>
                          <label
                            className="vpn-remember-option"
                            title={
                              snapshot.encryptionAvailable
                                ? '使用 Windows 系统加密保存，不包含验证码'
                                : '当前系统加密不可用'
                            }
                          >
                            <input
                              type="checkbox"
                              className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                              aria-label="加密记住密码"
                              checked={selected.profile.rememberPassword}
                              disabled={busy || active || !snapshot.encryptionAvailable}
                              onChange={(event) =>
                                storePassword(event.target.checked)
                              }
                            />
                            加密记住密码
                          </label>
                        </div>
                        <div className="vpn-password-input">
                          <input
                            type={reveal ? 'text' : 'password'}
                            aria-label="登录密码"
                            id="vpn-login-password"
                            autoComplete="off"
                            placeholder={
                              passwordSaved
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
                      </div>
                    )}
                    {!selectedActive && selected.profile.authMethod === 'auth/smsCheckCode' && (
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
                              : state.preparingRouting ? '正在准备分流'
                              : labels[selectedState]}
                          </strong>
                          <p>
                            {selectedState === 'connected'
                              ? '接入资源经专属隧道访问，其他流量沿用现有出口。'
                              : state.preparingRouting ? '分流就绪后自动登录 VPN；准备期间可以取消。'
                              : selectedState === 'waiting_user'
                                ? '请完成弹窗中的身份验证。'
                                : '连接过程中可以随时取消。'}
                          </p>
                        </div>
                      </div>
                    )}
                    <div className="vpn-connect-actions">
                      <div className="vpn-credential-summary">
                        <p>
                          <LockKeyhole size={13} />
                          {passwordSaved
                            ? '密码已加密保存，下次连接可留空'
                            : selected.profile.rememberPassword
                              ? '连接时自动加密保存密码'
                              : '密码仅用于本次连接'}
                        </p>
                        {!active && selected.profile.rememberPassword && !!password && (
                          <button
                            type="button"
                            className="vpn-text-button"
                            disabled={busy}
                            onClick={() => storePassword(true)}
                          >
                            保存密码
                          </button>
                        )}
                      </div>
                      {selectedActive ? (
                        <button
                          type="button"
                          className="vpn-button"
                          disabled={cancelling}
                          onClick={async () => {
                            setCancelling(true);
                            try { await window.electronAPI.corporateVpn.disconnect(selected.id); }
                            catch (e) { setActionError(e instanceof Error ? e.message : String(e)); }
                            finally { setCancelling(false); }
                          }}
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
                  <div className="vpn-diagnostics-bar">
                    <span>{selected.profile.diagnosticMode === 'full' ? '完整诊断已开启 · 含明文凭据' : selected.profile.diagnosticMode === 'detail' ? '连接诊断已开启' : '基础错误日志'}</span>
                    <div><button type="button" className="vpn-text-button" disabled={busy || !selectedDiagnostic?.exists}
                      onClick={() => run(async () => { await window.electronAPI.corporateVpn.openDiagnostics(selected.id); })}>打开日志</button>
                    <button type="button" className="vpn-text-button" disabled={busy || !selectedDiagnostic?.exists}
                      onClick={() => run(async () => { await window.electronAPI.corporateVpn.clearDiagnostics(selected.id); await refresh(); })}>清空日志</button>
                    <button type="button" className="vpn-text-button" onClick={() => openEditor(selected.profile, 'advanced')}>诊断设置</button></div>
                    {selectedDiagnostic?.error && <p role="alert">日志写入失败:{selectedDiagnostic.error}</p>}
                  </div>
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
                    当前策略
                    <ArrowRight size={13} />
                    <strong>{vpnTrafficModes.find((m) => m.id === (selected.profile.trafficMode || 'split'))?.name}</strong>
                  </span>
                </div>
              </section>
              <section className="vpn-routing-overview" aria-label="当前流量去向">
                <div className="vpn-routing-overview-heading">
                  <div><span className="vpn-eyebrow">流量去向</span>
                    <h3>{vpnTrafficModes.find((m) => m.id === (selected.profile.trafficMode || 'split'))?.name}</h3></div>
                  <button className="vpn-button compact" disabled={busy} onClick={() => openEditor(selected.profile, 'routing')}>
                    <Settings2 size={14} />{active ? '查看策略' : '调整策略'}
                  </button>
                </div>
                {defaultProfile && defaultProfile.id !== selected.id && <p className="vpn-field-hint" role="status">
                  国内和国外流量当前按「{defaultProfile.name}」的策略处理；此接入的公司资源仍走各自隧道。
                </p>}
                <div className="vpn-outlet-grid">
                  {([
                    { label: '公司资源', icon: Network, outlet: 'vpn' as const },
                    { label: '国内公网', icon: Globe2, outlet: vpnRouting(effectivePublicPolicy!, publicProxy.enabled).domestic },
                    { label: '国外网站', icon: Waypoints, outlet: vpnRouting(effectivePublicPolicy!, publicProxy.enabled).foreign },
                  ]).map(({ label, icon: Icon, outlet }) => {
                    const connected = selectedState === 'connected';
                    const actual = !connected && label === '公司资源' && !selectedProtected ? 'normal' : !defaultProfile && !connected && label !== '公司资源'
                      ? (publicProxy.enabled && (label === '国外网站' || publicProxy.mode === 'global') ? 'proxy' : 'direct') : outlet;
                    return <div className={`vpn-outlet-item ${actual}`} key={label}>
                      <span className="vpn-outlet-icon"><Icon size={18} /></span><span className="vpn-outlet-label">{label}</span>
                      <strong>{actual === 'normal' ? '普通分流' : actual === 'vpn' ? 'VPN 隧道' : actual === 'proxy' ? '公网代理' : '本机直连'}</strong>
                      <small>{actual === 'normal' ? '此接入未接管流量' : actual === 'vpn' ? label !== '公司资源' && defaultProfile ? defaultProfile.name : connected ? selected.name : '连接未就绪 · 已知目标受保护'
                        : actual === 'proxy' ? `${publicProxy.name || '当前节点'}${coreState !== 'running' ? ' · 未启动' : ''}` : '保留本地网络出口'}</small>
                    </div>;
                  })}
                </div>
                <div className="vpn-discovery-note"><ShieldCheck size={15} /><p>
                  {(selected.profile.trafficMode || 'split') === 'split' && selected.profile.autoDiscoverPrivate !== false
                    ? '自动识别已开启：未知私网目标先验证本机路径，再按优先级尝试已连接的 VPN。公网公司地址与特殊域名可手动补充。'
                    : selected.profile.protocol === 'softether' ? 'SoftEther 自动发现部分网络，公司其他资源可手动补充。'
                    : resources?.targets.length ? `已读取 ${resources.targets.length} 条网关资源；手动补充规则优先。`
                    : '连接后自动读取公司资源；只知道业务网址或服务器 IP，也可以手动添加。'}
                  {publicProxy.enabled ? ' 国外网站保持公网代理出口。' : ' 开启公网代理后，国外网站可走代理。'}
                </p></div>
                {!!snapshot.discoveredTargets?.[selected.id]?.length && (
                  <div className="vpn-learned-summary">
                    <span>此接入已自动识别 {snapshot.discoveredTargets[selected.id].length} 个 TCP 目标；新会话会重新验证路径。</span>
                    <button className="vpn-button compact" disabled={active || busy}
                      title={active ? '断开 VPN 后可清空自动识别记录' : '清空此接入的自动识别记录，保留手动规则'}
                      onClick={() => run(async () => { await window.electronAPI.corporateVpn.clearDiscoveredTargets(selected.id); await refresh(); })}>清空识别记录</button>
                  </div>
                )}
              </section>
              <section className="vpn-proxy-card" aria-label="应用代理">
                <div className="vpn-proxy-heading">
                  <div>
                    <h3>应用代理</h3>
                    <p>Xshell 等软件使用此入口，自动按资源分流。</p>
                  </div>
                  <span
                    className={`vpn-state-badge ${coreState === 'running' ? 'connected' : ''}`}
                    role="status"
                  >
                    <Circle size={11} />
                    {coreState === 'running'
                      ? '代理运行中'
                      : coreState === 'starting'
                        ? '代理启动中'
                        : coreState === 'stopping'
                          ? '代理停止中'
                          : '代理未运行'}
                  </span>
                </div>
                <dl className="vpn-proxy-fields">
                  <div>
                    <dt>类型</dt>
                    <dd>SOCKS5</dd>
                  </div>
                  <div>
                    <dt>地址</dt>
                    <dd>
                      <code>127.0.0.1</code>
                      <button
                        className="vpn-icon-button"
                        type="button"
                        aria-label="复制代理地址"
                        title="复制代理地址"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText('127.0.0.1');
                            toast.success('代理地址已复制');
                          } catch {
                            toast.error('复制失败，请手动复制代理地址');
                          }
                        }}
                      >
                        <Copy size={15} />
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>端口</dt>
                    <dd aria-live="polite">
                      <code>{settings.mixedPort}</code>
                      <button
                        className="vpn-icon-button"
                        type="button"
                        aria-label="复制代理端口"
                        title="复制代理端口"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              String(settings.mixedPort),
                            );
                            toast.success('代理端口已复制');
                          } catch {
                            toast.error('复制失败，请手动复制代理端口');
                          }
                        }}
                      >
                        <Copy size={15} />
                      </button>
                    </dd>
                  </div>
                </dl>
                <p className="vpn-proxy-hint">
                  {settings.inboundAuth
                    ? '已启用代理认证，账号和密码见「设置」。'
                    : '无需代理账号密码。'}
                  {coreState !== 'running'
                    ? '连接 VPN 时会自动启动本地分流服务，无需代理节点。'
                    : '访问公司资源前，请保持 VPN 已连接。'}
                </p>
                <p className="vpn-proxy-hint">
                  {settings.tunEnabled
                    ? '已开启 TUN，使用自动接管的软件可以不单独设置代理。'
                    : '未开启 TUN，Xshell 需要在会话中选择 SOCKS5 并填写以上地址和端口。'}
                </p>
              </section>
              <section className="vpn-resource-card">
                <div className="vpn-resource-heading">
                  <div>
                    <h3>此接入的分流配置</h3>
                    <p>
                      仅用于「{selected.name}」，用户自定义规则优先。
                      公网出口按当前选择的策略分配。
                      {active && '连接期间可查看，断开后可修改。'}
                    </p>
                  </div>
                  <button
                    className="vpn-button compact"
                    disabled={busy}
                    title={active ? '查看高级分流（连接期间只读）' : '配置此接入的域名、IP 和固定解析'}
                    onClick={() => openEditor(selected.profile, 'routing')}
                  >
                    <Settings2 size={15} />
                    高级分流
                  </button>
                </div>
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
                          <h4>{selected.profile.protocol === 'softether' ? '添加需要通过 VPN 访问的公司资源' : '连接后自动获取授权资源'}</h4>
                          <p>可在「高级分流」中自行添加域名、IP 和固定解析，保存后下次继续使用。</p>
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
                        <h4>保存配置，直接连接</h4>
                        <p>
                          保存不会重连当前代理。点击连接时自动准备必要的分流配置；配置未变化时直接连接。
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
          initialTab={editorTab}
          readOnly={!['idle', 'failed'].includes(stateFor(editor.id).state)}
          passwordSaved={!!snapshot.passwordSaved?.[editor.id]}
          encryptionAvailable={snapshot.encryptionAvailable}
          onClose={() => setEditor(undefined)}
          onSaved={async (profile, keepOpen) => {
            await refresh();
            setSelectedId(profile.id);
            setEditor(keepOpen ? profile : undefined);
          }}
        />
      )}
      {addPickerOpen && (
        <Portal>
          <AddTypePicker
            onClose={() => setAddPickerOpen(false)}
            onPickCorporate={(protocol) => {
              setAddPickerOpen(false);
              openEditor({ ...newVpnProfile(), protocol });
            }}
            onPickEngine={(type) => {
              setAddPickerOpen(false);
              // 空白引擎档案带类型直开编辑器(管理在主列表:连接/编辑/删除)
              setEngineEditorFor({
                id: '', name: '', server: '', username: '', password: '',
                type, splitTunnel: true, useMfa: false, authUserPass: false,
                configText: '', extraRoutes: [], createdAt: Date.now(),
              });
            }}
          />
        </Portal>
      )}
      {engineEditorFor !== undefined && (
        <VpnProfileEditorModal
          profile={engineEditorFor}
          lockType={!engineEditorFor?.id}
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

// 类型弹层里引擎类型的徽标缩写
const ENGINE_TYPE_MARKS: Record<string, string> = {
  ikev2: 'IK', l2tp: 'L2', sstp: 'SS', openvpn: 'OP', anyconnect: 'AC',
  fortinet: 'FT', globalprotect: 'GP', pulse: 'PU', nc: 'JN', f5: 'F5',
  array: 'AR', wireguard: 'WG',
};

/** 类型选择弹层:独立组件——useModalExit 的开/关状态随挂载/卸载自然复位。
 *  若放在常驻页面组件体内,关闭一次后 exiting/closingRef 残留,再次打开会
 *  以收场隐身终态渲染(弹层在 DOM 里但不可见)。 */
const AddTypePicker: React.FC<{
  onClose: () => void;
  onPickCorporate: (protocol: VpnProtocol) => void;
  onPickEngine: (type: VpnProfileType) => void;
}> = ({ onClose, onPickCorporate, onPickEngine }) => {
  const { exiting, requestClose } = useModalExit(onClose);
  const maskDrag = useMaskDrag();
  // 防双击穿透:刚打开 350ms 内忽略类型行点击(第二击可能落在位置重叠的行上)
  const openedAtRef = useRef(0);
  if (openedAtRef.current === 0) openedAtRef.current = Date.now();
  const clickGuard = () => Date.now() - openedAtRef.current < 350;
  return (
    <div
      {...maskDrag}
      className={`vpn-modal-backdrop no-drag ${modalOverlayClass(exiting)}`}
    >
      <div className={`vpn-surface ${modalPopClass(exiting)}`} role="dialog" aria-modal="true" aria-label="选择接入类型" style={{ maxWidth: 460, width: '100%', borderRadius: 14, padding: 20, background: 'var(--vpn-bg)', border: '1px solid var(--vpn-border)', boxShadow: '0 24px 80px #0005' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>选择接入类型</strong>
          <ModalCloseX onClick={requestClose} />
        </div>
        <div className="vpn-add-type-list">
          {vpnProviderList.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="vpn-provider-option"
              onClick={() => { if (clickGuard()) return; onPickCorporate(provider.id); }}
            >
              <span className={`vpn-provider-mark ${provider.tone}`}>{provider.mark}</span>
              <span>
                <strong>{provider.name}</strong>
                <small>{provider.description}</small>
              </span>
            </button>
          ))}
          <div className="vpn-add-type-divider" />
          {TYPE_GROUPS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="vpn-provider-option"
              onClick={() => { if (clickGuard()) return; onPickEngine(t.id); }}
            >
              <span className="vpn-provider-mark teal">{ENGINE_TYPE_MARKS[t.id] || 'EN'}</span>
              <span>
                <strong>{t.label}</strong>
                {t.hint && <small>{t.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export const VpnAccessStatus: React.FC<{
  onOpen: () => void;
  showSummary?: boolean;
}> = ({ onOpen, showSummary = true }) => {
  const { snapshot } = useVpnSnapshot();
  const { state } = snapshot;
  const connectedCount = Object.values(snapshot.states || { legacy: state }).filter(s => s.state === 'connected').length;
  const challengeName = snapshot.profiles.find(p => p.id === state.challenge?.profileId)?.name;
  const [challengeOpen, setChallengeOpen] = useState(true);
  const challengeRoot = useRef<HTMLDivElement>(null);
  // 挑战弹窗收场动画:后端挑战消失时保留最后内容 200ms 播 overlay-exit/pop-exit
  const [challengeView, setChallengeView] = useState(state.challenge);
  const [challengeExiting, setChallengeExiting] = useState(false);
  const challengeSeenRef = useRef(false);
  const challengeDrag = useMaskDrag();
  useEffect(() => {
    if (state.challenge) {
      challengeSeenRef.current = true;
      setChallengeView(state.challenge);
      setChallengeExiting(false);
      return;
    }
    if (!challengeSeenRef.current) return;
    challengeSeenRef.current = false;
    setChallengeExiting(true);
    const t = setTimeout(() => {
      setChallengeView(undefined);
      setChallengeExiting(false);
    }, 200);
    return () => clearTimeout(t);
  }, [state.challenge]);
  useEffect(() => {
    setChallengeOpen(true);
  }, [state.challenge?.profileId, state.challenge?.generation, state.challenge?.id]);
  useEffect(() => {
    if (!state.challenge || !challengeOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setChallengeOpen(false);
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
    (challengeRoot.current?.querySelector<HTMLElement>('input') || challengeRoot.current?.querySelector<HTMLElement>('button'))?.focus();
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      previous?.focus();
    };
  }, [challengeOpen, state.challenge?.profileId, state.challenge?.generation, state.challenge?.id]);
  return (
    <>
      {(showSummary || (state.challenge && !challengeOpen)) && (state.profileId || snapshot.profiles.length > 0) && (
        <button onClick={() => state.challenge ? setChallengeOpen(true) : onOpen()} className="vpn-surface vpn-global-status">
          <Network size={14} />
          <span>VPN 接入</span>
          {snapshot.states && <span>已连接 {connectedCount} 个</span>}
          <ConnectionBadge state={state.state} />
          <span className="vpn-global-hint">{state.challenge ? '继续填写验证码' : '查看接入'}</span>
          <ArrowRight size={13} />
        </button>
      )}
      {challengeView && (
        <Portal>
          <div
            {...challengeDrag}
            className={`vpn-modal-backdrop vpn-challenge-backdrop no-drag ${modalOverlayClass(challengeExiting)}`}
            style={{ display: challengeOpen || challengeExiting ? undefined : 'none' }}
          >
            <div
              className={`vpn-surface vpn-auth-dialog ${modalPopClass(challengeExiting)}`}
              ref={challengeRoot}
              role="dialog"
              aria-modal="true"
              aria-label="VPN 身份验证"
            >
              <div className="vpn-auth-label">
                <ShieldCheck size={16} />
                <span className="flex-1">VPN 身份验证{challengeName ? ` · ${challengeName}` : ''}</span>
                <button type="button" className="vpn-icon-button" aria-label="收起身份验证" title="稍后继续填写" onClick={() => setChallengeOpen(false)}><X size={17} /></button>
              </div>
              <ChallengeForm
                key={`${challengeView.profileId}:${challengeView.generation}:${challengeView.id}`}
                challenge={challengeView}
                onDismiss={() => setChallengeOpen(false)}
                onSubmit={(value) =>
                  window.electronAPI.corporateVpn
                    .respond(challengeView.id, challengeView.generation, value)
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
  onDismiss,
}: {
  challenge: VpnChallenge;
  onSubmit: (value: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState('');
  const [points, setPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [time, setTime] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);
  const expired = time >= challenge.expiresAt;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (pending.current) return;
        if (Date.now() >= challenge.expiresAt) {
          setTime(Date.now());
          return;
        }
        if (challenge.kind === 'structured' ? !points.length : challenge.kind !== 'confirm-sms' && !value) return;
        pending.current = true;
        setSubmitting(true);
        setSubmitError('');
        try {
          await onSubmit(
            challenge.kind === 'confirm-sms'
              ? 'confirm'
              : challenge.kind === 'structured'
                ? captchaAnswer(points, dimensions.width, dimensions.height)
                : value,
          );
        } catch (error) {
          if (mounted.current) {
            pending.current = false;
            setSubmitting(false);
            setSubmitError(error instanceof Error ? error.message : String(error));
          }
        }
      }}
      className="space-y-4"
    >
      <h3 className="text-base font-semibold">{challenge.title}</h3>
      <p className="text-xs text-slate-600 dark:text-slate-400" role="timer" aria-label="本轮验证剩余时间">
        本轮验证剩余 {Math.max(0, Math.ceil((challenge.expiresAt - time) / 1000))} 秒
      </p>
      <p className="vpn-field-hint">可先收起，稍后继续填写。取消连接后重试会开始新一轮计时。</p>
      {expired && <p className="vpn-inline-error" role="status">本轮验证已超时，请取消后重新连接。</p>}
      {submitError && <p className="vpn-inline-error" role="alert">{submitError}</p>}
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
              .disconnect(challenge.profileId)
              .catch((e) => toast.error(String(e)))
          }
        >
          取消连接
        </button>
        <button type="button" className={button} onClick={onDismiss}>稍后填写</button>
        <button
          type="submit"
          className={button + ' primary'}
          disabled={
            expired ||
            submitting ||
            (challenge.kind === 'structured' && !points.length) ||
            (!['structured', 'confirm-sms'].includes(challenge.kind) && !value)
          }
        >
          {submitting ? '正在提交…' : challenge.kind === 'confirm-sms' ? '发送短信' : '提交验证码'}
        </button>
      </div>
    </form>
  );
}
