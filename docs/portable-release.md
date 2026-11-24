# Portable Preview

**English** · [简体中文](portable-release.zh-CN.md)

The repository is currently at version `v0.2.0-preview.7`. The release workflow is configured to build two portable targets for it, each bundling Node.js 22, the production dependencies and the built frontend and backend:

| System | File |
|------|------|
| Windows x64 | `mystry-v0.2.0-preview.7-windows-x64.zip` |
| Linux x64 | `mystry-v0.2.0-preview.7-linux-x64.tar.gz` |

The packaging scripts for Linux ARM64 and macOS (Intel / Apple Silicon) still work locally, but these targets are not in this preview's public release matrix; they are left for a later version.

The table lists build targets and file names; it does not mean the assets have been published. Check the project's actual Release page before downloading. If the asset you need is not there, use the source launcher described in [Getting Started](getting-started.md).

This is a preview, not a system installer. You don't need to install Node.js or run `npm install`, but Java for Minecraft is not included. Instances use the `java` on your system `PATH` by default; you can also select a scanned and verified local runtime in the panel, or have the panel install Eclipse Temurin when the recommended version is missing. This stage does not use [Node SEA](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html): the feature is still marked Active development and targets a single CommonJS main script, which does not suit the current layout of ESM, multiple packages and static frontend assets.

## Download and Verify

From the same GitHub Release, download the archive for your platform, `SHA256SUMS`, `SHA256SUMS.asc` and `mystry-release-signing-key.asc` (identical to [`.github/release-signing-key.asc`](../.github/release-signing-key.asc) in the repository). The release page also provides `sbom.cdx.json` for the production dependencies.

### 1. Get and Trust the Release Public Key

Before signing is first enabled, maintainers must commit the public key and the single-line fingerprint file [`.github/release-signing-key.fingerprint`](../.github/release-signing-key.fingerprint) as described in [`.github/RELEASE_SIGNING.md`](../.github/RELEASE_SIGNING.md).

As a user, run:

```bash
gpg --import mystry-release-signing-key.asc
gpg --fingerprint
```

Compare the fingerprint in the output with `release-signing-key.fingerprint` in the repository or the record in the Release notes. It is 40 hexadecimal characters and must match exactly, ignoring spaces and case. A GPG signature check is meaningful only once you have obtained and trusted this public key through the project's release channel.

### 2. Verify File Hashes and the Signature

Linux:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

In Windows PowerShell, first calculate the archive hash, then compare it with the matching line in `SHA256SUMS`:

```powershell
Get-FileHash .\mystry-v0.2.0-preview.7-windows-x64.zip -Algorithm SHA256
```

In WSL or Gpg4win, you can also run the same `gpg --verify` as on Linux.

If the pipeline lacks `RELEASE_GPG_PRIVATE_KEY`, or `RELEASE_GPG_FINGERPRINT` does not match the fingerprint in the repository, the pipeline refuses to create a public Release; it never falls back to an unsigned release. Before running `gh release create`, CI verifies `SHA256SUMS.asc` with the repository public key in a separate keyring.

## Start

Windows:

```text
Extract → double-click mdash.cmd → the panel runs in the background and opens your browser → sign in with the account shown in the window → press Ctrl+C in the window to stop it
```

After a double-click, the panel and your servers run in the background as a daemon, with no window of their own. The window you see shows only the account and important logs; the full log is in `logs/panel.stdout.log`. Closing the window does not affect the panel or your servers. To see the logs again or stop the panel, double-click `mdash.cmd` again. Ctrl+C safely stops the panel and all servers; do this before you shut down or restart as well. When the panel is restarted from another window, this window keeps showing the new panel's logs. If startup fails, the window stays on the error until you press Enter.

To use the menu, run `.\mdash.cmd menu`. Command-line calls with arguments do not pause, so they are safe in scripts.

You can also run this in a terminal:

```powershell
.\mdash.cmd start
```

Linux:

```bash
tar -xzf mystry-v0.2.0-preview.7-linux-x64.tar.gz
cd mystry-dashboard
chmod +x mdash
./mdash start
```

Commands:

| Command | What it does |
|------|------|
| `start` | Starts in the background, writes the PID fingerprint, runs a health check and records logs |
| `watch` | Starts in the background and shows the logs; this is what a double-click does |
| `foreground` | Starts in the foreground, for troubleshooting. Closing the window also stops the panel |
| `stop` | Requests a safe shutdown with the local token |
| `restart` | Stops, then starts again in the background |
| `status` | Checks health and the state of the managed process |
| `logs` | Shows recent logs |
| `open` | Opens the panel address |
| `reset-password` | Generates a new random administrator password in an interactive terminal while the panel is running |
| `remote` | Controls access from other devices while the panel is running: `remote on`, `remote off`, `remote status`, `remote https off`, `remote renew-cert` |
| `menu` | Opens the interactive command menu |

