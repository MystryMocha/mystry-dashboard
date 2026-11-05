# Changelog

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 「本机环境」页新增下载来源设置，可选官方来源（默认）或国内镜像，保存后立即生效。国内镜像下 Vanilla、Forge、NeoForge 和版本列表走 BMCLAPI，frp 和 EasyTier 走公共 GitHub 镜像，失败时自动改用官方来源；Paper 和 Fabric 的服务端文件仍走官方。`panel_settings` 表在启动时自动创建，无需手动迁移。
- 部署页和联机客户端安装提示显示当前下载来源；下载进度显示正在使用的来源。
- Vanilla、Paper、Forge、NeoForge 的下载现在按官方校验值核对，不符的文件不会进入缓存。

### Changed

- 官方来源下 Forge 版本列表改用 `files.minecraftforge.net`，NeoForge 版本列表只用 `maven.neoforged.net`，不再访问第三方的 BMCLAPI。

### Fixed

- Forge 的默认版本现在总是最新构建。原来按 BMCLAPI 返回的顺序取，可能选到旧一点的构建。
- Forge 1.7.10 等带分支后缀的旧版本能拼出正确的安装器地址。
- Windows 上安装 frp 客户端不再依赖系统 `tar`。原来 `PATH` 里排在前面的是 Git 带的 GNU tar 时（例如从 Git Bash 启动），下载成功后会解压失败。
- NeoForge 的 Minecraft 版本现在显示正确：26.3 不再显示成 1.26.3，26.1.2 也能单独选择，国内来源能列出对应的构建，新部署的实例记录和 Java 推荐随之正确。部署页只列正式版，快照和愚人节版不再混入。
- NeoForge 在国内来源下留空构建时总是取最新构建。原来按 BMCLAPI 返回的顺序取，1.21 会选到 21.0.98-beta。
- 部署页的版本下拉在桌面宽度下能用鼠标滚轮选到全部选项。原来首屏 10 项放不满面板，没有滚动条，只有键盘能加载后面的版本。

## [0.2.0-preview.3] - 2026-11-05

### Changed

