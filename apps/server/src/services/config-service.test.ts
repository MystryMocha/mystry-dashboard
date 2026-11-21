import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

function prepareTempDataRoot(t: test.TestContext): string {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-config-service-test-'));
  t.after(async () => {
    try {
      const { closeDb } = await import('../db.js');
      closeDb();
    } catch {
      /* The module may not be loaded yet */
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  process.env.MYSTRY_DATA_DIR = dataRoot;
  return dataRoot;
}

test('comments, blank lines, duplicate keys and separators are preserved, and the guided patch changes only the last definition', async () => {
  const {
    applyPropertiesPatch,
    parsePropertiesDocument,
    propertiesMapFromDocument,
    stringifyPropertiesDocument,
  } = await import('./config-service.js');
  const fixture = [
    '# 顶部注释',
    '',
    'server-port=25565',
    'motd=Old MOTD',
    'motd=Current MOTD',
    'gamemode:survival',
    'online-mode=true',
    '',
  ].join('\n');

  const document = parsePropertiesDocument(fixture);
  assert.equal(propertiesMapFromDocument(document).motd, 'Current MOTD');
  assert.equal(propertiesMapFromDocument(document).gamemode, 'survival');

  const patched = applyPropertiesPatch(document, { motd: 'New MOTD', 'server-port': '25566' });
  const output = stringifyPropertiesDocument(patched);

  assert.match(output, /# 顶部注释/);
  assert.match(output, /motd=Old MOTD/);
  assert.match(output, /motd=New MOTD/);
  assert.doesNotMatch(output, /motd=Current MOTD/);
  assert.match(output, /server-port=25566/);
  assert.match(output, /gamemode:survival/);
});

test('parseProperties takes the last effective value for duplicate keys', async () => {
  const { parseProperties } = await import('./config-service.js');
  const map = parseProperties('a=1\na=2\n# comment\nb=3\n');
  assert.deepEqual(map, { a: '2', b: '3' });
});

test('game port: 25565 when absent or empty, null when written but not a port number', async () => {
  const { gamePortFromProperties } = await import('./config-service.js');
  assert.equal(gamePortFromProperties({}), 25565);
  assert.equal(gamePortFromProperties({ 'server-port': '' }), 25565);
  assert.equal(gamePortFromProperties({ 'server-port': '  ' }), 25565);
  assert.equal(gamePortFromProperties({ 'server-port': ' 25570 ' }), 25570);
  for (const value of ['0', '65536', '25565.5', 'abc', '-1']) {
    assert.equal(gamePortFromProperties({ 'server-port': value }), null, value);
  }
});

test('the default difficulty is normal when server.properties is missing', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { readServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-default-difficulty' });

  assert.equal(readServerProperties(inst.id).difficulty, 'normal');
});

test('first write of a nonexistent server.properties: a value containing a line break creates no extra property', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-newline' });
  const instanceDir = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id);
  assert.ok(!fs.existsSync(path.join(instanceDir, 'server.properties')), '前置：文件尚不存在');

  writeServerProperties(inst.id, { motd: 'line1\nmalicious=value' });
  const content = fs.readFileSync(path.join(instanceDir, 'server.properties'), 'utf8');
  const { parseProperties } = await import('./config-service.js');
  const parsed = parseProperties(content);

  assert.ok(content.includes('motd=line1\\nmalicious=value'), '换行应被转义为字面 \\n');
  assert.ok(!('malicious' in parsed), '不得产生多余的 malicious 属性');
  assert.equal(parsed.motd, 'line1\nmalicious=value');
});

test('first write of a nonexistent server.properties: a value ending in a backslash does not swallow the next line', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties, readServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-trailing-slash' });
  const instanceDir = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id);

  writeServerProperties(inst.id, { motd: 'foo\\' });
  const content = fs.readFileSync(path.join(instanceDir, 'server.properties'), 'utf8');

  assert.ok(content.includes('motd=foo\\\\\n'), '尾随反斜杠应转义且独占一行');
  assert.ok(content.includes('online-mode=true'), '默认属性不得被吞并');
  assert.equal(readServerProperties(inst.id).motd, 'foo\\');
});

