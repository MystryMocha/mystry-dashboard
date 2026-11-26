# API 参考

[English](api.md) · **简体中文**

除下列公开接口外，其余 `/api/*` 路由均需 JWT：

```http
Authorization: Bearer <token>
```

带请求体的接口使用 JSON，请求头为 `Content-Type: application/json`；启动、停止等无请求体的 POST 不应带 `Content-Type`，或发送 `{}`。其他 `Content-Type` 返回 **415**。

错误响应为 JSON：

```json
{ "error": "Instance not found.", "code": "server.instance.notFound", "params": { "id": "abc" } }
```

- `error`：已渲染的**英文**说明，脚本与旧客户端可直接显示。
- `code` / `params`：面板自身产生的错误带有稳定的消息键与参数（键以 `server.` 开头，定义于 `packages/shared/src/messages/`）。Web 界面按当前语言（English / 简体中文 / 繁體中文）以同一键翻译，缺键时显示 `error`。参数值可为文本、数字，或另一条 `{ key, params }` 消息（如失败原因）。
- 来自 Node.js 系统错误、Java 或网络库的原始文本不带 `code`，`error` 原样返回。
- 实例启停、删除与接管冲突（409）的 `code` 同样是消息键（如 `server.instance.alreadyRunning`），不再是 `INSTANCE_OPERATION_CONFLICT`。
- 请求体校验失败（Fastify / AJV）返回 400，`code` 为 `server.common.invalidRequest`，`params.detail` 为英文校验说明。

## 总览性能监测

`GET /api/system/metrics` 需 JWT，返回共享类型 `DashboardMetrics`：

- `sampledAt`：采样时间；`cpuPercent`：整机 CPU 使用率，首次采样为 `null`。
- `memory`：主机 `usedBytes` / `totalBytes`；`disk`：数据根所在磁盘的 `availableBytes` / `totalBytes`，读取失败为 `null`。
- `instances`：以实例 ID 为键，包含 `cpuPercent`、`memoryBytes` 与 `state`（`ready` / `collecting` / `unavailable`）。仅采集面板持有的存活进程，调用方不可指定 PID 或路径。
- `warnings`：CPU 或内存在连续采样中达到 90% 且持续至少 30 秒，或磁盘可用空间低于 5 GiB 或 10% 时提示。文本为英文，`warningsI18n` 按相同顺序给出对应的消息键，供界面翻译。

CPU 按整机逻辑核总容量归一至 0–100%；进程内存为驻留内存，不同于 JVM 堆上限 Xmx。进程指标目前仅支持 Windows 与 Linux，其他平台为 `unavailable`。空值不代表零占用。实时快照缓存 4 秒，并发请求合并（与每 5 分钟一次的后台采样共用同一缓存）；页面每 5 秒刷新，隐藏时暂停。采样间隔超过 15 秒时，持续告警时间重新累计。

### 总览历史统计 `/api/stats/overview`

`GET /api/stats/overview?range=24h|7d|30d` 需 JWT，返回共享类型 `StatsOverview`。`range` 缺省为 `7d`；非法取值或多余查询参数返回 **400**（`server.system.statsRangeInvalid`）。

- `range` / `from` / `to` / `bucketSeconds`：请求的时间范围、UTC ISO-8601 起止时刻（`from` 为 `to` 减去范围时长）与单个时间桶的宽度秒数（`24h` 为 `300`，`7d` 为 `3600`，`30d` 为 `21600`）。
- `processMetricsSupported`：Windows 与 Linux 为 `true`；不支持逐进程采集的平台为 `false`，此时实例序列恒为 `null`。
- `ioMetricsSupported`：Windows 与 Linux 为 `true`，面板在这两个平台采集整机网络与磁盘读写；其他平台为 `false`，相应序列恒为 `null`。
- `buckets`：固定槽位序列（`24h` 为 `288` 桶、`7d` 为 `168` 桶、`30d` 为 `120` 桶），每项含 `timestamp`、`hostCpuPercent`、`hostMemoryBytes`、`instancesCpuPercent`、`instancesMemoryBytes`、`hostNetRxBytesPerSec`、`hostNetTxBytesPerSec`、`hostDiskReadBytesPerSec` 与 `hostDiskWriteBytesPerSec`。无采样的槽位返回 `null`，超前于当前服务端时间的采样忽略。实例合计采用以本机采样时刻（`instance_id IS NULL`）为锚点的两层聚合：在支持逐进程采集的平台上，该时刻没有运行中实例时按 `0` 计入；存在运行中实例但进程指标全为 `null` 时按空跳过，再对桶内有效点求平均。四项读写速率单位为字节每秒，取每个 5 分钟采样间隔内的平均值：网络只计物理网卡（Windows 为硬件网卡，Linux 为 sysfs 中带 `device` 链接的接口，容器内没有此类接口时计除回环外的全部接口），避免 VPN、代理 TUN、网桥与 veth 重复计入；磁盘只计整块物理磁盘，不含分区与叠加设备。与上一次采样间隔超过两个周期（面板未运行或电脑休眠）的采样不含读写数值。
- `runs`：已完成启动（`ready_at` 非空）且与 `[from, to]` 有交集的运行段，每项含 `instanceId`、`readyAt`、`endedAt`（仍在运行时为 `null`）与 `endReason`（`stopped` / `crashed` / `panel-exit`，运行中为 `null`）。启动前失败不留记录；启动中途失败（`start-failed`）与未就绪即以退出码 0 结束（如未同意 EULA）的记录 `ready_at` 为空，不包含在此列表中。
- `host`：`osName`（Windows 取 `os.version()`，Linux 取 `/etc/os-release` 的 `PRETTY_NAME` 并在读取失败时回落为内核类型与版本，macOS 为 `macOS`）、`cpuModel`（不可用时为 `null`）、`cpuThreads`、`totalMemoryBytes` 与 `bootedAt`。
- `diskBreakdown`：后台每小时统计并缓存的 `DATA_DIR/instances` 大小（`instancesBytes`）、`BACKUP_DIR` 大小（`backupsBytes`）以及 `backupsOnSameVolume`。首次扫描完成前大小返回 `null`；`BACKUP_DIR` 位于其他卷时 `backupsBytes` 返回 `null`。目录扫描跳过符号链接与目录联接，不跟随外部目标。

## 健康检查

| 方法 | 路径 | 认证 | 响应 |
|------|------|------|------|
| GET | `/api/health` | 否 | `{ ok: true, service: "mystry-dashboard", processFingerprint?: string }` |

`processFingerprint` 仅在服务由便携控制器启动时出现，且只返回给来自回环地址的请求：开启「从其他设备访问」后，其他设备的健康检查不会获得该字段。它供 `mdash` 将状态文件、PID 与实际监听的服务对应起来，并非认证密钥，也不能替代 `X-Launcher-Token`。经面板自带网络（见下文）进入的连接落在回环地址上，因此可以获得该字段。

