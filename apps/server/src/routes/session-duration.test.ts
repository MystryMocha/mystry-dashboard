/**
 * Session duration: 12 hours by default, changed in the panel, and a change reissues the current device's token right away;
 * tokens issued as "never expire" carry no exp, but after shortening, tokens that have timed out by issue time are invalidated immediately. JWT_EXPIRES_IN in .env no longer applies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SessionDurationSetting, UpdateSessionDurationResult } from '@mystry/shared';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
// The expiry from old config no longer applies: tokens are still issued with the panel setting (12 hours by default).
process.env.JWT_EXPIRES_IN = '1m';

const HOUR = 60 * 60;

test('登录有效期：默认 12 小时，可改为不过期或改短，改短后超时的旧令牌立即失效', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-session-duration-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    await app.close();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  type Claims = { id: string; iat: number; exp?: number };
  const decode = (token: string) => app.jwt.decode<Claims>(token)!;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const me = (token: string) => app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(token) });
  const getDuration = (token: string) => app.inject({ method: 'GET', url: '/api/auth/session-duration', headers: bearer(token) });
  const putDuration = (token: string | null, duration: unknown) => app.inject({
    method: 'PUT',
    url: '/api/auth/session-duration',
    headers: token ? bearer(token) : {},
    payload: { duration },
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const { token: firstToken, user } = setup.json<{ token: string; user: { id: string; username: string } }>();

  // 12 hours by default; JWT_EXPIRES_IN=1m is ignored.
  const firstClaims = decode(firstToken);
  assert.equal(firstClaims.exp! - firstClaims.iat, 12 * HOUR);
  assert.equal((await getDuration(firstToken)).json<SessionDurationSetting>().duration, '12h');

  // Neither readable nor changeable without signing in; values not in the list are rejected.
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/session-duration' })).statusCode, 401);
  assert.equal((await putDuration(null, 'never')).statusCode, 401);
  const invalid = await putDuration(firstToken, '3h');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json<{ code: string }>().code, 'server.auth.sessionDurationInvalid');

  // Changed to never expire: this device gets a new token without exp, and a token issued three hours ago keeps working as well.
  const toNever = await putDuration(firstToken, 'never');
  assert.equal(toNever.statusCode, 200);
  const neverResult = toNever.json<UpdateSessionDurationResult>();
  assert.equal(neverResult.duration, 'never');
  assert.equal(decode(neverResult.token).exp, undefined);
  assert.equal((await getDuration(neverResult.token)).json<SessionDurationSetting>().duration, 'never');
  const now = Math.floor(Date.now() / 1000);
  const oldNeverToken = app.jwt.sign({ id: user.id, username: user.username, tv: 0, iat: now - 3 * HOUR });
  assert.equal(decode(oldNeverToken).iat, now - 3 * HOUR);
  assert.equal(decode(oldNeverToken).exp, undefined);
  assert.equal((await me(oldNeverToken)).statusCode, 200);

  // Shortened to 2 hours: a token from a sign-in three hours ago is invalidated immediately even without exp; a freshly issued one keeps working.
  const toShort = await putDuration(neverResult.token, '2h');
  assert.equal(toShort.statusCode, 200);
  const shortResult = toShort.json<UpdateSessionDurationResult>();
  const shortClaims = decode(shortResult.token);
  assert.equal(shortClaims.exp! - shortClaims.iat, 2 * HOUR);
  assert.equal((await me(oldNeverToken)).statusCode, 401);
  assert.equal((await me(neverResult.token)).statusCode, 200);
  assert.equal((await me(shortResult.token)).statusCode, 200);

  // Every other preset can be issued, with an expiry matching the option (if issuing failed, saving the setting would get stuck and nobody could sign in afterwards).
  let currentToken = shortResult.token;
  for (const [duration, seconds] of [['1d', 24 * HOUR], ['7d', 7 * 24 * HOUR], ['30d', 30 * 24 * HOUR], ['12h', 12 * HOUR]] as const) {
    const response = await putDuration(currentToken, duration);
    assert.equal(response.statusCode, 200, `${duration}: ${response.body}`);
    currentToken = response.json<UpdateSessionDurationResult>().token;
    const presetClaims = decode(currentToken);
    assert.equal(presetClaims.exp! - presetClaims.iat, seconds, duration);
  }
  assert.equal((await putDuration(currentToken, '2h')).statusCode, 200);

  // Later sign-ins are issued with the new setting.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(login.statusCode, 200);
  const loginClaims = decode(login.json<{ token: string }>().token);
  assert.equal(loginClaims.exp! - loginClaims.iat, 2 * HOUR);
});
