import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { getDb, type UserRow } from '../db.js';
import { nowIso } from '../utils/path.js';
import { PanelError } from '../utils/errors.js';
import { revokeUserSessions } from './session-revocation-service.js';

const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 64;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

/** bcrypt 只使用前 72 字节，超出部分静默截断会导致不同密码可互相登录；初始化时即拒绝超长密码。 */
const BCRYPT_MAX_BYTES = 72;

/** 用户不存在时也执行一次 bcrypt 比较，抹平「用户是否存在」的时序差异。 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/** 签发 JWT 所需的用户信息；tokenVersion 写进令牌，校验时与数据库比对。 */
export type SessionUser = { id: string; username: string; tokenVersion: number };

export function needsSetup(): boolean {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
  return row.c === 0;
}

function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PanelError('server.auth.passwordTooShort', { min: PASSWORD_MIN_LENGTH });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new PanelError('server.auth.passwordTooLong', { max: PASSWORD_MAX_LENGTH });
  }
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new PanelError('server.auth.passwordTooManyBytes', { max: BCRYPT_MAX_BYTES });
  }
}

export function setupAdmin(username: string, password: string): SessionUser {
  const normalizedUsername = username.trim();
  if (normalizedUsername.length < USERNAME_MIN_LENGTH) {
    throw new PanelError('server.auth.usernameTooShort', { min: USERNAME_MIN_LENGTH });
  }
  if (normalizedUsername.length > USERNAME_MAX_LENGTH) {
    throw new PanelError('server.auth.usernameTooLong', { max: USERNAME_MAX_LENGTH });
  }
  assertValidPassword(password);

  const id = nanoid(12);
  const hash = bcrypt.hashSync(password, 10);
  const result = getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, created_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .run(id, normalizedUsername, hash, nowIso());
  if (Number(result.changes) === 0) {
    throw new PanelError('server.auth.alreadyInitialized', undefined, { statusCode: 409 });
  }
  return { id, username: normalizedUsername, tokenVersion: 0 };
}

export function verifyLogin(username: string, password: string): SessionUser | null {
  // 超过 72 字节的密码必然与任何合法哈希不匹配，直接拒绝可避免截断误匹配。
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) return null;
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as
    | UserRow
    | undefined;
  // 用户不存在时也执行一次 bcrypt 比较，避免通过响应时间枚举用户名。
  if (!bcrypt.compareSync(password, row ? row.password_hash : DUMMY_PASSWORD_HASH)) return null;
  if (!row) return null;
  return { id: row.id, username: row.username, tokenVersion: row.token_version };
}

/**
 * 写入新密码并把令牌版本加 1：此前签发的 JWT 版本不再匹配，下一次请求即返回 401；
 * 同时作废旧登录签发的控制台、下载 ticket 并断开控制台连接。
 */
function updatePasswordHash(userId: string, password: string): SessionUser {
  const row = getDb()
    .prepare(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1
       WHERE id = ? RETURNING id, username, token_version`,
    )
    .get(bcrypt.hashSync(password, 10), userId) as Pick<UserRow, 'id' | 'username' | 'token_version'> | undefined;
  if (!row) throw new PanelError('server.common.unauthorized', undefined, { statusCode: 401 });
  revokeUserSessions(row.id);
  return { id: row.id, username: row.username, tokenVersion: row.token_version };
}

/** 修改成功返回新的令牌版本，路由据此为当前会话换发令牌。 */
export function changePassword(userId: string, currentPassword: string, newPassword: string): SessionUser {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | Pick<UserRow, 'password_hash'>
    | undefined;
  if (
    !row
    || Buffer.byteLength(currentPassword, 'utf8') > BCRYPT_MAX_BYTES
    || !bcrypt.compareSync(currentPassword, row.password_hash)
  ) {
    throw new PanelError('server.auth.currentPasswordIncorrect');
  }
  assertValidPassword(newPassword);
  return updatePasswordHash(userId, newPassword);
}

/** 忘记密码时由本机启动器调用，重置最早创建的管理员。 */
export function resetAdminPassword(password: string): { username: string } {
  assertValidPassword(password);
  const row = getDb().prepare('SELECT id, username FROM users ORDER BY created_at LIMIT 1').get() as
    | { id: string; username: string }
    | undefined;
  if (!row) throw new PanelError('server.auth.noAdministrator', undefined, { statusCode: 409 });
  updatePasswordHash(row.id, password);
  return { username: row.username };
}

/** 令牌里的版本与数据库一致才算有效；用户不存在返回 false。旧版令牌不带版本，按 0 处理。 */
export function isTokenVersionCurrent(userId: string, tokenVersion: unknown): boolean {
  const row = getDb().prepare('SELECT token_version FROM users WHERE id = ?').get(userId) as
    | Pick<UserRow, 'token_version'>
    | undefined;
  if (!row) return false;
  const version = tokenVersion === undefined ? 0 : tokenVersion;
  return typeof version === 'number' && version === Number(row.token_version);
}

export function getUserById(id: string): { id: string; username: string } | null {
  const row = getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(id) as
    | { id: string; username: string }
    | undefined;
  return row ?? null;
}
