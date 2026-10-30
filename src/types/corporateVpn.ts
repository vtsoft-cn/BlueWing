export type VpnProtocol = 'easyconnect' | 'atrust' | 'softether';
export type VpnOutlet = 'direct' | 'proxy' | 'vpn';
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
  authName?: string;
  authChoices?: VpnAuthMethod[];
  diagnosticMode?: 'off' | 'detail' | 'full';
  trafficMode?: 'split' | 'vpn' | 'custom';
  autoDiscoverPrivate?: boolean;
  routingPriority?: number;
  customRouting?: { domestic: VpnOutlet; foreign: VpnOutlet; lan: VpnOutlet };
  rememberPassword: boolean;
  rememberSession: boolean;
  tls: {
    caPem?: string;
    pinSha256?: string;
    serverName?: string;
    trustMode?: 'auto' | 'strict';
    autoTrustAnchor?: 'system' | 'pin';
  };
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
  validFrom?: string;
  dnsNames?: string[];
  ipAddresses?: string[];
  trustIssues?: string[];
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
  trafficProtected?: boolean;
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
  errorDetail?: { stage: string; message: string; serverCode?: string };
  resources?: VpnResources;
  requiresCoreRebuild?: boolean;
  revision?: string;
  coreAvailable?: boolean;
  preparingRouting?: boolean;
}
export interface VpnSnapshot {
  profiles: VpnProfile[];
  state: VpnState;
  states?: Record<string, VpnState>;
  defaultProfileId?: string;
  encryptionAvailable: boolean;
  passwordSaved?: Record<string, boolean>;
  diagnostics?: Record<string, { exists: boolean; path: string; mode: string; error?: string }>;
  discoveredTargets?: Record<string, VpnTarget[]>;
}
export interface VpnRuntimeProfile {
  profile: VpnProfile;
  socksUser: string;
  socksPassword: string;
  routePath: string;
  guardPath: string;
  dnsPath: string;
  internetPath?: string;
  internetDnsPath?: string;
  discoveredGuardPath?: string;
  packet?: { privateKey: string; publicKey: string; port?: number; serverPublicKey?: string; loopbackInterface?: string };
}
export interface VpnRuntime {
  profiles: VpnRuntimeProfile[];
  coreProcessName: string;
  privateProxy?: { port: number; user: string; password: string; rulePath: string };
}
export interface CorporateVpnAPI {
  snapshot(): Promise<VpnSnapshot>;
  save(
    profile: VpnProfile,
  ): Promise<{ profile: VpnProfile; requiresCoreRebuild: boolean }>;
  remove(id: string): Promise<void>;
  connect(id: string, password: string): Promise<void>;
  disconnect(id?: string): Promise<void>;
  discover(id: string): Promise<VpnAuthMethod[]>;
  certificate(id: string): Promise<VpnCertificate>;
  respond(id: string, generation: number, value: string, profileId?: string): Promise<void>;
  clearCredentials(id: string): Promise<void>;
  savePassword(id: string, password: string, remember: boolean): Promise<void>;
  openDiagnostics(id: string): Promise<void>;
  clearDiagnostics(id: string): Promise<void>;
  clearDiscoveredTargets(id: string): Promise<void>;
  apply(): Promise<boolean>;
  onState(callback: (state: VpnState) => void): () => void;
}
