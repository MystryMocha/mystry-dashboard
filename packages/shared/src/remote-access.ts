import type { PanelMessage } from './messages/index.js';

/**
 * Network interface categories, used only for defaults, ordering and UI hints, never to forbid a choice.
 * lan: local network; overlay: virtual networking software; proxy: a proxy app's virtual interface; virtual: VM or container;
 * instanceNetwork: an instance's multiplayer network; public: a public address directly on the interface.
 */
export type NetworkInterfaceKind =
  | 'lan'
  | 'overlay'
  | 'proxy'
  | 'virtual'
  | 'instanceNetwork'
  | 'public';

export interface PanelNetworkInterface {
  /** System interface name, e.g. WLAN, 以太网, tailscale0 */
  name: string;
  /** IPv4 address */
  address: string;
  /** e.g. 192.168.2.163/24; null when the system does not report it */
  cidr: string | null;
  kind: NetworkInterfaceKind;
}

export type RemoteAccessProblem =
  | 'interfaceGone'
  | 'noAddress'
  | 'listenFailed'
  | 'subnetUnknown'
  | 'certificateFailed';

export type RemoteAccessFirewall = 'applied' | 'failed' | 'skipped';

export interface RemoteAccessUrl {
  /** http(s)://<address>:<port>/ */
  url: string;
  /** null when it comes from the public address entered by the user */
  interfaceName: string | null;
  kind: NetworkInterfaceKind | 'publicHost';
  /** Whether a listener is attached on this address; the public address follows whether any listener is working */
  listening: boolean;
  /** Problems with a single address: listenFailed, subnetUnknown */
  problem: RemoteAccessProblem | null;
}

/** State shared by the "direct access" and "installed virtual networking software" modes. */
export interface AccessModeStatus {
  enabled: boolean;
  /** In direct access, null means all interfaces */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
  /** URLs built from all candidate addresses (including ones without a listener) */
  urls: RemoteAccessUrl[];
  /** Overall problems: no address got a listener, the interface is gone, the certificate failed */
  problem: RemoteAccessProblem | null;
  /** null when not enabled */
  firewall: RemoteAccessFirewall | null;
}

export type DirectAccessStatus = AccessModeStatus;
export type OverlayAccessStatus = AccessModeStatus;

export interface PanelCertificateInfo {
  /** SHA-256 fingerprint, colon-separated uppercase hex */
  fingerprint256: string;
  /** ISO timestamp */
  notAfter: string;
  /** IPs and domain names written into the certificate */
  addresses: string[];
}

export interface PanelNetworkDevice {
  hostname: string;
  virtualIp: string | null;
  connection: 'direct' | 'relay' | 'unknown';
}

export const PANEL_NETWORK_STATES = ['stopped', 'installing', 'starting', 'running', 'error'] as const;
export type PanelNetworkState = (typeof PANEL_NETWORK_STATES)[number];

/** The panel's built-in EasyTier network. The status contains no network name or secret. */
export interface PanelNetworkStatus {
  enabled: boolean;
  platformSupported: boolean;
  installed: boolean;
  state: PanelNetworkState;
  detail: PanelMessage | null;
  /** The panel peer's virtual address once running */
  virtualIp: string | null;
  /** http://<virtual address>:<port>/ */
  url: string | null;
  devices: PanelNetworkDevice[];
  useSharedPeers: boolean;
  customPeers: string[];
  /** Community shared peers built into the panel, for display only */
  sharedPeers: string[];
  /** Whether the Windows firewall rule was added; null when not running or on other systems */
  firewall: RemoteAccessFirewall | null;
}

/** GET /api/system/remote-access/panel-network/join response: what to enter on a phone to join, including the secret. */
export interface PanelNetworkJoinInfo {
  networkName: string;
  networkSecret: string;
  peers: string[];
  easytierVersion: string;
  /** GitHub release page of the pinned version */
  androidDownloadUrl: string;
}

export interface UpdatePanelNetworkRequest {
  enabled: boolean;
  useSharedPeers?: boolean;
  /** The limit reuses LAN_CUSTOM_PEER_LIMIT */
  customPeers?: string[];
}

/** GET /api/system/remote-access response. */
export interface RemoteAccessStatus {
  /** HOST is already a non-loopback address: decided by the config file, so the toggle is read-only */
  managedByConfig: boolean;
  /** The HOST from the config when managedByConfig, otherwise null */
  configuredHost: string | null;
  /** The port the panel actually listens on */
  port: number;
  /** Whether the backend is serving the frontend (usually false in development mode) */
  frontendServed: boolean;
  /** The panel host's OS, for firewall instructions */
  platform: string;
  interfaces: PanelNetworkInterface[];
  publicHost: string | null;
  certificate: PanelCertificateInfo | null;
  direct: DirectAccessStatus;
  overlay: OverlayAccessStatus;
  panelNetwork: PanelNetworkStatus;
}

export interface UpdateDirectAccessRequest {
  enabled: boolean;
  /** null means all interfaces */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

export interface UpdateOverlayAccessRequest {
  enabled: boolean;
  /** Required when enabling */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

export interface UpdatePublicHostRequest {
  /** null means clear */
  host: string | null;
}

export interface PublicHostSetting {
  publicHost: string | null;
}

/** The panel peer's fixed virtual address in the panel's built-in network. */
export const PANEL_NETWORK_VIRTUAL_IP = '10.127.0.1';
