# Mystry Dashboard

**English** · [简体中文](README.zh-CN.md)

A self-hosted web panel for running game servers on your own machine. Start and stop servers, watch the live console, edit files and settings, deploy a new server in a few clicks, and back it all up, from any browser.

The first public preview supports **Minecraft: Java Edition** servers. Mystry Dashboard is a standalone Node.js app, not a client mod: you don't need Fabric or Forge to run the panel itself.

[Quick start](#quick-start) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md)

> **Preview software.** The current version is `0.2.0-preview.3`. Expect rough edges, and read [Scope and limitations](#scope-and-limitations) before relying on it.

## Features

| Area | What you can do |
|---|---|
| Instances | Create, start, stop, restart and delete multiple servers on one machine. Restart, force stop and delete ask for confirmation. |
| Console | Live server output with log-level colouring, send commands, and automatic reconnect after a dropped connection. |
| Files and config | Upload, stream downloads, edit text files, rename, and edit `server.properties` through a grouped form. |
| Quick deploy | Deploy Vanilla, Paper, Fabric, Forge or NeoForge. Paper and the latest stable version are preselected. |
| Import | Upload a ZIP (checked before import) or copy in an existing server folder from the same machine. The original folder is left untouched. |
| Backups | One-click backup of a whole server folder, even while it's running. Download, upload, delete and restore backups; a restore backs up the current files first by default. |
| Multiplayer | Let friends outside your network join a server, through a virtual LAN (no public IP or account needed) or your own frp server. Only the game port is opened, never the panel. |
| Java and JVM | Detect installed Java runtimes, get a warning when the Java version doesn't match the Minecraft version, and set memory with presets (including G1 and Aikar's flags) or custom arguments. |
| Tasks and monitoring | A task center tracks deploys, imports and backups. The overview shows host CPU, memory and disk, plus CPU and memory for each server process. |
| Interface | First-run admin setup and JWT sign-in. Apple-style design with auto, light and dark appearance, five accent colours, and layouts for phones and tablets. |
| Languages | English (default), Simplified Chinese and Traditional Chinese, with automatic detection from your browser. Server errors and task progress are translated too. |

### Supported games

| Game | Status |
|---|---|
| Minecraft: Java Edition | Supported in the preview |
| Left 4 Dead 2 | Planned |

## Quick start

Pick how you want to run it, then [sign in for the first time](docs/getting-started.md#set-up-administrator).

| Option | Requirements | How |
|---|---|---|
| Portable preview | Windows x64 or Linux x64. Node.js is bundled. | [Download, verify and start](docs/portable-release.md) |
| Windows, from source | Node.js 22 or later | Double-click `PanelManager.cmd` in the repository root |
| Linux / WSL, from source | Node.js 22 or later | See the commands below |
| Manual development | Node.js 22 or later, two terminals | [Development guide](docs/development.md) |

Windows PowerShell:

```powershell
.\PanelManager.cmd start
```

Linux / WSL:

```bash
chmod +x PanelManager.sh
./PanelManager.sh start
```

The source launcher checks your environment, installs dependencies, generates a config file with random secrets, then builds and starts the panel. Open `http://127.0.0.1:3000` in your browser. During manual development, the Vite dev server runs at `http://127.0.0.1:5173`.

Launcher commands: `start`, `foreground`, `stop`, `restart`, `rebuild` (source only), `status`, `logs`, `open`, `reset-password`, `mirror` (source only) and `help`. Run without a command, `PanelManager.cmd` opens an interactive menu, `mystryctl` starts the panel in the background and shows its logs, and `PanelManager.sh` starts the panel.

**Java is not included.** Install the Java version your Minecraft server needs. By default a server uses the `java` on the panel's `PATH`, or you can pick a runtime the panel has detected and verified.

| Minecraft version | Recommended Java |
|---|---|
| 26.1 and later | 25 |
| 1.20.5 to 1.21.x | 21 |
| 1.17 to 1.20.4 | 17 |
| 1.16.5 and earlier | 8 |

**Slow dependency downloads?** The source launchers install dependencies with npm. Run `.\PanelManager.cmd mirror` or `./PanelManager.sh mirror` to choose a download source: npm's own configuration (the default), the official registry, or a mainland China mirror (npmmirror, Tencent Cloud or Huawei Cloud). See [npm download source](docs/configuration.md#npm-registry). Portable packages bundle their dependencies, so they don't need this.

### Portable preview

The release workflow builds portable packages for Windows x64 and Linux x64. Each one bundles Node.js, production dependencies and the built panel, and ships with SHA-256 checksums, a GPG signature and an SBOM. Check the project's Releases page for what is actually published. Platform notes, verification and upgrade steps are in the [portable release guide](docs/portable-release.md).

### Production build from source

After installing dependencies and setting up secrets (see [getting started](docs/getting-started.md)):

```bash
npm run build
npm start
```

On Windows PowerShell, use `npm.cmd` instead of `npm`. The server also serves the built web UI.

## Configuration

Which config file the panel reads depends on how you run it:

| How you run it | Config file |
|---|---|
| Portable package (`mystryctl`) | `config/panel.env` in the package folder |
| Linux / WSL, from source (`PanelManager.sh`) | `config/panel.env` in the repository |
| Windows, from source (`PanelManager.cmd`) | `.env` in the repository root |
| Manual (`npm run dev:server`, `npm start`) | `.env` in the repository root |

The launchers create the file and generate its secrets for you. For manual setup, copy [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Listen address |
| `MYSTRY_DATA_DIR` or `DATA_DIR` | `data` | Data root (`MYSTRY_DATA_DIR` wins if both are set) |
| `BACKUP_DIR` | `DATA_DIR/backups` | Where backups are stored |
| `JWT_SECRET`, `SETUP_TOKEN`, `LAUNCHER_TOKEN` | generated by the launcher | Three different 64-character hex secrets |

Upload sizes, timeouts, concurrency and other limits are all configurable. The full list is in [`.env.example`](.env.example) and the [configuration guide](docs/configuration.md).

## Scope and limitations

- Only the built-in local node (`local`) is available. Remote agents and remote nodes are not enabled yet.
- Each server lives in `instances/<id>` under the data root. The panel does not browse the rest of your disk or bind to outside folders.
- To import a server that's already on the machine, stop it and copy it into the data directory's `imports/` folder first. See [import from a local folder](docs/user-guide.md#import-from-a-local-folder).
- Tasks can queue. If the panel restarts, unfinished tasks are marked as failed and do not resume.
- Backups cover one server folder at a time. There are no scheduled backups or retention rules yet, and the panel database (`panel.db`) is not included. See [backup and migration](docs/tutorials.md#tutorial-8-backup-and-migration).
- Multiplayer has a few requirements. On Windows, the virtual LAN only works if you start the panel as administrator, and your friends must run their command as administrator too. If a direct connection fails, traffic is relayed through shared community nodes, encrypted with the network key. frp needs a server of your own. Anyone with the network key or the friend config can reach that game port, so share them only with people you trust. See [multiplayer](docs/user-guide.md#multiplayer).
- There is one admin account. Sessions can't be listed or revoked, and there is no 2FA or role system yet.

## Security

The panel listens on `127.0.0.1` only by default. It can read and write server files and run processes, so read the [security policy](SECURITY.md) and the [configuration guide](docs/configuration.md) before exposing it to a network. Never commit `.env`, `config/panel.env`, other secrets or the `data/` folder. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Project structure

| Path | Contents |
|---|---|
| `apps/server/` | Fastify 5 API, `node:sqlite`, process, file, backup and task services |
| `apps/web/` | React 19, Vite 6, React Router 6 and xterm.js |
| `packages/shared/` | Types, JSON Schemas and server messages shared by both apps |
| `scripts/` | Launchers, checks and portable packaging |
| `docs/` | User docs, development reference and the AI knowledge base |

Start with the [development guide](docs/development.md), then the [API reference](docs/api.md) and [architecture](docs/architecture.md). Run the full check suite with `npm run verify`. AI-assisted contributors should read [CLAUDE.md](CLAUDE.md) first.

> The detailed docs under `docs/` are currently written in Chinese.

## Roadmap

- Public Minecraft preview with portable Windows and Linux builds
- Left 4 Dead 2 server support

See the [changelog](CHANGELOG.md) for what has shipped.

## Contributing

Issues, pull requests and doc fixes are welcome. Please read the [contributing guide](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md) first.

## License

[MIT](LICENSE). Minecraft is a trademark of Microsoft / Mojang. This project is not affiliated with Mojang Studios or Microsoft.
