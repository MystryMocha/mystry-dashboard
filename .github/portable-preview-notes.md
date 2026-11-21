简体中文说明在英文之后。

## English

### New in 0.2.0-preview.5

- **Open the panel on other devices**: The new "Other Devices" button turns access from a phone or another computer on or off inside the panel, with a URL and QR code. Choose direct access (HTTPS with a panel-issued certificate by default) or a virtual network, including a built-in EasyTier network that allows only the panel.
- **Upload Folder import**: Pick or drag in an existing server folder in the browser and the panel uploads and checks it before importing. Copying from `data/imports` stays available for very large servers.
- **One-click Java**: Deploy and import pick the right installed Java automatically, and can install a checksum-pinned Eclipse Temurin JRE (8 / 17 / 21 / 25) when it is missing.
- **Panel Settings and session duration**: A new settings page gathers language, appearance, session duration (12 hours by default, up to never expire), download source, account and runtime info.
- **Redesigned interface**: A one-row-per-server Instances list that says what to do next, card-free pages, two-column forms on desktop, a reworked Multiplayer page, and a fixed ink-purple accent.
- **Servers with a public IP**: The Multiplayer page gives a public join address and a checklist for cloud servers.

The full list of changes and fixes is in `CHANGELOG.md`. The Chinese version is `CHANGELOG.zh-CN.md`.

### Highlights

- **Self-contained portable package**: Bundles Node.js and production dependencies for Windows x64 and Linux x64 — no need to install Node.js or run `npm install`.
- **Zero-token first start**: First launch automatically generates random secrets in `config/panel.env` and creates the `admin` account with a one-time random password shown in the window (change it in the panel, or run `reset-password` locally if forgotten).
- **Full Minecraft server lifecycle**: One-click deploy for Paper, Fabric, Forge, NeoForge and Vanilla, folder upload and two-stage ZIP import of existing servers, live console, running-server backups, and built-in Virtual LAN (EasyTier) or frp multiplayer (opening only the game port, never the panel).
- **Network & language ready**: Switch between Official and Mainland China download sources (mirrored files are used only when their checksum can be verified; frp and EasyTier are checked against pinned SHA-256 values and can be installed from an uploaded archive), and use the web UI in English, Simplified Chinese or Traditional Chinese.

### Quick Start in 3 Steps

1. **Extract and launch**: On Windows, extract the archive and double-click `mystryctl.cmd` (or run `mystryctl.cmd start`). On Linux, extract the archive, run `chmod +x mystryctl`, then run `./mystryctl start`.
2. **Sign in at `http://127.0.0.1:3000`**: Use the `admin` username and the one-time password printed in the launcher window. Closing the Windows log window leaves the panel and your servers running in the background; reopen `mystryctl.cmd` and press `Ctrl+C` (or run `mystryctl stop`) for a safe shutdown.
3. **Prepare Java for Minecraft**: The package does not bundle a Minecraft Java runtime. The panel uses a Java already on your computer, and when the version a server needs is missing it can install a checksum-pinned Eclipse Temurin JRE for you.

### Upgrading and Keeping Your Data

Run `mystryctl stop` in the old folder first. Extract the new version into a new folder next to it, then move your existing `config/`, `data/` and `logs/` into the new folder. Don't overwrite a folder that's running, and back up these three folders separately before you upgrade.

### Verification, Security and Known Limitations

- **Platform scope**: This preview ships for Windows x64 and Linux x64 only. It doesn't include Linux ARM64 or macOS builds, a system installer, service registration, start at boot, native auto-update or Windows code signing.
- **Network boundary**: The panel only listens on `127.0.0.1` by default. Access from other devices is off until an administrator turns it on in the panel; once it is on, the sign-in page can be reached from the networks you chose, so keep HTTPS on and don't expose the panel to the untrusted public internet.
- **Signature & checksum verification**: After downloading, check the files against `SHA256SUMS`. Import `mystry-release-signing-key.asc` and confirm its fingerprint is `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8` (the same value as `.github/release-signing-key.fingerprint` in the repository; `gpg --fingerprint` prints it in groups of four, so ignore spaces and case when comparing), then use that public key to verify `SHA256SUMS.asc`.
- **Dependency audit**: The production dependency audit against the official registry on 2026-11-21 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories are React Router 6 dependency advisories (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg), fixed only in 7.18 and later. The frontend has no SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs. They still stand as a residual preview risk, and the audit is rerun for every release.

Full details are in `docs/portable-release.md` in the repository. The Chinese version is `docs/portable-release.zh-CN.md`.

## 简体中文

### 0.2.0-preview.5 新增

