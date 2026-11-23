# Development Guide

**English** · [简体中文](development.zh-CN.md)

## Before You Start

Read the [contributing guide](../CONTRIBUTING.md) first, then run `git status --short --branch` to confirm the current branch and existing changes. Use Node.js ≥ 22 and run commands from the repository root.

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
6. Update the [API reference](api.md), then check the contract and the real operation path end to end.

## Paths and Security

- Instance directory resolution: `apps/server/src/utils/path.ts` (`resolveDirFromRow`, etc.).
- File operations must go through the path validation in `file-service` to prevent directory traversal.

## Processes and Console

- The singleton `processManager` manages all instance processes.
- When extending multi-instance concurrency, note that `start` / `stop` already hold a state lock to avoid spawning twice.
- Console events: `output`, `status` (EventEmitter).

## Database

- Initialization: `initDb()` is called at startup in `index.ts`.
- Schema changes are versioned. The version is stored in `PRAGMA user_version`; `PANEL_DB_MIGRATIONS` in `apps/server/src/db.ts` lists every step in order, and `apps/server/src/db-migrations.ts` runs the pending ones at startup.
- To change the schema, append an entry with the next version number, and update the row types and queries in the same change:

  ```ts
  {
    version: 2,
    name: 'add instances.notes',
    up: (db) => db.exec('ALTER TABLE instances ADD COLUMN notes TEXT'),
  },
  ```

- Never edit, reorder or remove an entry that has been released: databases already past it will not run it again. The startup check rejects a list whose versions do not count up from 1 without gaps.
- An entry runs in one transaction together with the version update, so a throw or SQL error undoes the whole step and leaves the version as it was. `up` must not begin or end a transaction itself.
- A step that rebuilds a table (create the new table, copy the rows, drop the old one, rename) sets `disableForeignKeys: true`. The pragma has no effect inside a transaction, so the runner switches foreign keys off before the transaction and back on after it, and commits only if `PRAGMA foreign_key_check` finds nothing. Without the flag, dropping a referenced table deletes or rejects the rows that point to it.
- Cover each new entry in `apps/server/src/db-migrations.test.ts` with a database at the previous version that already holds data. Rehearse on copies only, never on a real `panel.db`.

## Code Style

- Match the existing files: ESM (`import`), TypeScript, and server files with the `.ts` suffix compiled to `.js`.
- Comments are written in English. Web UI text goes into the English, Simplified Chinese and Traditional Chinese string tables in `apps/web/src/i18n/`; the rules are in the [contributing guide](../CONTRIBUTING.md#user-facing-text).
- Avoid unrelated refactoring; prefer small, focused fixes.

## Checks and CI

- The lockfile records only official URLs. If your local npm is configured with a mirror, run `npm run lockfile:fix` after installing a new dependency.
- Full gate: `npm run verify`. When running it directly from a Windows PowerShell terminal, use `npm.cmd run verify`.
- Remote CI: the Quality Gate (`.github/workflows/quality.yml`) runs `npm ci` and `npm run verify` on both `ubuntu-latest` and `windows-2025` for every push to `main` and every pull request.

## Local Verification Checklist

Before committing or pushing, run the checks related to your change; the Quality Gate runs the full `npm run verify` on Linux and Windows for your pull request. To reproduce the gate locally, run `npm.cmd run verify`. The full gate does not include the production dependency audit; dependency changes and releases also need `npm.cmd run audit:production`. Choose the manual items below by the scope of the change and use separate test data; database drills use copies only. Passing automated checks is no substitute for verifying real interaction.

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
node scripts/portable/smoke-portable.mjs release/mystry-v0.2.0-preview.6-windows-x64.zip
```

`package-portable.mjs` downloads the pinned runtime from the official Node.js release site and verifies it against `SHASUMS256.txt`, creates a separate production dependency tree with `npm ci --omit=dev`, physically copies `@mystry/shared`, and rejects symlinks inside the package. Do not package directly from `node_modules` in the current repository.

`.github/workflows/portable-release.yml` creates the Release after both the Windows x64 and Linux x64 matrix jobs pass. Before a release, `npm run verify` and `npm run audit:production` must also pass; a missing signing key blocks a public Release. Maintenance operations and the data upgrade flow are in [Portable Preview](portable-release.md).

## Related Documents

- [Contributing guide](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [Portable Preview](portable-release.md)
