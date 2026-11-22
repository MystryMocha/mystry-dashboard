# 开发指南

[English](development.md) · **简体中文**

## 前置步骤

先阅读 [项目开发规则](../CLAUDE.md)，并运行 `git status --short --branch` 确认当前分支与已有修改。使用 Node.js ≥ 22，在仓库根目录执行命令。

首次运行须先完成 [手动安装与密钥配置](getting-started.zh-CN.md#手动安装与首次配置)，再分别运行 `npm.cmd run dev:server` 与 `npm.cmd run dev:web`。Windows PowerShell 使用 `npm.cmd`；下文的 `npm` 示例适用于 Linux/macOS，脚本名相同。

后端默认为 `http://127.0.0.1:3000`，开发界面为 `http://127.0.0.1:5173`，由 Vite 代理 `/api` 与 `/ws`。修改后端端口时，同步检查 `apps/web/vite.config.ts`。

```bash
npm install
npm run build -w @mystry/shared
```

在 Linux / WSL 中以整合面板方式运行源码，可使用根目录的 `mdash.sh`。它检查 Node.js 22，按锁文件补装缺失依赖，完成构建，并复用跨平台的安全生命周期控制器：

```bash
chmod +x mdash.sh
./mdash.sh start
```

默认配置为 `config/panel.env`，数据根为仓库内的 `data/`，两者均不应提交。如需隔离测试数据，在每次执行启动/停止/状态命令前设置相同的 `MYSTRY_CONFIG_PATH` 与 `MYSTRY_DATA_DIR`。

修改 `packages/shared` 后须重新构建 shared，server / web 才能获得最新类型。

独立类型检查（不产出构建物）：

```bash
npm run build -w @mystry/shared
npm run typecheck
```

## 工作区包

### `@mystry/shared`

```bash
npm run build -w @mystry/shared
```

输出：`packages/shared/dist/`。新增前后端共用字段时，应先修改此处；请求体校验 schema 位于 `src/schemas.ts`，由路由直接引用。

### `@mystry/server`

- 开发：`npm run dev -w @mystry/server`（通常经根目录的 `npm run dev:server` 启动）
- 构建：`npm run build -w @mystry/server`
- 入口：`apps/server/src/index.ts`

### `@mystry/web`

- 开发：`npm run dev -w @mystry/web`
- 构建：`npm run build -w @mystry/web`
- 别名：`@` → `src/`

## 添加 REST 接口的建议流程

1. 如有需要，在 `packages/shared` 中补充请求 / 响应类型，并同步 `schemas.ts` 中对应的 JSON Schema。
2. 在 `apps/server/src/services/` 实现业务逻辑。
3. 在 `apps/server/src/routes/` 注册路由；若需登录，挂载 `authenticate`；body schema 优先从 `@mystry/shared` 引入。
4. 在 `apps/web/src/api.ts` 或页面中调用。
5. 确认用户可见入口、加载状态与错误反馈；新增路由模块时，更新 `apps/server/src/index.ts` 中的注册。
6. 更新 [API 参考](api.zh-CN.md) 与相关知识库，并按 [验证矩阵](ai/verification.md) 检查契约与真实操作链路。

## 路径与安全

- 实例目录解析：`apps/server/src/utils/path.ts`（`resolveDirFromRow` 等）。
- 文件操作必须经过 `file-service` 的路径校验，以防目录穿越。

## 进程与控制台

- 所有实例进程由单例 `processManager` 管理。
- 扩展多实例并发时注意：`start` / `stop` 已持有状态锁，以避免重复 spawn。
- 控制台事件：`output`、`status`（EventEmitter）。

## 数据库

- 初始化：`initDb()` 在 `index.ts` 启动时调用。
- 表结构变更：当前无迁移框架；改表时须手动处理已有的 `panel.db`，或编写一次性迁移脚本。

## 代码风格

- 与现有文件保持一致：ESM（`import`）、TypeScript，服务端文件以 `.ts` 为后缀并编译为 `.js`。
- 注释使用英文。Web 界面文案写入 `apps/web/src/i18n/` 的英文、简体中文与繁體中文文案表，规则见 [贡献指南](../CONTRIBUTING.zh-CN.md#用户可见文案)。
- 避免无关重构，优先小范围修复。

## AI 项目知识库

- 根目录 `CLAUDE.md` 是 Claude Code 的强制入口，详细资料位于 `docs/ai/`。
- 路由、环境变量、workspaces、入口或验证脚本变化时，必须同步 `docs/ai/project-facts.json`。
- 当前事实、计划、已否决方案与历史故障必须分层记录，不得将旧计划视为已实现的能力。
- 快速检查：`npm run knowledge:check`；检查器负向测试：`npm run knowledge:test`。
- 锁文件只记录官方地址。若本机 npm 配置了镜像，安装新依赖后运行 `npm run lockfile:fix`。
- 完整门禁：`npm run verify`。在 Windows PowerShell 终端中直接执行时，使用 `npm.cmd run verify`。
- 远程 CI：Quality Gate（`.github/workflows/quality.yml`）在推送到 `main` 和每个 PR 时，于 `ubuntu-latest` 与 `windows-2025` 上各执行一次 `npm ci` 与 `npm run verify`（见 [验证矩阵](ai/verification.md#远程-ci)）。

## 本地验证清单

提交前运行与改动相关的检查；推送前运行完整的 `npm.cmd run verify`，PR 上的 Quality Gate 将再次运行。完整门禁不含生产依赖审计，依赖变更与发布须另行运行 `npm.cmd run audit:production`。以下人工检查项按改动范围选用，并使用独立的测试数据；数据库演练仅使用副本。自动检查通过不能替代真实交互验证。

- [ ] `npm run knowledge:check` 与 `npm run knowledge:test` 无错误
- [ ] `npm run build -w @mystry/shared` 后运行 `npm run test:smoke`（已包含在 `verify` 中；不启动 Minecraft，不使用仓库内的 `data/`）
- [ ] `npm run typecheck` 无错误
- [ ] `GET /api/health` 返回 ok
- [ ] 登录 / setup 流程
- [ ] 创建或部署实例并启动
- [ ] WebSocket 控制台有输出且可发送命令
- [ ] 文件列表与 `server.properties` 读写
- [ ] `npm run build` 无错误，`npm start` 可打开整合页面

## 便携包开发与发布

便携工具位于 `scripts/portable/`。每个压缩包必须在相同操作系统与架构的原生 runner 上组装，再解压最终压缩包验证：

```bash
npm run portable:test
npm run audit:production
npm run build
node scripts/portable/package-portable.mjs --platform win32 --arch x64 --output-dir release
node scripts/portable/smoke-portable.mjs release/mystry-v0.2.0-preview.6-windows-x64.zip
```

`package-portable.mjs` 从 Node.js 官方发布站下载固定版本的运行时并按 `SHASUMS256.txt` 校验，以 `npm ci --omit=dev` 创建独立的生产依赖树，物理复制 `@mystry/shared`，并拒绝包内的符号链接。不要直接从当前仓库的 `node_modules` 打包。

`.github/workflows/portable-release.yml` 在 Windows x64 与 Linux x64 矩阵全部通过后生成 Release。发布前还必须通过 `npm run verify` 与 `npm run audit:production`；缺少签名密钥将阻止公开 Release。维护操作与数据升级流程见 [便携预览版](portable-release.zh-CN.md)。

## 相关文档

- [贡献指南](../CONTRIBUTING.zh-CN.md)
- [架构设计](architecture.zh-CN.md)
- [配置说明](configuration.zh-CN.md)
- [便携预览版](portable-release.zh-CN.md)
- [AI 项目知识库](ai/README.md)
