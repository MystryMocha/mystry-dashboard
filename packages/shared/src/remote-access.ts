import type { PanelMessage } from './messages/index.js';

/**
 * 网卡分类，只用于默认值、排序和界面说明，不用来禁止选择。
 * lan 局域网；overlay 组网软件；proxy 代理软件的虚拟网卡；virtual 虚拟机或容器；
 * instanceNetwork 实例的联机网络；public 网卡上直接有公网地址。
 */
export type NetworkInterfaceKind =
  | 'lan'
  | 'overlay'
  | 'proxy'
  | 'virtual'
  | 'instanceNetwork'
  | 'public';

export interface PanelNetworkInterface {
  /** 系统网卡名，如 WLAN、以太网、tailscale0 */
  name: string;
  /** IPv4 地址 */
  address: string;
  /** 如 192.168.2.163/24；系统没给出时为 null */
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
  /** http(s)://<地址>:<port>/ */
  url: string;
  /** 来自用户填写的公网地址时为 null */
  interfaceName: string | null;
  kind: NetworkInterfaceKind | 'publicHost';
  /** 这个地址有没有挂上监听器；公网地址跟随是否有任一监听器在工作 */
  listening: boolean;
  /** 单个地址的问题：listenFailed、subnetUnknown */
  problem: RemoteAccessProblem | null;
}

/** 「直接访问」和「已装的组网软件」两种方式共用的状态。 */
export interface AccessModeStatus {
  enabled: boolean;
  /** 直接访问里 null 表示所有网卡 */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
  /** 所有候选地址（含没挂上的）拼出的网址 */
  urls: RemoteAccessUrl[];
  /** 整体问题：一个地址都没挂上、网卡不在了、证书失败 */
  problem: RemoteAccessProblem | null;
  /** 没开启时为 null */
  firewall: RemoteAccessFirewall | null;
}

export type DirectAccessStatus = AccessModeStatus;
export type OverlayAccessStatus = AccessModeStatus;

export interface PanelCertificateInfo {
  /** SHA-256 指纹，冒号分隔的大写十六进制 */
  fingerprint256: string;
  /** ISO 时间 */
  notAfter: string;
  /** 证书里写入的 IP 和域名 */
  addresses: string[];
}

export interface PanelNetworkDevice {
  hostname: string;
  virtualIp: string | null;
  connection: 'direct' | 'relay' | 'unknown';
}

export const PANEL_NETWORK_STATES = ['stopped', 'installing', 'starting', 'running', 'error'] as const;
export type PanelNetworkState = (typeof PANEL_NETWORK_STATES)[number];

/** 面板自带的 EasyTier 网络。状态里不含网络名和密钥。 */
export interface PanelNetworkStatus {
  enabled: boolean;
  platformSupported: boolean;
  installed: boolean;
  state: PanelNetworkState;
  detail: PanelMessage | null;
  /** 运行后为面板节点的虚拟地址 */
  virtualIp: string | null;
  /** http://<虚拟地址>:<port>/ */
  url: string | null;
  devices: PanelNetworkDevice[];
  useSharedPeers: boolean;
  customPeers: string[];
  /** 面板内置的社区共享节点，只用于展示 */
  sharedPeers: string[];
  /** Windows 防火墙规则是否加上；没运行或其他系统为 null */
  firewall: RemoteAccessFirewall | null;
}

/** GET /api/system/remote-access/panel-network/join 响应：手机加入要填的内容，含密钥。 */
export interface PanelNetworkJoinInfo {
  networkName: string;
  networkSecret: string;
  peers: string[];
  easytierVersion: string;
  /** 钉死版本的 GitHub 发布页 */
  androidDownloadUrl: string;
}

export interface UpdatePanelNetworkRequest {
  enabled: boolean;
  useSharedPeers?: boolean;
  /** 上限沿用 LAN_CUSTOM_PEER_LIMIT */
  customPeers?: string[];
}

/** GET /api/system/remote-access 响应。 */
export interface RemoteAccessStatus {
  /** HOST 已经是非回环地址：由配置文件决定，开关只读 */
  managedByConfig: boolean;
  /** managedByConfig 时为配置里的 HOST，否则为 null */
  configuredHost: string | null;
  /** 面板实际监听的端口 */
  port: number;
  /** 后端是否在托管前端（开发模式下通常为 false） */
  frontendServed: boolean;
  /** 面板所在系统，用于防火墙说明 */
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
  /** null 表示所有网卡 */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

export interface UpdateOverlayAccessRequest {
  enabled: boolean;
  /** 开启时必填 */
  interfaceName: string | null;
  restrictToSubnet: boolean;
  https: boolean;
}

export interface UpdatePublicHostRequest {
  /** null 表示清除 */
  host: string | null;
}

export interface PublicHostSetting {
  publicHost: string | null;
}

/** 面板自带网络里，面板节点的固定虚拟地址。 */
export const PANEL_NETWORK_VIRTUAL_IP = '10.127.0.1';
