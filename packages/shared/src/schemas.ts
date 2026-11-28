/** Request JSON Schemas used by Fastify AJV; when fields change, keep the matching types in index.ts in sync. */

import { AUTO_RESTART_LIMITS } from './auto-restart.js';

/** Core type enum (including custom) */
export const CORE_TYPE_ENUM = [
  'vanilla',
  'paper',
  'fabric',
  'forge',
  'neoforge',
  'custom',
] as const;

/** Panel download source: official uses only the official servers; china prefers mirrors in China and falls back to official on failure. */
export const DOWNLOAD_SOURCE_ENUM = ['official', 'china'] as const;

/** Session duration: how long after sign-in the password must be entered again; never does not expire. Defaults to 12h. */
export const SESSION_DURATION_ENUM = ['2h', '12h', '1d', '7d', '30d', 'never'] as const;

/** Time range for GET /api/stats/overview; defaults to 7d when omitted. */
export const STATS_RANGE_ENUM = ['24h', '7d', '30d'] as const;

/** GET /api/stats/overview query parameters */
export const statsOverviewQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: [...STATS_RANGE_ENUM] },
  },
} as const;

/** Core types that support one-click deploy (excluding custom) */
export const DEPLOYABLE_CORE_TYPE_ENUM = [
  'vanilla',
  'paper',
  'fabric',
  'forge',
  'neoforge',
] as const;

/** Java major versions the panel can install automatically (Eclipse Temurin JRE; the exact version and SHA-256 are pinned on the server). */
export const JAVA_INSTALL_MAJORS = [8, 17, 21, 25] as const;

/** POST /api/system/java-runtimes/install: only accepts major versions whose installer the panel has pinned. */
export const installJavaBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['major'],
  properties: {
    major: { type: 'integer', enum: [...JAVA_INSTALL_MAJORS] },
  },
} as const;

export const createInstanceBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    jarFile: { type: 'string', maxLength: 1024 },
    jvmArgs: { type: 'string', maxLength: 8192 },
    coreType: { type: 'string', enum: [...CORE_TYPE_ENUM] },
    mcVersion: { type: 'string', maxLength: 64 },
    acceptEula: { type: 'boolean' },
    nodeId: { type: 'string', maxLength: 255 },
    javaRuntimeId: { type: ['string', 'null'], maxLength: 255 },
  },
} as const;

export const updateInstanceBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    jarFile: { type: 'string', maxLength: 1024 },
    jvmArgs: { type: 'string', maxLength: 8192 },
    acceptEula: { type: 'boolean' },
    javaRuntimeId: { type: ['string', 'null'], maxLength: 255 },
  },
} as const;

export const deployCoreBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'coreType', 'mcVersion'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    coreType: { type: 'string', enum: [...DEPLOYABLE_CORE_TYPE_ENUM] },
    mcVersion: { type: 'string', maxLength: 64 },
    build: { type: 'integer' },
    loaderVersion: { type: 'string', maxLength: 128 },
    installerVersion: { type: 'string', maxLength: 128 },
    jvmArgs: { type: 'string', maxLength: 8192 },
    acceptEula: { type: 'boolean' },
    javaRuntimeId: { type: ['string', 'null'], maxLength: 255 },
  },
} as const;

export const updateDownloadSourceBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: [...DOWNLOAD_SOURCE_ENUM] },
  },
} as const;

export const updateAutoRestartBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'delaySeconds', 'maxAttempts', 'windowMinutes'],
  properties: {
    enabled: { type: 'boolean' },
    delaySeconds: { type: 'integer', minimum: AUTO_RESTART_LIMITS.delaySeconds.min, maximum: AUTO_RESTART_LIMITS.delaySeconds.max },
    maxAttempts: { type: 'integer', minimum: AUTO_RESTART_LIMITS.maxAttempts.min, maximum: AUTO_RESTART_LIMITS.maxAttempts.max },
    windowMinutes: { type: 'integer', minimum: AUTO_RESTART_LIMITS.windowMinutes.min, maximum: AUTO_RESTART_LIMITS.windowMinutes.max },
  },
} as const;

