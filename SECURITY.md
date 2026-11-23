# Security Policy

**English** · [简体中文](SECURITY.zh-CN.md)

## Supported Versions

| Version | Support status |
|------|----------|
| `0.2.0-preview.x` | Current Preview, accepts security reports |
| `0.1.x` | Temporarily maintained until a newer Preview is released |

Once a stable release is published, security fixes are accepted only for minor versions still in support. Preview does not promise the long-term security support window of a stable release.

## Reporting a Vulnerability

This project is a high-privilege local management panel (it can read and write instance files and start Java processes). If you find a security problem, do **not** open a public Issue or discussion.

Contact the maintainers privately through either channel:

1. GitHub **Private vulnerability reporting** for the repository (if enabled: Security → Report a vulnerability); or
2. A private message / email to the repository maintainers (contact details are in the repository About section or profile).

Include as much of the following as you can:

- Affected version and environment (OS, Node version)
- Vulnerability type and impact (for example unauthorized access, path traversal, command injection)
- Minimal reproduction steps or a PoC (do not paste it in public channels)
- Your suggested fix direction (optional)

We will confirm and reply as soon as possible. Do not disclose details before a fix is released.

## Security Design Principles (Summary)

- Listens on `127.0.0.1` by default to avoid unintended exposure to the public internet. For access from other devices, a signed-in administrator turns it on in the panel (or with the local launcher's `remote` command): the panel opens extra listeners on the chosen interfaces, with HTTPS on a self-signed certificate by default and a "same subnet only" switch. A self-signed certificate protects against eavesdropping but not active impersonation; compare the certificate fingerprint shown in the UI and the terminal. With HTTPS turned off, the password and sign-in token travel in plaintext. Once enabled, the login page may face the public internet, and the sign-in itself is the protection (a random initial password, passwords of at least 12 characters, and failed-attempt rate limiting by "source IP + username").
- The pages the panel serves carry a Content Security Policy: scripts run only from the panel's own files plus the page's inline appearance/language script, allowed by its SHA-256 hash computed from the built `index.html` (never by `'unsafe-inline'`), so injected markup cannot run script that could read the sign-in token held in the browser. Framing, plugins and `<base>` are denied.
- The local launcher endpoints (shutdown, password reset, toggling access) accept only a loopback origin plus `LAUNCHER_TOKEN` and cannot be reached from other devices; the process fingerprint in the health check is returned only to requests from this machine.
- The panel's built-in EasyTier network allows only the panel port and is independent of the instances' multiplayer networks; its network secret is equivalent to a credential for reaching the panel login page, so use it only on your own devices. Connections arriving through it appear to the panel as coming from this machine.
- First-time setup uses the `X-Setup-Token` header; setup accepts requests only while the users table is empty. Remove `SETUP_TOKEN` after the administrator is created.
- `JWT_SECRET` and `SETUP_TOKEN` must be distinct 64-digit hex random values and must not be committed to the repository.
- Every instance lives strictly in `DATA_DIR/instances/<id>`; the panel does not accept custom instance directories and offers no whole-disk directory browsing.
- Instance files and zip extraction are validated against path escape, and file API paths are always relative to the instance root.
- Instances start with the `java` on PATH by default, or with a runtime the panel scanned and verified, referenced by registry ID; requests cannot submit a full Java path. Scanning only runs `-version` on candidates, with a sanitized child process environment; `JAVA_HOME` and the scanned directories must be controlled by a trusted local administrator.
- The panel neither accesses nor deletes legacy external instance directories; the user migrates them with system tools after stopping the server.
- `DATA_DIR` can be configured relative to the project root or as an absolute path; instances can still only live in `instances/<id>` under it.
- An upload over the size limit returns 413, and exhausted upload concurrency returns 429; the core cache atomically publishes only fully written files.
- File downloads are limited to 4 concurrent by default; exhausted download concurrency returns 429, and an idle download times out, closes and releases its slot (controlled by `MAX_CONCURRENT_FILE_DOWNLOADS` and `FILE_DOWNLOAD_IDLE_TIMEOUT_MS`).
- Multiplayer opens only the game port of the chosen instance and does not expose the panel. The panel downloads pinned versions of the official frpc and EasyTier and verifies their SHA-256. When hole punching fails on the virtual LAN, traffic is relayed through community shared peers with content encrypted by the network secret; on Windows the panel must run as administrator. The network secret and the frp **Player Config** are both equivalent to credentials for connecting to that game port; give them only to people you trust.
- Deploy / import tasks can queue and are protected by an execution timeout; the console limits concurrent connections, command size and rate, inbound messages and the stdin buffer.

See [docs/configuration.md](docs/configuration.md) for details.

## Acknowledgements

Contributors who disclose responsibly and help with a fix can be credited after the fix is released, if they wish (anonymously if preferred).

## Release Asset Integrity

The GitHub Release of a public Preview provides the archives, `SHA256SUMS`, `SHA256SUMS.asc` and `mystry-release-signing-key.asc`. Maintainer setup and fingerprint notes are in [`.github/RELEASE_SIGNING.md`](.github/RELEASE_SIGNING.md); user verification steps are in [docs/portable-release.md](docs/portable-release.md).

Verification in brief:

1. Import the public key attached to the Release and check that its fingerprint matches [`.github/release-signing-key.fingerprint`](.github/release-signing-key.fingerprint) in the repository.
2. Use `sha256sum -c` or an equivalent to confirm that the archive hashes match `SHA256SUMS`.
3. Use `gpg --verify SHA256SUMS.asc SHA256SUMS` to confirm the checksum list was signed by that public key.

Before creating a Release, CI runs the same verification in a standalone keyring; the private key, fingerprint and Environment approval are configured by the repository administrator and are not read by the application at runtime.
