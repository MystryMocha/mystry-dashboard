#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'mystry-dashboard';
const SECRET_PATTERN = /^[0-9a-f]{64}$/i;
// Lets the source launcher tell whether the panel is running: exit code 0 when running, otherwise 1.
const INTERNAL_IS_RUNNING = '__is-running';

/**
 * Launcher UI language: MYSTRY_LANG first, then the system language; Chinese when the system language is Chinese, English for everything else.
 * On Windows LANG is often hard-coded by terminals such as Git Bash and does not reflect the system language, so only the system locale given by Intl is used.
 */
function detectLanguage() {
  const candidates = [process.env.MYSTRY_LANG];
  if (process.platform !== 'win32') {
    candidates.push(process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG);
  }
  for (const value of candidates) {
    const trimmed = value?.trim();
    // C / POSIX means no language is set, so move on to the next item.
    if (trimmed && !/^(C|POSIX)([.@]|$)/i.test(trimmed)) return /^zh/i.test(trimmed) ? 'zh' : 'en';
  }
  return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en';
}

const chinese = detectLanguage() === 'zh';
/** Picks one of two by UI language, with Chinese and English written in the same place for easy comparison. */
const text = (zh, en) => (chinese ? zh : en);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

function discoverHome() {
  if (process.env.MYSTRY_HOME?.trim()) return path.resolve(process.env.MYSTRY_HOME.trim());
  const portableCandidate = path.resolve(scriptDir, '..');
  if (fs.existsSync(path.join(portableCandidate, 'app', 'server', 'dist', 'index.js'))) {
    return portableCandidate;
  }
  return path.resolve(scriptDir, '..', '..');
}

function resolveFromHome(value, homeDir) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(homeDir, value);
}

const homeDir = discoverHome();
const configPath = resolveFromHome(
  process.env.MYSTRY_CONFIG_PATH?.trim() || path.join('config', 'panel.env'),
  homeDir,
);
// Same as the server's config.ts: MYSTRY_DATA_DIR takes precedence over DATA_DIR, and process environment variables over the config file.
const fileValues = fs.existsSync(configPath) ? parseEnv(fs.readFileSync(configPath, 'utf8')) : new Map();
const configValue = (name) => process.env[name]?.trim() || fileValues.get(name);
const dataDir = resolveFromHome(configValue('MYSTRY_DATA_DIR') || configValue('DATA_DIR') || 'data', homeDir);
const logDir = path.join(homeDir, 'logs');
const launcherDir = path.join(dataDir, 'launcher');
const statePath = path.join(launcherDir, 'state.json');
// Keeps the name from before the controller became mdash, so an older mystryctl and mdash on the same data directory still exclude each other.
const lockPath = path.join(launcherDir, 'mystryctl.lock');
// The panel's own data directory lock: an exclusive SQLite transaction held for the life of the panel process. The panel keeps it after
// it stops answering for as long as a Minecraft server it started is still running, which is how "still shutting down" is told apart
// from "stopped". owner.json beside it only names the holder in messages.
const panelDataLockDbPath = path.join(dataDir, '.mystry-panel-lock.db');
const panelDataLockOwnerPath = path.join(dataDir, '.mystry-panel-lock', 'owner.json');
const stdoutLog = path.join(logDir, 'panel.stdout.log');
const stderrLog = path.join(logDir, 'panel.stderr.log');
const portableServerEntry = path.join(homeDir, 'app', 'server', 'dist', 'index.js');
const repositoryServerEntry = path.join(homeDir, 'apps', 'server', 'dist', 'index.js');
const portableMode = fs.existsSync(portableServerEntry);
const serverEntry = portableMode ? portableServerEntry : repositoryServerEntry;
const managerLabel = portableMode ? text('便携版', 'Portable') : text('源码版', 'Source');
const sourceManagerCommand = process.platform === 'win32' ? 'mdash.cmd' : 'mdash.sh';
const managerCommand = portableMode ? 'mdash' : sourceManagerCommand;
const bundledNode = process.platform === 'win32'
  ? path.join(homeDir, 'runtime', 'node.exe')
  : path.join(homeDir, 'runtime', 'bin', 'node');
const nodeExecutable = fs.existsSync(bundledNode) ? bundledNode : process.execPath;

function randomSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function parseEnv(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    result.set(key, quoted ? value.slice(1, -1) : value);
  }
  return result;
}

function setEnvLine(lines, name, value) {
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (value === null) {
    if (index < 0) return false;
    lines.splice(index, 1);
    return true;
  }
  const next = `${name}=${value}`;
  if (index >= 0) {
    if (lines[index] === next) return false;
    lines[index] = next;
    return true;
  }
  if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
  lines.push(next);
  return true;
}

let cachedWindowsUserSid;

function resolveWindowsUserSid() {
  if (cachedWindowsUserSid !== undefined) return cachedWindowsUserSid;
  if (process.platform !== 'win32') {
    cachedWindowsUserSid = null;
    return null;
  }
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const result = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    cachedWindowsUserSid = null;
    return null;
  }
  const match = /\b(S-1-\d+(?:-\d+)+)\b/.exec(result.stdout);
  cachedWindowsUserSid = match?.[1] ?? null;
  return cachedWindowsUserSid;
}

