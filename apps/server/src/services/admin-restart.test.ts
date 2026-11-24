import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-admin-restart-'));
// config refuses to load without these secrets (CI has no .env); the one-click restart also needs a panel the launcher started.
process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
process.env.MYSTRY_DATA_DIR = path.join(root, 'data');
process.env.MYSTRY_PROCESS_FINGERPRINT = 'test-fingerprint';
const launcher = path.join(root, 'mdash.cmd');
fs.writeFileSync(launcher, '@echo off\r\n');
process.env.MYSTRY_LAUNCHER = launcher;

const {
  adminRestartAvailable,
  readAdminPrefs,
  requestAdminRestart,
  setAdminRestartForTests,
  setStartAsAdmin,
  startsAsAdmin,
} = await import('./admin-restart.js');
const { setWindowsElevationForTests } = await import('./windows-elevation.js');

/** whoami /groups /fo csv /nh for an account that is or is not in Administrators, elevated or not. */
function groups(elevated: boolean, administrator: boolean): string {
  const label = elevated
    ? '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""\r\n'
    : '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""\r\n';
  const admins = administrator ? '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n' : '';
  return `"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n${admins}${label}`;
}

function windowsAccount(elevated: boolean, administrator: boolean): void {
  setWindowsElevationForTests({ platform: 'win32', runner: async () => groups(elevated, administrator) });
}

const prefsFile = path.join(root, 'data', 'launcher', 'admin.json');

test.after(() => {
  setAdminRestartForTests(null);
  setWindowsElevationForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the one-click restart is offered only to this computer, for an unelevated administrator account, with the launcher it can reopen', async () => {
  const opened: string[] = [];
  setAdminRestartForTests({ platform: 'win32', runner: async (args) => { opened.push(args); return 'started'; } });

  windowsAccount(false, true);
  assert.equal(await adminRestartAvailable(true), true);
  // The Windows prompt appears on the screen of the computer running the panel.
  assert.equal(await adminRestartAvailable(false), false);

  windowsAccount(true, true);
  assert.equal(await adminRestartAvailable(true), false);
  // A standard account would be asked for another account's password and the panel would then run as that account.
  windowsAccount(false, false);
  assert.equal(await adminRestartAvailable(true), false);
  setWindowsElevationForTests({ platform: 'win32', runner: async () => { throw new Error('whoami failed'); } });
  assert.equal(await adminRestartAvailable(true), false);

  windowsAccount(false, true);
  // The launcher reports a launcher only when a bare restart finds the same config and data; a path cmd could misread is refused too.
  for (const value of ['', 'mdash.cmd', path.join(root, 'other.cmd'), path.join(root, 'a&b', 'mdash.cmd'), path.join(root, 'missing', 'mdash.cmd')]) {
    process.env.MYSTRY_LAUNCHER = value;
    assert.equal(await adminRestartAvailable(true), false, value);
  }
  process.env.MYSTRY_LAUNCHER = launcher;
  assert.equal(await adminRestartAvailable(true), true);

  setAdminRestartForTests({ platform: 'linux', runner: async () => { throw new Error('must not run'); } });
  assert.equal(await adminRestartAvailable(true), false);
  assert.deepEqual(opened, []);
});

test('a declined prompt leaves the saved choice as it was; an accepted one keeps the choice and marks the restart as the page\'s', async () => {
  windowsAccount(false, true);
  const opened: string[] = [];
  let outcome: 'started' | 'cancelled' | 'failed' = 'cancelled';
  setAdminRestartForTests({ platform: 'win32', runner: async (args) => { opened.push(args); return outcome; } });

  await assert.rejects(requestAdminRestart(true, true), (err: { messageKey?: string }) => err.messageKey === 'server.lan.adminRestartCancelled');
  assert.equal(fs.existsSync(prefsFile), false);
  assert.equal(startsAsAdmin(), false);

  outcome = 'failed';
  await assert.rejects(requestAdminRestart(true, true), (err: { messageKey?: string }) => err.messageKey === 'server.lan.adminRestartFailed');
  assert.equal(fs.existsSync(prefsFile), false);

  outcome = 'started';
  await requestAdminRestart(true, true);
  // cmd /c keeps the window open only when the restart fails, so its reason stays on screen.
  assert.deepEqual(opened.at(-1), `/c ""${launcher}" restart || pause"`);
  const prefs = readAdminPrefs();
  assert.equal(prefs.startAsAdmin, true);
  assert.equal(typeof prefs.panelRestartRequestedAt, 'string');
  assert.equal(startsAsAdmin(), true);

  // Without "remember", only this restart is marked.
  await requestAdminRestart(false, true);
  assert.equal(readAdminPrefs().startAsAdmin, false);
  assert.equal(typeof readAdminPrefs().panelRestartRequestedAt, 'string');

  await assert.rejects(requestAdminRestart(true, false), (err: { messageKey?: string }) => err.messageKey === 'server.lan.adminRestartUnavailable');
  fs.rmSync(prefsFile, { force: true });
});

test('only one prompt at a time, and the remembered choice can be turned off without restarting anything', async () => {
  windowsAccount(false, true);
  let answer: (outcome: 'started') => void = () => {};
  let opened = 0;
  setAdminRestartForTests({
    platform: 'win32',
    runner: () => {
      opened += 1;
      return new Promise((resolve) => { answer = resolve; });
    },
  });
  const first = requestAdminRestart(true, true);
  // Let the first request reach the runner before the second one asks.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(requestAdminRestart(true, true), (err: { messageKey?: string }) => err.messageKey === 'server.lan.adminRestartBusy');
  answer('started');
  await first;
  assert.equal(opened, 1);

  setStartAsAdmin(false);
  assert.equal(startsAsAdmin(), false);
  // The restart mark is still there for the launcher; with neither left, the file goes away.
  assert.equal(fs.existsSync(prefsFile), true);
  fs.writeFileSync(prefsFile, JSON.stringify({ version: 1, startAsAdmin: true }));
  setStartAsAdmin(false);
  assert.equal(fs.existsSync(prefsFile), false);

  setAdminRestartForTests({ platform: 'linux', runner: async () => 'started' });
  assert.throws(() => setStartAsAdmin(true), (err: { messageKey?: string }) => err.messageKey === 'server.lan.adminRestartUnavailable');
});
