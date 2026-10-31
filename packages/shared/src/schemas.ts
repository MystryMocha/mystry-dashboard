/** Fastify AJV 使用的请求 JSON Schema；字段改动时同步 index.ts 中对应的类型。 */

/** 核心类型枚举（含 custom） */
export const CORE_TYPE_ENUM = [
  'vanilla',
  'paper',
  'fabric',
  'forge',
  'neoforge',
  'custom',
] as const;

/** 可一键部署的核心类型（不含 custom） */
export const DEPLOYABLE_CORE_TYPE_ENUM = [
  'vanilla',
  'paper',
  'fabric',
  'forge',
  'neoforge',
] as const;

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

/** 实例内相对路径最大长度（与 file 路由一致） */
const maxInstanceRelativePathLength = 1024;

/** POST /api/instances/:id/files/download-ticket 请求体 */
export const fileDownloadTicketBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', maxLength: maxInstanceRelativePathLength },
  },
} as const;

/** GET /api/instances/:id/files/download 查询参数 */
export const fileDownloadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', maxLength: maxInstanceRelativePathLength },
    /** 一次性下载 ticket；有 ticket 时可不带 JWT */
    ticket: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

/** POST /api/instances/:id/backups/:backupId/restore 请求体 */
export const restoreBackupBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    backupCurrent: { type: 'boolean' },
  },
} as const;

/** GET /api/instances/:id/backups/:backupId/download 查询参数 */
export const backupDownloadQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /** 一次性下载 ticket；有 ticket 时可不带 JWT */
    ticket: { type: 'string', minLength: 1, maxLength: 128 },
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

/** PATCH /api/frp/endpoints/:id。token 省略或空字符串表示不改令牌。 */
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
  },
} as const;
