# Changelog

本文件记录项目的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 一键部署默认选中 Paper 和最新正式版；Build、Loader、Installer 改为可选，留空时由服务端取最新（Paper 优先稳定构建）。部署页右侧的实现说明卡改为新手指引，说明怎么选核心和部署后怎么进服。
- 部署、导入、创建空实例三个入口的 EULA 同意默认不勾选；部署必须主动勾选才能开始。
- 界面文案去掉内部术语：「节点监控」改为「本机环境」，去掉远程集群锁定卡；「同机目录交接」改为「从本机文件夹导入」；「PATH 中的 java」改为「系统默认 Java」；「堆内存上限 (Xmx)」改为「最大内存」等。导入与部分启动错误提示同步改写。
- 初始化页说明令牌已由启动器复制到剪贴板，并写明各配置文件的位置；设置密码时提示长度要求，并说明无法找回密码。
- 「第一次开服」教程改为按便携版和启动器的实际流程编写，新增 Java 版本对照表和看到 `Done` 再进服的说明。
- 统一界面与错误信息的叫法，术语表写入 `CONTRIBUTING.md`：「任务队列」「后台异步任务中心」统一为「任务中心」，「指令」统一为「命令」，所有 401 统一提示「登录已失效，请重新登录」；ZIP、链接、凭证、临时目录相关的错误信息不再夹带 entry、symlink/junction、ticket、staging marker 等英文术语。部署按钮改为「开始部署」，去掉「请耐心等待」「敬请期待」等措辞；标点、引号统一为全角与「」，内存单位统一为 MiB / GiB。
- 三个启动入口（`PanelManager.cmd`、`PanelManager.sh`、`mystryctl`）的命令清单按同一顺序列出；Windows 源码启动器补上 `open` 和 `help` 命令。菜单和日志输出去掉 `=====` 分隔线，`logs` 的分节标题改为「最近的错误输出」「最近的标准输出」。

### Removed

- 删除旧的一阶段 ZIP 导入接口 `POST /api/import`。Web 早已改用「上传预检 → 确认配置」的 `/api/import/previews` 流程；直接调用旧接口的脚本需要改走预览流程，否则会收到 404。

### Fixed

- 页面不再从 Google Fonts 加载字体，改用系统字体栈，离线或国内网络下首屏不再被外部样式阻塞。
- 主按钮、当前标签与任务徽标的文字改用各主题的 `--on-accent`，修复 Grok 暗色主题下白字配浅色背景看不清的问题。
- 打开文件很多的目录（如 `world/region`）时，文件列表不再逐项重复校验整条路径；此前 300 个文件约需 1 秒，期间会阻塞其他请求。
- 文件页不再列出实例根目录的面板标记文件 `.mystry-instance.json`；此前它带着编辑、重命名、删除按钮，但点了都会被服务端拒绝。
- 双击便携版 `mystryctl.cmd` 时，菜单命令执行完或出错后窗口会停住，按回车再关闭，不再一闪而过、看不到令牌提示和错误信息。带参数的命令行调用不受影响。
- 已识别为 Java 25 的运行时现在可以选择 G1 均衡和 Paper Aikar 预设，便携版启动器也不再对 Java 25 报兼容性警告。此前 MC 26.x 推荐 Java 25，但这两处只认 Java 8、17、21。

### Performance

- 前端构建后生成 `.br` / `.gz` 预压缩资源，服务端按 `Accept-Encoding` 直接发送；带 hash 的 `/assets/*` 设为一年 `immutable` 缓存，`index.html` 每次重新校验。

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
