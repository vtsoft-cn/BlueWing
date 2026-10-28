import React, { useState, useEffect } from 'react';
import { ModalCloseX, ModalShell } from '../components/ModalShell';
import { useModalClose } from '../components/ModalShell';
import { X, KeyRound, Settings2, Save } from 'lucide-react';
import { VpnProfile, VpnProfileType } from '../../types';
import { Portal } from '../components/Portal';
import { Select } from '../components/Select';
import { InfoTip } from '../components/InfoTip';
import { FieldLabel, inputCls, Input } from '../components/ui';
import { VpnTargetsFields } from '../components/VpnTargetsFields';

interface VpnProfileEditorModalProps {
  profile?: VpnProfile | null;
  /** 类型已在添加弹层选定:隐藏类型网格 */
  lockType?: boolean;
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
  { id: 'ikev2', label: 'IKEv2', hint: '', products: '标准 IKEv2/IPsec 网关:Cisco、Fortinet、MikroTik、pfSense/OPNsense、Windows Server 等' },
  { id: 'l2tp', label: 'L2TP/IPsec', hint: '', products: '标准 L2TP/IPsec 网关:路由器/防火墙、Windows Server;SoftEther 服务器(未设默认 Hub 时用户名用 Hub名\\用户名)' },
  { id: 'sstp', label: 'SSTP', hint: '', products: '标准 SSTP 网关:Microsoft RRAS/TMG;SoftEther 服务器(SSTP 端点)' },
  { id: 'openvpn', label: 'OpenVPN', hint: '', missing: 'OpenVPN 引擎未检测到,见页面顶部安装指引', engine: 'openvpn', products: 'OpenVPN 服务器及兼容端点:OpenVPN、SoftEther(OpenVPN 兼容端点)、各类企业网关' },
  { id: 'anyconnect', label: 'AnyConnect', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Cisco ASA / Firepower 等 AnyConnect 网关' },
  { id: 'fortinet', label: 'FortiClient', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Fortinet FortiGate SSL VPN(FortiClient 协议)' },
  { id: 'globalprotect', label: 'GlobalProtect', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Palo Alto GlobalProtect 网关' },
  { id: 'pulse', label: 'Pulse/Ivanti', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Pulse Connect Secure / Ivanti Connect Secure' },
  { id: 'nc', label: 'Juniper NC', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Juniper Network Connect(旧版 Pulse Secure)' },
  { id: 'f5', label: 'F5 BIG-IP', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'F5 BIG-IP SSL VPN' },
  { id: 'array', label: 'Array AG', hint: '', missing: 'openconnect 引擎未检测到,见页面顶部安装指引', engine: 'openconnect', products: 'Array Networks AG SSL VPN' },
  { id: 'wireguard', label: 'WireGuard', hint: '', products: 'WireGuard 网关(wg-easy、Firezone、FortiGate 等);内网网段(AllowedIPs)必填,其余流量仍走代理节点' },
];

/** SoftEther 兼容端点模式说明(仅编辑历史 softether 档案时使用;新建请直接选 L2TP/SSTP/OpenVPN 类型) */
const SOFTETHER_MODE_HINTS: Record<string, string> = {
  l2tp: 'L2TP/IPsec 兼容端点:Windows 内置直连,需服务器设置的 IPsec 预共享密钥',
  sstp: 'SSTP 兼容端点:Windows 内置直连,零额外依赖',
  openvpn: 'OpenVPN 兼容端点:填写服务器/端口/证书(可自动获取)',
};


export const VpnProfileEditorModal: React.FC<VpnProfileEditorModalProps & { lockType?: boolean }> = ({ profile, engines, onSave, onClose, lockType }) => (
  <Portal>
    <ModalShell overlayClassName="bg-black/60 z-[200]" onClose={onClose}>
      <VpnProfileEditorPanel profile={profile} engines={engines} onSave={onSave} onClose={onClose} lockType={lockType} />
    </ModalShell>
  </Portal>
);

// 面板必须是 ModalShell 的真实子组件:useModalClose 的 Context 只提供给 children
const VpnProfileEditorPanel: React.FC<VpnProfileEditorModalProps & { lockType?: boolean }> = ({ profile, engines, onSave, onClose, lockType }) => {
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
  const [customDomainsText, setCustomDomainsText] = useState('');
  const [hostsText, setHostsText] = useState('');
  const [certFetching, setCertFetching] = useState(false);
  const [certMessage, setCertMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<'connection' | 'advanced'>('connection');

  useEffect(() => {
    if (profile) {
      setFormData({ ...profile });
      setExtraRoutesText((profile.extraRoutes || []).join('\n'));
      setCustomDomainsText((profile.customDomains || []).join('\n'));
      setHostsText(
        Object.entries(profile.hosts || {})
          .flatMap(([d, ips]) => [d, ...(ips || [])].join(' '))
          .join('\n'),
      );
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
    // 服务器:手动模式由 OpenVPN 手动块/其他类型基础区提供;
    // 历史 .ovpn 档案(configText 已有全文)内含 remote,server 可空
    const hasOvpnConfig = !!(formData.configText || '').trim();
    if (!formData.server && !isOpenVpn && !hasOvpnConfig) return;
    if (isOpenVpn) {
      // 手动模式:服务器在基础区已必填;证书必须有 PEM 块
      if (!(formData.ovpnCaText || '').includes('-----BEGIN CERTIFICATE-----')) return;
    }
    if (isOpenConnect && !formData.username) return;
    // SoftEther 的 L2TP 端点必须走 IPsec PSK(服务器端由管理员设置,无证书模式)
    if (formData.type === 'softether' && softetherMode === 'l2tp' && !(formData.l2tpPsk || '').trim()) return;

    const extraRoutes = extraRoutesText
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 自定义域名:每行一个;自定义网段沿用 extraRoutes 语义(与自动上报合并)
    const customDomains = customDomainsText
      .split(/[\n,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    // 固定域名解析:"域名 IP [IP...]" 每行一条;首词非域名或无合法 IP 的行跳过
    const hosts: Record<string, string[]> = {};
    for (const raw of hostsText.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const parts = raw.split(/[\s,]+/);
      const domain = (parts[0] || '').toLowerCase();
      const ips = parts.slice(1).filter((ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.includes(':'));
      if (domain.includes('.') && ips.length > 0) {
        hosts[domain] = [...(hosts[domain] || []), ...ips.filter((ip) => !hosts[domain]?.includes(ip))];
      }
    }

    const final: VpnProfile = {
      ...(formData as VpnProfile),
      id: profile?.id || `vpn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: formData.name || '',
      server: formData.server || '',
      createdAt: profile?.createdAt || Date.now(),
      extraRoutes,
      customDomains,
      hosts: Object.keys(hosts).length > 0 ? hosts : undefined,
      // 历史 .ovpn 档案的 configText 原样保留(引擎优先读它);新配置走手动字段
      configText: formData.configText,
    };
    onSave(final);
    onClose();
  };

  // 经 ModalShell Context 拿收场关闭;直接调 onClose prop 会跳过动画
  const requestClose = useModalClose();
  return (
      <div
        className="vpn-surface vpn-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vpn-engine-editor-title"
      >
          {/* Header */}
          <header className="vpn-editor-header">
            <div className="vpn-heading-icon">
              <KeyRound size={21} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 id="vpn-engine-editor-title">
                {profile?.id ? '编辑 VPN 账号' : '添加 VPN 账号'}
              </h2>
              <p>填写服务器与账号，保存后从列表连接。</p>
            </div>
            <ModalCloseX onClick={requestClose} />
          </header>

          {/* 分类 tab(与 corporate 编辑器同款结构) */}
          <div className="vpn-editor-tabs" role="tablist" aria-label="接入设置分类">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'connection'}
              onClick={() => setTab('connection')}
            >
              <KeyRound size={16} />
              连接设置
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'advanced'}
              onClick={() => setTab('advanced')}
            >
              <Settings2 size={16} />
              高级选项
            </button>
          </div>

          {/* Form Body(footer 在 body 外:body 有自身 padding,footer 嵌内会双重缩进、灰底条不满宽) */}
          <form onSubmit={handleSubmit} id="vpn-engine-editor-form" className="vpn-editor-body space-y-4">
            <section role="tabpanel" aria-label="连接设置" hidden={tab !== 'connection'} className="space-y-4">
            {/* Type Selector(类型已在添加弹层选定时隐藏) */}
            <div style={lockType ? { display: 'none' } : undefined}>
              <FieldLabel>
                VPN 类型 (Protocol)
              </FieldLabel>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {TYPE_GROUPS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => {
                      setFormData({ ...formData, type: t.id });
                    }}
                    className={`w-full h-[34px] flex items-center justify-between pl-3 pr-2 rounded-lg font-medium text-xs border transition-all ${
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
                <FieldLabel>
                  名称 <span className="text-blue-500">*</span>
                </FieldLabel>
                <Input
                  type="text"
                  required
                  value={formData.name || ''}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="例如: 公司内网 VPN"
                />
              </div>
              {!isOpenVpn && (
                <div className={isOpenConnect ? '' : 'sm:col-span-1'}>
                  <FieldLabel>
                    服务器 <span className="text-blue-500">*</span>
                  </FieldLabel>
                  <Input
                    type="text"
                    required
                    value={formData.server || ''}
                    onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                    placeholder={isOpenConnect ? 'https://vpn.example.com' : 'vpn.example.com'}
                  />
                </div>
              )}
            </div>

            {/* Credentials (all except cert-less openvpn) */}
            {!isOpenVpn && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <FieldLabel>
                    用户名{formData.type === 'softether' && '(服务器未设默认 Hub 时用 Hub名\\用户名)'}
                  </FieldLabel>
                  <Input
                    type="text"
                    autoComplete="off"
                    value={formData.username || ''}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder={formData.type === 'softether' ? 'alice 或 HUB01\\alice' : 'VPN 账号'}
                  />
                </div>
                <div>
                  <FieldLabel>
                    密码
                  </FieldLabel>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={formData.password || ''}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="留空则连接时使用空密码"
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
                      <FieldLabel>
                        预共享密钥 (PSK){formData.type === 'softether' && ' — SoftEther L2TP 必填'}
                      </FieldLabel>
                      <Input
                        type="password"
                        autoComplete="off"
                        required={formData.type === 'softether'}
                        value={formData.l2tpPsk || ''}
                        onChange={(e) => setFormData({ ...formData, l2tpPsk: e.target.value })}
                        placeholder={formData.type === 'softether' ? '服务器 IPsec 设置中的预共享密钥' : 'L2TP/IPsec PSK'}
                      />
                    </div>
                  )}
                  <div>
                    <FieldLabel>
                      内网域名后缀
                    </FieldLabel>
                    <Input
                      type="text"
                      value={formData.dnsSuffix || ''}
                      onChange={(e) => setFormData({ ...formData, dnsSuffix: e.target.value })}
                      placeholder="corp.example.com(可选)"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.splitTunnel !== false}
                    onChange={(e) => setFormData({ ...formData, splitTunnel: e.target.checked })}
                    className="w-4 h-4 rounded text-blue-600 focus:ring"
                  />
                  <span className="text-slate-600 dark:text-slate-400">分流模式(仅放行内网路由,不接管默认路由)</span>
                </label>
              </div>
            )}

            {/* OpenVPN specific */}
            {isOpenVpn && (
              <div className="space-y-3">
                <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2">
                        <FieldLabel>
                          服务器地址
                        </FieldLabel>
                        <Input
                          type="text"
                          value={formData.server || ''}
                          onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                          placeholder="vpn.example.com 或 IP"
                        />
                      </div>
                      <div>
                        <FieldLabel>
                          端口
                        </FieldLabel>
                        <Input
                          type="number"
                          value={formData.port || 1194}
                          onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || 1194 })}
                        />
                      </div>
                      <div>
                        <FieldLabel>
                          协议
                        </FieldLabel>
                        <Select
                          value={formData.ovpnProto || 'udp'}
                          onChange={(v) => setFormData({ ...formData, ovpnProto: v as 'udp' | 'tcp' })}
                          className={inputCls}
                          options={[
                            { value: 'udp', label: 'UDP' },
                            { value: 'tcp', label: 'TCP' },
                          ]}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <FieldLabel>
                          服务器证书
                        </FieldLabel>
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

                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.authUserPass || false}
                      onChange={(e) => setFormData({ ...formData, authUserPass: e.target.checked })}
                      className="w-4 h-4 rounded text-blue-600 focus:ring"
                    />
                    <span className="text-slate-600 dark:text-slate-400">使用用户名密码认证</span>
                  </label>
                </div>
                {formData.authUserPass && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>用户名</FieldLabel>
                      <Input
                        type="text"
                        value={formData.username || ''}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                      />
                    </div>
                    <div>
                      <FieldLabel>密码</FieldLabel>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        value={formData.password || ''}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
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
                    <FieldLabel>
                      用户组 / 登录入口
                    </FieldLabel>
                    <Input
                      type="text"
                      value={formData.usergroup || ''}
                      onChange={(e) => setFormData({ ...formData, usergroup: e.target.value })}
                      placeholder="留空通常即可"
                    />
                  </div>
                  <div>
                    <FieldLabel>
                      服务器端口
                    </FieldLabel>
                    <Input
                      type="number"
                      value={formData.port || ''}
                      onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || undefined })}
                      placeholder="默认 443"
                    />
                  </div>
                </div>
                <div>
                  <FieldLabel>
                    服务器证书指纹 (--servercert)
                  </FieldLabel>
                  <Input
                    type="text"
                    value={formData.servercert || ''}
                    onChange={(e) => setFormData({ ...formData, servercert: e.target.value })}
                    placeholder="pin-sha256:...(自签名网关校验失败时按日志提示填写)"
                    className="font-mono"
                  />
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.useMfa || false}
                    onChange={(e) => setFormData({ ...formData, useMfa: e.target.checked })}
                    className="w-4 h-4 rounded text-blue-600 focus:ring"
                  />
                  <span className="text-slate-600 dark:text-slate-400">登录需要双因素验证码 (MFA/令牌)</span>
                </label>
              </div>
            )}

            {/* WireGuard specific */}
            {isWireGuard && (
              <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <FieldLabel>端口</FieldLabel>
                    <input type="number" value={formData.port || 51820} onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) || 51820 })} className={inputCls} />
                  </div>
                  <div>
                    <FieldLabel>本机隧道地址</FieldLabel>
                    <input type="text" value={formData.localAddress || ''} onChange={(e) => setFormData({ ...formData, localAddress: e.target.value })} placeholder="10.7.0.2/32" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <FieldLabel>MTU(可选)</FieldLabel>
                    <input type="number" value={formData.wireguardMtu || ''} onChange={(e) => setFormData({ ...formData, wireguardMtu: Number(e.target.value) || undefined })} placeholder="1420" className={inputCls} />
                  </div>
                  <div>
                    <FieldLabel>私钥(Private Key)</FieldLabel>
                    <input type="password" autoComplete="off" value={formData.privateKey || ''} onChange={(e) => setFormData({ ...formData, privateKey: e.target.value })} placeholder="本机接口私钥" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <FieldLabel>对端公钥(Peer Key)</FieldLabel>
                    <input type="text" value={formData.peerPublicKey || ''} onChange={(e) => setFormData({ ...formData, peerPublicKey: e.target.value })} placeholder="服务器公钥" className={`${inputCls} font-mono`} />
                  </div>
                  <div>
                    <FieldLabel>预共享密钥(可选)</FieldLabel>
                    <input type="password" autoComplete="off" value={formData.presharedKey || ''} onChange={(e) => setFormData({ ...formData, presharedKey: e.target.value })} className={`${inputCls} font-mono`} />
                  </div>
                  <div className="sm:col-span-2">
                    <FieldLabel>企业内网 DNS(可选)</FieldLabel>
                    <input type="text" value={formData.corpDns || ''} onChange={(e) => setFormData({ ...formData, corpDns: e.target.value })} placeholder="如 10.7.0.1(内网域名解析经隧道)" className={inputCls} />
                  </div>
                </div>
              </div>
            )}
            </section>

            <section role="tabpanel" aria-label="高级选项" hidden={tab !== 'advanced'} className="space-y-4">
            {/* 公司资源:与 corporate 编辑器共用 VpnTargetsFields(域名/网段/固定解析),
                数据面经 VpnSplitConfig 注入(domain_suffix+ip_cidr+predefined DNS) */}
            <div className="vpn-section-heading"><div><h3>公司资源</h3>
              <p>{isWireGuard ? '内网网段即 WireGuard AllowedIPs(必填);其他资源可补充。' : '连接后引擎自动上报内网路由，也可以手动补充域名与网段。'}</p></div></div>
            <VpnTargetsFields
              domains={customDomainsText}
              onDomains={setCustomDomainsText}
              cidrs={extraRoutesText}
              onCidrs={setExtraRoutesText}
              hosts={hostsText}
              onHosts={setHostsText}
              domainsHint="每行一个公司域名，走此 VPN（包含子域名）"
              cidrsHint={isWireGuard ? 'WireGuard AllowedIPs，每行一个网段' : '与引擎自动上报的内网路由合并，走此 VPN'}
            />
            </section>

            </form>

            {/* Footer Buttons(form 属性绑定提交;与 body 平级,缩进/底色与 corporate 编辑器一致) */}
            <footer className="vpn-editor-footer">
              <button
                type="button"
                className="vpn-button"
                onClick={requestClose}
              >
                取消
              </button>
              <button
                type="submit"
                form="vpn-engine-editor-form"
                className="vpn-button primary"
              >
                <Save size={16} />
                保存账号
              </button>
            </footer>
        </div>
  );
};
