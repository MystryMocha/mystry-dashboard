简体中文说明在英文之后。

## English

0.3.0-preview.1 adds a Home dashboard, scheduled backups and restarting after a crash, and fixes a number of console, backup and import problems.

### New in 0.3.0-preview.1

- **Home**: Signing in opens a dashboard with running servers, CPU, memory and data-disk usage, trends over 24 hours, 7 days or 30 days, and a timeline of each instance's runs and crashes. The server list moves to `/instances`.
- **Scheduled backups**: An instance can be backed up once a day at a time you choose, keeping the newest few. Manual and uploaded backups are left alone.
- **Restart after a crash**: A switch in **Panel Settings** starts a crashed server again. It is off until you turn it on.
- **Servers that outlive the panel**: A server still running after the panel exited unexpectedly is shown as **Detached**, and must be stopped before its instance is started, backed up, restored or deleted, so the same world cannot be opened twice.
- **Sharper interface**: Frosted glass is gone so text stays sharp, the accent is clay orange, and the desktop sidebar can collapse to icons.
- **Fixes**: Garbled non-ASCII text in the console, binary files broken by the file editor, backups that stored truncated files, and Forge or NeoForge backups that failed to start on another system.
- **Security**: Sign-in attempts are limited per address, and on Windows the launcher restricts `config`, `data` and `logs` to the current user, `SYSTEM` and `Administrators`.

The full list of changes and fixes is in `CHANGELOG.md`; the Chinese version is `CHANGELOG.zh-CN.md`.

### Highlights

- **Self-contained portable package**: Bundles Node.js and production dependencies for Windows x64 and Linux x64, so there is no need to install Node.js or run `npm install`.
- **Automatic first-start account**: The first start generates random secrets in `config/panel.env` and creates the `admin` account with a one-time random password shown in the window (change it in the panel; if you forget it, run `reset-password` locally).
- **Full Minecraft server lifecycle**: One-click deploy for Paper, Fabric, Forge, NeoForge and Vanilla, folder upload and ZIP import (inspecting the archive first) for existing servers, a live console, backups of running servers, daily scheduled backups, and built-in Virtual LAN (EasyTier) or frp multiplayer that opens only the game port, never the panel.
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
- **Signature & checksum verification**: After downloading, check the files against `SHA256SUMS`. Import `mystry-release-signing-key.asc`, confirm its fingerprint is `89776870C5B4C56BE7D0E32BA3AA7D21DB154796` (the same value as `.github/release-signing-key.fingerprint` in the repository; `gpg --fingerprint` prints it in groups of four, so ignore spaces and case when comparing), then verify `SHA256SUMS.asc` with that public key.
- **Dependency audit**: The production dependency audit against the official registry on 2026-11-28 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories concern React Router 6 (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg) and are fixed only in 7.18 and later. The frontend uses no SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs. The advisories remain a residual preview risk, and the audit is rerun for every release.

Full details are in `docs/portable-release.md` in the repository; the Chinese version is `docs/portable-release.zh-CN.md`.

## 简体中文

0.3.0-preview.1 新增首页数据看板、每天定时备份与崩溃后自动重启，并修复控制台、备份与导入方面的若干问题。

### 0.3.0-preview.1 新增

- **首页**：登录后进入数据看板，展示运行中的服务器、CPU、内存与数据盘占用，24 小时、7 天或 30 天的趋势，以及各实例运行与崩溃的时间线。服务器列表移至 `/instances`。
- **每天定时备份**：实例可在设定的时刻每天备份一次，只保留最新的若干份。手动备份与上传的备份不受影响。
- **崩溃后自动重启**：「面板设置」中的开关可将崩溃的服务器再次启动。默认关闭。
- **面板退出后仍在运行的服务器**：面板异常退出后仍在运行的服务器显示为「独立运行中」，须先将其停止，才能启动、备份、还原或删除该实例，同一存档不会被打开两次。
- **界面更清晰**：去掉毛玻璃，文字保持清晰；强调色改为陶土橙，桌面端侧栏可收起为图标栏。
- **修复**：控制台中非 ASCII 文字出现乱码、文件编辑器损坏二进制文件、备份存入被截断的文件，以及 Forge 或 NeoForge 的备份换一个系统后无法启动。
- **安全**：登录尝试按来源地址限制次数；在 Windows 上，启动器将 `config`、`data` 与 `logs` 限制为仅当前用户、`SYSTEM` 与 `Administrators` 可访问。

完整的改动与修复见 `CHANGELOG.zh-CN.md`，英文版为 `CHANGELOG.md`。

### 版本亮点

- **解压即用的独立便携包**：Windows x64 与 Linux x64 便携包内置 Node.js 与全部生产依赖，无需自行安装 Node.js 或执行 `npm install`。
- **首次启动自动建号**：首次启动即在 `config/panel.env` 生成随机密钥并创建管理员 `admin`，一次性随机密码显示于窗口中（可在面板内修改；忘记密码时，可在本机运行 `reset-password` 重置）。
- **完整的开服与联机能力**：支持 Paper、Fabric、Forge、NeoForge、Vanilla 一键部署，上传文件夹或先查看内容再导入 ZIP 迁入已有服务端，并提供实时控制台、运行中备份、每天定时备份，以及内置虚拟局域网（EasyTier）与 frp 联机（仅开放游戏端口，不暴露面板）。
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
- **哈希与签名校验**：下载后先以 `SHA256SUMS` 校验文件；导入 `mystry-release-signing-key.asc`，核对指纹为 `89776870C5B4C56BE7D0E32BA3AA7D21DB154796`（与仓库 `.github/release-signing-key.fingerprint` 相同；`gpg --fingerprint` 每 4 位分组显示，比对时忽略空格与大小写），再以该公钥验证 `SHA256SUMS.asc`。
- **依赖安全审计**：2026-11-28 针对官方 registry 的生产依赖审计结果为 0 critical、0 high、2 moderate。两项 moderate 均为 React Router 6 系依赖公告（GHSA-wrjc-x8rr-h8h6、GHSA-337j-9hxr-rhxg），仅 7.18 及更高版本修复。当前前端不使用 SSR hydration，导航目标均来自固定站内路径或服务端生成的实例 ID；这两项仍作为 Preview 残余风险保留，每次发布均重新审计。

完整说明见仓库中的 `docs/portable-release.zh-CN.md`，英文版为 `docs/portable-release.md`。
