import type { RuntimeArchiveInfo } from './frp.js';
import type { PanelMessage } from './messages/index.js';

export const EASYTIER_VERSION = '2.6.4';

export const LAN_STATUSES = ['disabled', 'stopped', 'starting', 'running', 'error'] as const;
export type LanStatus = (typeof LAN_STATUSES)[number];

/** Maximum number of custom relay peers that can be entered per instance. */
export const LAN_CUSTOM_PEER_LIMIT = 8;

export interface LanRuntimeInfo {
  version: string;
  installed: boolean;
  platformSupported: boolean;
  /** The official archive for this machine's platform. When GitHub is unreachable, the user can download the same file from any mirror and upload it; the panel verifies it by digest. */
  archive: RuntimeArchiveInfo | null;
  /**
   * Windows only: the panel is not running as administrator, so EasyTier cannot create its virtual adapter.
   * False on other systems and when it cannot be determined.
   */
  needsAdmin: boolean;
  /**
   * Windows only: the panel is running as administrator, and the servers it starts inherit those rights.
   * False on other systems and when it cannot be determined.
   */
  runsAsAdmin: boolean;
  /**
   * The page may offer to restart the panel as administrator in one click: Windows, a browser on this computer, a panel started by
   * mdash.cmd whose launcher finds the same config and data directory by itself, and an account in Administrators.
   */
  adminRestart: boolean;
  /** Windows only: the launcher asks for administrator rights every time it starts the panel. */
  startAsAdmin: boolean;
}

export interface LanAdminRestartInput {
  /** Also ask for administrator rights on every later start. */
  startAsAdmin: boolean;
}

export interface LanAdminStartInput {
  enabled: boolean;
}

export interface InstanceLanInput {
  enabled: boolean;
  /** Custom relay peers, such as tcp://relay.example.com:11010. Omitted means no change. */
  peers?: string[];
  /** Whether to also use the community shared peers built into the panel. Omitted means no change. */
  useSharedPeers?: boolean;
}

/** The status response contains no network name or secret. The secret appears only in the separately downloaded instructions for friends. */
export interface InstanceLan {
  instanceId: string;
  enabled: boolean;
  status: LanStatus;
  /** Current game port from server.properties. Empty when it cannot be read. */
  localPort: number | null;
  /** The virtual address friends should add. Empty when not enabled yet or the port is unavailable. */
  virtualIp: string | null;
  joinAddress: string | null;
  serverIpBlocked: boolean;
  runtimeInstalled: boolean;
  /** Relay peers entered by the user (normalized). */
  peers: string[];
  useSharedPeers: boolean;
  /** Community shared peers built into the panel, for display only. */
  sharedPeers: string[];
  /** The port EasyTier is listening on in this run (same for TCP and UDP), for direct connections that do not rely on hole punching, such as IPv6. Empty when not running. */
  listenPort: number | null;
  detail: PanelMessage | null;
  /** Problems that do not stop it from running but may keep friends from connecting, such as a firewall rule that could not be added. */
  warning: PanelMessage | null;
}
