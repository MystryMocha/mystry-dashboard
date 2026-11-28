# API Reference

**English** · [简体中文](api.zh-CN.md)

Apart from the public endpoints listed below, all `/api/*` routes require a JWT:

```http
Authorization: Bearer <token>
```

Endpoints with a request body use JSON with the header `Content-Type: application/json`; a POST without a body, such as start or stop, should omit `Content-Type` or send `{}`. Any other `Content-Type` returns **415**.

Error responses are JSON:

```json
{ "error": "Instance not found.", "code": "server.instance.notFound", "params": { "id": "abc" } }
```

- `error`: the rendered **English** description, which scripts and older clients can display directly.
- `code` / `params`: errors produced by the panel itself carry a stable message key and params (keys start with `server.` and are defined in `packages/shared/src/messages/`). The Web UI translates the key into the current language (English / Simplified Chinese / Traditional Chinese) and falls back to `error` when the key is missing. A param value can be text, a number, or another `{ key, params }` message (for example a failure reason).
- Raw text from Node.js system errors, Java or network libraries has no `code`; `error` is returned as is.
- The `code` of instance start/stop, delete and takeover conflicts (409) is also a message key (such as `server.instance.alreadyRunning`), no longer `INSTANCE_OPERATION_CONFLICT`.
- A request body validation failure (Fastify / AJV) returns 400 with `code` `server.common.invalidRequest` and `params.detail` holding the English validation message.

## Overview Performance Monitoring

`GET /api/system/metrics` requires a JWT and returns the shared type `DashboardMetrics`:

- `sampledAt`: the sample time; `cpuPercent`: whole-machine CPU usage, `null` on the first sample.
- `memory`: host `usedBytes` / `totalBytes`; `disk`: `availableBytes` / `totalBytes` of the disk holding the data root, `null` when reading fails.
- `instances`: keyed by instance ID, containing `cpuPercent`, `memoryBytes` and `state` (`ready` / `collecting` / `unavailable`). Only live processes the panel holds are sampled; callers cannot specify a PID or path.
- `warnings`: raised when CPU or memory stays at 90% across samples for at least 30 seconds, or when free disk space is below 5 GiB or 10%. The text is English; `warningsI18n` lists the matching message keys in the same order for the UI to translate.

CPU is normalized to 0–100% of the total capacity of all logical cores; process memory is resident memory, not the JVM heap limit Xmx. Process metrics currently support only Windows and Linux and are `unavailable` on other platforms. An empty value does not mean zero usage. The live snapshot is cached for 4 seconds and concurrent requests are merged (shared with the 5-minute background sampler), and the page refreshes every 5 seconds and pauses while hidden. A sampling gap longer than 15 seconds restarts the sustained-warning timer.

### Overview History `/api/stats/overview`

`GET /api/stats/overview?range=24h|7d|30d` requires a JWT and returns the shared type `StatsOverview`. `range` defaults to `7d`; any other value or unknown query parameter returns **400** (`server.system.statsRangeInvalid`).

- `range` / `from` / `to` / `bucketSeconds`: requested range, UTC ISO-8601 window bounds (`from` is `to` minus the range duration), and bucket width in seconds (`300` for `24h`, `3600` for `7d`, `21600` for `30d`).
- `processMetricsSupported`: `true` on Windows and Linux; `false` on platforms without per-process CPU and memory collection, where instance series stay `null`.
- `ioMetricsSupported`: `true` on Windows and Linux, where the panel collects whole-machine network and disk I/O; `false` elsewhere, where those series stay `null`.
- `ioReadFailed`: `{ network, disk }`, each `true` when the latest background read of that half failed or kept no device, so empty series mean the counters cannot be read rather than not collected yet. Both are `false` before the first read and whenever `ioMetricsSupported` is `false`.
- `buckets`: fixed-width slots (`288` for `24h`, `168` for `7d`, `120` for `30d`), each with `timestamp`, `hostCpuPercent`, `hostMemoryBytes`, `instancesCpuPercent`, `instancesMemoryBytes`, `hostNetRxBytesPerSec`, `hostNetTxBytesPerSec`, `hostDiskReadBytesPerSec` and `hostDiskWriteBytesPerSec`. Missing slots return `null` and samples ahead of the current server time are ignored. Instance totals use two-layer aggregation anchored on each host sample timestamp (`instance_id IS NULL`): timestamps with no running instances count as `0` when per-process metrics are supported, whereas timestamps where running instances exist but all reported `null` are skipped before averaging the bucket. The four I/O rates are bytes per second averaged over each 5-minute sampling interval: network counts physical adapters only (hardware adapters on Windows, interfaces with a `device` link in sysfs on Linux, or every interface but loopback inside a container that has none) so VPN, proxy TUN, bridge and veth traffic is not counted twice; disk counts whole physical disks only, not partitions or stacked devices. A sample that follows a gap longer than two intervals (the panel was off or the computer slept) has no I/O value.
- `runs`: instance runs that finished starting (`ready_at` set) and overlap `[from, to]`, each with `instanceId`, `readyAt`, `endedAt` (`null` while still running) and `endReason` (`stopped` / `crashed` / `panel-exit`, or `null`). Pre-spawn failures leave no row; mid-start failures (`start-failed`) and unready zero-code exits (such as an unaccepted EULA) keep `ready_at` null and are omitted.
- `host`: `osName` (`os.version()` on Windows, `PRETTY_NAME` from `/etc/os-release` with kernel fallback on Linux, `macOS` on macOS), `cpuModel` (`null` when unavailable), `cpuThreads`, `totalMemoryBytes` and `bootedAt`.
- `diskBreakdown`: hourly cached sizes of `DATA_DIR/instances` (`instancesBytes`) and `BACKUP_DIR` (`backupsBytes`), plus `backupsOnSameVolume`. Sizes stay `null` until the first background scan completes; `backupsBytes` is `null` when `BACKUP_DIR` is on another volume. Scans skip symlinks and directory junctions without following them.

## Health Check

| Method | Path | Auth | Response |
|------|------|------|------|
| GET | `/api/health` | No | `{ ok: true, service: "mystry-dashboard", processFingerprint?: string }` |

`processFingerprint` appears only when the portable controller started the service, and only in responses to requests from a loopback address: with "access from other devices" enabled, health checks from other devices do not receive it. It lets `mdash` match the state file and PID to the service actually listening; it is not an authentication secret and cannot replace `X-Launcher-Token`. Connections through the panel's built-in network (see below) arrive on a loopback address and therefore do receive it.

## Authentication `/api/auth`

