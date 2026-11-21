# 已知误区与历史教训

本页记录可复现的错误模式，不等同于当前缺陷列表。

## KF-001 接口存在但功能声明过度

- 历史现象：提交标题声称完成强杀、文件下载和重命名，但下载调用和重命名 UI 缺失。
- 快速核对：搜索 `downloadAuthenticated|files/rename|files/download|force-stop|force=1`，同时检查前端调用和可见入口。
- 预防：按共享契约、服务端、前端调用、UI、文档、验证六段链路验收。
- 当前含义：文件下载（`downloadAuthenticated` + 可见「下载」）、同目录重命名（可见「重命名」）与强制停止（总览/详情「强制停止」+ `ConfirmDialog` + `force=1`）均已补齐 Web 入口；仍须按六段链路验收，不得只凭后端路由宣称完成。

## KF-002 大文件被整体载入内存

- 历史现象：浏览器端 `res.blob()` 会等待并缓存完整下载。
- 预防：服务端保持流式响应；前端使用不会整体缓冲的认证下载方案，并验证大文件和取消行为。

## KF-003 沙箱权限被误判为代码错误

- 历史现象：Vite/esbuild 因无法读取工作区父目录而无法加载 `vite.config.ts`。
- 预防：确认错误文本后在获准的正常环境重跑完整构建。
- 禁止：只凭沙箱失败宣称项目无法构建。

## KF-004 安全自检被当成完整安全证明

- 历史现象：安全自检通过时，依赖审计仍可能报告 high/critical。
- 预防：把代码边界测试和依赖供应链审计分开报告；审计结论必须来自当前官方 registry 结果。

## KF-005 文档和源码漂移

- 历史现象：新增 `launcher` 路由和 `LAUNCHER_TOKEN` 后，AI 入口与架构/API 文档没有全部同步。
- 预防：路由、环境变量、工作区和脚本变化必须更新 `project-facts.json`，由 `knowledge:check` 阻断漂移。

## KF-006 把持久化记录当成可恢复任务

- 现象：`tasks` 表保存状态，但 worker、队列和 AbortController 在内存中。
- 当前处理：面板启动时把遗留的 `pending` / `running` 标记为失败，并尝试清理任务已关联的半成品实例；不宣称断点续跑。
- 预防：若未来实现真正续跑，仍必须设计状态机、幂等和重新调度；不能仅查询到任务记录就声称任务会恢复。

## KF-007 覆盖用户工作

- 现象：AI 在脏工作树中格式化或回退不相关文件。
- 预防：开工和交付都运行 `git status --short --branch`；只编辑明确范围，逐文件审查 diff。

## KF-008 把历史草稿当成当前缺陷

- 现象：`.slim/deepwork/**` 同时包含已修复发现、过程状态和旧计划。
- 当前处理：2026-10-26 改为只用 Claude Code 后，该目录已从本机删除，`.ignore` 排除规则一并移除。
- 预防：引用任何历史计划或草稿结论前必须回到当前源码验证。

## KF-009 Windows 批处理被统一成 LF 行尾

- 现象：`.gitattributes` 曾对所有文本文件设置 `eol=lf`，`.cmd` 也以 LF 检出；cmd.exe 读 LF 批处理时，跳转标签和 `chcp 65001` 后的多字节字符可能错位，把半行内容当命令执行。
- 当前处理：`*.cmd`、`*.bat` 单独设为 `eol=crlf`；`mdash.cmd` 只写 ASCII，说明放在 `scripts/windows/panel-manager.ps1`。
- 预防：新增批处理沿用这两条规则；修改 `.gitattributes` 后用 `git ls-files --eol` 确认工作区行尾。

## KF-010 前台 Ctrl+C 只看「进程退出、端口释放」就判为安全关闭

- 现象：终端 Ctrl+C 会把 SIGINT 发给整个前台进程组，`mdash foreground` 还会再转发一次。服务端曾在第一次信号后移除处理器，第二次信号走默认动作，面板在十几毫秒内被直接杀死，没有「正在安全关闭面板」日志，`.mystry-panel-lock` 留在数据目录。只看进程是否退出、端口是否释放会误判为通过。Windows 上 Node 的 `child.kill('SIGINT')` 等于强制结束进程，转发同样会打断安全关闭。
- 当前处理：服务端信号处理器挂到进程退出，关闭途中的重复信号只记日志；控制器用 `on` 监听，Windows 不转发 SIGINT。
- 后续发现：修复后在 Linux 实机验收中，浏览器开着面板时 10 轮里有 2 轮卡在 `app.close()`：Java 已退出、端口已关，但浏览器残留的连接一直不断，锁不释放。没开浏览器的测试测不出来。现在 `app.close()` 最多等 5 秒，之后强制断开服务端跟踪的全部 TCP 连接（含已升级的 WebSocket），测试可用 `MYSTRY_TEST_CLOSE_GRACE_MS` 缩短。
- 预防：验证前台停止时要对整个进程组发信号（或真实按 Ctrl+C），并确认安全关闭日志、退出码和数据目录锁已释放；至少有一轮要开着浏览器面板（含实例控制台页）。回归测试见 `scripts/smoke/panel-smoke.test.mjs` 与 `scripts/portable/portable.test.mjs`。