- 接口错误响应改为 `{ error, code, params }`：`error` 为英文文本（原来是中文），`code` 是 `server.*` 消息键。直接读取 `error` 的脚本会看到英文；实例操作冲突（409）的 `code` 由 `INSTANCE_OPERATION_CONFLICT` 改为具体的消息键。任务的 `message` / `error` 同样改为英文，并新增 `messageI18n` / `errorI18n`；`tasks` 表启动时自动新增两列，无需手动迁移。
- 一键部署默认选中 Paper 和最新正式版；Build、Loader、Installer 改为可选，留空时由服务端取最新（Paper 优先稳定构建）。部署页右侧的实现说明卡改为新手指引，说明怎么选核心和部署后怎么进服。
- 部署、导入、创建空实例三个入口的 EULA 同意默认不勾选；部署必须主动勾选才能开始。
- 界面文案去掉内部术语：「节点监控」改为「本机环境」，去掉远程集群锁定卡；「同机目录交接」改为「从本机文件夹导入」；「PATH 中的 java」改为「系统默认 Java」；「堆内存上限 (Xmx)」改为「最大内存」等。导入与部分启动错误提示同步改写。
- 初始化页说明令牌已由启动器复制到剪贴板，并写明各配置文件的位置；设置密码时提示长度要求，并说明无法找回密码。
- 「第一次开服」教程改为按便携版和启动器的实际流程编写，新增 Java 版本对照表和看到 `Done` 再进服的说明。
- 统一界面与错误信息的叫法，术语表写入 `CONTRIBUTING.md`：「任务队列」「后台异步任务中心」统一为「任务中心」，「指令」统一为「命令」，所有 401 统一提示「登录已失效，请重新登录」；ZIP、链接、凭证、临时目录相关的错误信息不再夹带 entry、symlink/junction、ticket、staging marker 等英文术语。部署按钮改为「开始部署」，去掉「请耐心等待」「敬请期待」等措辞；标点、引号统一为全角与「」，内存单位统一为 MiB / GiB。
- Windows 源码启动器 `PanelManager.cmd` 改为只负责检查 Node、安装依赖和构建，启停、状态、日志交给 `mystryctl`，与 Linux 的 `PanelManager.sh` 一致（脚本从约 1200 行减到约 340 行）。配置仍是仓库根目录的 `.env`，不用迁移；日志从 `data/launcher/logs/` 改到仓库根目录的 `logs/`。升级前请先停止正在运行的面板。三个入口的命令清单按同一顺序列出，Windows 补上 `open` 和 `help`。菜单和日志输出去掉 `=====` 分隔线，`logs` 的分节标题改为「最近的错误输出」「最近的标准输出」。
- 文档整理：同一件事只在一处写全，其他地方改为链接。从本机文件夹导入、旧版实例接管、控制台限制、Java 版本对照表、数据目录结构各保留一份正文；使用指南和教程去掉接口路径、HTTP 状态码、内部模块名等实现细节，部署与导入的内部流程移到 `docs/architecture.md`。按实际界面修正了侧栏、Tab 和按钮名称（如「导入服务端」「参数配置」「接管托管目录」）、文件页的编辑方式，以及总览刷新间隔（5 秒）。
- 根 README 改为英文默认，中文版移至 `README.zh-CN.md`；两份都补上备份与还原，去掉过时的「没有备份功能」说明。
- GitHub Release 正文和便携包内 `README.txt` 改为中英双语，英文在前。此前只有中文。
- 便携说明 `docs/portable-release.md` 改为英文，中文版移至 `docs/portable-release.zh-CN.md`。
- Linux `PanelManager.sh rebuild` 改为和 Windows 相同的顺序：先安全停止面板，再强制重新安装依赖、构建，然后启动。此前它在面板运行时直接构建再重启，也不会重新安装依赖。
- 发布冒烟不再固定中文界面，只看退出码、文件、健康检查和日志内容，界面语言不影响发布结果。
- `package-lock.json` 只记录官方下载地址，`npm run verify` 会检查这一点；本机 npm 配了镜像时用 `npm run lockfile:fix` 改回。
- README 补上联机功能和使用前提，改正配置文件位置（便携版和 Linux 源码是 `config/panel.env`，Windows 源码是 `.env`）。

### Added

