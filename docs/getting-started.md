# Getting Started

**English** · [简体中文](getting-started.zh-CN.md)

First pick one way to run the panel. Once it has started, every option continues with [Set Up Administrator](#set-up-administrator):

| Option | Best for | Environment and entry point |
|---|---|---|
| Portable build | Using the panel without building it | Windows/Linux x64, bundles Node.js, uses `mdash` |
| Source launcher | Building from source, with one tool to start and stop | Node.js ≥ 22, uses `mdash.cmd` / `mdash.sh` |
| Manual development | Changing the frontend or backend code | Node.js ≥ 22, runs two development terminals |

No option bundles Java: use a Java you already have, or let the panel install Eclipse Temurin when the recommended version is missing. This Preview has no macOS portable package. The configuration file differs by entry point; see the [configuration file comparison table](configuration.md). In these docs, `DATA_DIR/...` means the final data root, and `MYSTRY_DATA_DIR` takes priority over `DATA_DIR`.

Run the generic npm scripts below with `npm.cmd` in Windows PowerShell and with `npm` on Linux/macOS.

## Portable Build (Recommended for Most Users)

The portable package contains Node.js, the production dependencies and the build output. On Windows, extract it and double-click `mdash.cmd`. On Linux x64, extract it and run:

```bash
chmod +x mdash
./mdash start
```

No `npm install` is needed. First install a Java version that suits your target server: check the default PATH runtime with `java -version`, or scan for and select another installed runtime in the panel. For the full platform list, verification, upgrades and limitations, see [Portable Preview](portable-release.md).

## Requirements for Running from Source

| Dependency | Requirement |
|------|------|
| Node.js | **≥ 22** (uses the built-in `node:sqlite`, so no native SQLite module needs compiling) |
| Java | The `java` on PATH by default; on the deploy page and in instance settings you can also select a local runtime the panel has scanned and verified |
| Operating system | The source launcher supports Windows (`mdash.cmd`) and Linux / WSL (`mdash.sh`); the portable artifacts are built and smoke-tested separately on Windows x64 and Linux x64 |

The panel does not accept a typed-in full Java path. To check the default PATH, run `java -version` in the same user environment that runs the panel. To use another installed Java, click **Rescan** on the deploy page or in the instance settings, then pick it in the selector.

## One-Click Management on Windows (Recommended)

With Node.js 22 or later installed, double-click `mdash.cmd` in the repository root. It automatically:

1. Checks Node and npm.
2. Installs dependencies from `package-lock.json` and builds shared, server and web, skipping this step when neither the source nor the lock file has changed.
3. Copies `.env.example` to `.env` if there is no `.env`.
4. Hands over to the cross-platform controller `mdash`, which generates distinct random secrets, checks Java, starts the panel in the background and opens your browser.

If dependency downloads are slow or fail, run `.\mdash.cmd mirror` to choose another npm download source; see [npm download source](configuration.md#npm-registry).

Double-clicking opens a menu in your system language (Chinese on a Chinese system, English otherwise; set it with `MYSTRY_LANG`, see [launcher language](configuration.md#launcher-language)). You can also run the commands directly:

```powershell
.\mdash.cmd start
.\mdash.cmd foreground
.\mdash.cmd stop
.\mdash.cmd restart
.\mdash.cmd rebuild
.\mdash.cmd mirror
.\mdash.cmd status
.\mdash.cmd logs
.\mdash.cmd open
.\mdash.cmd reset-password
.\mdash.cmd help
```

Start, stop, status and logs share one implementation with `mdash.sh` on Linux and `mdash` in the portable build. The only differences: the configuration defaults to `.env` in the repository root (or the file named by `MYSTRY_CONFIG_PATH`, if set), and the data directory follows that file's `DATA_DIR`. Logs go to `logs/` in the repository root.

A background stop or restart first cancels deploy/import tasks, then stops each running Minecraft instance safely, one at a time. Do not force-kill the Node process in Task Manager.

After you choose on the Multiplayer page to start the panel as administrator (for the virtual LAN), `start`, `restart` and `foreground` first ask Windows for administrator rights and continue in an administrator window. When the prompt is declined, the panel starts without them. The choice is kept in `launcher/admin.json` under the data directory, and **Stop Asking** on the same page turns it off. This needs the default `.env` and data directory: with `MYSTRY_CONFIG_PATH`, `MYSTRY_DATA_DIR` or `DATA_DIR` set in the environment, the administrator window would not find them, so the launcher starts without asking.

If a secret in your existing `.env` is not a 64-character hexadecimal string, the source launcher first backs up the original file to `launcher/config-backups/` under the data directory, then generates new valid secrets. Changing `JWT_SECRET` invalidates old sign-in tokens but does not delete the administrator, instances or Minecraft worlds.

## One-Click Source Management on Linux / WSL

Run these in the repository root:

```bash
chmod +x mdash.sh
./mdash.sh start
```

`mdash.sh` checks for Node.js 22, installs missing dependencies from the lock file and builds the source, then hands over to the cross-platform controller `mdash` to generate the configuration, start the panel and stop it safely. By default the configuration goes to `config/panel.env` and the data to `data/` in the repository; Git ignores both.

To keep WSL test data separate, set the same environment variables before every operation, including start, stop and status:

```bash
export MYSTRY_CONFIG_PATH="${HOME}/mystry-test/config/panel.env"
export MYSTRY_DATA_DIR="${HOME}/mystry-test"
./mdash.sh start
```

On the first run with an empty user database, it generates random secrets and creates the administrator `admin` with a random 16-character password, shown only once in the window. Do not share the password or `panel.env` in chats, repositories or screenshots. The available commands are `start`, `foreground`, `stop`, `restart`, `rebuild`, `mirror`, `status`, `logs`, `open`, `reset-password` and `help`. `rebuild` stops the panel safely, then reinstalls dependencies, builds and starts it again, the same as `mdash.cmd rebuild` on Windows.

## Manual Install and First-Time Configuration

Run these in the repository root:

```bash
npm install
npm run build -w @mystry/shared
```

Copy the environment variable template only on first-time configuration. If `.env` already exists, keep it and check the required fields.

Windows PowerShell:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

Linux/macOS:

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
```

Edit `.env` and fill in `JWT_SECRET` and `SETUP_TOKEN`, generated as described in [Required Settings for First Start](configuration.md#required-settings-for-first-start). `SETUP_TOKEN` is used only to set up the administrator; once the administrator exists, remove it from `.env` and restart the panel.

## Development Mode

Run the backend and the frontend at the same time (the frontend reaches the API through the Vite proxy).

**Terminal 1 — backend** (default `http://127.0.0.1:3000`):

```bash
npm run dev:server
```

**Terminal 2 — frontend** (default `http://127.0.0.1:5173`):

```bash
npm run dev:web
```

Open **http://127.0.0.1:5173** in your browser, then follow [Set Up Administrator](#set-up-administrator) below to finish the first start.

## Production Deployment

Build all workspace packages at once:

```bash
npm run build
```

Start the backend (it serves the static assets in `apps/web/dist`):

```bash
npm start
```

It listens on **http://127.0.0.1:3000** by default; the frontend and backend share that port.

## Set Up Administrator

Open the panel address in your browser (`http://127.0.0.1:3000` by default, or `http://127.0.0.1:5173` in manual development mode).

### Started with `mdash` (Recommended)

1. On the first run, the launcher has already created the `admin` account with a random 16-character password (shown once in the launcher window), so the browser opens directly to **Sign In**.
2. Sign in with `admin` and the password from the launcher window, then open **Panel Settings** (the gear at the bottom left) and click **Change Password** to set your own password (at least 12 characters).
3. If you forget the password later, run `reset-password` in a terminal while the panel is running to generate a new one.

### Started Manually (`npm start` / `npm run dev:server`)

1. With an empty user database, the page shows **Set Up Administrator**. In **Setup Token**, enter the `SETUP_TOKEN` from your configuration file (see [Configuration](configuration.md)). Do not share the token or configuration file.
2. Enter a username (2–64 characters after trimming whitespace) and a password (at least 12 characters, and no more than 72 bytes in UTF-8), then click **Create and Continue**.
3. Once the administrator is created, remove `SETUP_TOKEN` from your configuration file and restart the panel (`mdash` cleans it up automatically). If an administrator already exists, the page shows **Sign In**; `SETUP_TOKEN` cannot be used as a sign-in password.

Once you see the **Instances** page, follow [Step-by-Step Tutorials: Your First Server](tutorials.md#tutorial-1-your-first-server-paper-recommended) to deploy an instance, then start the Minecraft server.

## Common npm Scripts

| Command | What it does |
|------|------|
| `npm run dev:server` | Backend development with hot reload (`@mystry/server`) |
| `npm run dev:web` | Frontend Vite development server (`@mystry/web`) |
| `npm run build` | Builds shared → server → web |
| `npm run portable:test` | Verifies the portable controller and the release helper scripts |
| `npm run audit:production` | Checks production dependencies against the official registry and blocks on high / critical |
| `npm start` | Runs the production backend |

## Five-Minute Quick Path

| Step | What to do | Where |
|------|--------|--------|
| 1 | Prepare the configuration for your chosen entry point, create the administrator and sign in | Launcher messages or the current configuration file, sign-in page |
| 2 | Deploy Paper (or import an existing server) | **Quick Deploy** / **Import Server** in the sidebar |
| 3 | Click **Start** | Instance details or the **Instances** page |
| 4 | Wait for `Done` to appear in the console | Instance → **Console** |
| 5 | Add the server `127.0.0.1` in the game | Minecraft client |

To open the panel on a phone or another computer, click **Other Devices** in the top bar; see [Open the Panel on Another Device](user-guide.md#open-the-panel-on-another-device). If the panel runs on a server you reach over SSH, the first run asks once whether your own computer or phone may open the panel. You can also run `./mdash.sh remote on` (`./mdash remote on` in the portable build) at any time, then allow the panel port in your cloud provider's security group.

For detailed steps, see [Step-by-Step Tutorials](tutorials.md) and the [User Guide](user-guide.md).

## First-Time Checklist

1. Install a Java version that meets your server's requirements. Check the default runtime with `java -version` in the panel's environment, or select a scanned runtime in the panel later.
2. Make sure `JWT_SECRET` and `SETUP_TOKEN` are set to different 64-character hexadecimal values. The launcher generates them automatically; for a manual run, fill them in yourself.
3. If you started with the launcher, sign in with the account shown in the window. In manual configuration mode, enter the **Setup Token**, a username and a password on the sign-in page to create the administrator, then remove `SETUP_TOKEN` and restart.
4. Create your first instance with **Quick Deploy** or **Import an Existing Server**. To bring in a server you already have, follow [Upload a Folder](user-guide.md#upload-a-folder).
5. Start the server from the instance details and view the logs in **Console**.
6. To change the port, difficulty and so on: Instance → **Properties** → save, then **restart**.

## Troubleshooting

| Symptom | Possible cause | What to do |
|------|----------|------|
| The panel fails to start and mentions secrets | Not configured, or not in 64-character hexadecimal format | Generate separate random values for `JWT_SECRET` and for the `SETUP_TOKEN` needed on first start |
| Setup returns 401 | The setup token is missing or doesn't match the current configuration | Enter the `SETUP_TOKEN` from the current configuration file on the page |
| Setup returns 409 | The administrator has already been created | Refresh the page and sign in with the existing account |
| Frontend gets 401 | Not signed in, or the token has expired | Sign in again |
| An instance fails to start | The jar doesn't exist, or the default PATH / bound Java runtime is unavailable or the wrong version | Check the instance root directory, the runtime status in the instance settings and the console log |
| Deployment times out | The network can't reach the Mojang / Paper / Fabric APIs, or the task exceeded its execution timeout | Check your firewall, proxy, the failure reason in the **Task Center** and the related timeout settings |
| Port in use | The panel port or the Minecraft server port conflicts | Panel port: change `PORT` in your current entry point's configuration file. Game port: change it in the instance's `server.properties`. In development mode, also update the Vite proxy target |

For more configuration, see [Configuration](configuration.md).