## 认证 `/api/auth`

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/api/auth/status` | 否 | `{ needsSetup: boolean }` |
| POST | `/api/auth/setup` | `X-Setup-Token` | 仅用户表为空时可用；Body：`{ username, password }` → `{ token, user }` |
| POST | `/api/auth/login` | 否 | Body：`{ username, password }` → `{ token, user }` 或 401 |
| POST | `/api/auth/password` | JWT | Body：`{ currentPassword, newPassword }` → `{ ok: true, token, user }`；当前密码错误返回 400。成功后此前签发的 JWT 全部失效（含本次请求所用的），调用方改用响应中的 `token`，见 [令牌失效](#令牌失效) |
| GET | `/api/auth/me` | 是 | `{ user }` |
| GET | `/api/auth/session-duration` | 是 | `{ duration }`，取值 `2h` / `12h` / `1d` / `7d` / `30d` / `never`，默认 `12h`，见 [登录有效期](#登录有效期) |
| PUT | `/api/auth/session-duration` | 是 | Body：`{ duration }` → `{ duration, token }`；列表以外的值返回 400（`server.auth.sessionDurationInvalid`）。调用方改用响应中按新有效期签发的 `token` |

### setup 请求

`setup` 不使用 JWT，而是要求在 header 中携带环境变量 `SETUP_TOKEN` 的值：

```http
POST /api/auth/setup
Content-Type: application/json
X-Setup-Token: <SETUP_TOKEN>

{"username":"admin","password":"至少 12 位的强密码"}
```

用户创建成功后，setup 接口不再可用。`mdash` 通过此接口自动创建 `admin`，成功后移除 `SETUP_TOKEN`。密钥格式要求见 [配置说明](configuration.zh-CN.md#首次启动必需配置)。

### 登录有效期

登录有效期保存在 `panel_settings`，于「面板设置」页设置，默认 12 小时，可选 2 小时、12 小时、1 天、7 天、30 天或不过期。`.env` 中的 `JWT_EXPIRES_IN` 已不再生效；若仍保留该项，启动时终端会给出提示。

- setup、登录、修改密码与保存有效期时，按当前设置签发令牌；选择「不过期」时令牌不含 `exp`。
- 每次请求都以令牌的签发时间 `iat` 重新对照当前设置：缩短后，登录已超过新时长的令牌（含按「不过期」签发的）在下一次请求时返回 **401**。
- 延长时，保存请求的响应附带按新时长签发的令牌，发起修改的设备随即生效；其他设备的令牌仍按签发时的 `exp` 过期，下次登录后才按新时长计算。

### 令牌失效

`users` 表的 `token_version` 记录令牌版本，签发的 JWT 以 `tv` 字段携带该版本。每次请求除校验签名与有效期（见 [登录有效期](#登录有效期)）外，还要求 `tv` 与数据库一致；用户不存在时同样返回 **401**（`server.common.unauthorized`）。

修改密码（`POST /api/auth/password`）或本机重置密码（`POST /api/launcher/reset-password`）成功后，版本加 1，因此：

- 此前签发的所有 JWT 在下一次请求时返回 401。修改密码的响应附带新令牌，发起修改的会话可继续使用；重置密码不签发令牌，所有会话均须重新登录。
- 由旧令牌签发且尚未使用的控制台 ticket，以及尚未开流的下载 ticket，同时作废；下载 ticket 状态变为 `failed`。
- 已打开的控制台 WebSocket 以关闭码 **1008** 断开，客户端须以当前有效的令牌重新申请 ticket。
- 已开始传输的下载不会中断，因其在开流时已通过授权。

0.2.0-preview.3 及更早版本签发的令牌不含 `tv`，按版本 0 处理：升级后在过期前仍可使用，首次修改或重置密码后失效。旧数据库在启动时自动添加 `token_version` 列，已有用户从 0 起计。

## 系统 `/api/system`

| 方法 | 路径 | 认证 | 响应 |
|------|------|------|------|
| GET | `/api/system/java` | 是 | Java 状态对象 |
| GET | `/api/system/java-runtimes` | 是 | `{ runtimes: JavaRuntimeInfo[], installable: number[] }` |
| POST | `/api/system/java-runtimes/install` | 是 | 请求体 `{ major }`（8、17、21、25），返回后台任务 `TaskInfo`；完成后 `result.javaRuntimeId` 为新运行时 |
| POST | `/api/system/java-runtimes/install/:taskId/cancel` | 是 | 取消仍在排队或运行的一键安装 Java 任务，返回任务当前状态；目标不是进行中的 Java 安装任务时返回 409（`server.jvm.javaInstall.notCancellable`） |
| GET | `/api/system/panel-info` | 是 | `PanelInfo`：`{ host, port, dataDir, backupDir, configPath }`，即面板启动时从配置文件读取的监听地址与目录（绝对路径）。只读，不含密钥，供「面板设置」页的「运行信息」展示 |
| GET | `/api/system/download-source` | 是 | `{ source: 'official' \| 'china' }` |
| PUT | `/api/system/download-source` | 是 | 请求体 `{ source }`，返回保存后的值；其他取值返回 400 |
| GET | `/api/system/remote-access` | 是 | `RemoteAccessStatus`；每次读取都重新枚举网卡 |
| PUT | `/api/system/remote-access/direct` | 是 | 请求体 `UpdateDirectAccessRequest`，返回 `RemoteAccessStatus` |
| PUT | `/api/system/remote-access/overlay` | 是 | 请求体 `UpdateOverlayAccessRequest`（开启时 `interfaceName` 必填），返回 `RemoteAccessStatus` |
| POST | `/api/system/remote-access/certificate` | 是 | 重新生成面板的自签名证书，返回 `RemoteAccessStatus` |
| PUT | `/api/system/remote-access/panel-network` | 是 | 请求体 `UpdatePanelNetworkRequest`，返回 `PanelNetworkStatus` |
| GET | `/api/system/remote-access/panel-network/join` | 是 | `PanelNetworkJoinInfo`，含网络密钥，`Cache-Control: no-store` |
| POST | `/api/system/remote-access/panel-network/reset-secret` | 是 | 重置网络名和密钥，返回 `PanelNetworkStatus` |
| GET | `/api/system/public-host` | 是 | `{ publicHost: string \| null }` |
| PUT | `/api/system/public-host` | 是 | 请求体 `{ host: string \| null }`（`null` 清除），返回 `{ publicHost }` |

下载来源默认为 `official`，保存在 `panel.db`；保存后新发起的下载随即采用，无需重启。各类文件的实际来源见[架构说明](architecture.zh-CN.md#下载来源)。

### 从其他设备访问面板

面板的主监听器保持不变（`HOST:PORT`，默认 `127.0.0.1:3000`）。开启访问后，服务端在每个待开放的 IPv4 地址上另起监听器（同一端口），并将连接转交同一个 HTTP 服务；设置保存在 `panel.db` 的 `panel_settings` 表，保存即生效，无需重启。任何已登录的请求均可开关此功能，不限于本机。

- **`direct`（直接访问）**：`interfaceName` 为 `null` 表示所有网卡（不含实例的联机网络），也可指定单块网卡的名称。`https` 默认 `true`：监听器按首字节分流，TLS 握手交给面板，明文请求仅返回 `308` 跳转至同主机的 `https://`，不发送 HSTS。`restrictToSubnet` 默认 `false`：开启后，每个监听器仅接受来自所在网卡网段的来源（`100.64.0.0/10` 内的组网网卡放行整个网段；其他 `/32` 网卡无法推算网段，因此不监听并标记为 `subnetUnknown`）。
- **`overlay`（已装的组网软件）**：仅在选定的网卡上监听，`https` 默认 `false`。直接访问的「所有网卡」会让出该网卡的地址。
- **证书**：ECDSA P-256 自签名证书，保存于 `<数据根>/tls/panel.key` 与 `panel.crt`，有效期 800 天，SAN 为生成时的网卡地址与公网地址。已有证书持续复用，仅在文件缺失或损坏、30 天内到期或用户要求时重新生成。状态中的 `certificate` 仅含指纹、到期时间与 SAN，不含私钥。
- **状态**：`RemoteAccessStatus` 含 `managedByConfig`（`HOST` 已是非回环地址时为 `true`，此时两个 PUT 返回 409 `server.remoteAccess.managedByConfig`）、`port`、`frontendServed`、`platform`、`interfaces`（每块网卡的名称、地址、`cidr` 与分类 `kind`）、`publicHost`、`certificate`、`direct`、`overlay`、`panelNetwork`。`direct` / `overlay` 的 `urls` 列出全部候选网址及其是否在监听，单个地址未能监听时附带 `problem`（`listenFailed` / `subnetUnknown`）；整体问题见 `problem`（另有 `interfaceGone`、`noAddress`、`certificateFailed`）；`firewall` 为 Windows 防火墙规则的处理结果 `applied` / `failed` / `skipped`。
- **防火墙**：Windows 上的规则名含面板端口，即 `MystryDashboard-Panel-Direct-<端口>`、`MystryDashboard-Panel-Overlay-<端口>`、`MystryDashboard-PanelNet-<端口>`，同一台电脑上的两个面板不会互删规则；仅删除本进程添加的规则。
- **失败**：所选网卡不存在时返回 409 `server.remoteAccess.interfaceGone`；证书生成或读取失败时返回 500 `server.remoteAccess.certificateFailed`；没有任何地址成功监听时返回 409 `server.remoteAccess.listenFailed` 或 `server.remoteAccess.noAddress`，设置恢复为操作前的值。
- **面板自带网络（`panel-network`）**：面板运行固定版本的官方 EasyTier（无 TUN 模式），面板节点恒为 `10.127.0.1`。面板另在 `127.0.0.1` 上开设一个组网专用端口，`tcp_whitelist` 仅含该端口（不含面板端口），`url` 也使用该端口；该端口首次从面板端口 + 1 向上查找（不使用系统动态端口段），存入设置后每次启动沿用，仅在被其他程序占用时更换并记录日志。经该端口进入的请求按组网设备处理：启动器接口返回 403，`/api/health` 不含进程指纹，限流与登录失败计数将整个组网视为单一来源，不与本机共用。`PanelNetworkStatus` 含 `enabled`、`platformSupported`、`installed`、`state`（`stopped` / `installing` / `starting` / `running` / `error`）、`detail`、`virtualIp`、`url`、`devices`、节点设置与 `firewall`，不含网络名与密钥，二者仅由 `join` 接口返回。开启后，安装与启动在后台完成，界面按 `state` 轮询。
- **公网地址（`public-host`）**：用户填写的公网 IP 或域名，由联机页与面板网址共用。服务端去除首尾空白、`http(s)://` 与末尾的 `/`；含端口时返回 400 `server.publicHost.hasPort`，其他非法写法返回 400 `server.publicHost.invalid`；不拒绝私网地址。面板不解析域名，也不探测公网 IP。

