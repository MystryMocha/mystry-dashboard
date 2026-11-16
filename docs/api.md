# API 参考

除下列公开接口外，其余 `/api/*` 路由均需 JWT：

```http
Authorization: Bearer <token>
```

带请求体的接口使用 JSON，请求头为 `Content-Type: application/json`；启动、停止这类没有请求体的 POST 不要带 `Content-Type`，或者发送 `{}`。其他 `Content-Type` 会返回 **415**。

错误响应为 JSON：

```json
{ "error": "Instance not found.", "code": "server.instance.notFound", "params": { "id": "abc" } }
```

- `error`：渲染好的**英文**说明，脚本和旧客户端可直接显示。
- `code` / `params`：面板自身产生的错误带有稳定的消息键与参数（键以 `server.` 开头，定义在 `packages/shared/src/messages/`）。Web 界面按当前语言（English / 简体中文 / 繁體中文）用同一个键翻译，缺键时显示 `error`。参数值可以是文本、数字，或另一条 `{ key, params }` 消息（例如失败原因）。
- Node.js 系统错误、Java 或网络库返回的原始文本没有 `code`，`error` 原样返回。
- 实例启停、删除、接管冲突（409）的 `code` 也是消息键（如 `server.instance.alreadyRunning`），不再是 `INSTANCE_OPERATION_CONFLICT`。
- 请求体校验失败（Fastify / AJV）返回 400，`code` 为 `server.common.invalidRequest`，`params.detail` 为英文校验说明。

## 总览性能监测

`GET /api/system/metrics` 需要 JWT，返回共享类型 `DashboardMetrics`：

- `sampledAt`：采样时间；`cpuPercent`：整机 CPU 使用率，首次采样为 `null`。
- `memory`：主机 `usedBytes` / `totalBytes`；`disk`：数据根所在磁盘的 `availableBytes` / `totalBytes`，读取失败为 `null`。
- `instances`：以实例 ID 为键，包含 `cpuPercent`、`memoryBytes` 与 `state`（`ready` / `collecting` / `unavailable`）。仅采集面板持有的活进程，调用方不能指定 PID 或路径。
- `warnings`：CPU 或内存连续采样至少 30 秒达到 90% 时提示；磁盘可用空间低于 5 GiB 或 10% 时提示。文本为英文，`warningsI18n` 按相同顺序给出对应的消息键，供界面翻译。

CPU 按整机逻辑核总容量归一至 0–100%；进程内存是驻留内存，与 JVM 堆内存上限 Xmx 不同。进程指标目前只支持 Windows 和 Linux，其他平台为 `unavailable`。空值不表示零占用。快照缓存 4 秒，并发请求合并；无历史存储，页面每 5 秒刷新、隐藏时暂停。采样间隔超过 15 秒会重新累计持续告警时间。

## 健康检查

| 方法 | 路径 | 认证 | 响应 |
|------|------|------|------|
| GET | `/api/health` | 否 | `{ ok: true, service: "mystry-dashboard", processFingerprint?: string }` |

`processFingerprint` 仅在便携控制器启动服务时出现。它用于让 `mystryctl` 将状态文件、PID 与实际监听服务对应起来，不是认证密钥，也不能替代 `X-Launcher-Token`。

## 认证 `/api/auth`

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/auth/status` | 否 | `{ needsSetup: boolean }` |
| POST | `/api/auth/setup` | `X-Setup-Token` | 仅用户表为空时可用；Body：`{ username, password }` → `{ token, user }` |
| POST | `/api/auth/login` | 否 | Body：`{ username, password }` → `{ token, user }` 或 401 |
| POST | `/api/auth/password` | JWT | Body：`{ currentPassword, newPassword }` → `{ ok: true }`；当前密码错误返回 400。已签发的 JWT 不会失效，到期前仍可使用 |
| GET | `/api/auth/me` | 是 | `{ user }` |

### setup 请求

`setup` 不使用 JWT，而是要求环境变量 `SETUP_TOKEN` 的值放在 header 中：

```http
POST /api/auth/setup
Content-Type: application/json
X-Setup-Token: <SETUP_TOKEN>

