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

/** bcrypt uses only the first 72 bytes, and silently truncating the rest would let different passwords sign in as each other; overlong passwords are rejected at setup already. */
const BCRYPT_MAX_BYTES = 72;

/** Runs one bcrypt comparison even when the user does not exist, to even out the timing difference that reveals "whether the user exists". */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/** User info needed to issue a JWT; tokenVersion is written into the token and compared with the database on verification. */
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
  // A password over 72 bytes can never match a valid hash, and rejecting it outright avoids a false match from truncation.
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) return null;
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as
    | UserRow
    | undefined;
  // Run one bcrypt comparison even when the user does not exist, so usernames cannot be enumerated through response time.
  if (!bcrypt.compareSync(password, row ? row.password_hash : DUMMY_PASSWORD_HASH)) return null;
  if (!row) return null;
  return { id: row.id, username: row.username, tokenVersion: row.token_version };
}

/**
 * Writes the new password and increments the token version: previously issued JWTs no longer match the version, and the next request returns 401;
 * it also voids the console and download tickets issued by the old sign-in and drops console connections.
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

/** Returns the new token version on success, which the route uses to reissue a token for the current session. */
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

/** Called by the local launcher when the password is forgotten; resets the earliest-created admin. */
export function resetAdminPassword(password: string): { username: string } {
  assertValidPassword(password);
  const row = getDb().prepare('SELECT id, username FROM users ORDER BY created_at LIMIT 1').get() as
    | { id: string; username: string }
    | undefined;
  if (!row) throw new PanelError('server.auth.noAdministrator', undefined, { statusCode: 409 });
  updatePasswordHash(row.id, password);
  return { username: row.username };
}

/** Valid only when the version in the token matches the database; returns false when the user does not exist. Old tokens carry no version and are treated as 0. */
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