export const updateSessionDurationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['duration'],
  properties: {
    duration: { type: 'string', enum: [...SESSION_DURATION_ENUM] },
  },
} as const;

export const importExistingServerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'sourceId'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    sourceId: { type: 'string', minLength: 1, maxLength: 255 },
    coreType: { type: 'string', enum: [...CORE_TYPE_ENUM] },
    mcVersion: { type: 'string', maxLength: 64 },
    jvmArgs: { type: 'string', maxLength: 8192 },
    acceptEula: { type: 'boolean' },
    javaRuntimeId: { type: ['string', 'null'], maxLength: 255 },
  },
} as const;

export const confirmZipImportBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    coreType: { type: 'string', enum: [...CORE_TYPE_ENUM] },
    mcVersion: { type: 'string', maxLength: 64 },
    jvmArgs: { type: 'string', maxLength: 8192 },
    acceptEula: { type: 'boolean' },
    javaRuntimeId: { type: ['string', 'null'], maxLength: 255 },
  },
} as const;

/** Start request for a browser folder upload; the server checks the limits again against MAX_EXISTING_IMPORT_*. */
export const createFolderUploadBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['folderName', 'fileCount', 'totalBytes'],
  properties: {
    folderName: { type: 'string', minLength: 1, maxLength: 255 },
    fileCount: { type: 'integer', minimum: 1 },
    totalBytes: { type: 'integer', minimum: 0 },
  },
} as const;

export const setupBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 2, maxLength: 64 },
    password: { type: 'string', minLength: 12, maxLength: 128 },
  },
} as const;

export const loginBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['username', 'password'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** Password length rules are validated by the server; this only blocks oversized input, so users get to see the specific length hint. */
const newPasswordSchema = { type: 'string', maxLength: 1024 } as const;

export const changePasswordBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currentPassword', 'newPassword'],
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
    newPassword: newPasswordSchema,
  },
} as const;

export const resetPasswordBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['password'],
  properties: {
    password: newPasswordSchema,
  },
} as const;

export const createNodeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export const updateNodeBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** Maximum length of a relative path inside an instance (same as the file routes) */
export const maxInstanceRelativePathLength = 1_024;

const textFileConflictPolicies = ['fail', 'overwrite'] as const;

/** PUT /api/instances/:id/files/content request body */
export interface TextFileSaveRequest {
  path: string;
  content: string;
  /** `fail` refuses with 409 when a file or folder already exists at `path`, so creating a file never empties one; defaults to `overwrite`. */
  onConflict?: (typeof textFileConflictPolicies)[number];
}

export function createTextFileSaveSchema(maxTextFileBytes: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', maxLength: maxInstanceRelativePathLength },
      content: { type: 'string', maxLength: maxTextFileBytes },
      onConflict: { type: 'string', enum: textFileConflictPolicies },
    },
  } as const;
}

/** POST /api/instances/:id/files/download-ticket request body */
export const fileDownloadTicketBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', maxLength: maxInstanceRelativePathLength },
  },
} as const;

/** GET /api/instances/:id/files/download query parameters */
export const fileDownloadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', maxLength: maxInstanceRelativePathLength },
    /** One-time download ticket; with a ticket the JWT may be omitted */
    ticket: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** POST /api/instances/:id/backups/:backupId/restore request body */
export const restoreBackupBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    backupCurrent: { type: 'boolean' },
  },
} as const;

/** GET /api/instances/:id/backups/:backupId/download query parameters */
export const backupDownloadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /** One-time download ticket; with a ticket the JWT may be omitted */
    ticket: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** Upper bound for how many scheduled backups one instance keeps. */
export const BACKUP_SCHEDULE_MAX_KEEP = 365;

/** A time of day as HH:MM, 24-hour. */
export const BACKUP_SCHEDULE_TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

