# Documentation

**English** · [简体中文](README.zh-CN.md)

Mystry Dashboard is a standalone web panel for Minecraft Java servers. It manages multiple server instances on your own machine.

## Read by Goal

| What you want to do | Start here | Further reading |
|---|---|---|
| Install and start the panel | [Getting Started](getting-started.md) | [Portable build: download, verify and upgrade](portable-release.md) |
| Create the first administrator or fix sign-in problems | [Set Up Administrator](getting-started.md#set-up-administrator) | [Startup and authentication troubleshooting](getting-started.md#troubleshooting) |
| Get your first server running | [Step-by-Step Tutorials](tutorials.md) | [User Guide](user-guide.md) |
| Import, configure or manage instances | [User Guide](user-guide.md) | [Backup and migration](tutorials.md#tutorial-8-backup-and-migration) |
| Let friends join your server | [Multiplayer](user-guide.md#multiplayer) | [Security policy](../SECURITY.md) (Chinese) |
| Change the listen address, secrets or resource limits | [Configuration](configuration.md) | [Security policy](../SECURITY.md) (Chinese) |
| Change the code or open a PR | [Development guide](development.md) (Chinese) | [Contributing guide](../CONTRIBUTING.md) (Chinese), [Verification matrix](ai/verification.md) (Chinese) |
| Integrate with the API or understand the implementation | [API reference](api.md) (Chinese) | [Architecture](architecture.md) (Chinese) |
| Design the interface or write interface copy | [Design system](design-system.md) | [Localization guide](localization.md) |
| Develop with AI assistance | [Project development rules](../CLAUDE.md) (Chinese) | [AI project knowledge base](ai/README.md) (Chinese) |

If this is your first time, read in this order: Getting Started → Step-by-Step Tutorials → User Guide.

## How the Docs Are Organized

- Root [README](../README.md): what the project is, what it can and can't do, and how to run it.
- Topic docs in this folder: the source of truth for user operations, configuration, the API and the development workflow.
- [AI knowledge base](ai/README.md) (Chinese): traceable implementation facts, architecture decisions, off-limits areas and how to check things.
- Historical records: they keep the conclusions and evidence from their time. They are not a list of current defects or release status.

## History and Community

| Document | Purpose |
|---|---|
| [Changelog](../CHANGELOG.md) (Chinese) | Version history |
| [Contributing guide](../CONTRIBUTING.md) (Chinese) | Conventions for issues, PRs and doc maintenance |
| [Security policy](../SECURITY.md) (Chinese) | Private vulnerability disclosure |
| [Code of conduct](../CODE_OF_CONDUCT.md) (Chinese) | Rules for taking part in the community |
| [License](../LICENSE) | MIT |

## Maintenance and Checks

Before you change a feature description, check the related source code, shared contracts, frontend entry points and tests. When configuration, routes, scripts or AI entry points change, update the [machine facts](ai/project-facts.json) too. For the doc change workflow, see the [change playbooks](ai/change-playbooks.md#文档与知识库) (Chinese).

Run these in the repository root:

```powershell
npm.cmd run knowledge:check
npm.cmd run knowledge:test
```

On Linux/macOS the script names are the same; replace `npm.cmd` with `npm`. The checker verifies the machine facts and that local Markdown link targets exist. It does not verify heading anchors, whether external links work, or real user flows. Before you commit, you must also run `npm.cmd run verify` as described in the [verification matrix](ai/verification.md) (Chinese).
