import React, { useState, useEffect } from 'react';
import { ModalCloseX, ModalShell } from '../components/ModalShell';
import { useModalClose } from '../components/ModalShell';
import { X, Check } from 'lucide-react';
import { ProxyNode, ProxyType } from '../../types';
import { Select } from '../components/Select';
import { Portal } from '../components/Portal';
import { FieldLabel, inputCls, Input, Button } from '../components/ui';

interface NodeEditorModalProps {
  node?: ProxyNode | null;
  onSave: (node: ProxyNode) => void;
  onClose: () => void;
}

export const NodeEditorModal: React.FC<NodeEditorModalProps> = ({ node, onSave, onClose }) => (
  <Portal>
    <ModalShell overlayClassName="bg-black/60 z-[200]" onClose={onClose}>
      <NodeEditorPanel node={node} onSave={onSave} onClose={onClose} />
    </ModalShell>
  </Portal>
);

// 面板必须是 ModalShell 的真实子组件:useModalClose 的 Context 只提供给 children,
// 在外层组件里调用拿到的是默认空函数(X/取消点了没反应的根因)
const NodeEditorPanel: React.FC<NodeEditorModalProps> = ({ node, onSave, onClose }) => {
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

  // 经 ModalShell Context 拿收场关闭;直接调 onClose prop 会跳过动画
  const requestClose = useModalClose();
  return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl max-w-xl w-full p-6 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
          <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
            {node ? '编辑节点配置' : '手动添加代理节点'}
          </h3>
          <ModalCloseX onClick={requestClose} />
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="overflow-y-auto space-y-4 py-4 pr-1 flex-1 text-xs">
          {/* Protocol Selector */}
          <div>
            <FieldLabel>
              协议类型 (Protocol)
            </FieldLabel>
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
              <FieldLabel>
                节点名称 (Remark)
              </FieldLabel>
              <Input
                type="text"
                required
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="例如: Japan Tokyo 01"
              />
            </div>

            <div className="sm:col-span-2">
              <FieldLabel>
                服务器地址 (Server)
              </FieldLabel>
              <Input
                type="text"
                required
                value={formData.server || ''}
                onChange={(e) => setFormData({ ...formData, server: e.target.value })}
                placeholder="域名或 IP 地址"
              />
            </div>

            <div>
              <FieldLabel>
                端口 (Port)
              </FieldLabel>
              <Input
                type="number"
                required
                value={formData.port || ''}
                onChange={(e) => setFormData({ ...formData, port: Number(e.target.value) })}
                placeholder="443"
              />
            </div>
          </div>

          {/* Protocol-specific dynamic fields */}
          {(formData.type === 'vless' || formData.type === 'vmess' || formData.type === 'tuic') && (
            <div>
              <FieldLabel>
                用户 ID / UUID
              </FieldLabel>
              <Input
                type="text"
                value={formData.uuid || ''}
                onChange={(e) => setFormData({ ...formData, uuid: e.target.value })}
                placeholder="00000000-0000-0000-0000-000000000000"
className="font-mono"
              />
            </div>
          )}

          {formData.type === 'vless' && (
            <div>
              <FieldLabel>
                流控 (Flow)
              </FieldLabel>
              <Select
                value={formData.flow || ''}
                onChange={(v) => setFormData({ ...formData, flow: v })}
                className={inputCls}
                options={[
                  { value: '', label: '无 (None)' },
                  { value: 'xtls-rprx-vision', label: 'xtls-rprx-vision' },
                ]}
              />
            </div>
          )}

          {formData.type === 'naive' && (
            <div>
              <FieldLabel>
                用户名 (Username)
              </FieldLabel>
              <Input
                type="text"
                value={formData.username || ''}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="HTTP 认证用户名"
className="font-mono"
              />
            </div>
          )}

          {(formData.type === 'trojan' || formData.type === 'shadowsocks' || formData.type === 'hysteria2' || formData.type === 'naive') && (
            <div>
              <FieldLabel>
                认证密码 (Password / Secret)
              </FieldLabel>
              <Input
                type="text"
                value={formData.password || ''}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="节点密码"
className="font-mono"
              />
            </div>
          )}

          {/* Transport(naive/WireGuard 无传输层概念,隐藏) */}
          {formData.type !== 'naive' && formData.type !== 'wireguard' && (
          <>
          <div>
            <FieldLabel>
              传输协议 (Transport)
            </FieldLabel>
            <Select
              value={formData.transport || 'tcp'}
              onChange={(v) => setFormData({ ...formData, transport: v as any })}
              className={inputCls}
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
                <FieldLabel>
                  路径 (Path)
                </FieldLabel>
                <Input
                  type="text"
                  value={formData.transportPath || ''}
                  onChange={(e) => setFormData({ ...formData, transportPath: e.target.value })}
                  placeholder="/ws"
                />
              </div>
              <div>
                <FieldLabel>
                  请求头 / Host
                </FieldLabel>
                <Input
                  type="text"
                  value={formData.transportHost || ''}
                  onChange={(e) => setFormData({ ...formData, transportHost: e.target.value })}
                  placeholder="example.com"
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
                  <FieldLabel>
                    SNI (Server Name Indication)
                  </FieldLabel>
                  <Input
                    type="text"
                    value={formData.sni || ''}
                    onChange={(e) => setFormData({ ...formData, sni: e.target.value })}
                    placeholder="www.microsoft.com"
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
                      <FieldLabel>
                        Public Key (pbk)
                      </FieldLabel>
                      <Input
                        type="text"
                        value={formData.publicKey || ''}
                        onChange={(e) => setFormData({ ...formData, publicKey: e.target.value })}
                        placeholder="Reality 公钥"
className="font-mono"
                      />
                    </div>
                    <div>
                      <FieldLabel>
                        Short ID (sid)
                      </FieldLabel>
                      <Input
                        type="text"
                        value={formData.shortId || ''}
                        onChange={(e) => setFormData({ ...formData, shortId: e.target.value })}
                        placeholder="短 ID"
className="font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer Buttons */}
          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="ghost" onClick={requestClose}>
              取消
            </Button>
            <Button type="submit">
              <Check className="w-4 h-4" />
              保存节点
            </Button>
          </div>
        </form>
      </div>
  );
};