function tightenWindowsAcl(targetPath, isDirectory, userSid) {
  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  const grants = isDirectory
    ? [`*${userSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']
    : [`*${userSid}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F'];
  // `/inheritance:r` and `/grant:r` leave explicit entries for other principals in place (left behind by tools that
  // copy ACLs, or by a manual grant), so the ACL is reset first. icacls rejects `/reset` combined with the other switches.
  for (const args of [['/reset'], ['/inheritance:r', '/grant:r', ...grants]]) {
    const result = spawnSync(icacls, [targetPath, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      return result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status ?? 'unknown'}`;
    }
  }
  return null;
}

function warnWindowsAclFailure(failures) {
  if (failures.length === 0) return;
  console.warn(text(
    `警告：无法收紧以下 Windows 路径的访问权限：${failures.join('、')}。`
      + '若所在磁盘不是 NTFS 或权限不足，其他本机账户可能读取配置密钥或数据目录，请手动限制 NTFS 权限。',
    `Warning: could not restrict Windows permissions on: ${failures.join(', ')}. `
      + 'On non-NTFS drives or with insufficient rights, other local accounts may read config secrets or data; restrict NTFS permissions manually.',
  ));
}

function tightenWindowsFileIfNeeded(filePath, userSid) {
  if (!fs.existsSync(filePath)) return null;
  const err = tightenWindowsAcl(filePath, false, userSid);
  return err ? `${filePath} (${err})` : null;
}

/**
 * Restricts panel config, data, logs and existing secret/DB files on Windows to the current user,
 * SYSTEM and Administrators so directories extracted outside the user profile do not keep inherited broad ACLs.
 * Only these top-level paths are rewritten; instance files and other children pick the result up through inheritance.
 */
function tightenWindowsPanelPaths() {
  if (process.platform !== 'win32') return;
  const userSid = resolveWindowsUserSid();
  if (!userSid) {
    console.warn(text(
      '警告：无法获取当前 Windows 用户 SID，未自动收紧配置与数据目录权限；请确保 config、data 与 logs 仅当前用户可访问。',
      'Warning: could not resolve the current Windows user SID; config and data directory permissions were not tightened. Ensure config, data and logs are readable only by your user.',
    ));
    return;
  }

  const resolvedHome = path.resolve(homeDir);
  const candidateDirs = [path.dirname(configPath), dataDir, logDir, launcherDir];
  const configBackupDir = path.join(launcherDir, 'config-backups');
  if (fs.existsSync(configBackupDir)) candidateDirs.push(configBackupDir);

  const seenDirs = new Set();
  const failures = [];
  for (const dir of candidateDirs) {
    const resolved = path.resolve(dir);
    // Source mode places .env directly under the repository root; never strip inheritance from the repo root itself.
    if (resolved === resolvedHome || seenDirs.has(resolved) || !fs.existsSync(resolved)) continue;
    seenDirs.add(resolved);
    const err = tightenWindowsAcl(resolved, true, userSid);
    if (err) failures.push(`${resolved} (${err})`);
  }

  const sensitiveFiles = [
    configPath,
    path.join(dataDir, 'panel.db'),
    path.join(dataDir, 'panel.db-wal'),
    path.join(dataDir, 'panel.db-shm'),
    statePath,
  ];
  if (fs.existsSync(configBackupDir)) {
    try {
      for (const name of fs.readdirSync(configBackupDir)) {
        sensitiveFiles.push(path.join(configBackupDir, name));
      }
    } catch {
      // Ignore unreadable backup directory; directory tightening failure above will already report it.
    }
  }
  for (const file of sensitiveFiles) {
    const failure = tightenWindowsFileIfNeeded(file, userSid);
    if (failure) failures.push(failure);
  }
  warnWindowsAclFailure(failures);
}

async function writeAtomic(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  await fsp.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, filePath);
  if (process.platform !== 'win32') {
    await fsp.chmod(filePath, 0o600);
  } else if (
    path.resolve(filePath) === path.resolve(configPath)
    && path.resolve(path.dirname(filePath)) === path.resolve(homeDir)
  ) {
    const userSid = resolveWindowsUserSid();
    if (userSid) {
      const failure = tightenWindowsFileIfNeeded(filePath, userSid);
      if (failure) warnWindowsAclFailure([failure]);
    }
  }
}

async function databaseNeedsSetup() {
  const databasePath = path.join(dataDir, 'panel.db');
  if (!fs.existsSync(databasePath)) return true;
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 15_000) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
      try {
        const table = database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
          .get();
        if (!table) return true;
        const count = database.prepare('SELECT COUNT(*) AS count FROM users').get();
        return !count || Number(count.count) === 0;
      } finally {
        database.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // While the panel finishes restarting the database may be briefly held by a write lock, so wait and retry.
      if (!/database is locked|SQLITE_BUSY/.test(message)) {
        throw new Error(text(`无法检查管理员初始化状态：${message}`, `Cannot check administrator setup status: ${message}`));
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(text(`无法检查管理员初始化状态：${message}`, `Cannot check administrator setup status: ${message}`));
}

async function backupConfiguration() {
  if (!fs.existsSync(configPath)) return null;
  const backupDir = path.join(launcherDir, 'config-backups');
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `panel-${stamp}.env.bak`);
  await fsp.copyFile(configPath, backupPath, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') await fsp.chmod(backupPath, 0o600);
  return backupPath;
}

async function ensureConfiguration() {
  await Promise.all([
    fsp.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 }),
    fsp.mkdir(dataDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(logDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(launcherDir, { recursive: true, mode: 0o700 }),
  ]);
  tightenWindowsPanelPaths();

  const existed = fs.existsSync(configPath);
  const original = existed
    ? await fsp.readFile(configPath, 'utf8')
    : [
        text('# Mystry Dashboard 配置', '# Mystry Dashboard configuration'),
        text('# 本文件包含密钥，不要上传、分享或放入版本控制。', '# This file contains secrets. Do not upload, share or commit it.'),
        'HOST=127.0.0.1',
        'PORT=3000',
        'CORS_ORIGINS=http://127.0.0.1:3000,http://localhost:3000',
        '',
      ].join('\n');
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  let values = parseEnv(original);
  let changed = !existed;
  let repaired = false;

  for (const name of ['JWT_SECRET', 'LAUNCHER_TOKEN']) {
    const current = values.get(name);
    if (!current || !SECRET_PATTERN.test(current)) {
      changed = setEnvLine(lines, name, randomSecret()) || changed;
      repaired = repaired || Boolean(current);
    }
  }

  values = parseEnv(lines.join('\n'));
  if (values.get('JWT_SECRET') === values.get('LAUNCHER_TOKEN')) {
    changed = setEnvLine(lines, 'LAUNCHER_TOKEN', randomSecret()) || changed;
    repaired = true;
  }

  const needsSetup = await databaseNeedsSetup();
  values = parseEnv(lines.join('\n'));
  if (needsSetup) {
    const current = values.get('SETUP_TOKEN');
    if (!current || !SECRET_PATTERN.test(current)) {
      changed = setEnvLine(lines, 'SETUP_TOKEN', randomSecret()) || changed;
      repaired = repaired || Boolean(current);
    }
  } else {
    changed = setEnvLine(lines, 'SETUP_TOKEN', null) || changed;
  }

  values = parseEnv(lines.join('\n'));
  if (
    needsSetup
    && (values.get('SETUP_TOKEN') === values.get('JWT_SECRET')
      || values.get('SETUP_TOKEN') === values.get('LAUNCHER_TOKEN'))
  ) {
    changed = setEnvLine(lines, 'SETUP_TOKEN', randomSecret()) || changed;
    repaired = true;
  }

  if (changed) {
    const backup = existed ? await backupConfiguration() : null;
    let content = lines.join('\n').replace(/\n+$/, '');
    content += '\n';
    await writeAtomic(configPath, content);
    if (backup) console.log(text(`配置已备份：${backup}`, `Configuration backed up: ${backup}`));
    if (!existed) console.log(text(`已创建${managerLabel}配置：${configPath}`, `Created configuration: ${configPath}`));
    if (repaired) {
      console.warn(text(
        '检测到缺失或无效密钥，已备份配置并生成新的随机密钥。',
        'Missing or invalid secrets were found; the configuration was backed up and new random secrets were generated.',
      ));
    }
  }

  values = parseEnv(await fsp.readFile(configPath, 'utf8'));
  return {
    values,
    needsSetup,
    setupToken: needsSetup ? values.get('SETUP_TOKEN') ?? null : null,
  };
}

async function loadConfiguration() {
  if (!fs.existsSync(configPath)) return null;
  return parseEnv(await fsp.readFile(configPath, 'utf8'));
}

function parsePort(values) {
  const raw = process.env.PORT?.trim() || values?.get('PORT') || '3000';
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(text(`PORT 必须是 1 到 65535 的整数：${raw}`, `PORT must be an integer from 1 to 65535: ${raw}`));
  }
  return port;
}

function connectionForHostPort(host, port) {
  const normalizedHost = !host || ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
  const formattedHost = normalizedHost.includes(':') && !normalizedHost.startsWith('[')
    ? `[${normalizedHost}]`
    : normalizedHost;
  return {
    port,
    url: `http://${formattedHost}:${port}`,
    healthUrl: `http://${formattedHost}:${port}/api/health`,
    setupUrl: `http://${formattedHost}:${port}/api/auth/setup`,
    shutdownUrl: `http://127.0.0.1:${port}/api/launcher/shutdown`,
    resetPasswordUrl: `http://127.0.0.1:${port}/api/launcher/reset-password`,
  };
}

function getConnection(values) {
  const host = process.env.HOST?.trim() || values?.get('HOST') || '127.0.0.1';
  const port = parsePort(values);
  return connectionForHostPort(host, port);
}

function connectionFromState(state) {
  if (typeof state?.url !== 'string' || !state.url) return null;
  try {
    const parsed = new URL(state.url);
    if (parsed.protocol !== 'http:') return null;
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    return connectionForHostPort(parsed.hostname, port);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getHealthForConnection(connection, expectedFingerprint = null) {
  if (!connection) return null;
  try {
    const response = await fetchWithTimeout(connection.healthUrl);
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.ok !== true || body?.service !== SERVICE_NAME) return null;
    if (
      expectedFingerprint
      && body?.processFingerprint !== expectedFingerprint
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

async function getHealth(values, expectedFingerprint = null) {
  return values ? await getHealthForConnection(getConnection(values), expectedFingerprint) : null;
}

async function isPortOpen(port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function childEnvironment(fingerprint) {
  return {
    ...process.env,
    MYSTRY_HOME: homeDir,
    MYSTRY_CONFIG_PATH: configPath,
    MYSTRY_DATA_DIR: dataDir,
    MYSTRY_PROCESS_FINGERPRINT: fingerprint,
  };
}

async function writeState(pid, startedAt, fingerprint, url) {
  await writeAtomic(
    statePath,
    `${JSON.stringify({ version: 1, pid, startedAt, fingerprint, url }, null, 2)}\n`,
  );
}

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

async function unlinkIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }
}

async function clearState() {
  await unlinkIfExists(statePath);
}

function isProcessAlive(pid) {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but may not be signalled: on Windows, a launcher without administrator rights gets it for a panel
    // started as administrator, and treating that as gone would show a running panel as stopped.
    return isErrorCode(error, 'EPERM');
  }
}

/**
 * Whether the PID in the manager lock still blocks taking it. Unlike isProcessAlive, EPERM counts as gone: the lock lasts one command,
 * so one left behind usually outlived a power cut, and after a reboot Windows may hand its PID to a system process that a launcher may
 * not signal. Counting that as alive would refuse every command until the file is deleted by hand.
 */
function isManagerProcessAlive(pid) {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The PID of a live panel process holding the data directory, or null. Liveness comes from trying to take the lock itself: the
 * operating system drops it when the holder exits, so a leftover owner.json with a recycled PID is never mistaken for a running panel.
 */
async function panelDataLockHolder() {
  // Opening would create the file; a missing one simply means no panel with this lock has ever run here.
  if (!fs.existsSync(panelDataLockDbPath)) return null;
  let database = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(panelDataLockDbPath, { timeout: 0 });
    database.exec('BEGIN EXCLUSIVE');
    database.exec('ROLLBACK');
    return null;
  } catch (error) {
    // Anything other than "busy" (unreadable file, SQLite unavailable) proves nothing about a holder.
    if (error?.errcode !== 5) return null;
  } finally {
    database?.close();
  }
  // A panel records itself right after taking the lock. Busy without a record is another launcher probing at the same instant.
  try {
    const owner = JSON.parse(fs.readFileSync(panelDataLockOwnerPath, 'utf8'));
    return Number.isSafeInteger(owner?.pid) && owner.pid !== process.pid ? owner.pid : null;
  } catch {
    return null;
  }
}

/** Whether a Linux start identity recorded by the panel (`linux:<boot id>:<start ticks>`) still describes the PID. */
function linuxIdentityMatches(pid, identity) {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return identity === `linux:${bootId}:${ticks}`;
  } catch {
    return false;
  }
}

/**
 * Minecraft servers that outlived the panel: runs the database still has open whose PID exists. Stopping the panel only stops the
 * servers it is attached to, so one it found already running after a crash keeps going, and nothing else would say so.
 * Only Linux can confirm the PID is still that server without a subprocess. Elsewhere a run from before this boot is skipped, since
 * its PID can only belong to something else by now (the usual case after the computer was shut down with servers running); a PID
 * reused within the same boot is still listed, hence "may".
 */
async function serversLeftRunning() {
  const databasePath = path.join(dataDir, 'panel.db');
  if (!fs.existsSync(databasePath)) return [];
  let database = null;
  try {
    const bootedAtMs = Date.now() - os.uptime() * 1000;
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1_000 });
    const rows = database
      .prepare(
        `SELECT r.pid AS pid, r.process_identity AS identity, r.started_at AS startedAt, i.name AS name
         FROM instance_runs r INNER JOIN instances i ON i.id = r.instance_id
         WHERE r.ended_at IS NULL AND r.pid IS NOT NULL`,
      )
      .all();
    return rows.filter((row) => {
      if (!isProcessAlive(row.pid) || row.pid === process.pid) return false;
      if (typeof row.identity === 'string' && row.identity.startsWith('linux:')) return linuxIdentityMatches(row.pid, row.identity);
      const startedMs = Date.parse(row.startedAt);
      return !(Number.isFinite(startedMs) && startedMs < bootedAtMs - 5_000);
    });
  } catch {
    // An older database without these columns, or one that cannot be read right now: there is nothing reliable to report.
    return [];
  } finally {
    database?.close();
  }
}

async function warnServersLeftRunning() {
  const servers = await serversLeftRunning();
  if (servers.length === 0) return;
  const list = servers.map((server) => `${server.name} (PID ${server.pid})`).join(text('、', ', '));
  console.warn(text(
    `提醒：面板没有在运行，但这些实例的 Minecraft 服务器可能还在运行：${list}。启动面板后可以在实例页停止它们；面板停着的时候，它们不受面板管理。`,
    `Note: the panel is not running, but the Minecraft servers of these instances may still be: ${list}. Start the panel to stop them from the instance page; while it is stopped they are not managed.`,
  ));
}

function serversStillStoppingMessage(pid) {
  const howToEnd = process.platform === 'win32'
    ? text('在任务管理器里结束它启动的 java.exe', 'end the java.exe it started in Task Manager')
    : text('用 kill 结束它启动的 java 进程', 'end the java process it started with kill');
  return text(
    `面板进程（PID ${pid}）已经不再响应，但还占着数据目录，通常是在等它启动的 Minecraft 服务器退出。为保护存档，${managerCommand} 不会强制结束它，也不会再启动一个面板。请等它退出后再启动面板；如果一直不退出，可以${howToEnd}，上次自动保存之后的进度会丢失。`,
    `The panel process (PID ${pid}) no longer responds but still holds the data directory, usually because a Minecraft server it started has not exited yet. To protect your worlds, ${managerCommand} neither forces it to end nor starts another panel. Start the panel once it has exited. If it never does, ${howToEnd}; progress since the last autosave is lost.`,
  );
}

/**
 * The PID of a panel that is shutting down but still waiting for its servers: it has closed its port yet still holds the data directory.
 * A panel that is only slow to answer still has its port open, and must not be reported this way: the advice is to end its servers.
 */
async function panelStillShuttingDown(values, state = null) {
  const candidates = [];
  const fromState = connectionFromState(state);
  if (fromState) candidates.push(fromState);
  if (values) {
    const configured = getConnection(values);
    if (!candidates.some((c) => c.url === configured.url)) candidates.push(configured);
  }
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    if (await getHealthForConnection(candidate) || await isPortOpen(candidate.port)) return null;
  }
  return await panelDataLockHolder();
}

