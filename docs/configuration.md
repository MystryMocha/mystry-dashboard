# Configuration

**English** · [简体中文](configuration.zh-CN.md)

Which config file is used depends on how you start the panel. Don't mix the two files:

| Launch entry | Default config file | First-time configuration |
|---|---|---|
| Running `npm run dev:server` / `npm start` by hand | `.env` in the repository root | Copy `.env.example` and fill in random secrets |
| Windows source `PanelManager.cmd` | `.env` in the repository root (change it with `MYSTRY_CONFIG_PATH`) | The manager creates it from `.env.example`; mystryctl generates or repairs the secrets |
| Linux / WSL source `PanelManager.sh` | `config/panel.env` in the repository root | Generated automatically by the cross-platform controller |
| Portable `mystryctl` | `config/panel.env` in the package root | Generated automatically by the cross-platform controller |

The table lists the defaults. For the variables that override these paths, see the environment variable tables below. Keep any configuration you already have. Don't overwrite it with the template again. In Windows PowerShell, use `npm.cmd`.

## Required Settings for First Start

Before the first start you must configure:

- `JWT_SECRET`: a 64-character hexadecimal string used to sign JWTs.
- `SETUP_TOKEN`: a 64-character hexadecimal string used in the `X-Setup-Token` header of the first setup request. The launcher generates it automatically and removes it after creating the administrator. You only need to set it yourself when you run the panel by hand.
- `LAUNCHER_TOKEN`: a separate local shutdown token generated automatically by PanelManager / mystryctl. You can leave it out if you run the panel by hand without a manager.

Each configured secret must use a different random value. The Node.js command below generates one. The docs and the template don't provide any usable fixed secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`POST /api/auth/setup` is only available while the user table is empty, and the request must carry `X-Setup-Token: <SETUP_TOKEN>`. For the steps on the page, see [Set Up Administrator](getting-started.md#set-up-administrator). Once the administrator is created, you can remove `SETUP_TOKEN` from the config file your launch entry actually uses, then restart the panel. Existing users don't need it to sign in. If the user table is empty and there is no `SETUP_TOKEN`, the panel doesn't start.

## Environment Variables

Where a limit is measured in bytes or milliseconds, the tables say so. `MiB` is calculated as `1024 × 1024`.

### Basics and Authentication

