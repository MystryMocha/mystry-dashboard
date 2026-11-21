# Contributing

**English** · [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in **Mystry Dashboard**. This guide explains how to take part in development and documentation.

## Code of Conduct

By taking part in this project you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## What Can I Contribute?

- Bug reports with steps to reproduce
- Feature suggestions (open an Issue to discuss first, to avoid duplicated work)
- Documentation and tutorial fixes, and translations
- Code fixes and small feature improvements

Before large architectural changes, new dependencies or breaking changes, open an Issue and agree on the direction with the maintainers.

## Development Environment

| Dependency | Requirement |
|------|------|
| Node.js | ≥ 22 |
| Java | For verifying instance start and stop locally (optional, but strongly recommended) |

First follow [Getting Started: Manual Install and First-Time Setup](docs/getting-started.md) to install dependencies and configure random secrets, then follow the [Development Guide](docs/development.md) to start the two development terminals. Copying `.env.example` without filling in the secrets is not enough to complete the first start.

On Windows PowerShell use `npm.cmd`, and run the in-repo manager with `.\mdash.cmd`; on Linux/macOS use `npm`.

For more detail see [docs/development.md](docs/development.md) and [docs/getting-started.md](docs/getting-started.md).

## Branches and Commits

1. Create a feature branch from the default branch, for example `fix/console-reconnect` or `docs/readme-typo`.
2. Keep changes focused: one PR solves one problem.
3. Write commit messages in English, briefly saying **why**, for example:
   - `fix: prevent path escape in zip import`
   - `docs: explain JWT setup for production`
4. New and changed code comments are written in **English**. Web UI text goes into the string tables in `apps/web/src/i18n/`, provided in English, Simplified Chinese and Traditional Chinese together (see "User-Facing Text" below).

## Code Conventions

- TypeScript + ESM; match the style of the surrounding files.
- When adding types shared by the frontend and backend, change `packages/shared` first, then build shared.
- Reads and writes involving instance paths must go through the existing path validation (see `apps/server/src/utils/path.ts` / `file-service`); do not join unvalidated paths yourself.
- Do not commit `.env`, `data/`, secrets or absolute paths from your machine.
- Avoid unrelated refactoring and reformatting the whole repo.

## User-Facing Text

The Web UI supports English (default), Simplified Chinese and Traditional Chinese. The rules:

- Strings are stored under keys named by meaning (such as `instance.status.running`) in `apps/web/src/i18n/en/<area>.ts`, with the same key added in `zh-CN/<area>.ts` and `zh-TW/<area>.ts`; type checking rejects missing or extra keys. Components get strings with `t()` from `useI18n()`, without inline strings and without splitting one sentence into several keys to concatenate.
- Status words, common actions and navigation names are defined once in `i18n/en/common.ts` and reused by every page, without inventing synonyms.
- English: titles, buttons, menus and tabs use Title Case; descriptions, hints and dialog body text use sentence case and end with a period; address the user as "you"; technical names (Paper, JVM, `server.properties`, etc.) are not translated. English is usually 30–60% longer than Chinese, so buttons and labels in a row need `white-space: nowrap` + `flex-shrink: 0`, and narrow screens should be checked so they are not squeezed into a vertical column.
- Traditional Chinese uses the wording customary in Taiwan and is not a character-by-character conversion of Simplified Chinese; see the glossary in `i18n/zh-TW/common.ts`.
- Numbers, dates and sizes use `useI18n().fmt` (based on `Intl`); do not hard-code `'zh-CN'`.
- Errors and task progress returned to users by the server use `server.*` message keys (`PanelError`, `panelErrorBody`, task `report(progress, { key, params })`): English templates live in `packages/shared/src/messages/<area>.ts`, and the Simplified and Traditional translations in `apps/web/src/i18n/zh-CN/server/` and `zh-TW/server/`. The server no longer writes Chinese messages; startup-time terminal logs are the exception.
- Explain facts and the next step; avoid promotional or soothing phrases. Error messages say what went wrong and what the user can do, and do not show internal field names (such as ticket, marker, staging) to users as is.

The unified Chinese terminology table and Chinese punctuation rules are in the [Chinese version of this guide](CONTRIBUTING.zh-CN.md#用户可见文案); per-language writing rules are in [docs/localization.md](docs/localization.md).

## Pull Request Checklist

Before opening a PR, confirm for yourself:

- [ ] `npm.cmd run verify` passes (use `npm run verify` on Linux/macOS)
- [ ] If the API changed, [docs/api.md](docs/api.md) and its Chinese copy are updated
- [ ] If configuration options changed, `.env.example` and [docs/configuration.md](docs/configuration.md) are updated
- [ ] The related flows were verified manually (sign-in / deploy / console / files, etc.)
- [ ] When configuration, routes, scripts or AI entry points change, `docs/ai/project-facts.json` is synced
- [ ] UI changes were verified along the real user path on desktop, narrow screens and neighboring entries
- [ ] The PR description separates implemented, verified, unverified and remaining risks

## Documentation Contributions

Find the right page through the [documentation hub](docs/README.md) and fix it in place; the Wiki only maintains navigation. Feature descriptions must be checked against the current source, and historical reviews and plans keep their dates and scope rather than being written as current conclusions. Documents that have both an English page (`X.md`) and a Chinese page (`X.zh-CN.md`) are updated together. Documentation checks and commit requirements are in the [verification matrix](docs/ai/verification.md).

## Reporting Issues

**Bug**: environment (OS / Node / Java versions), steps to reproduce, expected and actual behavior, and related logs (redacted as needed).

**Feature**: the use case, the expected behavior, and whether an alternative already exists.

Do not open public Issues for security problems; see [SECURITY.md](SECURITY.md).

## License

Contributed code is released under the [MIT License](LICENSE). By opening a PR you confirm you have the right to contribute the content under that license.
