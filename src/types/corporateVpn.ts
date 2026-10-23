export type VpnProtocol = 'easyconnect' | 'atrust';
export interface VpnTarget {
  guardOnly?: boolean;
  domains: string[];
  cidrs: string[];
  ports?: string[];
  network?: 'tcp' | 'udp';
}
export interface VpnProfile {
  id: string;
  name: string;
  protocol: VpnProtocol;
  gateway: { host: string; port: number };
  username: string;
  authMethod: string;
  loginDomain: string;
  rememberPassword: boolean;
  rememberSession: boolean;
  tls: { caPem?: string; pinSha256?: string; serverName?: string };
  targets: VpnTarget[];
  hosts: Record<string, string[]>;
  bindInterface: string;
  socksPort: number;
  dnsPort: number;
}
export interface VpnAuthMethod {
  loginDomain: string;
  authType: string;
  authName: string;
  supported: boolean;
}
export interface VpnCertificate {
  fingerprint: string;
  subject: string;
  issuer: string;
  validTo: string;
  chainTrusted: boolean;
}
export interface VpnResources {
  targets: VpnTarget[];
  hosts: Record<string, string[]>;
  dnsServers: string[];
}
export interface VpnChallenge {
  id: string;
  generation: number;
  profileId: string;
  kind: 'otp' | 'sms' | 'image' | 'structured' | 'confirm-sms';
  title: string;
  expiresAt: number;
  imageBase64?: string;
  mime?: string;
}
export interface VpnState {
  state:
    | 'idle'
    | 'starting'
    | 'authenticating'
    | 'waiting_user'
    | 'applying_policy'
    | 'connected'
    | 'failed'
    | 'stopping'
    | 'reconnect_wait';
  generation: number;
  profileId?: string;
  challenge?: VpnChallenge;
  error?: string;
  resources?: VpnResources;
  requiresCoreRebuild?: boolean;
  revision?: string;
  coreAvailable?: boolean;
}
export interface VpnSnapshot {
  profiles: VpnProfile[];
  state: VpnState;
  encryptionAvailable: boolean;
}
export interface VpnRuntimeProfile {
  profile: VpnProfile;
  socksUser: string;
  socksPassword: string;
  routePath: string;
  guardPath: string;
  dnsPath: string;
}
export interface VpnRuntime {
  profiles: VpnRuntimeProfile[];
  coreProcessName: string;
}
export interface CorporateVpnAPI {
  snapshot(): Promise<VpnSnapshot>;
  save(
    profile: VpnProfile,
  ): Promise<{ profile: VpnProfile; requiresCoreRebuild: boolean }>;
  remove(id: string): Promise<void>;
  connect(id: string, password: string): Promise<void>;
  disconnect(): Promise<void>;
  discover(id: string): Promise<VpnAuthMethod[]>;
  certificate(id: string): Promise<VpnCertificate>;
  respond(id: string, generation: number, value: string): Promise<void>;
  clearCredentials(id: string): Promise<void>;
  apply(): Promise<boolean>;
  onState(callback: (state: VpnState) => void): () => void;
}
