import type { PanelMessage } from './messages/index.js';

/** 面板代管的官方 frpc。只描述联机方式，不接受任意配置或可执行路径。 */

export const FRP_CLIENT_VERSION = '0.71.1';

export const FRP_TRANSPORTS = ['tcp', 'kcp', 'quic', 'websocket', 'wss'] as const;
export type FrpTransport = (typeof FRP_TRANSPORTS)[number];

/** public：朋友直连穿透服务器上的端口。stcp：经穿透服务器中转的内网。xtcp：点对点内网。 */
export const TUNNEL_MODES = ['public', 'stcp', 'xtcp'] as const;
export type TunnelMode = (typeof TUNNEL_MODES)[number];

export const TUNNEL_STATUSES = ['disabled', 'stopped', 'starting', 'running', 'error'] as const;
export type TunnelStatus = (typeof TUNNEL_STATUSES)[number];

export interface FrpEndpoint {
  id: string;
  name: string;
  serverAddr: string;
  serverPort: number;
  /** 朋友要连接的主机名。空字符串表示与 serverAddr 相同。 */
  visitHost: string;
  transport: FrpTransport;
  tls: boolean;
  /** 令牌只写不回读。 */
  tokenSet: boolean;
}

export interface FrpEndpointInput {
  name: string;
  serverAddr: string;
  serverPort: number;
  visitHost?: string;
  transport: FrpTransport;
  tls?: boolean;
  /** 更新时省略或空字符串表示保留原令牌。 */
  token?: string;
}

export interface FrpRuntimeInfo {
  version: string;
  installed: boolean;
  platformSupported: boolean;
}

export interface InstanceTunnel {
  instanceId: string;
  enabled: boolean;
  endpointId: string | null;
  mode: TunnelMode;
  remotePort: number | null;
  /** 朋友运行 visitor 后，在他自己的电脑上连接的本地端口。 */
  visitorBindPort: number;
  /** 本机 Minecraft 正在监听的端口，来自 server.properties。 */
  localPort: number;
  status: TunnelStatus;
  /** 公网模式是朋友要填的地址；内网模式是朋友本机的 127.0.0.1 端口。未启用时为 null。 */
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
