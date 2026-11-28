/**
 * Panel runtime info: readable only after sign-in; gives only the listen address, data directory, backup directory, config file path and text file limit, with no secrets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PanelInfo } from '@mystry/shared';

const JWT_SECRET = 'a'.repeat(64);
const SETUP_TOKEN = 'b'.repeat(64);
const LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.JWT_SECRET = JWT_SECRET;
process.env.SETUP_TOKEN = SETUP_TOKEN;
process.env.LAUNCHER_TOKEN = LAUNCHER_TOKEN;

test('panel runtime info: 401 when not signed in; after sign-in it returns the listen address and directories with no secrets in the response', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-panel-info-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  delete process.env.BACKUP_DIR;
  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const { config } = await import('../config.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    await app.close();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  assert.equal((await app.inject({ method: 'GET', url: '/api/system/panel-info' })).statusCode, 401);

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': SETUP_TOKEN },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const { token } = setup.json<{ token: string }>();

  const response = await app.inject({
    method: 'GET',
    url: '/api/system/panel-info',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  const info = response.json<PanelInfo>();
  assert.deepEqual(Object.keys(info).sort(), ['backupDir', 'configPath', 'dataDir', 'host', 'maxTextFileBytes', 'port']);
  assert.equal(info.maxTextFileBytes, config.maxTextFileBytes);
  assert.equal(info.host, config.host);
  assert.equal(info.port, config.port);
  assert.equal(info.dataDir, path.resolve(config.dataDir));
  assert.equal(info.backupDir, path.join(path.resolve(config.dataDir), 'backups'));
  assert.ok(path.isAbsolute(info.configPath));
  for (const secret of [JWT_SECRET, SETUP_TOKEN, LAUNCHER_TOKEN]) {
    assert.equal(response.body.includes(secret), false);
  }
});
