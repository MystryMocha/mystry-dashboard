/**
 * 登录有效期（D-040）：默认 12 小时、在面板里改、改了马上给当前设备换发令牌；
 * 「不过期」签发的令牌不带 exp，但改短后按签发时间超时的令牌立即失效。.env 的 JWT_EXPIRES_IN 不再生效。
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
// 旧配置里的有效期不再生效：令牌仍按面板设置（默认 12 小时）签发。
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

  // 默认 12 小时，JWT_EXPIRES_IN=1m 被忽略。
  const firstClaims = decode(firstToken);
  assert.equal(firstClaims.exp! - firstClaims.iat, 12 * HOUR);
  assert.equal((await getDuration(firstToken)).json<SessionDurationSetting>().duration, '12h');

  // 没登录不能读也不能改；不在列表里的值被拒绝。
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/session-duration' })).statusCode, 401);
  assert.equal((await putDuration(null, 'never')).statusCode, 401);
  const invalid = await putDuration(firstToken, '3h');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json<{ code: string }>().code, 'server.auth.sessionDurationInvalid');

  // 改为不过期：当前设备拿到不带 exp 的新令牌，三小时前签发的令牌也照常可用。
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

  // 改短为 2 小时：三小时前登录的令牌即使不带 exp 也立即失效；刚签发的照常可用。
  const toShort = await putDuration(neverResult.token, '2h');
  assert.equal(toShort.statusCode, 200);
  const shortResult = toShort.json<UpdateSessionDurationResult>();
  const shortClaims = decode(shortResult.token);
  assert.equal(shortClaims.exp! - shortClaims.iat, 2 * HOUR);
  assert.equal((await me(oldNeverToken)).statusCode, 401);
  assert.equal((await me(neverResult.token)).statusCode, 200);
  assert.equal((await me(shortResult.token)).statusCode, 200);

  // 其余预设都能签发，有效期和选项一致（签不出来会把保存的设置卡住，之后谁都登录不了）。
  let currentToken = shortResult.token;
  for (const [duration, seconds] of [['1d', 24 * HOUR], ['7d', 7 * 24 * HOUR], ['30d', 30 * 24 * HOUR], ['12h', 12 * HOUR]] as const) {
    const response = await putDuration(currentToken, duration);
    assert.equal(response.statusCode, 200, `${duration}: ${response.body}`);
    currentToken = response.json<UpdateSessionDurationResult>().token;
    const presetClaims = decode(currentToken);
    assert.equal(presetClaims.exp! - presetClaims.iat, seconds, duration);
  }
  assert.equal((await putDuration(currentToken, '2h')).statusCode, 200);

  // 之后的登录按新设置签发。
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(login.statusCode, 200);
  const loginClaims = decode(login.json<{ token: string }>().token);
  assert.equal(loginClaims.exp! - loginClaims.iat, 2 * HOUR);
});
