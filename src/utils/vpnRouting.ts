import { VpnOutlet, VpnProfile } from '../types/corporateVpn';

export function orderedVpnProfiles(profiles: VpnProfile[]): VpnProfile[] {
  return [...profiles].sort((a, b) => (a.routingPriority ?? 100) - (b.routingPriority ?? 100));
}

export const vpnTrafficModes = [
  { id: 'split', name: '智能分流', summary: '公司走 VPN，国内走本机', recommended: true },
  { id: 'vpn', name: '全部走 VPN', summary: '默认经 VPN，国外优先代理', recommended: false },
  { id: 'custom', name: '自定义', summary: '分别选择每类流量的出口', recommended: false },
] as const;

/** Shared by the visible route preview and the actual rule compiler. */
export function vpnRouting(profile: Pick<VpnProfile, 'trafficMode' | 'customRouting'>, proxyEnabled: boolean) {
  const mode = profile.trafficMode || 'split';
  const custom = profile.customRouting || { domestic: 'direct', foreign: 'proxy', lan: 'direct' };
  const raw: { domestic: VpnOutlet; foreign: VpnOutlet; lan: VpnOutlet } = mode === 'vpn'
    ? { domestic: 'vpn', foreign: proxyEnabled ? 'proxy' : 'vpn', lan: 'vpn' }
    : mode === 'custom' ? custom : { domestic: 'direct', foreign: proxyEnabled ? 'proxy' : 'direct', lan: 'direct' };
  // A configured but unreachable public proxy never falls back to direct.
  const actual = (outlet: VpnOutlet): VpnOutlet => outlet === 'proxy' && !proxyEnabled ? 'direct' : outlet;
  return { domestic: actual(raw.domestic), foreign: actual(raw.foreign), lan: actual(raw.lan) };
}
