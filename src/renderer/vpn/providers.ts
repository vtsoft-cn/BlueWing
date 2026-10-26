import { VpnProtocol } from '../../types/corporateVpn';

/** UI capabilities belong to the provider; new entries also require a native adapter. */
export const vpnProviders: Record<
  VpnProtocol,
  {
    name: string;
    mark: string;
    tone: 'blue' | 'violet' | 'teal';
    description: string;
    authDiscovery: boolean;
    deviceSession: boolean;
  }
> = {
  easyconnect: {
    name: 'EasyConnect',
    mark: 'EC',
    tone: 'blue',
    description: '账号密码与动态码认证',
    authDiscovery: false,
    deviceSession: false,
  },
  atrust: {
    name: 'aTrust',
    mark: 'AT',
    tone: 'violet',
    description: '登录域与多种认证方式',
    authDiscovery: true,
    deviceSession: true,
  },
  softether: {
    name: 'SoftEther',
    mark: 'SE',
    tone: 'teal',
    description: 'Virtual HUB 与账号密码认证',
    authDiscovery: false,
    deviceSession: false,
  },
};

export const vpnProviderList = Object.entries(vpnProviders).map(
  ([id, provider]) => ({
    id: id as VpnProtocol,
    ...provider,
  }),
);
