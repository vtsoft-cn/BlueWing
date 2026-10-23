import React, { useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import {
  VpnChallenge,
  VpnProfile,
  VpnState,
  VpnTarget,
} from '../../types/corporateVpn';
import { captchaAnswer } from '../../utils/vpnChallenge';
import { useVpnSnapshot } from '../vpn/useVpnSnapshot';
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
  const [expanded, setExpanded] = useState(false);
  const state = snapshot.state;
  const active = !['idle', 'failed'].includes(state.state);
  const selected = snapshot.profiles.find(
    (profile) => profile.id === selectedId,
  );
  const selectedState =
    selected && state.profileId === selected.id ? state.state : 'idle';
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
  const resourceRows: Array<{ target: VpnTarget; source: string }> = selected
    ? [
        ...(resources?.targets || []).map((target) => ({
          target,
          source: '服务器下发',
        })),
        ...selected.targets.map((target) => ({ target, source: '手动补充' })),
        ...Object.entries(selected.hosts).map(([domain, ips]) => ({
          target: { domains: [domain], cidrs: ips, network: 'tcp' as const },
          source: '固定解析',
        })),
      ]
    : [];
  const profiles = snapshot.profiles.filter((profile) =>
    `${profile.name} ${profile.gateway.host} ${vpnProviders[profile.protocol].name}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
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
            onClick={() => setEditor(newVpnProfile())}
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
            onClick={() => setEditor(newVpnProfile())}
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
                  disabled={active && state.profileId !== profile.id}
                  title={
                    active && state.profileId !== profile.id
                      ? '请先断开当前接入后切换'
                      : profile.gateway.host
                  }
                  onClick={() => setSelectedId(profile.id)}
                >
                  <div className="vpn-profile-item-top">
                    <ProviderMark protocol={profile.protocol} small />
                    <strong>{profile.name}</strong>
                    {state.profileId === profile.id &&
                      state.state === 'connected' && (
                        <CheckCircle2
                          size={15}
                          className="vpn-success-text shrink-0"
                        />
                      )}
                  </div>
                  <span className="vpn-profile-gateway">
                    {profile.gateway.host}:{profile.gateway.port}
                  </span>
                  <span className="vpn-profile-protocol">
                    {vpnProviders[profile.protocol].name}
                    {state.profileId === profile.id && active && (
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
          {selected && (
            <div className="vpn-detail-column">
              <section className="vpn-connection-card" aria-label="连接面板">
                <header className="vpn-connection-header">
                  <div className="vpn-connection-identity">
                    <ProviderMark protocol={selected.protocol} />
                    <div className="min-w-0">
                      <div className="vpn-connection-title">
                        <h3>{selected.name}</h3>
                        <ConnectionBadge state={selectedState} />
                      </div>
                      <p>
                        {vpnProviders[selected.protocol].name}
                        <span>·</span>
                        <span
                          className="font-mono"
                          title={`${selected.gateway.host}:${selected.gateway.port}`}
                        >
                          {selected.gateway.host}:{selected.gateway.port}
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    className="vpn-icon-button"
                    aria-label="编辑接入配置"
                    title="编辑接入配置"
                    disabled={active || busy}
                    onClick={() => setEditor(selected)}
                  >
                    <Pencil size={17} />
                  </button>
                </header>
                <div className="vpn-connection-body">
                  <div className="vpn-connection-meta">
                    <span>
                      <KeyRound size={14} />
                      {selected.username || '尚未填写账号'}
                    </span>
                    <span>
                      <ShieldCheck size={14} />
                      按资源分流
                    </span>
                    {selected.loginDomain && (
                      <span>登录域：{selected.loginDomain}</span>
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
                    {!active && selected.authMethod !== 'auth/smsCheckCode' && (
                      <label className="vpn-field">
                        <span>登录密码</span>
                        <div className="vpn-password-input">
                          <input
                            type={reveal ? 'text' : 'password'}
                            aria-label="登录密码"
                            autoComplete="off"
                            placeholder={
                              selected.rememberPassword
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
                    {!active && selected.authMethod === 'auth/smsCheckCode' && (
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
                        {selected.rememberPassword
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
