# 贡献指南

感谢你对 **Mystry Dashboard** 的关注。本指南说明如何参与开发与文档改进。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 我能贡献什么？

- Bug 报告与复现步骤
- 功能建议（先开 Issue 讨论，避免重复劳动）
- 文档与教程修正 / 翻译
- 代码修复与小范围功能增强

大改架构、引入新依赖或破坏性变更前，请先开 Issue 与维护者对齐。

## 开发环境

| 依赖 | 要求 |
|------|------|
| Node.js | ≥ 22 |
| Java | 用于本地验证实例启停（可选，但强烈建议） |

先按 [快速开始：手动安装与首次配置](docs/getting-started.zh-CN.md#手动安装与首次配置) 安装依赖并配置随机密钥，再按 [开发指南](docs/development.md) 启动两个开发终端。只复制 `.env.example` 而不填写密钥无法完成首启。

Windows PowerShell 使用 `npm.cmd`，执行仓库内管理器使用 `.\PanelManager.cmd`；Linux/macOS 使用 `npm`。

更多细节见 [docs/development.md](docs/development.md) 与 [docs/getting-started.zh-CN.md](docs/getting-started.zh-CN.md)。

## 分支与提交

1. 从默认分支创建功能分支，例如 `fix/console-reconnect`、`docs/readme-typo`。
2. 保持改动聚焦：一次 PR 只解决一个问题。
3. 提交信息简洁说明 **为什么**，例如：
   - `fix: 防止 zip 导入时路径逃逸`
   - `docs: 补充生产部署 JWT 说明`
4. 新增、修改的代码注释使用**英文**。Web 界面文案写进 `apps/web/src/i18n/` 的文案表，英文、简体中文与繁體中文同时提供（见下方「用户可见文案」）。

## 代码约定

- TypeScript + ESM；与周围文件风格保持一致。
- 新增前后端共用类型时，先改 `packages/shared`，再构建 shared。
- 涉及实例路径的读写必须走现有路径校验（见 `apps/server/src/utils/path.ts` / `file-service`），禁止自行拼接未校验路径。
- 不要提交 `.env`、`data/`、密钥或本机绝对路径。
- 避免无关重构与格式化整个仓库。

## 用户可见文案

Web 界面支持英文（默认）、简体中文和繁體中文，规则如下：

- 文案按含义命名的键（如 `instance.status.running`）写进 `apps/web/src/i18n/en/<区域>.ts`，再在 `zh-CN/<区域>.ts` 与 `zh-TW/<区域>.ts` 补上同一个键；类型检查会拒绝缺键或多余的键。组件里用 `useI18n()` 的 `t()` 取文案，不内联字符串，也不把一句话拆成几个键拼接。
- 状态词、通用动作和导航名只在 `i18n/en/common.ts` 定义一次，各页面复用，不另起同义词。
- 英文：标题、按钮、菜单、标签页用 Title Case；说明、提示、对话框正文用 sentence case 并以句号结尾；称呼用 you；技术名（Paper、JVM、`server.properties` 等）不翻译。英文通常比中文长 30–60%，横排里的按钮和标签要 `white-space: nowrap` + `flex-shrink: 0`，窄屏下检查不被挤成竖排。
- 繁體中文用台湾惯用词，不要把简体直接转成繁体：伺服器、檔案、資料夾、連線、載入、設定、主控台、指令、當機；对照表见 `i18n/zh-TW/common.ts`。
- 数字、日期和大小用 `useI18n().fmt`（基于 `Intl`），不要写死 `'zh-CN'`。
- 服务端返回给用户的错误和任务进度用 `server.*` 消息键（`PanelError`、`panelErrorBody`、任务 `report(progress, { key, params })`）：英文模板写在 `packages/shared/src/messages/<区域>.ts`，简体与繁體翻译写在 `apps/web/src/i18n/zh-CN/server/`、`zh-TW/server/`。服务端不再写中文提示；启动期终端日志除外。

中文界面文字、错误信息和用户文档按下表统一叫法：

| 统一为 | 不要写成 | 说明 |
|------|------|------|
| 任务中心 | 任务队列、后台任务中心、后台异步任务中心 | 顶栏按钮和右侧抽屉都叫「任务中心」 |
| 系统默认 Java | 系统 Java、PATH 中的 java | 只在帮助文档中解释一次：指面板进程 `PATH` 中的 `java` |
| 命令 | 指令 | 控制台里发送给服务器的内容，与中文 Minecraft Wiki 一致 |
| 条目 | entry | ZIP 中的单个文件或目录 |
| 安装器 | installer | Forge / NeoForge 的安装程序；Fabric 的版本字段沿用产品名「Installer 版本」 |
| 符号链接或目录联接 | symlink/junction | |
| 登录已失效，请重新登录 | 未授权、未登录 | 所有 401 响应 |

写法：

- 称呼用「你」，不用「您」。
- 冒号、括号、逗号用全角；引号用「」，不用 “” 或 ""。
- 内存与文件大小单位写 MiB、GiB（按 1024 换算），不写 MB、GB。
- 产品名和格式名写 ZIP、Java、Minecraft、Paper、Fabric、Forge、NeoForge。
- 说明事实和下一步，不写「立即」「全新」「一键开启」「请耐心等待」「敬请期待」这类推销或安抚的话。
- 错误信息说清楚出了什么问题、用户能做什么；不要把内部字段名（如 ticket、marker、staging）原样展示给用户。

## Pull Request 检查清单

提交 PR 前请自行确认：

- [ ] `npm.cmd run verify` 通过（Linux/macOS 使用 `npm run verify`）
- [ ] 提交后 `npm.cmd run ci:local` 通过（远程不再自动检查 PR，见 [验证矩阵](docs/ai/verification.md#本机-ci)）
- [ ] 若改动 API，已更新 [docs/api.md](docs/api.md)
- [ ] 若改动配置项，已更新 `.env.example` 与 [docs/configuration.zh-CN.md](docs/configuration.zh-CN.md)
- [ ] 手动验证过相关流程（登录 / 部署 / 控制台 / 文件等）
- [ ] 配置、路由、脚本或 AI 入口变化时，已同步 `docs/ai/project-facts.json`
- [ ] UI 改动已按真实路径验证桌面、窄屏与相邻入口
- [ ] PR 描述区分已实现、已验证、未验证与剩余风险

## 文档贡献

先通过 [文档中心](docs/README.zh-CN.md) 找到对应正文，在原页修正；Wiki 只维护导航。功能描述需核对当前源码，历史审查和计划保留日期与适用范围，不写成当前结论。文档检查与提交要求见 [验证矩阵](docs/ai/verification.md)。

## Issue 报告建议

**Bug**：环境（OS / Node / Java 版本）、复现步骤、期望与实际行为、相关日志（可打码）。

**功能**：使用场景、期望行为、是否已有替代方案。

安全相关问题请勿公开开 Issue，见 [SECURITY.md](SECURITY.md)。

## 许可证

贡献的代码将在 [MIT License](LICENSE) 下发布。提交 PR 即表示你有权以该许可证贡献这些内容。
