# Documentation

**English** · [简体中文](README.zh-CN.md)

Mystry Dashboard is a self-hosted game server panel, now supporting Minecraft: Java Edition. It manages multiple server instances on the machine it runs on.

## Read by Goal

| What you want to do | Start here | Further reading |
|---|---|---|
| Install and start the panel | [Getting Started](getting-started.md) | [Portable build: download, verify and upgrade](portable-release.md) |
| Create the first administrator or fix sign-in problems | [Set Up Administrator](getting-started.md#set-up-administrator) | [Startup and authentication troubleshooting](getting-started.md#troubleshooting) |
| Get your first server running | [Step-by-Step Tutorials](tutorials.md) | [User Guide](user-guide.md) |
| Import, configure or manage instances | [User Guide](user-guide.md) | [Backup and migration](tutorials.md#tutorial-8-backup-and-migration) |
| Let friends join your server | [Multiplayer](user-guide.md#multiplayer) | [Security policy](../SECURITY.md) |
| Change the listen address, secrets or resource limits | [Configuration](configuration.md) | [Security policy](../SECURITY.md) |
| Change the code or open a PR | [Development guide](development.md) | [Contributing guide](../CONTRIBUTING.md) |
| Integrate with the API or understand the implementation | [API reference](api.md) | [Architecture](architecture.md) |
| Design the UI or write UI copy | [Design system](design-system.md) | [Localization guide](localization.md) |

New users should read in this order: Getting Started → Step-by-Step Tutorials → User Guide.

## How the Docs Are Organized

- Root [README](../README.md): what the project is, its scope and limits, and how to run it.
- Topic docs in this folder: the source of truth for user operations, configuration, the API and the development workflow.
- Historical records: conclusions and evidence as of their date, not a list of current defects or release status.

## History and Community

| Document | Purpose |
|---|---|
| [Changelog](../CHANGELOG.md) | Version history |
| [Contributing guide](../CONTRIBUTING.md) | Conventions for issues, PRs and doc maintenance |
| [Security policy](../SECURITY.md) | Private vulnerability disclosure |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Community participation rules |
| [License](../LICENSE) | MIT |

## Maintenance and Checks

Before changing a feature description, check the related source code, shared contracts, frontend entry points and tests. Keep each procedure and default in one document and link to it from the others. The full `npm run verify` runs in the Quality Gate on every pull request; the checks to run before that are in the [development guide](development.md#local-verification-checklist).
