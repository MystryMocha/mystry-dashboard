# Development Guide

**English** · [简体中文](development.zh-CN.md)

## Before You Start

Read the [project development rules](../CLAUDE.md) first, then run `git status --short --branch` to confirm the current branch and existing changes. Use Node.js ≥ 22 and run commands from the repository root.

For the first run, complete [manual install and secret configuration](getting-started.md#manual-install-and-first-time-configuration), then run `npm.cmd run dev:server` and `npm.cmd run dev:web` separately. Use `npm.cmd` in Windows PowerShell; the `npm` examples below are for Linux/macOS and use the same script names.

The backend defaults to `http://127.0.0.1:3000` and the development UI to `http://127.0.0.1:5173`, with Vite proxying `/api` and `/ws`. If you change the backend port, also check `apps/web/vite.config.ts`.

```bash
npm install
npm run build -w @mystry/shared
```

To run the source as an integrated panel on Linux / WSL, use `mdash.sh` in the root. It checks for Node.js 22, installs missing dependencies from the lockfile, builds, and reuses the cross-platform safe lifecycle controller:

```bash
chmod +x mdash.sh
./mdash.sh start
```

The default config is `config/panel.env` and the data root is `data/` in the repository; neither should be committed. To isolate test data, set the same `MYSTRY_CONFIG_PATH` and `MYSTRY_DATA_DIR` before every start/stop/status command.

After changing `packages/shared`, rebuild shared so that server / web pick up the latest types.

Standalone type checking (no build output):

```bash
npm run build -w @mystry/shared
npm run typecheck
```

## Workspace Packages

### `@mystry/shared`

```bash
npm run build -w @mystry/shared
```

Output: `packages/shared/dist/`. Add fields shared by the frontend and backend here first; request body validation schemas live in `src/schemas.ts`, and routes reference them directly.

### `@mystry/server`

- Development: `npm run dev -w @mystry/server` (usually through `npm run dev:server` in the root)
- Build: `npm run build -w @mystry/server`
- Entry: `apps/server/src/index.ts`

### `@mystry/web`

- Development: `npm run dev -w @mystry/web`
- Build: `npm run build -w @mystry/web`
- Alias: `@` → `src/`

## Suggested Flow for Adding a REST Endpoint

1. If needed, add request / response types in `packages/shared`, and sync the matching JSON Schema in `schemas.ts`.
2. Implement the business logic in `apps/server/src/services/`.
3. Register the route in `apps/server/src/routes/`, attach `authenticate` if sign-in is required, and prefer importing the body schema from `@mystry/shared`.
4. Call it from `apps/web/src/api.ts` or a page.
5. Confirm the user-visible entry, loading state and error feedback; when adding a route module, update its registration in `apps/server/src/index.ts`.
6. Update the [API reference](api.md) and the related knowledge base, and check the contract and the real operation path against the [verification matrix](ai/verification.md).

## Paths and Security

- Instance directory resolution: `apps/server/src/utils/path.ts` (`resolveDirFromRow`, etc.).
- File operations must go through the path validation in `file-service` to prevent directory traversal.

## Processes and Console

- The singleton `processManager` manages all instance processes.
- When extending multi-instance concurrency, note that `start` / `stop` already hold a state lock to avoid spawning twice.
- Console events: `output`, `status` (EventEmitter).

## Database

- Initialization: `initDb()` is called at startup in `index.ts`.
- Schema changes: there is currently no migration framework; when changing a table, handle existing `panel.db` files manually or with a one-off migration script.

## Code Style

- Match the existing files: ESM (`import`), TypeScript, and server files with the `.ts` suffix compiled to `.js`.
- Comments are written in English. Web UI text goes into the English, Simplified Chinese and Traditional Chinese string tables in `apps/web/src/i18n/`; the rules are in the [contributing guide](../CONTRIBUTING.md#user-facing-text).
- Avoid unrelated refactoring; prefer small, focused fixes.

## AI Project Knowledge Base

- `CLAUDE.md` in the root is the mandatory entry for Claude Code; detailed material lives in `docs/ai/`.
- When routes, environment variables, workspaces, entry points or verification scripts change, `docs/ai/project-facts.json` must be synced.
- Current facts, plans, rejected options and historical failures must be recorded in separate layers; an old plan must not be treated as an implemented capability.
- Quick check: `npm run knowledge:check`; negative tests for the checker: `npm run knowledge:test`.
- The lockfile records only official URLs. If your local npm is configured with a mirror, run `npm run lockfile:fix` after installing a new dependency.
- Full gate: `npm run verify`. When running it directly from a Windows PowerShell terminal, use `npm.cmd run verify`.
- Remote CI: the Quality Gate (`.github/workflows/quality.yml`) runs `npm ci` and `npm run verify` on `ubuntu-latest` for every push to `main` and every pull request (see the [verification matrix](ai/verification.md)).

## Local Verification Checklist

Before committing, run the checks related to your change; before pushing, run the full `npm.cmd run verify`; the Quality Gate runs it again on your pull request. The full gate does not include the production dependency audit; dependency changes and releases also need `npm.cmd run audit:production`. Choose the manual items below by the scope of the change and use separate test data; database drills use copies only. Passing automated checks is no substitute for verifying real interaction.

- [ ] `npm run knowledge:check` and `npm run knowledge:test` report no errors
- [ ] `npm run test:smoke` after `npm run build -w @mystry/shared` (already included in `verify`; it does not start Minecraft or use `data/` in the repository)
- [ ] `npm run typecheck` reports no errors
- [ ] `GET /api/health` returns ok
- [ ] Sign-in / setup flow
- [ ] Create or deploy an instance and start it
- [ ] The WebSocket console shows output and accepts commands
- [ ] File listing, and reading and writing `server.properties`
- [ ] `npm run build` reports no errors, and `npm start` opens the integrated page

## Portable Package Development and Release

The portable tools are in `scripts/portable/`. Each archive must be assembled on a native runner of the same operating system and architecture, then verified by extracting the final archive:

```bash
npm run portable:test
npm run audit:production
npm run build
node scripts/portable/package-portable.mjs --platform win32 --arch x64 --output-dir release
node scripts/portable/smoke-portable.mjs release/mystry-v0.2.0-preview.5-windows-x64.zip
```

`package-portable.mjs` downloads the pinned runtime from the official Node.js release site and verifies it against `SHASUMS256.txt`, creates a separate production dependency tree with `npm ci --omit=dev`, physically copies `@mystry/shared`, and rejects symlinks inside the package. Do not package directly from `node_modules` in the current repository.

`.github/workflows/portable-release.yml` creates the Release after both the Windows x64 and Linux x64 matrix jobs pass. Before a release, `npm run verify` and `npm run audit:production` must also pass; a missing signing key blocks a public Release. Maintenance operations and the data upgrade flow are in [Portable Preview](portable-release.md).

## Related Documents

- [Contributing guide](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [Portable Preview](portable-release.md)
- [AI project knowledge base](ai/README.md)