Java 状态响应的确切结构：

```json
{
  "available": true,
  "version": "21.0.3",
  "majorVersion": 21
}
```

未找到 Java 时返回 `{ "available": false, "version": null, "majorVersion": null }`。面板不提供全盘目录浏览接口。

`/api/system/java-runtimes` 返回面板探测并验证过的 Java 运行时注册表；带 `?refresh=1` 时请求重新扫描。并发扫描合并为一个任务，连续强制刷新受 30 秒冷却限制；普通读取默认使用 60 秒缓存。候选路径仅来自对 `JAVA_HOME`、常见安装目录与面板安装目录（数据根下的 `runtimes/java/*`，`source: 'panel'`）的扫描，且文件名须为 `java`/`java.exe`、`-version` 输出能解析出版本号，方可入表。实例可通过 `javaRuntimeId` 绑定表内条目（创建、更新、部署请求均接受该可选字段；`null` 表示使用 PATH 中的 `java`），请求不可提交任意可执行路径。绑定的运行时在启动前或 Forge/NeoForge 安装器执行前会再次验证；最近一次扫描未发现的条目以 `available: false` 返回。

`installable` 是面板可在本机自动安装的 Java 主版本（目前 Windows x64 与 Linux x64 上为 `[8, 17, 21, 25]`，其他系统或架构为空）。`POST /api/system/java-runtimes/install` 下载固定版本的 Eclipse Temurin JRE（来源随下载来源设置：GitHub 或公共 GitHub 代理），按固定的 SHA-256 校验，在数据根的 `runtimes/java/.staging-*` 中解压后移至 `runtimes/java/temurin-<版本>`，经 `-version` 验证后注册；已安装且可运行时不重复下载。同一主版本已有任务排队或运行时，返回该任务。`POST /api/system/java-runtimes/install/:taskId/cancel` 仅取消本进程中仍在排队或运行的 Java 安装任务（部署、导入等其他任务 ID 一律返回 409）：排队中的任务直接结束；运行中的任务在中止下载或解压、删除临时目录后结束，因此返回时任务可能仍为 `running`，须继续轮询。结束后 `status` 为 `failed`，`messageI18n` 为 `server.tasks.cancelled`，`errorI18n` 为 `server.tasks.cancelledByUser`。取消请求晚于改名至最终目录时不生效，任务照常完成。不在固定列表中的主版本返回 400（`server.jvm.javaInstall.unsupportedMajor`），本机无可用安装包时返回 409（`server.jvm.javaInstall.platformUnsupported`）。任务失败原因：`downloadFailed`、`checksumMismatch`、`extractFailed`、`verifyFailed`（均在 `server.jvm.javaInstall.*` 下）。

`JavaRuntimeInfo` 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 运行时注册表 ID；请求仅可提交该值 |
| `path` | string | 面板扫描到的 Java 可执行文件绝对路径，仅返回给已认证用户 |
| `version` / `majorVersion` | string / number | 最近一次验证的完整版本与主版本号 |
| `source` | `env \| scan \| panel` | `JAVA_HOME`、常见安装目录扫描，或面板安装到数据目录的 Java |
| `verifiedAt` | string | 最近一次成功验证时间 |
| `available` | boolean | 最近一次完整扫描是否仍发现并验证此条目 |

## 实例 `/api/instances`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/instances` | 实例列表 `InstanceInfo[]` |
| GET | `/api/instances/:id` | 单个实例 |
| POST | `/api/instances` | 创建空实例，Body 见 `CreateInstanceInput` |
| PATCH | `/api/instances/:id` | 按 `UpdateInstanceInput` 更新，仅修改提交的字段。`acceptEula` 由 `true` 改为 `false` 时，将实例目录的 `eula.txt` 改写为 `eula=false`；实例正在备份或还原时，此项改动返回 **409** |
| POST | `/api/instances/:id/adopt-managed-directory` | 接管已复制到面板托管根目录的旧实例 |
| DELETE | `/api/instances/:id` | 删除实例记录及面板托管的实例目录；不访问也不删除旧版外部目录。默认一并删除该实例在 `BACKUP_DIR` 下的备份，带 `?keepBackups=1` 时保留（此后不再显示于面板）；实例已删除而备份删除失败时返回 **500** |
| POST | `/api/instances/:id/start` | 启动 |
| POST | `/api/instances/:id/stop` | 停止；`?force=1` 强制终止进程。普通停止超时且仍在停止中时返回 **202** `{ code: "INSTANCE_STOP_PENDING", error, errorI18n }` |
| POST | `/api/instances/:id/restart` | 重启 |
| POST | `/api/instances/:id/command` | Body：`{ command: string }`，发送控制台命令 |
| GET | `/api/instances/:id/local-network` | 直连地址 `InstanceLocalNetwork`：`{ port, addresses, publicIpv4, publicIpv6, publicHost, serverIpBlocked, serverIpIsUnboundPublicHost, panelPort, platform }`。只读，不开放端口，也不修改配置 |

