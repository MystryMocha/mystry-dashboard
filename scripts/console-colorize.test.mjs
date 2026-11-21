import assert from 'node:assert/strict';
import test from 'node:test';
import {
  colorizeConsoleLine,
  colorizeConsoleStream,
  createConsoleColorizeState,
  flushConsoleColorize,
} from '../apps/web/src/console-colorize.ts';

test('INFO/WARN/ERROR use ECMA-48 bright green/bright yellow/bright red', () => {
  const info = colorizeConsoleLine('[01:00:00] [Server thread/INFO]: started');
  const warn = colorizeConsoleLine('[01:00:00] [Server thread/WARN]: missing');
  const error = colorizeConsoleLine('[01:00:00] [Server thread/ERROR]: boom');

  assert.match(info, /^\x1b\[92m.*\x1b\[0m$/);
  assert.match(warn, /^\x1b\[93m.*\x1b\[0m$/);
  assert.match(error, /^\x1b\[91m.*\x1b\[0m$/);
});

test('a line that already contains ANSI is not colored a second time', () => {
  const raw = '\x1b[31mred\x1b[0m';
  assert.equal(colorizeConsoleLine(raw), raw);
});

test('a streaming fragment is colored only after the line break', () => {
  const state = createConsoleColorizeState();
  assert.equal(colorizeConsoleStream('[main/INF', state), '');
  const colored = colorizeConsoleStream('O]: ok\n', state);
  assert.match(colored, /^\x1b\[92m\[main\/INFO\]: ok\x1b\[0m\n$/);
  assert.equal(flushConsoleColorize(state), '');
});
