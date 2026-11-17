# Portable Preview

**English** · [简体中文](portable-release.zh-CN.md)

The repository is currently at version `v0.2.0-preview.4`. The release workflow is set up to build two portable targets for it. Each one bundles Node.js 22, production dependencies and the built frontend and backend:

| System | File |
|------|------|
| Windows x64 | `mystry-v0.2.0-preview.4-windows-x64.zip` |
| Linux x64 | `mystry-v0.2.0-preview.4-linux-x64.tar.gz` |

The packaging scripts for Linux ARM64 and macOS (Intel / Apple Silicon) still work locally, but those targets aren't in this preview's public release matrix. They're left for a later version.

This table lists build targets and file names. It doesn't mean those assets have been published. Check the project's actual Release page before you download. If the asset you need isn't there, use the source launcher described in [Getting Started](getting-started.md).

This is a preview, not a system installer. You don't need to install Node.js or run `npm install`, but you do need to install the Java that Minecraft requires yourself. Instances use the `java` on your system `PATH` by default, and you can also select a scanned and verified local runtime in the panel. This stage doesn't use [Node SEA](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html): that feature is still marked Active development and targets a single CommonJS main script, which doesn't suit the current layout of ESM, multiple packages and static frontend assets.

## Download and Verify

From the same GitHub Release, download the archive for your platform, `SHA256SUMS`, `SHA256SUMS.asc` and `mystry-release-signing-key.asc` (identical to [`.github/release-signing-key.asc`](../.github/release-signing-key.asc) in the repository). The release page also provides `sbom.cdx.json` for production dependencies.

### 1. Get and Trust the Release Public Key

Before signing is first enabled, maintainers must commit the public key and the single-line fingerprint file [`.github/release-signing-key.fingerprint`](../.github/release-signing-key.fingerprint) as described in [`.github/RELEASE_SIGNING.md`](../.github/RELEASE_SIGNING.md).

As a user, run:

```bash
gpg --import mystry-release-signing-key.asc
gpg --fingerprint
```

Compare the fingerprint in the output with `release-signing-key.fingerprint` in the repository or the record in the Release notes. It has 40 hexadecimal characters and must match exactly, ignoring spaces and case. A GPG signature check only means something after you've obtained and trusted this public key from the project's release channel.

### 2. Verify File Hashes and the Signature

