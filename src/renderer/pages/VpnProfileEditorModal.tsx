import React, { useState, useEffect } from 'react';
import { ModalCloseX, ModalShell } from '../components/ModalShell';
import { useModalClose } from '../components/ModalShell';
import { X, Check } from 'lucide-react';
import { VpnProfile, VpnProfileType } from '../../types';
import { Portal } from '../components/Portal';
import { Select } from '../components/Select';
import { InfoTip } from '../components/InfoTip';

interface VpnProfileEditorModalProps {
  profile?: VpnProfile | null;
  /** 引擎运行时可用性(安装包已内置;仅用户手动删除/替换引擎时才可能缺失) */
  engines?: { openvpn: boolean; openconnect: boolean } | null;
  onSave: (profile: VpnProfile) => void;
  onClose: () => void;
}

export const TYPE_GROUPS: {
  id: VpnProfileType;
  label: string;
  hint: string;
  missing?: string;
  engine?: 'openvpn' | 'openconnect';
  /** 悬停问号图标:该协议支持哪些 VPN 网关/产品 */
  products?: string;
}[] = [
  { id: 'ikev2', label: 'IKEv2', hint: 'Windows 内置,零依赖', products: '标准 IKEv2/IPsec 网关:Cisco、Fortinet、MikroTik、pfSense/OPNsense、Windows Server 等' },
  { id: 'l2tp', label: 'L2TP/IPsec', hint: 'Windows 内置,零依赖', products: '标准 L2TP/IPsec 网关:路由器/防火墙、Windows Server;SoftEther 服务器(未设默认 Hub 时用户名用 Hub名\\用户名)' },
  { id: 'sstp', label: 'SSTP', hint: 'Windows 内置,零依赖', products: '标准 SSTP 网关:Microsoft RRAS/TMG;SoftEther 服务器(SSTP 端点)' },
  { id: 'openvpn', label: 'OpenVPN', hint: 'OpenVPN 2.7 引擎(已随应用内置)', missing: 'OpenVPN 引擎未检测到,见页面顶部安装指引', engine: 'openvpn', products: 'OpenVPN 服务器及兼容端点:OpenVPN、SoftEther(OpenVPN 兼容端点)、各类企业网关' },
  { id: 'anyconnect', label: 'AnyConnect', hint: 'Cisco SSL VPN(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Cisco ASA / Firepower 等 AnyConnect 网关' },
  { id: 'fortinet', label: 'FortiClient', hint: 'Fortinet SSL VPN(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Fortinet FortiGate SSL VPN(FortiClient 协议)' },
  { id: 'globalprotect', label: 'GlobalProtect', hint: 'Palo Alto SSL VPN(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Palo Alto GlobalProtect 网关' },
  { id: 'pulse', label: 'Pulse/Ivanti', hint: 'Pulse Connect Secure(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Pulse Connect Secure / Ivanti Connect Secure' },
  { id: 'nc', label: 'Juniper NC', hint: 'Juniper Network Connect(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Juniper Network Connect(旧版 Pulse Secure)' },
  { id: 'f5', label: 'F5 BIG-IP', hint: 'F5 BIG-IP SSL VPN(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'F5 BIG-IP SSL VPN' },
  { id: 'array', label: 'Array AG', hint: 'Array Networks SSL VPN(已随应用内置)', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Array Networks AG SSL VPN' },
  { id: 'wireguard', label: 'WireGuard', hint: 'sing-box 原生隧道,零额外引擎', products: 'WireGuard 网关(wg-easy、Firezone、FortiGate 等);内网网段(AllowedIPs)必填,其余流量仍走代理节点' },
];

/** SoftEther 兼容端点模式说明(仅编辑历史 softether 档案时使用;新建请直接选 L2TP/SSTP/OpenVPN 类型) */
const SOFTETHER_MODE_HINTS: Record<string, string> = {
  l2tp: 'L2TP/IPsec 兼容端点:Windows 内置直连,需服务器设置的 IPsec 预共享密钥',
  sstp: 'SSTP 兼容端点:Windows 内置直连,零额外依赖',
  openvpn: 'OpenVPN 兼容端点:填写服务器/端口/证书(可自动获取)',
};

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500';

export const VpnProfileEditorModal: React.FC<VpnProfileEditorModalProps> = ({ profile, engines, onSave, onClose }) => (
  <Portal>
    <ModalShell overlayClassName="bg-black/60 z-[200]" onClose={onClose}>
      <VpnProfileEditorPanel profile={profile} engines={engines} onSave={onSave} onClose={onClose} />
    </ModalShell>
  </Portal>
);

// 面板必须是 ModalShell 的真实子组件:useModalClose 的 Context 只提供给 children
const VpnProfileEditorPanel: React.FC<VpnProfileEditorModalProps> = ({ profile, engines, onSave, onClose }) => {
  const [formData, setFormData] = useState<Partial<VpnProfile>>({
    type: 'ikev2',
    name: '',
    server: '',
    username: '',
    password: '',
    splitTunnel: true,
    useMfa: false,
    authUserPass: false,
    configText: '',
    extraRoutes: [],
  });
  const [extraRoutesText, setExtraRoutesText] = useState('');
  /** OpenVPN 配置方式:手动字段(默认) 或 完整 .ovpn */
  const [ovpnMode, setOvpnMode] = useState<'manual' | 'file'>('manual');
  const [certFetching, setCertFetching] = useState(false);
  const [certMessage, setCertMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (profile) {
      setFormData({ ...profile });
      setExtraRoutesText((profile.extraRoutes || []).join('\n'));
      // 编辑已有档案:按其现有配置来源选择模式
      setOvpnMode((profile.configText || '').trim() ? 'file' : 'manual');
    }
  }, [profile]);

  const handleFetchCert = async (): Promise<void> => {
    if (!window.electronAPI?.vpn || !formData.server) return;
    setCertFetching(true);
    setCertMessage(null);
    try {
      const res = await window.electronAPI.vpn.fetchServerCert(formData.server.trim());
      if (res.pem) {
        setFormData((prev) => ({ ...prev, ovpnCaText: res.pem }));
        setCertMessage({ ok: true, text: `已获取证书(经端口 ${res.port}),可直接保存连接` });
      } else {
        setCertMessage({ ok: false, text: res.error || '获取失败,请手动粘贴证书 PEM' });
      }
    } catch (e: any) {
      setCertMessage({ ok: false, text: e?.message || '获取失败' });
    } finally {
      setCertFetching(false);
    }
  };

  // softether 按所选兼容端点复用对应类型的表单块与校验
  const softetherMode = formData.softetherMode || 'l2tp';
  const effType: VpnProfileType =
    formData.type === 'softether' ? (softetherMode as VpnProfileType) : formData.type || 'ikev2';
  const isRas = effType === 'ikev2' || effType === 'l2tp' || effType === 'sstp';
  const isWireGuard = formData.type === 'wireguard';
  const isOpenVpn = effType === 'openvpn';
  const isOpenConnect =
    effType === 'anyconnect' ||
    effType === 'fortinet' ||
    effType === 'globalprotect' ||
    effType === 'pulse' ||
    effType === 'nc' ||
    effType === 'f5' ||
    effType === 'array';

  const typeMeta = TYPE_GROUPS.find((t) => t.id === effType);
  const engineMissing = !!(typeMeta?.engine && engines && engines[typeMeta.engine] === false);
  const typeHint =
    formData.type === 'softether'
      ? engineMissing
        ? typeMeta?.missing
        : SOFTETHER_MODE_HINTS[softetherMode]
      : engineMissing
        ? typeMeta?.missing
        : typeMeta?.hint;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) return;
    // 服务器:手动模式由 OpenVPN 手动块/其他类型基础区提供;.ovpn 全文模式内含 remote,不必填
    const ovpnFileMode = isOpenVpn && ovpnMode === 'file';
    if (!formData.server && !ovpnFileMode) return;
    if (isOpenVpn) {
      if (ovpnMode === 'file' && !(formData.configText || '').trim()) return;
      // 手动模式:服务器在基础区已必填;证书必须有 PEM 块
      if (ovpnMode === 'manual' && !(formData.ovpnCaText || '').includes('-----BEGIN CERTIFICATE-----')) return;
    }
    if (isOpenConnect && !formData.username) return;
    // SoftEther 的 L2TP 端点必须走 IPsec PSK(服务器端由管理员设置,无证书模式)
    if (formData.type === 'softether' && softetherMode === 'l2tp' && !(formData.l2tpPsk || '').trim()) return;

    const extraRoutes = extraRoutesText
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const final: VpnProfile = {
      ...(formData as VpnProfile),
      id: profile?.id || `vpn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: formData.name || '',
      server: formData.server || '',
      createdAt: profile?.createdAt || Date.now(),
      extraRoutes,
      // 手动模式清掉 .ovpn 全文(引擎优先读 configText,残留会让手动字段失效)
      configText: ovpnMode === 'file' ? formData.configText : undefined,
    };
    onSave(final);
    onClose();
  };

  // 经 ModalShell Context 拿收场关闭;直接调 onClose prop 会跳过动画
  const requestClose = useModalClose();
  return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-xl w-full p-6 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col max-h-[85vh]">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
            <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
              {profile?.id ? '编辑 VPN 账号' : '添加 VPN 账号'}
            </h3>
            <ModalCloseX onClick={requestClose} />
          </div>

          {/* Form Body */}
          <form onSubmit={handleSubmit} className="overflow-y-auto space-y-4 py-4 pr-1 flex-1 text-xs">
            {/* Type Selector */}
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                VPN 类型 (Protocol)
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {TYPE_GROUPS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => {
                      setFormData({ ...formData, type: t.id });
                    }}
                    className={`w-full flex items-center justify-between py-1.5 pl-3 pr-2 rounded-lg font-medium text-xs border transition-all ${
                      formData.type === t.id
                        ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {t.label}
                    {t.products && <InfoTip text={t.products} />}
                  </button>
                ))}
              </div>
              <p className={`mt-1.5 text-[11px] ${engineMissing ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                {typeHint}
              </p>
              {formData.type === 'softether' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['l2tp', 'sstp', 'openvpn'] as const).map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => setFormData({ ...formData, softetherMode: m })}
                      className={`py-1 px-3 rounded-lg text-xs font-medium border transition-all ${
                        softetherMode === m
                          ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {m === 'l2tp' ? 'L2TP/IPsec' : m === 'sstp' ? 'SSTP' : 'OpenVPN'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Basic fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className={isOpenVpn ? 'sm:col-span-3' : 'sm:col-span-2'}>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  名称{isOpenVpn && '(.ovpn 内已含服务器地址,此处仅作显示名)'}
                </label>
                <input
                  type="text"
                  required
                  value={formData.name || ''}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="例如: 公司内网 VPN"
                  className={inputCls}
                />
              </div>
              {!isOpenVpn && (
                <div className={isOpenConnect ? '' : 'sm:col-span-1'}>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    服务器
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.server || ''}
                    onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                    placeholder={isOpenConnect ? 'https://vpn.example.com' : 'vpn.example.com'}
                    className={inputCls}
                  />
                </div>
              )}
            </div>

            {/* Credentials (all except cert-less openvpn) */}
            {!isOpenVpn && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    用户名{formData.type === 'softether' && '(服务器未设默认 Hub 时用 Hub名\\用户名)'}
                  </label>
                  <input
                    type="text"
                    autoComplete="off"
                    value={formData.username || ''}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder={formData.type === 'softether' ? 'alice 或 HUB01\\alice' : 'VPN 账号'}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    密码
                  </label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={formData.password || ''}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="留空则连接时使用空密码"
                    className={inputCls}
                  />
                </div>
              </div>
            )}

            {/* RAS specific */}
            {isRas && (
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {effType === 'l2tp' && (
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        预共享密钥 (PSK){formData.type === 'softether' && ' — SoftEther L2TP 必填'}
                      </label>
                      <input
                        type="password"
                        autoComplete="off"
                        required={formData.type === 'softether'}
                        value={formData.l2tpPsk || ''}
                        onChange={(e) => setFormData({ ...formData, l2tpPsk: e.target.value })}
                        placeholder={formData.type === 'softether' ? '服务器 IPsec 设置中的预共享密钥' : 'L2TP/IPsec PSK'}
                        className={inputCls}
                      />
                    </div>
                  )}
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      内网域名后缀
                    </label>
                    <input
                      type="text"
                      value={formData.dnsSuffix || ''}
                      onChange={(e) => setFormData({ ...formData, dnsSuffix: e.target.value })}
                      placeholder="corp.example.com(可选)"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400">分流模式(仅放行内网路由,不接管默认路由)</span>
                  <input
                    type="checkbox"
                    checked={formData.splitTunnel !== false}
                    onChange={(e) => setFormData({ ...formData, splitTunnel: e.target.checked })}
                    className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                  />
                </div>
              </div>
            )}

            {/* OpenVPN specific */}
            {isOpenVpn && (
              <div className="space-y-3">
                {/* 配置方式:手动填写(默认) 或 粘贴完整 .ovpn */}
                <div className="flex flex-wrap gap-2">
                  {(['manual', 'file'] as const).map((m) => (
                    <button
                      type="button"
                      key={m}
                      onClick={() => setOvpnMode(m)}
                      className={`py-1 px-3 rounded-lg text-xs font-medium border transition-all ${
                        ovpnMode === m
                          ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {m === 'manual' ? '手动填写' : '粘贴 .ovpn 文件'}
                    </button>
                  ))}
                </div>

                {ovpnMode === 'file' && (
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      .ovpn 配置内容
                    </label>
                    <textarea
                      required
                      rows={8}
                      value={formData.configText || ''}
                      onChange={(e) => setFormData({ ...formData, configText: e.target.value })}
                      placeholder="粘贴 .ovpn 文件全文(证书请内联 &lt;ca&gt;...&lt;/ca&gt;)"
                      className={`${inputCls} font-mono text-[11px] leading-relaxed`}
                    />
                  </div>
                )}

                {ovpnMode === 'manual' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          服务器地址
                        </label>
                        <input
                          type="text"
                          value={formData.server || ''}
                          onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                          placeholder="vpn.example.com 或 IP"
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          端口
                        </label>
                        <input
                          type="number"
                          value={formData.port || 1194}
                          onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || 1194 })}
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          协议
                        </label>
                        <Select
                          value={formData.ovpnProto || 'udp'}
                          onChange={(v) => setFormData({ ...formData, ovpnProto: v as 'udp' | 'tcp' })}
                          className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                          options={[
                            { value: 'udp', label: 'UDP' },
                            { value: 'tcp', label: 'TCP' },
                          ]}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block font-medium text-slate-700 dark:text-slate-300">
                          服务器证书
                        </label>
                        <button
                          type="button"
                          disabled={!formData.server || certFetching}
                          onClick={() => void handleFetchCert()}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium border border-blue-300 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50 whitespace-nowrap"
                        >
                          {certFetching ? '获取中...' : '自动获取证书'}
                        </button>
                      </div>
                      <textarea
                        required
                        rows={5}
                        value={formData.ovpnCaText || ''}
                        onChange={(e) => setFormData({ ...formData, ovpnCaText: e.target.value })}
                        placeholder="点上方按钮自动获取,或粘贴服务器证书 PEM(-----BEGIN CERTIFICATE----- 开头)"
                        className={`${inputCls} font-mono text-[11px]`}
                      />
                      {certMessage && (
                        <p className={`mt-1 text-[11px] ${certMessage.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {certMessage.text}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                  <span className="text-slate-600 dark:text-slate-400">使用用户名密码认证</span>
                  <input
                    type="checkbox"
                    checked={formData.authUserPass || false}
                    onChange={(e) => setFormData({ ...formData, authUserPass: e.target.checked })}
                    className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                  />
                </div>
                {formData.authUserPass && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">用户名</label>
                      <input
                        type="text"
                        value={formData.username || ''}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">密码</label>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={formData.password || ''}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* openconnect specific */}
            {isOpenConnect && (
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      用户组 / 登录入口
                    </label>
                    <input
                      type="text"
                      value={formData.usergroup || ''}
                      onChange={(e) => setFormData({ ...formData, usergroup: e.target.value })}
                      placeholder="留空通常即可"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      服务器端口
                    </label>
                    <input
                      type="number"
                      value={formData.port || ''}
                      onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || undefined })}
                      placeholder="默认 443"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    服务器证书指纹 (--servercert)
                  </label>
                  <input
                    type="text"
                    value={formData.servercert || ''}
                    onChange={(e) => setFormData({ ...formData, servercert: e.target.value })}
                    placeholder="pin-sha256:...(自签名网关校验失败时按日志提示填写)"
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600 dark:text-slate-400">登录需要双因素验证码 (MFA/令牌)</span>
                  <input
                    type="checkbox"
                    checked={formData.useMfa || false}
                    onChange={(e) => setFormData({ ...formData, useMfa: e.target.checked })}
                    className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                  />
                </div>
              </div>
            )}

            {/* WireGuard specific */}
            {isWireGuard && (
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">端口</label>
                    <input type="number" value={formData.port || 51820} onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || 51820 })} className={inputCls} />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">本机隧道地址</label>
                    <input type="text" value={formData.localAddress || ''} onChange={(e) => setFormData({ ...formData, localAddress: e.target.value })} placeholder="10.7.0.2/32" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">MTU(可选)</label>
                    <input type="number" value={formData.wireguardMtu || ''} onChange={(e) => setFormData({ ...formData, wireguardMtu: Number(e.target.value) || undefined })} placeholder="1420" className={inputCls} />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">私钥(Private Key)</label>
                    <input type="password" autoComplete="off" value={formData.privateKey || ''} onChange={(e) => setFormData({ ...formData, privateKey: e.target.value })} placeholder="本机接口私钥" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">对端公钥(Peer Key)</label>
                    <input type="text" value={formData.peerPublicKey || ''} onChange={(e) => setFormData({ ...formData, peerPublicKey: e.target.value })} placeholder="服务器公钥" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">预共享密钥(可选)</label>
                    <input type="password" autoComplete="off" value={formData.presharedKey || ''} onChange={(e) => setFormData({ ...formData, presharedKey: e.target.value })} className={`${inputCls} font-mono`} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">企业内网 DNS(可选)</label>
                    <input type="text" value={formData.corpDns || ''} onChange={(e) => setFormData({ ...formData, corpDns: e.target.value })} placeholder="如 10.7.0.1(内网域名解析经隧道)" className={inputCls} />
                  </div>
                </div>
              </div>
            )}

            {/* Common: extra routes */}
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                {isWireGuard ? '内网网段(WireGuard AllowedIPs,必填)' : '补充内网网段(可选,与自动上报合并)'}
              </label>
              <textarea
                rows={2}
                value={extraRoutesText}
                onChange={(e) => setExtraRoutesText(e.target.value)}
                placeholder={'10.1.0.0/16\n172.16.8.0/24'}
                className={`${inputCls} font-mono text-[11px]`}
              />
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={requestClose}
                className="px-4 py-2 rounded-lg font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-lg font-medium bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white flex items-center space-x-1.5 shadow-sm shadow-blue-500/25 transition-colors"
              >
                <Check className="w-4 h-4" />
                <span>保存账号</span>
              </button>
            </div>
          </form>
        </div>
  );
};