/**
 * The PID of another live process holding the manager lock, such as a restart or stop running in another window, or null.
 * EPERM counts as alive here, unlike when taking the lock: this only decides how long to wait, and a restart from a window opened
 * as administrator answers EPERM. By the time anyone waits, a start has already replaced a lock left over from before a reboot.
 */
function managerLockHolder() {
  try {
    const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
    return owner !== process.pid && isProcessAlive(owner) ? owner : null;
  } catch {
    return null;
  }
}

async function acquireManagerLock() {
  await fsp.mkdir(launcherDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.close();
      return () => unlinkIfExists(lockPath);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
      const ownerText = await fsp.readFile(lockPath, 'utf8').catch(() => '');
      const owner = Number(ownerText.trim());
      if (isManagerProcessAlive(owner)) {
        throw new Error(text(`另一个 ${managerCommand} 正在运行，请稍后再试。`, `Another ${managerCommand} is running. Try again later.`));
      }
      await fsp.unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(text('无法获取 mdash 运行锁。', 'Could not acquire the mdash lock.'));
}

async function releaseCurrentManagerLock() {
  const ownerText = await fsp.readFile(lockPath, 'utf8').catch(() => '');
  if (Number(ownerText.trim()) !== process.pid) return;
  await unlinkIfExists(lockPath);
}

/**
 * Resolves the active connection of a panel started by this manager, preferring state.json's URL
 * so port/host edits while running still route stop/status/open/reset-password/remote cleanly.
 */
async function findManagedPanel(values, state) {
  if (!isProcessAlive(state?.pid) || !state?.fingerprint) return null;
  const fromState = connectionFromState(state);
  const configured = values ? getConnection(values) : null;
  const candidates = [];
  if (fromState) candidates.push(fromState);
  if (configured && !candidates.some((c) => c.url === configured.url)) {
    candidates.push(configured);
  }
  for (const candidate of candidates) {
    if (await getHealthForConnection(candidate, state.fingerprint)) {
      return {
        connection: candidate,
        configured,
        portChanged: Boolean(configured && candidate.port !== configured.port),
        urlChanged: Boolean(configured && candidate.url !== configured.url),
      };
    }
  }
  return null;
}

/** Only when the process recorded in state.json is still alive, and the health check returns the same fingerprint, does it count as a panel started by this manager. */
async function isManagedPanelRunning(values, state) {
  return Boolean(await findManagedPanel(values, state));
}

function checkJava() {
  const result = spawnSync('java', ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    console.warn(text(
      '警告：PATH 中未找到可用 Java。面板可以启动；默认实例无法启动，但可在面板中探测并选择其他已安装运行时。',
      'Warning: no usable Java was found in PATH. The panel can start, but instances that use the default Java cannot; you can detect and select another installed runtime in the panel.',
    ));
    return;
  }
  const line = `${result.stderr || result.stdout}`.split(/\r?\n/).find(Boolean)?.trim();
  console.log(text(`Java：${line || '已检测到'}`, `Java: ${line || 'detected'}`));
  const versionMatch = `${result.stderr || result.stdout}`.match(/\bversion\s+"(?:1\.)?(\d+)/i);
  const major = versionMatch ? Number(versionMatch[1]) : null;
  if (major === null) {
    console.warn(text(
      '警告：无法识别默认 PATH Java 主版本，请在启动 Minecraft 实例前确认兼容性。',
      'Warning: could not tell the major version of the default Java in PATH. Check compatibility before starting a Minecraft instance.',
    ));
  } else if (![8, 17, 21, 25].includes(major)) {
    console.warn(text(
      `警告：检测到 Java ${major}；当前常见 Minecraft 服务端通常需要 Java 8、17、21 或 25，`
        + '请按服务端版本确认兼容性；已绑定实例以所选运行时为准。',
      `Warning: found Java ${major}. Common Minecraft servers need Java 8, 17, 21 or 25; `
        + 'check what your server version requires. Instances bound to a runtime use that runtime.',
    ));
  }
}

async function waitForHealth(
  values,
  expectedFingerprint = null,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await getHealth(values, expectedFingerprint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const OPEN_URL_COMMANDS = { win32: 'explorer.exe', darwin: 'open' };
async function openBrowser(target, { announce = true } = {}) {
  const url = target && typeof target === 'object' && 'url' in target
    ? target.url
    : getConnection(target).url;
  if (announce) console.log(text(`面板地址：${url}`, `Panel URL: ${url}`));
  if (process.env.MYSTRY_NO_BROWSER === '1') return;
  // Under SSH login the browser would open on the server where the user cannot see it; showRemoteAccessOnStart explains how to open it from outside instead.
  if (isRemoteLogin()) return;
  const command = OPEN_URL_COMMANDS[process.platform] ?? 'xdg-open';
  const warnManualOpen = () => {
    console.warn(text('无法自动打开浏览器，请手动访问上面的地址。', 'Could not open a browser. Open the address above manually.'));
  };
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Missing launchers (such as xdg-open on headless Linux) emit an async ENOENT 'error' event outside try/catch.
    child.once('error', warnManualOpen);
    child.unref();
  } catch {
    warnManualOpen();
  }
}

// The easily misread 0/O and 1/l/I are left out, so users can type it by reading the window.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_PASSWORD_LENGTH = 16;
const INITIAL_ADMIN_USERNAME = 'admin';

function randomPassword() {
  return Array.from(
    { length: GENERATED_PASSWORD_LENGTH },
    () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)],
  ).join('');
}

/** The account and password go only to the user's window, not into log files, which is why console.log is used here rather than the server log. */
function showCredentials(title, { username, password }) {
  const divider = '='.repeat(64);
  console.log(`\n${divider}`);
  console.log(title);
  console.log('');
  console.log(text(`  用户名：${username}`, `  Username: ${username}`));
  console.log(text(`  密码：${password}`, `  Password: ${password}`));
  console.log('');
  console.log(text(
    '密码只显示这一次，请现在记下。登录后点左下角的齿轮进入「面板设置」修改密码。',
    'This password is shown only once, so note it now. After signing in, open Panel Settings (the gear at the bottom left) to change it.',
  ));
  console.log(text(
    `忘记密码时，在面板运行期间执行：${managerCommand} reset-password`,
    `If you forget it, run this while the panel is running: ${managerCommand} reset-password`,
  ));
  console.log(`${divider}\n`);
}

/** Creates the first admin with the internal token, so the user never handles the token; after creation the token is removed from the config immediately. */
async function createInitialAdmin({ setupToken }, connection) {
  const credentials = { username: INITIAL_ADMIN_USERNAME, password: randomPassword() };
  try {
    const response = await fetchWithTimeout(connection.setupUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-setup-token': setupToken },
      body: JSON.stringify(credentials),
    }, 15_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn(text(
      `自动创建管理员失败：${error instanceof Error ? error.message : String(error)}。请在打开的页面手动创建，初始化令牌在 ${configPath}`,
      `Could not create the administrator automatically: ${error instanceof Error ? error.message : String(error)}. Create it on the page that opened. The setup token is in ${configPath}`,
    ));
    if (isRemoteLogin()) {
      console.warn(text(
        `创建好管理员之后，运行 ${managerCommand} remote on 就能从其他设备打开面板。`,
        `After the administrator is created, run ${managerCommand} remote on to open the panel from other devices.`,
      ));
    }
    return null;
  }
  const lines = (await fsp.readFile(configPath, 'utf8')).replace(/\r\n/g, '\n').split('\n');
  if (setEnvLine(lines, 'SETUP_TOKEN', null)) {
    await writeAtomic(configPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  }
  return credentials;
}

async function resetPassword() {
  // A new password may only be shown in a terminal: when output is redirected or piped it would end up in a file or log.
  // This must be checked and refused before contacting the server; resetting first and then hiding the password would leave the user unable to sign in.
  if (!process.stdout.isTTY) {
    throw new Error(text(
      `当前输出不是终端（被重定向或通过管道传出），为避免新密码写进文件或日志，没有重置密码。请在终端窗口里直接运行：${managerCommand} reset-password`,
      `Output is not a terminal (it is redirected or piped), so the password was not reset; otherwise the new password could end up in a file or log. Run ${managerCommand} reset-password directly in a terminal window.`,
    ));
  }
  const values = await loadConfiguration();
  const managed = await findManagedPanel(values, await readState());
  if (!managed) {
    throw new Error(text('面板未运行。请先启动面板，再重置密码。', 'The panel is not running. Start it first, then reset the password.'));
  }
  const password = randomPassword();
  const response = await fetchWithTimeout(managed.connection.resetPasswordUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-launcher-token': values?.get('LAUNCHER_TOKEN') ?? '' },
    body: JSON.stringify({ password }),
  }, 15_000);
  if (!response.ok) {
    throw new Error(text(`重置密码失败：HTTP ${response.status}`, `Could not reset the password: HTTP ${response.status}`));
  }
  const { username } = await response.json();
  showCredentials(text('管理员密码已重置：', 'The administrator password has been reset:'), { username, password });
}

async function rotateLogs() {
  await fsp.mkdir(logDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const current of [stdoutLog, stderrLog]) {
    if (!fs.existsSync(current)) continue;
    await fsp.rename(current, `${current}.${stamp}`);
  }
}

/**
 * Pre-start checks shared by foreground and background starts.
 * When the panel was already started by this manager, only the browser is opened and null is returned; throws when the port is taken by an unknown panel or another program.
 */
async function prepareStart() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(text(`找不到服务端构建产物：${serverEntry}`, `Server build not found: ${serverEntry}`));
  }
  const configuration = await ensureConfiguration();
  const managed = await findManagedPanel(configuration.values, await readState());
  if (managed) {
    console.log(text('面板已经在运行。', 'The panel is already running.'));
    if (managed.urlChanged && managed.configured) {
      console.log(text(
        `当前面板运行在 ${managed.connection.url}，新配置（${managed.configured.url}）将在重启后生效。`,
        `The panel is currently running at ${managed.connection.url}; the configured address (${managed.configured.url}) will take effect after restart.`,
      ));
    }
    await openBrowser(managed.connection);
    return null;
  }
  if (await getHealth(configuration.values)) {
    throw new Error(text(
      '端口上已有无法由当前 mdash 指纹确认的面板，拒绝接管。',
      'A panel on this port does not match the fingerprint recorded by mdash; refusing to take it over.',
    ));
  }
  const connection = getConnection(configuration.values);
  if (await isPortOpen(connection.port)) {
    throw new Error(text(`端口 ${connection.port} 已被其他程序占用。`, `Port ${connection.port} is already in use by another program.`));
  }
  // Otherwise the new panel would only fail to take the data directory, and say so after the full 60-second wait.
  const holder = await panelDataLockHolder();
  if (holder !== null) throw new Error(serversStillStoppingMessage(holder));
  checkJava();
  return { configuration, connection };
}