{"username":"admin","password":"至少 12 位的强密码"}
```

用户创建成功后 setup 接口不再可用。`mystryctl` 和 `PanelManager` 会用这个接口自动创建 `admin`，并在成功后移除 `SETUP_TOKEN`。密钥格式要求见 [配置说明](configuration.md#首次启动必需配置)。

## 系统 `/api/system`

| 方法 | 路径 | 认证 | 响应 |
|------|------|------|------|
| GET | `/api/system/java` | 是 | Java 状态对象 |
| GET | `/api/system/java-runtimes` | 是 | `{ runtimes: JavaRuntimeInfo[] }` |
| GET | `/api/system/download-source` | 是 | `{ source: 'official' \| 'china' }` |
| PUT | `/api/system/download-source` | 是 | 请求体 `{ source }`，返回保存后的值；其他取值返回 400 |

下载来源默认 `official`，保存在 `panel.db`，保存后新发起的下载立即使用，不需要重启。各类文件实际走哪里见[架构说明](architecture.md#下载来源)。

Java 状态响应准确结构为：

```json
{
  "available": true,
  "version": "21.0.3",
  "majorVersion": 21
}
```

找不到 Java 时返回 `{ "available": false, "version": null, "majorVersion": null }`。面板不提供全盘目录浏览接口。

`/api/system/java-runtimes` 返回面板探测并验证过的 Java 运行时注册表；带 `?refresh=1` 请求重新扫描。并发扫描会合并为一个任务，连续强制刷新受 30 秒冷却限制；普通读取默认使用 60 秒缓存。候选路径只来自 `JAVA_HOME` 和常见安装目录扫描，且必须文件名为 `java`/`java.exe`、`-version` 输出可解析出版本号才会入表。实例可通过 `javaRuntimeId` 绑定表内条目（创建、更新、部署请求均接受该可选字段；`null` 表示使用 PATH 中的 `java`），请求不能提交任意可执行路径。绑定运行时在启动或 Forge/NeoForge Installer 执行前会再次验证；最近一次扫描未发现的条目会以 `available: false` 返回。

`JavaRuntimeInfo` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 运行时注册表 ID；请求仅可提交该值 |
| `path` | string | 面板扫描到的绝对 Java 可执行路径，仅对已认证用户返回 |
| `version` / `majorVersion` | string / number | 最近一次验证的完整版本与主版本号 |
| `source` | `env \| scan` | `JAVA_HOME` 或常见安装目录扫描 |
| `verifiedAt` | string | 最近一次成功验证时间 |
| `available` | boolean | 最近一次完整扫描是否仍发现并验证此条目 |

## 实例 `/api/instances`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/instances` | 实例列表 `InstanceInfo[]` |
| GET | `/api/instances/:id` | 单个实例 |
| POST | `/api/instances` | 创建空实例，Body 见 `CreateInstanceInput` |
| PATCH | `/api/instances/:id` | 更新 `UpdateInstanceInput` |
| POST | `/api/instances/:id/adopt-managed-directory` | 接管已复制到面板托管根目录的旧实例 |
| DELETE | `/api/instances/:id` | 删除实例记录及面板托管的实例目录；旧版外部目录不会被访问或删除。默认同时删除该实例在 `BACKUP_DIR` 下的备份，`?keepBackups=1` 时保留（之后不再出现在面板中）；实例已删除但备份删除失败时返回 **500** |
| POST | `/api/instances/:id/start` | 启动 |
| POST | `/api/instances/:id/stop` | 停止；`?force=1` 强杀。普通停止超时仍在停止中时返回 **202** `{ code: "INSTANCE_STOP_PENDING", error, errorI18n }` |
| POST | `/api/instances/:id/restart` | 重启 |
| POST | `/api/instances/:id/command` | Body：`{ command: string }`，发送控制台命令 |
| GET | `/api/instances/:id/local-network` | 同一网络直连用的地址 `InstanceLocalNetwork`：`{ port, addresses, publicIpv6, serverIpBlocked }`。只读，不开端口也不改配置 |

