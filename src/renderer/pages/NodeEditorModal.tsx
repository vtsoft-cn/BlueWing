import React, { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { ProxyNode, ProxyType } from '../../types';
import { Select } from '../components/Select';
import { Portal } from '../components/Portal';

interface NodeEditorModalProps {
  node?: ProxyNode | null;
  onSave: (node: ProxyNode) => void;
  onClose: () => void;
}

export const NodeEditorModal: React.FC<NodeEditorModalProps> = ({ node, onSave, onClose }) => {
  const [formData, setFormData] = useState<Partial<ProxyNode>>({
    type: 'vless',
    name: '',
    server: '',
    port: 443,
    groupId: 'default',
    uuid: '',
    password: '',
    tls: true,
    reality: false,
    sni: '',
    publicKey: '',
    shortId: '',
    fingerprint: 'chrome',
    transport: 'tcp',
    transportPath: '',
    transportHost: '',
    method: 'aes-256-gcm',
    flow: 'xtls-rprx-vision',
  });

  useEffect(() => {
    if (node) {
      setFormData(node);
    }
  }, [node]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // 端口必须是 1-65535 的整数(修复:此前展开顺序导致 port 以字符串保存,生成非法配置)
    const portNum = Number(formData.port);
    if (!formData.name || !formData.server || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return;
    }

    const finalNode: ProxyNode = {
      ...formData,
      id: node?.id || Math.random().toString(36).substring(2),
      groupId: formData.groupId || 'default',
      type: formData.type as ProxyType,
      name: formData.name || '',
      server: formData.server || '',
      port: portNum,
    };
    onSave(finalNode);
    onClose();
  };

  const protocolTypes: { id: ProxyType; label: string }[] = [
    { id: 'vless', label: 'VLESS' },
    { id: 'vmess', label: 'VMess' },
    { id: 'trojan', label: 'Trojan' },
    { id: 'shadowsocks', label: 'Shadowsocks' },
    { id: 'hysteria', label: 'Hysteria 1' },
    { id: 'hysteria2', label: 'Hysteria 2' },
    { id: 'tuic', label: 'TUIC' },
    { id: 'wireguard', label: 'WireGuard' },
    { id: 'socks', label: 'SOCKS5' },
    { id: 'http', label: 'HTTP' },
    { id: 'naive', label: 'NaiveProxy' },
  ];

  return (
    <Portal>
    <div className="no-drag fixed inset-0 bg-black/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-xl w-full p-6 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
            {node ? '编辑节点配置' : '手动添加代理节点'}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="overflow-y-auto space-y-4 py-4 pr-1 flex-1 text-xs">
          {/* Protocol Selector */}
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              协议类型 (Protocol)
            </label>
            <div className="grid grid-cols-3 gap-2">
              {protocolTypes.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setFormData({ ...formData, type: p.id })}
                  className={`py-1.5 px-3 rounded-lg font-medium text-xs border transition-all ${
                    formData.type === p.id
                      ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Basic Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-3">
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                节点名称 (Remark)
              </label>
              <input
                type="text"
                required
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="例如: Japan Tokyo 01"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                服务器地址 (Server)
              </label>
              <input
                type="text"
                required
                value={formData.server || ''}
                onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                placeholder="域名或 IP 地址"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                端口 (Port)
              </label>
              <input
                type="number"
                required
                value={formData.port || ''}
                onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) })}
                placeholder="443"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Protocol-specific dynamic fields */}
          {(formData.type === 'vless' || formData.type === 'vmess' || formData.type === 'tuic') && (
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                用户 ID / UUID
              </label>
              <input
                type="text"
                value={formData.uuid || ''}
                onChange={(e) => setFormData({ ...formData, uuid: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
          )}

          {formData.type === 'vless' && (
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                流控 (Flow)
              </label>
              <Select
                value={formData.flow || ''}
                onChange={(v) => setFormData({ ...formData, flow: v })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                options={[
                  { value: '', label: '无 (None)' },
                  { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' },
                ]}
              />
            </div>
          )}

          {formData.type === 'naive' && (
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                用户名 (Username)
              </label>
              <input
                type="text"
                value={formData.username || ''}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="HTTP 认证用户名"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
          )}

          {(formData.type === 'trojan' || formData.type === 'shadowsocks' || formData.type === 'hysteria2' || formData.type === 'naive') && (
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                认证密码 (Password / Secret)
              </label>
              <input
                type="text"
                value={formData.password || ''}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="节点密码"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>
          )}

          {/* Transport(naive/WireGuard 无传输层概念,隐藏) */}
          {formData.type !== 'naive' && formData.type !== 'wireguard' && (
          <>
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              传输协议 (Transport)
            </label>
            <Select
              value={formData.transport || 'tcp'}
              onChange={(v) => setFormData({ ...formData, transport: v as any })}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'ws', label: 'WebSocket (WS)' },
                { value: 'grpc', label: 'gRPC' },
                { value: 'http', label: 'HTTP' },
                { value: 'xhttp', label: 'XHTTP (SplitHTTP)' },
              ]}
            />
          </div>

          {formData.transport && formData.transport !== 'tcp' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  路径 (Path)
                </label>
                <input
                  type="text"
                  value={formData.transportPath || ''}
                  onChange={(e) => setFormData({ ...formData, transportPath: e.target.value })}
                  placeholder="/ws"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  请求头 / Host
                </label>
                <input
                  type="text"
                  value={formData.transportHost || ''}
                  onChange={(e) => setFormData({ ...formData, transportHost: e.target.value })}
                  placeholder="example.com"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none"
                />
              </div>
            </div>
          )}
          </>
          )}

          {/* TLS & Reality Settings */}
          <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-700 dark:text-slate-300">TLS 安全加密{formData.type === 'naive' ? '(Naive 强制启用)' : ''}</span>
              <input
                type="checkbox"
                checked={formData.type === 'naive' ? true : formData.tls || false}
                disabled={formData.type === 'naive'}
                onChange={(e) => setFormData({ ...formData, tls: e.target.checked })}
                className="w-4 h-4 rounded text-blue-600 focus:ring-0"
              />
            </div>

            {(formData.tls || formData.type === 'naive') && (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    SNI (Server Name Indication)
                  </label>
                  <input
                    type="text"
                    value={formData.sni || ''}
                    onChange={(e) => setFormData({ ...formData, sni: e.target.value })}
                    placeholder="www.microsoft.com"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none"
                  />
                </div>

                {formData.type === 'vless' && (
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      启用 Reality
                    </span>
                    <input
                      type="checkbox"
                      checked={formData.reality || false}
                      onChange={(e) => setFormData({ ...formData, reality: e.target.checked })}
                      className="w-4 h-4 rounded text-blue-600 focus:ring-0"
                    />
                  </div>
                )}

                {formData.reality && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Public Key (pbk)
                      </label>
                      <input
                        type="text"
                        value={formData.publicKey || ''}
                        onChange={(e) => setFormData({ ...formData, publicKey: e.target.value })}
                        placeholder="Reality 公钥"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Short ID (sid)
                      </label>
                      <input
                        type="text"
                        value={formData.shortId || ''}
                        onChange={(e) => setFormData({ ...formData, shortId: e.target.value })}
                        placeholder="短 ID"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 focus:outline-none font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer Buttons */}
          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg font-medium bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white flex items-center space-x-1.5 shadow-sm shadow-blue-500/25 transition-colors"
            >
              <Check className="w-4 h-4" />
              <span>保存节点</span>
            </button>
          </div>
        </form>
      </div>
    </div>
    </Portal>
  );
};
