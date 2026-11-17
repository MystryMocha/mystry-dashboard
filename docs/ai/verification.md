# 验证矩阵

本文规定如何选择检查，不记录本次工作已通过哪些检查；历史结果不能替代当前验证。

## 标准命令

Windows PowerShell：

```powershell
npm.cmd run knowledge:check
npm.cmd run knowledge:test
npm.cmd run lockfile:check
npm.cmd run mirror:test
npm.cmd run portable:test
npm.cmd run windows:test
npm.cmd run linux:test
npm.cmd run typecheck
npm.cmd run test:interaction
npm.cmd run test:security -w @mystry/server
npm.cmd run test:smoke
npm.cmd run test:regression -w @mystry/server
npm.cmd run test:static
npm.cmd run build
npm.cmd run audit:production
```

完整门禁：

```powershell
npm.cmd run verify
```

Beta 修复批次回归（已并入根 `verify`；需要单独聚焦执行时）：

```powershell
npm.cmd run test:regression -w @mystry/server
```

Linux/macOS 使用相同脚本名，但命令入口为 `npm run ...`。

## 本机 CI

远程 Quality Gate 已不随推送和 PR 自动运行（D-032）。推送前在本机运行：

```powershell
npm.cmd run ci:local
```

它对 HEAD 做干净检出，执行 `npm ci` 和 `npm run verify`，结束后删除临时目录。在 Windows 上依次跑两个平台：

- **Windows**：系统临时目录里的 git worktree。
- **Linux（WSL）**：在默认 WSL 发行版的 `/tmp` 里克隆仓库（不写进本仓库的 `.git`），接近原远程 CI 的 `ubuntu-latest`。

两边的 Node 都固定为便携包内置的版本（`scripts/portable/runtime.json`，当前 22.23.1）：从 nodejs.org 下载官方发行包，按 `SHASUMS256.txt` 校验后缓存在仓库之外（Windows 在 `%LOCALAPPDATA%\mystry-dashboard\ci`，WSL 在 `~/.cache/mystry-dashboard/ci`）。Windows 一侧复用 `fetch-node-runtime.mjs` 的下载与校验；Linux 版由 WSL 自己用 `curl` 下载、`sha256sum` 校验，不经共享路径，因为从打包安装的应用里写到 `%LOCALAPPDATA%` 的文件会被重定向，WSL 看不到。不使用、也不改动本机已装的 Node。两个平台顺序执行，因为 WSL 镜像网络模式与 Windows 共用 localhost；某个平台失败也会继续跑下一个，最后分别列出结果。

参数：`--ref <提交>` 检查别的提交，`--platform windows|linux` 只跑一个平台，`--keep` 保留临时目录排查失败。Linux 用 WSL 的默认发行版；没有 WSL 时 Linux 一项判为未通过，可用 `--platform windows` 只跑 Windows。脚本只在 Windows 上运行。

只检查已提交的内容，工作树有未提交改动时会提示。子进程去掉 `MYSTRY_*`、`DATA_DIR`、密钥、`HOST`、`PORT`、`NODE_ENV`、`INIT_CWD` 和 npm 注入的小写 `npm_*`，并设 `CI=true`；代理变量经 `WSLENV` 带进 WSL。WSL 与 GitHub runner 的预装软件和内核不同，通过不等于发布工作流必然通过。

## 源码进程冒烟

`test:smoke` 已并入 `verify`。它在系统临时目录启动当前源码的面板进程，不启动 Minecraft，也不读写仓库 `data/`。先构建共享包：

```powershell
npm.cmd run build -w @mystry/shared
npm.cmd run test:smoke
```

通过仅表示：`/api/health` 与 `/api/auth/status` 不是 500，未登录访问受保护接口返回 401，随后本机启动器关闭通道能停掉该进程。登录后的部署、文件、控制台和真实 Java 进程不在这条路径里。便携包最终压缩包仍用 `portable:smoke`，二者不能互相代替。

## 按变更类型