`InstanceInfo.startIssue` 在最近一次启动没成功且原因可识别时给出 `{ kind, requiredJava }`，否则为 `null`：`kind` 为 `eula`（尚未同意 Minecraft EULA）、`java-too-new` 或 `java-too-old`（所用 Java 过新或过旧，`requiredJava` 是需要的主版本，无法判断时为 `null`）。它由面板从该次进程的控制台输出里按固定句式识别，只存在内存里；再次启动、删除实例或面板重启后清空。服务端打印过 `Done (` 之后的退出不归因于 Java 版本。进程自己以退出码 0 结束（未同意 EULA、游戏内执行 `stop`）时状态为 `stopped`，非 0 才是 `crashed`。

`local-network` 的 `addresses` 是这台电脑的局域网 IPv4 地址（不含回环、`169.254.*` 和能认出的虚拟网卡，如 WSL、虚拟机、组网或代理软件的网卡；全是虚拟网卡时照常列出。最多 6 个，`192.168.*` 排在前面），`port` 取自 `server.properties` 的 `server-port`，无效时为 `null`。`server-ip` 留空或为 `0.0.0.0` 时返回全部地址；等于其中一个地址时只返回它；其余情况 `serverIpBlocked` 为 `true` 且 `addresses` 为空。`publicIpv6` 是实体网卡上的公网 IPv6 地址（`2000::/3`，不含 6to4、Teredo 和文档示例段，最多 3 个），只在 `server-ip` 留空、为 `*` 或 `::` 时给出，`0.0.0.0` 或具体地址时为空；面板不区分固定地址和系统的临时地址，也不检测路由器是否放行。

实例目录固定为最终数据根目录的 `instances/<id>`。最终数据根优先取 `MYSTRY_DATA_DIR`，否则取 `DATA_DIR`；创建、部署、导入和启动都不会接受另一个实例目录，`jarFile` 也只能表示实例根目录内的相对文件。

### 接管旧版实例

面板不会访问或删除旧版记录指向的外部目录，也不会自动搬迁。调用接管接口前，必须：

1. 停止实例和面板服务。
2. 使用操作系统工具将旧外部目录完整复制到 `DATA_DIR/instances/<id>`。
3. 启动面板，并以 JWT 调用：

```http
POST /api/instances/<id>/adopt-managed-directory
Authorization: Bearer <token>
```

接管成功后返回更新后的 `InstanceInfo`。实例正在运行、目标目录为空或目录不属于该实例时，接口会返回错误。接管或删除面板实例都不会触碰旧外部目录。

### `InstanceInfo` 字段摘要

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实例 ID |
| `name` | string | 显示名称 |
| `coreType` | `vanilla \| paper \| fabric \| forge \| neoforge \| custom` | 核心类型 |
| `mcVersion` | string \| null | MC 版本 |
| `jarFile` | string | 相对实例根目录的 jar 名或启动参数文件 |
| `jvmArgs` | string | JVM 参数字符串 |
| `requiresMigration` | boolean | 是否需要按旧版外部实例流程完成接管 |
| `nodeId` | string | 执行节点 ID；本机为 `local` |
| `javaRuntimeId` | string \| null | 绑定的 Java 运行时 ID；`null` 使用 PATH 中的 `java` |
| `status` | `InstanceStatus` | 运行状态 |
| `acceptEula` | boolean | 是否写入 `eula=true` |
| `createdAt` / `updatedAt` | string | ISO 时间 |

`jvmArgs` 保存与启动前都会经过 `@mystry/shared` 的同一套校验：必须各有一个 `Xms` / `Xmx`，拒绝未闭合引号、重复或冲突 GC、`Xms > Xmx`，也拒绝 `-jar`、classpath、模块启动、`@argfile` 和 `nogui` 等由面板负责的启动参数。请求省略 `jvmArgs` 时，创建、部署和导入仍使用兼容默认值 `-Xms1G -Xmx2G`。旧实例文本不会仅因读取而被改写，但非法旧值必须先修正才能保存或启动。