/** PUT /api/instances/:id/backup-schedule request body */
export const updateBackupScheduleBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'time', 'keep'],
  properties: {
    enabled: { type: 'boolean' },
    time: { type: 'string', pattern: BACKUP_SCHEDULE_TIME_PATTERN },
    keep: { type: 'integer', minimum: 1, maximum: BACKUP_SCHEDULE_MAX_KEEP },
  },
} as const;

export const FRP_TRANSPORT_ENUM = ['tcp', 'kcp', 'quic', 'websocket', 'wss'] as const;
export const TUNNEL_MODE_ENUM = ['public', 'stcp', 'xtcp'] as const;

const frpNameSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;
const frpHostSchema = { type: 'string', minLength: 1, maxLength: 253 } as const;
const frpPortSchema = { type: 'integer', minimum: 1, maximum: 65535 } as const;
const frpTokenSchema = { type: 'string', minLength: 1, maxLength: 256 } as const;

/** POST /api/frp/endpoints */
export const createFrpEndpointBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'serverAddr', 'serverPort', 'transport', 'token'],
  properties: {
    name: frpNameSchema,
    serverAddr: frpHostSchema,
    serverPort: frpPortSchema,
    visitHost: { type: 'string', maxLength: 253 },
    transport: { type: 'string', enum: FRP_TRANSPORT_ENUM },
    tls: { type: 'boolean' },
    token: frpTokenSchema,
  },
} as const;

/** PATCH /api/frp/endpoints/:id. An omitted or empty-string token means the token is unchanged. */
export const updateFrpEndpointBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: frpNameSchema,
    serverAddr: frpHostSchema,
    serverPort: frpPortSchema,
    visitHost: { type: 'string', maxLength: 253 },
    transport: { type: 'string', enum: FRP_TRANSPORT_ENUM },
    tls: { type: 'boolean' },
    token: { type: 'string', maxLength: 256 },
  },
} as const;

/** PUT /api/instances/:id/tunnel */
export const updateInstanceTunnelBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'endpointId', 'mode'],
  properties: {
    enabled: { type: 'boolean' },
    endpointId: { type: 'string', minLength: 1, maxLength: 64 },
    mode: { type: 'string', enum: TUNNEL_MODE_ENUM },
    remotePort: frpPortSchema,
    visitorBindPort: frpPortSchema,
  },
} as const;

/** PUT /api/instances/:id/lan */
export const updateInstanceLanBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    // Same as LAN_CUSTOM_PEER_LIMIT; the exact format is validated per item by the server.
    peers: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
    useSharedPeers: { type: 'boolean' },
  },
} as const;

/** Interface names are limited in length only, not in characters: on Chinese Windows, interfaces are named "以太网" or "本地连接* 1". Whether one exists is decided by the server from the enumeration result. */
const interfaceNameSchema = { type: ['string', 'null'], minLength: 1, maxLength: 255 } as const;

/** PUT /api/system/remote-access/direct, PUT /api/system/remote-access/overlay and PUT /api/launcher/remote-access/direct */
export const updateAccessModeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled', 'interfaceName', 'restrictToSubnet', 'https'],
  properties: {
    enabled: { type: 'boolean' },
    interfaceName: interfaceNameSchema,
    restrictToSubnet: { type: 'boolean' },
    https: { type: 'boolean' },
  },
} as const;

/** PUT /api/system/remote-access/panel-network */
export const updatePanelNetworkBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['enabled'],
  properties: {
    enabled: { type: 'boolean' },
    useSharedPeers: { type: 'boolean' },
    // Same as LAN_CUSTOM_PEER_LIMIT; the exact format is validated per item by the server.
    customPeers: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
} as const;

/** PUT /api/system/public-host; the exact format is validated by the server, this only blocks oversized input. */
export const updatePublicHostBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['host'],
  properties: {
    host: { type: ['string', 'null'], maxLength: 300 },
  },
} as const;