`InstanceInfo.startIssue` 在最近一次启动失败且原因可识别时给出 `{ kind, requiredJava }`，否则为 `null`：`kind` 为 `eula`（尚未同意 Minecraft EULA）、`java-too-new` 或 `java-too-old`（所用 Java 过新或过旧；`requiredJava` 为所需主版本，无法判断时为 `null`）。这三种由面板按固定句式从该次进程的控制台输出中识别，仅存于内存；再次启动、删除实例或面板重启后清空。`kind` 也可为 `java-unavailable`（`requiredJava` 恒为 `null`）：实例 `javaRuntimeId` 指向的运行时在注册表中已标为不可用或已不存在。该项无需启动即可给出，每次读取实例时依据注册表实时计算，优先于上述三种；改选 Java 或重新扫描找回该运行时后消失。服务端打印 `Done (` 之后的退出不归因于 Java 版本。进程自行以退出码 0 结束（未同意 EULA、游戏内执行 `stop`）时状态为 `stopped`，非 0 才为 `crashed`。

`InstanceInfo.ready` 表示本次运行中服务端已打印标志启动完成的 `Done (` 行，玩家可以进服；状态为 `running` 但世界仍在加载时为 `false`，正在停止或未运行时亦为 `false`。该字段同样仅存于内存。

`local-network` 的 `addresses` 为本机的局域网 IPv4 地址（不含回环、`169.254.*` 与可识别的虚拟网卡，如 WSL、虚拟机、组网或代理软件的网卡；若全为虚拟网卡则照常列出。最多 6 个，`192.168.*` 优先）。`port` 取自 `server.properties` 的 `server-port`：未填写或留空时为游戏默认的 `25565`，填写的值不是 1–65535 的整数时为 `null`（frp 与虚拟局域网按同一规则读取端口）。`server-ip` 留空或为 `0.0.0.0` 时返回全部地址；等于其中某个地址时仅返回该地址；其余情况下 `serverIpBlocked` 为 `true` 且 `addresses` 为空。`publicIpv6` 为实体网卡上的公网 IPv6 地址（`2000::/3`，不含 6to4、Teredo 与文档示例段，最多 3 个），仅在 `server-ip` 留空、为 `*` 或 `::` 时给出，为 `0.0.0.0` 或具体地址时为空；面板不区分固定地址与系统临时地址，也不检测路由器是否放行。

`addresses` 不含网卡上的公网地址，也不含实例自身联机网卡的地址；直接配置在网卡上的公网 IPv4 单独列于 `publicIpv4`。`publicHost` 为用户通过 `PUT /api/system/public-host` 填写的公网 IP 或域名，未填写时为 `null`。`server-ip` 等于 `addresses` 或 `publicIpv4` 中的某个地址时仅返回该地址，`serverIpBlocked` 为 `false`；`server-ip` 等于 `publicHost` 但网卡上并无该地址时（云服务器上的常见错误），`serverIpBlocked` 与 `serverIpIsUnboundPublicHost` 均为 `true`。`panelPort` 为面板端口，`platform` 为面板所在的操作系统（`process.platform`），界面据此区分游戏端口与面板端口，并显示对应系统的防火墙设置方法。

实例目录固定为最终数据根下的 `instances/<id>`。最终数据根优先取 `MYSTRY_DATA_DIR`，其次 `DATA_DIR`；创建、部署、导入与启动均不接受其他实例目录，`jarFile` 也只能指向实例根目录内的相对文件。

### 接管旧版实例

面板不访问、不删除旧版记录指向的外部目录，也不自动迁移。调用接管接口前，须：

1. 停止实例与面板服务。
2. 使用操作系统工具将旧外部目录完整复制到 `DATA_DIR/instances/<id>`。
3. 启动面板，并以 JWT 调用：

```http
POST /api/instances/<id>/adopt-managed-directory
Authorization: Bearer <token>
```

接管成功后返回更新后的 `InstanceInfo`。实例正在运行、目标目录为空或目录不属于该实例时，接口返回错误。接管或删除面板实例均不触及旧外部目录。

### `InstanceInfo` 字段摘要

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实例 ID |
| `name` | string | 显示名称 |
| `coreType` | `vanilla \| paper \| fabric \| forge \| neoforge \| custom` | 核心类型 |
| `mcVersion` | string \| null | MC 版本 |
| `jarFile` | string | 相对实例根目录的 jar 名；Forge / NeoForge 为 `@args:<参数文件相对路径>`，模组加载器尚未安装时为 `@modloader`。共享包的 `parseLaunchTarget` 负责解析这两种标记 |
| `jvmArgs` | string | JVM 参数字符串 |
| `requiresMigration` | boolean | 是否需要按旧版外部实例流程完成接管 |
| `nodeId` | string | 执行节点 ID；本机为 `local` |
| `javaRuntimeId` | string \| null | 绑定的 Java 运行时 ID；`null` 使用 PATH 中的 `java` |
| `status` | `InstanceStatus` | 运行状态 |
| `acceptEula` | boolean | 为 `true` 时每次启动写入 `eula=true`；为 `false` 时启动不修改 `eula.txt`（导入的服务端可能自带同意记录），仅在由 `true` 改为 `false` 的那次保存时写入 `eula=false` |
| `createdAt` / `updatedAt` | string | ISO 时间 |

`jvmArgs` 在保存与启动前均经过 `@mystry/shared` 的同一套校验：`Xms` / `Xmx` 须各有且仅有一个；拒绝未闭合引号、重复或冲突的 GC 设置及 `Xms > Xmx`，也拒绝 `-jar`、classpath、模块启动、`@argfile` 与 `nogui` 等由面板负责的启动参数。请求省略 `jvmArgs` 时，创建、部署与导入仍使用兼容默认值 `-Xms1G -Xmx2G`。旧实例的文本不会仅因读取而被改写，但非法旧值须先修正，方可保存或启动。

## 文件与配置 `/api/instances/:id`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/files?path=` | 列出实例根目录内的目录，返回 `FileEntry[]`；实例根目录下的面板所有权标记 `.mystry-instance.json` 不在列表中 |
| GET | `/files/content?path=` | 读取文本 `{ path, content, binary }`。前 8 KiB 中含 NUL 字节时 `binary` 为 `true`，此时 `content` 有损（非 UTF-8 字节变为 U+FFFD），原样写回会损坏文件 |
| PUT | `/files/content` | Body：`{ path, content }` |
| DELETE | `/files?path=` | 删除实例根目录内的文件或目录。与该实例的启动、停止、重启及实例删除共用实例锁：其中一项进行时，删除排队等待；删除完成前，这些操作亦须等待 |
| POST | `/files/mkdir` | Body：`{ path }` |
| POST | `/files/rename` | Body：`{ from, to }` |
| GET | `/files/download?path=` | 二进制流；可选 `ticket=` 一次性下载票据；响应含 `Content-Disposition: attachment` |
| POST | `/files/download-ticket` | Body：`{ path }`；签发票据并预占下载槽位 |
| GET | `/files/download-ticket/:ticket/status` | 查询自己名下下载票据的生命周期状态 |
| DELETE | `/files/download-ticket/:ticket` | 取消自己名下尚未开流的下载票据 |
| POST | `/files/upload?path=` | multipart 单文件 |
| GET | `/config/server.properties` | 键值对象；`difficulty`、`gamemode` 的数字写法转换为名称（如 `1` → `easy`） |
| PUT | `/config/server.properties` | Body：`Record<string, string>`。`difficulty`、`gamemode` 以名称提交；文件原为数字或实例版本为 1.13 及更早时，写回数字。非 ASCII 字符写为 `\uXXXX` |