- **在其他设备上打开面板**：新的「其他设备」按钮可在面板里一键开关手机或另一台电脑的访问，给出网址和二维码。可选直接访问（默认 HTTPS，证书由面板自己签发）或虚拟组网，其中面板自带的 EasyTier 网络只放行面板。
- **上传文件夹导入**：在浏览器里选择或拖入已有服务端的文件夹，面板上传并检查后再导入；很大的服务端仍可从 `data/imports` 复制。
- **一键安装 Java**：部署和导入会自动选用合适的已装 Java，缺少时可一键安装固定校验值的 Eclipse Temurin JRE（8 / 17 / 21 / 25）。
- **面板设置与登录有效期**：新的设置页集中了语言、外观、登录有效期（默认 12 小时，可设为不过期）、下载来源、账号和运行信息。
- **界面改版**：实例总览改为一行一台并写明下一步该做什么，页面去掉卡片，桌面宽度下表单分两栏，联机页重新排版，强调色固定为墨紫。
- **有公网 IP 的服务器**：联机页给出公网加入地址和云服务器排查清单。

完整的改动和修复见 `CHANGELOG.zh-CN.md`，英文版是 `CHANGELOG.md`。

### 版本亮点

- **解压即用的独立便携包**：面向 Windows x64 与 Linux x64 内置 Node.js 和全部生产依赖，无需自行安装 Node.js 或执行 `npm install`。
- **首启免令牌自动建号**：首次启动自动在 `config/panel.env` 生成随机密钥，并创建管理员 `admin` 与一次性随机密码显示在窗口中（可在面板内修改，忘记密码时可在本机运行 `reset-password` 重置）。
- **完整的开服与联机链路**：支持 Paper、Fabric、Forge、NeoForge、Vanilla 一键部署，上传文件夹和 ZIP 二阶段预检导入已有服务端，实时着色控制台，运行中热备份，以及内置虚拟局域网（EasyTier）与 frp 联机（只开放游戏端口，不暴露面板）。
- **国内网络与多语言支持**：支持在面板中切换官方来源或国内镜像（镜像文件只在能核对校验值时使用；联机工具 frp 与 EasyTier 按固定的官方 SHA-256 校验，并支持离线上传压缩包安装），界面支持英文、简体中文与繁體中文。

### 3 步快速启动

1. **解压并启动**：Windows 解压后直接双击 `mystryctl.cmd`（或运行 `mystryctl.cmd start`）；Linux 解压后先执行 `chmod +x mystryctl`，再运行 `./mystryctl start`。
2. **访问 `http://127.0.0.1:3000` 登录**：使用窗口里显示的 `admin` 账号和一次性密码登录。Windows 下关闭日志窗口不会影响后台运行的面板和服务端；需要停止时重新双击 `mystryctl.cmd` 按 `Ctrl+C`（或运行 `mystryctl stop`）安全停止。
3. **准备 Minecraft 所需的 Java**：包内不包含 Minecraft Java 运行时；面板使用电脑上已有的 Java，服务端需要的版本没装时可以由面板安装固定校验值的 Eclipse Temurin JRE。

### 升级与数据保留

先在旧目录运行 `mystryctl stop`，将新版本解压到新的同级目录，再把原有 `config/`、`data/` 与 `logs/` 移入新目录。不要覆盖正在运行的目录，升级前请另外备份这三个目录。

### 签名校验、安全与已知限制

- **平台范围**：本 Preview 仅发布 Windows x64 与 Linux x64；不提供 Linux ARM64、macOS、系统安装器、服务注册、开机启动、原生自动更新或 Windows 代码签名。
- **监听边界**：默认只监听 `127.0.0.1`；从其他设备访问默认关闭，需要管理员在面板里开启。开启后登录页可以从所选网络访问到，请保持 HTTPS 开启，不要把面板暴露到不可信公网。
- **哈希与签名校验**：下载后请先使用 `SHA256SUMS` 校验文件，导入 `mystry-release-signing-key.asc` 并核对指纹为 `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8`（与仓库 `.github/release-signing-key.fingerprint` 相同；`gpg --fingerprint` 会每 4 位分组显示，比对时忽略空格与大小写），再用该公钥验证 `SHA256SUMS.asc`。
- **依赖安全审计**：2026-11-21 官方 registry 生产依赖审计为 0 critical、0 high、2 moderate。两项 moderate 来自 React Router 6 系依赖公告（GHSA-wrjc-x8rr-h8h6、GHSA-337j-9hxr-rhxg），修复版只在 7.18 以上；当前前端没有 SSR hydration，并且导航目标来自固定站内路径或服务端生成的实例 ID，但仍作为 Preview 残余风险保留并在每次发布重新审计。

完整说明见仓库中的 `docs/portable-release.zh-CN.md`，英文版是 `docs/portable-release.md`。
