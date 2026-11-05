简体中文说明在英文之后。

## English

### Using the Portable Preview

- On Windows, extract the archive and run `mystryctl.cmd start`. On Linux, extract the archive, run `chmod +x mystryctl`, then run `./mystryctl start`.
- The package includes Node.js and production dependencies, but not the Java runtime Minecraft needs. It uses the Java on your system `PATH` by default. You can also scan for and select another installed runtime in the panel.
- This preview ships for Windows x64 and Linux x64 only. It doesn't include Linux ARM64 or macOS builds, a system installer, service registration, start at boot, native auto-update or Windows code signing.

### Upgrading and Keeping Your Data

Run `mystryctl stop` in the old folder first. Extract the new version into a new folder next to it, then move your existing `config/`, `data/` and `logs/` into the new folder. Don't overwrite a folder that's running, and back up these three folders separately before you upgrade.

### Security and Known Limitations

- The panel only listens on `127.0.0.1` by default. Don't expose the panel port directly to the untrusted public internet.
- The production dependency audit against the official registry on 2026-11-05 found 0 critical, 0 high and 2 moderate advisories. This release upgrades `react-router-dom` / `react-router` to 6.30.6 and `@fastify/static` to 10.1.10, which also brings in `glob` 14.0.3 and `minimatch` 11.0.4 and resolves 3 advisories of moderate severity. The two that remain are React Router 6 dependency advisories (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg), fixed only in 7.18 and later. The frontend has no SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs. They still stand as a residual preview risk, and the audit is rerun for every release.
- After downloading, check the files against `SHA256SUMS`. Import `mystry-release-signing-key.asc`, confirm its fingerprint, then use that public key to verify `SHA256SUMS.asc`.

Full details are in `docs/portable-release.md` in the repository (currently Chinese only).

## 简体中文

### 便携 Preview 使用说明

- Windows 解压后运行 `mystryctl.cmd start`；Linux 解压后先执行 `chmod +x mystryctl`，再运行 `./mystryctl start`。
- 包内已包含 Node.js 和生产依赖，但不包含 Minecraft Java；默认使用系统 `PATH` 中的 Java，也可在面板中扫描并选择其他已安装运行时。
- 本 Preview 仅发布 Windows x64 与 Linux x64；不提供 Linux ARM64、macOS、系统安装器、服务注册、开机启动、原生自动更新或 Windows 代码签名。

### 升级与数据保留

先在旧目录运行 `mystryctl stop`，将新版本解压到新的同级目录，再把原有 `config/`、`data/`、`logs/` 移入新目录。不要覆盖正在运行的目录，升级前请另外备份这三个目录。

### 安全与已知限制

- 默认只监听 `127.0.0.1`；不要把面板端口直接暴露到不可信公网。
- 2026-11-05 官方 registry 生产依赖审计为 0 critical、0 high、2 moderate（本版升级 `react-router-dom` / `react-router` 6.30.6、`@fastify/static` 10.1.10，并带动 `glob` 14.0.3、`minimatch` 11.0.4，消除 3 项 moderate 公告）。剩余两项 moderate 来自 React Router 6 系依赖公告（GHSA-wrjc-x8rr-h8h6、GHSA-337j-9hxr-rhxg），修复版只在 7.18 以上；当前前端没有 SSR hydration，并且导航目标来自固定站内路径或服务端生成的实例 ID，但仍作为 Preview 残余风险保留并在每次发布重新审计。
- 下载后请先使用 `SHA256SUMS` 校验文件，导入 `mystry-release-signing-key.asc` 核对指纹后，再用该公钥验证 `SHA256SUMS.asc`。

完整说明见仓库中的 `docs/portable-release.md`。
