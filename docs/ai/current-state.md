# 当前项目状态

本文只描述当前工作树可由源码确认的状态。未来设想必须写入
[架构决策](decisions.md)并标为 `Proposed`。

## 已确认实现

- 总览性能监测：认证接口 `GET /api/system/metrics` 提供主机 CPU、已用/总内存、数据盘可用空间与面板持有的实例进程 CPU/驻留内存。总览把本机 CPU、内存、数据盘压成列表上方的一条占用条，实例改为一行一台的列表，运行中的行显示进程 CPU 和「内存 / -Xmx 上限」占用条，列表上方的分段控件按「全部 / 运行中 / 异常」筛选（异常 = 已崩溃、待迁移或上次启动因可识别原因失败）；页头说明行是 22px 状态句（`overview-status`，有异常时接红字数量）；页面内容不放卡片（D-036），本机资源条和服务器列表不放底板，只用分隔线分行，宽屏行内的启动/停止平时无底色。实例页标签是下划线文字标签（`hub-tabs` / `hub-tab`），页头核心名与总览同用 `coreDisplayName()`；5 秒刷新、隐藏暂停、失败保留旧值并标记过期。采集器合并并发并缓存 4 秒，不写数据库。Windows 与 Linux 有进程采集实现，其他平台显示暂不可用；具体运行验证以本次测试结果为准。TPS/MSPT 与历史趋势尚未接入。口径、阈值见 `docs/api.md`。

- npm workspaces monorepo：
  - `packages/shared`：共享 TypeScript 类型和 JSON Schema。
  - `apps/server`：Fastify API、SQLite、进程、文件、部署与导入。
  - `apps/web`：React 管理界面。