function spawnServer(nonce, options) {
  return spawn(
    nodeExecutable,
    ['--no-warnings', '--experimental-sqlite', serverEntry, `--mystry-fingerprint=${nonce}`],
    { cwd: homeDir, env: childEnvironment(nonce), ...options },
  );
}

async function announceStarted({ configuration, connection }) {
  console.log(text(`面板已启动：${connection.url}`, `Panel started: ${connection.url}`));
  const credentials = configuration.needsSetup
    ? await createInitialAdmin(configuration, connection)
    : null;
  await openBrowser(configuration.values, { announce: false });
  if (credentials) {
    // When output is redirected it may end up in a log file, so the password is not written; the user can reset it at any time.
    if (process.stdout.isTTY) {
      showCredentials(text('首次启动，已创建管理员账号：', 'First run. The administrator account has been created:'), credentials);
    } else {
      console.log(text(
        `已创建管理员 ${credentials.username}。当前输出不是终端，没有显示密码；请在终端窗口里运行 ${managerCommand} reset-password 生成新密码。`,
        `Created administrator ${credentials.username}. Output is not a terminal, so the password was not shown. Run ${managerCommand} reset-password in a terminal window to generate a new one.`,
      ));
    }
  }
  await showRemoteAccessOnStart(configuration, { adminCreated: Boolean(credentials) });
}

// ---- Access the panel from other devices: first-start prompt and the remote command ----

