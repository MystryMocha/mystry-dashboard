# 贡献指南

[English](CONTRIBUTING.md) · **简体中文**

感谢你对 **Mystry Dashboard** 的关注。本指南说明如何参与开发与文档改进。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.zh-CN.md)。

## 我能贡献什么？

- Bug 报告与复现步骤
- 功能建议（先在 Issue 中讨论，避免重复工作）
- 文档与教程修正 / 翻译
- 代码修复与小范围功能增强

重大架构调整、引入新依赖或破坏性变更前，请先开 Issue，与维护者商定方向。

## 开发环境

| 依赖 | 要求 |
|------|------|
| Node.js | ≥ 22 |
| Java | 用于本地验证实例启停（可选，但强烈建议） |

先按 [快速开始：手动安装与首次配置](docs/getting-started.zh-CN.md#手动安装与首次配置) 安装依赖并配置随机密钥，再按 [开发指南](docs/development.zh-CN.md) 启动两个开发终端。仅复制 `.env.example` 而不填写密钥，无法完成首次启动。

Windows PowerShell 使用 `npm.cmd`，仓库内管理器以 `.\mdash.cmd` 运行；Linux/macOS 使用 `npm`。

详见 [开发指南](docs/development.zh-CN.md) 与 [docs/getting-started.zh-CN.md](docs/getting-started.zh-CN.md)。

## 分支与提交

1. 从默认分支创建功能分支，例如 `fix/console-reconnect`、`docs/readme-typo`。
2. 保持改动聚焦：一个 PR 只解决一个问题。
3. 提交信息使用英文，简要说明 **为什么**，例如：
   - `fix: prevent path escape in zip import`
   - `docs: explain JWT setup for production`
4. 新增、修改的代码注释使用**英文**。Web 界面文案写入 `apps/web/src/i18n/` 的文案表，英文、简体中文与繁體中文须同时提供（见下方「用户可见文案」）。

## 代码约定

- TypeScript + ESM；与周围文件风格保持一致。
- 新增前后端共用类型时，先改 `packages/shared`，再构建 shared。
- 涉及实例路径的读写须经现有路径校验（见 `apps/server/src/utils/path.ts` / `file-service`），禁止自行拼接未经校验的路径。
- 不得提交 `.env`、`data/`、密钥或本机绝对路径。
- 避免无关重构与全仓库格式化。

## 用户可见文案

Web 界面支持英文（默认）、简体中文与繁體中文，规则如下：

- 文案以按含义命名的键（如 `instance.status.running`）写入 `apps/web/src/i18n/en/<区域>.ts`，并在 `zh-CN/<区域>.ts` 与 `zh-TW/<区域>.ts` 补齐同一键；类型检查拒绝缺失或多余的键。组件通过 `useI18n()` 的 `t()` 取文案，不内联字符串，也不将一句话拆成多个键拼接。
- 状态词、通用动作与导航名仅在 `i18n/en/common.ts` 定义一次，各页面复用，不另造同义词。
- 英文：标题、按钮、菜单、标签页用 Title Case；说明、提示、对话框正文用 sentence case 并以句号结尾；称呼用 you；技术名（Paper、JVM、`server.properties` 等）不翻译。英文通常比中文长 30–60%，横排中的按钮与标签须设 `white-space: nowrap` + `flex-shrink: 0`，并在窄屏下检查，避免被挤成竖排。
- 繁體中文采用台湾惯用词，不得将简体直接转为繁体：伺服器、檔案、資料夾、連線、載入、設定、主控台、指令、當機；对照表见 `i18n/zh-TW/common.ts`。
- 数字、日期与大小使用 `useI18n().fmt`（基于 `Intl`），不得写死 `'zh-CN'`。
- 服务端返回给用户的错误与任务进度使用 `server.*` 消息键（`PanelError`、`panelErrorBody`、任务 `report(progress, { key, params })`）：英文模板位于 `packages/shared/src/messages/<区域>.ts`，简体与繁體翻译位于 `apps/web/src/i18n/zh-CN/server/`、`zh-TW/server/`。除启动期终端日志外，服务端不再输出中文提示。

中文界面文字、错误信息与用户文档统一采用下表叫法：

| 统一为 | 不要写成 | 说明 |
|------|------|------|
| 任务中心 | 任务队列、后台任务中心、后台异步任务中心 | 顶栏按钮与右侧抽屉均称「任务中心」 |
| 系统默认 Java | 系统 Java、PATH 中的 java | 仅在帮助文档中解释一次：指面板进程 `PATH` 中的 `java` |
| 命令 | 指令 | 在控制台发送给服务器的内容，与中文 Minecraft Wiki 一致 |
| 条目 | entry | ZIP 中的单个文件或目录 |
| 安装器 | installer | Forge / NeoForge 的安装程序；Fabric 的版本字段沿用产品名「Installer 版本」 |
| 符号链接或目录联接 | symlink/junction | |
| 登录已失效，请重新登录 | 未授权、未登录 | 所有 401 响应 |

写法：

- 称呼用「你」，不用「您」。
- 冒号、括号、逗号用全角；引号用「」，不用 “” 或 ""。
- 内存与文件大小单位写 MiB、GiB（按 1024 换算），不写 MB、GB。
- 产品名与格式名写作 ZIP、Java、Minecraft、Paper、Fabric、Forge、NeoForge。
- 说明事实与下一步，不写「立即」「全新」「一键开启」「请耐心等待」「敬请期待」这类推销或安抚的措辞。
- 错误信息须说明问题所在与用户可采取的操作；不得将内部字段名（如 ticket、marker、staging）原样展示给用户。

## Pull Request 检查清单

提交 PR 前请自行确认：

- [ ] `npm.cmd run verify` 通过（Linux/macOS 使用 `npm run verify`）
- [ ] 若改动 API，已更新 [docs/api.zh-CN.md](docs/api.zh-CN.md) 及其英文版
- [ ] 若改动配置项，已更新 `.env.example` 与 [docs/configuration.zh-CN.md](docs/configuration.zh-CN.md)
- [ ] 已手动验证相关流程（登录 / 部署 / 控制台 / 文件等）
- [ ] 配置、路由、脚本或 AI 入口变化时，已同步 `docs/ai/project-facts.json`
- [ ] UI 改动已按真实路径验证桌面、窄屏与相邻入口
- [ ] PR 描述区分已实现、已验证、未验证与剩余风险

## 文档贡献

通过 [文档中心](docs/README.zh-CN.md) 找到对应正文，在原页修正；Wiki 仅维护导航。功能描述须与当前源码核对；历史审查和计划保留其日期与适用范围，不改写为当前结论。同时有英文版（`X.md`）与中文版（`X.zh-CN.md`）的文档，须一并修改。文档检查与提交要求见 [验证矩阵](docs/ai/verification.md)。

## Issue 报告建议

**Bug**：环境（OS / Node / Java 版本）、复现步骤、期望与实际行为、相关日志（按需脱敏）。

**功能**：使用场景、期望行为、是否已有替代方案。

安全问题请勿公开提交 Issue，见 [安全政策](SECURITY.zh-CN.md)。

## 许可证

贡献的代码以 [MIT License](LICENSE) 发布。提交 PR 即表示你有权以该许可证贡献相关内容。
