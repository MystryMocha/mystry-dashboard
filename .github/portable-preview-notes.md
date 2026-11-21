简体中文说明在英文之后。

## English

### New in 0.2.0-preview.5

- **Open the panel on other devices**: The "Other Devices" button turns access from a phone or another computer on or off inside the panel and shows a URL and QR code. Choose direct access (HTTPS with a panel-issued certificate by default) or a virtual network, including a built-in EasyTier network that allows only the panel.
- **Upload Folder import**: Pick or drag an existing server folder into the browser; the panel uploads and checks it before importing. Very large servers can still be copied from `data/imports`.
- **One-click Java**: Deploy and import pick the matching installed Java automatically and, when it is missing, can install a checksum-pinned Eclipse Temurin JRE (8 / 17 / 21 / 25).
- **Panel Settings and session duration**: A new settings page brings together language, appearance, session duration (12 hours by default, up to never expire), download source, account and runtime info.
- **Redesigned interface**: A one-row-per-server Instances list that states the next step, card-free pages, two-column forms on desktop, a reworked Multiplayer page and a fixed ink-purple accent.
- **Servers with a public IP**: The Multiplayer page shows a public join address and a checklist for cloud servers.

The full list of changes and fixes is in `CHANGELOG.md`; the Chinese version is `CHANGELOG.zh-CN.md`.

### Highlights

- **Self-contained portable package**: Bundles Node.js and production dependencies for Windows x64 and Linux x64, so there is no need to install Node.js or run `npm install`.
- **Zero-token first start**: The first start generates random secrets in `config/panel.env` and creates the `admin` account with a one-time random password shown in the window (change it in the panel; if you forget it, run `reset-password` locally).
- **Full Minecraft server lifecycle**: One-click deploy for Paper, Fabric, Forge, NeoForge and Vanilla, folder upload and two-stage ZIP import of existing servers, a live console, backups of running servers, and built-in Virtual LAN (EasyTier) or frp multiplayer that opens only the game port, never the panel.
- **Network & language ready**: Switch between the Official and Mainland China download sources (mirrored files are used only when their checksum can be verified; frp and EasyTier are checked against pinned SHA-256 values and can be installed from an uploaded archive), and use the web UI in English, Simplified Chinese or Traditional Chinese.

### Quick Start in 3 Steps

1. **Extract and launch**: On Windows, extract the archive and double-click `mdash.cmd` (or run `mdash.cmd start`). On Linux, extract the archive, run `chmod +x mdash`, then `./mdash start`.
2. **Sign in at `http://127.0.0.1:3000`**: Use the `admin` username and the one-time password printed in the launcher window. Closing the Windows log window leaves the panel and your servers running in the background; to shut down safely, reopen `mdash.cmd` and press `Ctrl+C` (or run `mdash stop`).
3. **Prepare Java for Minecraft**: The package does not bundle a Java runtime for Minecraft. The panel uses a Java already on your computer; when a server needs a version you don't have, it can install a checksum-pinned Eclipse Temurin JRE.

### Upgrading and Keeping Your Data

First run `mdash stop` in the old folder (`mystryctl stop` in 0.2.0-preview.5 and earlier). Extract the new version into a new folder beside it, then move your existing `config/`, `data/` and `logs/` into the new folder. Do not overwrite a running folder, and back up these three folders separately before upgrading.

### Verification, Security and Known Limitations

- **Platform scope**: This preview ships for Windows x64 and Linux x64 only. Linux ARM64 and macOS builds, a system installer, service registration, start at boot, native auto-update and Windows code signing are not available yet.
- **Network boundary**: By default the panel listens only on `127.0.0.1`. Access from other devices stays off until an administrator turns it on in the panel. Once it is on, the sign-in page is reachable from the networks you chose, so keep HTTPS on and do not expose the panel to the untrusted public internet.
- **Signature & checksum verification**: After downloading, check the files against `SHA256SUMS`. Import `mystry-release-signing-key.asc`, confirm its fingerprint is `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8` (the same value as `.github/release-signing-key.fingerprint` in the repository; `gpg --fingerprint` prints it in groups of four, so ignore spaces and case when comparing), then verify `SHA256SUMS.asc` with that public key.
- **Dependency audit**: The production dependency audit against the official registry on 2026-11-21 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories concern React Router 6 (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg) and are fixed only in 7.18 and later. The frontend uses no SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs. The advisories remain a residual preview risk, and the audit is rerun for every release.

Full details are in `docs/portable-release.md` in the repository; the Chinese version is `docs/portable-release.zh-CN.md`.

## 简体中文

### 0.2.0-preview.5 新增

