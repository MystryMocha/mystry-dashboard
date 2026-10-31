import type { PanelMessage } from './messages/index.js';

export const EASYTIER_VERSION = '2.6.4';

export const LAN_STATUSES = ['disabled', 'stopped', 'starting', 'running', 'error'] as const;
export type LanStatus = (typeof LAN_STATUSES)[number];

export interface LanRuntimeInfo {
  version: string;
  installed: boolean;
  platformSupported: boolean;
}

export interface InstanceLanInput {
  enabled: boolean;
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
  detail: PanelMessage | null;
}
