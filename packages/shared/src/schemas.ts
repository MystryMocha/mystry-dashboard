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

/** 面板下载来源：official 只用官方服务器，china 优先用国内镜像，失败后回到官方。 */
export const DOWNLOAD_SOURCE_ENUM = ['official', 'china'] as const;

/** 可一键部署的核心类型（不含 custom） */
export const DEPLOYABLE_CORE_TYPE_ENUM = [
  'vanilla',
  'paper',
  'fabric',
  'forge',
  'neoforge',
] as const;

/** 面板能自动安装的 Java 主版本（Eclipse Temurin JRE，具体版本和 SHA-256 钉死在服务端）。 */
export const JAVA_INSTALL_MAJORS = [8, 17, 21, 25] as const;

/** POST /api/system/java-runtimes/install：只接受面板钉死了安装包的主版本。 */
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

/** 密码长度规则由服务端校验，这里只挡超长输入，用户才能看到具体的长度提示。 */
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
    // 与 LAN_CUSTOM_PEER_LIMIT 一致；具体格式由服务端逐条校验。
    peers: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
    useSharedPeers: { type: 'boolean' },
  },
} as const;

/** 网卡名只限长度，不限字符：中文 Windows 的网卡叫「以太网」「本地连接* 1」。是否存在由服务端按枚举结果判断。 */
const interfaceNameSchema = { type: ['string', 'null'], minLength: 1, maxLength: 255 } as const;

/** PUT /api/system/remote-access/direct、PUT /api/system/remote-access/overlay 与启动器同名接口 */
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
    // 与 LAN_CUSTOM_PEER_LIMIT 一致；具体格式由服务端逐条校验。
    customPeers: {
      type: 'array',
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
  },
} as const;

/** PUT /api/system/public-host；具体格式由服务端校验，这里只挡超长输入。 */
export const updatePublicHostBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['host'],
  properties: {
    host: { type: ['string', 'null'], maxLength: 300 },
  },
} as const;