所有 `path` 均为**相对于 `DATA_DIR/instances/<id>` 的逻辑路径**，服务端校验后拒绝 `..` 逃逸；这些接口无法访问实例根目录以外的文件。仅可下载普通文件；`Content-Disposition` 仅使用 basename（含 RFC 5987 `filename*`）。不带 ticket 的下载使用 Bearer JWT；浏览器原生下载可先以 Bearer JWT 调用 `POST .../download-ticket`，再以 `GET .../download?path=&ticket=` 触发流式下载（该 GET 不带 Authorization header）。

下载 ticket 的签发有效期由 `FILE_DOWNLOAD_TICKET_TTL_SECONDS` 控制，默认 60 秒。签发时状态为 `reserved`，并预占一个下载并发槽位；原生 GET 校验 `instance` 与 `path` 后将其原子地转为 `streaming`，签发有效期到期不回收已开流的槽位。状态查询返回 `reserved`、`streaming`、`consumed`、`failed` 或 `expired`：传输成功为 `consumed`；读流错误、连接中止、下载空闲超时及取消为 `failed`；签发有效期届满仍未开流为 `expired`。`expired`、`consumed` 与 `failed` 均按所属用户保留 60 秒的短时 tombstone，供状态查询返回终态；超过该期限或无权查询时返回 404。

已认证的 `DELETE .../download-ticket/:ticket` 仅在 ticket、当前用户与 URL 中的实例 ID 三者均匹配，且 ticket 仍为 `reserved` 时，取消 ticket 并随即释放预占槽位，返回 **204**。已进入 `streaming` 时不改动流与槽位，返回 **409**；票据不存在、所属用户或实例不匹配时一律返回 **404**。

上传文件超过 `MAX_UPLOAD_BYTES` 时返回 **413**；上传或下载并发已满时返回 **429**。相关超时见 [配置说明](configuration.zh-CN.md)。

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

备份文件为 gzip 压缩的 tar，末尾条目 `.mystry-backup/manifest.json` 记录每个文件的大小与 SHA-256。备份范围为实例目录 `DATA_DIR/instances/<id>` 下的全部文件，不含面板的所有权标记与运行时被 JVM 锁定的 `session.lock`（启动时自动重建），也不含 `panel.db`（用户与实例设置不在备份中）。目录中含符号链接或目录联接时拒绝备份。

- **运行中备份**：先发送 `save-off` 与 `save-all flush`，等待服务端自身打印 `Saved the game`（1.12 及更早为 `Saved the world`，Paper 26.3 为 `System chat: Saved the game`；仅匹配日志前缀之后的完整消息，玩家聊天不计；最长 60 秒），打包完成后发送 `save-on`。期间服务器启动、停止或崩溃将取消备份；启动中或停止中的实例返回 **409**。
- **还原**：服务器须已停止，否则返回 **409**。`backupCurrent` 为 `true`（界面默认）时，先生成一份 `source: 'pre-restore'` 的备份。备份先经完整校验并解压到 `DATA_DIR/.mystry-staging/<taskId>/`，全部通过后才整体替换实例目录；替换中途失败时移回原目录。若面板在替换中途退出，下次启动时自动回滚或完成收尾。替换成功后，若清单记录的启动文件（jar 或 Forge `@args:` 参数文件）存在于还原后的目录，实例的 `jarFile`、`coreType`、`mcVersion` 将改为清单中的值。
- **校验**：拒绝绝对路径、`..`、链接与特殊文件、重复路径、面板保留文件、清单以外的文件及校验值不符的文件；条目数与总大小沿用 `MAX_EXISTING_IMPORT_ENTRIES` / `MAX_EXISTING_IMPORT_BYTES`。
- **互斥**：备份或还原期间，拒绝启动、重启、删除与接管该实例（**409**）；还原期间另拒绝写入、删除、改名与上传实例文件（上传在接收完毕、写入实例目录前再检查一次；删除在取得实例锁后再检查一次）。还原任务正在使用的备份不可删除（**409**）。
- 备份与还原任务的运行时限为 `BACKUP_TASK_TIMEOUT_MS`（默认 6 小时），不受 `TASK_TIMEOUT_MS` 限制。
- 上传超过 `MAX_BACKUP_UPLOAD_BYTES` 返回 **413**。下载票据的状态查询与取消沿用 `/files/download-ticket/:ticket/status` 和 `DELETE /files/download-ticket/:ticket`。

`BackupInfo` 字段：`id`、`instanceId`、`instanceName`、`source`（`manual` / `pre-restore` / `upload` / `scheduled`）、`createdAt`、`sizeBytes`（压缩包大小）、`fileCount`、`contentBytes`（解压后大小）、`coreType`、`mcVersion`、`wasRunning`、`sha256`（压缩包的 SHA-256）。

### 定时备份 `/api/instances/:id/backup-schedule`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/backup-schedule` | `BackupScheduleInfo`；未保存过计划时为默认值（未启用、`04:00`、保留 `7` 份） |
| PUT | `/backup-schedule` | Body：`{ enabled: boolean, time: "HH:MM", keep: 1–365 }`，三项必填；返回 `BackupScheduleInfo`。格式不符返回 **400** |

每个实例有一份每日计划。`time` 为 24 小时制时刻，以面板所在机器的时钟为准；响应中的 `utcOffsetMinutes` 为该时钟当前相对 UTC 的偏移。面板每分钟检查一次，到期的备份作为普通 `backup` 任务排入，因此也出现在 `GET /api/tasks` 中；生成的备份 `source` 为 `'scheduled'`。

- **到期**：当日备份自设定时刻起到期。启用计划，或在启用状态下修改时刻，均自该时刻下一次到来起算。面板未运行或机器休眠期间错过的日子，于下次启动后只补一次。夏令时切换当日，设定时刻被跳过时，在跳变后的第一分钟备份；设定时刻出现两次时，只在第一次备份。
- **推迟**：仅在没有其他任务运行或排队时排入定时备份，故同一时间至多运行一份。面板正在处理其他任务，或实例正在启动、停止、备份或还原时，留待之后的检查，不作记录。
- **跳过**：上一份定时备份之后服务器未运行过、亦未经面板改动文件，且该备份仍在时，当日跳过，不产生任务。还原视同改动；面板之外对实例目录的改动无从得知。
- **磁盘空间**：打包前，备份目录所在磁盘的可用空间须不少于该实例最新一份备份的大小加 256 MiB。不足时，先删除已超出 `keep` 份的定时备份，再读取一次可用空间；仍然不足或无可删除时，本次失败。实例尚无备份，或平台无法报告可用空间时，不作检查。
- **保留**：定时备份成功后，该实例 `source: 'scheduled'` 的备份中超出最新 `keep` 份者，按从旧到新删除。`keep` 取删除时已保存的值，打包期间的修改对本次即生效。刚生成的一份不在删除之列，即便机器时钟被调回、其日期早于其余各份。其他来源的备份不会被自动删除；正被还原任务使用的备份留待之后处理。
- **失败**：失败的一次是一条失败的 `backup` 任务，错误信息带实例名称；`lastFailure`（`at`、`error`、`errorI18n`）保留其原因，直至下一份定时备份成功。当日不再重试，唯一的例外是因服务器启动、停止或崩溃而中断的一次：下次检查时重试，同一日至多运行三次。其中每一次仍是一条失败任务，第三次仍被中断时才写入 `lastFailure`。因面板关闭而中断的一次不作记录，于下次启动后补做。