- 实例页新增「备份」分段：一键备份整个服务器目录（世界、配置、mods、plugins），运行中也能备份，面板会先暂停自动保存并把世界写入磁盘，完成后恢复。备份可下载、上传、删除；还原前需停服，默认先自动备份当前文件，备份经逐文件校验后才替换实例目录，中途失败或面板退出都会恢复原目录。备份默认存于 `DATA_DIR/backups/`，可用新变量 `BACKUP_DIR` 指定目录，上传上限由 `MAX_BACKUP_UPLOAD_BYTES`（默认 10 GiB）控制。备份或还原期间不能启动、重启、删除该实例；还原期间不能修改其文件。还原后若备份里的服务端 jar 与当前不同，面板记录的服务端文件、核心类型和版本会改回备份时的值。删除实例时默认连同它的备份一起删除，可在确认框里选择保留。备份与还原任务的时限由新变量 `BACKUP_TASK_TIMEOUT_MS`（默认 6 小时）控制。备份不包含账号、面板中的其他实例设置，以及运行时被锁住的 `session.lock`。
- Web 界面支持英文、简体中文和繁體中文，英文为默认语言。工具栏和登录页右上角新增「语言」按钮，可选自动（浏览器是繁体中文显示繁體中文，其他中文显示简体中文，其他语言显示英文）、English、简体中文或繁體中文，选择保存在本浏览器；从旧版本升级且浏览器为中文时仍显示中文。数字、日期和文件大小按所选语言格式化。服务端返回的错误信息、部署/导入任务进度和控制台错误也随界面语言显示：接口错误改为 `{ error, code, params }`，`error` 默认英文；升级前创建的任务仍显示原来的中文。
- `PanelManager.cmd`、`PanelManager.sh` 和 `mystryctl` 的菜单与提示按系统语言显示：中文系统显示中文，其他系统显示英文；可用环境变量 `MYSTRY_LANG=zh-CN` / `en-US` 固定。此前 Linux 源码版和便携版只有中文。
- 侧栏「部署与维护」新增「联机」（排在「本机环境」前面）：先选择实例，再用分段在「虚拟局域网」和「frp 穿透」之间切换，一次只显示一种，切换不会改掉另一种已保存的设置。两种方式都只转发这个实例的游戏端口，不会暴露面板本身，也不会要求填写程序路径；游戏没在运行、或 `server.properties` 把 `server-ip` 写成了某一块网卡时不会启动。
  - **虚拟局域网**：不需要公网 IP 或注册账号。面板下载钉死版本的官方 EasyTier，把实例放进一个私有虚拟局域网；朋友复制或下载一条锁定命令，用管理员权限运行后按显示的虚拟地址加入。网络密钥只出现在给朋友的说明里。
  - **frp 穿透**：用你自己的 frp 服务器。面板下载钉死版本的官方 frp 客户端；公网模式下朋友直接添加显示的地址，内网模式下把下载的配置发给朋友，对方用官方客户端打开后连接自己的 `127.0.0.1`。
- 源码启动器新增 `mirror` 命令，Windows 菜单里也能选：安装依赖时可以跟随 npm 自身配置，或使用 npm 官方、npmmirror、腾讯云、华为云。

### Removed

- Windows 源码启动器去掉 `--lang` 参数和菜单中按 `L` 切换语言；改为自动跟随系统语言，需要固定时设置 `MYSTRY_LANG`。
- 删除截图展示：产品介绍页 `docs/product-intro/` 与其中 8 张界面截图一并移除，README 和文档中心不再链接「界面导览」；界面说明以 [使用指南](docs/user-guide.md) 为准。
- 删除 `docs/wiki/` 导航页（内容都是指向正文的链接，与 `docs/README.md` 重复），以及产品介绍的 PDF、生成脚本 `build-pdf.py` 和旧截图。
- 删除旧的一阶段 ZIP 导入接口 `POST /api/import`。Web 早已改用「上传预检 → 确认配置」的 `/api/import/previews` 流程；直接调用旧接口的脚本需要改走预览流程，否则会收到 404。

### Fixed

