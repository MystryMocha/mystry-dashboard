import type { DetectedJvmConfig } from './jvm-config.js';
import type { PanelMessage, PanelMessageParams, ServerMessageKey } from './messages/index.js';

export * from './messages/index.js';
export type {
  FrpEndpoint,
  FrpEndpointInput,
  FrpRuntimeInfo,
  FrpTransport,
  InstanceTunnel,
  InstanceTunnelInput,
  RuntimeArchiveInfo,
  TunnelMode,
  TunnelStatus,
} from './frp.js';
export type {
  InstanceLan,
  InstanceLanInput,
  LanRuntimeInfo,
  LanStatus,
} from './lan.js';
export { EASYTIER_VERSION, LAN_CUSTOM_PEER_LIMIT, LAN_STATUSES } from './lan.js';
export type {
  AccessModeStatus,
  DirectAccessStatus,
  NetworkInterfaceKind,
  OverlayAccessStatus,
  PanelCertificateInfo,
  PanelNetworkDevice,
  PanelNetworkInterface,
  PanelNetworkJoinInfo,
  PanelNetworkState,
  PanelNetworkStatus,
  PublicHostSetting,
  RemoteAccessFirewall,
  RemoteAccessProblem,
  RemoteAccessStatus,
  RemoteAccessUrl,
  UpdateDirectAccessRequest,
  UpdateOverlayAccessRequest,
  UpdatePanelNetworkRequest,
  UpdatePublicHostRequest,
} from './remote-access.js';
export { PANEL_NETWORK_STATES, PANEL_NETWORK_VIRTUAL_IP } from './remote-access.js';
export { FRP_CLIENT_VERSION, FRP_TRANSPORTS, TUNNEL_MODES, TUNNEL_STATUSES } from './frp.js';

/** Snapshot of local resources; an empty value means there is no valid sample yet, not zero usage. */
export interface DashboardMetrics {
  sampledAt: string;
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number };
  disk: { availableBytes: number; totalBytes: number } | null;
  /** Warning descriptions (English text) */
  warnings: string[];
  /** Translatable messages matching `warnings` one-to-one; Web uses the key to tell the warning kind and shows it in the current language */
  warningsI18n?: PanelMessage[];
  instances: Record<string, {
    cpuPercent: number | null;
    memoryBytes: number | null;
    state: 'ready' | 'collecting' | 'unavailable';
  }>;
}

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

/** The process is still exiting after the normal stop grace period (HTTP 202) */
export interface InstanceStopPendingResult {
  code: 'INSTANCE_STOP_PENDING';
  /** English description */
  error: string;
  /** Translatable message for `error` */
  errorI18n?: PanelMessage;
  status: 'stopping';
  stillStopping: true;
}

export function isInstanceStopPendingResult(value: unknown): value is InstanceStopPendingResult {
  return value !== null
    && typeof value === 'object'
    && 'stillStopping' in value
    && (value as InstanceStopPendingResult).stillStopping === true;
}

export type CoreType = 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge' | 'custom';

/** ID of the built-in local node (the panel itself, always present) */
export const LOCAL_NODE_ID = 'local';

/** The remote Agent is not implemented yet, so the entry for creating remote nodes stays closed. */
export const REMOTE_NODE_CREATION_ENABLED = false;

/** Node online status (runtime only, not persisted) */
export type NodeStatus = 'online' | 'offline';

