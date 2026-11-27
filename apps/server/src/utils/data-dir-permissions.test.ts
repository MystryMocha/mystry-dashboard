/**
 * Data directory Unix permission regression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a new directory should be 0700 on Unix', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-new-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { ensureSecureDirectory } = await import('./data-dir-permissions.js');
  const nested = path.join(root, 'instances');
  ensureSecureDirectory(nested);
  const mode = fs.statSync(nested).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('forceSecureSensitiveFile should tighten a new file to 0600 immediately', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-force-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'panel.db');
  fs.writeFileSync(file, 'db');
  const { forceSecureSensitiveFile } = await import('./data-dir-permissions.js');
  forceSecureSensitiveFile(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('overly permissive permissions should refuse startup', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-data-perm-bad-'));
  t.after(() => {
    delete process.env.MYSTRY_REPAIR_DATA_PERMISSIONS;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.chmodSync(root, 0o755);
  const { ensureSecureDirectory, DataDirPermissionError } = await import('./data-dir-permissions.js');
  assert.throws(() => ensureSecureDirectory(root), DataDirPermissionError);
  process.env.MYSTRY_REPAIR_DATA_PERMISSIONS = '1';
  ensureSecureDirectory(root);
  const mode = fs.statSync(root).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('Unix owner mismatch error explains both uids and how to recover with chown', async () => {
  const { formatUnixOwnerMismatch } = await import('./data-dir-permissions.js');
  const message = formatUnixOwnerMismatch('/opt/mystry/data', 0, 1001);
  assert.match(message, /uid 0/);
  assert.match(message, /1001/);
  assert.match(message, /\/opt\/mystry\/data/);
  assert.match(message, /chown/);
});

test('Windows ACL parser distinguishes secure ACLs from permissive inherited principals', async () => {
  const {
    findPermissiveWindowsPrincipals,
    inspectWindowsDirectoryAcl,
    parseIcaclsOutput,
    parseWindowsUserIdentity,
    resetWindowsAclCheckForTests,
    takeStartupNotices,
    warnWindowsAclBoundary,
  } = await import('./data-dir-permissions.js');

  const identity = parseWindowsUserIdentity('"MYSTRYHOST\\player","S-1-5-21-100-200-300-1001"\r\n');
  assert.deepEqual(identity, { account: 'MYSTRYHOST\\player', sid: 'S-1-5-21-100-200-300-1001' });

  const target = 'D:\\mystry\\data';
  const tightOutput = [
    `${target} MYSTRYHOST\\player:(OI)(CI)(F)`,
    '               NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '               BUILTIN\\Administrators:(OI)(CI)(F)',
    '               Mandatory Label\\High Mandatory Level:(OI)(NP)(IO)(NW)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  assert.deepEqual(
    findPermissiveWindowsPrincipals(parseIcaclsOutput(tightOutput, target), identity),
    [],
  );

  const permissiveOutput = [
    `${target} BUILTIN\\Administrators:(I)(OI)(CI)(F)`,
    '               NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
    '               BUILTIN\\Users:(I)(OI)(CI)(RX)',
    '               NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(M)',
    '               S-1-5-21-100-200-300-1002:(OI)(CI)(M)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  assert.deepEqual(
    findPermissiveWindowsPrincipals(parseIcaclsOutput(permissiveOutput, target), identity),
    ['BUILTIN\\Users', 'NT AUTHORITY\\Authenticated Users', 'S-1-5-21-100-200-300-1002'],
  );

  const makeRunner = (icaclsOut: string, status = 0) => (executable: string) => {
    if (executable.toLowerCase().endsWith('whoami.exe')) {
      return { status: 0, stdout: '"MYSTRYHOST\\player","S-1-5-21-100-200-300-1001"\r\n', stderr: '' };
    }
    return { status, stdout: icaclsOut, stderr: status === 0 ? '' : 'Access is denied' };
  };

  assert.deepEqual(inspectWindowsDirectoryAcl(target, makeRunner(tightOutput)), { status: 'secure' });
  assert.deepEqual(inspectWindowsDirectoryAcl(target, makeRunner(permissiveOutput)), {
    status: 'permissive',
    principals: ['BUILTIN\\Users', 'NT AUTHORITY\\Authenticated Users', 'S-1-5-21-100-200-300-1002'],
  });
  assert.equal(inspectWindowsDirectoryAcl(target, makeRunner('', 5)).status, 'unverified');

  if (process.platform === 'win32') {
    resetWindowsAclCheckForTests();
    warnWindowsAclBoundary(target, makeRunner(tightOutput));
    assert.deepEqual(takeStartupNotices(), []);

    resetWindowsAclCheckForTests();
    warnWindowsAclBoundary(target, makeRunner(permissiveOutput));
    const notices = takeStartupNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /BUILTIN\\Users/);
    assert.match(notices[0]!, /Authenticated Users/);

    resetWindowsAclCheckForTests();
    warnWindowsAclBoundary(target, makeRunner('', 5));
    const unverifiedNotices = takeStartupNotices();
    assert.equal(unverifiedNotices.length, 1);
    assert.match(unverifiedNotices[0]!, /无法在 Windows 上自动验证/);
    resetWindowsAclCheckForTests();
  }
});
