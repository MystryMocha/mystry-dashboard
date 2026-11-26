# 便携预览版

[English](portable-release.md) · **简体中文**

`v0.3.0-preview.1` 的便携包内置 Node.js 22、生产依赖与已构建的前后端。前往 [GitHub Releases](https://github.com/MystryMocha/mystry-dashboard/releases/latest) 下载对应系统的压缩包，解压即可启动，无需安装 Node.js 或运行 `npm install`：

| 系统 | 文件 |
|------|------|
| Windows x64 | `mystry-v0.3.0-preview.1-windows-x64.zip` |
| Linux x64 | `mystry-v0.3.0-preview.1-linux-x64.tar.gz` |

Minecraft 所需的 Java 不随包提供。实例默认使用系统 `PATH` 中的 `java`，也可在面板中选择已扫描并验证的本机运行时，或在缺少推荐版本时一键安装 Eclipse Temurin。其他系统（如 macOS 或 Linux ARM64）请按 [快速开始](getting-started.zh-CN.md) 从源码启动。

## 启动

Windows：

```text
解压 → 双击 mdash.cmd → 面板在后台运行并打开浏览器 → 用窗口里的账号密码登录 → 要停止时在窗口里按 Ctrl+C
```

首次启动会创建含随机密钥的 `config/panel.env`，并创建管理员 `admin` 与 16 位随机密码；密码仅在窗口中显示一次，不写入日志文件。打开 `http://127.0.0.1:3000` 登录后，点击左下角齿轮进入「面板设置」，再点「修改密码」即可换成自己的密码。忘记密码时，在面板运行期间于交互终端执行 `.\mdash.cmd reset-password`（Linux 为 `./mdash reset-password`）；若输出被重定向或经管道传出，命令将拒绝执行，避免新密码落入文件。切勿上传或分享 `config/panel.env`。

双击后，面板与服务端以 daemon 形式在后台运行，自身没有独立窗口；当前窗口仅显示账号与重要日志，完整日志位于 `logs/panel.stdout.log`。关闭窗口不影响面板与服务端；再次双击 `mdash.cmd` 即可重新查看日志，或按 Ctrl+C 安全停止面板与所有服务端（关机或重启电脑前也请先行停止）。面板在其他窗口中重启时，此窗口会接着跟踪新面板的日志；启动失败时，窗口会停留在报错信息上，按回车后关闭。

也可在终端中管理面板（运行 `.\mdash.cmd menu` 打开交互菜单；带参数的命令调用不会暂停，可安全用于脚本）：

```powershell
.\mdash.cmd start
```

Linux：

```bash
tar -xzf mystry-v0.3.0-preview.1-linux-x64.tar.gz
cd mystry-dashboard
chmod +x mdash
./mdash start
```

统一命令：

| 命令 | 作用 |
|------|------|
| `start` | 后台启动，写入 PID 指纹、执行健康检查并记录日志 |
| `watch` | 后台启动并查看日志，即双击时的操作 |
| `foreground` | 前台启动，用于排错；关闭窗口时面板随之退出 |
| `stop` | 通过本机令牌请求安全关闭 |
| `restart` | 停止后重新在后台启动 |
| `status` | 检查健康状态与受管进程状态 |
| `logs` | 显示最近日志 |
| `open` | 打开面板地址 |
| `reset-password` | 面板运行期间在交互终端中重置并显示新的随机管理员密码 |
| `remote` | 面板运行期间开关「从其他设备访问」：`remote on`、`remote off`、`remote status`、`remote https off`、`remote renew-cert` |
| `menu` | 打开交互式命令菜单 |

## 目录与数据

```text
mystry-dashboard/
├── runtime/              # 固定版本的官方 Node.js 运行时
├── app/                  # 已构建应用和生产依赖
├── config/               # 首启配置和配置备份
├── data/                 # 数据库、实例、缓存和上传临时文件
├── logs/                 # 面板标准输出和错误日志
├── mdash.cmd
├── mdash
├── manifest.json
├── VERSION
├── README.txt
└── LICENSE
```

实例始终位于 `data/instances/<id>`。`manifest.json` 记录产品版本、Git SHA、Node 版本、目标平台、架构、构建时间，以及包内每个发布文件的大小与 SHA-256。发布包中的 `config/`、`data/` 与 `logs/` 初始为空，包内不含 `.env`、数据库、缓存、实例或开发依赖。

## 升级与回滚

切勿覆盖正在运行的便携目录：

1. 在旧目录运行 `mdash stop`，再以 `mdash status` 确认已停止。0.2.0-preview.5 及更早版本中，该命令名为 `mystryctl` 而非 `mdash`。
2. 将新版本解压至新的同级目录。
3. 确认新目录的 `config/`、`data/`、`logs/` 为空。
4. 将旧目录中的这三个目录移至新目录，并保留旧应用目录作为回滚副本。
5. 从新目录运行 `mdash start`，检查登录、实例列表与存档。
6. 确认无误后，自行归档旧应用目录；切勿删除唯一的数据副本。

回滚时，先停止新版本，将 `config/`、`data/`、`logs/` 移回旧应用目录后再启动。新版本若升级过数据库结构，升级前已在 `data/db-backups/` 留存旧库副本；旧版本可能拒绝打开升级后的数据库，并列出两个结构版本号。此时将 `panel.db` 及可能存在的 `panel.db-wal`、`panel.db-shm` 移出 `data/`，再从 `data/db-backups/` 中选一份复制为 `data/panel.db`：文件名后缀 `-v<N>` 不得高于旧版本报错中所写的支持版本，满足条件的取最新一份。升级之后的改动不在该副本中。副本仅涵盖数据库，因此升级前仍须另行备份这三个目录，不可仅依赖旧应用目录。

若环境中已设置 `MYSTRY_HOME`，Windows `.cmd` 与 Unix `.sh` 包装脚本将保留该值，并仅对未设置的 `MYSTRY_CONFIG_PATH`、`MYSTRY_DATA_DIR` 使用便携包默认值；相对路径均相对于 `MYSTRY_HOME`。日常使用便携版无需手动设置这些变量。

## 校验下载文件（可选）

每个 GitHub Release 均同时提供校验和文件 `SHA256SUMS`、分离式 GPG 签名 `SHA256SUMS.asc`、发布签名公钥 `mystry-release-signing-key.asc`（与仓库中的 [`.github/release-signing-key.asc`](../.github/release-signing-key.asc) 相同）及生产依赖清单 `sbom.cdx.json`。

### 1. 校验 SHA-256 哈希

Windows PowerShell（将输出与 `SHA256SUMS` 中的对应行比对）：

```powershell
Get-FileHash .\mystry-v0.3.0-preview.1-windows-x64.zip -Algorithm SHA256
```

Linux：

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

### 2. 校验 GPG 签名

导入公钥，确认输出的 40 位十六进制指纹与仓库中的 [`.github/release-signing-key.fingerprint`](../.github/release-signing-key.fingerprint)（或 Release 说明中的记录，忽略空格与大小写）完全一致后，再验证 `SHA256SUMS.asc`（Windows 可在 WSL 或 Gpg4win 中执行）：

```bash
gpg --import mystry-release-signing-key.asc
gpg --fingerprint
gpg --verify SHA256SUMS.asc SHA256SUMS
```

## Preview 已知限制

- 公开发布仅覆盖 Windows x64 与 Linux x64；暂不提供 Linux ARM64 与 macOS 便携包。
- 不提供 NSIS、DEB、PKG 安装包，也不支持系统级安装或卸载。
- 当前以便携目录而非 [Node SEA](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html) 单文件可执行程序分发：该特性仍标为 Active development，且面向单个 CommonJS 主脚本，不适合当前 ESM、多包与静态前端资源的目录结构。
- 不注册 WinSW、systemd 或 LaunchDaemon，也不随开机自动启动。
- Windows 产物尚无代码签名，操作系统可能显示来源警告。
- 不提供原生自动更新、自动回滚与运行中覆盖升级。
- Java 8/17/21/25 不随包提供；可使用系统 `PATH` 中的运行时、选择面板扫描到的其他已安装版本，或在缺少推荐版本时由面板安装 Eclipse Temurin。
- 登录仍使用浏览器本地存储的 JWT；Cookie 会话、CSRF 防护、TOTP 与公网部署向导尚未实现。
- 面板默认仅监听 `127.0.0.1`。切勿将面板端口直接暴露于不可信的公网。
- 2026-11-26 针对官方 registry 的生产依赖审计结果为 0 critical、0 high、2 moderate。两项 moderate 均为 React Router 6 系公告（GHSA-wrjc-x8rr-h8h6 反斜杠开放重定向、GHSA-337j-9hxr-rhxg SSR hydration 构造注入），仅 7.18 及更高版本修复。当前 SPA 不使用 SSR hydration，导航目标均来自固定站内路径或服务端生成的实例 ID；但这些公告仍作为 Preview 残余风险记录，每次发布须重新审计。此前的公告已通过以下升级消除：`react-router-dom` / `react-router` 升至 6.30.6（GHSA-jjmj-jmhj-qwj2），`@fastify/static` 升至 10.1.10 并带动 `glob` 14.0.3 / `minimatch` 11.0.4（GHSA-3g3m-2fjr-6pw4、GHSA-g3hv-75wg-m249），以及传递依赖（`fastify` 5.12.7、`fast-jwt` 6.3.5、`@fastify/busboy` 3.2.3、`fast-uri` 3.1.9 / 4.2.3、`brace-expansion` 5.0.12）。开发依赖 `vitest` 3 系的 `tinypool` critical 公告不进入便携包；修复需跨大版本升级，暂未处理。

## 发布维护

本地原生平台构建与验证：

```bash
npm ci
npm run verify
npm run audit:production
npm run build
node scripts/portable/package-portable.mjs --platform win32 --arch x64 --output-dir release
node scripts/portable/smoke-portable.mjs release/mystry-v0.3.0-preview.1-windows-x64.zip
```

以上流程可由一条命令完成（在目标平台原生运行，自动采用当前平台与架构，并生成压缩包、SHA256SUMS 与 SBOM）：

```bash
npm run package:release
```

在 Windows 上也可双击 `scripts/portable/package-release.cmd`。参数：

- `--skip-install`：跳过 `npm ci`（须已安装依赖）
- `--skip-verify`：跳过 `verify` 与生产依赖审计，仅构建并打包（供开发自测）
- `--skip-smoke`：跳过对最终压缩包的冒烟验证
- `--no-force`：已有同名压缩包时拒绝覆盖
- `--allow-dirty`：允许在脏工作树上打包（非发布用途）
- `--output-dir <目录>`：指定输出目录，默认为 `release`
- `--runtime-dir <目录>`：复用本机已下载的 Node 运行时，不重新下载

`package-portable.mjs` 写入 `manifest.json` 的 Git SHA 优先取自当前 checkout 的 `git rev-parse HEAD`（而非 workflow 的 `GITHUB_SHA`）。正式资产须基于干净的工作树；本地非发布调试可设置 `MYSTRY_PORTABLE_ALLOW_DIRTY=1` 或传入 `--allow-dirty`。

首次启用签名前，维护者须按 [`.github/RELEASE_SIGNING.md`](../.github/RELEASE_SIGNING.zh-CN.md) 提交公钥与单行指纹文件 [`.github/release-signing-key.fingerprint`](../.github/release-signing-key.fingerprint)。目标平台须与构建机的平台、架构一致。发布流程定义于 `.github/workflows/portable-release.yml`：仅当现有 `v*` 标签位于 `main` 历史中、版本与根 `package.json` 一致且 checkout 工作树干净时，方可触发发布；prepare 阶段执行 `npm run verify` 与生产依赖审计；Windows x64 矩阵 job 显式执行 `npm run windows:test`；Win/Linux x64 两个最终压缩包均须重新解压并通过健康检查，Release job 才会生成校验和、经指纹绑定的 GPG 签名、SBOM 与自动 Release Notes。若流水线缺少 `RELEASE_GPG_PRIVATE_KEY`，或 `RELEASE_GPG_FINGERPRINT` 与仓库指纹不一致，流水线将拒绝创建公开 Release，绝不降级为未签名发布；CI 先在独立 keyring 中以仓库公钥验证 `SHA256SUMS.asc`，再执行 `gh release create`。第三方 Actions 使用固定的 commit SHA，见 [`.github/actions-pins.md`](../.github/actions-pins.md)。

仓库须在 GitHub `release` Environment 中配置：

- `RELEASE_GPG_PRIVATE_KEY`：ASCII armored 私钥，必需。
- `RELEASE_GPG_PASSPHRASE`：私钥有密码时配置。
- `RELEASE_GPG_FINGERPRINT`：与 [`.github/release-signing-key.fingerprint`](../.github/release-signing-key.fingerprint) 一致的公钥指纹，必需。

`release` Environment 应启用 **Required reviewers**（人工审批），并限制仅受保护分支上的发布 workflow 可访问；此项须由仓库管理员在 GitHub Settings 中配置并留存记录。

正式打标签前，先将版本提交合入 `main`，再在该提交上创建并推送标签。流水线不会自动创建标签，也不发布不在 `main` 中的提交。

Release 正文取自 `.github/portable-preview-notes.md`，包内 `README.txt` 由 `package-portable.mjs` 生成，两者均为英文在前、中文在后。本页另有英文版 `portable-release.md`，发布维护一节仅在中文版完整列出。更新版本号、审计结论或其他事实时，须同步修改所有语言；`npm run portable:test` 比对日期、版本号、公告编号、行内代码与列表结构，但无法比对文意，改写说明后须人工对照。
