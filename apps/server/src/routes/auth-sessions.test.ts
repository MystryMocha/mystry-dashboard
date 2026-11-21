/**
 * Session invalidation regression: after a password change or a local password reset, previously issued JWTs, unused console / download tickets
 * and open console connections are invalidated immediately; a legacy users table (without the token version column) is upgraded compatibly at startup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import type { ChangePasswordResult } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

test('修改或重置密码后旧令牌、ticket 和控制台连接立即失效', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-auth-sessions-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;

  // The users table in 0.2.0-preview.3 and earlier has no token_version and already contains one admin.
  const legacyDb = new DatabaseSync(path.join(dataRoot, 'panel.db'));
  legacyDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacyDb
    .prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run('legacy-admin', 'admin', bcrypt.hashSync('password1234', 4), new Date().toISOString());
  legacyDb.close();

  const { buildApp } = await import('../index.js');
  const { getDb, closeDb } = await import('../db.js');
  const { consumeConsoleTicket, issueConsoleTicket } = await import('../services/console-ticket-service.js');
  const {
    getDownloadTicketStatus,
    reserveDownloadTicket,
    resetDownloadTicketsForTests,
  } = await import('../services/download-ticket-service.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    resetDownloadTicketsForTests();
    await app.close();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  // Compatible upgrade: the column is added and existing users start at version 0; the existing password is unaffected.
  const userColumns = getDb().prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  assert.ok(userColumns.some((column) => column.name === 'token_version'));
  const migrated = getDb().prepare('SELECT token_version FROM users WHERE id = ?').get('legacy-admin') as {
    token_version: number;
  };
  assert.equal(Number(migrated.token_version), 0);

  const me = (token: string) => app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  const login = async (password: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password },
    });
    assert.equal(response.statusCode, 200);
    return response.json<{ token: string }>().token;
  };

  // Tokens issued before the upgrade carry no version number and keep working as version 0.
  const legacyToken = app.jwt.sign({ id: 'legacy-admin', username: 'admin' });
  assert.equal((await me(legacyToken)).statusCode, 200);

  const sessionA = await login('password1234');
  const sessionB = await login('password1234');
  assert.equal(app.jwt.decode<{ tv: number }>(sessionA)?.tv, 0);
  assert.equal((await me(sessionB)).statusCode, 200);

  const created = await app.inject({
    method: 'POST',
    url: '/api/instances',
    headers: { authorization: `Bearer ${sessionA}` },
    payload: { name: 'session-revocation' },
  });
  assert.equal(created.statusCode, 200);
  const instanceId = created.json<{ id: string }>().id;

  // A console connection opened by the old sign-in.
  const openTicket = await app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/console-ticket`,
    headers: { authorization: `Bearer ${sessionB}` },
  });
  assert.equal(openTicket.statusCode, 200);
  let resolveHistory!: () => void;
  const historyReceived = new Promise<void>((resolve) => { resolveHistory = resolve; });
  let resolveClosed!: (code: number) => void;
  const socketClosed = new Promise<number>((resolve) => { resolveClosed = resolve; });
  await app.injectWS(`/ws/console/${instanceId}?ticket=${openTicket.json<{ ticket: string }>().ticket}`, {}, {
    onInit(ws) {
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'history') resolveHistory();
      });
      ws.on('close', (code) => resolveClosed(code));
    },
  });
  await historyReceived;

  // A ticket issued by the old sign-in that has not been used yet.
  const userId = 'legacy-admin';
  const pendingConsoleTicket = issueConsoleTicket(userId, instanceId).ticket;
  const reservedDownload = reserveDownloadTicket(userId, instanceId, 'server.properties', () => {}).ticket;

  // A failed password change must not invalidate any token.
  const wrongCurrent = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { authorization: `Bearer ${sessionA}` },
    payload: { currentPassword: 'wrong-password', newPassword: 'changed-password' },
  });
  assert.equal(wrongCurrent.statusCode, 400);
  assert.equal((await me(sessionA)).statusCode, 200);

  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { authorization: `Bearer ${sessionA}` },
    payload: { currentPassword: 'password1234', newPassword: 'changed-password' },
  });
  assert.equal(changed.statusCode, 200);
  const changeResult = changed.json<ChangePasswordResult>();
  assert.equal(changeResult.ok, true);
  assert.deepEqual(changeResult.user, { id: userId, username: 'admin' });
  assert.equal(app.jwt.decode<{ tv: number }>(changeResult.token)?.tv, 1);

  // The session that made the change continues with a reissued token; all old tokens, including its own, are invalidated.
  assert.equal((await me(changeResult.token)).statusCode, 200);
  for (const stale of [sessionA, sessionB, legacyToken]) {
    const response = await me(stale);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json<{ code: string }>().code, 'server.common.unauthorized');
  }
  const staleTicketRequest = await app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/console-ticket`,
    headers: { authorization: `Bearer ${sessionB}` },
  });
  assert.equal(staleTicketRequest.statusCode, 401);

  assert.equal(await socketClosed, 1008, '旧登录打开的控制台连接必须被断开');
  assert.equal(consumeConsoleTicket(pendingConsoleTicket, instanceId), null);
  assert.equal(getDownloadTicketStatus(reservedDownload, userId)?.status, 'failed');

  // A local password reset likewise invalidates earlier tokens.
  const sessionC = await login('changed-password');
  const reset = await app.inject({
    method: 'POST',
    url: '/api/launcher/reset-password',
    headers: { 'x-launcher-token': 'c'.repeat(64) },
    payload: { password: 'reset-password-1234' },
  });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json(), { username: 'admin' });
  assert.equal((await me(changeResult.token)).statusCode, 401);
  assert.equal((await me(sessionC)).statusCode, 401);

  const afterReset = await login('reset-password-1234');
  assert.equal(app.jwt.decode<{ tv: number }>(afterReset)?.tv, 2);
  assert.equal((await me(afterReset)).statusCode, 200);

  // After the user is deleted, a token whose signature is still valid must be rejected as well.
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal((await me(afterReset)).statusCode, 401);
});