/** Host info reported by the node (sent when the Agent connects; for the local node it is the panel's own info) */
export interface NodeHostInfo {
  platform?: string;
  arch?: string;
  cpuCount?: number;
  totalMemMb?: number;
  agentVersion?: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  /** Whether this is the panel's built-in local node (cannot be deleted, secret cannot be reset) */
  isLocal: boolean;
  status: NodeStatus;
  lastSeenAt: string | null;
  hostInfo: NodeHostInfo | null;
  /** Number of instances attached to this node */
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNodeInput {
  name: string;
}

export interface UpdateNodeInput {
  name?: string;
}

/** secret is returned only this once, when the node is created or its secret is reset; the server stores only a digest. */
export interface NodeSecretResult {
  node: NodeInfo;
  secret: string;
}

/**
 * Startup failure reasons the panel recognizes from console output:
 * eula means the Minecraft EULA has not been accepted yet; java-too-new / java-too-old mean the Java version in use is too new or too old.
 * java-unavailable does not come from console output: the Java runtime bound to the instance is no longer usable or no longer registered, which can be told without starting.
 */
export type InstanceStartIssueKind = 'eula' | 'java-too-new' | 'java-too-old' | 'java-unavailable';

export interface InstanceStartIssue {
  kind: InstanceStartIssueKind;
  /** The Java major version this server needs; null when it cannot be determined or is unrelated to Java. */
  requiredJava: number | null;
}

/** GET /api/instances/:id/local-network response: addresses that friends on the same network as this computer can connect to directly. */
export interface InstanceLocalNetwork {
  /** Game port from server.properties; null when it cannot be read or is not a valid port. */
  port: number | null;
  /** This computer's LAN IPv4 addresses, excluding loopback, link-local and public addresses on an interface. */
  addresses: string[];
  /** Public IPv4 addresses assigned directly to an interface (some cloud servers and data centers). */
  publicIpv4: string[];
  /** This computer's public IPv6 addresses, for friends outside the local network to connect directly; empty when there are none or server-ip does not accept IPv6. */
  publicIpv6: string[];
  /** Public IP or domain entered by the user; null when not set. */
  publicHost: string | null;
  /** true when server-ip is bound to a specific address, in which case friends on the same network may be unable to connect. */
  serverIpBlocked: boolean;
  /** server-ip is set to exactly publicHost, but no interface has that address (a common mistake on cloud servers). */
  serverIpIsUnboundPublicHost: boolean;
  /**
   * The port the panel actually listens on, used to tell the game port from the panel port in instructions.
   * It cannot be taken from the browser address bar: when opened through SSH port forwarding, the local port may differ from the panel port.
   */
  panelPort: number;
  /** The panel host's OS (process.platform), used to show the matching firewall instructions. */
  platform: string;
}

export interface InstanceInfo {
  id: string;
  name: string;
  coreType: CoreType;
  mcVersion: string | null;
  jarFile: string;
  javaPath: string;
  jvmArgs: string;
  /** Usually DATA_DIR/instances/<id>; for a legacy instance still bound to an external directory it is that directory, and requiresMigration is true */
  installPath: string | null;
  requiresMigration: boolean;
  status: InstanceStatus;
  /** ID of the owning node; defaults to the built-in local node LOCAL_NODE_ID */
  nodeId: string;
  /** ID of the bound Java runtime; null means use the java on the panel's PATH */
  javaRuntimeId: string | null;
  createdAt: string;
  updatedAt: string;
  acceptEula: boolean;
  /**
   * Set when the latest start failed for a recognizable reason; cleared on the next start, a panel restart, or once the instance runs normally.
   * When the bound Java is no longer usable (java-unavailable) it is set without waiting for a start, and goes away after another Java is chosen or a rescan finds it again.
   */
  startIssue?: InstanceStartIssue | null;
  /** In this run the server has finished starting (it printed Done) and players can join; false when not running or still loading. */
  ready?: boolean;
}

/** Prefix for a Forge / NeoForge args file in `InstanceInfo.jarFile`, followed by the path relative to the instance directory. */
export const LAUNCH_ARGS_PREFIX = '@args:';
/** When `InstanceInfo.jarFile` equals this value, the mod loader is not installed yet and there is no file to launch. */
export const LAUNCH_MODLOADER_PENDING = '@modloader';

/** An instance's launch target: a plain jar, a Forge / NeoForge args file, or a mod loader that is not installed yet. */
export type LaunchTarget =
  | { kind: 'jar'; path: string }
  | { kind: 'args'; path: string }
  | { kind: 'modloader' };

/** Splits out the markers the panel itself writes into `jarFile`; the UI must not show markers such as `@args:` to people as a file name. */
export function parseLaunchTarget(jarFile: string): LaunchTarget {
  if (jarFile.startsWith(LAUNCH_ARGS_PREFIX)) return { kind: 'args', path: jarFile.slice(LAUNCH_ARGS_PREFIX.length) };
  if (jarFile === LAUNCH_MODLOADER_PENDING) return { kind: 'modloader' };
  return { kind: 'jar', path: jarFile };
}

export interface CreateInstanceInput {
  name: string;
  jarFile?: string;
  jvmArgs?: string;
  coreType?: CoreType;
  mcVersion?: string;
  acceptEula?: boolean;
  /** ID of the owning node; empty uses the local node. Creation fails for non-local nodes until the Agent is available */
  nodeId?: string;
  /** Java runtime ID (must come from the panel's detected list); empty/null uses the java on PATH */
  javaRuntimeId?: string | null;
}

export interface UpdateInstanceInput {
  name?: string;
  jarFile?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java runtime ID (must come from the panel's detected list); null reverts to the java on PATH */
  javaRuntimeId?: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** One-time file download ticket; then pass it as a query parameter to GET .../files/download */
export interface FileDownloadTicketResult {
  ticket: string;
  expiresIn: number;
}

export type FileDownloadTicketStatus =
  | 'reserved'
  | 'streaming'
  | 'failed'
  | 'expired'
  | 'consumed';

/** GET /api/instances/:id/files/download-ticket/:ticket/status response */
export interface FileDownloadTicketStatusResult {
  status: FileDownloadTicketStatus;
  /** Description when claiming the slot or opening the stream fails (English text, or the raw Node.js error text) */
  error?: string;
  /** Translatable message for `error`; raw system errors do not have this field */
  errorI18n?: PanelMessage;
}

/** Download source; for the values see DOWNLOAD_SOURCE_ENUM in schemas.ts. */
export type DownloadSource = 'official' | 'china';

/** GET /api/system/download-source response, also the PUT request body. */
export interface DownloadSourceSetting {
  source: DownloadSource;
}

/**
 * GET /api/system/panel-info response: the listen address and directories the panel read from its config file at startup; shown in the UI only, not editable.
 * Contains no secrets.
 */
export interface PanelInfo {
  /** Address of the main listener (HOST); listeners added by "open on other devices" are not included here */
  host: string;
  port: number;
  /** Absolute path of the data root directory */
  dataDir: string;
  /** Absolute path of the backup directory; under the data root when not configured separately */
  backupDir: string;
  /** Path of the config file the panel reads; changes to this file take effect only after the panel restarts */
  configPath: string;
}

export interface DeployCoreInput {
  name: string;
  coreType: Exclude<CoreType, 'custom'>;
  mcVersion: string;
  /** Paper build number; latest when omitted */
  build?: number;
  /** Fabric loader / Forge / NeoForge version; latest when omitted */
  loaderVersion?: string;
  /** Fabric installer version; latest when omitted */
  installerVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java runtime ID (must come from the panel's detected list); empty/null uses the java on PATH */
  javaRuntimeId?: string | null;
}

/** An existing server directory under DATA_DIR/imports that can be handed to the panel to copy and take over. */
export interface ExistingServerSourceInfo {
  /** A single-level directory name inside the handoff area, not an absolute system path. */
  id: string;
  /** The auto-detected jar or Forge/NeoForge args launch target. */
  launchTarget: string | null;
  /** Core type inferred from the launch file; custom when unrecognized. */
  coreType: CoreType;
  /** Minecraft version recognized from the launch file name; omitted when unrecognized. */
  mcVersion?: string;
  modifiedAt: string;
  ready: boolean;
  /** Arguments detected from user_jvm_args.txt; omitted when the file does not exist. */
  detectedJvmConfig?: DetectedJvmConfig;
  /** True when the server's own eula.txt already records acceptance; the import page then does not ask again and the file is left as it is. Omitted otherwise. */
  eulaAccepted?: boolean;
  /** English description (why it cannot be imported, or a precheck hint); the original text for system errors that cannot be classified. */
  error?: string;
  /** Message key and params for `error`, which Web uses to show it in the UI language; raw system error text does not have this field. */
  errorI18n?: PanelMessage;
}

export interface ExistingServerSourceListResult {
  sources: ExistingServerSourceInfo[];
  /** Absolute path of the imports handoff area on the panel's computer, shown only to the signed-in user to copy into; the panel never accepts a path submitted by the client. */
  importDir: string;
}

/** Precheck result for a server folder: shared by the imports source and browser-uploaded folders. */
export type ServerFolderCheck = Pick<
  ExistingServerSourceInfo,
  'launchTarget' | 'coreType' | 'mcVersion' | 'ready' | 'detectedJvmConfig' | 'eulaAccepted' | 'error' | 'errorI18n'
>;

/** Starts a server folder upload from the browser: the folder name, file count and total size are declared first, and the panel checks quota and free space against them. */
export interface CreateFolderUploadInput {
  folderName: string;
  fileCount: number;
  totalBytes: number;
}

/** A server folder uploaded from the browser. Only counters while uploading; once everything is received, state becomes ready and the precheck result check is attached. */
export interface FolderUploadInfo {
  id: string;
  /** Name of the folder the user picked, for display only. */
  folderName: string;
  fileCount: number;
  totalBytes: number;
  receivedFiles: number;
  receivedBytes: number;
  state: 'uploading' | 'ready';
  expiresAt: string;
  check?: ServerFolderCheck;
}

/** Copies an existing server from the fixed handoff area and creates a panel-managed instance. */
export interface ImportExistingServerInput {
  name: string;
  sourceId: string;
  coreType?: CoreType;
  mcVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java runtime ID (must come from the panel's detected list); empty/null uses the java on PATH. */
  javaRuntimeId?: string | null;
}

export interface JavaDetectResult {
  available: boolean;
  version: string | null;
  majorVersion: number | null;
}

/** Temporary preview after a ZIP upload, waiting for the user to confirm JVM settings. */
export interface ImportPreviewInfo {
  id: string;
  fileName: string;
  sizeBytes: number;
  expiresAt: string;
  detectedJvmConfig?: DetectedJvmConfig;
  /** True when the package's own eula.txt (at the root, or in its single top-level folder) already records acceptance. */
  eulaAccepted?: boolean;
}

export interface ConfirmZipImportInput {
  name: string;
  coreType?: CoreType;
  mcVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  javaRuntimeId?: string | null;
}

/** A Java runtime the panel detected and verified by running -version (the absolute path comes from the panel's scan; user-submitted paths are not accepted) */
export interface JavaRuntimeInfo {
  /** Stable ID: a hash of the normalized path, unchanged across rescans */
  id: string;
  /** Absolute path of the java executable */
  path: string;
  /** Full version string from the -version output, e.g. "17.0.2" */
  version: string | null;
  /** Major version number, e.g. 8 / 17 / 21 */
  majorVersion: number | null;
  /** Detection source: the JAVA_HOME environment variable, a scan of common install directories, or Java the panel itself installed into the data directory */
  source: 'env' | 'scan' | 'panel';
  verifiedAt: string;
  /** Whether the latest full scan still found and verified this runtime */
  available: boolean;
}

/** GET /api/system/java-runtimes response */
export interface JavaRuntimeListResult {
  runtimes: JavaRuntimeInfo[];
  /** Java major versions the panel can install automatically on this computer; an empty array when the OS or architecture is unsupported */
  installable: number[];
}

/** POST /api/system/java-runtimes/install request: which major version to install. The response is a background task. */
export interface InstallJavaRequest {
  major: number;
}

/**
 * Recommends a Java major version for a Minecraft version; returns null when the version format is unrecognized.
 * 26.1+ (year-based versions, including 26.1.2, 26.3-rc-3, etc.) → 25;
 * 1.20.5+ → 21; 1.17–1.20.4 → 17; 1.16.5 and earlier → 8.
 */
export function recommendedJavaMajor(mcVersion: string | null | undefined): number | null {
  if (!mcVersion) return null;
  // Since 26.1 Mojang uses "year.sequence" version numbers, which require at least Java 25
  const yearMatch = mcVersion.match(/^(\d{2,})\.(\d+)/);
  if (yearMatch && Number(yearMatch[1]) >= 26) return 25;
  const match = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor >= 21) return 21;
  if (minor === 20) return patch >= 5 ? 21 : 17;
  if (minor >= 17) return 17;
  return 8;
}

/** Backup origin: created manually, created automatically before a restore, uploaded from a file, or created by the daily schedule. */
export type BackupSource = 'manual' | 'pre-restore' | 'upload' | 'scheduled';

/** One instance backup (DATA_DIR/backups/<instance ID>/<backup ID>.tar.gz and its metadata). */
export interface BackupInfo {
  /** Backup ID such as 20261026-054200-ab12cd, also the file name stem. */
  id: string;
  /** ID of the instance the backup belongs to (and is stored under). */
  instanceId: string;
  /** Instance name at backup time; for an uploaded backup, the name in the source panel. */
  instanceName: string;
  source: BackupSource;
  createdAt: string;
  /** Archive size (bytes). */
  sizeBytes: number;
  /** Number of files in the backup. */
  fileCount: number;
  /** Total size of the extracted files (bytes), used to check disk space on restore. */
  contentBytes: number;
  coreType: CoreType | null;
  mcVersion: string | null;
  /** Whether the server was running at backup time (a running backup first pauses autosave and flushes the world). */
  wasRunning: boolean;
  /** Archive SHA-256, so users can verify a downloaded file themselves. */
  sha256: string;
}

/** GET /api/instances/:id/backups response */
export interface BackupListResult {
  backups: BackupInfo[];
}

/** POST /api/instances/:id/backups/:backupId/restore request body */
export interface RestoreBackupInput {
  /** Back up the current files before restoring; defaults to true. */
  backupCurrent?: boolean;
}

/** The daily automatic backup of one instance; PUT /api/instances/:id/backup-schedule request body. */
export interface BackupScheduleInput {
  enabled: boolean;
  /** Time of day as HH:MM (24-hour), read on the clock of the computer the panel runs on. */
  time: string;
  /** How many scheduled backups to keep. Older ones are deleted after each scheduled backup that succeeds; backups from other sources are never deleted. */
  keep: number;
}

/** A scheduled backup that failed. */
export interface BackupScheduleFailure {
  at: string;
  /** English failure reason. */
  error: string;
  /** Message key and params for the failure reason; raw errors that cannot be classified do not have this field. */
  errorI18n?: PanelMessage;
}

/** GET /api/instances/:id/backup-schedule response, also returned by PUT. Without a saved schedule it holds the defaults, disabled. */
export interface BackupScheduleInfo extends BackupScheduleInput {
  /** Offset of the panel computer's clock from UTC right now, in minutes (east is positive): a browser in another time zone uses it to say which clock `time` is read on. */
  utcOffsetMinutes: number;
  /** When the latest scheduled backup that succeeded was taken; null when there has been none. */
  lastBackupAt: string | null;
  /** Set while the latest scheduled run is a failed one; the next one that succeeds clears it. */
  lastFailure: BackupScheduleFailure | null;
}

export interface TaskInfo {
  id: string;
  type: 'download' | 'extract' | 'deploy' | 'import' | 'backup' | 'restore';
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  /** English progress text; tasks written by older versions may be in Chinese. */
  message: string;
  /** Message key and params for the progress, which Web uses to show it in the UI language; older tasks do not have this field. */
  messageI18n?: PanelMessage;
  /**
   * backupId: the backup produced by a backup task, or the backup used by a restore task.
   * instanceRecordUpdated: after a restore, the launch file, core type or version recorded by the panel was updated to match the backup.
   */
  result?: {
    instanceId?: string;
    stagingToken?: string;
    backupId?: string;
    instanceRecordUpdated?: boolean;
    /** Java install task: ID of the runtime that was installed and registered */
    javaRuntimeId?: string;
  };
  /** English failure reason; tasks written by older versions may be in Chinese. */
  error?: string;
  /** Message key and params for the failure reason; older tasks and raw errors that cannot be classified do not have this field. */
  errorI18n?: PanelMessage;
  createdAt: string;
  updatedAt: string;
}

/** Task center list response (GET /api/tasks) */
export interface TaskListResult {
  tasks: TaskInfo[];
}

export interface AuthSetupStatus {
  needsSetup: boolean;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface SetupInput {
  username: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ResetPasswordInput {
  password: string;
}

export interface AuthUser {
  id: string;
  username: string;
}

/** Session duration; for the values see SESSION_DURATION_ENUM in schemas.ts; never means it does not expire (the token has no exp). */
export type SessionDuration = '2h' | '12h' | '1d' | '7d' | '30d' | 'never';

/** GET /api/auth/session-duration response, also the PUT request body. */
export interface SessionDurationSetting {
  duration: SessionDuration;
}

/** Session duration saved: this device switches to the token reissued here with the new duration; other devices pick it up after their next sign-in. */
export interface UpdateSessionDurationResult extends SessionDurationSetting {
  token: string;
}

/** Password changed: all old tokens are invalidated, and the current session stays signed in with the new token reissued here. */
export interface ChangePasswordResult {
  ok: true;
  token: string;
  user: AuthUser;
}

export interface ConsoleMessage {
  type: 'output' | 'status' | 'error' | 'history';
  /** An `error` frame carries an English description (or the raw Node.js error text) */
  data: string;
  status?: InstanceStatus;
  /** Message key and params for an `error` frame, which Web uses to show it in the current language; raw system errors do not have this field */
  code?: ServerMessageKey;
  params?: PanelMessageParams;
}

export {
  CORE_TYPE_ENUM,
  DEPLOYABLE_CORE_TYPE_ENUM,
  DOWNLOAD_SOURCE_ENUM,
  updateDownloadSourceBodySchema,
  SESSION_DURATION_ENUM,
  updateSessionDurationBodySchema,
  JAVA_INSTALL_MAJORS,
  installJavaBodySchema,
  createInstanceBodySchema,
  updateInstanceBodySchema,
  deployCoreBodySchema,
  importExistingServerBodySchema,
  confirmZipImportBodySchema,
  createFolderUploadBodySchema,
  setupBodySchema,
  changePasswordBodySchema,
  resetPasswordBodySchema,
  loginBodySchema,
  createNodeBodySchema,
  updateNodeBodySchema,
  fileDownloadTicketBodySchema,
  fileDownloadQuerySchema,
  restoreBackupBodySchema,
  backupDownloadQuerySchema,
  BACKUP_SCHEDULE_MAX_KEEP,
  BACKUP_SCHEDULE_TIME_PATTERN,
  updateBackupScheduleBodySchema,
  createFrpEndpointBodySchema,
  updateFrpEndpointBodySchema,
  updateInstanceTunnelBodySchema,
  updateInstanceLanBodySchema,
  updateAccessModeBodySchema,
  updatePanelNetworkBodySchema,
  updatePublicHostBodySchema,
} from './schemas.js';

export type {
  DetectedJvmConfig,
  JvmPresetDefinition,
  JvmPresetId,
  JvmValidationContext,
  JvmValidationIssue,
  ParsedJvmConfig,
} from './jvm-config.js';

export {
  JVM_PRESETS,
  JvmArgsParseError,
  automaticInitialMemoryMiB,
  buildJvmArgs,
  firstJvmValidationIssue,
  inspectJvmArgFile,
  inspectJvmArgs,
  parseJvmArgFile,
  parseJvmArgs,
  recommendedMaxMemoryMiB,
  serializeJvmArgFile,
  serializeJvmArgs,
  validateJvmArgs,
} from './jvm-config.js';