| 变更 | 最低自动验证 | 额外人工验证 |
|---|---|---|
| 纯知识库或文档 | `knowledge:check`、`knowledge:test`；提交前 `verify` | 标题锚点、阅读路径和事实源可读 |
| npm 下载源或锁文件 | `lockfile:check`、`mirror:test`、`windows:test`、`linux:test` | 用小包实测所选下载源能完成 `npm ci` |
| shared 类型/schema | shared build、typecheck、build | 请求与响应兼容 |
| 服务端路由/认证 | typecheck、安全自检、`test:smoke`、build | health、setup/login、授权失败 |
| 文件/路径/ZIP | 安全自检、build | 列表、读写、上传、下载及逃逸拒绝 |
| 进程/任务/控制台 | typecheck、安全自检、build | 启停、命令、WS 重连、排队到终态 |
| UI/样式 | typecheck、build | 桌面/窄屏、加载/错误态、键盘焦点 |
| 数据库 schema | typecheck、安全自检、build | 旧数据库副本升级和失败恢复 |
| Java 运行时扫描/绑定 | shared build、typecheck、安全自检、build | 合法/非法候选、未知或失效 ID、`null` 回退、启动前复验、Forge/NeoForge Installer |
| PanelManager | typecheck、安全自检、build | start/status/stop/restart/logs |
| 便携控制器/打包 | portable:test、build、audit:production、目标平台 package + smoke | 最终压缩包解压、首启、setup、stop、升级数据复用 |
| 依赖升级 | verify、当前 `npm audit --omit=dev` | 登录、部署、控制台和文件回归 |

## 关键人工流程

`knowledge:check` 检查机器事实与本地 Markdown 链接目标是否存在，不检查标题锚点、远程链接或正文语义。文档整理需额外检查所改链接的锚点与命令是否符合对应终端。

`verify` 不包含 `audit:production`，也不自动完成下列人工流程。

`test:interaction` 使用 Vitest、jsdom 与 Testing Library 执行真实 React 组件的键盘、任务抽屉开关/焦点恢复、路由标题/换页焦点/未知路由兜底、ZIP 选择/拖放、节点重试及剪贴板反馈回归，已纳入 `verify`。请求与终端使用替身，jsdom 的 dialog 替身仅检查应用逻辑；不证明原生模态焦点约束、文件对话框、布局、主题、真实上传或 Minecraft 进程行为。

1. `GET /api/health` 返回 `ok`。
2. 空用户库 setup、正常 login、已认证请求和未认证 401。
3. 创建、部署或导入实例；任务从 `pending/running` 到 `completed/failed`。
4. 启动实例，控制台收到输出并可发送命令。
5. 文件列表、文本读写、上传、流式下载和 `server.properties` 保存。
6. `npm start` 后浏览器打开后端托管的整合页面。
7. 每个平台从最终 Release 压缩包重新解压，使用包内 Node 完成 start、health、status、stop。
8. 重新扫描 Java 运行时后，验证选择器、版本告警、失效条目提示和绑定实例的启动失败反馈。

## 结果解释

- typecheck 通过：只证明 TypeScript 契约可检查。
- 安全自检通过：只证明当前自检覆盖的负向边界。
- `test:smoke` 通过：只证明隔离数据目录中的面板进程能启动，健康与未登录只读接口不返回 500，受保护接口拒绝未登录请求。不证明登录后的部署、文件、控制台或 Minecraft 进程。
- build 通过：只证明生产产物可生成；大 chunk 警告应单独报告。
- 人工流程通过：只证明本次环境和路径下的可见行为。
- `npm audit` 结果会随时间变化；只有当前执行结果才能支持当前结论。
- 本机单平台便携 smoke 通过不能代表另一发布目标；Windows x64 与 Linux x64 结论必须来自 Actions 矩阵。

受限沙箱中若 Vite/esbuild 报父目录 `Access is denied`，先确认错误与权限相关，再在获准环境重跑完整构建；不要把环境限制误报为代码构建失败。