## 文件与配置 `/api/instances/:id`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/files?path=` | 列出实例根目录内的目录 `FileEntry[]`；实例根目录的面板所有权标记 `.mystry-instance.json` 不出现在列表中 |
| GET | `/files/content?path=` | 读文本 `{ path, content }` |
| PUT | `/files/content` | Body：`{ path, content }` |
| DELETE | `/files?path=` | 删除实例根目录内的文件或目录 |
| POST | `/files/mkdir` | Body：`{ path }` |
| POST | `/files/rename` | Body：`{ from, to }` |
| GET | `/files/download?path=` | 二进制流；可选 `ticket=` 一次性下载票据；响应含 `Content-Disposition: attachment` |
| POST | `/files/download-ticket` | Body：`{ path }`；签发并预占下载槽位 |
| GET | `/files/download-ticket/:ticket/status` | 查询所属下载票据的生命周期状态 |
| DELETE | `/files/download-ticket/:ticket` | 取消尚未开流的所属下载票据 |
| POST | `/files/upload?path=` | multipart 单文件 |
| GET | `/config/server.properties` | 键值对象；`difficulty`、`gamemode` 的数字写法转成名称（如 `1` → `easy`） |
| PUT | `/config/server.properties` | Body：`Record<string, string>`。`difficulty`、`gamemode` 提交名称；文件原来是数字或实例版本为 1.13 及更早时写回数字。非 ASCII 字符写成 `\uXXXX` |

所有 `path` 均为**相对于 `DATA_DIR/instances/<id>` 的逻辑路径**，服务端会校验并拒绝 `..` 逃逸；这些接口不能访问实例根目录以外的文件。下载仅允许普通文件；`Content-Disposition` 仅使用 basename（含 RFC 5987 `filename*`）。无 ticket 的下载使用 Bearer JWT；浏览器原生下载可先使用 Bearer JWT 调用 `POST .../download-ticket`，再以 `GET .../download?path=&ticket=` 触发流式下载（该 GET 不带 Authorization header）。

下载 ticket 的签发有效期由 `FILE_DOWNLOAD_TICKET_TTL_SECONDS` 控制，默认 60 秒。签发时状态为 `reserved` 并预占下载并发槽；原生 GET 校验 `instance` 与 `path` 后原子转为 `streaming`，签发有效期不会回收已开流的槽位。状态查询返回 `reserved`、`streaming`、`consumed`、`failed` 或 `expired`：成功传输为 `consumed`，读流错误、连接中止、下载空闲超时及取消为 `failed`，未开流而签发期到期为 `expired`。`expired`、`consumed` 和 `failed` 都按所属用户保留 60 秒短时 tombstone，供状态查询返回终态；超过该期限或无权查询时返回 404。

已认证的 `DELETE .../download-ticket/:ticket` 仅在 ticket、当前用户和 URL 中的实例 ID 三者都匹配，且 ticket 仍为 `reserved` 时取消并立即释放预占槽位，返回 **204**。已进入 `streaming` 时不改变流或槽位，返回 **409**；票据不存在、所属用户或实例不匹配时统一返回 **404**。

上传文件超过 `MAX_UPLOAD_BYTES` 时返回 **413**；上传或下载的并发容量已满时返回 **429**。相关超时见 [配置说明](configuration.md)。

## 实例备份 `/api/instances/:id/backups`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/backups` | `{ backups: BackupInfo[] }`，按创建时间从新到旧 |
| POST | `/backups` | 一键备份，返回 `TaskInfo`（`type: 'backup'`），完成后 `result.backupId` 为新备份 |
| POST | `/backups/upload` | multipart 单文件；完整校验通过后返回 `BackupInfo`（`source: 'upload'`） |
| POST | `/backups/:backupId/restore` | Body：`{ backupCurrent: boolean }`；返回 `TaskInfo`（`type: 'restore'`），完成后 `result.instanceRecordUpdated` 表示是否按备份更新了实例的启动文件、核心类型与版本 |
| DELETE | `/backups/:backupId` | 删除备份，返回 **204** |
| POST | `/backups/:backupId/download-ticket` | 签发一次性下载票据并预占下载槽位 |
| GET | `/backups/:backupId/download?ticket=` | 流式下载 `.tar.gz`；也可不带 `ticket` 改用 Bearer JWT |