/** Whether logged in through SSH. "No graphical interface" is not used to guess: WSL and home computers without a monitor have no graphical interface either. */
function isRemoteLogin(env = process.env) {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

const REMOTE_ERROR_TEXT = {
  'server.remoteAccess.managedByConfig': ['访问方式由配置文件里的 HOST 决定，不能用命令修改。', 'Access is set by HOST in the configuration file, so it cannot be changed with this command.'],
  'server.remoteAccess.interfaceGone': ['找不到这块网卡。运行 remote status 查看可用的网卡。', 'That network adapter was not found. Run remote status to list the adapters.'],
  'server.remoteAccess.noAddress': ['这台电脑没有其他设备能连到的网络地址。', 'This computer has no network address that other devices can reach.'],
  'server.remoteAccess.listenFailed': ['面板没能在任何地址上监听，端口可能被别的程序占用。', 'The panel could not listen on any address. The port may be in use by another program.'],
  'server.remoteAccess.certificateFailed': [`HTTPS 证书生成或读取失败。可以先运行 ${managerCommand} remote https off 改用不加密的连接。`, `The HTTPS certificate could not be created or read. You can run ${managerCommand} remote https off to use an unencrypted connection.`],
};

/** Calls the launcher endpoints that accept only this machine and LAUNCHER_TOKEN; the token does not go into output. */
async function launcherRequest(values, method, pathname, body, connection = null) {
  const targetPort = (connection ?? getConnection(values)).port;
  const response = await fetchWithTimeout(`http://127.0.0.1:${targetPort}${pathname}`, {
    method,
    headers: {
      'x-launcher-token': values?.get('LAUNCHER_TOKEN') ?? '',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 30_000);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // When it is not JSON, report the error by status code
  }
  if (!response.ok) {
    const known = REMOTE_ERROR_TEXT[payload?.code];
    throw new Error(known ? text(known[0], known[1]) : payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

const getRemoteStatus = (values, connection = null) => launcherRequest(values, 'GET', '/api/launcher/remote-access', undefined, connection);
const setDirectAccess = (values, body, connection = null) => launcherRequest(values, 'PUT', '/api/launcher/remote-access/direct', body, connection);

/** Same defaults as the UI: all interfaces, HTTPS, no source restriction; existing settings keep their security options. */
function directAccessRequest(status, overrides) {
  const current = status?.direct ?? {};
  return {
    enabled: current.enabled === true,
    interfaceName: current.interfaceName ?? null,
    restrictToSubnet: current.restrictToSubnet === true,
    https: current.https !== false,
    ...overrides,
  };
}

/** The URLs that can be opened from other devices, with notes, printed on first start, remote on and remote status. */
function remoteAccessLines(status) {
  const direct = status.direct;
  const port = status.port;
  const scheme = direct.https ? 'https' : 'http';
  const listening = direct.urls.filter((item) => item.listening);
  const outside = listening.filter((item) => item.kind === 'publicHost' || item.kind === 'public');
  const nearby = listening.filter((item) => item.kind === 'lan' || item.kind === 'overlay');
  const lines = [text('可以在你自己的电脑或手机上打开面板：', 'You can open the panel on your own computer or phone:')];
  for (const item of [...outside, ...nearby].slice(0, 6)) lines.push(`  ${item.url}`);
  if (outside.length === 0 && isRemoteLogin()) {
    lines.push(`  ${scheme}://${text('<服务器地址>', '<server address>')}:${port}/`);
    lines.push(text(
      '  · <服务器地址> 是你 SSH 登录这台服务器时用的 IP 或域名',
      '  · <server address> is the IP or domain you use to SSH into this server',
    ));
  }
  if (direct.https && status.certificate) {
    lines.push(text(
      `  · 浏览器第一次会提示「不安全」：点「高级」→「继续前往」。证书指纹（SHA-256）：${status.certificate.fingerprint256}`,
      `  · The browser warns that the site is not secure the first time. Choose Advanced, then continue. Certificate fingerprint (SHA-256): ${status.certificate.fingerprint256}`,
    ));
  }
  lines.push(text(
    `  · 打不开：去云平台控制台的安全组放行 TCP ${port}；系统防火墙是 ufw 时再运行 sudo ufw allow ${port}/tcp`,
    `  · Can't open it? Allow TCP ${port} in your cloud provider's security group. With ufw, also run sudo ufw allow ${port}/tcp`,
  ));
  lines.push(direct.https
    ? text(
      `  · 不想看到警告：运行 ${managerCommand} remote https off（连接不再加密）`,
      `  · To skip the warning, run ${managerCommand} remote https off (the connection is then not encrypted)`,
    )
    : text(
      `  · 想加密连接：运行 ${managerCommand} remote https on`,
      `  · To encrypt the connection, run ${managerCommand} remote https on`,
    ));
  return lines;
}

function remoteHintLine() {
  return text(
    `要从其他电脑或手机打开面板，运行：${managerCommand} remote on`,
    `To open the panel from another computer or phone, run: ${managerCommand} remote on`,
  );
}

async function askYesNo(question, defaultYes) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(question)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes' || answer === '是';
  } finally {
    terminal.close();
  }
}

/**
 * After the panel starts: under SSH login, explains how to open it from outside.
 * A question is asked only on first start, with the admin created, and with both input and output being terminals; otherwise only one line of hint is printed and no setting is changed.
 */
async function showRemoteAccessOnStart(configuration, { adminCreated }) {
  if (!isRemoteLogin()) return;
  let status;
  try {
    status = await getRemoteStatus(configuration.values);
  } catch {
    // When the status cannot be read (for example an older panel) only a hint is given, without affecting startup.
    console.log(remoteHintLine());
    return;
  }
  if (status.managedByConfig || status.direct.enabled) {
    console.log(remoteAccessLines(status).join('\n'));
    return;
  }
  if (!configuration.needsSetup || !adminCreated || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(remoteHintLine());
    return;
  }
  const wanted = await askYesNo(text(
    '要让你自己的电脑或手机直接打开面板吗？[Y/n] ',
    'Open the panel to your own computer or phone? [Y/n] ',
  ), true);
  if (!wanted) {
    console.log(remoteHintLine());
    return;
  }
  try {
    status = await setDirectAccess(configuration.values, directAccessRequest(status, { enabled: true }));
    console.log(remoteAccessLines(status).join('\n'));
  } catch (error) {
    console.warn(text(
      `开启失败：${error instanceof Error ? error.message : String(error)} 运行 ${managerCommand} remote on 重试。`,
      `Could not turn it on: ${error instanceof Error ? error.message : String(error)} Run ${managerCommand} remote on to try again.`,
    ));
  }
}

function printRemoteStatus(status) {
  const direct = status.direct;
  if (status.managedByConfig) {
    console.log(text(
      `从其他设备访问：由配置文件决定（HOST=${status.configuredHost}）`,
      `Access from other devices: set by the configuration file (HOST=${status.configuredHost})`,
    ));
    for (const item of direct.urls) console.log(`  ${item.url}`);
    return;
  }
  console.log(direct.enabled
    ? text('从其他设备访问：已开启', 'Access from other devices: on')
    : text('从其他设备访问：未开启', 'Access from other devices: off'));
  console.log(text(
    `  网卡：${direct.interfaceName ?? '所有网卡'}  HTTPS：${direct.https ? '开' : '关'}  只允许同一网段：${direct.restrictToSubnet ? '开' : '关'}`,
    `  Adapter: ${direct.interfaceName ?? 'all adapters'}  HTTPS: ${direct.https ? 'on' : 'off'}  Same network only: ${direct.restrictToSubnet ? 'on' : 'off'}`,
  ));
  if (direct.enabled) {
    for (const item of direct.urls) {
      console.log(`  ${item.url}${item.listening ? '' : text(`  （没有在监听${item.problem ? `：${item.problem}` : ''}）`, `  (not listening${item.problem ? `: ${item.problem}` : ''})`)}`);
    }
    if (direct.problem) console.log(text(`  问题：${direct.problem}`, `  Problem: ${direct.problem}`));
  }
  if (status.certificate) {
    console.log(text(
      `  证书指纹（SHA-256）：${status.certificate.fingerprint256}`,
      `  Certificate fingerprint (SHA-256): ${status.certificate.fingerprint256}`,
    ));
    console.log(text(`  证书有效期至：${status.certificate.notAfter}`, `  Certificate valid until: ${status.certificate.notAfter}`));
  }
  if (status.interfaces.length > 0) {
    console.log(text('  可用网卡：', '  Adapters:'));
    for (const entry of status.interfaces) console.log(`    ${entry.name}  ${entry.address}  (${entry.kind})`);
  }
}

function remoteUsage() {
  return text(
    `用法：${managerCommand} remote [status | on [网卡名] | off | https on | https off | renew-cert]`,
    `Usage: ${managerCommand} remote [status | on [adapter] | off | https on | https off | renew-cert]`,
  );
}

/** The remote commands. The launcher does not read or write the database directly; everything goes through the panel's launcher endpoints, so the panel must be running. */
async function remoteCommand(args) {
  const [action = '', argument] = args;
  const values = await loadConfiguration();
  const managed = await findManagedPanel(values, await readState());
  if (!managed) {
    if (action === 'status') {
      console.log(text('状态：未运行', 'Status: stopped'));
      return;
    }
    throw new Error(text('面板未运行。请先启动面板。', 'The panel is not running. Start it first.'));
  }
  const connection = managed.connection;
  if (action === 'status') {
    printRemoteStatus(await getRemoteStatus(values, connection));
    return;
  }
  if (action === '') {
    // "Access from other devices" in the menu: shows the status, and can toggle it directly in a terminal.
    const status = await getRemoteStatus(values, connection);
    printRemoteStatus(status);
    if (status.managedByConfig || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const enable = !status.direct.enabled;
    const confirmed = await askYesNo(enable
      ? text('\n现在开启吗？[y/N] ', '\nTurn it on now? [y/N] ')
      : text('\n现在关闭吗？[y/N] ', '\nTurn it off now? [y/N] '), false);
    if (!confirmed) return;
    const next = await setDirectAccess(values, directAccessRequest(status, { enabled: enable }), connection);
    console.log(enable ? remoteAccessLines(next).join('\n') : text('已关闭从其他设备访问。', 'Access from other devices is off.'));
    return;
  }
  if (action === 'on') {
    const status = await getRemoteStatus(values, connection);
    const next = await setDirectAccess(values, directAccessRequest(status, { enabled: true, interfaceName: argument ?? null }), connection);
    console.log(remoteAccessLines(next).join('\n'));
    return;
  }
  if (action === 'off') {
    const status = await getRemoteStatus(values, connection);
    await setDirectAccess(values, directAccessRequest(status, { enabled: false }), connection);
    console.log(text('已关闭从其他设备访问。', 'Access from other devices is off.'));
    return;
  }
  if (action === 'https' && (argument === 'on' || argument === 'off')) {
    const status = await getRemoteStatus(values, connection);
    const next = await setDirectAccess(values, directAccessRequest(status, { https: argument === 'on' }), connection);
    console.log(argument === 'on'
      ? text('已开启 HTTPS。', 'HTTPS is on.')
      : text('已关闭 HTTPS，连接不再加密。', 'HTTPS is off. The connection is no longer encrypted.'));
    if (next.direct.enabled) console.log(remoteAccessLines(next).join('\n'));
    return;
  }
  if (action === 'renew-cert') {
    const next = await launcherRequest(values, 'POST', '/api/launcher/remote-access/certificate', undefined, connection);
    console.log(text(
      `已重新生成证书，浏览器需要重新确认一次。新指纹（SHA-256）：${next.certificate?.fingerprint256 ?? ''}`,
      `The certificate was regenerated, and browsers will ask you to confirm again. New fingerprint (SHA-256): ${next.certificate?.fingerprint256 ?? ''}`,
    ));
    return;
  }
  throw new Error(remoteUsage());
}

/** A background panel has no window and users easily assume it has exited, so every background start says so clearly. */
function showDaemonReminder() {
  console.log(text(
    `提醒：面板在后台运行，没有窗口，不会自动停止。要停止时运行：${managerCommand} stop`,
    `Reminder: the panel runs in the background with no window, and it does not stop on its own. To stop it, run: ${managerCommand} stop`,
  ));
}

async function startBackground() {
  const prepared = await prepareStart();
  if (!prepared) return;
  const { configuration, connection } = prepared;
  await rotateLogs();
  const nonce = crypto.randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  const stdout = fs.openSync(stdoutLog, 'a', 0o600);
  const stderr = fs.openSync(stderrLog, 'a', 0o600);
  const child = spawnServer(nonce, {
    detached: true,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.unref();
  await writeState(child.pid, startedAt, nonce, connection.url);

  if (!(await waitForHealth(configuration.values, nonce))) {
    if (isProcessAlive(child.pid)) child.kill();
    await clearState();
    const recent = await readRecentLogs(40);
    if (recent) console.error(recent);
    throw new Error(text('面板未能在 60 秒内启动，请检查日志。', 'The panel did not start within 60 seconds. Check the logs.'));
  }
  await announceStarted(prepared);
}

const LOG_LEVEL_LABELS = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const REQUEST_LOG_MESSAGES = new Set(['incoming request', 'request completed']);

/** Turns a line of server JSON log into short human-readable text; returns null for per-request records, and lines that are not JSON as is. */
function formatForegroundLogLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof entry?.msg !== 'string' || !Number.isFinite(entry.time)) return line;
  if (entry.quiet === true || REQUEST_LOG_MESSAGES.has(entry.msg)) return null;
  const time = new Date(entry.time).toTimeString().slice(0, 8);
  return `${time} ${(LOG_LEVEL_LABELS[entry.level] ?? 'LOG').padEnd(5)} ${entry.msg}`;
}

/** The foreground window shows only readable logs, while the full raw log is still written to the log file, so nothing is lost for troubleshooting. */
function relayForegroundLogs(stream) {
  // After the window closes the output is no longer valid while the panel is still shutting down safely, and a failed write to the screen must not interrupt forwarding.
  process.stdout.on('error', () => {});
  const rawLog = fs.createWriteStream(stdoutLog, { flags: 'a', mode: 0o600 });
  rawLog.on('error', () => {});
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', (line) => {
    rawLog.write(`${line}\n`);
    const formatted = formatForegroundLogLine(line);
    if (formatted !== null) console.log(formatted);
  });
  lines.once('close', () => rawLog.end());
}

// When the user ends it deliberately the window closes directly, with no need to press Enter again.
let windowCanClose = false;

async function startForeground() {
  const prepared = await prepareStart();
  if (!prepared) return;
  const { configuration, connection } = prepared;
  await rotateLogs();
  const nonce = crypto.randomBytes(16).toString('hex');
  const startedAt = new Date().toISOString();
  const child = spawnServer(nonce, { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: false });
  relayForegroundLogs(child.stdout);
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  await writeState(child.pid, startedAt, nonce, connection.url);

  // on rather than once: on a second Ctrl+C the controller must not be killed first by the default action, and has to wait for the panel to finish closing on its own.
  // Ctrl+C in a Windows console already reaches the panel in the same console; and Node's
  // child.kill('SIGINT') on Windows is a forced termination, so forwarding would interrupt the safe shutdown instead, which is why Windows does not forward.
  const forwardInterrupt = () => {
    if (process.platform === 'win32') return;
    if (isProcessAlive(child.pid)) child.kill('SIGINT');
  };
  const forwardTerminate = () => {
    if (isProcessAlive(child.pid)) child.kill('SIGTERM');
  };
  // When the window closes the panel receives SIGHUP itself too; the controller has to stay alive until the panel finishes closing, or the pipe the panel logs to would break.
  const keepRelayingOnHangup = () => {};
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  process.on('SIGHUP', keepRelayingOnHangup);
  try {
    if (!(await waitForHealth(configuration.values, nonce))) {
      if (isProcessAlive(child.pid)) child.kill('SIGTERM');
      await exitPromise.catch(() => 1);
      throw new Error(text('面板未能在 60 秒内启动，请检查前台输出。', 'The panel did not start within 60 seconds. Check the output above.'));
    }
    await releaseCurrentManagerLock();
    windowCanClose = true;
    await announceStarted(prepared);
    console.log(text(
      `窗口只显示重要日志，完整日志在：${stdoutLog}\n按 Ctrl+C 停止面板。有服务端在运行时不要直接关窗口。`,
      `This window shows important logs only. Full log: ${stdoutLog}\nPress Ctrl+C to stop the panel. Do not just close this window while a server is running.`,
    ));
    const exitCode = await exitPromise;
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTerminate);
    process.off('SIGHUP', keepRelayingOnHangup);
    await clearState();
  }
}

const WATCH_POLL_MS = 500;

/**
 * Reads the complete lines newly added to the log file, leaving an unfinished last line for the next round. A new file after rotation is
 * read from the start. It is recognised by its file ID, not by being shorter: the new file can already be longer than the old one, and its
 * creation time is no help because NTFS gives a file recreated under the same name within seconds the old one's.
 */
async function readNewLogLines(cursor) {
  let handle;
  try {
    handle = await fsp.open(stdoutLog, 'r');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    if ((cursor.ino !== undefined && stat.ino !== cursor.ino) || size < cursor.offset) {
      cursor.offset = 0;
      cursor.partial = Buffer.alloc(0);
    }
    cursor.ino = stat.ino;
    if (size === cursor.offset) return [];
    const chunk = Buffer.alloc(size - cursor.offset);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor.offset);
    cursor.offset += bytesRead;
    const data = Buffer.concat([cursor.partial, chunk.subarray(0, bytesRead)]);
    const lineEnd = data.lastIndexOf(0x0a);
    cursor.partial = data.subarray(lineEnd + 1);
    return lineEnd < 0 ? [] : data.subarray(0, lineEnd).toString('utf8').split(/\r?\n/);
  } finally {
    await handle.close();
  }
}