- 前台启动（`foreground`）时在终端按 Ctrl+C，面板会被直接结束，跳过任务清理、实例停止和释放数据目录锁。终端会把 Ctrl+C 发给面板和启动器，启动器又转发一次，面板收到第二次信号时已经移除了处理器。现在关闭途中的重复信号会被忽略，连按 Ctrl+C 时启动器也会等面板关完再退出；Windows 上启动器不再转发 Ctrl+C（Node 在 Windows 上转发等于强制结束进程）。
- 浏览器开着面板时停止面板，偶尔会卡在最后一步：实例已停、端口已关，但面板进程不退出，数据目录锁也不释放，要关掉浏览器标签页才结束。关闭流程会一直等浏览器残留的连接断开。现在最多等 5 秒，之后强制断开剩余连接并完成关闭，日志会记一条「等待连接断开超时，已强制断开剩余连接」。
- 同一个核心的下载被所有等待的任务取消后，紧接着开始的新部署不会再被误报为「任务已取消」。此前旧下载收尾期间，新任务会加入这次已中止的下载，拿到前一批任务的取消原因。
- Windows 批处理（`PanelManager.cmd`、便携版 `mystryctl.cmd` 等）检出时改为 CRLF 行尾。此前所有文本文件统一为 LF，cmd.exe 读 LF 行尾的批处理时，跳转标签和多字节字符可能错位，把半行内容当命令执行。仓库里仍按 LF 存储，已有的本地仓库需要删掉这几个 `.cmd` 后重新检出（`git checkout -- <文件>`）才会生效。
- 在 PowerShell 7 终端里运行 `PanelManager.cmd start` 不再报「Get-FileHash 无法识别」后退出。此前 Windows PowerShell 5.1 会沿用 PowerShell 7 的模块路径，加载到不兼容的模块；从资源管理器双击或在 cmd 里运行不受影响。
- 一键部署 Paper 时指定的构建号不存在，现在任务会失败并提示「Paper <版本> 没有构建 #<号>」；此前会悄悄改装最新构建。
- `mystryctl` 现在和服务端一样读取配置文件里的 `DATA_DIR` / `MYSTRY_DATA_DIR`；此前它总是把数据目录定为 `data`，配置文件里改了数据目录也会被覆盖。配置值两侧的引号也按 dotenv 的规则去掉。
- `mystryctl` 的配置备份改放到数据目录下的 `launcher/config-backups/`，不再写到配置文件旁边的 `backups/`。
- 页面不再从 Google Fonts 加载字体，改用系统字体栈，离线或国内网络下首屏不再被外部样式阻塞。
- 主按钮、当前标签与任务徽标的文字改用各主题的 `--on-accent`，修复 Grok 暗色主题下白字配浅色背景看不清的问题。
- 打开文件很多的目录（如 `world/region`）时，文件列表不再逐项重复校验整条路径；此前 300 个文件约需 1 秒，期间会阻塞其他请求。
- 文件页不再列出实例根目录的面板标记文件 `.mystry-instance.json`；此前它带着编辑、重命名、删除按钮，但点了都会被服务端拒绝。
- 双击便携版 `mystryctl.cmd` 时，菜单命令执行完或出错后窗口会停住，按回车再关闭，不再一闪而过、看不到令牌提示和错误信息。带参数的命令行调用不受影响。
- 已识别为 Java 25 的运行时现在可以选择 G1 均衡和 Paper Aikar 预设，便携版启动器也不再对 Java 25 报兼容性警告。此前 MC 26.x 推荐 Java 25，但这两处只认 Java 8、17、21。
- 1.13 及更早的服务端：参数配置把数字形式的难度和游戏模式显示成第一项，保存后又被服务端重置。现在读取时转成名称，写回时保持数字，这类实例的默认配置也改用数字。
- 服务器简介等文字里的中文在旧版服务端上变成乱码：写入时改用 `\uXXXX`。

### Performance

- 前端构建后生成 `.br` / `.gz` 预压缩资源，服务端按 `Accept-Encoding` 直接发送；带 hash 的 `/assets/*` 设为一年 `immutable` 缓存，`index.html` 每次重新校验。

### Security

- `react-router-dom` / `react-router` 从 6.30.4 升到 6.30.6，修复 6.30.2–6.30.5 的开放重定向导致 XSS 公告（GHSA-jjmj-jmhj-qwj2）。仍留在 6 系。
- `@fastify/static` 升到 10.1.10，随之把 `glob` 升到 14.0.3、`minimatch` 升到 11.0.4，消除 AbortSignal 取消绕过（GHSA-3g3m-2fjr-6pw4）与 globparts 放大拒绝服务（GHSA-g3hv-75wg-m249）两条公告。
- 生产依赖审计剩余 2 条 moderate，都来自 React Router 6 系、只在 7.18 以上修复（反斜杠开放重定向 GHSA-wrjc-x8rr-h8h6、SSR hydration 构造注入 GHSA-337j-9hxr-rhxg）；本面板不用 SSR，导航目标都是站内固定路径或服务端生成的实例 ID，作为残余风险记录在 [便携预览版](docs/portable-release.md)。开发依赖 `vitest` 3 系的 `tinypool` critical 公告不进入发布包，升级需跨大版本，本次未处理。