The first start creates `config/panel.env`, generates distinct random secrets, and creates the `admin` account with a random 16-character password. The password is shown once in the window and is not written to the log files. To change it, sign in, open **Panel Settings** (the gear at the bottom left) and click **Change Password**. If you forget it, run `.\mdash.cmd reset-password` in a terminal window while the panel is running; the command refuses to run when its output is redirected or piped, so the new password never lands in a file. The config file contains secrets; do not upload or share it.

## Folders and Data

```text
mystry-dashboard/
├── runtime/              # Pinned official Node.js runtime
├── app/                  # Built application and production dependencies
├── config/               # First-start config and config backups
├── data/                 # Database, instances, caches and temporary uploads
├── logs/                 # Panel standard output and error logs
├── mdash.cmd
├── mdash
├── manifest.json
├── VERSION
├── README.txt
└── LICENSE
```

Instances always stay in `data/instances/<id>`. `manifest.json` records the product version, Git SHA, Node version, target platform, architecture and build time, plus the size and SHA-256 of every released file in the package. `config/`, `data/` and `logs/` start empty in the release package, which contains no `.env`, database, caches, instances or development dependencies.

## Upgrade and Roll Back

Do not overwrite a running portable folder:

1. Run `mdash stop` in the old folder, then confirm with `mdash status` that it has stopped. In versions up to 0.2.0-preview.5, the command is `mystryctl`, not `mdash`.
2. Extract the new version into a new folder next to the old one.
3. Confirm that `config/`, `data/` and `logs/` in the new folder are empty.
4. Move those three folders from the old folder into the new one, and keep the old application folder as a rollback copy.
5. Run `mdash start` from the new folder, then check sign-in, the instance list and your worlds.
6. Once everything checks out, archive the old application folder yourself. Do not delete your only copy of the data.

To roll back, stop the new version, move `config/`, `data/` and `logs/` back to the old application folder, then start it. If the new version upgraded the database schema, it first left a copy of the old database in `data/db-backups/`; the older version may refuse the upgraded database and name both schema versions. In that case, move `panel.db` and any `panel.db-wal` and `panel.db-shm` out of `data/`, then copy a file from `data/db-backups/` to `data/panel.db`: take the newest one whose `-v<N>` suffix is no higher than the version the older release says it supports. Changes made after the upgrade are not in that copy. The copy covers only the database, so still back up these three folders separately before upgrading rather than relying on the old application folder alone.

If `MYSTRY_HOME` is already set in your environment, the Windows `.cmd` and Unix `.sh` wrapper scripts keep it and apply the portable defaults only to whichever of `MYSTRY_CONFIG_PATH` and `MYSTRY_DATA_DIR` is unset. Relative paths are relative to `MYSTRY_HOME`. Everyday portable use does not require setting these variables.

## Known Preview Limitations

- Public releases cover only Windows x64 and Linux x64; Linux ARM64 and macOS portable packages are not available yet.
- There is no NSIS, DEB or PKG package, and no system-level install or uninstall.
- It does not register with WinSW, systemd or LaunchDaemon, and does not start automatically at boot.
- Windows builds are not code-signed yet, so the operating system may show a source warning.
- There is no native auto-update, automatic rollback or in-place upgrade while running.
- Java 8/17/21/25 is not bundled. Use the runtime on your system `PATH`, select another installed version the panel scans, or install Eclipse Temurin from the panel when the recommended version is missing.
- Sign-in still uses a JWT stored locally in the browser. Cookie sessions, CSRF protection, TOTP and a public deployment wizard are not implemented yet.
- By default the panel listens only on `127.0.0.1`. Do not expose the panel port directly to the untrusted public internet.
- The production dependency audit against the official registry on 2026-11-24 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories concern React Router 6 (GHSA-wrjc-x8rr-h8h6 backslash open redirect, GHSA-337j-9hxr-rhxg SSR hydration injection) and are fixed only in 7.18 and later. The current SPA does not use SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs; even so, these advisories are recorded as a residual preview risk and must be re-audited for every release. Earlier advisories were resolved by upgrading `react-router-dom` / `react-router` to 6.30.6 (GHSA-jjmj-jmhj-qwj2), `@fastify/static` to 10.1.10 with `glob` 14.0.3 / `minimatch` 11.0.4 (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249), and transitive dependencies (`fastify` 5.12.7, `fast-jwt` 6.3.5, `@fastify/busboy` 3.2.3, `fast-uri` 3.1.9 / 4.2.3, `brace-expansion` 5.0.12). The critical `tinypool` advisory in the `vitest` 3 development dependency does not reach the portable package; fixing it requires a major version upgrade, so it has not been addressed yet.

## Release Maintenance

Maintainer steps for packaging and publishing are kept in one place: the [Chinese version](portable-release.zh-CN.md#发布维护).
