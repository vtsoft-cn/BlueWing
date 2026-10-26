import React, { useState, useEffect, useCallback } from 'react';
import { ModalShell } from '../components/ModalShell';
import {
  Shield,
  ShieldCheck,
  Plus,
  Trash2,
  Pencil,
  Link2,
  Unlink,
  FolderOpen,
  Server,
} from 'lucide-react';
import { VpnProfile, VpnProfileType, VpnRuntimeInfo } from '../../types';
import { VpnProfileEditorModal } from './VpnProfileEditorModal';
import { Portal } from '../components/Portal';
import { confirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';

const TYPE_LABEL: Record<VpnProfileType, string> = {
  ikev2: 'IKEv2',
  l2tp: 'L2TP/IPsec',
  sstp: 'SSTP',
  openvpn: 'OpenVPN',
  anyconnect: 'Cisco AnyConnect',
  fortinet: 'FortiClient',
  globalprotect: 'GlobalProtect',
  pulse: 'Pulse/Ivanti',
  nc: 'Juniper NC',
  f5: 'F5 BIG-IP',
  array: 'Array AG',
  softether: 'SoftEther',
  wireguard: 'WireGuard',
};

const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  connecting: { text: '连接中', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  connected: { text: '已连接', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  disconnecting: { text: '断开中', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  error: { text: '失败', cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  disconnected: { text: '未连接', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

interface EnginesInfo {
  openvpn: { available: boolean; dir: string };
  openconnect: { available: boolean; dir: string };
}

/** 嵌入「VPN 接入」页的分区:协议引擎类 VPN(IKEv2/L2TP/SSTP/OpenVPN/兼容端点/WireGuard) */
export const Vpn: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [runtime, setRuntime] = useState<VpnRuntimeInfo | null>(null);
  const [engines, setEngines] = useState<EnginesInfo | null>(null);
  const [editorFor, setEditorFor] = useState<VpnProfile | null | undefined>(undefined);
  const [mfaFor, setMfaFor] = useState<VpnProfile | null>(null);
  const requestClose = () => { setMfaFor(null); };
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (!window.electronAPI?.vpn) return;
    void window.electronAPI.vpn.getProfiles().then(setProfiles);
    void window.electronAPI.vpn.getState().then(setRuntime);
    void window.electronAPI.vpn.getEngines().then(setEngines);
    const unsubState = window.electronAPI.vpn.onStateChange((info) => setRuntime(info));
    const unsubProfiles = window.electronAPI.vpn.onProfilesChanged((list) => setProfiles(list));
    return () => {
      unsubState();
      unsubProfiles();
    };
  }, []);

  const doConnect = useCallback(async (profile: VpnProfile, code?: string) => {
    if (!window.electronAPI?.vpn) return;
    const ok = await window.electronAPI.vpn.connect(profile.id, code ? { mfaCode: code } : undefined);
    if (!ok) {
      toast.warn('VPN 连接未能发起,请查看日志');
    }
  }, []);

  const handleConnect = useCallback(
    async (profile: VpnProfile) => {
      if (profile.useMfa) {
        setMfaCode('');
        setMfaFor(profile);
        return;
      }
      await doConnect(profile);
    },
    [doConnect]
  );

  const handleDisconnect = useCallback(async () => {
    if (!window.electronAPI?.vpn) return;
    await window.electronAPI.vpn.disconnect();
  }, []);

  const handleDelete = useCallback(async (profile: VpnProfile) => {
    if (
      !(await confirmDialog({
        title: '删除 VPN 账号',
        message: `确定要删除「${profile.name}」吗?正在连接时会先断开。`,
        danger: true,
      }))
    ) {
      return;
    }
    await window.electronAPI?.vpn?.deleteProfile(profile.id);
  }, []);

  const handleSave = useCallback(async (profile: VpnProfile) => {
    const ok = await window.electronAPI?.vpn?.saveProfile(profile);
    if (ok) toast.success('VPN 账号已保存');
    else toast.warn('保存失败:名称与服务器为必填项');
  }, []);

  const isWireGuardActive = !!(runtime && runtime.state === 'connected' && profiles.find((p) => p.id === runtime.profileId)?.type === 'wireguard');
  const activeRuntimeFor = (p: VpnProfile): VpnRuntimeInfo | null =>
    runtime && runtime.profileId === p.id && runtime.state !== 'disconnected' ? runtime : null;

  const badgeOf = (state?: string): { text: string; cls: string } =>
    STATE_BADGE[state || 'disconnected'] || STATE_BADGE.disconnected;

  return (
    <div className="space-y-6">
      {/* 分区工具行(embedded 时隐藏说明,由宿主页提供上下文) */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          {!embedded && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              在应用内直接登录企业 VPN 账号;内网流量经应用分流交还 VPN 隧道,其余流量照常走代理/直连
            </p>
          )}
        </div>
        <button
          onClick={() => setEditorFor(null)}
          className="flex-shrink-0 flex items-center space-x-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white shadow-sm shadow-blue-500/25 whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          <span>添加 VPN 账号</span>
        </button>
      </div>

      {/* 当前连接状态卡 */}
      {runtime && runtime.state !== 'disconnected' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center space-x-3 min-w-0">
              {runtime.state === 'connected' ? (
                <ShieldCheck className="w-5 h-5 text-emerald-500 flex-shrink-0" />
              ) : (
                <Shield className={`w-5 h-5 flex-shrink-0 ${runtime.state === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
              )}
              <div className="min-w-0">
                <div className="flex items-center space-x-2 flex-wrap">
                  <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">
                    {runtime.profileName}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${badgeOf(runtime.state).cls}`}>
                    {badgeOf(runtime.state).text}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {runtime.message ||
                    (runtime.state === 'connected'
                      ? `${isWireGuardActive ? '原生 WireGuard 隧道' : `网卡 ${runtime.adapterName || '未识别'}`}${runtime.ipv4 ? ` · ${runtime.ipv4}` : ''} · 内网段 ${runtime.routes.length} 个${runtime.dnsServers.length ? ` · DNS ${runtime.dnsServers.join(', ')}` : ''}`
                      : '正在建立隧道,可能需要几十秒...')}
                </div>
              </div>
            </div>
            {(runtime.state === 'connected' || runtime.state === 'error') && (
              <button
                onClick={handleDisconnect}
                className="flex-shrink-0 flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <Unlink className="w-3.5 h-3.5" />
                <span>断开</span>
              </button>
            )}
          </div>
          {runtime.state === 'connected' && runtime.routes.length > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-1.5">
              {runtime.routes.slice(0, 12).map((r) => (
                <span
                  key={r}
                  className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[11px] font-mono text-slate-600 dark:text-slate-400"
                >
                  {r}
                </span>
              ))}
              {runtime.routes.length > 12 && (
                <span className="text-[11px] text-slate-400">+{runtime.routes.length - 12} 个</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 引擎可用性提示 */}
      {engines && (!engines.openvpn.available || !engines.openconnect.available) && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/30 p-4 space-y-3">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">部分协议需要先安装开源引擎(一次性放置)</p>
          {!engines.openvpn.available && (
            <EngineHint
              label="OpenVPN"
              dir={engines.openvpn.dir}
              note="下载官方 OpenVPN Community 安装包后,将其安装目录中的 openvpn.exe 放入上述目录"
            />
          )}
          {!engines.openconnect.available && (
            <EngineHint
              label="openconnect(Cisco AnyConnect / FortiClient / GlobalProtect)"
              dir={engines.openconnect.dir}
              note="从 openconnect 官方 Windows 构建(OpenConnect GUI 发行包内含 CLI)提取 openconnect.exe 放入上述目录"
            />
          )}
          <p className="text-[11px] text-amber-700/80 dark:text-amber-400/70">
            IKEv2 / L2TP / SSTP 由 Windows 系统内置支持,无需任何引擎。
          </p>
        </div>
      )}

      {/* 账号列表 */}
      {profiles.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl">
          <Shield className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
          <p className="text-sm text-slate-500 dark:text-slate-400">尚未添加任何 VPN 账号</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">点击右上角「添加 VPN 账号」开始</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {profiles.map((p) => {
            const rt = activeRuntimeFor(p);
            const badge = badgeOf(rt?.state);
            const busy = rt?.state === 'connecting';
            return (
              <div
                key={p.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2 flex-wrap">
                      <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">{p.name}</span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {TYPE_LABEL[p.type]}
                      </span>
                      {rt && (
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 truncate">
                      {p.type === 'openvpn' ? '内嵌 .ovpn 配置' : p.server}
                      {p.username ? ` · ${p.username}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    {rt && rt.state !== 'disconnected' ? (
                      <button
                        onClick={handleDisconnect}
                        disabled={busy}
                        className="flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Unlink className="w-3.5 h-3.5" />
                        <span>断开</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleConnect(p)}
                        className="flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-500/25"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        <span>连接</span>
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setEditorFor(p)}
                      title="编辑"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => void handleDelete(p)}
                      title="删除"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 编辑/新增弹窗:undefined=关闭,null=新增,对象=编辑;engines 供弹窗按运行时
          引擎可用性切换类型提示(已内置→纯描述,缺失→安装指引) */}
      {editorFor !== undefined && (
        <VpnProfileEditorModal
          profile={editorFor}
          engines={engines ? { openvpn: engines.openvpn.available, openconnect: engines.openconnect.available } : null}
          onSave={(profile) => void handleSave(profile)}
          onClose={() => setEditorFor(undefined)}
        />
      )}

      {/* MFA 验证码弹窗 */}
      {mfaFor && (
        <Portal>
          <ModalShell overlayClassName="bg-black/60 backdrop-blur-sm z-[200]" onClose={requestClose}>
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-sm w-full p-5 border border-slate-200 dark:border-slate-800 shadow-2xl">
              <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100 mb-1">输入双因素验证码</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                「{mfaFor.name}」启用了双因素认证,请输入本次登录的一次性验证码(令牌/短信)。
              </p>
              <input
                type="text"
                autoFocus
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.trim())}
                placeholder="6 位验证码"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 text-center font-mono tracking-widest"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && mfaCode) {
                    void doConnect(mfaFor, mfaCode);
                    setMfaFor(null);
                  }
                }}
              />
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setMfaFor(null)}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  取消
                </button>
                <button
                  disabled={!mfaCode}
                  onClick={() => {
                    void doConnect(mfaFor, mfaCode);
                    setMfaFor(null);
                  }}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                >
                  连接
                </button>
              </div>
            </div>
    </ModalShell>
        </Portal>
      )}
    </div>
  );
};

const EngineHint: React.FC<{ label: string; dir: string; note: string }> = ({ label, dir, note }) => (
  <div className="flex items-start justify-between gap-3 flex-wrap">
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">{label} 引擎未安装</p>
      <p className="text-[11px] text-amber-700/80 dark:text-amber-400/70 mt-0.5">{note}</p>
      <p className="text-[11px] font-mono text-amber-700/70 dark:text-amber-400/60 mt-0.5 break-all">{dir}</p>
    </div>
    <button
      onClick={() => void window.electronAPI?.system?.openPath?.(dir)}
      className="flex-shrink-0 flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 whitespace-nowrap"
    >
      <FolderOpen className="w-3.5 h-3.5" />
      <span>打开目录</span>
    </button>
  </div>
);