## [0.2.0-preview.2] - 2026-10-21

### Changed

- 品牌更名为 **Mystry Dashboard**（不再绑定 Minecraft，为后续支持其他游戏服务端预留）。根包名改为 `mystry-dashboard`，健康检查 `service` 同步改名；缩写 MMD 全部改为 mystry：工作区包 `@mystry/*`、便携控制器 `mystryctl`、环境变量 `MYSTRY_HOME` / `MYSTRY_CONFIG_PATH` / `MYSTRY_DATA_DIR` 等、数据目录内 `.mystry-staging` / `.mystry-panel-lock`、浏览器存储键 `mystry_*`、发布文件 `mystry-v*` 与 `mystry-release-signing-key.asc`。不保留旧名称兼容：已有 `.env` 中的 `MMD_*` 需手动改名，旧数据目录里遗留的 `.mmd-*` 目录不会再被识别或清理。

### Added

- Web 文件页：普通文件流式下载（一次性 download ticket + `Content-Disposition`）与同目录重命名入口
- 实例详情与总览操作栏：强制停止（`ConfirmDialog` + `stop?force=1`）
- 总览「创建空实例」入口：创建 custom 实例并跳转文件页上传 Jar
- `server.properties` 保留式文档模型与原子写入；Paper/Fabric 核心缓存键基于解析后的不可变版本

### Fixed

- 数据目录锁与实例/暂存/上传/缓存等子目录在 Unix 上显式 `0700`（此前受 umask 影响为 `755`，会触发权限门禁拒绝启动），`owner.json` 显式 `0600`。
- CI 覆盖缺口：根 `verify` 并入批次 A–F 回归测试（数据锁、任务恢复、进程生命周期、文件/下载路由等）；同步修正过期的 Beta 门禁知识库文档。
- 文件下载：占槽/开流失败时归还未过期 download ticket；前端用新标签页触发下载，避免错误 JSON 冲掉 SPA
- 已有服务端来源列表改为有界 ModLoader 预检；任务中心轮询失败时标注状态可能已过期
- 部署表单与移动抽屉可访问性（标签关联、LazyScrollSelect 键盘、焦点陷阱）
- `mmdctl` 包装脚本尊重用户已设置的 `MMD_HOME`

### Security

- 2026-10-21 官方 registry 生产依赖审计为 0 critical、0 high、2 moderate。通过 `npm audit fix` 升级传递依赖 `fastify`（5.12.7）、`fast-jwt`（6.3.5）、`@fastify/busboy`（3.2.3）、`fast-uri`（3.1.9 / 4.2.3）与 `brace-expansion`（5.0.12），消除 5 项阻断公开发布的 high 公告；React Router 6 的两项 moderate 公告仍作为 Preview 残余风险记录。

## [0.2.0-preview.1] - 2026-08-06

### Added