test('non-ASCII characters are written as \\uXXXX and read back as the original text', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties, readServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-unicode' });
  const file = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id, 'server.properties');
  const motd = '§a我的服务器 😀';

  writeServerProperties(inst.id, { motd });
  const content = fs.readFileSync(file, 'utf8');

  assert.ok(content.includes('motd=\\u00A7a\\u6211\\u7684\\u670D\\u52A1\\u5668 \\uD83D\\uDE00'));
  assert.match(content, /^[\x00-\x7f]*$/, '整个文件都应是 ASCII，旧版服务端按 Latin-1 读取也不会乱码');
  assert.equal(readServerProperties(inst.id).motd, motd);

  // Non-ASCII in the existing file is kept as is in comments; only the written values are escaped.
  fs.writeFileSync(file, '# 中文注释\nmotd=old\n', 'utf8');
  writeServerProperties(inst.id, { motd: '新简介' });
  assert.equal(fs.readFileSync(file, 'utf8'), '# 中文注释\nmotd=\\u65B0\\u7B80\\u4ECB\n');
});

test('numeric difficulty and gamemode: read as words, kept numeric when written back', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties, readServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-numeric' });
  const file = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id, 'server.properties');
  fs.writeFileSync(file, 'difficulty=1\ngamemode=0\nmax-players=20\n', 'utf8');

  const properties = readServerProperties(inst.id);
  assert.equal(properties.difficulty, 'easy');
  assert.equal(properties.gamemode, 'survival');
  assert.equal(properties['max-players'], '20', '其他数字键不受影响');

  writeServerProperties(inst.id, { ...properties, difficulty: 'hard', gamemode: 'creative' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'difficulty=3\ngamemode=1\nmax-players=20\n');
  assert.equal(readServerProperties(inst.id).difficulty, 'hard');
});

test('words stay words when the file has words, and out-of-range numbers are kept as is', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { writeServerProperties, readServerProperties } = await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-named', mcVersion: '1.21.4' });
  const file = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id, 'server.properties');
  fs.writeFileSync(file, 'difficulty=easy\ngamemode=9\n', 'utf8');

  assert.equal(readServerProperties(inst.id).gamemode, '9');
  writeServerProperties(inst.id, { difficulty: 'hard', gamemode: '9' }, '1.21.4');
  assert.equal(fs.readFileSync(file, 'utf8'), 'difficulty=hard\ngamemode=9\n');
});

test('instances at 1.13 and earlier: both the default config and saves use numbers', async (t) => {
  prepareTempDataRoot(t);
  const { initDb } = await import('../db.js');
  const { createInstance } = await import('./instance-service.js');
  const { ensureServerPropertiesDefaults, writeServerProperties, parseProperties, readServerProperties } =
    await import('./config-service.js');

  initDb();
  const inst = createInstance({ name: 'props-legacy', mcVersion: '1.12.2' });
  const file = path.join(process.env.MYSTRY_DATA_DIR!, 'instances', inst.id, 'server.properties');

  ensureServerPropertiesDefaults(inst.id, '1.12.2');
  const defaults = parseProperties(fs.readFileSync(file, 'utf8'));
  assert.equal(defaults.difficulty, '2');
  assert.equal(defaults.gamemode, '0');
  assert.equal(readServerProperties(inst.id).difficulty, 'normal');

  // The previous panel version may have left the word form, which old servers do not accept, so it has to be corrected on save.
  fs.writeFileSync(file, 'difficulty=normal\n', 'utf8');
  writeServerProperties(inst.id, { difficulty: 'hard' }, '1.12.2');
  assert.equal(fs.readFileSync(file, 'utf8'), 'difficulty=3\n');

  // New versions, and instances whose version cannot be determined, keep writing words.
  fs.rmSync(file);
  ensureServerPropertiesDefaults(inst.id, '26.3');
  assert.equal(parseProperties(fs.readFileSync(file, 'utf8')).difficulty, 'normal');
  fs.rmSync(file);
  ensureServerPropertiesDefaults(inst.id, '1.14');
  assert.equal(parseProperties(fs.readFileSync(file, 'utf8')).difficulty, 'normal');
  fs.rmSync(file);
  ensureServerPropertiesDefaults(inst.id, null);
  assert.equal(parseProperties(fs.readFileSync(file, 'utf8')).difficulty, 'normal');
});