备份文件是 gzip 压缩的 tar，最后一个条目 `.mystry-backup/manifest.json` 记录每个文件的大小与 SHA-256。备份范围是实例目录 `DATA_DIR/instances/<id>` 下的全部文件，不含面板的归属标记和运行时被 JVM 锁住的 `session.lock`（启动时自动重建），也不含 `panel.db`（用户、实例设置不在备份里）。目录中有符号链接或目录联接时拒绝备份。

- **运行中备份**：先发 `save-off` 和 `save-all flush`，等服务端自己打印 `Saved the game`（1.12 及更早为 `Saved the world`，只认日志前缀后的整条消息，玩家聊天不算；最多 60 秒），打包完成后发 `save-on`。期间服务器启停或崩溃会取消备份；启动中、停止中的实例返回 **409**。
- **还原**：服务器必须已停止，否则 **409**。`backupCurrent` 为 `true`（界面默认）时先生成一份 `source: 'pre-restore'` 的备份。备份先完整校验并解压到 `DATA_DIR/.mystry-staging/<taskId>/`，全部通过后才整体替换实例目录；替换中途失败会把原目录移回。面板在替换中途退出时，下次启动会自动回滚或收尾。替换成功后，若清单里记录的启动文件（jar 或 Forge `@args:` 参数文件）在还原后的目录中存在，实例的 `jarFile`、`coreType`、`mcVersion` 会改为清单中的值。
- **校验**：拒绝绝对路径、`..`、链接和特殊文件、重复路径、面板保留文件、清单之外的文件和校验值不一致的文件；条目数与总大小沿用 `MAX_EXISTING_IMPORT_ENTRIES` / `MAX_EXISTING_IMPORT_BYTES`。
- **互斥**：备份或还原期间拒绝启动、重启、删除和接管该实例（**409**）；还原期间还拒绝写入、删除、改名和上传实例文件（上传在接收完、写入实例目录前会再检查一次）。正在被还原任务使用的备份不能删除（**409**）。
- 备份与还原任务的运行时限为 `BACKUP_TASK_TIMEOUT_MS`（默认 6 小时），不受 `TASK_TIMEOUT_MS` 限制。
- 上传超过 `MAX_BACKUP_UPLOAD_BYTES` 返回 **413**。下载票据的状态查询与取消沿用 `/files/download-ticket/:ticket/status` 和 `DELETE /files/download-ticket/:ticket`。

`BackupInfo` 字段：`id`、`instanceId`、`instanceName`、`source`（`manual` / `pre-restore` / `upload`）、`createdAt`、`sizeBytes`（压缩包大小）、`fileCount`、`contentBytes`（解压后大小）、`coreType`、`mcVersion`、`wasRunning`、`sha256`（压缩包的 SHA-256）。

