import type { DetectedJvmConfig } from './jvm-config.js';
import type { PanelMessage, PanelMessageParams, ServerMessageKey } from './messages/index.js';

export * from './messages/index.js';

/** 本机资源快照；空值表示尚无有效采样，不等同于零占用。 */
export interface DashboardMetrics {
  sampledAt: string;
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number };
  disk: { availableBytes: number; totalBytes: number } | null;
  /** 告警说明（英文文本） */
  warnings: string[];
  /** 与 `warnings` 一一对应的可翻译消息；Web 按键判断告警种类并按当前语言显示 */
  warningsI18n?: PanelMessage[];
  instances: Record<string, {
    cpuPercent: number | null;
    memoryBytes: number | null;
    state: 'ready' | 'collecting' | 'unavailable';
  }>;
}

export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

/** 普通停止宽限期过后进程仍在退出（HTTP 202） */
export interface InstanceStopPendingResult {
  code: 'INSTANCE_STOP_PENDING';
  /** 英文说明 */
  error: string;
  /** `error` 对应的可翻译消息 */
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

/** 内置本机节点 ID（面板自身，始终存在） */
export const LOCAL_NODE_ID = 'local';

/** 远程 Agent 尚未实现，创建远程节点的入口保持关闭。 */
export const REMOTE_NODE_CREATION_ENABLED = false;

/** 节点在线状态（运行期，非持久化） */
export type NodeStatus = 'online' | 'offline';

/** 节点上报的主机信息（Agent 连接时携带，本机节点为面板自身信息） */
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
  /** 是否为面板内置的本机节点（不可删除/不可重置密钥） */
  isLocal: boolean;
  status: NodeStatus;
  lastSeenAt: string | null;
  hostInfo: NodeHostInfo | null;
  /** 该节点下挂载的实例数量 */
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

/** secret 只在创建节点或重置密钥时返回这一次，服务端只保存摘要。 */
export interface NodeSecretResult {
  node: NodeInfo;
  secret: string;
}

export interface InstanceInfo {
  id: string;
  name: string;
  coreType: CoreType;
  mcVersion: string | null;
  jarFile: string;
  javaPath: string;
  jvmArgs: string;
  /** 通常是 DATA_DIR/instances/<id>；旧实例仍绑定外部目录时为该目录，且 requiresMigration 为 true */
  installPath: string | null;
  requiresMigration: boolean;
  status: InstanceStatus;
  /** 所属节点 ID；默认为内置本机节点 LOCAL_NODE_ID */
  nodeId: string;
  /** 绑定的 Java 运行时 ID；null 表示使用面板 PATH 中的 java */
  javaRuntimeId: string | null;
  createdAt: string;
  updatedAt: string;
  acceptEula: boolean;
}

export interface CreateInstanceInput {
  name: string;
  jarFile?: string;
  jvmArgs?: string;
  coreType?: CoreType;
  mcVersion?: string;
  acceptEula?: boolean;
  /** 所属节点 ID；留空则使用本机节点。非本机节点在 Agent 接入前会创建失败 */
  nodeId?: string;
  /** Java 运行时 ID（必须来自面板探测清单）；留空/null 使用 PATH 中的 java */
  javaRuntimeId?: string | null;
}

export interface UpdateInstanceInput {
  name?: string;
  jarFile?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java 运行时 ID（必须来自面板探测清单）；null 恢复为 PATH 中的 java */
  javaRuntimeId?: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** 一次性文件下载 ticket；随后用 query 参数访问 GET .../files/download */
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

/** GET /api/instances/:id/files/download-ticket/:ticket/status 响应 */
export interface FileDownloadTicketStatusResult {
  status: FileDownloadTicketStatus;
  /** 占槽或开流失败时的说明（英文文本，或 Node.js 原始错误文本） */
  error?: string;
  /** `error` 对应的可翻译消息；原始系统错误没有该字段 */
  errorI18n?: PanelMessage;
}

export interface DeployCoreInput {
  name: string;
  coreType: Exclude<CoreType, 'custom'>;
  mcVersion: string;
  /** Paper build 号；不传则取最新 */
  build?: number;
  /** Fabric loader / Forge / NeoForge 版本；不传则取最新 */
  loaderVersion?: string;
  /** Fabric installer 版本；不传则取最新 */
  installerVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java 运行时 ID（必须来自面板探测清单）；留空/null 使用 PATH 中的 java */
  javaRuntimeId?: string | null;
}

/** DATA_DIR/imports 下可交给面板复制接管的已有服务端目录。 */
export interface ExistingServerSourceInfo {
  /** 交接区内的单层目录名，不是系统绝对路径。 */
  id: string;
  /** 自动探测到的 jar 或 Forge/NeoForge args 启动目标。 */
  launchTarget: string | null;
  /** 根据启动文件推断的核心类型；无法识别时为 custom。 */
  coreType: CoreType;
  modifiedAt: string;
  ready: boolean;
  /** 从 user_jvm_args.txt 检测出的参数；不存在该文件时省略。 */
  detectedJvmConfig?: DetectedJvmConfig;
  /** 英文说明（不可导入原因或预检提示）；无法归类的系统错误为原文。 */
  error?: string;
  /** `error` 的消息键与参数，Web 据此按界面语言显示；系统错误原文没有此字段。 */
  errorI18n?: PanelMessage;
}

export interface ExistingServerSourceListResult {
  sources: ExistingServerSourceInfo[];
}

/** 从固定交接区复制已有服务端并创建面板托管实例。 */
export interface ImportExistingServerInput {
  name: string;
  sourceId: string;
  coreType?: CoreType;
  mcVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  /** Java 运行时 ID（必须来自面板探测清单）；留空/null 使用 PATH 中的 java。 */
  javaRuntimeId?: string | null;
}

export interface JavaDetectResult {
  available: boolean;
  version: string | null;
  majorVersion: number | null;
}

/** ZIP 上传后等待用户确认 JVM 设置的临时预览。 */
export interface ImportPreviewInfo {
  id: string;
  fileName: string;
  sizeBytes: number;
  expiresAt: string;
  detectedJvmConfig?: DetectedJvmConfig;
}

export interface ConfirmZipImportInput {
  name: string;
  coreType?: CoreType;
  mcVersion?: string;
  jvmArgs?: string;
  acceptEula?: boolean;
  javaRuntimeId?: string | null;
}

/** 面板探测并执行 -version 验证过的 Java 运行时（绝对路径由面板扫描产生，不接受用户提交） */
export interface JavaRuntimeInfo {
  /** 稳定 ID：规范化路径的哈希，重扫后不变 */
  id: string;
  /** java 可执行文件绝对路径 */
  path: string;
  /** -version 输出中的完整版本串，如 "17.0.2" */
  version: string | null;
  /** 主版本号，如 8 / 17 / 21 */
  majorVersion: number | null;
  /** 探测来源：JAVA_HOME 环境变量或常见安装目录扫描 */
  source: 'env' | 'scan';
  verifiedAt: string;
  /** 最近一次完整扫描是否仍发现并验证此运行时 */
  available: boolean;
}

/** GET /api/system/java-runtimes 响应 */
export interface JavaRuntimeListResult {
  runtimes: JavaRuntimeInfo[];
}

/**
 * 按 Minecraft 版本推荐 Java 主版本号；无法识别版本格式时返回 null。
 * 26.1+（年份版本号，含 26.1.2、26.3-rc-3 等）→ 25；
 * 1.20.5+ → 21；1.17–1.20.4 → 17；1.16.5 及更早 → 8。
 */
export function recommendedJavaMajor(mcVersion: string | null | undefined): number | null {
  if (!mcVersion) return null;
  // Mojang 自 26.1 起改用「年份.序号」版本号，最低要求 Java 25
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

/** 备份来源：手动创建、还原前自动创建，或从文件上传。 */
export type BackupSource = 'manual' | 'pre-restore' | 'upload';

/** 一份实例备份（DATA_DIR/backups/<实例 ID>/<备份 ID>.tar.gz 及其元数据）。 */
export interface BackupInfo {
  /** 形如 20261026-054200-ab12cd 的备份 ID，同时是文件名主体。 */
  id: string;
  /** 备份所属（存放在其下）的实例 ID。 */
  instanceId: string;
  /** 备份时的实例名称；上传的备份为来源面板中的名称。 */
  instanceName: string;
  source: BackupSource;
  createdAt: string;
  /** 压缩包大小（字节）。 */
  sizeBytes: number;
  /** 备份内文件数量。 */
  fileCount: number;
  /** 解压后的文件总大小（字节），还原时据此检查磁盘空间。 */
  contentBytes: number;
  coreType: CoreType | null;
  mcVersion: string | null;
  /** 备份时服务器是否在运行（运行中备份会先暂停自动保存并刷写世界）。 */
  wasRunning: boolean;
  /** 压缩包 SHA-256，便于用户自行核对下载的文件。 */
  sha256: string;
}

/** GET /api/instances/:id/backups 响应 */
export interface BackupListResult {
  backups: BackupInfo[];
}

/** POST /api/instances/:id/backups/:backupId/restore 请求体 */
export interface RestoreBackupInput {
  /** 还原前先备份当前文件；默认 true。 */
  backupCurrent?: boolean;
}

export interface TaskInfo {
  id: string;
  type: 'download' | 'extract' | 'deploy' | 'import' | 'backup' | 'restore';
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  /** 英文进度文本；旧版本写入的任务可能是中文。 */
  message: string;
  /** 进度消息键与参数，Web 据此按界面语言显示；旧任务没有此字段。 */
  messageI18n?: PanelMessage;
  /**
   * backupId：备份任务生成的备份，或还原任务使用的备份。
   * instanceRecordUpdated：还原后面板记录的启动文件、核心类型或版本已按备份更新。
   */
  result?: { instanceId?: string; stagingToken?: string; backupId?: string; instanceRecordUpdated?: boolean };
  /** 英文失败原因；旧版本写入的任务可能是中文。 */
  error?: string;
  /** 失败原因的消息键与参数；旧任务或无法归类的原始错误没有此字段。 */
  errorI18n?: PanelMessage;
  createdAt: string;
  updatedAt: string;
}

/** 任务中心列表响应（GET /api/tasks） */
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

export interface AuthUser {
  id: string;
  username: string;
}

export interface ConsoleMessage {
  type: 'output' | 'status' | 'error' | 'history';
  /** `error` 帧为英文说明（或 Node.js 原始错误文本） */
  data: string;
  status?: InstanceStatus;
  /** `error` 帧的消息键与参数，Web 据此按当前语言显示；原始系统错误没有该字段 */
  code?: ServerMessageKey;
  params?: PanelMessageParams;
}

export {
  CORE_TYPE_ENUM,
  DEPLOYABLE_CORE_TYPE_ENUM,
  createInstanceBodySchema,
  updateInstanceBodySchema,
  deployCoreBodySchema,
  importExistingServerBodySchema,
  confirmZipImportBodySchema,
  setupBodySchema,
  loginBodySchema,
  createNodeBodySchema,
  updateNodeBodySchema,
  fileDownloadTicketBodySchema,
  fileDownloadQuerySchema,
  restoreBackupBodySchema,
  backupDownloadQuerySchema,
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
  firstJvmValidationError,
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