- 开源仓库文档：`LICENSE`、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`
- GitHub Issue / Pull Request 模板
- Windows x64 与 Linux x64 便携包构建，以及跨平台 `mmdctl`（后台启停、前台运行、PID 指纹、健康检查、状态、日志和浏览器打开）。打包脚本仍可本地组装 Linux ARM64 / macOS，但不纳入本 Preview 公开发布。
- 最终压缩包冒烟测试、文件级 `manifest.json`、SHA-256、CycloneDX SBOM 和 GitHub Preview Release 流水线。
- Java 运行时注册表：扫描 `JAVA_HOME` 与常见安装目录，实例和部署可按 ID 绑定已验证运行时。
- 任务中心、亮暗主题、窄屏侧栏、配置表单和危险操作确认弹窗。
- 从固定 `DATA_DIR/imports` 交接区复制接管同机已有服务端。

### Changed

- 版本进入 `0.2.0-preview.1`；便携包内置固定 Node.js 22 和生产依赖，不捆绑 Minecraft Java。
- Preview 公开发布矩阵收窄为 Windows x64 与 Linux x64；Linux ARM64 与 macOS 不纳入本版本 Release。
- 运行布局新增 `MMD_HOME`、`MMD_CONFIG_PATH`、`MMD_DATA_DIR`，配置与数据不再绑定源码仓库目录。
- 升级生产依赖并移除未使用的 `adm-zip`，公开发布门禁拒绝 high / critical 生产依赖漏洞。
- 实例统一托管在 `DATA_DIR/instances/<id>`，移除自定义实例目录和全盘目录浏览约定。
- 实例默认使用 PATH 中的 `java`，也可按 ID 绑定扫描并验证的运行时；Java 接口提供默认状态和运行时注册表。
- 首次初始化要求两个互不相同的 64 位十六进制 `JWT_SECRET` 与 `SETUP_TOKEN`，setup 使用 `X-Setup-Token` header，且仅在用户表为空时可用。
- 增加旧版外部实例的手动接管流程；面板不会自动搬迁、访问或删除旧外部目录。
- 补充 JSON、上传、任务、下载、Installer、文本、命令和控制台的默认限制配置。
- 同步阶段二资源防护配置：`HTTP_REQUEST_TIMEOUT_MS`、`HTTP_CONNECTION_TIMEOUT_MS`、`HTTP_KEEP_ALIVE_TIMEOUT_MS`、`UPLOAD_IDLE_TIMEOUT_MS` 分别为 `900000`、`300000`、`72000`、`30000` 毫秒；`MAX_CORE_METADATA_BYTES` / `CORE_METADATA_TIMEOUT_MS` 为 `2097152` 字节 / `15000` 毫秒。
- 上传超限返回 413，上传容量耗尽返回 429；核心缓存改为完整文件校验后原子发布，任务支持排队并受执行超时保护。
- 文件下载增加 `MAX_CONCURRENT_FILE_DOWNLOADS=4` 与 `FILE_DOWNLOAD_IDLE_TIMEOUT_MS=60000`；并发容量耗尽返回 429，下载空闲超时会释放下载资源。
- 控制台增加 `MAX_CONSOLE_CONNECTIONS=20`、每 `CONSOLE_COMMAND_WINDOW_MS=60000` 毫秒最多 `MAX_CONSOLE_COMMANDS_PER_WINDOW=60` 条命令、`MAX_CONSOLE_INCOMING_BYTES=4352` 字节入站消息和 `MAX_CONSOLE_STDIN_BYTES=65536` 字节 stdin 缓冲限制；Installer 取消后按 `INSTALLER_KILL_GRACE_MS=5000` 毫秒宽限期再强制结束。
- 澄清用户可见能力：Web UI 提供实例创建（含空实例上传 Jar）、启停与重启、强制停止、文件下载与重命名；控制台与任务中心提供异步操作反馈。

### Security

- 2026-08-06 官方 registry 生产依赖审计为 0 critical、0 high、2 moderate；React Router 6 的两项 moderate 公告仍作为 Preview 残余风险记录。
- 升级传递依赖 `brace-expansion`（至 5.0.9）与 `fast-uri`（至 3.1.5 / 4.1.2），消除此前阻断公开发布的 high 公告。

## [0.1.0] - 2026-07-26

### Added

- 单机一体 Minecraft 服务端管理面板（Fastify + React）
- 实例 CRUD、启停 / 重启；强杀 API（`?force=1`）
- WebSocket 实时控制台（xterm.js）
- 实例根目录内的文件浏览、上传、文本编辑；下载与重命名后端接口
- `server.properties` 编辑与 EULA 确认
- 一键部署 Vanilla / Paper / Fabric / Forge / NeoForge
- 导入服务端 zip 安装包（路径逃逸防护）
- 首启管理员账号与 JWT 登录
- PATH 中 `java` 的可用状态检测
- 中文用户文档（快速开始、教程、使用指南、配置、架构、API、开发）
