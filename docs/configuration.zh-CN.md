# 配置说明

[English](configuration.md) · **简体中文**

配置文件取决于启动入口，切勿混用两份配置：

| 启动入口 | 默认配置文件 | 首次配置 |
|---|---|---|
| 手动运行 `npm run dev:server` / `npm start` | 仓库根 `.env` | 复制 `.env.example` 并填写随机密钥 |
| Windows 源码 `mdash.cmd` | 仓库根 `.env`（可由 `MYSTRY_CONFIG_PATH` 修改） | 管理器从 `.env.example` 创建，密钥由 mdash 生成或修复 |
| Linux / WSL 源码 `mdash.sh` | 仓库根 `config/panel.env` | 跨平台控制器自动生成 |
| 便携版 `mdash` | 包根 `config/panel.env` | 跨平台控制器自动生成 |

表中为默认值，覆盖这些路径的变量见下方环境变量表。请保留已有配置，不要以模板再次覆盖。Windows PowerShell 中使用 `npm.cmd`。

## 首次启动必需配置

首次启动前须配置：

- `JWT_SECRET`：64 位十六进制字符串，用于 JWT 签名。
- `SETUP_TOKEN`：64 位十六进制字符串，用于首次初始化请求的 `X-Setup-Token` 请求头。管理器自动生成该值，并在创建管理员后移除；仅手动运行时须自行配置。
- `LAUNCHER_TOKEN`：`mdash` 自动生成的独立本机关闭令牌；手动运行且不使用管理器时可不配置。

