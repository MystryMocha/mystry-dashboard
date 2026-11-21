# Getting Started

**English** · [简体中文](getting-started.zh-CN.md)

First pick one way to run the panel. Once it has started, follow [Set Up Administrator](#set-up-administrator), which is the same for every option:

| Option | Best for | Environment and entry point |
|---|---|---|
| Portable build | Just using the panel | Windows/Linux x64, bundles Node.js, uses `mystryctl` |
| Source launcher | Building from source and starting/stopping everything in one place | Node.js ≥ 22, uses `PanelManager` |
| Manual development | Changing the frontend or backend code | Node.js ≥ 22, runs two development terminals |

With every option, you need to install the Java your server requires yourself. There is no portable package for macOS in this Preview. The configuration file differs by entry point; see the [configuration file comparison table](configuration.md). In these docs, `DATA_DIR/...` means the final data root, and `MYSTRY_DATA_DIR` takes priority over `DATA_DIR`.

Windows PowerShell uses `npm.cmd`. For the generic npm scripts below, use `npm` on Linux/macOS.

## Portable Build (Recommended for Most Users)

The portable package already contains Node.js, production dependencies and the build output. On Windows, extract it and double-click `mystryctl.cmd`. On Linux x64, extract it and run:

```bash
chmod +x mystryctl
./mystryctl start
```

You don't need to run `npm install`. Install a Java version that suits your target server first. You can check the default PATH runtime with `java -version`, or scan for and select another installed runtime in the panel. For the full platform list, verification, upgrades and limitations, see [Portable Preview](portable-release.md).

## Requirements for Running from Source

| Dependency | Requirement |
|------|------|
| Node.js | **≥ 22** (uses the built-in `node:sqlite`, so no native SQLite module needs compiling) |
| Java | Uses the `java` on PATH by default; the deploy page and instance settings let you select a local runtime that the panel has scanned and verified |
| Operating system | The source launcher supports Windows (`PanelManager.cmd`) and Linux / WSL (`PanelManager.sh`); the portable artifacts are built and smoke-tested separately on Windows x64 and Linux x64 |

The panel does not accept a hand-typed full Java path. First run `java -version` in the same user environment that runs the panel to check the default PATH. If you need a different installed Java, click **Rescan** on the deploy page or in the instance settings, then use the selector.

## One-Click Management on Windows (Recommended)

After you install Node.js 22 or later, double-click `PanelManager.cmd` in the repository root. It automatically:

1. Checks Node and npm.
2. Installs dependencies according to `package-lock.json`, and builds shared, server and web. It skips this when the source and lock file haven't changed.
3. Copies `.env.example` to `.env` if there is no `.env`.
4. Hands over to the cross-platform controller `mystryctl`, which generates random secrets that all differ from each other, checks Java, starts the panel in the background and opens your browser.

If dependency downloads are slow or fail, run `.\PanelManager.cmd mirror` to choose another npm download source. See [npm download source](configuration.md#npm-registry).

Double-clicking shows a menu. Its language follows your system (Chinese on a Chinese system, English otherwise; you can set it with `MYSTRY_LANG`, see [launcher language](configuration.md#launcher-language)). You can also run these directly:

```powershell
.\PanelManager.cmd start
.\PanelManager.cmd foreground
.\PanelManager.cmd stop
.\PanelManager.cmd restart
.\PanelManager.cmd rebuild
.\PanelManager.cmd mirror
.\PanelManager.cmd status
.\PanelManager.cmd logs
.\PanelManager.cmd open
.\PanelManager.cmd reset-password
.\PanelManager.cmd help
```

Start, stop, status and logs share one implementation with `PanelManager.sh` on Linux and `mystryctl` in the portable build. The only difference is that the configuration defaults to `.env` in the repository root (or the file set by `MYSTRY_CONFIG_PATH`, if you set it), and the data directory follows the `DATA_DIR` in that file. Logs are in `logs/` in the repository root.

A background stop or restart first cancels deploy/import tasks, then safely stops each running Minecraft instance one by one. Do not force-kill the Node process in Task Manager.

If a secret in your existing `.env` is not a 64-character hexadecimal string, PanelManager first backs up the original file to `launcher/config-backups/` under the data directory, then generates new valid secrets. Changing `JWT_SECRET` invalidates old sign-in tokens, but it does not delete the administrator, instances or Minecraft worlds.

## One-Click Source Management on Linux / WSL

Run these in the repository root:

```bash
chmod +x PanelManager.sh
./PanelManager.sh start
```

`PanelManager.sh` checks for Node.js 22, installs any missing dependencies according to the lock file and builds the source. It then hands over to the cross-platform controller `mystryctl` to generate the configuration, start the panel and stop it safely. By default it writes the configuration to `config/panel.env` and the data to `data/` in the repository. Both are ignored by Git.

If you want to keep WSL test data separate, use the same environment variables before every operation, including start, stop and status:

```bash
export MYSTRY_CONFIG_PATH="${HOME}/mystry-test/config/panel.env"
export MYSTRY_DATA_DIR="${HOME}/mystry-test"
./PanelManager.sh start
```

On the first run with an empty user database, it automatically generates random secrets and creates the administrator `admin` with a random 16-character password, which is shown only once in the window. Do not share the password or `panel.env` in chats, repositories or screenshots. The available commands are `start`, `foreground`, `stop`, `restart`, `rebuild`, `mirror`, `status`, `logs`, `open`, `reset-password` and `help`. `rebuild` safely stops the panel first, then reinstalls dependencies, builds and starts again, the same as `PanelManager.cmd rebuild` on Windows.

## Manual Install and First-Time Configuration

Run these in the repository root:

```bash
npm install
npm run build -w @mystry/shared
```

Copy the environment variable template only for the first-time configuration. If you already have a `.env`, keep it and check the required fields.

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

Edit `.env`. Generate and fill in `JWT_SECRET` and `SETUP_TOKEN` as described in [Required Settings for First Start](configuration.md#required-settings-for-first-start). `SETUP_TOKEN` is only used to set up the administrator. After you create the administrator, remove it from `.env` and restart the panel.

## Development Mode

You need to run the backend and the frontend at the same time (the frontend reaches the API through the Vite proxy).

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

Build all workspace packages in one go:

```bash
npm run build
```

Start the backend (it serves the static assets in `apps/web/dist`):

```bash
npm start
```

It listens on **http://127.0.0.1:3000** by default, with the frontend and backend on the same port.

## Set Up Administrator

Open the panel address in your browser (`http://127.0.0.1:3000` by default, or `http://127.0.0.1:5173` in manual development mode).

### Started with `mystryctl` or `PanelManager` (Recommended)

1. On the first run, the launcher has already created the `admin` account with a random 16-character password (shown once in the launcher window), so the browser opens directly to **Sign In**.
2. Sign in with `admin` and the password from the launcher window, then open **Panel Settings** (the gear at the bottom left) and click **Change Password** to set your own password (at least 12 characters).
3. If you forget the password later, run `reset-password` in a terminal while the panel is running to generate a new one.

### Started Manually (`npm start` / `npm run dev:server`)

1. With an empty user database, the page shows **Set Up Administrator**. In **Setup Token**, enter the `SETUP_TOKEN` from your configuration file (see [Configuration](configuration.md)). Do not share the token or configuration file.
2. Enter a username (2–64 characters after trimming whitespace) and a password (at least 12 characters, and no more than 72 bytes in UTF-8), then click **Create and Continue**.
3. Once the administrator is created, remove `SETUP_TOKEN` from your configuration file and restart the panel (`mystryctl` and `PanelManager` clean it up automatically). If an administrator already exists, the page shows **Sign In**; `SETUP_TOKEN` cannot be used as a sign-in password.

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

To open the panel on a phone or another computer, click **Other Devices** in the top bar. See [Open the Panel on Another Device](user-guide.md#open-the-panel-on-another-device). When the panel is installed on a server you reach over SSH, the first run asks once whether your own computer or phone may open the panel. You can also run `./PanelManager.sh remote on` (`./mystryctl remote on` in the portable build) at any time, then allow the panel port in your cloud provider's security group.

For detailed steps, see [Step-by-Step Tutorials](tutorials.md) and the [User Guide](user-guide.md).

## First-Time Checklist

1. Install a Java version that meets your server's requirements. You can check the default runtime with `java -version` in the panel's environment, or select a scanned runtime in the panel later.
2. Make sure `JWT_SECRET` and `SETUP_TOKEN` are set to different 64-character hexadecimal values. The launcher generates them automatically; for a manual run you fill them in yourself.
3. If you started with the launcher, sign in with the account shown in the window. In manual configuration mode, enter the **Setup Token**, a username and a password on the sign-in page to create the administrator, then remove `SETUP_TOKEN` and restart.
4. Create your first instance with **Quick Deploy** or **Import an Existing Server**. For a server you already have, follow [Upload a Folder](user-guide.md#upload-a-folder).
5. Start the server from the instance details, and view the logs in **Console**.
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
| Port in use | The panel port or the Minecraft server port conflicts | Change `PORT` for the panel port in the configuration file of your current entry point; change the game port in the instance's `server.properties`; in development mode, also update the Vite proxy target |

For more configuration, see [Configuration](configuration.md).
