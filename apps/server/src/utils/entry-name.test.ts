/**
 * Names the panel may create files and directories under: the rules for every system, and the ones for Windows alone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEntryName, MAX_ENTRY_NAME_LENGTH } from './entry-name.js';

const platforms = ['win32', 'linux', 'darwin'] as const;

test('ordinary names pass on every system', () => {
  for (const platform of platforms) {
    for (const name of [
      'server.properties', 'world', '.hidden', 'a b.txt', '世界 备份.zip', 'config.old.yml', 'console.log', 'com.example.plugin',
      'lpt', 'com10', 'nul-device', 'x'.repeat(MAX_ENTRY_NAME_LENGTH),
    ]) {
      assert.equal(checkEntryName(name, platform), null, `${platform}: ${name}`);
    }
  }
});

test('empty names, dot segments, separators, control characters and names that are too long are refused on every system', () => {
  for (const platform of platforms) {
    for (const name of ['', '.', '..']) assert.equal(checkEntryName(name, platform), 'empty', `${platform}: ${JSON.stringify(name)}`);
    for (const name of ['a/b', 'a\\b', 'a\u0000b', 'tab\there', 'line\nbreak', 'del\u007f']) {
      assert.equal(checkEntryName(name, platform), 'invalidCharacter', `${platform}: ${JSON.stringify(name)}`);
    }
    assert.equal(checkEntryName('x'.repeat(MAX_ENTRY_NAME_LENGTH + 1), platform), 'tooLong', platform);
  }
});

test('on Windows the characters it forbids, a trailing dot or space, and device names are refused as well', () => {
  const windowsOnly: Array<[string, ReturnType<typeof checkEntryName>]> = [
    ['what?.txt', 'invalidCharacter'],
    ['a:b', 'invalidCharacter'],
    ['notes.txt:hidden', 'invalidCharacter'],
    ['<tag>', 'invalidCharacter'],
    ['pipe|name', 'invalidCharacter'],
    ['star*', 'invalidCharacter'],
    ['"quoted"', 'invalidCharacter'],
    ['trailing.', 'trailingDotOrSpace'],
    ['trailing ', 'trailingDotOrSpace'],
    ['con', 'reserved'],
    ['CON', 'reserved'],
    ['nul.txt', 'reserved'],
    ['aux.tar.gz', 'reserved'],
    ['prn', 'reserved'],
    ['com1', 'reserved'],
    ['LPT9.log', 'reserved'],
    ['com¹', 'reserved'],
  ];
  for (const [name, issue] of windowsOnly) {
    assert.equal(checkEntryName(name, 'win32'), issue, name);
    // Legal elsewhere: a server moved from Linux may well contain such names.
    assert.equal(checkEntryName(name, 'linux'), null, name);
    assert.equal(checkEntryName(name, 'darwin'), null, name);
  }
});

test('with no system given, the rules of the one the panel runs on apply', () => {
  assert.equal(checkEntryName('con'), process.platform === 'win32' ? 'reserved' : null);
  assert.equal(checkEntryName('a\u0001b'), 'invalidCharacter');
});