`BackupScheduleInfo` 字段：`enabled`、`time`、`keep`、`utcOffsetMinutes`、`lastBackupAt`（最近一份成功的定时备份的时间，无则为 `null`）、`lastFailure`（无则为 `null`）。计划随实例一并删除。

## 核心部署与导入

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cores/:type/versions` | `type`: `vanilla \| paper \| fabric \| forge \| neoforge` |
| GET | `/api/cores/paper/:version/builds` | Paper build 列表 |
| GET | `/api/cores/fabric/:version/loaders` | Fabric loaders + installers |
| GET | `/api/cores/forge/:version/loaders` | Forge loader 列表 |
| GET | `/api/cores/neoforge/:version/loaders` | NeoForge loader 列表，最新构建在前。`:version` 为 Minecraft 版本号，如 `1.21.1`、`26.3` |
| POST | `/api/cores/deploy` | Body：`DeployCoreInput`，返回 `TaskInfo` |
| GET | `/api/import/sources` | 列出 `DATA_DIR/imports` 的直接子目录及启动文件探测结果 |
| POST | `/api/import/existing` | Body：`ImportExistingServerInput`，复制交接目录并返回 `TaskInfo` |
| POST | `/api/import/previews` | multipart 上传单个 ZIP，验证中央目录并返回 `ImportPreviewInfo` |
| GET | `/api/import/previews/:id` | 恢复当前登录用户的待确认预览 |
| POST | `/api/import/previews/:id/confirm` | Body：`ConfirmZipImportInput`，确认配置并返回 `TaskInfo` |
| DELETE | `/api/import/previews/:id` | 取消预览并删除临时 ZIP |
| POST | `/api/import/folder-uploads` | Body：`CreateFolderUploadInput`，开始浏览器文件夹上传，返回 `FolderUploadInfo` |
| POST | `/api/import/folder-uploads/:id/files` | multipart 上传一批文件（每个文件之前须有一个 `path` 字段），返回 `FolderUploadInfo` |
| POST | `/api/import/folder-uploads/:id/complete` | 全部接收后预检，返回带 `check` 的 `FolderUploadInfo` |
| GET | `/api/import/folder-uploads/:id` | 恢复当前登录用户的上传 |
| POST | `/api/import/folder-uploads/:id/confirm` | Body：`ConfirmZipImportInput`，确认配置并返回 `TaskInfo` |
| DELETE | `/api/import/folder-uploads/:id` | 取消上传并删除临时文件夹 |
| GET | `/api/tasks/:id` | 查询任务进度 `TaskInfo` |
| GET | `/api/tasks` | 任务中心列表，按创建时间倒序返回最近 50 条 `{ tasks: TaskInfo[] }` |

部署与导入始终将内容写入新实例的 `DATA_DIR/instances/<id>`，不接受自定义目录或 Java 可执行文件路径。实例默认使用 PATH 中的 `java` 启动，也可通过 `javaRuntimeId` 绑定注册表中当前可用的运行时；部署请求中的绑定同样用于 Forge/NeoForge 安装器。Paper 的 `build`、Fabric / Forge / NeoForge 的 `loaderVersion` 等版本字段留空时取最新稳定版；填写的版本不存在时任务失败，不会改用其他版本。

### 同机已有服务端交接

`GET /api/import/sources` 返回：

```json
{
  "sources": [
    {
      "id": "paper-survival",
      "launchTarget": "paper.jar",
      "coreType": "paper",
      "mcVersion": "1.20.4",
      "modifiedAt": "2026-08-02T10:00:00.000Z",
      "ready": true,
      "detectedJvmConfig": {
        "source": "user_jvm_args.txt",
        "raw": "-Xms1G\n-Xmx4G\n",
        "canonicalArgs": "-Xms1G -Xmx4G",
        "issues": []
      }
    }
  ],
  "importDir": "/opt/mystry/data/imports"
}
```

`id` 仅为 `DATA_DIR/imports` 下的单层目录名，而非系统路径。`importDir` 为 imports 文件夹在面板所在电脑上的绝对路径，仅用于向已登录用户展示复制目标；面板不接受客户端提交的任何路径。`coreType` 依据启动文件名判断（`paper`、`fabric`、`neoforge`、`forge`；`server.jar` 与 `minecraft_server*` 为 `vanilla`；其余为 `custom`）。`mcVersion` 为从启动文件名或 Forge args 目录名中识别出的 `1.7`–`1.21.x` 版本号；无法识别、核心为 `custom` 或为 NeoForge 时省略。

两种导入的请求中，`coreType` 省略或为 `custom` 均表示自动识别，以面板复制或解压后的识别结果为准；指定其他类型时按指定值使用。`mcVersion` 留空时采用识别出的版本，无法识别则保持为空。创建任务示例：

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

提交前应停止原服务器。复制前的检查与限制见 [从 imports 文件夹复制](user-guide.zh-CN.md#从-imports-文件夹复制)。无论成功与否，源目录均不会被删除；失败时清理新建的半成品实例。

目录根部的普通文件 `eula.txt` 已记录同意时，来源信息包含 `eulaAccepted: true`，Web 随之隐藏 EULA 勾选框。导入不会将其记为 `acceptEula`，该文件始终交由服务端读取，面板不会改写。目录根部存在普通文件 `user_jvm_args.txt` 时，来源信息可包含 `detectedJvmConfig`。该文件最大 64 KiB；不读取子目录中的文件，不跟随链接，也不解析或执行 `.bat` / `.sh`。检测到参数后，Web 自动将 `canonicalArgs` 填入 JVM 配置器并给出提示，用户可取消（恢复为沿用前的参数）或重新应用；提交时仍只发送 `jvmArgs`。解析失败时 `canonicalArgs` 为 `null`，不予沿用。`issues[]` 每项含稳定的 `code`、`severity` 与英文 `message`；共享 JVM 校验产生的诊断另带 `key`（`server.jvm.issue.*`）与 `params`，供界面翻译。

### ZIP 二阶段导入

第一步仅上传文件：

```http
POST /api/import/previews
Content-Type: multipart/form-data