| Variable | Default | Description |
|------|--------|------|
| `HOST` | `127.0.0.1` | Fastify listen address |
| `PORT` | `3000` | Listen port |
| `JWT_SECRET` | None; required before the first start | 64-character hexadecimal JWT signing secret. Don't use a fixed example value |
| `SETUP_TOKEN` | None; required before the first setup | 64-character hexadecimal setup token. You can remove it after setup is complete |
| `LAUNCHER_TOKEN` | None; generated automatically when you use PanelManager / mystryctl | 64-character hexadecimal local shutdown token. Usable only from a loopback address |
| `JWT_EXPIRES_IN` | `2h` | JWT lifetime. A plain number is read as milliseconds. You can also write `2h` / `30m` / `7d` |
| `CORS_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Exact CORS origin allowlist, comma-separated. Don't use `*` |
| `RATE_LIMIT_MAX` | `120` | Maximum number of regular requests per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window for regular requests, in milliseconds |
| `AUTH_RATE_LIMIT_MAX` | `10` | Maximum number of failed sign-ins, setup requests and local shutdown requests per window. A successful sign-in clears the failure count for that username and IP |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `300000` | Authentication rate limit window, in milliseconds |
| `CONSOLE_TICKET_TTL_SECONDS` | `60` | Console ticket lifetime. Each ticket can open only one WebSocket connection |
| `FILE_DOWNLOAD_TICKET_TTL_SECONDS` | `60` | File download ticket lifetime. Each ticket can be used for only one download |

### HTTP, File and Upload Lifecycle

| Variable | Default | Description |
|------|--------|------|
| `HTTP_REQUEST_TIMEOUT_MS` | `900000` | HTTP request lifecycle timeout, 15 minutes |
| `HTTP_CONNECTION_TIMEOUT_MS` | `300000` | HTTP connection timeout, 5 minutes |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `72000` | HTTP keep-alive idle timeout, 72 seconds |
| `UPLOAD_IDLE_TIMEOUT_MS` | `30000` | Upload idle timeout, 30 seconds. An upload that keeps sending no data is cancelled |
| `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` | `60000` | File download idle timeout, 60 seconds. On timeout the download is closed and its concurrency slot is released |

### JSON, Concurrency and Tasks

| Variable | Default | Description |
|------|--------|------|
| `MAX_JSON_BODY_BYTES` | `1048576` | JSON request body limit, 1 MiB |
| `MAX_CONCURRENT_UPLOADS` | `1` | Maximum number of uploads handled at the same time |
| `MAX_CONCURRENT_FILE_DOWNLOADS` | `4` | Maximum number of file downloads handled at the same time |
| `MAX_CONCURRENT_TASKS` | `1` | Maximum number of deploy / import tasks running at the same time |
| `MAX_QUEUED_TASKS` | `2` | Maximum number of tasks waiting to run |
| `TASK_TIMEOUT_MS` | `1800000` | Timeout for a single task, 30 minutes |
| `BACKUP_TASK_TIMEOUT_MS` | `21600000` | Timeout for backup and restore tasks, 6 hours. The pre-restore backup and the extraction count as one task |
| `IMPORT_PREVIEW_TTL_SECONDS` | `1800` | Lifetime of a ZIP import preview waiting for confirmation, 30 minutes by default |
| `MAX_IMPORT_PREVIEWS` | `2` | Maximum number of ZIP previews waiting for confirmation that are kept at once, panel-wide. Each signed-in user can have at most one |

Deploy and import tasks are limited by both the concurrency limit and the queue limit. Once `MAX_CONCURRENT_TASKS` is reached, new tasks wait in the queue. When the queue is full, the request returns **429**. A task that runs longer than `TASK_TIMEOUT_MS` after it starts fails and is cleaned up. A panel restart doesn't resume unfinished tasks. On startup the panel marks them as failed and cleans up any half-built instances that were created.

File downloads are limited by `MAX_CONCURRENT_FILE_DOWNLOADS`. When all slots are in use, a file download request returns **429**. A download with no data activity for `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` is closed, and the download slot it held is released.

### Cores, Installer and Text/Console

| Variable | Default | Description |
|------|--------|------|
| `MAX_CORE_DOWNLOAD_BYTES` | `536870912` | Limit for a single core download, 512 MiB |
| `CORE_DOWNLOAD_TIMEOUT_MS` | `300000` | Core download timeout, 5 minutes |
| `MAX_CORE_METADATA_BYTES` | `2097152` | Limit for core metadata responses such as versions and builds, 2 MiB |
| `CORE_METADATA_TIMEOUT_MS` | `15000` | Core metadata request timeout, 15 seconds |
| `MAX_INSTALLER_OUTPUT_BYTES` | `65536` | Limit on retained installer output, 64 KiB |
| `INSTALLER_KILL_GRACE_MS` | `5000` | Grace period before the installer is force-killed after a cancel or timeout, 5 seconds |
| `MAX_TEXT_FILE_BYTES` | `1048576` | Limit for text files read or edited online, 1 MiB |
| `MAX_COMMAND_BYTES` | `4096` | Limit for a single console command, 4 KiB |
| `MAX_CONSOLE_BUFFER_BYTES` | `1048576` | Console history buffer limit, 1 MiB |
| `MAX_CONSOLE_CHUNK_BYTES` | `65536` | Limit for a single console output chunk, 64 KiB |
| `MAX_CONSOLE_INCOMING_BYTES` | `4352` | Limit for a single incoming WebSocket message, including message protocol overhead |
| `MAX_CONSOLE_CONNECTIONS` | `20` | Maximum number of concurrent console WebSocket connections |
| `MAX_CONSOLE_COMMANDS_PER_WINDOW` | `60` | Maximum number of console commands sent per command rate limit window |
| `CONSOLE_COMMAND_WINDOW_MS` | `60000` | Console command rate limit window, 60 seconds |
| `MAX_CONSOLE_STDIN_BYTES` | `65536` | Limit on the buffer of pending input written to the instance's stdin, 64 KiB |

When the connection limit or buffer capacity is exceeded, new connections are rejected or reading is paused. A command that is too long or exceeds the rate limit isn't written to the instance.

### Uploads, ZIP Extraction and Local Folder Import

| Variable | Default | Description |
|------|--------|------|
| `MAX_UPLOAD_BYTES` | `536870912` | Limit for a single uploaded file, 512 MiB |
| `MAX_BACKUP_UPLOAD_BYTES` | `10737418240` | Limit for an uploaded backup file, 10 GiB. Backups are usually larger than regular uploads, so they have their own setting |
| `MAX_ZIP_ENTRIES` | `10000` | Limit on the number of ZIP entries |
| `MAX_ZIP_ENTRY_BYTES` | `1073741824` | Limit for a single extracted entry, 1 GiB |
| `MAX_ZIP_UNCOMPRESSED_BYTES` | `2147483648` | Limit on the total size after ZIP extraction, 2 GiB |
| `MAX_ZIP_CENTRAL_DIRECTORY_BYTES` | `33554432` | ZIP central directory limit, 32 MiB |
| `MAX_EXISTING_IMPORT_ENTRIES` | `200000` | Limit on file and directory entries for a single folder import from `DATA_DIR/imports` |
| `MAX_EXISTING_IMPORT_BYTES` | `107374182400` | Limit on the total file size for a single folder import from `DATA_DIR/imports`, 100 GiB |
| `MOD_LOADER_PRECHECK_MAX_DEPTH` | `4` | Maximum directory depth of the ModLoader args precheck in the existing-server source list endpoint |
| `MOD_LOADER_PRECHECK_MAX_ENTRIES` | `200` | Same as above: maximum number of entries traversed |
| `MOD_LOADER_PRECHECK_TIMEOUT_MS` | `250` | Same as above: maximum time (milliseconds) |
| `MOD_LOADER_SCAN_MAX_DEPTH` | `64` | Maximum directory depth of the ModLoader args deep scan in import/deploy tasks |
| `MOD_LOADER_SCAN_MAX_ENTRIES` | `50000` | Same as above: maximum number of entries traversed |
| `MOD_LOADER_SCAN_TIMEOUT_MS` | `30000` | Same as above: maximum time (milliseconds) |

A regular file or zip upload larger than `MAX_UPLOAD_BYTES` returns **413**. When all upload slots are in use, it returns **429**. A ZIP also goes through the entry count, single entry, total extracted size and central directory limit checks.

The check result of a ZIP import is held temporarily in `uploads/.tmp-import-preview-*`, isolated per signed-in user. It expires after `IMPORT_PREVIEW_TTL_SECONDS`, and all of them are deleted when the panel restarts. When the panel-wide preview limit is reached, the request returns **429**.

`MAX_EXISTING_IMPORT_*` limits how much a single copy can contain when you import from a local folder. For the other checks made before importing, see [Import from a Local Folder](user-guide.md#import-from-a-local-folder).

### Data Directory

| Variable | Default | Description |
|------|--------|------|
| `DATA_DIR` | `data` | Data root directory. A relative value is resolved against the repository root. You can also use an absolute path |
| `MYSTRY_HOME` | Repository root for source; package root for the portable build | Root of the runtime layout. It must be set in the process environment before Node starts |
| `MYSTRY_CONFIG_PATH` | `.env` for source; `config/panel.env` for the portable build | Config file path. A relative value is relative to `MYSTRY_HOME` |
| `MYSTRY_DATA_DIR` | Uses `DATA_DIR` when not set | Takes priority over `DATA_DIR`. A relative value is relative to `MYSTRY_HOME` |
| `BACKUP_DIR` | `DATA_DIR/backups` | Instance backup directory. A relative value is relative to `MYSTRY_HOME`. You can put it on another disk, but it can't be inside `instances`, `imports`, `uploads` or `.mystry-staging`, and it can't contain the whole data directory |

### Launcher Language

The menus and messages of `PanelManager.cmd`, `PanelManager.sh` and `mystryctl` follow the system language: Chinese when the system language is Chinese, and English for every other language. On Windows it looks at the display language. On Linux / macOS it looks at `LC_ALL`, `LC_MESSAGES` and `LANG`, in that order. This only affects the launcher, not the web interface or the panel logs.

| Variable | Default | Description |
|------|--------|------|
| `MYSTRY_LANG` | Follows the system | Set it to `zh-CN` or `en-US` to fix the launcher language. Any value starting with `zh` means Chinese, and everything else is treated as English |

The runtime layout under `DATA_DIR` is:

| Path | Description |
|------|------|
| `panel.db` | SQLite database (users, instances, tasks) |
| `instances/` | The only managed root directory for instances |
| `instances/<id>/` | All files, the jar and the working directory of that instance |
| `imports/<folder name>/` | Handoff area for existing servers on the same machine. It is only a copy source, not an instance working directory |
| `cache/cores/` | Download cache for core jars |
| `uploads/` | Temporary upload directory. `.tmp-import-preview-*` holds ZIPs waiting for confirmation, which aren't kept across restarts |
| `backups/<id>/` | Instance backups (when `BACKUP_DIR` isn't set). Each backup is a `.tar.gz` plus a `.json` metadata file with the same name |

Whether the final data directory comes from `MYSTRY_DATA_DIR` or `DATA_DIR`, an instance can only ever live in `instances/<id>` under that directory. Deploying, importing, creating and starting all use this directory. Custom instance install directories aren't supported, and there is no feature for picking a directory from anywhere on the machine. A path in the instance file API is only a logical path relative to that instance's root directory.

**Symbolic links**: if a folder above the data directory or the backup directory is a symbolic link or junction (for example, a Linux distribution where `/home` is itself a link), the panel uses its real location when it reads the configuration. The data directory itself, and everything inside it, must not be a link. Otherwise the panel refuses to work with instances.

**Permissions**: on Linux/macOS, the panel creates the data root and directories such as `instances`, `imports`, `uploads`, `.mystry-staging` and `.mystry-panel-lock` at startup and verifies that they are `0700`, and that `panel.db` and its WAL/SHM files are `0600`. If an existing directory is accessible to group/other, the panel refuses to start by default. Set `MYSTRY_REPAIR_DATA_PERMISSIONS=1` to tighten the permissions automatically at startup. On Windows, Node can't reliably verify ACLs, so the first start prints a blocking-level warning. Make sure `DATA_DIR` can be read and written only by the user who runs the panel (in the portable build, `mystryctl`/PanelManager creates a user-only directory).

`MYSTRY_HOME` and `MYSTRY_CONFIG_PATH` decide where the config file is, so you can't rely on that config file to change where it is loaded from. Set them before startup through `mystryctl`, the shell, or the process environment. Portable users usually don't need to set these variables by hand.

## npm Registry

This is the download address the source launcher uses when it installs dependencies. The portable build ships with its dependencies, so you don't need to set it.

```powershell
.\PanelManager.cmd mirror
.\PanelManager.cmd mirror npmmirror
```

The first command shows the current choice and the available options. The second one switches. On Linux / WSL, use `./PanelManager.sh mirror`. On Windows, you can also choose it in the menu after double-clicking `PanelManager.cmd`.

| Name | Download address | Description |
|------|----------|------|
| `default` | npm's own configuration | The default. The launcher doesn't specify an address |
| `official` | `https://registry.npmjs.org/` | Official npm registry, international |
| `npmmirror` | `https://registry.npmmirror.com/` | Mainland China |
| `tencent` | `https://mirrors.cloud.tencent.com/npm/` | Tencent Cloud, mainland China |
| `huawei` | `https://repo.huaweicloud.com/repository/npm/` | Huawei Cloud, mainland China |