| Method | Path | Auth | Description |
|------|------|------|------|
| GET | `/api/auth/status` | No | `{ needsSetup: boolean }` |
| POST | `/api/auth/setup` | `X-Setup-Token` | Available only while the users table is empty; Body: `{ username, password }` → `{ token, user }` |
| POST | `/api/auth/login` | No | Body: `{ username, password }` → `{ token, user }` or 401 |
| POST | `/api/auth/password` | JWT | Body: `{ currentPassword, newPassword }` → `{ ok: true, token, user }`; a wrong current password returns 400. On success all previously issued JWTs are invalidated (including the one used for this request), and the caller switches to the `token` in the response; see [Token Invalidation](#token-invalidation) |
| GET | `/api/auth/me` | Yes | `{ user }` |
| GET | `/api/auth/session-duration` | Yes | `{ duration }`, one of `2h` / `12h` / `1d` / `7d` / `30d` / `never`, default `12h`; see [Session Duration](#session-duration) |
| PUT | `/api/auth/session-duration` | Yes | Body: `{ duration }` → `{ duration, token }`; a value not in the list returns 400 (`server.auth.sessionDurationInvalid`). The caller switches to the `token` in the response, issued with the new duration |

### The setup Request

`setup` does not use a JWT; it requires the value of the environment variable `SETUP_TOKEN` in a header:

```http
POST /api/auth/setup
Content-Type: application/json
X-Setup-Token: <SETUP_TOKEN>

{"username":"admin","password":"a strong password of at least 12 characters"}
```

Once the user is created, the setup endpoint is no longer available. `mdash` uses this endpoint to create `admin` automatically and removes `SETUP_TOKEN` on success. Secret format requirements are in [Configuration](configuration.md#required-settings-for-first-start).

### Session Duration

The session duration is stored in `panel_settings` and set on the "Panel Settings" page; it defaults to 12 hours, and the options are 2 hours, 12 hours, 1 day, 7 days, 30 days or never expire. `JWT_EXPIRES_IN` in `.env` no longer applies; if it is still set, the terminal prints a note at startup.

- Setup, sign-in, password change and saving the duration issue tokens with the current setting; with "never expire" the token carries no `exp`.
- Every request re-checks the token's issue time `iat` against the current setting: after the duration is shortened, a token whose sign-in is older than the new duration (including ones issued as "never expire") gets **401** on its next request.
- When the duration is lengthened, the response to the save request carries a token issued with the new duration, so the change takes effect at once on the device that made it; tokens on other devices still expire at the `exp` they were issued with, and the new duration applies after their next sign-in.

### Token Invalidation

`token_version` in the `users` table records the token version, and issued JWTs carry it in the `tv` field. Besides signature and validity checks (see [Session Duration](#session-duration)), every request also requires `tv` to match the database; a nonexistent user also returns **401** (`server.common.unauthorized`).

A successful password change (`POST /api/auth/password`) or local password reset (`POST /api/launcher/reset-password`) increments the version, so:

- All previously issued JWTs return 401 on their next request. The password change response carries a new token, so the session making the change can continue; a password reset issues no token, and every session must sign in again.
- Unused console tickets issued by old tokens, and download tickets that have not opened a stream, are voided at the same time; the download ticket status becomes `failed`.
- Open console WebSockets are closed with close code **4401**, and the client must request a new ticket with a currently valid token.
- Downloads already transferring are not interrupted; they passed authorization when the stream opened.

Tokens issued by 0.2.0-preview.3 and earlier have no `tv` and are treated as version 0: after the upgrade they remain usable until they expire, and are invalidated by the first password change or reset. Old databases gain the `token_version` column automatically at startup, and existing users start at 0.

## System `/api/system`

| Method | Path | Auth | Response |
|------|------|------|------|
| GET | `/api/system/java` | Yes | Java status object |
| GET | `/api/system/java-runtimes` | Yes | `{ runtimes: JavaRuntimeInfo[], installable: number[] }` |
| POST | `/api/system/java-runtimes/install` | Yes | Request body `{ major }` (8, 17, 21, 25); returns the background task `TaskInfo`; on completion `result.javaRuntimeId` is the new runtime |
| POST | `/api/system/java-runtimes/install/:taskId/cancel` | Yes | Cancels a one-click Java install task still queued or running and returns the task's current state; 409 when it is not a Java install task in progress (`server.jvm.javaInstall.notCancellable`) |
| GET | `/api/system/panel-info` | Yes | `PanelInfo`: `{ host, port, dataDir, backupDir, configPath, maxTextFileBytes }`, the listen address, directories (absolute paths) and text file limit (`MAX_TEXT_FILE_BYTES`) the panel read from the config file at startup. Read-only, without secrets. The address and directories are shown as "Runtime Info" on the "Panel Settings" page; the file manager offers editing for files up to `maxTextFileBytes` |
| GET | `/api/system/download-source` | Yes | `{ source: 'official' \| 'china' }` |
| PUT | `/api/system/download-source` | Yes | Request body `{ source }`; returns the saved value; other values return 400 |
| GET | `/api/system/auto-restart` | Yes | `AutoRestartSettings`: `{ enabled, delaySeconds, maxAttempts, windowMinutes }`; `{ false, 10, 3, 10 }` until saved |
| PUT | `/api/system/auto-restart` | Yes | Request body `AutoRestartSettings`, all four fields: `delaySeconds` 5–300, `maxAttempts` 1–10, `windowMinutes` 5–60, whole numbers; returns the saved value, and anything else returns 400. Saving `enabled: false` also drops every restart that is waiting |
| GET | `/api/system/remote-access` | Yes | `RemoteAccessStatus`; interfaces are re-enumerated on every read |
| PUT | `/api/system/remote-access/direct` | Yes | Request body `UpdateDirectAccessRequest`; returns `RemoteAccessStatus` |
| PUT | `/api/system/remote-access/overlay` | Yes | Request body `UpdateOverlayAccessRequest` (`interfaceName` required when enabling); returns `RemoteAccessStatus` |
| POST | `/api/system/remote-access/certificate` | Yes | Regenerates the panel's self-signed certificate; returns `RemoteAccessStatus` |
| PUT | `/api/system/remote-access/panel-network` | Yes | Request body `UpdatePanelNetworkRequest`; returns `PanelNetworkStatus` |
| GET | `/api/system/remote-access/panel-network/join` | Yes | `PanelNetworkJoinInfo`, including the network secret, with `Cache-Control: no-store` |
| POST | `/api/system/remote-access/panel-network/reset-secret` | Yes | Resets the network name and secret; returns `PanelNetworkStatus` |
| GET | `/api/system/public-host` | Yes | `{ publicHost: string \| null }` |
| PUT | `/api/system/public-host` | Yes | Request body `{ host: string \| null }` (`null` clears); returns `{ publicHost }` |

The download source defaults to `official` and is stored in `panel.db`; downloads started after saving use it at once, without a restart. [Architecture](architecture.md#download-sources) describes where each kind of file comes from.

### Accessing the Panel from Other Devices

The panel's main listener stays unchanged (`HOST:PORT`, `127.0.0.1:3000` by default). When access is enabled, the server starts an extra listener (same port) on each IPv4 address to open and hands connections to the same HTTP server; the settings are stored in the `panel_settings` table of `panel.db` and take effect on save, without a restart. Any signed-in request can toggle it, not only requests from this machine.

- **`direct` (direct access)**: `interfaceName` `null` means all interfaces (excluding the instances' multiplayer networks); alternatively, give the name of one interface. `https` defaults to `true`: the listener dispatches on the first byte and hands TLS handshakes to the panel, while plaintext requests get only a `308` to `https://` on the same host, with no HSTS. `restrictToSubnet` defaults to `false`: when on, each listener accepts only sources in its own interface's subnet (overlay interfaces in `100.64.0.0/10` allow that whole range; other `/32` interfaces have no derivable subnet, so they are not listened on and are flagged `subnetUnknown`).
- **`overlay` (installed virtual networking software)**: listens only on the chosen interface; `https` defaults to `false`. "All interfaces" in direct access leaves out this interface's addresses.
- **Certificate**: an ECDSA P-256 self-signed certificate stored at `<data root>/tls/panel.key` and `panel.crt`, valid for 800 days, with a SAN of the interface addresses and public address at generation time. An existing certificate is reused, and is regenerated only when the files are missing or corrupted, it expires within 30 days, or the user asks. `certificate` in the status holds only the fingerprint, expiry time and SAN, not the private key.
- **Status**: `RemoteAccessStatus` contains `managedByConfig` (`true` when `HOST` is already a non-loopback address, in which case the two PUTs return 409 `server.remoteAccess.managedByConfig`), `port`, `frontendServed`, `platform`, `interfaces` (each interface's name, address, `cidr` and classification `kind`), `publicHost`, `certificate`, `direct`, `overlay` and `panelNetwork`. `urls` of `direct` / `overlay` lists every candidate URL and whether it is listening, with `problem` on an address that could not be attached (`listenFailed` / `subnetUnknown`); overall problems are in `problem` (also `interfaceGone`, `noAddress`, `certificateFailed`); `firewall` is the Windows firewall rule result `applied` / `failed` / `skipped`.
- **Firewall**: on Windows the rule names include the panel port, `MystryDashboard-Panel-Direct-<port>`, `MystryDashboard-Panel-Overlay-<port>` and `MystryDashboard-PanelNet-<port>`, so two panels on the same computer do not delete each other's rules; only rules added by this process are deleted.
- **Failures**: a chosen interface that does not exist returns 409 `server.remoteAccess.interfaceGone`; a failure to generate or read the certificate returns 500 `server.remoteAccess.certificateFailed`; when no address could be attached, it returns 409 `server.remoteAccess.listenFailed` or `server.remoteAccess.noAddress`, and the settings revert to their values before the operation.
- **Built-in panel network (`panel-network`)**: the panel runs a pinned version of the official EasyTier (no-TUN mode), with the panel peer fixed at `10.127.0.1`. The panel opens another port on `127.0.0.1` dedicated to the virtual network; `tcp_whitelist` contains only that port (not the panel port), and `url` uses it as well. The port is first searched upward from panel port + 1 (not from the system's dynamic range), stored in settings and reused on every start, and changed (with a log entry) only when another program occupies it. Requests arriving on this port are treated as virtual-network devices: launcher endpoints return 403, `/api/health` omits the process fingerprint, and rate limiting and failed sign-in counting treat the whole virtual network as one origin, separate from this machine. `PanelNetworkStatus` contains `enabled`, `platformSupported`, `installed`, `state` (`stopped` / `installing` / `starting` / `running` / `error`), `detail`, `virtualIp`, `url`, `devices`, the peer settings and `firewall`, but not the network name and secret, which only the `join` endpoint returns. After enabling, installation and startup run in the background, and the UI polls `state`.
- **Public address (`public-host`)**: the public IP or domain entered by the user, shared by the multiplayer page and the panel URLs. The server strips surrounding whitespace, `http(s)://` and a trailing `/`; a value with a port returns 400 `server.publicHost.hasPort`, and other invalid forms return 400 `server.publicHost.invalid`; private addresses are not rejected. The panel does not resolve domains or detect the public IP.

The exact structure of the Java status response:

```json
{
  "available": true,
  "version": "21.0.3",
  "majorVersion": 21
}
```

When Java is not found, it returns `{ "available": false, "version": null, "majorVersion": null }`. The panel offers no whole-disk directory browsing endpoint.

`/api/system/java-runtimes` returns the registry of Java runtimes the panel detected and verified; `?refresh=1` requests a rescan. Concurrent scans merge into one task, and consecutive forced refreshes are subject to a 30-second cooldown; ordinary reads use a 60-second cache by default. Candidate paths come only from scanning `JAVA_HOME`, common install directories and the panel install directory (`runtimes/java/*` under the data root, `source: 'panel'`), and an entry is added only when the file name is `java`/`java.exe` and a version number can be parsed from the `-version` output. An instance can bind a registry entry through `javaRuntimeId` (create, update and deploy requests all accept this optional field; `null` means use the `java` on PATH); requests cannot submit an arbitrary executable path. A bound runtime is verified again before a start or before the Forge/NeoForge installer runs; entries not found by the latest scan are returned with `available: false`.

`installable` lists the Java major versions the panel can install automatically on this computer (currently `[8, 17, 21, 25]` on Windows x64 and Linux x64, and empty on other systems or architectures). `POST /api/system/java-runtimes/install` downloads a pinned version of the Eclipse Temurin JRE (the source follows the download source setting: GitHub or a public GitHub proxy), verifies it against the pinned SHA-256, extracts it in `runtimes/java/.staging-*` under the data root, moves it to `runtimes/java/temurin-<version>`, and registers it after verifying with `-version`; if it is already installed and runs, nothing is downloaded. If a task for the same major version is already queued or running, that task is returned. `POST /api/system/java-runtimes/install/:taskId/cancel` cancels only Java install tasks still queued or running in this process (any other task ID, such as deploy or import, gets 409): a queued task ends at once, and a running one ends after the download or extraction is aborted and the temp directory deleted, so the task may still be `running` when the call returns, and polling must continue. When it ends, `status` is `failed`, `messageI18n` is `server.tasks.cancelled` and `errorI18n` is `server.tasks.cancelledByUser`. A cancel that arrives after the rename to the final directory has no effect, and the task completes as usual. A major version not in the pinned list returns 400 (`server.jvm.javaInstall.unsupportedMajor`), and the endpoint returns 409 when there is no installer for this computer (`server.jvm.javaInstall.platformUnsupported`). Task failure reasons: `downloadFailed`, `checksumMismatch`, `extractFailed`, `verifyFailed` (all under `server.jvm.javaInstall.*`).

`JavaRuntimeInfo` fields:

| Field | Type | Description |
|------|------|------|
| `id` | string | Runtime registry ID; requests may submit only this value |
| `path` | string | Absolute path of the Java executable the panel found, returned only to authenticated users |
| `version` / `majorVersion` | string / number | Full version and major version from the latest verification |
| `source` | `env \| scan \| panel` | `JAVA_HOME`, the scan of common install directories, or a Java the panel installed into the data directory |
| `verifiedAt` | string | Time of the latest successful verification |
| `available` | boolean | Whether the latest full scan still found and verified this entry |

## Instances `/api/instances`

| Method | Path | Description |
|------|------|------|
| GET | `/api/instances` | Instance list `InstanceInfo[]` |
| GET | `/api/instances/:id` | A single instance |
| POST | `/api/instances` | Creates an empty instance; Body: see `CreateInstanceInput` |
| PATCH | `/api/instances/:id` | Updates with `UpdateInstanceInput`, changing only the submitted fields. When `acceptEula` goes from `true` to `false`, `eula.txt` in the instance directory is rewritten to `eula=false`; while the instance is being backed up or restored this change returns **409** |
| POST | `/api/instances/:id/adopt-managed-directory` | Takes over a legacy instance that has been copied into the panel's managed root |
| DELETE | `/api/instances/:id` | Deletes the instance record and the panel-managed instance directory; a legacy external directory is neither accessed nor deleted. By default the instance's backups under `BACKUP_DIR` are deleted as well; `?keepBackups=1` keeps them (they no longer appear in the panel afterwards). Returns **500** when the instance was deleted but deleting its backups failed |
| POST | `/api/instances/:id/start` | Start |
| POST | `/api/instances/:id/stop` | Stop; `?force=1` force-kills the process. When a normal stop times out and the instance is still stopping, returns **202** `{ code: "INSTANCE_STOP_PENDING", error, errorI18n }` |
| POST | `/api/instances/:id/restart` | Restart |
| DELETE | `/api/instances/:id/pending-restart` | Drops the restart the panel scheduled after a crash and returns the `InstanceInfo`; also succeeds when none is waiting |
| POST | `/api/instances/:id/detached-process/dismiss` | Clears `orphanProcess` when its `state` is `unknown` (the panel cannot tell whether the PID is still this server), after the user has checked it is another program; the run is closed and nothing is signalled. Returns **409** `server.instance.orphanDismissAlive` when the PID is confirmed to still be the server |
| POST | `/api/instances/:id/command` | Body: `{ command: string }`; sends a console command |
| GET | `/api/instances/:id/local-network` | Addresses for direct connection, `InstanceLocalNetwork`: `{ port, addresses, publicIpv4, publicIpv6, publicHost, serverIpBlocked, serverIpIsUnboundPublicHost, panelPort, platform }`. Read-only; opens no ports and changes no config |

`InstanceInfo.startIssue` gives `{ kind, requiredJava }` when the latest start failed for a recognizable reason, and is `null` otherwise: `kind` is `eula` (the Minecraft EULA has not been accepted), `java-too-new` or `java-too-old` (the Java in use is too new or too old; `requiredJava` is the major version needed, or `null` when it cannot be determined). The panel recognizes these three by fixed sentence patterns in that process's console output and keeps them only in memory; they are cleared on the next start, when the instance is deleted, or when the panel restarts. `kind` can also be `java-unavailable` (`requiredJava` is always `null`): the runtime the instance's `javaRuntimeId` points at is marked unavailable in the registry or no longer exists. It needs no start, is computed from the registry on every instance read, and takes precedence over the three above; it clears once another Java is chosen or a rescan finds the runtime again. An exit after the server has printed `Done (` is not attributed to the Java version. When the process exits on its own with code 0 (EULA not accepted, `stop` run in-game), the status is `stopped`; only a non-zero code means `crashed`.

`InstanceInfo.ready` means the server has printed the `Done (` startup line in this run and players can join; it is `false` while the status is `running` but the world is still loading, and also `false` while stopping or not running. It too exists only in memory.

Restarting after a crash is one setting for the whole panel (`/api/system/auto-restart`). With it on, when an instance becomes `crashed` the panel waits `delaySeconds` and starts it again through the same path as `POST /start`, reading the instance record again first. Only a run that had printed `Done (` is restarted, so a server that dies while starting is left alone; nothing is scheduled either while the panel is shutting down or the bound Java runtime is unavailable. Restarts are counted in a row for each instance: after `maxAttempts` of them, one more crash leaves the instance `crashed`. The count starts over only when a crash comes at least `windowMinutes` after the restarted server printed `Done (`, or when the user starts the instance; an earlier crash continues it, however long ago it began. With the defaults, a server that crashes every 4 minutes is restarted 3 times and then left alone, and one that crashes every 15 minutes is restarted every time. A restart that is waiting keeps the delay and the limit saved when the crash happened.

`InstanceInfo.autoRestartState` reports where this stands for the instance and is `null` when there is nothing to report. It exists only in memory, so it does not survive a panel restart. `attempt` counts the restarts in a row, starting at 1, and `max` is the limit that applied:

| `state` | Meaning | Other fields |
|---|---|---|
| `scheduled` | A restart is waiting | `at` (ISO time of the restart), `remainingMs` (milliseconds left when the response was produced, for counting down without comparing clocks) |
| `gaveUp` | The limit was reached; the instance stays crashed until the user starts it | `at`, `windowMinutes` |
| `failed` | The start was refused when the restart came due, or the restarted server crashed before it finished starting (`reason.key` is `server.instance.autoRestartDidNotStart`); it is not tried again | `at`, `reason` (a message `{ key, params }`, or plain text for an error that has none) |

A start is refused, for example, while a backup or restore holds the instance, or when the JVM arguments no longer pass validation. A waiting restart is dropped by `DELETE /pending-restart`, by a successful `POST /start` or `/restart`, by deleting the instance, by saving the setting with `enabled: false`, when a restore of the instance begins, and when the panel shuts down. A start that is refused leaves it waiting.

`addresses` of `local-network` lists this computer's LAN IPv4 addresses (excluding loopback, `169.254.*` and recognizable virtual interfaces, such as those of WSL, virtual machines, and virtual networking or proxy software; if every interface is virtual, they are listed as usual. At most 6, with `192.168.*` first). `port` comes from `server-port` in `server.properties`: the game default `25565` when absent or empty, and `null` when the value is not an integer in 1–65535 (frp and the virtual LAN read the port by the same rules). When `server-ip` is empty or `0.0.0.0`, all addresses are returned; when it equals one of them, only that one is returned; otherwise `serverIpBlocked` is `true` and `addresses` is empty. `publicIpv6` lists the public IPv6 addresses on physical interfaces (`2000::/3`, excluding 6to4, Teredo and the documentation range, at most 3), given only when `server-ip` is empty, `*` or `::`, and empty for `0.0.0.0` or a specific address; the panel does not distinguish stable addresses from the system's temporary ones, nor check whether the router lets traffic through.

`addresses` excludes public addresses on interfaces and the address of the instance's own multiplayer interface; a public IPv4 assigned directly to an interface goes into `publicIpv4` instead. `publicHost` is the public IP or domain the user entered with `PUT /api/system/public-host`, or `null` when not set. When `server-ip` equals an address in `addresses` or `publicIpv4`, only that one is returned and `serverIpBlocked` is `false`; when `server-ip` equals `publicHost` but no interface has that address (a common mistake on cloud servers), both `serverIpBlocked` and `serverIpIsUnboundPublicHost` are `true`. `panelPort` is the panel port and `platform` is the panel host's OS (`process.platform`); the UI uses them to tell the game port from the panel port and to show firewall instructions for the matching system.

The instance directory is always `instances/<id>` under the final data root. The final data root prefers `MYSTRY_DATA_DIR`, then `DATA_DIR`; create, deploy, import and start never accept another instance directory, and `jarFile` can only point to a relative file inside the instance root.

### Taking Over Legacy Instances

The panel does not access, delete or automatically move the external directory a legacy record points at. Before calling the takeover endpoint, you must:

1. Stop the instance and the panel service.
2. Copy the old external directory completely to `DATA_DIR/instances/<id>` with operating system tools.
3. Start the panel, and call with a JWT:

```http
POST /api/instances/<id>/adopt-managed-directory
Authorization: Bearer <token>
```

A successful takeover returns the updated `InstanceInfo`. The endpoint returns an error when the instance is running, the target directory is empty or the directory does not belong to the instance. Neither taking over nor deleting a panel instance touches the old external directory.

### `InstanceInfo` Field Summary

| Field | Type | Description |
|------|------|------|
| `id` | string | Instance ID |
| `name` | string | Display name |
| `coreType` | `vanilla \| paper \| fabric \| forge \| neoforge \| custom` | Core type |
| `mcVersion` | string \| null | MC version |
| `jarFile` | string | Jar name relative to the instance root; for Forge / NeoForge it is `@args:<relative path of the args file>`, and `@modloader` when the mod loader is not installed yet. `parseLaunchTarget` in the shared package parses these two markers |
| `jvmArgs` | string | JVM argument string |
| `requiresMigration` | boolean | Whether takeover still has to be completed through the legacy external instance flow |
| `nodeId` | string | Execution node ID; `local` for this machine |
| `javaRuntimeId` | string \| null | ID of the bound Java runtime; `null` uses the `java` on PATH |
| `status` | `InstanceStatus` | Run status |
| `acceptEula` | boolean | When `true`, `eula=true` is written on every start; when `false`, a start does not change `eula.txt` (an imported server may come with its own acceptance record), and only the save that changes it from `true` to `false` writes `eula=false` |
| `autoRestartState` | object \| null | The restart waiting after a crash, or why the latest crash was not restarted; see above |
| `createdAt` / `updatedAt` | string | ISO time |

`jvmArgs` goes through the same validation in `@mystry/shared` before saving and before starting: there must be exactly one `Xms` and one `Xmx`; unclosed quotes, duplicate or conflicting GC settings and `Xms > Xmx` are rejected, as are launch arguments the panel is responsible for, such as `-jar`, classpath, module launch, `@argfile` and `nogui`. When a request omits `jvmArgs`, create, deploy and import still use the compatible default `-Xms1G -Xmx2G`. Reading legacy instance text does not rewrite it, but an invalid legacy value must be fixed before the instance can be saved or started.

## Files and Config `/api/instances/:id`

| Method | Path | Description |
|------|------|------|
| GET | `/files?path=` | Lists a directory inside the instance root, `FileEntry[]`; the panel ownership marker `.mystry-instance.json` in the instance root is omitted from the list |
| GET | `/files/content?path=` | Reads text `{ path, content, binary }`. `binary` is `true` when the first 8 KiB contain a NUL byte; `content` is then lossy (bytes that are not UTF-8 become U+FFFD), so writing it back would break the file |
| PUT | `/files/content` | Body: `{ path, content }`. `content` may be up to `MAX_TEXT_FILE_BYTES` bytes of UTF-8. The body limit of this endpoint is sized so that any such content fits once escaped as JSON; it can exceed `MAX_JSON_BODY_BYTES` and is never below it |
| DELETE | `/files?path=` | Deletes a file or directory inside the instance root. It shares the per-instance lock with start, stop, restart and instance deletion: it waits for one of them in progress, and they wait until the delete has finished |
| POST | `/files/mkdir` | Body: `{ path }` |
| POST | `/files/rename` | Body: `{ from, to }` |
| GET | `/files/download?path=` | Binary stream; optional `ticket=` one-time download ticket; the response includes `Content-Disposition: attachment` |
| POST | `/files/download-ticket` | Body: `{ path }`; issues a ticket and pre-claims a download slot |
| GET | `/files/download-ticket/:ticket/status` | Queries the lifecycle status of a download ticket you own |
| DELETE | `/files/download-ticket/:ticket` | Cancels a download ticket you own that has not opened a stream |
| POST | `/files/upload?path=` | multipart, single file |
| GET | `/config/server.properties` | Key-value object; the numeric forms of `difficulty` and `gamemode` are converted to names (such as `1` → `easy`) |
| PUT | `/config/server.properties` | Body: `Record<string, string>`. `difficulty` and `gamemode` are submitted as names; numbers are written back when the file originally had numbers or the instance version is 1.13 or earlier. Non-ASCII characters are written as `\uXXXX` |

Every `path` is a **logical path relative to `DATA_DIR/instances/<id>`**; the server validates it and rejects `..` escapes, and these endpoints cannot reach files outside the instance root. Only regular files can be downloaded; `Content-Disposition` uses the basename only (with RFC 5987 `filename*`). A download without a ticket uses the Bearer JWT; for a native browser download, first call `POST .../download-ticket` with the Bearer JWT, then trigger the streaming download with `GET .../download?path=&ticket=` (this GET carries no Authorization header).

The issue lifetime of a download ticket is controlled by `FILE_DOWNLOAD_TICKET_TTL_SECONDS`, 60 seconds by default. On issue, the status is `reserved` and a download concurrency slot is pre-claimed; the native GET validates `instance` and `path` and atomically moves the ticket to `streaming`, and the end of the issue lifetime does not reclaim the slot of an opened stream. The status query returns `reserved`, `streaming`, `consumed`, `failed` or `expired`: a successful transfer is `consumed`; a read stream error, an aborted connection, a download idle timeout or a cancel is `failed`; and an issue lifetime that runs out before a stream opens is `expired`. `expired`, `consumed` and `failed` each keep a short-lived 60-second tombstone per owning user, so the status query can return the final state; after that, or without permission to query, it returns 404.

An authenticated `DELETE .../download-ticket/:ticket` cancels the ticket and immediately releases the pre-claimed slot, returning **204**, only when the ticket, the current user and the instance ID in the URL all match and the ticket is still `reserved`. Once it is `streaming`, neither the stream nor the slot is changed and it returns **409**; a nonexistent ticket or a mismatched owner or instance always returns **404**.

A request that would create a file or directory (saving to a new path, `mkdir`, the target of a rename, an upload) is refused with **400** when a new name contains a control character, and on Windows also when it contains one of `<>:"|?*`, ends with a dot or a space, or is a device name such as `CON` or `NUL` with or without an extension. Entries that already exist are not checked, so they can still be saved, renamed and deleted.

An upload over `MAX_UPLOAD_BYTES` returns **413**; full upload or download concurrency returns **429**. Related timeouts are in [Configuration](configuration.md).

## Instance Backups `/api/instances/:id/backups`

| Method | Path | Description |
|------|------|------|
| GET | `/backups` | `{ backups: BackupInfo[] }`, newest first by creation time |
| POST | `/backups` | One-click backup; returns `TaskInfo` (`type: 'backup'`), and on completion `result.backupId` is the new backup |
| POST | `/backups/upload` | multipart, single file; returns `BackupInfo` (`source: 'upload'`) after full verification passes |
| POST | `/backups/:backupId/restore` | Body: `{ backupCurrent: boolean }`; returns `TaskInfo` (`type: 'restore'`), and on completion `result.instanceRecordUpdated` says whether the instance's launch file, core type and version were updated to match the backup |
| DELETE | `/backups/:backupId` | Deletes the backup; returns **204** |
| POST | `/backups/:backupId/download-ticket` | Issues a one-time download ticket and pre-claims a download slot |
| GET | `/backups/:backupId/download?ticket=` | Streams the `.tar.gz`; `ticket` can be omitted in favor of the Bearer JWT |

A backup file is a gzip-compressed tar whose last entry, `.mystry-backup/manifest.json`, records each file's size and SHA-256. The backup covers every file under the instance directory `DATA_DIR/instances/<id>` except the panel's ownership marker and `session.lock` (locked by the JVM while running and recreated at startup); `panel.db` is not included either (users and instance settings are not in the backup). A backup is refused when the directory contains a symlink or directory junction.

- **Backup while running**: the panel sends `save-off` and `save-all flush`, waits for the server itself to print `Saved the game` (`Saved the world` on 1.12 and earlier, `System chat: Saved the game` on Paper 26.3; only the whole message after the log prefix counts, not player chat; up to 60 seconds), and sends `save-on` after packing completes. If the server starts, stops or crashes meanwhile, the backup is cancelled; an instance that is starting or stopping returns **409**.
- **Restore**: the server must be stopped, otherwise **409**. When `backupCurrent` is `true` (the UI default), a backup with `source: 'pre-restore'` is created first. The backup is first fully verified and extracted to `DATA_DIR/.mystry-staging/<taskId>/`, and the instance directory is replaced as a whole only after everything passes; if the replacement fails midway, the original directory is moved back. If the panel exits midway through the replacement, the next start automatically rolls it back or finishes it. After a successful replacement, if the launch file recorded in the manifest (a jar or a Forge `@args:` args file) exists in the restored directory, the instance's `jarFile`, `coreType` and `mcVersion` are set to the values in the manifest.
- **Verification**: absolute paths, `..`, links and special files, duplicate paths, panel-reserved files, files outside the manifest and files with a mismatched checksum are rejected; the entry count and total size reuse `MAX_EXISTING_IMPORT_ENTRIES` / `MAX_EXISTING_IMPORT_BYTES`.
- **Mutual exclusion**: during a backup or restore, starting, restarting, deleting and taking over the instance are refused (**409**); during a restore, writing, deleting, renaming and uploading instance files are refused as well (an upload is checked once more after it is received and before it is written to the instance directory, and a delete once more after it obtains the instance lock). A backup in use by a restore task cannot be deleted (**409**).
- The time limit for backup and restore tasks is `BACKUP_TASK_TIMEOUT_MS` (6 hours by default), and is not bound by `TASK_TIMEOUT_MS`.
- An upload over `MAX_BACKUP_UPLOAD_BYTES` returns **413**. Status queries and cancellation of download tickets reuse `/files/download-ticket/:ticket/status` and `DELETE /files/download-ticket/:ticket`.

`BackupInfo` fields: `id`, `instanceId`, `instanceName`, `source` (`manual` / `pre-restore` / `upload` / `scheduled`), `createdAt`, `sizeBytes` (archive size), `fileCount`, `contentBytes` (size after extraction), `coreType`, `mcVersion`, `wasRunning`, `sha256` (SHA-256 of the archive).

### Scheduled Backups `/api/instances/:id/backup-schedule`

| Method | Path | Description |
|------|------|------|
| GET | `/backup-schedule` | `BackupScheduleInfo`; until a schedule is saved it holds the defaults (off, `04:00`, keep `7`) |
| PUT | `/backup-schedule` | Body: `{ enabled: boolean, time: "HH:MM", keep: 1–365 }`, all three required; returns `BackupScheduleInfo`. A malformed body returns **400** |

Each instance has one daily schedule. `time` is a 24-hour time of day on the clock of the computer the panel runs on; `utcOffsetMinutes` in the response is that clock's current offset from UTC. The panel checks once a minute and queues a due backup as an ordinary `backup` task, so it also appears in `GET /api/tasks`; the backup it makes has `source: 'scheduled'`.

- **Due**: a day's backup is due from the scheduled time on. Turning the schedule on, or changing its time while it is on, counts from the next occurrence of that time. Days missed while the panel was not running, or the computer was asleep, are made up once after the next start. On the day daylight-saving time skips the scheduled time, the backup runs in the first minute after the gap; on the day the time occurs twice, it runs the first time only.
- **Deferred**: a scheduled backup is queued only while no other task is running or waiting, so at most one runs at a time. While the panel is busy with another task, or the instance is starting, stopping, or being backed up or restored, the backup waits for a later check and nothing is recorded.
- **Skipped**: when the server has not run and no file was changed through the panel since the previous scheduled backup, and that backup still exists, the day is skipped without a task. A restore counts as a change; changes made to the instance folder outside the panel are not seen.
- **Free space**: before packing, the disk that holds the backup directory must have at least the size of the instance's newest backup plus 256 MiB free. When it has less, the scheduled backups already beyond `keep` are deleted and the space is read again; if it is still short, or there was nothing to delete, the run fails. Nothing is checked when the instance has no backup yet, or when the platform cannot report free space.
- **Retention**: after a scheduled backup succeeds, the instance's `source: 'scheduled'` backups beyond the newest `keep` are deleted, oldest first. `keep` is the value saved at that moment, so a change made while the backup was being packed applies to that run. The backup just made is never among those deleted, even when the computer's clock was set back and it carries an earlier date than the others. Backups from other sources are never deleted automatically, and one in use by a restore task stays until a later run.
- **Failure**: a failed run is a failed `backup` task whose error names the instance, and `lastFailure` (`at`, `error`, `errorI18n`) keeps its reason until the next scheduled backup succeeds. It is not tried again until the next day, with one exception: a run cut short because the server started, stopped or crashed is tried again at the next check, up to three runs for one day. Each of those runs is still a failed task, and `lastFailure` is set only when the third is cut short too. A run cut short by the panel shutting down is not recorded and is made up after the next start.

`BackupScheduleInfo` fields: `enabled`, `time`, `keep`, `utcOffsetMinutes`, `lastBackupAt` (when the latest successful scheduled backup was taken, or `null`), `lastFailure` (or `null`). The schedule is deleted with its instance.

## Core Deploy and Import

| Method | Path | Description |
|------|------|------|
| GET | `/api/cores/:type/versions` | `type`: `vanilla \| paper \| fabric \| forge \| neoforge` |
| GET | `/api/cores/paper/:version/builds` | Paper build list |
| GET | `/api/cores/fabric/:version/loaders` | Fabric loaders + installers |
| GET | `/api/cores/forge/:version/loaders` | Forge loader list |
| GET | `/api/cores/neoforge/:version/loaders` | NeoForge loader list, newest builds first. `:version` is the Minecraft version number, such as `1.21.1` or `26.3` |
| POST | `/api/cores/deploy` | Body: `DeployCoreInput`; returns `TaskInfo` |
| GET | `/api/import/sources` | Lists the direct subdirectories of `DATA_DIR/imports` with their launch file detection results |
| POST | `/api/import/existing` | Body: `ImportExistingServerInput`; copies the handoff directory and returns `TaskInfo` |
| POST | `/api/import/previews` | multipart upload of a single ZIP; validates the central directory and returns `ImportPreviewInfo` |
| GET | `/api/import/previews/:id` | Restores the current signed-in user's preview awaiting confirmation |
| POST | `/api/import/previews/:id/confirm` | Body: `ConfirmZipImportInput`; confirms the config and returns `TaskInfo` |
| DELETE | `/api/import/previews/:id` | Cancels the preview and deletes the temp ZIP |
| POST | `/api/import/folder-uploads` | Body: `CreateFolderUploadInput`; starts a browser folder upload and returns `FolderUploadInfo` |
| POST | `/api/import/folder-uploads/:id/files` | multipart upload of a batch of files (a `path` field before each file); returns `FolderUploadInfo` |
| POST | `/api/import/folder-uploads/:id/complete` | Prechecks once everything is received; returns `FolderUploadInfo` with `check` |
| GET | `/api/import/folder-uploads/:id` | Restores the current signed-in user's upload |
| POST | `/api/import/folder-uploads/:id/confirm` | Body: `ConfirmZipImportInput`; confirms the config and returns `TaskInfo` |
| DELETE | `/api/import/folder-uploads/:id` | Cancels the upload and deletes the temp folder |
| GET | `/api/tasks/:id` | Queries task progress `TaskInfo` |
| GET | `/api/tasks` | Task center list, the latest 50 in descending creation time, `{ tasks: TaskInfo[] }` |

Deploy and import always write content into `DATA_DIR/instances/<id>` of the new instance, and accept neither a custom directory nor a Java executable path. Instances start with the `java` on PATH by default and can bind a currently available runtime from the registry through `javaRuntimeId`; the binding in a deploy request is also used for the Forge/NeoForge installer. Version fields such as Paper's `build` and Fabric / Forge / NeoForge's `loaderVersion` take the latest stable version when left empty; if the given version does not exist, the task fails and no other version is substituted.

### Handoff of Existing Servers on the Same Machine

`GET /api/import/sources` returns:

```json
{
  "sources": [
    {
      "id": "paper-survival",
      "launchTarget": "paper.jar",
      "coreType": "paper",
      "mcVersion": "1.20.4",
      "modifiedAt": "2026-08-02T10:00:00.000Z",
      "ready": true,
      "detectedJvmConfig": {
        "source": "user_jvm_args.txt",
        "raw": "-Xms1G\n-Xmx4G\n",
        "canonicalArgs": "-Xms1G -Xmx4G",
        "issues": []
      }
    }
  ],
  "importDir": "/opt/mystry/data/imports"
}
```

`id` is only a single-level directory name under `DATA_DIR/imports`, not a system path. `importDir` is the absolute path of the imports folder on the panel's computer, shown to the signed-in user only as the copy destination; the panel accepts no path submitted by the client. `coreType` is inferred from the launch file name (`paper`, `fabric`, `neoforge`, `forge`; `server.jar` and `minecraft_server*` are `vanilla`; the rest are `custom`). `mcVersion` is a `1.7`–`1.21.x` version number recognized from the launch file name or the Forge args directory name, and is omitted when unrecognized, when the core is `custom`, or for NeoForge.

In both kinds of import request, an omitted or `custom` `coreType` means auto-detect, and the panel's detection after copying or extraction applies; any other type is used as given. An empty `mcVersion` takes the recognized version, or stays empty when none is recognized. Example request to create a task:

```json
{
  "name": "Survival",
  "sourceId": "paper-survival",
  "coreType": "paper",
  "mcVersion": "1.20.1",
  "jvmArgs": "-Xms2G -Xmx4G",
  "acceptEula": true,
  "javaRuntimeId": null
}
```

Stop the original server before submitting. Pre-copy checks and limits are in [Copy from imports](user-guide.md#copy-from-imports). The source directory is never deleted, whether the task succeeds or fails; on failure the newly created, half-finished instance is cleaned up.

When a regular `eula.txt` in the directory root records acceptance, the source info includes `eulaAccepted: true` and Web hides the EULA checkbox. The import does not record it as `acceptEula`, so the panel leaves that file to the server and never rewrites it. When a regular `user_jvm_args.txt` exists in the directory root, the source info can include `detectedJvmConfig`. The file is at most 64 KiB; files in subdirectories are not read, links are not followed, and `.bat` / `.sh` are neither parsed nor executed. Once arguments are detected, Web automatically fills `canonicalArgs` into the JVM configurator and shows a notice; the user can cancel (restoring the previous arguments) or reapply, and only `jvmArgs` is sent on submit. When parsing fails, `canonicalArgs` is `null` and nothing is adopted. Each item of `issues[]` has a stable `code`, a `severity` and an English `message`; diagnostics produced by the shared JVM validation also carry `key` (`server.jvm.issue.*`) and `params` for the UI to translate.

### Two-Phase ZIP Import

The first step only uploads the file:

```http
POST /api/import/previews
Content-Type: multipart/form-data

file=<server.zip>
```

The server streams it into a controlled temp directory and validates the ZIP central directory, entry quotas, ZIP64, links/special files and duplicate entries; beyond that, it extracts only `user_jvm_args.txt` and `eula.txt` from the root or a single top-level directory, each up to 64 KiB. `eulaAccepted: true` is present only when that `eula.txt` plainly records acceptance: the last `eula` key has the value `true` (in any case, with nothing around it), and the file contains no backslash. A successful response:

```json
{
  "id": "an unguessable random preview ID",
  "fileName": "server.zip",
  "sizeBytes": 10485760,
  "expiresAt": "2026-08-11T12:30:00.000Z",
  "detectedJvmConfig": {
    "source": "user_jvm_args.txt",
    "raw": "-Xms1G\n-Xmx4G\n",
    "canonicalArgs": "-Xms1G -Xmx4G",
    "issues": []
  }
}
```

The second step confirms the config:

```json
{
  "name": "Survival",
  "coreType": "paper",
  "mcVersion": "1.21.1",
  "jvmArgs": "-Xms4G -Xmx4G -XX:+UseG1GC",
  "acceptEula": true,
  "javaRuntimeId": null
}
```

A preview ID is bound to the signed-in user: a non-owner or a nonexistent ID returns **404**, an expired one **410**, and one being confirmed or confirmed again **409**. Each user has at most one preview, and the global capacity is controlled by `MAX_IMPORT_PREVIEWS`; a new ZIP replaces the old preview only after its precheck succeeds. The preview is consumed only when the background task is queued successfully; a full task queue returns **429** and keeps the preview for a retry. The preview lifetime is controlled by `IMPORT_PREVIEW_TTL_SECONDS=1800` by default; cancel, expiry, panel shutdown or restart deletes the temp ZIP, and previews are neither written to the database nor restored across restarts.

A ZIP import can only go through the preview flow above; the old one-phase `POST /api/import` has been removed, and calling it returns **404**.

### Browser Folder Upload

The browser reads the server folder the user picked and sends the files to the panel in batches. The panel receives only the file contents and their relative paths within the folder, and neither receives nor records paths on the user's computer.

1. Start: `POST /api/import/folder-uploads`, Body `{ "folderName": "survival", "fileCount": 6210, "totalBytes": 2147483648 }`. `folderName` is for display only and cannot contain `/`, `\` or control characters. The file count and total size reuse `MAX_EXISTING_IMPORT_ENTRIES` / `MAX_EXISTING_IMPORT_BYTES` and return **413** when exceeded; insufficient free space on the data disk returns **507**.
2. Batched upload: `POST /api/import/folder-uploads/:id/files`, multipart; each file is preceded by a `path` field holding its relative path without the outermost folder name, separated by `/`. At most 500 files per request, and a session accepts only one batch at a time (otherwise **409**).
3. Precheck: `POST /api/import/folder-uploads/:id/complete`. The received file count and byte count must match what was declared at the start, otherwise **409**. `state` in the response becomes `ready`, and `check` has the same fields as the precheck result of an imports source (`launchTarget`, `coreType`, `mcVersion`, `ready`, `detectedJvmConfig`, `eulaAccepted`, `error` / `errorI18n`).
4. Confirm: `POST /api/import/folder-uploads/:id/confirm`, with the same Body as the ZIP confirm. Returns **409** when `check.ready` is `false`. The task renames the whole temp folder into `DATA_DIR/.mystry-staging/<taskId>/<instanceId>` (falling back to copying file by file when not on the same drive), then confirms the launch file, moves it atomically to `instances/<id>` and registers it.

Relative paths must be in plain form: empty segments, `.`, `..`, absolute paths, backslashes and control characters are rejected; on Windows `<>:"|?*`, a trailing dot or space, and reserved names such as `CON` and `NUL` are rejected as well; the root cannot contain the panel-reserved `.mystry-instance.json` and `.mystry-staging-marker.json`. The same path appearing twice, a file and a directory sharing a name, actual bytes exceeding what was declared, and a file without a preceding `path` field all return **400**. If any file in a batch fails, the whole session is voided and the temp folder deleted; the upload must start over, and resuming is not supported.

Uploaded files are written under `DATA_DIR/uploads/.tmp-folder-upload-<id>/`. A session is bound to the signed-in user: a non-owner or a nonexistent ID returns **404**, and an expired one **410**. Only one session is kept per user, and a new upload replaces an unconfirmed old session; the number of sessions that can exist globally at once reuses `MAX_IMPORT_PREVIEWS` (**429** when full). The session idle timeout reuses `IMPORT_PREVIEW_TTL_SECONDS` and restarts each time a batch is received or a precheck runs. Cancel, expiry and panel shutdown delete the temp folder; at startup the panel removes temp folders left over from the previous run by prefix. Sessions live only in memory and are not restored across restarts.

Batch upload requests are also subject to the global request rate limit (`RATE_LIMIT_MAX` per minute per route); a rate-limited batch has written no files yet, so Web waits a few seconds and resends the same batch while the page shows "Upload paused". If the panel answers **429** and disconnects before the request body is fully sent, the browser often reports only a network error, so Web first checks with `GET /api/import/folder-uploads/:id` that the session still exists and `receivedFiles` is unchanged before resending; if the session is gone (for example after a panel restart), it reports that the upload was interrupted.

Regular files in a ZIP support only the stored and Deflate compression methods; any other method makes the import task fail, and the half-finished instance is cleaned up.

### `TaskInfo` Status

| status | Meaning |
|--------|------|
| `pending` | Queued |
| `running` | Running |
| `completed` | Succeeded; `result` may contain `instanceId` |
| `failed` | Failed; `error` is the reason |

`message` and `error` are English text; `messageI18n` / `errorI18n` (`{ key, params }`), returned alongside, let the UI translate by language. Tasks created before the upgrade lack these two fields, and their `message` / `error` may be the original Chinese text, which is shown as is. To support this, the database adds the nullable columns `message_i18n` and `error_i18n` to the `tasks` table (automatically at startup; no manual migration needed).

A successfully submitted deploy or import returns a `pending` task even when no execution slot is free yet; a full queue returns **429**. Callers should keep polling `/api/tasks/:id` until `completed` or `failed`; a task fails if it runs longer than `TASK_TIMEOUT_MS` after it starts executing. Queued does not mean failed, so do not resubmit.

## Console WebSocket

First call `POST /api/instances/:id/console-ticket` with a JWT to get a one-time ticket:

```http
POST /api/instances/<id>/console-ticket
Authorization: Bearer <token>
```

Then connect: `ws://<host>:<port>/ws/console/:instanceId?ticket=<ticket>`. A ticket is valid for 60 seconds by default and can establish only one connection. After a password change or reset, unused tickets are voided and established connections are closed with close code 4401; see [Token Invalidation](#token-invalidation).

Limits on connection count, inbound message size, command length and send rate are set by `MAX_CONSOLE_*` and related variables in [Configuration](configuration.md); when a limit is exceeded, the server does not write to the instance's stdin. A connection that sends commands faster than the allowed rate is closed with close code 4429. A client that falls so far behind the output that the send buffer fills is closed with 4503; the browser reconnects and receives a fresh history snapshot.

### Server → Client Messages (JSON)

| type | Fields | Description |
|------|------|------|
| `history` | `data`, `status?` | History output on connect |
| `output` | `data` | A new log fragment |
| `status` | `status` | Status change |
| `error` | `data`, `code?`, `params?` | Error description: `data` is English text, and `code` / `params` are the translatable message key and params |

### Client → Server

```json
{ "type": "command", "data": "say hello" }
```

After a command is successfully written to the instance's stdin, the server appends `> command` as a line to that instance's console buffer and pushes it as an `output` frame (adding a line break first when the previous output chunk had none), so every connection, and later `history` frames, show the command that was sent. `POST /api/instances/:id/command`, and the `save-off` / `save-all flush` / `save-on` the panel sends automatically during a backup, are echoed the same way.

## Launcher Local Endpoints

`POST /api/launcher/shutdown` is called only by the local launcher `mdash` and does not use the sign-in JWT. The request must come from a loopback address and carry:

```http
X-Launcher-Token: <LAUNCHER_TOKEN>
```

A valid request returns **202**, with a response containing `accepted`, the number of running instances, the number of running/queued tasks, and whether shutdown is already in progress. An invalid token returns 401 and a non-local origin 403; when the current launch method provides no safe shutdown callback, the endpoint returns 503. The endpoint has its own rate limit; after sending the response, it begins stopping tasks, Minecraft instances, the HTTP service and the database.

The same conditions (a loopback origin plus `X-Launcher-Token`) apply to:

| Method | Path | Description |
|------|------|------|
| POST | `/api/launcher/reset-password` | Request body `{ password }`; resets the admin password |
| GET | `/api/launcher/remote-access` | Returns `RemoteAccessStatus` |
| PUT | `/api/launcher/remote-access/direct` | Request body `UpdateDirectAccessRequest`; toggles direct access |
| POST | `/api/launcher/remote-access/certificate` | Regenerates the certificate |

These endpoints serve the `reset-password` and `remote` commands of `mdash`. Requests arriving on the extra listeners (other devices) do not have a loopback source address and always get 403; connections arriving through the panel's built-in network land on a loopback address and are stopped by `X-Launcher-Token`.

## Multiplayer Tunneling `/api/frp`

The panel manages only a pinned version of the official `frpc` (`FRP_CLIENT_VERSION`). Users provide the address, port and token of their own frp server; requests cannot submit an executable path or raw config. The token is write-only and never returned; responses contain only `tokenSet`. Local forwarding is fixed to the instance's `server-port` on `127.0.0.1` and does not open the panel port.

| Method | Path | Description |
|------|------|------|
| GET | `/api/frp/runtime` | `{ version, installed, platformSupported, archive }`. `archive` is the official archive for this machine's platform, `{ name, sha256, url, maxBytes }`, or `null` when the platform is unsupported |
| POST | `/api/frp/runtime` | Downloads and verifies the pinned official client from GitHub; returns directly when already installed |
| POST | `/api/frp/runtime/upload` | multipart field `file`: uploads an official archive the user downloaded themselves (possibly from a mirror). Installed only when the SHA-256 matches `archive.sha256`, otherwise 400 `server.frp.uploadMismatch`; over `maxBytes` returns 413 |
| GET | `/api/frp/endpoints` | Tunnel server list. Without tokens |
| POST | `/api/frp/endpoints` | Create. Body: see `createFrpEndpointBodySchema` |
| PATCH | `/api/frp/endpoints/:id` | Update. An omitted `token` or an empty string means the token is unchanged. After success, enabled tunnels are resynced with the new config |
| DELETE | `/api/frp/endpoints/:id` | Delete. Returns **409** while an instance still has multiplayer enabled through it; disabled tunnel settings are cleared along with the endpoint |
| GET | `/api/instances/:id/tunnel` | The instance's multiplayer status `InstanceTunnel` |
| PUT | `/api/instances/:id/tunnel` | Saves, and starts or stops `frpc` according to the current instance status |
| GET | `/api/instances/:id/tunnel/friend-config` | The player config `friend-frpc.toml` for private modes. The file contains the token; give it only to players who are joining |

With `mode` `public`, players connect directly to the public port, and `remotePort` is required. `stcp` is relayed through the frp server, and `xtcp` punches a hole between the two clients; in these two modes, players run the official `frpc` with the downloaded config on their own computer, then connect to `127.0.0.1` locally. If `server-ip` points at one specific interface, the tunnel does not start. When the instance stops or crashes or the panel shuts down, the matching `frpc` exits. After a panel restart, a game process that has already exited is not restored; the instance has to be started again.

## Virtual LAN `/api/lan`

The panel manages only a pinned version of the official EasyTier (`EASYTIER_VERSION`). Once enabled, the instance joins its own dedicated virtual LAN, and friends join with a locked-down command the panel provides. Requests cannot submit an executable path, raw config or the network secret; the secret is generated by the panel and appears only in the instructions for friends, never in the status endpoint. Locally only the instance's `server-port` is allowed; the panel port is not opened, and UDP for voice and query is not forwarded.

| Method | Path | Description |
|------|------|------|
| GET | `/api/lan/runtime` | `{ version, installed, platformSupported, archive, needsAdmin, runsAsAdmin }`, with `archive` as above. `needsAdmin` is `true` only on Windows when the panel itself is not running as administrator (read from the integrity level in `whoami /groups`; the answer is kept for the life of the process, and a failed lookup is tried again), so EasyTier cannot create its virtual adapter. `runsAsAdmin` is `true` only on Windows when the panel is running as administrator, in which case the servers it starts run as administrator too. Both are `false` on other systems and when this cannot be determined. |
| POST | `/api/lan/runtime` | Downloads and verifies the pinned official client from GitHub; returns directly when already installed |
| POST | `/api/lan/runtime/upload` | multipart field `file`: uploads an official archive the user downloaded themselves. Installed only when the SHA-256 matches, otherwise 400 `server.lan.uploadMismatch` |
| GET | `/api/instances/:id/lan` | The instance's virtual LAN status `InstanceLan`. Without the network secret; includes `peers`, `useSharedPeers`, `sharedPeers`, `listenPort` and the non-blocking notice `warning` |
| PUT | `/api/instances/:id/lan` | Body `{ enabled, peers?, useSharedPeers? }`. At most 8 `peers`, each of which must be `tcp://`, `udp://`, `ws://`, `wss://` or `quic://` plus a host and port (ws/wss may have a trailing `/`); the server normalizes and deduplicates them, and omitted fields keep their values. Turning off shared peers with no custom peers returns 400 `server.lan.peersRequired` |
| GET | `/api/instances/:id/lan/friend` | Instructions for friends. Contains the network secret; share it only with the people you play with |

The panel-side EasyTier picks a random free port on every start and listens on both TCP and UDP (EasyTier automatically adds IPv6 on the same port), so that friends on IPv6 or the same LAN can connect directly; the friend side still does not listen. Connecting requires the network name and secret (`private_mode`), and the panel side does not relay for other networks. On Windows, before starting, the panel adds inbound allow rules named `MystryDashboard-LAN-<instance id>` (the game TCP port restricted to this instance's virtual IP; TCP and UDP on the listen port restricted to the easytier-core program the panel starts, falling back to no program restriction when the program-restricted rule cannot be added), and deletes them by name on stop, crash or panel shutdown; when they cannot be added, `warning` is `server.lan.firewallFailed`. Rules left behind by an abnormal panel exit are swept at the next panel start by the instance IDs this panel knows (those with a virtual LAN record or a `DATA_DIR/lan/<id>` work directory), and are also removed later on stop, when the virtual LAN is disabled or when the instance is deleted; rules are never deleted by the `MystryDashboard-LAN-` prefix, so another panel's rules are not removed.

While the game is not running, the client does not start, but the saved toggle and the virtual address it will use are still returned. If `server-ip` points at one specific interface, the virtual LAN does not start. When the instance stops or crashes or the panel shuts down, the matching EasyTier exits. On Windows, both the panel and the friend's command need administrator rights, or the virtual interface cannot be created. When creating it fails there, `detail` is `server.lan.needsAdminWindows`, whose message gives the steps: right-click `mdash.cmd`, choose Run as administrator, choose Restart the panel in the menu, then start the server again (restarting stops running servers).

## Nodes `/api/nodes`

Phase one guarantees only the local node `local`. Creating remote nodes is controlled by the shared constant `REMOTE_NODE_CREATION_ENABLED`, which is currently off.

| Method | Path | Description |
|------|------|------|
| GET | `/api/nodes` | Node list `NodeInfo[]` |
| GET | `/api/nodes/:id` | A single node |
| POST | `/api/nodes` | Creates a remote node (currently returns **403**) |
| PATCH | `/api/nodes/:id` | Rename |
| DELETE | `/api/nodes/:id` | Deletes a remote node (the local node cannot be deleted; refused while the node has instances) |
| POST | `/api/nodes/:id/secret/reset` | Resets the secret (currently returns **403**) |

The server rejects a non-local `nodeId` when an instance is created (remote execution is not open yet).

## Type Definitions

The full TypeScript definitions and request body JSON Schemas are in `packages/shared/src/index.ts` / `packages/shared/src/schemas.ts`.