file=<server.zip>
```

服务端将其流式写入受控临时目录，并校验 ZIP 中央目录、条目配额、ZIP64、链接/特殊文件与重复条目；此外仅解压根目录或单一顶层目录中的 `user_jvm_args.txt` 与 `eula.txt`，各不超过 64 KiB。仅当该 `eula.txt` 明确记录了同意（最后一个 `eula` 键的值为不区分大小写、前后无多余字符的 `true`，且文件不含反斜杠）时，响应含 `eulaAccepted: true`。成功响应：

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

预览 ID 与登录用户绑定：非所有者或 ID 不存在时返回 **404**，已过期返回 **410**，正在确认或重复确认返回 **409**。每个用户最多保留一个预览，全局容量由 `MAX_IMPORT_PREVIEWS` 控制；新 ZIP 预检成功后才替换旧预览。仅当后台任务成功入队时才消费预览；任务队列已满时返回 **429**，并保留预览以便重试。预览有效期默认由 `IMPORT_PREVIEW_TTL_SECONDS=1800` 控制；取消、过期、面板关闭或重启均会删除临时 ZIP，预览既不写入数据库，也不跨重启恢复。

ZIP 导入只能通过上述预览流程；旧的一阶段 `POST /api/import` 已删除，调用将返回 **404**。

### 浏览器上传文件夹

浏览器读取用户所选的服务端文件夹，将文件分批传给面板。面板仅接收文件内容及其在文件夹内的相对路径，不接收也不记录用户电脑上的路径。

1. 开始：`POST /api/import/folder-uploads`，Body `{ "folderName": "survival", "fileCount": 6210, "totalBytes": 2147483648 }`。`folderName` 仅用于显示，不得含 `/`、`\` 或控制字符。文件数与总大小沿用 `MAX_EXISTING_IMPORT_ENTRIES` / `MAX_EXISTING_IMPORT_BYTES`，超出时返回 **413**；数据盘剩余空间不足时返回 **507**。
2. 分批上传：`POST /api/import/folder-uploads/:id/files`，multipart，每个文件之前须有一个 `path` 字段，其值为去掉最外层文件夹名、以 `/` 分隔的相对路径。每次请求最多 500 个文件，同一会话同一时间仅接收一批（否则返回 **409**）。
3. 预检：`POST /api/import/folder-uploads/:id/complete`。已接收的文件数与字节数须与开始时声明的一致，否则返回 **409**。响应中的 `state` 变为 `ready`，`check` 的字段与 imports 来源的预检结果相同（`launchTarget`、`coreType`、`mcVersion`、`ready`、`detectedJvmConfig`、`eulaAccepted`、`error` / `errorI18n`）。
4. 确认：`POST /api/import/folder-uploads/:id/confirm`，Body 与 ZIP 确认相同。`check.ready` 为 `false` 时返回 **409**。任务将整个临时文件夹改名移入 `DATA_DIR/.mystry-staging/<taskId>/<instanceId>`（不在同一磁盘时退回逐个文件复制），再确认启动文件，原子移动到 `instances/<id>` 并完成注册。

相对路径须为常规写法：拒绝空段、`.`、`..`、绝对路径、反斜杠与控制字符；Windows 上另拒绝 `<>:"|?*`、结尾的点或空格，以及 `CON`、`NUL` 等保留名；根目录不得包含面板保留的 `.mystry-instance.json` 与 `.mystry-staging-marker.json`。同一路径出现两次、文件与目录同名、实际字节数超过声明、文件之前缺少 `path` 字段，均返回 **400**。一批中任一文件出错，整个会话即作废并删除临时文件夹，须从头重传；不支持断点续传。

上传的文件写入 `DATA_DIR/uploads/.tmp-folder-upload-<id>/`。会话与登录用户绑定：非所有者或 ID 不存在时返回 **404**，已过期返回 **410**。每个用户仅保留一个会话，新开始的上传会替换尚未确认的旧会话；全局同时存在的会话数沿用 `MAX_IMPORT_PREVIEWS`（已满时返回 **429**）。会话空闲期限沿用 `IMPORT_PREVIEW_TTL_SECONDS`，每接收一批或执行一次预检均重新计时。取消、过期与面板关闭均会删除临时文件夹；面板启动时按前缀清理上次遗留的临时文件夹。会话仅存于内存，不跨重启恢复。

批量上传请求同样受全局请求频率限制（每个路由每分钟 `RATE_LIMIT_MAX` 次）；被限流的批次尚未写入任何文件，Web 等待数秒后重发同一批，页面显示「上传暂停」。若请求体尚未发完，面板即返回 **429** 并断开连接，浏览器往往只报告网络错误；此时 Web 先以 `GET /api/import/folder-uploads/:id` 确认会话仍在、`receivedFiles` 未变，再重发；若会话已不存在（如面板已重启），则提示上传中断。

ZIP 中的普通文件仅支持存储与 Deflate 两种压缩方式；使用其他方式时导入任务失败，并清理半成品实例。

### `TaskInfo` 状态

| status | 含义 |
|--------|------|
| `pending` | 排队 |
| `running` | 执行中 |
| `completed` | 成功，`result` 可能含 `instanceId` |
| `failed` | 失败，`error` 为原因 |

`message` 与 `error` 为英文文本；随之返回的 `messageI18n` / `errorI18n`（`{ key, params }`）供界面按语言翻译。升级前创建的任务没有这两个字段，其 `message` / `error` 可能是中文原文，原样显示即可。为此，数据库在 `tasks` 表中新增可空列 `message_i18n`、`error_i18n`（启动时自动添加，无需手动迁移）。

部署或导入提交成功后，即使暂无空闲执行槽位，也先返回 `pending` 任务；队列已满时返回 **429**。调用方应持续查询 `/api/tasks/:id`，直至 `completed` 或 `failed`；任务开始执行后运行超过 `TASK_TIMEOUT_MS` 即失败。排队并非失败，不应重复提交。

## 控制台 WebSocket

先以 JWT 调用 `POST /api/instances/:id/console-ticket` 获取一次性 ticket：

```http
POST /api/instances/<id>/console-ticket
Authorization: Bearer <token>
```

