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
| Change the code or open a PR | [Development guide](development.md) | [Contributing guide](../CONTRIBUTING.md), [Verification matrix](ai/verification.md) (Chinese) |
| Integrate with the API or understand the implementation | [API reference](api.md) | [Architecture](architecture.md) |
| Design the UI or write UI copy | [Design system](design-system.md) | [Localization guide](localization.md) |
| Develop with AI assistance | [Project development rules](../CLAUDE.md) (Chinese) | [AI project knowledge base](ai/README.md) (Chinese) |

New users should read in this order: Getting Started → Step-by-Step Tutorials → User Guide.

## How the Docs Are Organized

- Root [README](../README.md): what the project is, its scope and limits, and how to run it.
- Topic docs in this folder: the source of truth for user operations, configuration, the API and the development workflow.
- [AI knowledge base](ai/README.md) (Chinese): traceable implementation facts, architecture decisions, off-limits areas and verification methods.
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

Before changing a feature description, check the related source code, shared contracts, frontend entry points and tests. When configuration, routes, scripts or AI entry points change, update the [machine facts](ai/project-facts.json) as well. The doc change workflow is in the [change playbooks](ai/change-playbooks.md#文档与知识库) (Chinese).

From the repository root:

```powershell
npm.cmd run knowledge:check
npm.cmd run knowledge:test
```

On Linux/macOS the script names are the same; use `npm` instead of `npm.cmd`. The checker verifies the machine facts and that local Markdown link targets exist, but not heading anchors, external links or real user flows. The full `npm run verify` runs in the Quality Gate on every pull request; choose other checks by the [verification matrix](ai/verification.md) (Chinese).
