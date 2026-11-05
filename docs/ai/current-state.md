# 当前项目状态

本文只描述当前工作树可由源码确认的状态。未来设想必须写入
[架构决策](decisions.md)并标为 `Proposed`。

## 已确认实现

- 总览性能监测：认证接口 `GET /api/system/metrics` 提供主机 CPU、已用/总内存、数据盘可用空间与面板持有的实例进程 CPU/驻留内存。总览保留四张指标卡与实例原有四格结构，异常数量可筛选；5 秒刷新、隐藏暂停、失败保留旧值并标记过期。采集器合并并发并缓存 4 秒，不写数据库。Windows 与 Linux 有进程采集实现，其他平台显示暂不可用；具体运行验证以本次测试结果为准。TPS/MSPT 与历史趋势尚未接入。口径、阈值见 `docs/api.md`。

- npm workspaces monorepo：
  - `packages/shared`：共享 TypeScript 类型和 JSON Schema。
  - `apps/server`：Fastify API、SQLite、进程、文件、部署与导入。
  - `apps/web`：React 管理界面。
- 首次 setup、登录和 Bearer JWT 认证；控制台通过短期一次性 ticket 建立 WebSocket。
- 控制台前端按 ECMA-48 / ISO 6429 对 INFO（绿）、WARN（黄）、ERROR（红）等日志级别着色；服务端仍转发原始纯文本。
- 多实例创建、编辑、删除、启动、停止、强制停止、重启和控制台命令。
- 实例联机穿透：侧栏「部署与维护」中的「联机」（`/multiplayer`）用分段在「虚拟局域网」和「frp 穿透」之间切换，一次只显示一种，切换不改变另一种已保存的设置。frp 代管钉死版本的官方 frpc（Windows x64 与 Linux x64）。用户先选择实例，再填写自己的 frp 服务器地址、端口和令牌；面板只把该实例的 `server-port` 从 `127.0.0.1` 转出去，不暴露面板端口，也不接受可执行路径或原始配置。公网模式给出朋友可复制的加入地址；`stcp` / `xtcp` 可下载只应交给朋友的 visitor 配置。令牌不出现在 API 响应里。`server-ip` 绑定具体网卡时拒绝启动。实例停止或面板关闭时结束对应 frpc。见 D-023。
- 实例虚拟局域网：同一「联机」页的分段可打开钉死版本的官方 EasyTier（Windows x64 与 Linux x64）。面板为该实例生成独立网络名和密钥，只放行游戏 TCP 端口；朋友用锁定命令加入虚拟地址。密钥不出现在状态接口里。`server-ip` 绑定具体网卡时拒绝启动。实例停止或面板关闭时结束对应进程。见 D-024。
- Vanilla、Paper、Fabric、Forge、NeoForge 部署及 ZIP 导入。
- ZIP 导入采用二阶段预览：Web 先调用 `/api/import/previews` 流式上传并验证中央目录，只读取根目录或单一顶层目录中最大 64 KiB 的 `user_jvm_args.txt`；确认后同一临时 ZIP 才交给后台任务。预览随机 ID 按用户隔离、默认 30 分钟、每用户一个/全局两个，队列满保留，取消/过期/关闭/重启清理且不写数据库。旧的一阶段 `POST /api/import` 已删除。
- 面板外已有服务端交接：只列出 `DATA_DIR/imports` 直接子目录，只读扫描并以后台任务复制到新托管实例；拒绝 symlink/junction、特殊文件、ownership marker、超配额和磁盘空间不足，源目录始终保留。
- 下载来源：「本机环境」页切换 `official`（默认，只连官方）或 `china`（BMCLAPI 与公共 GitHub 镜像，失败回到官方），存 `panel_settings` 表，`GET/PUT /api/system/download-source`，立即生效。覆盖 Vanilla、Forge、NeoForge、Fabric 版本列表、frpc、EasyTier；Paper 和 Fabric 的 jar 始终走官方。Forge/NeoForge 在 `china` 下由 `installer-prefetch.ts` 预取依赖，但安装器仍可能连接 Mojang。校验值未知时计划里不含镜像地址。见 D-025 和 [架构说明](../architecture.md#下载来源)。
- 实例目录内文件列表、上传、文本读写、删除、同目录重命名；目标已存在时重命名返回 `409` 且不覆盖。普通文件通过一次性 download ticket 流式下载（JWT 签发、并发槽预留、`GET` 状态查询、失败回传 SPA；禁止 `blob()` 整包缓存），Web 文件页提供下载与重命名入口。下载窗在用户手势中 `window.open` 且不把 `noopener` 放进 feature（避免现代浏览器返回 `null` 被误判为拦截），打开后再断开 `opener`。票据完成（`consumed`）或过期（`expired`）后保留 60 秒按用户隔离的内存 tombstone，状态查询返回终态而非 404，避免前端轮询把成功下载误判为过期。
- 实例一键备份与还原（`routes/backups.ts`、`services/backup-service.ts`、`services/backup-archive.ts`，Web「备份」分段）：备份为整个实例目录的流式 tar.gz，末尾清单记录逐文件 SHA-256，存于 `BACKUP_DIR`（默认 `DATA_DIR/backups/<id>/`）。运行中备份用 `save-off` → `save-all flush`（等待服务端自己打印的 `Saved the game` / `Saved the world`，按日志行解析，聊天不算）→ 打包 → `save-on`，期间状态变化即取消；`session.lock` 不进入备份。还原要求已停服，默认先生成 `pre-restore` 备份，先校验并解压到 `.mystry-staging/<taskId>/`，在实例锁内整体换目录；换目录标记 `.mystry-restore-swap.json` 让启动时 `recoverInterruptedBackups()`（先于任务恢复）回滚或收尾；换目录后若清单里的启动文件存在，实例的 `jar_file` / `core_type` / `mc_version` 跟随清单。备份/还原任务用 `BACKUP_TASK_TIMEOUT_MS`（默认 6 小时）。删除实例默认一并删除 `BACKUP_DIR/<id>`（`?keepBackups=1` 保留）。备份/还原期间 `ProcessManager` 维护标记拒绝启动、重启、删除、接管；还原期间文件写接口返回 409（上传在写入实例目录前再检查一次）。备份下载复用下载 ticket（伪路径 `@backup/<id>`）。不含 `panel.db`，没有定时自动备份和保留策略。
- 同 `DATA_DIR` 仅允许一个面板进程进入 `initDb` / 任务恢复：`.mystry-panel-lock/` 目录锁 + `owner.json`（存活 PID 拒绝启动；仅原 PID 不存在时可 quarantine 后接管）。
- 部署/导入/ZIP 先写入 `DATA_DIR/.mystry-staging/<taskId>/<instanceId>`（marker 含 task/instance/token），校验通过后原子移动到 `instances/<id>`；崩溃恢复只清理 marker 匹配且任务未完成的 staging，**不会**因 `result.instanceId` 删除已注册实例或最终目录（见 D-016）。
- 实例 start/stop/restart/delete/adopt 互斥：启停、删除与接管走同一把实例操作锁；start 在首个异步步骤前占位 `starting`；普通 stop 只写 `stop\n`，超时返回仍在停止中且**不**隐式 `SIGKILL`；`force=1` 为唯一强杀路径（UI 二次确认）。面板关闭先标记 `shuttingDown` 并等待未完成的实例操作；`start` 在 spawn 前若已关闭则取消，避免留下无主 Java。
- `server.properties` 读写、Java 状态检测、本机节点列表。
- 界面参照 Apple HIG / Liquid Glass：导航层（悬浮侧栏、叠在内容上方的工具栏、底部标签栏、菜单、弹层、任务中心、页面底部悬浮操作栏）使用 `backdrop-filter` 毛玻璃，内容层为实色卡片与分组列表；页面以大标题开头，内容区滚动超过 12px 后工具栏显示页面标题与毛玻璃底；布尔型 `server.properties` 用 `role="switch"` 开关，实例子页、导入方式和联机方式用分段控件，部署核心为 `radiogroup` 卡片（方向键切换）。文件页为面包屑 + 列表，「…」菜单提供下载/编辑/重命名/删除，新建文件夹改为弹窗。共用组件：`PageHeader`、`StatusPill`、`CoreIcon`、`BrandMark`。
- 响应式布局：`<=1180px` 部署页指引改为单列、总览指标改为两列；`<=1024px` 侧栏收进左上角「打开导航菜单」（侧栏从工具栏下方展开，工具栏浮在遮罩之上，关闭按钮始终可点），任务中心按钮只显示图标；`<=768px` 出现底部悬浮标签栏（总览/部署/导入/联机/本机，展开导航菜单时一并 inert），内容边距 16px，实例卡片单列，对话框改为底部升起的面板，控制台高度随视口调整；`<=560px` 指标圆环移到卡片右上角；`<=480px` 实例分段按钮隐藏图标。总览保留「一键部署 / 导入已有服务端」入口；实例卡片通过名称链接或「进入管理」导航，启动/停止与更多操作独立；「更多操作」面板挂到 body 并以 fixed 定位在按钮下方右对齐展开（下方空间不足时翻到上方），不受卡片 `overflow` 裁剪，支持方向键、Home/End、Escape 与 Tab 关闭并恢复焦点。断点实现以 CSS 为准，真实宽度与各外观/强调色的视觉验收需另行运行，不能由构建或 DOM 测试推定。
- 路由无障碍（`App.tsx` 的 `RouteAnnouncer`、`hooks/useDocumentTitle.ts`、`hooks/useRouteFocus.ts`）：浏览器标签标题按路由设为「页面名 · Mystry Dashboard」，实例页为「标签 · 实例名 · Mystry Dashboard」，随界面语言更新；用户操作后的换页把焦点移到新页面 `h1`（脚本设 `tabindex=-1`），首屏加载与登录态重定向不移动焦点，同一实例内切换标签焦点留在标签上；未知顶层路由重定向到 `/`，未知实例子路由（如 `/instances/:id/console`）重定向到该实例控制台。
- `PanelManager.cmd`（Windows）与 `PanelManager.sh`（Linux / WSL 源码）只负责检查 Node、安装依赖和构建，启停、状态、日志都转调 `scripts/portable/mystryctl.mjs`，经本机 `POST /api/launcher/shutdown` 安全关闭。Windows 默认配置为仓库根 `.env`。三个入口的提示跟随系统语言（中文系统用中文，其余英文），`MYSTRY_LANG` 可覆盖。
- 跨平台 `mystryctl`：自动随机配置、后台 PID 指纹、健康检查、安全停止、状态和日志；便携包使用包内 Node，Linux 源码入口在依赖/构建预检后复用同一控制器。无参数且 stdin 为终端时显示交互菜单（通常是双击启动），菜单命令执行完或出错后等待回车再退出，避免窗口一闪而过；带参数调用与非终端 stdin 不暂停（`portable:test` 覆盖）。
- 目标平台原生便携组装与最终压缩包冒烟脚本；发布包物理复制 `@mystry/shared`，并生成文件级 manifest。
- GitHub Preview Release 流水线：标签/main/版本门禁、Windows x64 与 Linux x64 矩阵、生产依赖审计、校验和签名、SBOM 和自动 Release Notes。
- 上传、下载、任务、元数据、控制台和 ZIP 解压均有大小、并发或超时边界。
- 任务中心：`GET /api/tasks` 返回最近 50 条任务；桌面与移动布局均通过顶栏「任务中心」进入（共享单例轮询，429 退避、页面隐藏暂停），离开部署/导入页后仍可查看任务到终态。抽屉通过 portal 挂到 body，使用原生模态 dialog；关闭时不参与键盘导航，Escape、遮罩与关闭按钮均恢复入口焦点，任务进度带 progressbar 语义。
- ZIP 可通过「选择 ZIP」按钮或拖放选择，两者共享扩展名校验与中文错误反馈；busy 和预览恢复期间禁止更换。上传大小与解压限制由面板配置决定，前端不承诺固定 4GB。
- 内容区 `.content-container` 是唯一的页面滚动容器（工具栏叠在其上方），页面整体自然滚动；部署、导入、参数配置与实例设置的提交按钮放在 `position: sticky` 的底部悬浮操作栏中，滚动时始终可见。粘性偏移相对滚动容器内容区计算，所以容器上下内边距只留给工具栏和标签栏，页面末尾留白放在 `.content-inner`。切换路由时内容区回到顶部。
- 节点页展示加载、空态、失败重试与返回的在线/离线状态；刷新失败保留上次数据并标记可能过期。控制台复制日志提供成功、空日志及剪贴板不可用/拒绝提示，卸载时清理提示计时器。
- 危险操作防护：重启与强制停止需弹窗确认；运行/启动/停止中的实例禁止删除；删除实例需输入实例名二次确认（待迁移实例仅移除记录，免输名）；文件/目录与远程节点删除也使用统一确认弹窗，执行期间禁止 Escape 或遮罩绕过 busy 锁。
- 控制台 WebSocket 断线后指数退避自动重连（1s→30s 封顶，重新申请一次性 ticket）。
- 读屏播报：控制台工具栏有「读屏模式」开关（`aria-pressed`，按浏览器记在 `mystry_console_screen_reader`），开启 xterm `screenReaderMode` 提供逐行可浏览的日志与朗读区；历史快照写完、发送命令前各重建一次朗读区，历史不被朗读、命令回显可读到。总览每 5 秒刷新的「更新于」不在 live region 内，例行轮询也不切换刷新按钮状态，只播报监测出错、告警与恢复。`ConfirmDialog` 的 `error` 显示在弹窗正文内（`role="alert"` + `aria-describedby`）；部署页版本下拉用 `aria-labelledby` 指向可见标签与当前值。
- 前端任一请求收到 401（登录/setup/status 除外）会清空登录态并自动跳回登录页。
- server.properties 编辑为引导化表单：常用键按「基础/多人与权限/世界/性能」分组；服务端保留注释、空行、重复键与 `:` 分隔符，引导保存只改每个 key 的最后一次定义，并原子写入。应用使用 Data Router 支持 SPA 导航阻塞；配置与实例设置页跟踪未保存状态，无变化时禁用保存，保存期间锁定表单，切换页面前使用统一确认弹窗，浏览器离开则使用 beforeunload；配置保存后明确提示重启生效。
- 总览提供「创建空实例」：`POST /api/instances`（custom）成功后跳转实例文件页上传 Jar。
- 部署、导入、创建空实例和实例设置共用 `JvmSettingsEditor`：基础区为内存与兼容/G1/Paper Aikar 预设，高级区为手动 Xms 与附加参数，显示规范化参数预览和结构化诊断。预设常量含版本、适用核心/Java、来源与复核日期；服务端在实例保存、部署/导入入队和启动前使用同一共享校验。旧实例非法文本保持原样，但修正前不能保存或启动（见 D-018）。
- 任务中心区分首次读取、空列表和轮询失败；失败时显示「状态可能已过期」、上次成功刷新时间与重试，弹层打开后接收焦点并支持 Escape 返回入口。部署/导入 worker 一旦完成 promote/注册即视为成功，超时或关闭不得把已落地实例改写成失败；ZIP 导入在 promote 到 `instances/<id>` 之后不再检查 abort，必须继续注册。任务中心对失败但带 `result.instanceId` 的记录仍给出实例链接。部署/导入表单提交后锁定，进度值限制在 0–100 并带 progressbar 语义；已有服务端来源列表仅做有界 ModLoader 预检，预检超时仍可提交，完整扫描在导入任务中执行。
- Java 多运行时：`GET /api/system/java-runtimes` 扫描 JAVA_HOME 与常见安装目录，候选必须文件名为 java/java.exe 且 `-version` 输出可解析才写入 `java_runtimes` 注册表；`detectJava` / 执行前复验 / Minecraft 与 installer 子进程均使用 `getMinecraftChildEnv()` 脱敏环境（不继承面板密钥与 `DATA_DIR`）。实例可通过 `javaRuntimeId` 绑定运行时（默认仍用 PATH 中的 java），启动和 Forge/NeoForge Installer 会在执行前再次验证绑定条目；四个 JVM 配置入口共用运行时选择器的加载结果和实际 Java 主版本，PATH 默认 Java 与已选注册表运行时都按 MC 版本给出 mismatch 告警（`recommendedJavaMajor`：26.1+ 年份版本号 → 25，1.20.5+ → 21，1.17–1.20.4 → 17，更早 → 8）。
- 新建数据根与子目录在 Unix 上默认 `0700`、敏感文件 `0600`，过宽权限会拒绝启动；Windows 上记录 ACL 无法自动校验时的阻断级警告（见 `data-dir-permissions.ts`）。
- `PanelManager.ps1` 安全停服：`Get-PanelHealth` 校验 PID、状态文件指纹与健康 JSON 一致后才发送 `X-Launcher-Token`（伪造健康服务测试断言永不发送 token）。
- Paper/Fabric 等 core 缓存键基于解析后的不可变版本/build，旧 `latest` 键不再误命中。
- 发布工作流（`.github/workflows/portable-release.yml`）：Actions 使用固定 commit SHA；Windows job 显式 `npm run windows:test`；`RELEASE_GPG_FINGERPRINT` 与仓库内发布公钥/指纹文件用于签名链门禁；`package-portable.mjs` 优先 `git rev-parse HEAD`，脏工作树拒绝正式打包。**本机未验证** GitHub Environment 私钥注入、真实 GPG 签名与双平台 Actions smoke 结果。
- 外观模型参照 macOS：外观 `auto` / `light` / `dark`（持久化 `mystry_appearance`，自动时跟随 `prefers-color-scheme` 并由 `watchSystemAppearance()` 监听系统切换）× 强调色 `blue` / `purple` / `pink`（Mystry 粉）/ `green` / `graphite`（持久化 `mystry_accent`）。index.html 内联脚本在渲染前写入 `<html data-appearance-preference data-appearance data-accent>`；两个新键都缺失时迁移旧 `mystry_theme`（`dark`/`light` → 深/浅 + 粉，`codex*` → 绿，`grok*` → 石墨），都没有时为自动 + 蓝色。CSS 令牌按 `:root[data-appearance]` 与 `[data-accent]` 拆分：`--accent` 填充、`--accent-text` 文字、`--on-accent` 主按钮文字（深色绿/石墨/粉用深色文字；深色蓝/紫保留白字、填充加深一档，均 ≥4.5:1），语义填充色为 Apple 系统色，语义文字色 `--ok` / `--warn` / `--danger` 按自身 11–16% 色调叠在 `bg` 上仍 ≥4.5:1 取值。选择器是工具栏与登录页的「外观」弹层（原生单选组，弹层挂到 body，因为毛玻璃父级会成为 fixed 定位的包含块）；控制台终端区域在两种外观下都保持深色。
- Web 界面多语言（见 D-021）：零依赖实现，`apps/web/src/i18n/`。语言偏好 `auto` / `en` / `zh-CN` / `zh-TW` 持久化在 `mystry_locale`；自动时按浏览器语言列表取第一个 `zh*` 或 `en*`：繁体（`Hant`，或未写 `Hans` 且地区为 TW/HK/MO）用繁體中文，其他 `zh*` 用简体中文，`en*` 或都不匹配用英文，并监听 `languagechange`。index.html 内联脚本在渲染前写入 `<html lang data-locale-preference>`，规则与 `detectLocale()` 一致。文案表按界面区域拆分为 `en/<区域>.ts`（主表）与 `zh-CN/<区域>.ts`、`zh-TW/<区域>.ts`（`satisfies Record<keyof typeof en, string>` 强制键一致），运行时缺键回落 en；`useI18n()` 提供 `t`（`{name}` 插值）、`tp`（`_one`/`_other` 复数）、`rich`（句内标签）与 `fmt`（Intl 数字/日期/大小）。`:root:lang(zh-TW)` 把繁体字体（PingFang TC、Microsoft JhengHei、Noto Sans TC）排在简体字体前。语言切换是工具栏与登录页外观按钮旁的独立「语言」弹层（与外观弹层共用 `usePopover`）。服务端消息见下一条。
- 服务端消息多语言（见 D-022）：面向用户的错误、任务进度、控制台错误帧返回 `server.<区域>.<含义>` 消息键与参数（`PanelMessage`，参数可嵌套另一条消息），英文模板以 `packages/shared/src/messages/` 为唯一来源。错误响应 `{ error: 英文文本, code?, params? }`，由 `utils/errors.ts` 的 `PanelError` / `panelErrorBody` / `errorBody` 与 `sendRouteError`、全局错误处理器生成；任务在 `tasks` 表新增可空列 `message_i18n` / `error_i18n`（启动期 `ALTER TABLE` 自动补列），`TaskInfo` 返回 `messageI18n` / `errorI18n`，旧任务无键时显示存库原文。Web 的 `errorMessage()` 与 `useI18n().tm()` 按界面语言翻译，缺键回落英文文本。Node 系统错误、Java/网络库原文与启动期终端日志不翻译。
- 字体统一使用 `:root` 中的系统字体栈（`--font` / `--mono`，含中文系统字体回落），各主题不再单独指定字体；页面不加载任何外部字体或第三方样式，离线与国内网络下首屏不依赖外网。
- 前端静态资源：`@mystry/web` 构建在 `vite build` 后运行 `scripts/precompress-dist.mjs`，为 dist 中 ≥1 KiB 的文本资源生成 `.br` / `.gz`；服务端 `@fastify/static` 开启 `preCompressed` 按 `Accept-Encoding` 发送并带 `Vary`，缺失时回落原文件。`/assets/*`（Vite 带 hash 产物）返回 `public, max-age=31536000, immutable`，`index.html` 与 SPA 回落页返回 `no-cache`（见 `frontend-assets.ts` 与 `test:static`）。
- 文件列表 `listFiles` 只对目标目录调用一次 `resolveSafePath` 逐段校验，条目逐个 `lstat` 拒绝 symlink/junction，不再对每个条目重复 realpath 整条路径（大目录不会长时间阻塞事件循环）。实例根目录的所有权标记 `.mystry-instance.json` 不出现在列表中（子目录同名文件照常列出）；改写类接口仍由 `assertMutableTarget` 拒绝操作它。
- 一键部署默认选中 Paper，选定核心后自动拉取版本列表并默认选中最新正式版；Paper Build、Fabric Loader/Installer、Forge/NeoForge 版本均为可选，留空时由服务端解析为最新（Paper 优先稳定构建）。部署、ZIP/目录导入、创建空实例三处的 EULA 同意默认不勾选；部署页必须勾选后才能提交，导入和空实例可不勾选（不勾选时启动不改写已有 `eula.txt`）。部署页右侧为新手指引（选核心与进服步骤），不再展示内部实现说明。
- 面向用户的文案避免内部术语（英文对应叫法见 `apps/web/src/i18n/en/common.ts` 与贡献指南）：侧栏「本机环境」（`/nodes`，页面不再展示远程集群锁定卡）、「从本机文件夹导入」（`DATA_DIR/imports`）、「系统默认 Java」（PATH 中的 `java`）、「最大内存」（`-Xmx`）；导入与部分启动、落地错误改为「导入文件夹」「部署临时文件」「Forge/NeoForge 启动参数文件」等说法。

主要事实源：

- `apps/server/src/index.ts`
- `apps/server/src/routes/`
- `apps/server/src/services/`
- `apps/web/src/App.tsx`
- `apps/web/src/i18n/`
- `packages/shared/src/index.ts`

## 尚未形成完整用户功能

- 远程节点创建由 `REMOTE_NODE_CREATION_ENABLED = false` 禁用；当前只有内置本机节点 `local`。
- 任务元数据写入 SQLite，但队列、worker 和运行控制器位于内存；进程重启后不会续跑任务，而是把遗留的 `pending` / `running` 记录标记为失败，并**仅**清理可证明位于 `.mystry-staging` 且 marker 匹配的半成品目录。
- 管理员认证使用浏览器 `localStorage` 中的 JWT；当前没有会话列表、撤销、2FA 或角色权限体系。
- 数据库只有启动期兼容处理，没有通用、版本化迁移框架。
- 实例默认使用面板进程 `PATH` 中的 `java`，也可绑定 `java_runtimes` 注册表中当前可用的运行时；绑定条目消失、路径变化或执行前验证失败时必须重新探测和选择。
- 没有定时自动备份、备份保留策略和包含 `panel.db` 的整面板备份/恢复；也没有系统安装器、远程 Agent 执行协议或生产监控闭环。
- 便携发布流水线已经实现，但 Windows x64 / Linux x64 runner 和公开 Release 的实际结果只能由对应 GitHub Actions 运行确认。Linux ARM64 与 macOS 打包能力仍在脚本中，不纳入本 Preview 公开发布。
- 公开发布前须重新运行 `npm.cmd run audit:production`（拒绝 high/critical），并核对双平台最终压缩包 smoke、签名验证和人工验收。依赖审计结果、远程密钥配置与分支同步状态不由本页作实时保证。不得用 `--force` 贸然升到 React Router 7。

## 固定运行边界

- Node.js `>=22`。
- 便携包固定内置 Node.js `22.23.1`；源码运行仍遵循 `>=22`。
- 默认监听 `127.0.0.1:3000`；Vite 开发端口为 `127.0.0.1:5173`。
- 最终数据根目录优先使用 `MYSTRY_DATA_DIR`，否则使用 `DATA_DIR`；实例固定为该根目录的 `instances/<id>`，不得浏览或管理整台机器。
- 同机目录交接（界面称「从本机文件夹导入」）只接收 `DATA_DIR/imports` 下的单层目录 ID，不能提交绝对路径；该目录仅为复制源，不是实例工作目录。
- 旧版外部实例路径只用于迁移状态判断；面板不会读取、启动、搬迁或删除旧外部目录。
- `JWT_SECRET` 必填；空用户表时 `SETUP_TOKEN` 必填；`LAUNCHER_TOKEN` 仅供本机 PanelManager 关闭接口使用；已配置的三项必须互不相同。
- Java 可执行路径只允许来自面板扫描注册（见 D-014）；请求只能提交运行时 ID，不得提交任意路径。
- 部署和导入可保持 `pending` 等待队列容量，UI 必须轮询至终态。

## 声明能力前的最低证据

至少确认以下链路：

1. 共享类型或 schema。
2. 服务端路由和服务。
3. 前端 API 调用。
4. 用户可见入口及错误反馈。
5. 文档。
6. 自动检查与必要的人工行为验证。