The choice is saved in `config/npm-mirror` in the repository root. This file isn't tracked by Git. A switch takes effect the next time dependencies are installed. To reinstall right away, run `rebuild`.

| Variable | Default | Description |
|------|--------|------|
| `MYSTRY_NPM_MIRROR` | Not set | Sets the registry temporarily. It takes priority over the saved choice and accepts the same values as above |

Switching the registry doesn't change what gets installed: `package-lock.json` records only the official addresses, npm swaps in the registry you chose at install time, and downloads are still verified against the `integrity` values in the lockfile.

## Security Recommendations

1. By default the panel binds only to the loopback address, so other devices can't open it. To use it from a phone or another computer, click **Other Devices** in the panel (or run the launcher's `remote on`). You don't change `HOST` and you don't restart. See [Open the Panel on Another Device](user-guide.md#open-the-panel-on-another-device).
2. Once it's on, any device that can reach this computer can open the sign-in page. The sign-in is the protection, so use a strong password. Two security options are yours to choose:
   - **Use HTTPS** (on by default): the connection is encrypted. The panel issues its own certificate, so a browser warns that it is not secure the first time. Choose Advanced, then continue to the site. To be sure you reached the right panel, compare the certificate fingerprint shown in the dialog. With it off there is no warning, but anyone who can capture traffic on the same network or the internet can read your password.
   - **Only Allow Devices on the Same Network** (off by default): only devices on the same network as this computer can open the panel. If the panel runs on a cloud server, turning it on locks out your own computer too.
3. If you'd rather not open a port, use **Virtual Network** in the same dialog, or SSH port forwarding (`ssh -L 3000:127.0.0.1:3000 user@server`, then open `http://127.0.0.1:3000` on your own computer). You can also run your own reverse proxy (Nginx / Caddy). When the proxy and the panel are on the same machine, the panel sees every request as coming from `127.0.0.1`, so the sign-in failure limit counts everyone as one source.
4. `JWT_SECRET` and `SETUP_TOKEN` must use different random values. Remove `SETUP_TOKEN` after setup succeeds.
5. Use a strong administrator password of at least 12 characters. The panel can read and write instance files and run processes.
6. Instances use the `java` on PATH by default. On the Quick Deploy page or in the instance's Settings, you can also bind a runtime ID that the panel has scanned and verified. Scanning runs `-version` on each candidate, so `JAVA_HOME` and the common install directories must be controlled by a trusted local administrator. Requests can't submit a Java path.
7. Paper download requests carry a compliant User-Agent. Follow the terms of use of each core's distributor.

## Frontend Dev Proxy

In development mode, `apps/web/vite.config.ts` proxies:

- `/api` → `http://127.0.0.1:3000`
- `/ws` → `ws://127.0.0.1:3000`

If port 3000 is reserved by the system or can't be bound on your machine, set the environment variable `MYSTRY_DEV_API_PORT` before running `npm run dev:web` (PowerShell example: `$env:MYSTRY_DEV_API_PORT = "3100"`) so the proxy points at the port the panel is actually listening on. The panel itself must already be listening on that port (set by `PORT`). This variable only affects the target port of the Vite dev proxy. It doesn't affect the panel's own listening or configuration.

After a production build, the backend's `@fastify/static` serves the static files and Vite isn't needed. `npm run build -w @mystry/web` generates `.br` / `.gz` precompressed copies of text assets after `vite build`, and the backend sends them directly based on the browser's `Accept-Encoding`. Hashed `/assets/*` files can be cached by the browser for one year, and `index.html` is revalidated every time, so a refresh after an upgrade gets the new version. A reverse proxy doesn't need to compress these assets again.