/** Listens for Ctrl+C. Once the terminal is in raw mode it is just a key, and the batch file no longer asks "Terminate batch job?". */
function onStopKey(callback) {
  const rawTerminal = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  const onKey = (chunk) => {
    if (chunk.includes(0x03)) callback();
  };
  if (rawTerminal) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', onKey);
    process.stdin.resume();
  }
  process.on('SIGINT', callback);
  return () => {
    process.off('SIGINT', callback);
    if (!rawTerminal) return;
    process.stdin.off('data', onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

async function stopWithLock() {
  const releaseLock = await acquireManagerLock();
  try {
    await stopPanel();
  } finally {
    await releaseLock();
  }
}

/**
 * After the watched panel exits: the panel that a restart from another window started in its place, or null when it was stopped.
 * A restart holds the manager lock from before it stops the old panel until the new one answers, so waiting for the lock leaves no gap
 * that could be misread as a stop. A restart run from a window opened as administrator is such a restart.
 */
async function panelRestartedElsewhere(previous) {
  while (managerLockHolder() !== null) await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
  const state = await readState();
  if (!state?.fingerprint || state.fingerprint === previous?.fingerprint) return null;
  return await isManagedPanelRunning(await loadConfiguration(), state) ? state : null;
}

/** The viewer window only reads the log file and has no process relationship with the panel, so closing it does not affect the panel or the servers. */
async function watchPanel() {
  let state = await readState();
  console.log(text(
    `提醒：面板和服务端作为 daemon 在后台运行，没有单独的窗口。\n关闭这个窗口后它们会继续运行，不会自动停止。\n要停止时：重新打开 ${managerCommand}，按 Ctrl+C 安全停止。关机或重启前也请先停止。\n这里只显示重要日志，完整日志在：${stdoutLog}\n`,
    `Reminder: the panel and your servers run in the background as a daemon, with no window of their own.\nThey keep running after you close this window, and they do not stop on their own.\nTo stop them, open ${managerCommand} again and press Ctrl+C to stop safely. Do this before you shut down or restart too.\nThis window shows important logs only. Full log: ${stdoutLog}\n`,
  ));
  const cursor = {
    offset: fs.existsSync(stdoutLog) ? fs.statSync(stdoutLog).size : 0,
    ino: fs.existsSync(stdoutLog) ? fs.statSync(stdoutLog, { bigint: true }).ino : undefined,
    partial: Buffer.alloc(0),
  };
  const printNewLogs = async () => {
    for (const line of await readNewLogLines(cursor)) {
      const formatted = formatForegroundLogLine(line);
      if (formatted !== null) console.log(formatted);
    }
  };
  let stopping = null;
  let stopSettled = false;
  const stopListening = onStopKey(() => {
    if (stopping) return;
    console.log(text('正在安全停止面板和服务端，请稍候…', 'Safely stopping the panel and servers. Please wait…'));
    stopping = stopWithLock().finally(() => {
      stopSettled = true;
    });
    // The error is thrown after the loop ends; this only avoids an unhandled rejection.
    stopping.catch(() => {});
  });
  try {
    for (;;) {
      while (isProcessAlive(state?.pid) && !stopSettled) {
        await printNewLogs();
        await new Promise((resolve) => setTimeout(resolve, WATCH_POLL_MS));
      }
      await printNewLogs();
      if (stopping) break;
      const next = await panelRestartedElsewhere(state);
      if (!next || stopping) break;
      state = next;
      console.log(text(
        '\n面板已在另一个窗口中重启，这里接着显示它的日志。\n',
        '\nThe panel was restarted from another window. This window keeps showing its logs.\n',
      ));
    }
    if (stopping) {
      await stopping;
      windowCanClose = true;
      return;
    }
  } finally {
    stopListening();
  }
  console.log(text('面板已经停止。', 'The panel has stopped.'));
}

async function startAndWatch() {
  const releaseLock = await acquireManagerLock();
  try {
    await startBackground();
  } finally {
    await releaseLock();
  }
  await watchPanel();
}

async function stopPanel() {
  const values = await loadConfiguration();
  const state = await readState();
  const managed = await findManagedPanel(values, state);
  if (!managed) {
    if (values && await getHealth(values)) {
      throw new Error(text(
        '检测到面板服务，但 PID 或进程指纹不匹配；拒绝停止未知进程。',
        'A panel is responding, but its PID or process fingerprint does not match; refusing to stop an unknown process.',
      ));
    }
    const holder = await panelStillShuttingDown(values, state);
    if (holder !== null) throw new Error(serversStillStoppingMessage(holder));
    if (!isProcessAlive(state?.pid)) await clearState();
    console.log(text('面板未运行。', 'The panel is not running.'));
    return;
  }
  const launcherToken = values?.get('LAUNCHER_TOKEN');
  if (!launcherToken || !SECRET_PATTERN.test(launcherToken)) {
    throw new Error(text('LAUNCHER_TOKEN 缺失或格式无效，无法安全停止面板。', 'LAUNCHER_TOKEN is missing or invalid; cannot stop the panel safely.'));
  }
  if (managed.portChanged && managed.configured) {
    console.log(text(
      `当前配置端口（${managed.configured.port}）与运行中的面板（${managed.connection.url}）不同，将停止运行中的面板。`,
      `Configured port (${managed.configured.port}) differs from the running panel (${managed.connection.url}); stopping the running panel.`,
    ));
  }
  const connection = managed.connection;
  const response = await fetchWithTimeout(
    connection.shutdownUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Launcher-Token': launcherToken,
      },
      body: '{}',
    },
    10_000,
  );
  const summary = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(summary?.error || text(`安全停止请求失败：HTTP ${response.status}`, `Safe shutdown request failed: HTTP ${response.status}`));
  }
  const [instances, running, queued] = [summary.runningInstances ?? 0, summary.runningTasks ?? 0, summary.queuedTasks ?? 0];
  console.log(text(
    `正在停止：${instances} 个实例，${running} 个运行任务，${queued} 个排队任务。`,
    `Stopping: ${instances} instance(s), ${running} running task(s), ${queued} queued task(s).`,
  ));

  // Per server: the panel's two stop attempts of 15 seconds each, and time for the server to save after the second one.
  const timeoutMs = Number(process.env.MYSTRY_TEST_STOP_TIMEOUT_MS) || Math.min(
    30 * 60_000,
    60_000
      + 45_000 * Number(summary.runningInstances ?? 0)
      + 60_000 * Number(summary.runningTasks ?? 0),
  );
  const deadline = Date.now() + timeoutMs;
  let waitingForServers = false;
  let heldSince = null;
  while (Date.now() < deadline) {
    if (!(await getHealthForConnection(connection, state.fingerprint))) {
      // The panel stops answering before its servers are sure to be gone; while one is still running it keeps the data directory.
      if ((await panelDataLockHolder()) === null) {
        await clearState();
        console.log(text('面板已停止。', 'The panel has stopped.'));
        await warnServersLeftRunning();
        return;
      }
      heldSince ??= Date.now();
      // A panel with nothing left running also holds it for a moment after it stops answering; that is not worth a message.
      if (!waitingForServers && Date.now() - heldSince >= 3000) {
        waitingForServers = true;
        console.log(text(
          '面板已不再接收请求，正在等它启动的 Minecraft 服务器退出…',
          'The panel no longer takes requests and is waiting for the Minecraft servers it started to exit…',
        ));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const holder = await panelDataLockHolder();
  // State is kept: the process is still there, and a restart must not go on to start a second panel.
  if (heldSince !== null && holder !== null) throw new Error(serversStillStoppingMessage(holder));
  throw new Error(text(
    `面板安全停止超时；为保护游戏数据，${managerCommand} 不会按 PID 强制结束进程。`,
    `Timed out waiting for the panel to stop. To protect game data, ${managerCommand} will not force-kill it by PID.`,
  ));
}

async function showStatus() {
  const values = await loadConfiguration();
  const state = await readState();
  const managed = await findManagedPanel(values, state);
  if (managed) {
    console.log(text(`状态：运行中  ${managed.connection.url}`, `Status: running  ${managed.connection.url}`));
    if (managed.urlChanged && managed.configured) {
      console.log(text(
        `当前配置已改为 ${managed.configured.url}，重启面板后生效。`,
        `Configuration now specifies ${managed.configured.url}; restart the panel to apply it.`,
      ));
    }
    if (state?.pid) console.log(text(`PID：${state.pid}`, `PID: ${state.pid}`));
    return;
  }
  const holder = await panelStillShuttingDown(values, state);
  if (holder !== null) {
    console.log(text(`状态：正在关闭（PID ${holder}）`, `Status: shutting down (PID ${holder})`));
    console.warn(serversStillStoppingMessage(holder));
    return;
  }
  console.log(text('状态：未运行', 'Status: stopped'));
  await warnServersLeftRunning();
  if (values && await getHealth(values)) {
    console.warn(text(
      '配置端口存在面板服务，但 PID 或进程指纹不匹配；不会自动接管或停止。',
      'A panel is responding on the configured port, but its PID or process fingerprint does not match; it will not be taken over or stopped.',
    ));
    return;
  }
  if (isProcessAlive(state?.pid)) {
    console.warn(text(
      `检测到 PID ${state.pid} 仍存在，但健康检查不匹配；不会自动结束该进程。`,
      `PID ${state.pid} still exists but does not pass the health check; it will not be ended automatically.`,
    ));
  }
}

async function readRecentLogs(limit = 100) {
  const sections = [];
  const sources = [
    [text('最近的错误输出', 'Recent stderr'), stderrLog],
    [text('最近的标准输出', 'Recent stdout'), stdoutLog],
  ];
  for (const [label, filePath] of sources) {
    if (!fs.existsSync(filePath)) continue;
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    sections.push(`--- ${label} ---\n${lines.slice(-limit).join('\n')}`);
  }
  return sections.join('\n');
}

async function showLogs() {
  const content = await readRecentLogs();
  if (!content) {
    console.log(text('暂无日志。', 'No logs yet.'));
    return;
  }
  console.log(content);
}

function printHelp() {
  const commands = [
    ['start', '后台启动面板', 'Start the panel in the background'],
    ['foreground', '前台启动面板，关窗口时面板也会退出', 'Start the panel in the foreground. Closing the window also stops the panel'],
    ['stop', '安全停止面板及实例', 'Safely stop the panel and its instances'],
    ['restart', '安全重启面板', 'Safely restart the panel'],
    ...(portableMode ? [] : [['rebuild', '重新安装依赖并构建，然后重启面板', 'Reinstall dependencies, build, then restart the panel']]),
    ['status', '查看状态', 'Show status'],
    ['logs', '查看最近日志', 'Show recent logs'],
    ['open', '打开管理页面', 'Open the dashboard'],
    ['reset-password', '重置管理员密码（面板运行时）', 'Reset the administrator password (while the panel is running)'],
    ['remote on', '允许其他设备打开面板（面板运行时；可加网卡名）', 'Let other devices open the panel (while it is running; optionally name an adapter)'],
    ['remote off', '只允许这台电脑打开面板', 'Only allow this computer to open the panel'],
    ['remote status', '查看从其他设备访问的状态、网址和证书指纹', 'Show access from other devices: status, addresses and certificate fingerprint'],
    ['remote https', '开关 HTTPS：remote https on / off', 'Turn HTTPS on or off: remote https on / off'],
    ['remote renew-cert', '重新生成 HTTPS 证书', 'Regenerate the HTTPS certificate'],
    ...(portableMode ? [
      ['watch', '后台启动面板并查看日志（双击时的默认操作）', 'Start the panel in the background and watch its logs (what double-clicking does)'],
      ['menu', '打开管理菜单', 'Open the management menu'],
    ] : []),
    ...(portableMode ? [] : [['mirror', '查看或切换 npm 下载源', 'Show or change the npm download source']]),
    ['help', '显示帮助', 'Show this help'],
  ];
  console.log([
    text(`Mystry Dashboard ${managerLabel}管理器`, `Mystry Dashboard ${managerLabel} Manager`),
    '',
    text(`用法：${managerCommand} <command>`, `Usage: ${managerCommand} <command>`),
    '',
    text('命令：', 'Commands:'),
    ...commands.map(([name, zh, en]) => `  ${name.padEnd(20)}${text(zh, en)}`),
    '',
    text('启动器不会注册系统服务，也不会配置开机启动。', 'The launcher does not register a system service or start at boot.'),
  ].join('\n'));
}

// Menu items: [key, command, description]. A bare Enter equals 1, and unrecognized input shows help.
const RUNNING_MENU = [
  ['1', 'open', text('打开面板（直接回车）', 'Open the panel (Enter)')],
  ['2', 'logs', text('查看日志', 'View logs')],
  ['3', 'restart', text('重启面板', 'Restart the panel')],
  ['4', 'stop', text('停止面板', 'Stop the panel')],
  ['5', 'reset-password', text('重置管理员密码', 'Reset the administrator password')],
  ['6', 'remote', text('从其他设备访问', 'Access from other devices')],
];
const STOPPED_MENU = [
  ['1', 'start', text('后台启动面板（直接回车）', 'Start the panel in the background (Enter)')],
  ['2', 'watch', text('启动并查看日志', 'Start and watch the logs')],
  ['3', 'logs', text('查看最近日志', 'View recent logs')],
];

async function interactiveMenu() {
  const values = await loadConfiguration();
  const state = await readState();
  const running = await isManagedPanelRunning(values, state);
  const menu = running ? RUNNING_MENU : STOPPED_MENU;
  console.log(text(`Mystry Dashboard ${managerLabel}`, `Mystry Dashboard (${managerLabel})`));
  const holder = running ? null : await panelStillShuttingDown(values, state);
  if (running) console.log(text('状态：运行中', 'Status: running'));
  else if (holder !== null) console.log(text(`状态：正在关闭（PID ${holder} 在等 Minecraft 服务器退出）`, `Status: shutting down (PID ${holder} is waiting for Minecraft servers to exit)`));
  else {
    console.log(text('状态：未运行', 'Status: stopped'));
    await warnServersLeftRunning();
  }
  console.log('');
  for (const [key, , label] of menu) console.log(`[${key}] ${label}`);
  console.log(text('[0] 退出', '[0] Exit'));
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(text('\n请选择：', '\nChoose: '))).trim() || '1';
    if (answer === '0') return null;
    return menu.find(([key]) => key === answer)?.[1] ?? 'help';
  } finally {
    terminal.close();
  }
}