Linux:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gpg --verify SHA256SUMS.asc SHA256SUMS
```

In Windows PowerShell, calculate the archive hash first, then compare it with the matching line in `SHA256SUMS`:

```powershell
Get-FileHash .\mystry-v0.2.0-preview.4-windows-x64.zip -Algorithm SHA256
```

You can also run the same `gpg --verify` as on Linux in WSL or Gpg4win.

If `RELEASE_GPG_PRIVATE_KEY` is missing from the pipeline, or `RELEASE_GPG_FINGERPRINT` doesn't match the fingerprint in the repository, the pipeline refuses to create a public Release. It never falls back to an unsigned release. Before `gh release create` runs, CI verifies `SHA256SUMS.asc` with the repository public key in a separate keyring.

## Start

Windows:

```text
Extract → double-click mystryctl.cmd → the panel runs in the background and opens your browser → sign in with the account shown in the window → press Ctrl+C in the window to stop it
```

When you double-click it, the panel and your servers run in the background as a daemon, with no window of their own. The window you see only shows the account and important logs. The full log is in `logs/panel.stdout.log`. Closing the window doesn't affect the panel or your servers. To see the logs again or stop the panel, double-click `mystryctl.cmd` again. Ctrl+C safely stops the panel and all servers. Do this before you shut down or restart too. If startup fails, the window stays on the error until you press Enter.

To use the menu, run `.\mystryctl.cmd menu`. Command-line calls with arguments don't pause, so they're safe to use in scripts.

You can also run this in a terminal:

```powershell
.\mystryctl.cmd start
```

Linux:

```bash
tar -xzf mystry-v0.2.0-preview.4-linux-x64.tar.gz
cd mystry-dashboard
chmod +x mystryctl
./mystryctl start
```

Commands:

| Command | What it does |
|------|------|
| `start` | Starts in the background, writes the PID fingerprint, runs a health check and records logs |
| `watch` | Starts in the background and shows the logs. This is what double-clicking does |
| `foreground` | Starts in the foreground, useful for troubleshooting. Closing the window also stops the panel |
| `stop` | Requests a safe shutdown with the local token |
| `restart` | Stops, then starts again in the background |
| `status` | Checks health and the state of the managed process |
| `logs` | Shows recent logs |
| `open` | Opens the panel address |
| `reset-password` | Generates a new random administrator password in an interactive terminal while the panel is running |
| `remote` | While the panel is running, control access from other devices: `remote on`, `remote off`, `remote status`, `remote https off`, `remote renew-cert` |
| `menu` | Opens the interactive command menu |

The first start creates `config/panel.env`, generates distinct random secrets, and creates the `admin` account with a random 16-character password. The password is shown once in the window and isn't written to the log files. After signing in, click the key icon at the bottom left to change it. If you forget it, run `.\mystryctl.cmd reset-password` in a terminal window while the panel is running; it refuses when its output is redirected or piped, so the new password never lands in a file. The config file contains secrets, so don't upload or share it.

## Folders and Data

```text
mystry-dashboard/
├── runtime/              # Pinned official Node.js runtime
├── app/                  # Built application and production dependencies
├── config/               # First-start config and config backups
├── data/                 # Database, instances, caches and temporary uploads
├── logs/                 # Panel standard output and error logs
├── mystryctl.cmd
├── mystryctl
├── manifest.json
├── VERSION
├── README.txt
└── LICENSE
```

Instances always stay in `data/instances/<id>`. `manifest.json` records the product version, Git SHA, Node version, target platform, architecture and build time, plus the size and SHA-256 of every released file in the package. `config/`, `data/` and `logs/` start empty in the release package, which contains no `.env`, database, caches, instances or development dependencies.

## Upgrade and Roll Back

Don't overwrite a portable folder that's running:

1. Run `mystryctl stop` in the old folder, then confirm with `mystryctl status` that it has stopped.
2. Extract the new version into a new folder next to the old one.
3. Confirm that `config/`, `data/` and `logs/` in the new folder are empty.
4. Move those three folders from the old folder into the new one, and keep the old application folder as a rollback copy.
5. Run `mystryctl start` from the new folder, then check sign-in, the instance list and your worlds.
6. Once everything looks right, archive the old application folder yourself. Don't delete your only copy of the data.

To roll back, stop the new version first, move `config/`, `data/` and `logs/` back to the old application folder, then start it. There's currently no database migration framework, so back up these three folders separately before you upgrade. Don't rely on the old application folder alone.

If `MYSTRY_HOME` is already set in your environment, the Windows `.cmd` and Unix `.sh` wrapper scripts keep it, and only apply the portable defaults to `MYSTRY_CONFIG_PATH` and `MYSTRY_DATA_DIR` when those aren't set. Relative paths are relative to `MYSTRY_HOME`. You don't need to set these variables for everyday portable use.

## Known Preview Limitations

- Public releases only cover Windows x64 and Linux x64. Linux ARM64 and macOS portable packages aren't available yet.
- There's no NSIS, DEB or PKG package, and no system-level install or uninstall.
- It doesn't register with WinSW, systemd or LaunchDaemon, and it doesn't start automatically at boot.
- Windows builds aren't code-signed yet, so the operating system may show a source warning.
- There's no native auto-update, automatic rollback or in-place upgrade while running.
- Java 8/17/21/25 isn't bundled or downloaded automatically. You can configure your system `PATH` as the default runtime, or start the panel and scan for and select another installed version.
- Sign-in still uses a JWT stored locally in the browser. Cookie sessions, CSRF protection, TOTP and a public deployment wizard aren't implemented yet.
- The panel only listens on `127.0.0.1` by default. Don't expose the panel port directly to the untrusted public internet.
- The production dependency audit against the official registry on 2026-11-16 found 0 critical, 0 high and 2 moderate advisories. Both moderate advisories are React Router 6 advisories (GHSA-wrjc-x8rr-h8h6 backslash open redirect, GHSA-337j-9hxr-rhxg SSR hydration injection), fixed only in 7.18 and later. The current SPA doesn't use SSR hydration, and navigation targets come from fixed in-app paths or server-generated instance IDs, but these advisories are still recorded as a residual preview risk and must be audited again for every release. Earlier advisories were resolved by upgrading `react-router-dom` / `react-router` to 6.30.6 (GHSA-jjmj-jmhj-qwj2), `@fastify/static` to 10.1.10 with `glob` 14.0.3 / `minimatch` 11.0.4 (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249), and transitive dependencies (`fastify` 5.12.7, `fast-jwt` 6.3.5, `@fastify/busboy` 3.2.3, `fast-uri` 3.1.9 / 4.2.3, `brace-expansion` 5.0.12). The critical `tinypool` advisory in the `vitest` 3 development dependency doesn't reach the portable package. Upgrading needs a major version jump, so it hasn't been handled yet.

## Release Maintenance

Maintainer steps for packaging and publishing are kept in one place, in the [Chinese version](portable-release.zh-CN.md#发布维护).
