import React from 'react';

/** 「公司资源」三字段:自定义域名 / 自定义 IP 网段 / 固定域名解析。
 *  corporate(VpnProfileEditor 高级分流)与引擎(VpnProfileEditorModal 高级选项)
 *  共用,保证两类编辑器的资源录入 UI 完全一致;文案可按场景覆写。
 *  值均为原始文本(每行一条),解析与校验由各自编辑器的保存逻辑负责。 */
export const VpnTargetsFields: React.FC<{
  domains: string;
  onDomains: (v: string) => void;
  cidrs: string;
  onCidrs: (v: string) => void;
  hosts: string;
  onHosts: (v: string) => void;
  domainsHint?: string;
  cidrsHint?: string;
  hostsHint?: string;
  hostsLabel?: string;
}> = ({
  domains,
  onDomains,
  cidrs,
  onCidrs,
  hosts,
  onHosts,
  domainsHint = '每行一个公司域名或 http(s) 网址，自动提取域名并包含子域名',
  cidrsHint = '填写精确目标，避免覆盖整个家庭局域网',
  hostsHint = '域名与 IP 之间用空格分隔，每行一条',
  hostsLabel = (
    <>
      固定域名解析 <span className="vpn-optional">可选</span>
    </>
  ),
}) => (
  <>
    <div className="vpn-two-columns">
      <label className="vpn-field">
        <span>自定义域名</span>
        <textarea
          aria-label="自定义域名"
          className="vpn-input font-mono"
          rows={5}
          placeholder={'dev.example.com\nuat.example.com'}
          value={domains}
          onChange={(e) => onDomains(e.target.value)}
        />
        <small>{domainsHint}</small>
      </label>
      <label className="vpn-field">
        <span>自定义 IP / 网段</span>
        <textarea
          aria-label="自定义 IP / 网段"
          className="vpn-input font-mono"
          rows={5}
          placeholder={'10.20.30.40\n10.20.40.0/24'}
          value={cidrs}
          onChange={(e) => onCidrs(e.target.value)}
        />
        <small>{cidrsHint}</small>
      </label>
    </div>
    <label className="vpn-field">
      <span>{hostsLabel}</span>
      <textarea
        aria-label="固定域名解析"
        className="vpn-input font-mono"
        rows={4}
        placeholder="dev.example.com 10.20.30.40"
        value={hosts}
        onChange={(e) => onHosts(e.target.value)}
      />
      <small>{hostsHint}</small>
    </label>
  </>
);