- **在其他设备上打开面板**：通过「其他设备」按钮，可在面板内开关手机或另一台电脑的访问，并给出网址与二维码。可选直接访问（默认 HTTPS，证书由面板自行签发）或虚拟组网；面板自带的 EasyTier 网络仅放行面板。
- **上传文件夹导入**：在浏览器中选择或拖入已有服务端的文件夹，面板上传并检查后再导入；规模很大的服务端仍可从 `data/imports` 复制。
- **一键安装 Java**：部署与导入自动选用合适的已安装 Java；缺失时，可一键安装固定校验值的 Eclipse Temurin JRE（8 / 17 / 21 / 25）。
- **面板设置与登录有效期**：新增设置页，集中管理语言、外观、登录有效期（默认 12 小时，可设为永不过期）、下载来源、账号与运行信息。
- **界面改版**：实例总览改为每台服务端一行，并注明下一步操作；页面去除卡片，桌面端表单分为两栏，联机页重新排版，强调色固定为墨紫。
- **有公网 IP 的服务器**：联机页提供公网加入地址与云服务器排查清单。

完整的改动与修复见 `CHANGELOG.zh-CN.md`，英文版为 `CHANGELOG.md`。

### 版本亮点

- **解压即用的独立便携包**：Windows x64 与 Linux x64 便携包内置 Node.js 与全部生产依赖，无需自行安装 Node.js 或执行 `npm install`。
- **首启免令牌自动建号**：首次启动即在 `config/panel.env` 生成随机密钥并创建管理员 `admin`，一次性随机密码显示于窗口中（可在面板内修改；忘记密码时，可在本机运行 `reset-password` 重置）。
- **完整的开服与联机链路**：支持 Paper、Fabric、Forge、NeoForge、Vanilla 一键部署，以上传文件夹或 ZIP 二阶段预检导入已有服务端，并提供实时着色控制台、运行中热备份，以及内置虚拟局域网（EasyTier）与 frp 联机（仅开放游戏端口，不暴露面板）。
- **国内网络与多语言支持**：可在面板中切换官方来源与国内镜像（镜像文件须通过校验方可使用；联机工具 frp 与 EasyTier 按固定的官方 SHA-256 校验，并可上传离线包安装）；界面提供英文、简体中文与繁體中文。

### 3 步快速启动

1. **解压并启动**：Windows 解压后双击 `mdash.cmd`（或运行 `mdash.cmd start`）；Linux 解压后先执行 `chmod +x mdash`，再运行 `./mdash start`。
2. **访问 `http://127.0.0.1:3000` 登录**：以窗口中显示的 `admin` 账号与一次性密码登录。在 Windows 上关闭日志窗口，后台的面板与服务端照常运行；如需停止，重新双击 `mdash.cmd` 并按 `Ctrl+C`（或运行 `mdash stop`），即可安全停止。
3. **准备 Minecraft 所需的 Java**：包内不含 Minecraft 所需的 Java 运行时。面板使用电脑上已有的 Java；服务端所需版本缺失时，可由面板安装固定校验值的 Eclipse Temurin JRE。

### 升级与数据保留

先在旧目录运行 `mdash stop`（0.2.0-preview.5 及更早版本为 `mystryctl stop`），将新版本解压至新的同级目录，再将原有 `config/`、`data/` 与 `logs/` 移入新目录。切勿覆盖正在运行的目录；升级前须另行备份这三个目录。

### 签名校验、安全与已知限制

- **平台范围**：本 Preview 仅发布 Windows x64 与 Linux x64 版本；暂不提供 Linux ARM64 与 macOS 版本、系统安装器、服务注册、开机启动、原生自动更新或 Windows 代码签名。
- **监听边界**：面板默认仅监听 `127.0.0.1`；从其他设备访问默认关闭，须由管理员在面板中开启。开启后，所选网络均可访问登录页，因此请保持 HTTPS 开启，切勿将面板暴露于不可信的公网。
- **哈希与签名校验**：下载后先以 `SHA256SUMS` 校验文件；导入 `mystry-release-signing-key.asc`，核对指纹为 `F0272DFEE5F03A9907C4FA492E4ECE89B8DECEF8`（与仓库 `.github/release-signing-key.fingerprint` 相同；`gpg --fingerprint` 每 4 位分组显示，比对时忽略空格与大小写），再以该公钥验证 `SHA256SUMS.asc`。
- **依赖安全审计**：2026-11-21 针对官方 registry 的生产依赖审计结果为 0 critical、0 high、2 moderate。两项 moderate 均为 React Router 6 系依赖公告（GHSA-wrjc-x8rr-h8h6、GHSA-337j-9hxr-rhxg），仅 7.18 及更高版本修复。当前前端不使用 SSR hydration，导航目标均来自固定站内路径或服务端生成的实例 ID；这两项仍作为 Preview 残余风险保留，每次发布均重新审计。

完整说明见仓库中的 `docs/portable-release.zh-CN.md`，英文版为 `docs/portable-release.md`。