## 核心部署与导入

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cores/:type/versions` | `type`: `vanilla \| paper \| fabric \| forge \| neoforge` |
| GET | `/api/cores/paper/:version/builds` | Paper build 列表 |
| GET | `/api/cores/fabric/:version/loaders` | Fabric loaders + installers |
| GET | `/api/cores/forge/:version/loaders` | Forge loader 列表 |
| GET | `/api/cores/neoforge/:version/loaders` | NeoForge loader 列表，新构建在前。`:version` 是 Minecraft 版本号，如 `1.21.1`、`26.3` |
| POST | `/api/cores/deploy` | Body：`DeployCoreInput`，返回 `TaskInfo` |
| GET | `/api/import/sources` | 列出 `DATA_DIR/imports` 的直接子目录及启动文件探测结果 |
| POST | `/api/import/existing` | Body：`ImportExistingServerInput`，复制交接目录并返回 `TaskInfo` |
| POST | `/api/import/previews` | multipart 上传单个 ZIP，验证中央目录并返回 `ImportPreviewInfo` |
| GET | `/api/import/previews/:id` | 恢复当前登录用户的待确认预览 |
| POST | `/api/import/previews/:id/confirm` | Body：`ConfirmZipImportInput`，确认配置并返回 `TaskInfo` |
| DELETE | `/api/import/previews/:id` | 取消预览并删除临时 ZIP |
| GET | `/api/tasks/:id` | 查询任务进度 `TaskInfo` |
| GET | `/api/tasks` | 任务中心列表，按创建时间倒序返回最近 50 条 `{ tasks: TaskInfo[] }` |

部署和导入始终把内容写入新实例的 `DATA_DIR/instances/<id>`，不接收自定义目录或 Java 可执行文件路径。实例默认使用 PATH 中的 `java` 启动，可通过 `javaRuntimeId` 绑定注册表中当前可用的运行时；部署请求中的绑定同样用于 Forge/NeoForge Installer。Paper 的 `build`、Fabric / Forge / NeoForge 的 `loaderVersion` 等版本字段留空时取最新稳定版；填写了但不存在时任务失败，不会改用其他版本。

### 同机已有服务端交接

`GET /api/import/sources` 返回：

```json
{
  "sources": [
    {
      "id": "paper-survival",
      "launchTarget": "paper.jar",
      "coreType": "paper",
      "modifiedAt": "2026-08-02T10:00:00.000Z",
      "ready": true,
      "detectedJvmConfig": {
        "source": "user_jvm_args.txt",
        "raw": "-Xms1G\n-Xmx4G\n",
        "canonicalArgs": "-Xms1G -Xmx4G",
        "issues": []
      }
    }
  ]
}
```

`id` 只是 `DATA_DIR/imports` 下的单层目录名，不是系统路径。创建任务示例：

```json
{
  "name": "生存服",
  "sourceId": "paper-survival",
  "coreType": "paper",
  "mcVersion": "1.20.1",
  "jvmArgs": "-Xms2G -Xmx4G",
  "acceptEula": true,
  "javaRuntimeId": null
}
```

提交前应停止原服务器。复制前的检查与限制见 [从本机文件夹导入](user-guide.md#从本机文件夹导入)。成功或失败都不会删除源目录；失败时会清理新建的半成品实例。

目录根部存在普通 `user_jvm_args.txt` 时，来源信息可包含 `detectedJvmConfig`。文件最大 64 KiB；不读取子目录文件，不跟随链接，也不解析或执行 `.bat` / `.sh`。检测到参数后，Web 要求用户明确选择沿用、面板推荐或自定义；解析失败时 `canonicalArgs` 为 `null`，不能沿用。`issues[]` 每项含稳定的 `code`、`severity` 和英文 `message`；共享 JVM 校验产生的诊断另带 `key`（`server.jvm.issue.*`）与 `params` 供界面翻译。

### ZIP 二阶段导入

第一步仅上传文件：

```http
POST /api/import/previews
Content-Type: multipart/form-data

