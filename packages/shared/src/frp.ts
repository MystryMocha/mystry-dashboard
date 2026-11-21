import type { PanelMessage } from './messages/index.js';

/** The official frpc binary managed by the panel. Only describes the connection mode; arbitrary config or executable paths are not accepted. */

export const FRP_CLIENT_VERSION = '0.71.1';

export const FRP_TRANSPORTS = ['tcp', 'kcp', 'quic', 'websocket', 'wss'] as const;
export type FrpTransport = (typeof FRP_TRANSPORTS)[number];

/** public: friends connect straight to a port on the frp server. stcp: private, relayed through the frp server. xtcp: private, peer-to-peer. */
export const TUNNEL_MODES = ['public', 'stcp', 'xtcp'] as const;
export type TunnelMode = (typeof TUNNEL_MODES)[number];

export const TUNNEL_STATUSES = ['disabled', 'stopped', 'starting', 'running', 'error'] as const;
export type TunnelStatus = (typeof TUNNEL_STATUSES)[number];

export interface FrpEndpoint {
  id: string;
  name: string;
  serverAddr: string;
  serverPort: number;
  /** Hostname friends connect to. An empty string means the same as serverAddr. */
  visitHost: string;
  transport: FrpTransport;
  tls: boolean;
  /** The token is write-only and is never returned. */
  tokenSet: boolean;
}

export interface FrpEndpointInput {
  name: string;
  serverAddr: string;
  serverPort: number;
  visitHost?: string;
  transport: FrpTransport;
  tls?: boolean;
  /** On update, omitted or an empty string keeps the existing token. */
  token?: string;
}

export interface FrpRuntimeInfo {
  version: string;
  installed: boolean;
  platformSupported: boolean;
  /** The official archive for this machine's platform. When GitHub is unreachable, the user can download the same file from any mirror and upload it; the panel verifies it by digest. */
  archive: RuntimeArchiveInfo | null;
}

/** The pinned official archive: file name, SHA-256 and official download URL. null when the platform is unsupported. */
export interface RuntimeArchiveInfo {
  name: string;
  sha256: string;
  url: string;
  /** Upload size limit (bytes) */
  maxBytes: number;
}

export interface InstanceTunnel {
  instanceId: string;
  enabled: boolean;
  endpointId: string | null;
  mode: TunnelMode;
  remotePort: number | null;
  /** The local port a friend connects to on their own computer after running the visitor. */
  visitorBindPort: number;
  /** The port Minecraft is listening on locally, read from server.properties. */
  localPort: number;
  status: TunnelStatus;
  /** In public mode, the address friends enter; in private modes, the 127.0.0.1 port on the friend's machine. null when not enabled. */
  joinAddress: string | null;
  serverIpBlocked: boolean;
  runtimeInstalled: boolean;
  detail: PanelMessage | null;
}

export interface InstanceTunnelInput {
  enabled: boolean;
  endpointId: string;
  mode: TunnelMode;
  remotePort?: number;
  visitorBindPort?: number;
}
