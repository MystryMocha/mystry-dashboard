/**
 * Console history framing and ANSI JSON-escape budgeting regression.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ConsoleMessage } from '@mystry/shared';
import type { InstanceRow } from '../db.js';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

function fakeChild(): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid: Math.floor(Math.random() * 100_000) + 10_000,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  setImmediate(() => child.emit('spawn'));
  return child;
}

test('fitConsoleHistory trims dense ANSI escapes, quotes, newlines and surrogate pairs to JSON UTF-8 budget', async () => {
  const { fitConsoleHistory, jsonEscapedCharBytes } = await import('./console.js');
  assert.equal(jsonEscapedCharBytes(0x1B), 6);
  assert.equal(jsonEscapedCharBytes(0x0A), 2);
  assert.equal(jsonEscapedCharBytes(0x22), 2);
  assert.equal(jsonEscapedCharBytes(0x41), 1);
  assert.equal(jsonEscapedCharBytes(0x4E2D), 3);
  assert.equal(jsonEscapedCharBytes(0x1F600), 4);
  assert.equal(jsonEscapedCharBytes(0xD83D), 6);

  // Full 1 MiB of dense ESC (\u001b) + quotes + newlines expands several times in JSON.
  const denseUnit = '\x1b[38;5;196m"warn"\n';
  const unitBytes = Buffer.byteLength(denseUnit, 'utf8');
  const full1MiB = denseUnit.repeat(Math.ceil((1024 * 1024) / unitBytes)).slice(0, 1024 * 1024);
  const budget = 1024 * 1024 + 65_536 - 1024;

  const fitted = fitConsoleHistory(full1MiB, 'running', budget);
  const frameBytes = Buffer.byteLength(JSON.stringify({ type: 'history', data: fitted, status: 'running' }), 'utf8');
  assert.ok(frameBytes <= budget, `expected <= ${budget}, got ${frameBytes}`);
  assert.ok(fitted.length > 0 && fitted.length < full1MiB.length);
  assert.equal(full1MiB.endsWith(fitted), true, 'must keep the newest tail of console history');

  // Verify surrogate pairs are never split in half at the trim boundary.
  const emojiHistory = '\x1b😀'.repeat(200);
  const trimmedEmoji = fitConsoleHistory(emojiHistory, 'running', 250);
  assert.equal(/\uD83D(?!\uDE00)|(?<!\uD83D)\uDE00/.test(trimmedEmoji), false, 'surrogate pair must stay intact');
  assert.ok(
    Buffer.byteLength(JSON.stringify({ type: 'history', data: trimmedEmoji, status: 'running' }), 'utf8') <= 250,
  );
});

test('splitOutputForJsonBudget breaks ANSI-heavy output chunks cleanly without cutting surrogate pairs', async () => {
  const { splitOutputForJsonBudget } = await import('./console.js');
  const payload = '\x1b"😀\n'.repeat(100);
  const parts = splitOutputForJsonBudget(payload, 200);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), payload);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(JSON.stringify({ type: 'output', data: part }), 'utf8') <= 200);
    assert.equal(/\uD83D(?!\uDE00)|(?<!\uD83D)\uDE00/.test(part), false);
  }
});

test('console WebSocket sends a full-1MiB ANSI-heavy history snapshot without closing with 1009', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-console-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;

  const { buildApp } = await import('../index.js');
  const { closeDb } = await import('../db.js');
  const { getInstanceRow } = await import('../services/instance-service.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const { processManager } = await import('../services/process-manager.js');

  const app = await buildApp({ skipDataLock: true });
  const managerAccess = processManager as unknown as {
    spawnMinecraft: (...args: unknown[]) => ChildProcessWithoutNullStreams;
    resolveJavaCommand: (id: string | null) => Promise<string>;
  };
  const origSpawn = managerAccess.spawnMinecraft;
  const origResolve = managerAccess.resolveJavaCommand;
  let activeChild: ChildProcessWithoutNullStreams | null = null;
  managerAccess.spawnMinecraft = () => {
    activeChild = fakeChild();
    return activeChild;
  };
  managerAccess.resolveJavaCommand = async () => 'java';

  t.after(async () => {
    if (activeChild) {
      Object.assign(activeChild, { exitCode: 0 });
      activeChild.emit('exit', 0, null);
    }
    managerAccess.spawnMinecraft = origSpawn;
    managerAccess.resolveJavaCommand = origResolve;
    await app.close();
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': process.env.SETUP_TOKEN },
    payload: { username: 'admin', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const { token } = setup.json<{ token: string }>();

  const created = await app.inject({
    method: 'POST',
    url: '/api/instances',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'ansi-console' },
  });
  assert.equal(created.statusCode, 200);
  const instanceId = created.json<{ id: string }>().id;
  fs.writeFileSync(path.join(defaultInstanceDir(instanceId), 'server.jar'), 'stub');

  await processManager.start(getInstanceRow(instanceId)! as InstanceRow);
  // Write 1 MiB of ESC-heavy lines so JSON escaping exceeds raw buffer size by ~3-5x.
  const denseChunk = `${'\x1b[31m"ERR"\n'.repeat(5_000)}`; // ~60 KB per emit
  for (let i = 0; i < 18; i += 1) {
    activeChild!.stdout.emit('data', Buffer.from(denseChunk));
  }
  await new Promise((resolve) => setImmediate(resolve));

  const ticketRes = await app.inject({
    method: 'POST',
    url: `/api/instances/${instanceId}/console-ticket`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(ticketRes.statusCode, 200);
  const { ticket } = ticketRes.json<{ ticket: string }>();

  const frames: ConsoleMessage[] = [];
  let closedCode: number | null = null;
  let resolveDone!: () => void;
  const receivedBoth = new Promise<void>((resolve) => { resolveDone = resolve; });

  const ws = await app.injectWS(`/ws/console/${instanceId}?ticket=${ticket}`, {}, {
    onInit(socket) {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as ConsoleMessage;
        frames.push(parsed);
        if (frames.some((f) => f.type === 'history') && frames.some((f) => f.type === 'status')) {
          resolveDone();
        }
      });
      socket.on('close', (code) => {
        closedCode = code;
      });
    },
  });

  await receivedBoth;
  assert.equal(closedCode, null, 'connection must stay open after history + status frames');
  const historyFrame = frames.find((f) => f.type === 'history');
  assert.ok(historyFrame);
  assert.ok(historyFrame.data.length > 100_000);
  assert.ok(historyFrame.data.includes('\x1b[31m"ERR"'));
  ws.close();
});