file=<server.zip>
```

服务端流式写入受控临时目录，验证 ZIP 中央目录、条目配额、ZIP64、链接/特殊文件和重复条目；只额外解压根目录或单一顶层目录中的 `user_jvm_args.txt`，且最多 64 KiB。成功响应：

```json
{
  "id": "不可猜测的随机预览 ID",
  "fileName": "server.zip",
  "sizeBytes": 10485760,
  "expiresAt": "2026-08-11T12:30:00.000Z",
  "detectedJvmConfig": {
    "source": "user_jvm_args.txt",
    "raw": "-Xms1G\n-Xmx4G\n",
    "canonicalArgs": "-Xms1G -Xmx4G",
    "issues": []
  }
}
```

第二步确认配置：

```json
{
  "name": "生存服",
  "coreType": "paper",
  "mcVersion": "1.21.1",
  "jvmArgs": "-Xms4G -Xmx4G -XX:+UseG1GC",
  "acceptEula": true,
  "javaRuntimeId": null
}
```

预览 ID 绑定登录用户：非所有者和不存在的 ID 返回 **404**，过期返回 **410**，正在确认或重复确认返回 **409**。每个用户最多一个预览，全局容量由 `MAX_IMPORT_PREVIEWS` 控制；新 ZIP 预检成功后才替换旧预览。只有后台任务成功入队才消费预览，任务队列满返回 **429** 且保留预览供重试。预览默认由 `IMPORT_PREVIEW_TTL_SECONDS=1800` 控制，取消、过期、面板关闭或重启都会删除临时 ZIP，不写入数据库也不跨重启恢复。

ZIP 导入只能走上面的预览流程；旧的一阶段 `POST /api/import` 已删除，调用会返回 **404**。

ZIP 中的普通文件只支持存储和 Deflate 两种压缩方式；其他方式会使导入任务失败，并清理半成品实例。

### `TaskInfo` 状态

| status | 含义 |
|--------|------|
| `pending` | 排队 |
| `running` | 执行中 |
| `completed` | 成功，`result` 可能含 `instanceId` |
| `failed` | 失败，`error` 为原因 |

`message` 与 `error` 是英文文本；同时返回的 `messageI18n` / `errorI18n`（`{ key, params }`）供界面按语言翻译。升级前创建的任务没有这两个字段，`message` / `error` 可能是中文原文，按原样显示即可。数据库为此在 `tasks` 表新增可空列 `message_i18n`、`error_i18n`（启动时自动补列，无需手动迁移）。

部署或导入提交成功后，即使暂时没有执行槽位，也会先返回 `pending` 任务；队列已满时返回 **429**。调用方应继续查询 `/api/tasks/:id`，直到 `completed` 或 `failed`；任务开始执行后超过 `TASK_TIMEOUT_MS` 会失败。排队不是失败，不要重复提交。

## 控制台 WebSocket

先用 JWT 调用 `POST /api/instances/:id/console-ticket` 获取一次性 ticket：

```http
POST /api/instances/<id>/console-ticket
Authorization: Bearer <token>
```

然后连接：`ws://<host>:<port>/ws/console/:instanceId?ticket=<ticket>`。ticket 默认 60 秒有效且只能建立一次连接。

连接数、入站消息大小、命令长度和发送速率的上限见 [配置说明](configuration.md) 中 `MAX_CONSOLE_*` 等变量；超过限制时服务端不会向实例 stdin 写入。

### 服务端 → 客户端消息（JSON）

| type | 字段 | 说明 |
|------|------|------|
| `history` | `data`, `status?` | 连接时历史输出 |
| `output` | `data` | 新日志片段 |
| `status` | `status` | 状态变更 |
| `error` | `data`, `code?`, `params?` | 错误说明：`data` 为英文文本，`code` / `params` 为可翻译的消息键与参数 |

### 客户端 → 服务端

```json
{ "type": "command", "data": "say hello" }
```

## PanelManager 本机关闭

`POST /api/launcher/shutdown` 只供仓库根目录的 PanelManager 调用，不使用登录 JWT。请求必须来自回环地址并携带：

```http
X-Launcher-Token: <LAUNCHER_TOKEN>
```

有效请求返回 **202**，响应包含 `accepted`、运行实例数、运行/排队任务数和是否已经处于关闭过程。令牌无效返回 401，非本机来源返回 403，当前启动方式未提供安全关闭回调时返回 503。该接口使用独立限流，并在响应发送完成后开始停止任务、Minecraft 实例、HTTP 服务和数据库。

## 联机穿透 `/api/frp`