- 首次 setup、登录和 Bearer JWT 认证；控制台通过短期一次性 ticket 建立 WebSocket。
- 控制台前端按 ECMA-48 / ISO 6429 对 INFO（绿）、WARN（黄）、ERROR（红）等日志级别着色；服务端仍转发原始纯文本。Minecraft 不回显 stdin，`ProcessManager.sendCommand` 写入成功后把 `> 命令` 记进控制台缓冲（输入框、「常用命令」、REST 命令接口和备份自动发送的命令都走这里），前端把这类行显示为粗体亮白。
- 多实例创建、编辑、删除、启动、停止、强制停止、重启和控制台命令。
- 启动失败提示：进程不是因用户停止而退出时，`start-diagnosis.ts` 按固定句式从该次控制台输出里识别原因，写进 `InstanceInfo.startIssue`（只在内存，再次启动或面板重启后清空）。能识别的有未同意 EULA、Java 过新（旧版 Forge 的 LaunchWrapper 报错、核心自己的「Only up to Java N」）和 Java 过旧（`UnsupportedClassVersionError`、「requires running the server with Java N or above」）；服务端打印过 `Done (` 之后的退出不归因于 Java。实例控制台页上方的 `StartIssueBanner` 给出说明：EULA 可点「同意并启动」（先 `PATCH acceptEula`，再启动），Java 给出 Temurin 下载链接和实例设置入口。进程自己以退出码 0 结束时状态为「已停止」而不是「已崩溃」。Java 选择器在版本不符或找不到系统默认 Java 时也带下载链接。其他崩溃原因仍只有控制台原文。另有一种不用启动就给出的 `startIssue`：实例绑定的 Java 运行时在登记表里已不可用或已不存在时，`instance-service.ts` 读取实例时直接给出 `java-unavailable`（只查登记表，不碰磁盘），总览把它算进「异常」并在行里写明，控制台上方提示去实例设置重新选择，联机页不放「启动」而带去实例页。
- 启动成功提示：`ProcessManager` 在输出里见到 `]: Done (` 后把该次运行标为就绪，经 `InstanceInfo.ready` 暴露（只在内存，停止中或退出后为 `false`）。控制台页上方的 `ReadyHint`（一行 `ready-strip`，末尾是图标按钮「不再提示」）据此提示可以进服并链接到「联机」；「不再提示」记在浏览器 `localStorage`（`mystry_ready_hint_dismissed`），对所有实例生效。
- 实例联机：侧栏「部署与维护」中的「联机」（`/multiplayer`）页头下一行是实例下拉和分段（「直接连接」「虚拟局域网」「frp 穿透」），默认「直接连接」，一次只显示一种，切换不改变其他方式已保存的设置。三种方式共用 `MultiplayerLayout`：沿用部署页的 `deploy-layout` 两栏，主栏按操作顺序排：「对玩家开放这个实例」开关（`OpenSwitch`，点了立即保存，只带服务端已保存的设置）→「让玩家加入」编号步骤（`JoinSteps`：发加入说明或玩家配置、玩家运行客户端、加入地址放大一档可复制）→ 默认收起的高级设置（中继节点、保存过的穿透设置），右侧「指引」栏只放穿透模式说明和排查清单；指引栏可关闭，关闭状态记在浏览器 `localStorage`（`mystry_multiplayer_guide`），`<=1180px` 时排到主栏下方。EasyTier 与 frp 客户端未安装时共用 `RuntimeInstallCallout`（下载按钮、下载来源、默认收起的「手动安装」），这时不显示开关（已开着的除外）。中继节点和穿透设置各自保存，带上服务端当前的开关，不会和开关互相覆盖；开着时保存中继节点会提示重新发加入说明。frp 没有服务器时先显示添加表单；穿透设置从没保存过时不显示开关，保存按钮是「保存并开放」，之后穿透设置和添加服务器收进折叠区。界面统一称「玩家」「加入地址」「加入说明」「玩家配置」「frp 服务器」「穿透模式」「让玩家加入」。「直接连接」（`DirectSection`、`GET /api/instances/:id/local-network`、`local-network-service.ts`）只读显示这台电脑的局域网 IPv4 地址加游戏端口，标题固定为「同一网络的加入地址」，地址下第一句写明这是内网地址、只有同一个路由器或 Wi-Fi 的玩家能用，紧跟「改用虚拟局域网」「填写公网地址」两个出路；只在找不到局域网地址时才给出 `127.0.0.1:端口` 供本机自测（按网卡名和网段去掉能认出的虚拟网卡，也不含网卡上的公网地址和实例自己的联机网卡地址），可逐个复制，并提示 Windows 防火墙弹窗和 `server-ip` 绑定问题；这台电脑有公网 IP 时（网卡上直接有公网 IPv4，或用户在页面里填了公网 IP 或域名，`PUT /api/system/public-host`，面板不自动探测），另有「公网加入地址」，检查清单（安全组、系统防火墙、`server-ip` 留空、域名与 SRV、白名单）放在指引栏，并在 `server-ip` 填成公网 IP 时给出专门提示（未在真实云服务器上实测）；电脑有公网 IPv6 且 `server-ip` 不限制时，另外显示 `[地址]:端口` 供不在身边的朋友直连，并提醒只在路由器放行游戏端口（未在有公网 IPv6 的机器上实测）。它不开端口、不改配置，也不检测朋友是否真的连得上。frp 代管钉死版本的官方 frpc（Windows x64 与 Linux x64）。用户先选择实例，再填写自己的 frp 服务器地址、端口和令牌；面板只把该实例的 `server-port` 从 `127.0.0.1` 转出去，不暴露面板端口，也不接受可执行路径或原始配置。公网模式给出朋友可复制的加入地址；`stcp` / `xtcp` 可下载只应交给朋友的 visitor 配置。令牌不出现在 API 响应里。`server-ip` 绑定具体网卡时拒绝启动。实例停止或面板关闭时结束对应 frpc。见 D-023。
- 从其他设备访问面板（D-033）：顶栏「其他设备」按钮（768px 以下在「本机」页）打开「在其他设备上打开」弹窗，显示网址、二维码（浏览器本地生成，`qrcode-generator@2.0.4`）和复制按钮。「直接访问」默认所有网卡、HTTPS（面板自签名证书，`<数据根>/tls/`）、不限来源，可选一块网卡，两个安全开关「使用 HTTPS」「只允许同一网段的设备」开启后改动立即生效；Windows 上尝试加防火墙规则，加不上时给出手动放行的说明。「虚拟组网」分「面板自带」（钉死版本的官方 EasyTier，无 TUN，节点 `10.127.0.1`，只放行面板另开的组网专用端口，经它进来的请求不算本机，给出 Android / 电脑的加入信息和已加入设备）和「已装的组网软件」（在选定网卡上监听）。`HOST` 已是非回环地址时只显示网址，开关只读。设置存 `panel_settings`，面板启动时恢复，挂不上只记录原因、照常只监听本机；关闭面板时停监听器、断连接、删防火墙规则、停 EasyTier。启动器 `remote on [网卡名]` / `off` / `status` / `https on|off` / `renew-cert` 经本机启动器接口操作；经 SSH 首次启动且在终端里时询问一次是否开启，SSH 登录时不在服务器上打开浏览器。`remote-access-service.ts`、`panel-certificate.ts`、`panel-firewall.ts`、`panel-network.ts`、`public-host.ts`、`routes/system.ts`、`routes/launcher.ts`、`RemoteAccessDialog.tsx`、`mystryctl.mjs`。未在真实网卡、手机、云服务器和 iOS 上验证；面板自带网络的自动测试用替身进程；专用端口转发和白名单只用两个本机 EasyTier 2.6.4 节点（`port-forward`）实测过，没用手机连过真实组网，已加入设备列表按 EasyTier 对端表的字段解析，未对照真实输出。
- 复制按钮在非安全上下文（`http://` 加局域网或组网地址）下可用：`apps/web/src/clipboard.ts` 的 `copyText()` 先试 `navigator.clipboard`，不可用时退回隐藏文本框加 `execCommand`，都失败时提示手动复制；控制台、错误详情、联机三处和新弹窗统一使用它。
- 实例虚拟局域网：同一「联机」页的分段可打开钉死版本的官方 EasyTier（Windows x64 与 Linux x64）。面板为该实例生成独立网络名和密钥，只放行游戏 TCP 端口；朋友用锁定命令加入虚拟地址。密钥不出现在状态接口里。用户可为每个实例填写最多 8 个自己的中继节点，并可关掉内置社区共享节点；面板端在随机空闲端口上监听 TCP/UDP（含 IPv6）供直连；Windows 上自动添加并在停止时删除范围很窄的防火墙放行规则（监听端口规则只限 easytier-core 程序）；面板异常退出残留的规则在下次启动时按本面板已知的实例 ID 清扫，停止、关闭或删除实例时也会补删。连不上 GitHub 时，frp 与 EasyTier 都可上传自己下载的官方压缩包，只按钉死 SHA-256 安装。`server-ip` 绑定具体网卡时拒绝启动。实例停止或面板关闭时结束对应进程。见 D-024、D-031。
- Vanilla、Paper、Fabric、Forge、NeoForge 部署及 ZIP 导入。
- ZIP 导入采用二阶段预览：Web 先调用 `/api/import/previews` 流式上传并验证中央目录，只读取根目录或单一顶层目录中最大 64 KiB 的 `user_jvm_args.txt`；确认后同一临时 ZIP 才交给后台任务。预览随机 ID 按用户隔离、默认 30 分钟、每用户一个/全局两个，队列满保留，取消/过期/关闭/重启清理且不写数据库。旧的一阶段 `POST /api/import` 已删除。
- 面板外已有服务端交接：只列出 `DATA_DIR/imports` 直接子目录，只读扫描并以后台任务复制到新托管实例；拒绝 symlink/junction、特殊文件、ownership marker、超配额和磁盘空间不足，源目录始终保留。
- 下载来源：「本机环境」页切换 `official`（默认，只连官方）或 `china`（BMCLAPI 与公共 GitHub 镜像，失败回到官方），存 `panel_settings` 表，`GET/PUT /api/system/download-source`，立即生效。覆盖 Vanilla、Forge、NeoForge、Fabric 版本列表、frpc、EasyTier；Paper 和 Fabric 的 jar 始终走官方。Forge/NeoForge 在 `china` 下由 `installer-prefetch.ts` 预取依赖，但安装器仍可能连接 Mojang。校验值未知时计划里不含镜像地址；Vanilla 部署时清单只从 Mojang 取，作为 SHA-1 校验链的根；带校验值的核心缓存复用前重新核对；https 下载被跳转到 http 时拒绝。见 D-025 和 [架构说明](../architecture.md#下载来源)。
- 实例目录内文件列表、上传、文本读写、删除、同目录重命名；目标已存在时重命名返回 `409` 且不覆盖。普通文件通过一次性 download ticket 流式下载（JWT 签发、并发槽预留、`GET` 状态查询、失败回传 SPA；禁止 `blob()` 整包缓存），Web 文件页提供下载与重命名入口。下载窗在用户手势中 `window.open` 且不把 `noopener` 放进 feature（避免现代浏览器返回 `null` 被误判为拦截），打开后再断开 `opener`。票据完成（`consumed`）或过期（`expired`）后保留 60 秒按用户隔离的内存 tombstone，状态查询返回终态而非 404，避免前端轮询把成功下载误判为过期。
- 实例一键备份与还原（`routes/backups.ts`、`services/backup-service.ts`、`services/backup-archive.ts`，Web「备份」分段）：备份为整个实例目录的流式 tar.gz，末尾清单记录逐文件 SHA-256，存于 `BACKUP_DIR`（默认 `DATA_DIR/backups/<id>/`）。运行中备份用 `save-off` → `save-all flush`（等待服务端自己打印的 `Saved the game` / `Saved the world`，按日志行解析，聊天不算）→ 打包 → `save-on`，期间状态变化即取消；`session.lock` 不进入备份。还原要求已停服，默认先生成 `pre-restore` 备份，先校验并解压到 `.mystry-staging/<taskId>/`，在实例锁内整体换目录；换目录标记 `.mystry-restore-swap.json` 让启动时 `recoverInterruptedBackups()`（先于任务恢复）回滚或收尾；换目录后若清单里的启动文件存在，实例的 `jar_file` / `core_type` / `mc_version` 跟随清单。备份/还原任务用 `BACKUP_TASK_TIMEOUT_MS`（默认 6 小时）。删除实例默认一并删除 `BACKUP_DIR/<id>`（`?keepBackups=1` 保留）。备份/还原期间 `ProcessManager` 维护标记拒绝启动、重启、删除、接管；还原期间文件写接口返回 409（上传在写入实例目录前再检查一次）。备份下载复用下载 ticket（伪路径 `@backup/<id>`）。不含 `panel.db`，没有定时自动备份和保留策略。
- 同 `DATA_DIR` 仅允许一个面板进程进入 `initDb` / 任务恢复：`.mystry-panel-lock/` 目录锁 + `owner.json`（存活 PID 拒绝启动；仅原 PID 不存在时可 quarantine 后接管）。
- 部署/导入/ZIP 先写入 `DATA_DIR/.mystry-staging/<taskId>/<instanceId>`（marker 含 task/instance/token），校验通过后原子移动到 `instances/<id>`；崩溃恢复只清理 marker 匹配且任务未完成的 staging，**不会**因 `result.instanceId` 删除已注册实例或最终目录（见 D-016）。
- 实例 start/stop/restart/delete/adopt 互斥：启停、删除与接管走同一把实例操作锁；start 在首个异步步骤前占位 `starting`；普通 stop 只写 `stop\n`，超时返回仍在停止中且**不**隐式 `SIGKILL`；`force=1` 为唯一强杀路径（UI 二次确认）。面板关闭先标记 `shuttingDown` 并等待未完成的实例操作；`start` 在 spawn 前若已关闭则取消，避免留下无主 Java。
- `server.properties` 读写、Java 状态检测、本机节点列表。
- 界面参照 Apple HIG / Liquid Glass：导航层（悬浮侧栏、叠在内容上方的工具栏、底部标签栏、菜单、弹层、任务中心、页面底部悬浮操作栏）使用 `backdrop-filter` 毛玻璃，内容层为实色卡片与分组列表；页面以大标题开头，内容区滚动超过 12px 后工具栏显示页面标题与毛玻璃底；布尔型 `server.properties` 用 `role="switch"` 开关，实例子页、导入方式和联机方式用分段控件，部署核心为 `radiogroup` 卡片（方向键切换）。文件页为面包屑 + 列表，「…」菜单提供下载/编辑/重命名/删除，新建文件夹改为弹窗。共用组件：`PageHeader`、`StatusPill`、`CoreIcon`、`BrandMark`。
- 响应式布局：`<=1180px` 部署页指引改为单列、总览本机资源条改为两行（标题与更新时间一行，三条占用条一行，监测告警单独再占一行）；`<=1024px` 侧栏收进左上角「打开导航菜单」（侧栏从工具栏下方展开，工具栏浮在遮罩之上，关闭按钮始终可点），任务中心按钮只显示图标；`<=768px` 出现底部悬浮标签栏（总览/部署/导入/联机/本机，展开导航菜单时一并 inert），内容边距 16px，对话框改为底部升起的面板，控制台高度随视口调整；`<=560px` 总览本机占用条每条一行；总览实例列表按所在区块宽度（容器查询）在 `<=820px` 时每行改为上下堆叠、`<=520px` 时操作按钮平分一行；`<=480px` 实例分段按钮隐藏图标。长表单按页面内容区宽度（`.page` 容器查询）在 `>=900px` 时分两栏：导入页左栏来源、右栏导入设置（还没选好来源时只有来源一栏）；实例设置左栏基本信息与许可协议、右栏运行环境；参数配置各分组排成两列（半栏里控件收窄）；窄时按原顺序上下排列。部署页表单主栏 `>=640px`（`deploy-main` 容器查询）时五种核心排成一行，实例名称与游戏版本并排。原生下拉的选项用 `surface-raised` 实底和 `label` 文字色，避免 Windows 下沿用半透明输入框底色导致深色外观看不清。总览顶部保留「一键部署 / 导入服务端 / 创建空实例」，没有实例时顶部按钮隐藏、列表区改为三种添加方式；每行状态后跟一句现状说明，并给出对应的下一步链接（已就绪→邀请玩家、Java 不符→打开实例设置、未同意 EULA→查看并同意、崩溃→查看控制台、待迁移→去迁移），整行（按钮以外）都是进入详情的链接，行尾有箭头，悬停整行加底色；启动/停止与更多操作独立；「更多操作」面板挂到 body 并以 fixed 定位在按钮下方右对齐展开（下方空间不足时翻到上方），不受卡片 `overflow` 裁剪，支持方向键、Home/End、Escape 与 Tab 关闭并恢复焦点。断点实现以 CSS 为准，真实宽度与浅色、深色外观的视觉验收需另行运行，不能由构建或 DOM 测试推定。
- 路由无障碍（`App.tsx` 的 `RouteAnnouncer`、`hooks/useDocumentTitle.ts`、`hooks/useRouteFocus.ts`）：浏览器标签标题按路由设为「页面名 · Mystry Dashboard」，实例页为「标签 · 实例名 · Mystry Dashboard」，随界面语言更新；用户操作后的换页把焦点移到新页面 `h1`（脚本设 `tabindex=-1`），首屏加载与登录态重定向不移动焦点，同一实例内切换标签焦点留在标签上；未知顶层路由重定向到 `/`，未知实例子路由（如 `/instances/:id/console`）重定向到该实例控制台。
- `PanelManager.cmd`（Windows）与 `PanelManager.sh`（Linux / WSL 源码）只负责检查 Node、安装依赖和构建，启停、状态、日志和 `remote` 命令都转调 `scripts/portable/mystryctl.mjs`，经本机 `POST /api/launcher/shutdown` 安全关闭。两个源码启动器只允许 `mirror` 和 `remote` 带参数。Windows 默认配置为仓库根 `.env`。三个入口的提示跟随系统语言（中文系统用中文，其余英文），`MYSTRY_LANG` 可覆盖。
- 跨平台 `mystryctl`：自动随机配置、后台 PID 指纹、健康检查、安全停止、状态和日志；便携包使用包内 Node，Linux 源码入口在依赖/构建预检后复用同一控制器。无参数且 stdin 为终端时（通常是双击启动）执行 `watch`：面板以后台进程运行，窗口只读日志文件，关窗不影响面板和服务端，Ctrl+C 走安全停止。`menu` 打开交互菜单，命令执行完或出错后等待回车再退出；带参数调用与非终端 stdin 不暂停（`portable:test` 覆盖）。
- 目标平台原生便携组装与最终压缩包冒烟脚本；发布包物理复制 `@mystry/shared`，并生成文件级 manifest。
- GitHub Preview Release 流水线：标签/main/版本门禁、Windows x64 与 Linux x64 矩阵、生产依赖审计、校验和签名、SBOM 和自动 Release Notes。
- 上传、下载、任务、元数据、控制台和 ZIP 解压均有大小、并发或超时边界。
- 任务中心：`GET /api/tasks` 返回最近 50 条任务；桌面与移动布局均通过顶栏「任务中心」进入（共享单例轮询，429 退避、页面隐藏暂停），离开部署/导入页后仍可查看任务到终态。抽屉通过 portal 挂到 body，使用原生模态 dialog；关闭时不参与键盘导航，Escape、遮罩与关闭按钮均恢复入口焦点，任务进度带 progressbar 语义。
- ZIP 可通过「选择 ZIP」按钮或拖放选择，两者共享扩展名校验与中文错误反馈；busy 和预览恢复期间禁止更换。上传大小与解压限制由面板配置决定，前端不承诺固定 4GB。
- 矮屏减少滚动（[策划案](../plans/vertical-density-design.md)）：视口高度 <820px 且宽度 ≥1025px 时，顶栏 56px、页面与表单区块间距收紧（`styles.css` 的 `--page-gap` 等变量），大标题不变；侧栏常驻时实例页头不显示返回链接，滚动后顶栏胶囊显示实例名（`hooks/useToolbarTitle.ts`）；JVM「最终参数」预览移进「高级 JVM 参数」折叠区，填过非默认值时默认展开，第一次出现参数错误时自动展开一次；Java 选择器的推荐版本写进字段标签，删去两行重复说明，安装提示与按钮同一行；部署页 EULA 同意项移进底部操作栏，第 4 节只在有 Java 警告、部署进度或失败原因时出现。1463×775 下部署页 1449 → 1168px，参数配置内容起点 301 → 235px。
- 表单公共做法（[策划案](../plans/form-experience-design.md) 第 8 节）：字段用 `Field` / `useFieldFeedback`，红字在失焦后或按 Enter、点操作栏状态文字后才出现；数字框是 `NumberInput`（文本框加数字键盘），密码框是 `PasswordInput`（可点开看）；登录与初始化、部署、实例设置、参数配置、frp 表单都是 `<form>`，改密码对话框自己接 Enter；输入框里按 Enter 提交或跳到第一个要改的字段。实例设置和参数配置的保存栏（`SaveBar`）有修改才出现，带「放弃修改」，实例运行中保存后给「重启实例」；部署和导入的操作栏照旧常驻。内存按 GB 填，初始内存带 2 / 4 / 6 GB、最大内存带 8 / 10 / 12 GB 档位（超出本机内存的不显示），框内有 ±1 GB 小箭头（`NumberInput` 的 `stepper`，也响应 ↑ ↓，触屏不显示），保存的仍是 `-Xms…M -Xmx…M`。导入页和远程访问对话框还没迁。
- 主按钮只在信息足够时可点：部署、导入、实例设置、参数配置的底部操作栏在按钮不可点时写出第一个缺少的条件（选版本、实例名称、JVM、Java、EULA，参数配置的数字范围）；创建空实例、重命名、新建文件夹、初始设置、修改密码、frp 服务器与穿透端口、中继节点、公网地址的按钮在本地按与服务端相同的规则校验（`apps/web/src/validation.ts`，单元测试 `apps/web/tests/validation.test.ts`）。填了但不合规的字段显示红框和说明，空字段只让按钮不可点。文件编辑读取失败时不显示编辑框、不能保存；创建备份在点击时就进入忙碌状态，连点只发一次请求。参数配置只校验改过的数字字段，文件里原有的值不拦保存；数字项可以清空保存，存成空值后游戏按默认值生效（1.21.10 实测；1.12.2 只看了官方核心的字节码，没有实际启动）。面板自己读游戏端口（直连地址、frp、虚拟局域网）统一走 `config-service.ts` 的 `gamePortFromProperties`：没写或留空按 25565，写了但不是端口号才算无效。
- 内容区 `.content-container` 是唯一的页面滚动容器（工具栏叠在其上方），页面整体自然滚动；部署、导入的提交按钮放在 `position: sticky` 的底部悬浮操作栏中，滚动时始终可见；参数配置与实例设置的保存栏同样吸底，但有修改才出现。粘性偏移相对滚动容器内容区计算，所以容器上下内边距只留给工具栏和标签栏，页面末尾留白放在 `.content-inner`。切换路由时内容区回到顶部。
- 节点页展示加载、空态、失败重试与返回的在线/离线状态；刷新失败保留上次数据并标记可能过期。控制台复制日志提供成功、空日志及剪贴板不可用/拒绝提示，卸载时清理提示计时器。
- 危险操作防护：重启与强制停止需弹窗确认；运行/启动/停止中的实例禁止删除；删除实例需输入实例名二次确认（待迁移实例仅移除记录，免输名），入口在总览行的「更多操作」和实例设置页底部的「危险操作」，两处共用 `DeleteInstanceDialog`（请求在弹窗里发，失败原因显示在弹窗内）；实例页头只放当前状态能做的事（停着只有「启动」，进程在时才有「停止」「重启」，「强制停止」收在「更多操作」）；文件/目录与远程节点删除也使用统一确认弹窗，执行期间禁止 Escape 或遮罩绕过 busy 锁。
- 控制台 WebSocket 断线后指数退避自动重连（1s→30s 封顶，重新申请一次性 ticket）。
- 读屏播报：控制台工具栏有「读屏模式」开关（`aria-pressed`，按浏览器记在 `mystry_console_screen_reader`），开启 xterm `screenReaderMode` 提供逐行可浏览的日志与朗读区；历史快照写完、发送命令前各重建一次朗读区，历史不被朗读、命令回显可读到。总览每 5 秒刷新的「更新于」不在 live region 内，例行轮询也不切换刷新按钮状态，只播报监测出错、告警与恢复。`ConfirmDialog` 的 `error` 显示在弹窗正文内（`role="alert"` + `aria-describedby`）；部署页版本下拉用 `aria-labelledby` 指向可见标签与当前值。
- 前端任一请求收到 401（登录/setup/status 除外）会清空登录态并自动跳回登录页。
- server.properties 编辑为引导化表单：常用键按「基础/多人与权限/世界/性能」分组；服务端保留注释、空行、重复键与 `:` 分隔符，引导保存只改每个 key 的最后一次定义，并原子写入。文件里没写的键按游戏默认值显示（开关和下拉显示默认状态，文本和数字框把默认值放在占位字里），只显示不写入，拨回默认值不算修改；实例游戏版本已经不读的键不显示（`pvp`、`allow-nether`、`spawn-monsters` 从 1.21.9 起，`spawn-animals` 从 1.21.2 起，名单在 `ConfigTab.tsx` 的 `removedIn`；默认值和名单已用 1.21.8、1.21.10 官方服务端生成的文件核对，两个分界版本号取自 Minecraft Wiki），文件里的旧值保存时原样带回，版本未知时全部显示。应用使用 Data Router 支持 SPA 导航阻塞；配置与实例设置页跟踪未保存状态，无变化时禁用保存，保存期间锁定表单，切换页面前使用统一确认弹窗，浏览器离开则使用 beforeunload；配置保存后明确提示重启生效。
- 总览提供「创建空实例」：`POST /api/instances`（custom）成功后跳转实例文件页上传 Jar。
- 部署、导入、创建空实例和实例设置共用 `JvmSettingsEditor`：基础区并排是初始内存（Xms）和最大内存，旁边是兼容/G1/Paper Aikar 预设；初始内存没改过时自动取值（兼容/自定义为 `min(1 GiB, Xmx)`，G1 与 Paper Aikar 为 `Xmx`，切到 G1 时重置为自动，Paper 下锁定），高级区为附加参数和规范化参数预览，诊断显示在下方。导入时检测到 `user_jvm_args.txt` 自动沿用并提示，可取消（还原沿用前的参数）或重新应用。预设常量含版本、适用核心/Java、来源与复核日期；服务端在实例保存、部署/导入入队和启动前使用同一共享校验。旧实例非法文本保持原样，但修正前不能保存或启动（见 D-018）。
- 任务中心区分首次读取、空列表和轮询失败；失败时显示「状态可能已过期」、上次成功刷新时间与重试，弹层打开后接收焦点并支持 Escape 返回入口。部署/导入 worker 一旦完成 promote/注册即视为成功，超时或关闭不得把已落地实例改写成失败；ZIP 导入在 promote 到 `instances/<id>` 之后不再检查 abort，必须继续注册。任务中心对失败但带 `result.instanceId` 的记录仍给出实例链接。部署/导入表单提交后锁定，进度值限制在 0–100 并带 progressbar 语义；已有服务端来源列表仅做有界 ModLoader 预检，预检超时仍可提交，完整扫描在导入任务中执行。
- Java 多运行时：`GET /api/system/java-runtimes` 扫描 JAVA_HOME 与常见安装目录，候选必须文件名为 java/java.exe 且 `-version` 输出可解析才写入 `java_runtimes` 注册表；`detectJava` / 执行前复验 / Minecraft 与 installer 子进程均使用 `getMinecraftChildEnv()` 脱敏环境（不继承面板密钥与 `DATA_DIR`）。实例可通过 `javaRuntimeId` 绑定运行时（默认仍用 PATH 中的 java），启动和 Forge/NeoForge Installer 会在执行前再次验证绑定条目；四个 JVM 配置入口共用运行时选择器的加载结果和实际 Java 主版本，PATH 默认 Java 与已选注册表运行时都按 MC 版本给出 mismatch 告警（`recommendedJavaMajor`：26.1+ 年份版本号 → 25，1.20.5+ → 21，1.17–1.20.4 → 17，更早 → 8）。
- Java 自动选择与一键安装（D-034）：部署页和导入页的运行时选择器开 `autoSelect`，用户没手动改选时按推荐主版本选系统默认或已装的同主版本 Java；实例设置页不开。推荐版本没装且 `installable` 含它时，状态点后面同一行显示「推荐 Java N」「安装 Java N」；点按钮先弹确认（写明来源和大小），确认后才开始；进度条右边有「取消安装」（`POST /api/system/java-runtimes/install/:taskId/cancel`，任务服务的 `cancelTask` 只对 Java 安装开放，用户取消记成 `server.tasks.cancelledByUser`，前端不当错误显示）。`POST /api/system/java-runtimes/install` 以 `download` 类型后台任务下载钉死 SHA-256 的 Temurin JRE（`java-install-service.ts`，Windows/Linux x64 的 8/17/21/25），装到数据根 `runtimes/java/temurin-<版本>`，登记为 `source: 'panel'`；扫描始终包含这个目录。部署页在实际要用的 Java 不是推荐主版本（含没装 Java、所选条目不可用）或安装进行中时禁用「开始部署」并说明原因（选择器的 `onMatchStatusChange`）；只在前端拦，部署接口本身不校验 Java；导入页不拦。
- 新建数据根与子目录在 Unix 上默认 `0700`、敏感文件 `0600`，过宽权限会拒绝启动；Windows 上记录 ACL 无法自动校验时的阻断级警告（见 `data-dir-permissions.ts`）。
- `PanelManager.ps1` 安全停服：`Get-PanelHealth` 校验 PID、状态文件指纹与健康 JSON 一致后才发送 `X-Launcher-Token`（伪造健康服务测试断言永不发送 token）。
- Paper/Fabric 等 core 缓存键基于解析后的不可变版本/build，旧 `latest` 键不再误命中。
- 发布工作流（`.github/workflows/portable-release.yml`）：Actions 使用固定 commit SHA；Windows job 显式 `npm run windows:test`；`RELEASE_GPG_FINGERPRINT` 与仓库内发布公钥/指纹文件用于签名链门禁；`package-portable.mjs` 优先 `git rev-parse HEAD`，脏工作树拒绝正式打包。**本机未验证** GitHub Environment 私钥注入、真实 GPG 签名与双平台 Actions smoke 结果。
- 质量门禁在本机运行（D-032）：`npm run ci:local`（`scripts/ci-local.mjs`）对指定提交做干净检出并执行 `npm ci` 与 `npm run verify`，Windows 上依次跑 Windows（临时 git worktree）与 WSL Linux（`/tmp` 克隆），Node 固定为 `scripts/portable/runtime.json` 的版本并按 `SHASUMS256.txt` 校验；`.github/workflows/quality.yml` 只保留手动触发，推送和 PR 不再自动检查。
- 外观模型参照 macOS：外观 `auto` / `light` / `dark`（持久化 `mystry_appearance`，自动时跟随 `prefers-color-scheme` 并由 `watchSystemAppearance()` 监听系统切换）。强调色固定为墨紫（D-035），不再由用户选择：浅色填充 `#6439e0`、文字 `#5a30d4`，深色填充 `#6a48e6`、文字 `#ab98ff`，两种外观 `--on-accent` 都是白字（≥5.7:1）；旧版留下的 `mystry_accent` 不再读取，也不清除。index.html 内联脚本在渲染前写入 `<html data-appearance-preference data-appearance>`；`mystry_appearance` 缺失时从旧 `mystry_theme` 只迁移深浅（`dark`/`codex`/`grok` → 深色，`light`/`codex-light`/`grok-light` → 浅色），都没有时为自动。CSS 令牌按 `:root[data-appearance]` 拆分：`--accent` 填充、`--accent-text` 文字、`--on-accent` 主按钮文字，语义填充色为 Apple 系统色，语义文字色 `--ok` / `--warn` / `--danger` 按自身 11–16% 色调叠在 `bg` 上仍 ≥4.5:1 取值。选择器是工具栏与登录页的「外观」弹层，只有自动/浅色/深色一组（原生单选组，弹层挂到 body，因为毛玻璃父级会成为 fixed 定位的包含块）；控制台终端区域在两种外观下都保持深色。
- Web 界面多语言（见 D-021）：零依赖实现，`apps/web/src/i18n/`。语言偏好 `auto` / `en` / `zh-CN` / `zh-TW` 持久化在 `mystry_locale`；自动时按浏览器语言列表取第一个 `zh*` 或 `en*`：繁体（`Hant`，或未写 `Hans` 且地区为 TW/HK/MO）用繁體中文，其他 `zh*` 用简体中文，`en*` 或都不匹配用英文，并监听 `languagechange`。index.html 内联脚本在渲染前写入 `<html lang data-locale-preference>`，规则与 `detectLocale()` 一致。文案表按界面区域拆分为 `en/<区域>.ts`（主表）与 `zh-CN/<区域>.ts`、`zh-TW/<区域>.ts`（`satisfies Record<keyof typeof en, string>` 强制键一致），运行时缺键回落 en；`useI18n()` 提供 `t`（`{name}` 插值）、`tp`（`_one`/`_other` 复数）、`rich`（句内标签）与 `fmt`（Intl 数字/日期/大小）。`:root:lang(zh-TW)` 把繁体字体（PingFang TC、Microsoft JhengHei、Noto Sans TC）排在简体字体前。语言切换是工具栏与登录页外观按钮旁的独立「语言」弹层（与外观弹层共用 `usePopover`）。服务端消息见下一条。
- 服务端消息多语言（见 D-022）：面向用户的错误、任务进度、控制台错误帧返回 `server.<区域>.<含义>` 消息键与参数（`PanelMessage`，参数可嵌套另一条消息），英文模板以 `packages/shared/src/messages/` 为唯一来源。错误响应 `{ error: 英文文本, code?, params? }`，由 `utils/errors.ts` 的 `PanelError` / `panelErrorBody` / `errorBody` 与 `sendRouteError`、全局错误处理器生成；任务在 `tasks` 表新增可空列 `message_i18n` / `error_i18n`（启动期 `ALTER TABLE` 自动补列），`TaskInfo` 返回 `messageI18n` / `errorI18n`，旧任务无键时显示存库原文。Web 的 `errorMessage()` 与 `useI18n().tm()` 按界面语言翻译，缺键回落英文文本。Node 系统错误、Java/网络库原文与启动期终端日志不翻译。
- 字体统一使用 `:root` 中的系统字体栈（`--font` / `--mono`，含中文系统字体回落），各主题不再单独指定字体；页面不加载任何外部字体或第三方样式，离线与国内网络下首屏不依赖外网。
- 前端静态资源：`@mystry/web` 构建在 `vite build` 后运行 `scripts/precompress-dist.mjs`，为 dist 中 ≥1 KiB 的文本资源生成 `.br` / `.gz`；服务端 `@fastify/static` 开启 `preCompressed` 按 `Accept-Encoding` 发送并带 `Vary`，缺失时回落原文件。`/assets/*`（Vite 带 hash 产物）返回 `public, max-age=31536000, immutable`，`index.html` 与 SPA 回落页返回 `no-cache`（见 `frontend-assets.ts` 与 `test:static`）。
- 文件列表 `listFiles` 只对目标目录调用一次 `resolveSafePath` 逐段校验，条目逐个 `lstat` 拒绝 symlink/junction，不再对每个条目重复 realpath 整条路径（大目录不会长时间阻塞事件循环）。实例根目录的所有权标记 `.mystry-instance.json` 不出现在列表中（子目录同名文件照常列出）；改写类接口仍由 `assertMutableTarget` 拒绝操作它。
- 一键部署默认选中 Paper，选定核心后自动拉取版本列表并默认选中最新正式版；Paper Build、Fabric Loader/Installer、Forge/NeoForge 版本均为可选，留空时由服务端解析为最新（Paper 优先稳定构建）。部署、ZIP/目录导入、创建空实例三处的 EULA 同意默认不勾选；部署页必须勾选后才能提交，导入和空实例可不勾选（不勾选时启动不改写已有 `eula.txt`；实例设置里从勾选改成不勾选并保存时，`instance-service.ts` 在实例锁内把 `eula.txt` 改写为 `eula=false`，备份或还原中返回 409）。部署页右侧为新手指引（选核心与进服步骤），不再展示内部实现说明。
- 面向用户的文案避免内部术语（英文对应叫法见 `apps/web/src/i18n/en/common.ts` 与贡献指南）：侧栏「本机环境」（`/nodes`，页面不再展示远程集群锁定卡）、「上传文件夹」（浏览器读出文件后上传）与「从 imports 文件夹复制」（`DATA_DIR/imports`）、「系统默认 Java」（PATH 中的 `java`）、「最大内存」（`-Xmx`）；导入与部分启动、落地错误改为「导入文件夹」「部署临时文件」「Forge/NeoForge 启动参数文件」等说法。

- `server.properties`：`config-service.ts` 把数字形式的 `difficulty`、`gamemode` 读成名称，文件原来是数字或实例版本为 1.13 及更早时写回数字；非 ASCII 值写成 `\uXXXX`。
- npm 下载源：源码启动器的 `mirror` 命令和 `scripts/npm-mirror.mjs` 决定 `npm ci` 的 `--registry`，选择保存在 `config/npm-mirror`。`package-lock.json` 只记录官方地址，由 `lockfile:check` 把关。面板自身下载核心、frpc、EasyTier 的来源不受这个开关影响。

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
- 管理员认证使用浏览器 `localStorage` 中的 JWT。JWT 带令牌版本 `tv`，`authenticate` 每次与 `users.token_version` 比对；修改密码或本机重置密码时版本加 1，旧令牌、未用的控制台 / 下载 ticket 立即失效，已开的控制台 WebSocket 断开，改密的会话换发新令牌（`auth-service.ts`、`session-revocation-service.ts`，见 D-029）。登录有效期（D-040）在「本机环境」页设置，默认 12 小时，可选不过期：签发时按设置写 `exp`，`authenticate` 再用 `iat` 对照当前设置，改短立即生效（`session-duration-service.ts`）；`JWT_EXPIRES_IN` 已不再生效。当前没有会话列表、单个会话撤销、2FA 或角色权限体系。
- 数据库只有启动期兼容处理，没有通用、版本化迁移框架。
- 实例默认使用面板进程 `PATH` 中的 `java`，也可绑定 `java_runtimes` 注册表中当前可用的运行时；绑定条目消失、路径变化或执行前验证失败时必须重新扫描和选择。
- 没有定时自动备份、备份保留策略和包含 `panel.db` 的整面板备份/恢复；也没有系统安装器、远程 Agent 执行协议或生产监控闭环。
- 便携发布流水线已经实现，但 Windows x64 / Linux x64 runner 和公开 Release 的实际结果只能由对应 GitHub Actions 运行确认。Linux ARM64 与 macOS 打包能力仍在脚本中，不纳入本 Preview 公开发布。
- 公开发布前须重新运行 `npm.cmd run audit:production`（拒绝 high/critical），并核对双平台最终压缩包 smoke、签名验证和人工验收。依赖审计结果、远程密钥配置与分支同步状态不由本页作实时保证。不得用 `--force` 贸然升到 React Router 7。

## 固定运行边界

- Node.js `>=22`。
- 便携包固定内置 Node.js `22.23.1`；源码运行仍遵循 `>=22`。
- 默认监听 `127.0.0.1:3000`；Vite 开发端口为 `127.0.0.1:5173`。用户在界面或启动器里开启「从其他设备访问」后，面板另在所选网卡地址的同一端口上监听（D-033），`HOST` 和主监听器不变。
- 最终数据根目录优先使用 `MYSTRY_DATA_DIR`，否则使用 `DATA_DIR`；实例固定为该根目录的 `instances/<id>`，不得浏览或管理整台机器。
- 数据根和 `BACKUP_DIR` 所在上级路径中的符号链接或 junction 在 `config.ts` 里解析为真实路径，目录本身及数据根内部的链接仍被拒绝（D-030）。服务端和仓库脚本的入口判断都比较解析后的真实路径（`utils/real-path.ts`、`scripts/is-main-module.mjs`），安装或仓库路径含链接时不会静默退出。
- 同机目录交接（界面称「从 imports 文件夹复制」，次要入口：浏览器能选文件夹时只在 `imports` 已有文件夹或点了「上传文件夹」下方的链接后才列出）只接收 `DATA_DIR/imports` 下的单层目录 ID，不能提交绝对路径；该目录仅为复制源，不是实例工作目录。`GET /api/import/sources` 另返回 `importDir`（绝对路径，只出不进，D-041），页面 `ImportsSourceSection` 显示它和「复制路径」，下面是单选列表（`role="radiogroup"`，每行可访问名是文件夹名、说明用 `aria-describedby`）：核心与版本、普通 jar 的文件名、是否带 `user_jvm_args.txt`；Forge / NeoForge 参数文件路径不显示；不可导入的行禁用并写原因。
- 导入页的导入设置：来源就绪（文件夹上传检查完、ZIP 预检完、imports 里选中能导入的文件夹）之前只显示来源区。之后右栏一张卡片：实例名称、识别结果摘要（`dl.import-summary`：服务端核心与版本、要用的 Java、最大内存及是否来自 `user_jvm_args.txt`，均由页面当前状态算出，不取预检结果）、`details.disclosure`「修改设置」（核心类型、版本、`JavaRuntimeSelect`、`JvmSettingsEditor`，收起时照常挂载）、EULA 勾选。「修改设置」默认收起，按来源（模式 + 预检 / 上传 / 来源 ID）各自动展开一次：安装 Java 中，或 Java 读完后版本不符、不可用、列表没读到，或 JVM 配置器报错误 / 警告 / 检测文件用不了（`onAttentionChange`）；问题要持续 300ms 才展开，避开换来源、自动选 Java 时一两次渲染里的旧状态。换来源时重新收起。不知道 Minecraft 版本（`recommended` 为 null，ZIP 一定如此）时不展开，只在摘要里提醒无法确认 Java。Java 状态来自选择器的 `onResolvedChange`（`availability`：loading / unknown / ready / missing，因为 `matchStatus` 在没有推荐版本时总是 match）。
- Java 运行时选择器（四个入口共用）：状态点说实际要用的那个 Java，选了登记的 Java 写「Java 21.0.5 可用」，所选条目不可用时不放状态点（下方已有橙色提示），没选才写系统默认 Java。选项只写主版本，同一主版本有多个时才带路径；`<select>` 的 `title` 是所选 Java 的路径。安装中被卸载时会回报 `onInstallingChange(false)`，页面不会一直以为在安装。
- 导入页默认方式「上传文件夹」（D-039）：浏览器读出用户选的文件夹，分批上传文件和相对路径到 `uploads/.tmp-folder-upload-<id>/`，预检后确认时整个改名搬进任务 staging；服务端不接收本机路径。会话只在内存里，重启即清；手机浏览器不显示这个入口。
- 导入时的核心与版本识别：`server-launch-detect.ts` 按启动文件名判断核心类型，并从文件名或 Forge args 目录名认 `1.7`–`1.21.x` 的 Minecraft 版本（`custom` 与 NeoForge 不认）。来源预检（`ExistingServerSourceInfo.coreType` / `mcVersion`）和导入结果共用这套判断，导入页据此预填表单。请求里 `coreType` 省略或为 `custom` 表示自动识别（界面选项名为「自动识别」），`mcVersion` 留空时用识别到的版本；ZIP 导入在解压后才识别，预览阶段不给出。
- 旧版外部实例路径只用于迁移状态判断；面板不会读取、启动、搬迁或删除旧外部目录。
- `JWT_SECRET` 必填；空用户表时 `SETUP_TOKEN` 必填，管理器自动生成并用它创建 `admin`，随机 16 位密码只显示在窗口里；`LAUNCHER_TOKEN` 仅供本机 PanelManager 的关闭、重置密码和「从其他设备访问」接口使用，这些接口同时只认回环来源；已配置的三项必须互不相同。
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
