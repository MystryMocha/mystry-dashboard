简体中文说明在英文之后。

## English

### Highlights

- **Self-contained portable package**: Bundles Node.js and production dependencies for Windows x64 and Linux x64 — no need to install Node.js or run `npm install`.
- **Zero-token first start**: First launch automatically generates random secrets in `config/panel.env` and creates the `admin` account with a one-time random password shown in the window (change it in the panel, or run `reset-password` locally if forgotten).
- **Full Minecraft server lifecycle**: One-click deploy for Paper, Fabric, Forge, NeoForge and Vanilla, two-stage ZIP import, local folder import from `data/imports`, live console, running-server backups, and built-in Virtual LAN (EasyTier) or frp multiplayer (opening only the game port, never the panel).
- **Network & language ready**: Switch between Official and Mainland China download sources (mirrored files are used only when their checksum can be verified; frp and EasyTier are checked against pinned SHA-256 values and can be installed from an uploaded archive), and use the web UI in English, Simplified Chinese or Traditional Chinese.

### Quick Start in 3 Steps

1. **Extract and launch**: On Windows, extract the archive and double-click `mystryctl.cmd` (or run `mystryctl.cmd start`). On Linux, extract the archive, run `chmod +x mystryctl`, then run `./mystryctl start`.
2. **Sign in at `http://127.0.0.1:3000`**: Use the `admin` username and the one-time password printed in the launcher window. Closing the Windows log window leaves the panel and your servers running in the background; reopen `mystryctl.cmd` and press `Ctrl+C` (or run `mystryctl stop`) for a safe shutdown.
3. **Prepare Java for Minecraft**: The package does not bundle a Minecraft Java runtime. By default it uses `java` on your system `PATH`, or you can scan for and select another installed runtime in the panel.

### Upgrading and Keeping Your Data

Run `mystryctl stop` in the old folder first. Extract the new version into a new folder next to it, then move your existing `config/`, `data/` and `logs/` into the new folder. Don't overwrite a folder that's running, and back up these three folders separately before you upgrade.

### Verification, Security and Known Limitations

- **Platform scope**: This preview ships for Windows x64 and Linux x64 only. It doesn't include Linux ARM64 or macOS builds, a system installer, service registration, start at boot, native auto-update or Windows code signing.
- **Network boundary**: The panel only listens on `127.0.0.1` by default. Don't expose the panel port directly to the untrusted public internet.
- **Signature & checksum verification**: After downloading, check the files against `SHA256SUMS`. Import `mystry-release-signing-key.asc` and confirm its fingerprint is `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8` (the same value as `.github/release-signing-key.fingerprint` in the repository; `gpg --fingerprint` prints it in groups of four, so ignore spaces and case when comparing), then use that public key to verify `SHA256SUMS.asc`.
- **Dependency audit**: The production dependency audit against the official registry on 2026-11-16 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories are React Router 6 dependency advisories (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg), fixed only in 7.18 and later. The frontend has no SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs. They still stand as a residual preview risk, and the audit is rerun for every release.

Full details are in `docs/portable-release.md` in the repository. The Chinese version is `docs/portable-release.zh-CN.md`.

## 简体中文

### 版本亮点

- **解压即用的独立便携包**：面向 Windows x64 与 Linux x64 内置 Node.js 和全部生产依赖，无需自行安装 Node.js 或执行 `npm install`。
- **首启免令牌自动建号**：首次启动自动在 `config/panel.env` 生成随机密钥，并创建管理员 `admin` 与一次性随机密码显示在窗口中（可在面板内修改，忘记密码时可在本机运行 `reset-password` 重置）。
- **完整的开服与联机链路**：支持 Paper、Fabric、Forge、NeoForge、Vanilla 一键部署，ZIP 二阶段预检导入，从 `data/imports` 复制导入已有服务端，实时着色控制台，运行中热备份，以及内置虚拟局域网（EasyTier）与 frp 联机（只开放游戏端口，不暴露面板）。
- **国内网络与多语言支持**：支持在面板中切换官方来源或国内镜像（镜像文件只在能核对校验值时使用；联机工具 frp 与 EasyTier 按固定的官方 SHA-256 校验，并支持离线上传压缩包安装），界面支持英文、简体中文与繁體中文。

### 3 步快速启动

1. **解压并启动**：Windows 解压后直接双击 `mystryctl.cmd`（或运行 `mystryctl.cmd start`）；Linux 解压后先执行 `chmod +x mystryctl`，再运行 `./mystryctl start`。
2. **访问 `http://127.0.0.1:3000` 登录**：使用窗口里显示的 `admin` 账号和一次性密码登录。Windows 下关闭日志窗口不会影响后台运行的面板和服务端；需要停止时重新双击 `mystryctl.cmd` 按 `Ctrl+C`（或运行 `mystryctl stop`）安全停止。
3. **准备 Minecraft 所需的 Java**：包内不包含 Minecraft Java 运行时；默认使用系统 `PATH` 中的 `java`，也可在面板中扫描并选择本机其他已安装运行时。

### 升级与数据保留

先在旧目录运行 `mystryctl stop`，将新版本解压到新的同级目录，再把原有 `config/`、`data/` 与 `logs/` 移入新目录。不要覆盖正在运行的目录，升级前请另外备份这三个目录。

### 签名校验、安全与已知限制

- **平台范围**：本 Preview 仅发布 Windows x64 与 Linux x64；不提供 Linux ARM64、macOS、系统安装器、服务注册、开机启动、原生自动更新或 Windows 代码签名。
- **监听边界**：默认只监听 `127.0.0.1`；不要把面板端口直接暴露到不可信公网。
- **哈希与签名校验**：下载后请先使用 `SHA256SUMS` 校验文件，导入 `mystry-release-signing-key.asc` 并核对指纹为 `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8`（与仓库 `.github/release-signing-key.fingerprint` 相同；`gpg --fingerprint` 会每 4 位分组显示，比对时忽略空格与大小写），再用该公钥验证 `SHA256SUMS.asc`。
- **依赖安全审计**：2026-11-16 官方 registry 生产依赖审计为 0 critical、0 high、2 moderate。两项 moderate 来自 React Router 6 系依赖公告（GHSA-wrjc-x8rr-h8h6、GHSA-337j-9hxr-rhxg），修复版只在 7.18 以上；当前前端没有 SSR hydration，并且导航目标来自固定站内路径或服务端生成的实例 ID，但仍作为 Preview 残余风险保留并在每次发布重新审计。

完整说明见仓库中的 `docs/portable-release.zh-CN.md`，英文版是 `docs/portable-release.md`。