面板只代管钉死版本的官方 `frpc`（`FRP_CLIENT_VERSION`）。用户提供自己的 frp 服务器地址、端口和令牌；请求不能提交可执行路径或原始配置。令牌只写不回读，响应里只有 `tokenSet`。本地转发固定到 `127.0.0.1` 上的实例 `server-port`，不会开放面板端口。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/frp/runtime` | `{ version, installed, platformSupported }` |
| POST | `/api/frp/runtime` | 下载并校验钉死的官方客户端；已安装则直接返回 |
| GET | `/api/frp/endpoints` | 穿透服务器列表。不含令牌 |
| POST | `/api/frp/endpoints` | 创建。Body 见 `createFrpEndpointBodySchema` |
| PATCH | `/api/frp/endpoints/:id` | 更新。省略 `token` 或空字符串表示不改令牌。成功后会按新配置重新同步已启用的隧道 |
| DELETE | `/api/frp/endpoints/:id` | 删除。仍有实例启用着使用它的联机时 **409**；已关闭的隧道设置会随端点一起清除 |
| GET | `/api/instances/:id/tunnel` | 该实例的联机状态 `InstanceTunnel` |
| PUT | `/api/instances/:id/tunnel` | 保存并按当前实例状态启动或停止 `frpc` |
| GET | `/api/instances/:id/tunnel/friend-config` | 内网模式的朋友配置 `friend-frpc.toml`。文件含令牌，只应交给要一起玩的人 |

`mode` 为 `public` 时朋友直接连接公网端口，必须提供 `remotePort`。`stcp` 经穿透服务器中转，`xtcp` 在双方客户端之间打洞；这两种模式由朋友在自己的电脑上运行官方 `frpc` 和下载的配置，再连接本机 `127.0.0.1`。`server-ip` 若指向某一块网卡，隧道不会启动。实例停止、崩溃或面板关闭时，对应的 `frpc` 会退出。面板重启后不会恢复已经消失的游戏进程，需要重新启动实例。

## 虚拟局域网 `/api/lan`

面板只代管钉死版本的官方 EasyTier（`EASYTIER_VERSION`）。打开后，这个实例加入一个只属于它的虚拟局域网，朋友用面板给出的一条锁定命令加入。请求不能提交可执行路径、原始配置或网络密钥；密钥由面板生成，只出现在给朋友的说明里，不出现在状态接口里。本地只放行实例的 `server-port`，不开放面板端口，也不转发语音和查询用的 UDP。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lan/runtime` | `{ version, installed, platformSupported }` |
| POST | `/api/lan/runtime` | 下载并校验钉死的官方客户端；已安装则直接返回 |
| GET | `/api/instances/:id/lan` | 该实例的虚拟局域网状态 `InstanceLan`。不含网络密钥 |
| PUT | `/api/instances/:id/lan` | 保存开关。Body 只有 `{ enabled }` |
| GET | `/api/instances/:id/lan/friend` | 给朋友的说明。含网络密钥，只应交给要一起玩的人 |

游戏没在运行时客户端不会启动，但已保存的开关和将要使用的虚拟地址仍会返回。`server-ip` 若指向某一块网卡，虚拟局域网不会启动。实例停止、崩溃或面板关闭时，对应的 EasyTier 会退出。Windows 上面板和朋友的命令都需要管理员权限，否则创建不了虚拟网卡。

## 节点 `/api/nodes`

阶段一仅保证本机节点 `local` 可用。远程节点创建由共享常量 `REMOTE_NODE_CREATION_ENABLED` 控制，当前为关闭。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/nodes` | 节点列表 `NodeInfo[]` |
| GET | `/api/nodes/:id` | 单个节点 |
| POST | `/api/nodes` | 创建远程节点（当前返回 **403**） |
| PATCH | `/api/nodes/:id` | 重命名 |
| DELETE | `/api/nodes/:id` | 删除远程节点（本机不可删；有实例时拒绝） |
| POST | `/api/nodes/:id/secret/reset` | 重置密钥（当前返回 **403**） |

创建实例时若传入非本机 `nodeId`，服务端会拒绝（远程执行尚未开放）。

## 类型定义

完整 TypeScript 定义与请求体 JSON Schema 见 `packages/shared/src/index.ts` / `packages/shared/src/schemas.ts`。