## KF-011 Web 构建在 Windows 上报 esbuild 临时文件 `Access is denied`

- 现象：`vite build` 报 `[vite:esbuild-transpile] remove ...\Temp\esbuild-<hash>: Access is denied`，在沙箱外、用户自己的终端里也能复现，`%TEMP%` 里会留下约 1 MB 的 `esbuild-*` 残留文件。和 KF-003 的报错文本相似，但不是沙箱问题。
- 原因：esbuild 遇到超过 1 MiB 的输入时，会经 `%TEMP%` 下的临时文件中转，读完后删除；杀毒软件扫描占用该文件时删除失败。前端曾不分包，主代码块未压缩前超过 1 MiB，构建就必然走这条路径。
- 当前处理：`apps/web/vite.config.ts` 用 `manualChunks` 把 React、xterm、图标和两个中文语言包各自拆成独立代码块，每块远小于 1 MiB。
- 预防：新增大依赖或大段文案后，留意构建输出中最大 JS 代码块的大小；不要靠给杀毒软件加排除项来"修好"构建。

## KF-012 发布冒烟绑定了界面语言

- 现象：`logs` 的标题翻译后，`smoke-portable.mjs` 对 `stdout` 的断言必定失败。这个脚本不在 `verify` 里，公开仓库也没打过标签，直到发布审查才发现。
- 原因：启动器支持双语时，冒烟被固定为 `MYSTRY_LANG=zh-CN` 来保住原有的中文断言，发布结果因此依赖界面文案。
- 当前处理：冒烟只看退出码、文件、HTTP 和日志内容；`portable:test` 禁止它再按中文文案判断，并在中英文下核对日志检查。
- 预防：发布门禁不比对界面文字。改启动器后，至少在真实压缩包上跑一次 `portable:smoke`。

## KF-013 本机镜像地址被写进锁文件

- 现象：`package-lock.json` 有 30 条 `resolved` 指向 `registry.npmmirror.com`，公开用户和 CI 都被固定到这个镜像。
- 原因：本机 npm 配了镜像时，新增或升级依赖会把镜像地址写进锁文件。npm 安装时只替换官方地址，不替换其他地址。
- 当前处理：`verify` 里的 `lockfile:check` 负责拦截，`npm run lockfile:fix` 改回官方地址。下载源由启动器在安装时选择。
- 预防：想用镜像时走 `mirror` 命令或 `--registry`，不要提交带镜像地址的锁文件。

## KF-014 `server.properties` 只在新版本上验证过

- 现象：1.12.2 上 `difficulty=1` 显示成「和平」；选「困难」保存后提示成功，重启又变回 `1`。中文简介写入后变成永久乱码。
- 原因：1.13 及更早只认数字形式的难度和模式，写单词会被重置；旧版按 Latin-1 读取文件，再把读错的内容存回去。
- 当前处理：读取时把数字转成名称，写回时保持文件格式，旧版实例的默认配置也用数字；非 ASCII 值写成 `\uXXXX`。
- 预防：改 `server.properties` 读写时，用 1.12.2 和当前版本各走一遍「保存 → 重启 → 再打开」。

## KF-015 路径含链接时入口判断失败，进程静默以 0 退出

- 现象：启动器报“面板未能在 60 秒内启动”，`panel.stdout.log` 和 `panel.stderr.log` 都是空的；直接运行服务端入口立即以 0 退出。检查类脚本同样无输出地以 0 退出，看起来像通过。
- 原因：入口判断用 `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`。Node 加载入口前会解析符号链接和 junction，`argv[1]` 保留原写法，安装或仓库路径含链接时两边不等。
- 当前处理：服务端用 `utils/real-path.ts` 的 `isMainModule()`，仓库脚本用 `scripts/is-main-module.mjs`，两边都先解析真实路径（D-030）。
- 预防：新增可直接运行的脚本时复用这两个函数，不要手写比较。测试时 Claude 终端面板关标签会结束整棵进程树，不能用它验证“关窗不影响后台面板”。

## KF-016 测试用空文件冒充外部程序，没发现它根本起不来

- 现象：Windows 上打开虚拟局域网，`easytier-core.exe` 以 `0xC0000135`（找不到 DLL）退出，没有任何输出；单元测试全部通过。
- 原因：EasyTier 2.6.4 的 `easytier-core.exe` 静态导入同一压缩包里的 `Packet.dll`，安装只解压了 core、cli 和 `wintun.dll`。测试里的安装目录用空文件伪造，`lanInstalled()` 只查文件在不在，从没真的启动过它。
- 当前处理：`lan-runtime.ts` 的 Windows `extraNames` 加上 `Packet.dll`，测试锁住这一项。
- 预防：升级 EasyTier、frpc 等外部程序的版本，或改它们的安装文件列表时，在每个支持的平台上真的装一次，并运行一次 `--version`。不要只看测试通过。
