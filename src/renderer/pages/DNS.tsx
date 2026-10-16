import React, { useState } from 'react';
import {Check, Zap, Save, Plus, Trash2, FileCode2} from 'lucide-react';
import { DnsConfig, HostsRecord } from '../../types';
import { isValidDomain, isValidIpLiteral } from '../../utils/ip';

const DNS_PRESETS = [
  { name: '阿里', primary: '223.5.5.5', secondary: '223.6.6.6' },
  { name: '腾讯', primary: '119.29.29.29', secondary: '119.28.28.28' },
  { name: 'Google', primary: '8.8.8.8', secondary: '8.8.4.4' },
  { name: 'Cloudflare', primary: '1.1.1.1', secondary: '1.0.0.1' },
];

interface DNSProps {
  dns: DnsConfig;
  onSaveDns: (dns: DnsConfig) => void;
}

export const DNS: React.FC<DNSProps> = ({ dns, onSaveDns }) => {
  const [formData, setFormData] = useState<DnsConfig>({ ...dns, hosts: Array.isArray(dns.hosts) ? dns.hosts : [] });
  const [testDomain, setTestDomain] = useState('www.google.com');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [hostsError, setHostsError] = useState<string | null>(null);
  // hosts 为可选字段,统一收敛为确定性数组供渲染与编辑使用
  const hostsList = formData.hosts || [];

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    // Hosts 行校验:启用的行必须有合法域名与 IP,且同域名同记录类型不允许重复
    const seen = new Set<string>();
    for (const h of hostsList) {
      if (!h.enabled) continue;
      const domain = h.domain.trim().toLowerCase().replace(/\.$/, '');
      const ip = h.ip.trim();
      if (!domain && !ip) continue; // 两格都空的启用行视为未填写,忽略
      if (!domain || !isValidDomain(domain)) {
        setHostsError(`域名格式无效: "${domain || '(空)'}"`);
        return;
      }
      if (!isValidIpLiteral(ip)) {
        setHostsError(`IP 格式无效: "${ip || '(空)'}" (域名 ${domain})`);
        return;
      }
      const key = `${domain}|${ip.includes(':') ? 'AAAA' : 'A'}`;
      if (seen.has(key)) {
        setHostsError(`重复映射: ${domain} -> ${ip}`);
        return;
      }
      seen.add(key);
    }
    setHostsError(null);
    onSaveDns(formData);
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2000);
  };

  // ---- 应用内 Hosts 映射 ----
  const addHostsRow = () => {
    const record: HostsRecord = {
      id: `hosts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      domain: '',
      ip: '',
      enabled: true,
    };
    setFormData({ ...formData, hosts: [...hostsList, record] });
  };

  const updateHostsRow = (id: string, patch: Partial<HostsRecord>) => {
    setFormData({
      ...formData,
      hosts: hostsList.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    });
  };

  const removeHostsRow = (id: string) => {
    setFormData({ ...formData, hosts: hostsList.filter((h) => h.id !== id) });
  };

  const handleTestDns = async () => {
    if (!testDomain || !testDomain.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      if (window.electronAPI?.dns?.testResolve) {
        const res = await window.electronAPI.dns.testResolve(testDomain.trim());
        if (res.success) {
          setTestResult(`解析成功: ${testDomain} -> ${res.ip} (延迟: ${res.latency}ms)`);
        } else {
          setTestResult(`解析失败: ${res.error || '无法解析该域名'}`);
        }
      } else {
        setTestResult('DNS 测试接口未就绪');
      }
    } catch (e: any) {
      setTestResult(`解析失败: ${e.message || '网络异常'}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSave} className="space-y-4">
        {/* 1. Header & DNS Mode */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-4">
          <div>
            <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
              DNS 服务架构配置
            </h3>
            <p className="text-xs text-slate-400">
              配置安全防污染 DNS 解析服务，支持 DoH、DoT 及 FakeIP 虚拟池
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div
              onClick={() => setFormData({ ...formData, mode: 'standard' })}
              className={`p-4 rounded-xl border cursor-pointer transition-all ${
                formData.mode === 'standard'
                  ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-400'
              }`}
            >
              <div className="font-bold text-xs">标准真实 IP 模式 (Standard)</div>
              <div className="text-[11px] opacity-80 mt-1">
                远程安全 DNS 解析出真实 IP，连接时无需虚拟映射
              </div>
            </div>

            <div
              onClick={() => setFormData({ ...formData, mode: 'fakeip' })}
              className={`p-4 rounded-xl border cursor-pointer transition-all ${
                formData.mode === 'fakeip'
                  ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-400'
              }`}
            >
              <div className="font-bold text-xs">FakeIP 增强模式 (推荐)</div>
              <div className="text-[11px] opacity-80 mt-1">
                为域名瞬时分配 FakeIP，省去本地 DNS 往返延迟，极速首包建连
              </div>
            </div>
          </div>
        </div>

        {/* 2. DNS Servers */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-4 text-xs">
          <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">
            上游 DNS 服务器
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                远程代理 DNS (Remote DNS - 走节点代理)
              </label>
              <input
                type="text"
                required
                value={formData.remoteDns}
                onChange={(e) => setFormData({ ...formData, remoteDns: e.target.value })}
                placeholder="https://1.1.1.1/dns-query"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                常用: https://1.1.1.1/dns-query, https://dns.google/dns-query
              </span>
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                国内直连 DNS (Direct DNS - 直连国内)
              </label>
              <input
                type="text"
                required
                value={formData.directDns}
                onChange={(e) => setFormData({ ...formData, directDns: e.target.value })}
                placeholder="223.5.5.5"
                className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                常用: 223.5.5.5 (阿里), 119.29.29.29 (腾讯)
              </span>
            </div>
          </div>

          {formData.mode === 'fakeip' && (
            <div className="pt-2">
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                FakeIP 虚拟网段 (IPv4 CIDR)
              </label>
              <input
                type="text"
                value={formData.fakeIpRange}
                onChange={(e) => setFormData({ ...formData, fakeIpRange: e.target.value })}
                placeholder="198.18.0.0/15"
                className="w-full sm:w-1/2 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono focus:outline-none"
              />
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <div>
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                开启智能 DNS 分流
              </div>
              <div className="text-[11px] text-slate-400">
                自动匹配国内常用域名直连国内 DNS，防止 CDN 识别减速
              </div>
            </div>
            <input
              type="checkbox"
              checked={formData.enableDnsRouting}
              onChange={(e) =>
                setFormData({ ...formData, enableDnsRouting: e.target.checked })
              }
              className="w-4 h-4 rounded text-blue-600 focus:ring-0"
            />
          </div>
        </div>

        {/* 2.5 应用内 Hosts 映射 */}
        <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-4 text-xs">
          <div>
            <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 flex items-center space-x-1.5">
              <FileCode2 className="w-4 h-4 text-blue-500" />
              <span>自定义域名解析 (应用内 Hosts)</span>
            </h4>
            <p className="text-xs text-slate-400 mt-1">
              指定域名直接解析到指定 IP,仅在本应用内核心生效,
              <span className="text-slate-500 dark:text-slate-300">完全不修改系统 hosts 文件</span>;
              域名为精确匹配(与系统 hosts 语义一致),保存后核心运行期间立即生效。
            </p>
          </div>

          {hostsList.length === 0 ? (
            <div className="p-4 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 text-[11px] text-slate-400 text-center">
              暂无映射记录,点击下方按钮添加一条域名 → IP 映射
            </div>
          ) : (
            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-1 text-[10px] font-medium text-slate-400 uppercase tracking-wide">
                <span className="w-8 text-center">启用</span>
                <span>域名 (精确匹配)</span>
                <span>目标 IP (IPv4 / IPv6)</span>
                <span className="w-8 text-center">操作</span>
              </div>
              {hostsList.map((h) => (
                <div
                  key={h.id}
                  className="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1fr_1fr_auto] gap-2 items-center"
                >
                  <input
                    type="checkbox"
                    checked={h.enabled}
                    onChange={(e) => updateHostsRow(h.id, { enabled: e.target.checked })}
                    className="w-4 h-4 mx-auto rounded text-blue-600 focus:ring-0"
                  />
                  <input
                    type="text"
                    value={h.domain}
                    onChange={(e) => updateHostsRow(h.id, { domain: e.target.value })}
                    placeholder="example.com"
                    spellCheck={false}
                    className={`w-full px-3 py-2 rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-500 ${
                      h.enabled && h.domain && !isValidDomain(h.domain)
                        ? 'border-red-400 dark:border-red-500/60'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  />
                  <input
                    type="text"
                    value={h.ip}
                    onChange={(e) => updateHostsRow(h.id, { ip: e.target.value })}
                    placeholder="10.0.0.5 或 fd00::5"
                    spellCheck={false}
                    className={`w-full px-3 py-2 rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-500 ${
                      h.enabled && h.ip && !isValidIpLiteral(h.ip)
                        ? 'border-red-400 dark:border-red-500/60'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => removeHostsRow(h.id)}
                    className="w-8 h-8 mx-auto rounded-lg flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="删除此映射"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {hostsError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-[11px]">
              {hostsError}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={addHostsRow}
              className="px-4 py-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 text-slate-600 dark:text-slate-400 font-medium flex items-center space-x-1.5 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加映射</span>
            </button>
            <p className="text-[10px] text-slate-400 max-w-md">
              生效范围: 经核心解析的域名(直连流量、TUN 劫持与系统代理下的本机解析);
              走代理节点出流的域名由远端节点解析,不经过本地映射。
            </p>
          </div>
        </div>

        {/* 保存栏 */}
        <div className="bg-white dark:bg-slate-900 p-4 px-5 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm flex items-center justify-end space-x-3">
          {savedSuccess && (
            <span className="text-xs text-emerald-500 font-medium flex items-center space-x-1">
              <Check className="w-3.5 h-3.5" />
              <span>保存成功</span>
            </span>
          )}
          <button
            type="submit"
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 text-white font-medium flex items-center space-x-1.5 shadow-sm shadow-blue-500/25"
          >
            <Save className="w-4 h-4" />
            <span>保存 DNS 配置</span>
          </button>
        </div>
      </form>

      {/* 3. DNS Lookup Test Tool */}
      <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-3">
        <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">
          DNS 解析与连通性测试工具
        </h4>
        <div className="flex space-x-2">
          <input
            type="text"
            value={testDomain}
            onChange={(e) => setTestDomain(e.target.value)}
            placeholder="输入域名，例如: www.google.com"
            className="flex-1 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs font-mono focus:outline-none"
          />
          <button
            onClick={handleTestDns}
            disabled={isTesting}
            className="px-5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-medium flex items-center space-x-1.5 transition-colors"
          >
            <Zap className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
            <span>{isTesting ? '测试中...' : '测试解析'}</span>
          </button>
        </div>

        {testResult && (
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-700 dark:text-slate-300">
            {testResult}
          </div>
        )}
      </div>
    </div>
  );
};