已配置的各项密钥须使用互不相同的随机值。可用以下 Node.js 命令生成；文档与模板均不提供可用的固定密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`POST /api/auth/setup` 仅在用户表为空时可用，且请求须携带 `X-Setup-Token: <SETUP_TOKEN>`。页面操作见 [初始化管理员](getting-started.zh-CN.md#初始化管理员)。管理员创建后，可从当前入口实际使用的配置文件中移除 `SETUP_TOKEN` 并重启面板；已有用户登录无需此令牌。若用户表为空且未配置 `SETUP_TOKEN`，面板将无法启动。

## 环境变量

以字节或毫秒为单位的限制，表中均已标明；`MiB` 按 `1024 × 1024` 计算。

### 基础与认证

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | Fastify 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `JWT_SECRET` | 无；初次启动前必填 | 64 位十六进制 JWT 签名密钥，切勿使用固定示例值 |
| `SETUP_TOKEN` | 无；首次初始化前必填 | 64 位十六进制初始化令牌；初始化完成后可移除 |
| `LAUNCHER_TOKEN` | 无；使用 `mdash` 时自动生成 | 64 位十六进制本机关闭令牌；仅限回环地址使用 |
| `CORS_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | 精确 CORS 来源白名单，逗号分隔，不得填写 `*` |
| `RATE_LIMIT_MAX` | `120` | 普通请求限流窗口内的最大次数 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 普通请求限流窗口，毫秒 |
| `AUTH_RATE_LIMIT_MAX` | `10` | 登录失败、初始化与本机关闭请求在窗口内的最大次数；登录成功即清除该用户名与 IP 的失败计数 |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `300000` | 认证限流窗口，毫秒 |
| `CONSOLE_TICKET_TTL_SECONDS` | `60` | 控制台 ticket 有效期；每个 ticket 仅可建立一次 WebSocket 连接 |
| `FILE_DOWNLOAD_TICKET_TTL_SECONDS` | `60` | 文件下载 ticket 有效期；每个 ticket 仅可下载一次 |

登录有效期不再由 `JWT_EXPIRES_IN` 设置（即使写入也不生效，启动时将给出提示），改为在「面板设置」页选择，默认 12 小时，见 [登录有效期](user-guide.zh-CN.md#登录有效期)。

### HTTP、文件与上传生命周期

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_REQUEST_TIMEOUT_MS` | `900000` | 普通接口的 HTTP 请求接收超时，15 分钟；已认证的流式上传改为受 `UPLOAD_IDLE_TIMEOUT_MS` 空闲超时约束 |
| `HTTP_CONNECTION_TIMEOUT_MS` | `300000` | HTTP 连接超时，5 分钟 |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `72000` | HTTP keep-alive 空闲超时，72 秒 |
| `UPLOAD_IDLE_TIMEOUT_MS` | `30000` | 上传空闲超时，30 秒；持续无数据的上传将被取消 |
| `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` | `60000` | 文件下载空闲超时，60 秒；超时即关闭下载并释放并发资源 |

### JSON、并发与任务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_JSON_BODY_BYTES` | `1048576` | JSON 请求体上限，1 MiB |
| `MAX_CONCURRENT_UPLOADS` | `1` | 同时处理的上传数上限 |
| `MAX_CONCURRENT_FILE_DOWNLOADS` | `4` | 同时处理的文件下载数上限 |
| `MAX_CONCURRENT_TASKS` | `1` | 同时执行的部署 / 导入任务数上限 |
| `MAX_QUEUED_TASKS` | `2` | 等待执行的任务数上限 |
| `TASK_TIMEOUT_MS` | `1800000` | 单个任务超时，30 分钟 |
| `BACKUP_TASK_TIMEOUT_MS` | `21600000` | 备份与还原任务超时，6 小时；还原前的备份与解压计入同一任务 |
| `IMPORT_PREVIEW_TTL_SECONDS` | `1800` | 待确认 ZIP 导入预览的有效期，默认 30 分钟 |
| `MAX_IMPORT_PREVIEWS` | `2` | 全局同时保留的待确认 ZIP 预览上限；每个登录用户最多一个 |

部署与导入任务同时受并发数与队列长度限制。达到 `MAX_CONCURRENT_TASKS` 后，新任务排队等待；队列已满时，请求返回 **429**。任务开始后运行超过 `TASK_TIMEOUT_MS` 即判为失败并清理。面板重启不续跑未完成的任务，而是在启动时将其标记为失败，并清理已创建的半成品实例。

文件下载受 `MAX_CONCURRENT_FILE_DOWNLOADS` 限制；并发槽位已满时，文件下载请求返回 **429**。下载在 `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` 内无数据活动即被关闭，并释放所占的下载并发资源。

### 核心、Installer 与文本/控制台

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_CORE_DOWNLOAD_BYTES` | `536870912` | 单个核心下载上限，512 MiB |
| `CORE_DOWNLOAD_TIMEOUT_MS` | `60000` | 核心与运行时下载停滞超时，60 秒；只要数据持续流入就会重置计时 |
| `MAX_CORE_METADATA_BYTES` | `2097152` | 核心版本、构建等元数据响应上限，2 MiB |
| `CORE_METADATA_TIMEOUT_MS` | `15000` | 核心元数据请求超时，15 秒 |
| `MAX_INSTALLER_OUTPUT_BYTES` | `65536` | 安装器输出的保留上限，64 KiB |
| `INSTALLER_KILL_GRACE_MS` | `5000` | 安装器取消或超时后、强制结束前的宽限期，5 秒 |
| `MAX_TEXT_FILE_BYTES` | `1048576` | 在线读取或编辑的文本文件上限，1 MiB |
| `MAX_COMMAND_BYTES` | `4096` | 单条控制台命令上限，4 KiB |
| `MAX_CONSOLE_BUFFER_BYTES` | `1048576` | 控制台历史缓冲上限，1 MiB |
| `MAX_CONSOLE_CHUNK_BYTES` | `65536` | 单个控制台输出块上限，64 KiB |
| `MAX_CONSOLE_INCOMING_BYTES` | `4352` | 单个 WebSocket 入站消息上限，包含消息协议开销 |
| `MAX_CONSOLE_CONNECTIONS` | `20` | 控制台 WebSocket 最大并发连接数 |
| `MAX_CONSOLE_COMMANDS_PER_WINDOW` | `60` | 每个命令限流窗口内可发送的控制台命令数上限 |
| `CONSOLE_COMMAND_WINDOW_MS` | `60000` | 控制台命令限流窗口，60 秒 |
| `MAX_CONSOLE_STDIN_BYTES` | `65536` | 写入实例 stdin 的待处理输入缓冲上限，64 KiB |

超出连接数或缓冲容量时，新连接将被拒绝或暂缓读取；超长或超出速率限制的命令不会写入实例。

### 上传、ZIP 解压与同机目录交接

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_UPLOAD_BYTES` | `536870912` | 单个上传文件上限，512 MiB |
| `MAX_BACKUP_UPLOAD_BYTES` | `107374182400` | 上传备份文件的上限，100 GiB（与 `MAX_EXISTING_IMPORT_BYTES` 对齐，确保面板创建的备份可直接回传） |
| `MAX_ZIP_ENTRIES` | `10000` | ZIP 条目数上限 |
| `MAX_ZIP_ENTRY_BYTES` | `1073741824` | 单个解压条目上限，1 GiB |
| `MAX_ZIP_UNCOMPRESSED_BYTES` | `2147483648` | ZIP 解压后总大小上限，2 GiB |
| `MAX_ZIP_CENTRAL_DIRECTORY_BYTES` | `33554432` | ZIP central directory 上限，32 MiB |
| `MAX_EXISTING_IMPORT_ENTRIES` | `200000` | `DATA_DIR/imports` 单次目录交接的文件和目录条目上限 |
| `MAX_EXISTING_IMPORT_BYTES` | `107374182400` | `DATA_DIR/imports` 单次目录交接的文件总大小上限，100 GiB |
| `MOD_LOADER_PRECHECK_MAX_DEPTH` | `4` | 已有服务端来源列表接口中 ModLoader args 预检的最大目录深度 |
| `MOD_LOADER_PRECHECK_MAX_ENTRIES` | `200` | 同上，最大遍历条目数 |
| `MOD_LOADER_PRECHECK_TIMEOUT_MS` | `250` | 同上，最大耗时（毫秒） |
| `MOD_LOADER_SCAN_MAX_DEPTH` | `64` | 导入/部署任务中 ModLoader args 深度扫描的最大目录深度 |
| `MOD_LOADER_SCAN_MAX_ENTRIES` | `50000` | 同上，最大遍历条目数 |
| `MOD_LOADER_SCAN_TIMEOUT_MS` | `30000` | 同上，最大耗时（毫秒） |

普通文件或 ZIP 上传超过 `MAX_UPLOAD_BYTES` 时返回 **413**；上传并发槽位已满时返回 **429**。ZIP 还须通过条目数、单条目大小、解压总大小与 central directory 的配额校验。

ZIP 导入的预检结果暂存于 `uploads/.tmp-import-preview-*`，按登录用户隔离，`IMPORT_PREVIEW_TTL_SECONDS` 后过期，面板重启时全部删除；全局预览数已满时返回 **429**。

`MAX_EXISTING_IMPORT_*` 限制单次文件夹导入的规模，浏览器上传与从 `imports` 复制的文件夹均适用；导入前的其他检查见 [上传文件夹](user-guide.zh-CN.md#上传文件夹) 与 [从 imports 文件夹复制](user-guide.zh-CN.md#从-imports-文件夹复制)。浏览器上传的文件夹在确认或取消前存放于 `uploads/.tmp-folder-upload-*`，有效期与全局数量沿用 ZIP 预览的 `IMPORT_PREVIEW_TTL_SECONDS`、`MAX_IMPORT_PREVIEWS`；遗留文件于面板启动时清除。

### 数据目录

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATA_DIR` | `data` | 数据根目录；相对值相对于仓库根目录解析，也可填写绝对路径 |
| `MYSTRY_HOME` | 源码为仓库根目录；便携版为包根目录 | 运行布局根目录；须在 Node 启动前由进程环境设置 |
| `MYSTRY_CONFIG_PATH` | 源码为 `.env`；便携版为 `config/panel.env` | 配置文件路径；相对值相对于 `MYSTRY_HOME` |
| `MYSTRY_DATA_DIR` | 未设置时使用 `DATA_DIR` | 优先级高于 `DATA_DIR`；相对值相对于 `MYSTRY_HOME` |
| `BACKUP_DIR` | `DATA_DIR/backups` | 实例备份目录；相对值相对于 `MYSTRY_HOME`。可置于其他磁盘，但不得位于 `instances`、`imports`、`uploads` 或 `.mystry-staging` 之内，也不得包含整个数据目录 |

### 启动器语言

`mdash.cmd`、`mdash.sh` 与 `mdash` 的菜单与提示跟随系统语言：系统语言为中文时显示中文，其余语言均显示英文。Windows 依据显示语言，Linux / macOS 依次读取 `LC_ALL`、`LC_MESSAGES`、`LANG`。此设置仅作用于启动器，不影响 Web 界面与面板日志。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSTRY_LANG` | 跟随系统 | 设为 `zh-CN` 或 `en-US` 可固定启动器语言；以 `zh` 开头即为中文，其余均按英文处理 |

`DATA_DIR` 下的运行时结构为：

| 路径 | 说明 |
|------|------|
| `panel.db` | SQLite 数据库（用户、实例、任务） |
| `db-backups/` | 每次结构升级前留存的 `panel.db` 副本，命名为 `panel-<UTC 时间>-v<升级前的结构版本>.db`；仅保留最近 5 份 |
| `instances/` | 实例唯一托管根目录 |
| `instances/<id>/` | 对应实例的全部文件、jar 和工作目录 |
| `imports/<目录名>/` | 同机已有服务端交接区；仅作为复制源，并非实例工作目录 |
| `cache/cores/` | 核心 jar 下载缓存 |
| `uploads/` | 上传临时目录；`.tmp-import-preview-*` 为不跨重启保留的待确认 ZIP |
| `backups/<id>/` | 实例备份（未设置 `BACKUP_DIR` 时）：每份备份由一个 `.tar.gz` 与同名 `.json` 元数据组成 |

无论最终数据目录来自 `MYSTRY_DATA_DIR` 还是 `DATA_DIR`，实例始终只能位于该目录的 `instances/<id>`。部署、导入、创建与启动均使用这一目录；不支持自定义实例安装目录，也不提供在整台机器上选择目录的功能。实例文件 API 中的路径仅为相对于该实例根目录的逻辑路径。

**符号链接**：若数据目录或备份目录的上级文件夹是符号链接或目录联接（例如 `/home` 本身即为链接的 Linux 发行版），面板读取配置时将其解析为真实位置。数据目录本身及其中的内容均不得为链接，否则面板将拒绝操作实例。

**权限**：在 Linux/macOS 上，面板启动时创建数据根及 `instances`、`imports`、`uploads`、`.mystry-staging`、`.mystry-panel-lock` 等目录，并校验其权限为 `0700`，`panel.db` 及其 WAL/SHM 文件为 `0600`。若已有目录对 group/other 可访问，默认拒绝启动；设置 `MYSTRY_REPAIR_DATA_PERMISSIONS=1` 可在启动时自动收紧权限。在 Windows 上，`mdash` 会通过 `icacls` 重置 ACL、移除继承，并将 `config`（源码模式为 `.env`）、`data`、`logs` 限制为仅当前用户、`SYSTEM` 与 `Administrators` 可访问，显式授予其他账户的条目也一并清除；改写范围限于上述顶层路径及已存在的密钥与数据库文件，其下内容经继承取得相同权限。若权限收紧失败（例如非 NTFS 分区）会打印警告。服务端启动时也会通过 `icacls` 检查 `DATA_DIR` 的 ACL，检测到其他本机账户有访问权限或无法验证时，将在控制台与日志中输出可见警告（不阻断启动）。`db-backups` 在首次留存副本时创建，权限要求相同，每份副本为 `0600`。

**结构升级**：`panel.db` 自身记录结构版本。新版面板需要升级结构时，先将数据库复制到 `db-backups/`，再逐步执行，每一步各在一个事务中完成；某一步失败即回滚，面板拒绝启动并指明该步骤。数据库若已被更新版本的面板升级，面板同样拒绝启动，并列出两个版本号。若要换回某份副本：先停止面板，将 `panel.db` 及可能存在的 `panel.db-wal`、`panel.db-shm` 移出数据目录，再将 `db-backups/` 中选定的文件复制为 `panel.db`。副本留存之后的改动不在其中。副本与数据库一样含有账号与密钥。

`MYSTRY_HOME` 与 `MYSTRY_CONFIG_PATH` 决定配置文件的位置，因此配置文件无法改变自身的加载位置；须在启动前经由 `mdash`、shell 或进程环境设置。便携版用户通常无需手动设置这些变量。

## npm 下载源

源码启动器安装依赖时所用的下载地址。便携版自带依赖，无需设置。

```powershell
.\mdash.cmd mirror
.\mdash.cmd mirror npmmirror
```

第一条命令查看当前选择与可选项，第二条执行切换。Linux / WSL 使用 `./mdash.sh mirror`；在 Windows 上双击 `mdash.cmd` 后，也可在菜单中选择。

| 名称 | 下载地址 | 说明 |
|------|----------|------|
| `default` | npm 自身配置 | 默认值，启动器不额外指定地址 |
| `official` | `https://registry.npmjs.org/` | npm 官方，国际 |
| `npmmirror` | `https://registry.npmmirror.com/` | 中国大陆 |
| `tencent` | `https://mirrors.cloud.tencent.com/npm/` | 腾讯云，中国大陆 |
| `huawei` | `https://repo.huaweicloud.com/repository/npm/` | 华为云，中国大陆 |

选择保存于仓库根目录的 `config/npm-mirror`，该文件不受 Git 跟踪。切换后，下次安装依赖时生效；运行 `rebuild` 可立刻重装。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSTRY_NPM_MIRROR` | 未设置 | 临时指定下载源，优先于保存的选择，取值同上 |

切换下载源不影响安装结果：`package-lock.json` 仅记录官方地址，npm 安装时替换为所选的源，下载内容仍按锁文件中的 `integrity` 校验。

## 安全建议

1. 面板默认仅绑定回环地址，其他设备无法访问。如需从手机或另一台电脑访问，在面板中点击 **其他设备**（或运行启动器的 `remote on`）开启，无需修改 `HOST`，也无需重启。步骤见 [在其他设备上打开面板](user-guide.zh-CN.md#在其他设备上打开面板)。
2. 开启后，凡能连接到这台电脑的设备均可打开登录页，登录本身即是防护，因此请使用强密码。以下两项安全选项可按需选择：
   - **使用 HTTPS**（默认开启）：连接经过加密。证书由面板自行签发，浏览器首次访问时会提示不安全，点击「高级」→「继续前往」即可；如需确认连接的是正确的面板，可核对弹窗中的证书指纹。关闭后不再出现警告，但同一网络或公网上能抓包的人均可读取密码。
   - **只允许同一网段的设备**（默认关闭）：仅与这台电脑处于同一网络的设备可打开面板。面板运行于云服务器时，开启此项将使你自己的电脑也无法连接。
3. 如不希望直接开放端口，可使用同一弹窗中的 **虚拟组网**，或 SSH 端口转发（`ssh -L 3000:127.0.0.1:3000 用户@服务器`，随后在自己的电脑上打开 `http://127.0.0.1:3000`）。也可自行架设反向代理（Nginx / Caddy）；但代理与面板位于同一台机器时，面板所见的来源均为 `127.0.0.1`，登录失败限流会将所有人计为同一来源。
4. `JWT_SECRET` 与 `SETUP_TOKEN` 须使用不同的随机值；初始化成功后移除 `SETUP_TOKEN`。
5. 管理员须使用至少 12 位的强密码；面板具备实例文件读写与进程执行能力。
6. 实例默认使用系统默认 Java（PATH 中的 `java`）；也可在部署页或实例设置中绑定经面板扫描并验证的运行时 ID。扫描时会对每个候选执行 `-version`，因此 `JAVA_HOME` 与常见安装目录须由受信任的本机管理员控制；请求不得提交 Java 路径。
7. Paper 下载请求附带合规的 User-Agent；请遵守各核心分发方的使用条款。

## 前端开发代理

开发模式下，`apps/web/vite.config.ts` 配置以下代理：

- `/api` → `http://127.0.0.1:3000`
- `/ws` → `ws://127.0.0.1:3000`

若本机 3000 端口被系统保留或无法绑定，可在运行 `npm run dev:web` 前设置环境变量 `MYSTRY_DEV_API_PORT`（PowerShell 示例：`$env:MYSTRY_DEV_API_PORT = "3100"`），使代理指向面板实际监听的端口；面板本身须已在该端口监听（由 `PORT` 决定）。该变量仅影响 Vite 开发代理的目标端口，不影响面板自身的监听与配置。

生产构建后，由后端 `@fastify/static` 提供静态文件，无需 Vite。`npm run build -w @mystry/web` 在 `vite build` 之后为文本资源生成 `.br` / `.gz` 预压缩副本，后端依据浏览器的 `Accept-Encoding` 直接发送；带 hash 的 `/assets/*` 可由浏览器缓存一年，`index.html` 每次均重新校验，升级后刷新即可获取新版本。反向代理无需再次压缩这些资源。