/** When started by double-click the console window closes as soon as the process exits, so wait for Enter first, keeping the result, token hint and errors on screen. */
async function waitForCloseKey() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question(text('\n按回车键关闭窗口…', '\nPress Enter to close this window…'));
  } finally {
    terminal.close();
  }
}

async function runCommand(command, args = []) {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'status') {
    await showStatus();
    return;
  }
  if (command === 'logs') {
    await showLogs();
    return;
  }
  if (command === 'open') {
    const values = await loadConfiguration();
    const managed = await findManagedPanel(values, await readState());
    await openBrowser(managed ? managed.connection : values);
    return;
  }
  if (command === 'reset-password') {
    await resetPassword();
    return;
  }
  if (command === 'remote') {
    await remoteCommand(args);
    return;
  }
  if (command === 'watch') {
    await startAndWatch();
    return;
  }

  const releaseLock = await acquireManagerLock();
  try {
    if (command === 'start') {
      await startBackground();
      showDaemonReminder();
      return;
    }
    if (command === 'foreground') {
      await startForeground();
      return;
    }
    if (command === 'stop') {
      await stopPanel();
      return;
    }
    if (command === 'restart') {
      await stopPanel();
      await startBackground();
      showDaemonReminder();
      return;
    }
    throw new Error(text(`未知命令：${command}`, `Unknown command: ${command}`));
  } finally {
    await releaseLock();
  }
}

async function main() {
  if (process.argv[2] === INTERNAL_IS_RUNNING) {
    const running = await isManagedPanelRunning(await loadConfiguration(), await readState());
    process.exitCode = running ? 0 : 1;
    return;
  }
  const command = process.argv[2];
  if (command && command !== 'menu') {
    await runCommand(command, process.argv.slice(3));
    return;
  }
  if (!process.stdin.isTTY) {
    printHelp();
    return;
  }
  if (command === 'menu') {
    const selected = await interactiveMenu();
    if (!selected) return;
    await runAndHoldWindow(selected);
    return;
  }
  // No arguments and a terminal: usually started by double-click. The panel goes to the background, and the window is only for viewing the account and logs.
  await runAndHoldWindow('watch');
}

/** Pauses after a command run interactively ends, keeping the result and errors on screen; no key press is needed when the user stops the panel successfully with Ctrl+C. */
async function runAndHoldWindow(command) {
  try {
    await runCommand(command);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (!process.exitCode && windowCanClose) return;
  await waitForCloseKey();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
