import type { RuntimeArchiveInfo } from './frp.js';
import type { PanelMessage } from './messages/index.js';

export const EASYTIER_VERSION = '2.6.4';

export const LAN_STATUSES = ['disabled', 'stopped', 'starting', 'running', 'error'] as const;
export type LanStatus = (typeof LAN_STATUSES)[number];

/** 每个实例最多填写的自定义中继节点数。 */
export const LAN_CUSTOM_PEER_LIMIT = 8;

export interface LanRuntimeInfo {
  version: string;
  installed: boolean;
  platformSupported: boolean;
  /** 本机平台对应的官方压缩包。连不上 GitHub 时，用户可从任意镜像下载同名文件再上传，面板按摘要核对。 */
  archive: RuntimeArchiveInfo | null;
}

export interface InstanceLanInput {
  enabled: boolean;
  /** 自定义中继节点，形如 tcp://relay.example.com:11010。省略表示不改。 */
  peers?: string[];
  /** 是否同时使用面板内置的社区共享节点。省略表示不改。 */
  useSharedPeers?: boolean;
}

/** 状态响应不含网络名或密钥。密钥只出现在单独下载的朋友说明里。 */
export interface InstanceLan {
  instanceId: string;
  enabled: boolean;
  status: LanStatus;
  /** 当前 server.properties 的游戏端口。无法读取时为空。 */
  localPort: number | null;
  /** 朋友要添加的虚拟地址。尚未启用或端口不可用时为空。 */
  virtualIp: string | null;
  joinAddress: string | null;
  serverIpBlocked: boolean;
  runtimeInstalled: boolean;
  /** 用户填写的中继节点（已规范化）。 */
  peers: string[];
  useSharedPeers: boolean;
  /** 面板内置的社区共享节点，只用于展示。 */
  sharedPeers: string[];
  /** EasyTier 本次监听的端口（TCP 与 UDP 相同），供 IPv6 等非打洞直连使用。未运行时为空。 */
  listenPort: number | null;
  detail: PanelMessage | null;
  /** 不阻止运行、但可能让朋友连不上的问题，例如防火墙规则没加上。 */
  warning: PanelMessage | null;
}