然后连接：`ws://<host>:<port>/ws/console/:instanceId?ticket=<ticket>`。ticket 默认有效期 60 秒，且仅能建立一次连接。修改或重置密码后，未使用的 ticket 作废，已建立的连接以关闭码 1008 断开，见 [令牌失效](#令牌失效)。

连接数、入站消息大小、命令长度与发送速率的上限，见 [配置说明](configuration.zh-CN.md) 中的 `MAX_CONSOLE_*` 等变量；超出限制时，服务端不向实例 stdin 写入。

### 服务端 → 客户端消息（JSON）

| type | 字段 | 说明 |
|------|------|------|
| `history` | `data`, `status?` | 连接时推送的历史输出 |
| `output` | `data` | 新日志片段 |
| `status` | `status` | 状态变更 |
| `error` | `data`, `code?`, `params?` | 错误说明：`data` 为英文文本，`code` / `params` 为可翻译的消息键与参数 |

### 客户端 → 服务端

```json
{ "type": "command", "data": "say hello" }
```

命令成功写入实例 stdin 后，服务端将 `> 命令` 作为一行追加到该实例的控制台缓冲区，并以 `output` 帧推送（上一段输出未以换行结尾时先补换行），因此所有连接及之后的 `history` 帧都能看到已发送的命令。`POST /api/instances/:id/command` 以及备份时面板自动发送的 `save-off` / `save-all flush` / `save-on` 同样会回显。

## 启动器本机接口

`POST /api/launcher/shutdown` 仅供本机启动器 `mdash` 调用，不使用登录 JWT。请求须来自回环地址，并携带：

```http
X-Launcher-Token: <LAUNCHER_TOKEN>
```

有效请求返回 **202**，响应包含 `accepted`、运行中的实例数、运行中/排队中的任务数，以及是否已在关闭过程中。令牌无效返回 401，非本机来源返回 403，当前启动方式未提供安全关闭回调时返回 503。该接口独立限流，响应发送完毕后开始停止任务、Minecraft 实例、HTTP 服务与数据库。

满足同样条件（回环来源及 `X-Launcher-Token`）的接口还有：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/launcher/reset-password` | 请求体 `{ password }`，重置管理员密码 |
| GET | `/api/launcher/remote-access` | 返回 `RemoteAccessStatus` |
| PUT | `/api/launcher/remote-access/direct` | 请求体 `UpdateDirectAccessRequest`，开关直接访问 |
| POST | `/api/launcher/remote-access/certificate` | 重新生成证书 |

这些接口供 `mdash` 的 `reset-password` 与 `remote` 命令使用。经额外监听器（其他设备）进入的请求，来源地址并非回环，一律返回 403；经面板自带网络进入的连接落在回环地址上，由 `X-Launcher-Token` 拦截。

## 联机穿透 `/api/frp`

面板仅代管固定版本的官方 `frpc`（`FRP_CLIENT_VERSION`）。用户提供自有 frp 服务器的地址、端口与令牌；请求不可提交可执行路径或原始配置。令牌只写不读，响应中仅含 `tokenSet`。本地转发始终指向 `127.0.0.1` 上实例的 `server-port`，不开放面板端口。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/frp/runtime` | `{ version, installed, platformSupported, archive }`。`archive` 为本机平台的官方压缩包 `{ name, sha256, url, maxBytes }`，平台不支持时为 `null` |
| POST | `/api/frp/runtime` | 从 GitHub 下载并校验固定版本的官方客户端；已安装时直接返回 |
| POST | `/api/frp/runtime/upload` | multipart 字段 `file`：上传用户自行下载的官方压缩包（可来自镜像）。仅在 SHA-256 与 `archive.sha256` 一致时安装，否则返回 400 `server.frp.uploadMismatch`；超过 `maxBytes` 返回 413 |
| GET | `/api/frp/endpoints` | 穿透服务器列表，不含令牌 |
| POST | `/api/frp/endpoints` | 创建。Body 见 `createFrpEndpointBodySchema` |
| PATCH | `/api/frp/endpoints/:id` | 更新。省略 `token` 或传空字符串表示令牌不变。成功后按新配置重新同步已启用的隧道 |
| DELETE | `/api/frp/endpoints/:id` | 删除。仍有实例以它启用联机时返回 **409**；已关闭的隧道设置随端点一并清除 |
| GET | `/api/instances/:id/tunnel` | 该实例的联机状态 `InstanceTunnel` |
| PUT | `/api/instances/:id/tunnel` | 保存并按当前实例状态启动或停止 `frpc` |
| GET | `/api/instances/:id/tunnel/friend-config` | 内网模式的玩家配置 `friend-frpc.toml`。文件含令牌，仅应交给要加入的玩家 |

`mode` 为 `public` 时，玩家直接连接公网端口，须提供 `remotePort`。`stcp` 经 frp 服务器中转，`xtcp` 在双方客户端之间打洞；这两种模式下，玩家在自己的电脑上以下载的配置运行官方 `frpc`，再连接本机 `127.0.0.1`。若 `server-ip` 指向某一块网卡，隧道不会启动。实例停止、崩溃或面板关闭时，对应的 `frpc` 随之退出。面板重启后不会恢复已消失的游戏进程，须重新启动实例。

## 虚拟局域网 `/api/lan`

面板仅代管固定版本的官方 EasyTier（`EASYTIER_VERSION`）。开启后，该实例加入专属于它的虚拟局域网，好友通过面板给出的一条锁定命令加入。请求不可提交可执行路径、原始配置或网络密钥；密钥由面板生成，仅出现在给好友的说明中，不出现在状态接口中。本地仅放行实例的 `server-port`，不开放面板端口，也不转发语音与查询所用的 UDP。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lan/runtime` | `{ version, installed, platformSupported, archive, needsAdmin, runsAsAdmin }`，`archive` 同上。`needsAdmin` 仅在 Windows 上、面板本身未以管理员身份运行时为 `true`（依 `whoami /groups` 的完整性级别判断，结果在进程存续期间保留，查询失败时会再试），此时 EasyTier 无法创建虚拟网卡。`runsAsAdmin` 仅在 Windows 上、面板以管理员身份运行时为 `true`，此时面板启动的服务器同样以管理员身份运行。其他系统或无法判断时，两者均为 `false`。 |
| POST | `/api/lan/runtime` | 从 GitHub 下载并校验固定版本的官方客户端；已安装时直接返回 |
| POST | `/api/lan/runtime/upload` | multipart 字段 `file`：上传用户自行下载的官方压缩包。仅在 SHA-256 一致时安装，否则返回 400 `server.lan.uploadMismatch` |
| GET | `/api/instances/:id/lan` | 该实例的虚拟局域网状态 `InstanceLan`。不含网络密钥；含 `peers`、`useSharedPeers`、`sharedPeers`、`listenPort` 和非阻断提示 `warning` |
| PUT | `/api/instances/:id/lan` | Body `{ enabled, peers?, useSharedPeers? }`。`peers` 最多 8 个，每个须为 `tcp://`、`udp://`、`ws://`、`wss://` 或 `quic://` 加主机与端口（ws/wss 可带结尾 `/`），服务端会规范化并去重；省略的字段保持原值。关闭共享节点且无自定义节点时返回 400 `server.lan.peersRequired` |
| GET | `/api/instances/:id/lan/friend` | 给好友的说明。含网络密钥，仅应交给一同游玩的人 |

面板端 EasyTier 每次启动时选取一个随机空闲端口，同时监听 TCP 与 UDP（EasyTier 自动补充同端口的 IPv6），供使用 IPv6 或处于同一局域网的好友直连；好友端仍不监听。连接须提供网络名与密钥（`private_mode`），且不为其他网络中转。Windows 上，面板在启动前添加名为 `MystryDashboard-LAN-<实例 id>` 的入站放行规则（游戏 TCP 端口仅限本实例的虚拟 IP；监听端口的 TCP 与 UDP 仅限面板启动的 easytier-core 程序，无法添加限定程序的规则时退回不限程序），并在停止、崩溃或面板关闭时按名称删除；无法添加时 `warning` 为 `server.lan.firewallFailed`。面板异常退出后残留的规则，会在下次面板启动时按本面板已知的实例 ID（有虚拟局域网记录或 `DATA_DIR/lan/<id>` 工作目录的实例）清理，此后停止、关闭虚拟局域网或删除实例时也会补删；不按 `MystryDashboard-LAN-` 前缀删除，以免误删其他面板的规则。

游戏未运行时客户端不启动，但仍返回已保存的开关与将使用的虚拟地址。若 `server-ip` 指向某一块网卡，虚拟局域网不会启动。实例停止、崩溃或面板关闭时，对应的 EasyTier 随之退出。Windows 上，面板与好友的命令均须以管理员权限运行，否则无法创建虚拟网卡。在 Windows 上创建失败时，`detail` 为 `server.lan.needsAdminWindows`，消息写明操作步骤：右键 `mdash.cmd`，选择「以管理员身份运行」，再在菜单中选择「重启面板」，然后重新启动服务器（重启面板会停止正在运行的服务器）。

## 节点 `/api/nodes`

阶段一仅保证本机节点 `local` 可用。创建远程节点受共享常量 `REMOTE_NODE_CREATION_ENABLED` 控制，目前处于关闭状态。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/nodes` | 节点列表 `NodeInfo[]` |
| GET | `/api/nodes/:id` | 单个节点 |
| POST | `/api/nodes` | 创建远程节点（当前返回 **403**） |
| PATCH | `/api/nodes/:id` | 重命名 |
| DELETE | `/api/nodes/:id` | 删除远程节点（本机节点不可删除；节点下有实例时拒绝） |
| POST | `/api/nodes/:id/secret/reset` | 重置密钥（当前返回 **403**） |

创建实例时传入非本机 `nodeId` 将被服务端拒绝（远程执行尚未开放）。

## 类型定义

完整 TypeScript 定义与请求体 JSON Schema 见 `packages/shared/src/index.ts` / `packages/shared/src/schemas.ts`。
