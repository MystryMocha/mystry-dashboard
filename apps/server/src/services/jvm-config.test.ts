import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JVM_PRESETS,
  JvmArgsParseError,
  automaticInitialMemoryMiB,
  buildJvmArgs,
  inspectJvmArgFile,
  inspectJvmArgs,
  parseJvmArgFile,
  parseJvmArgs,
  recommendedJavaMajor,
  recommendedMaxMemoryMiB,
  serializeJvmArgFile,
  serializeJvmArgs,
  validateJvmArgs,
} from '@mystry/shared';

test('JVM 参数解析保留引号、Windows 路径和 UNC 路径', () => {
  const parsed = parseJvmArgs(
    String.raw`-Xms1G -Xmx2G "-Dpath=C:\Program Files\Java" '-Dunc=\\server\share folder'`,
  );
  assert.deepEqual(parsed, [
    '-Xms1G',
    '-Xmx2G',
    String.raw`-Dpath=C:\Program Files\Java`,
    String.raw`-Dunc=\\server\share folder`,
  ]);
  assert.deepEqual(parseJvmArgs(serializeJvmArgs(parsed)), parsed);
  assert.deepEqual(parseJvmArgFile(serializeJvmArgFile(parsed)), parsed);
  assert.throws(
    () => parseJvmArgs('-Xms1G "-Xmx2G'),
    (error: unknown) => error instanceof JvmArgsParseError
      && error.messageKey === 'server.jvm.issue.unclosedQuote'
      && /unclosed quote/.test(error.message),
  );
});

test('user_jvm_args.txt 忽略空行和注释并可规范化', () => {
  const raw = [
    '# Forge 生成的说明',
    '',
    '-Xms1G',
    '-Xmx4G',
    '  # 不执行这一行',
    '"-Dfolder=C:\\\\Minecraft Server"',
    '-Dkept=true # 行尾注释',
  ].join('\r\n');
  assert.deepEqual(parseJvmArgFile(raw), [
    '-Xms1G',
    '-Xmx4G',
    String.raw`-Dfolder=C:\Minecraft Server`,
    '-Dkept=true',
  ]);
  const detected = inspectJvmArgFile(raw);
  assert.equal(detected.canonicalArgs, String.raw`-Xms1G -Xmx4G -Dfolder=C:\Minecraft\ Server -Dkept=true`);
  assert.equal(detected.issues.length, 0);
});

test('推荐内存按四分之一、512 MiB、系统保留和上下限计算', () => {
  assert.equal(recommendedMaxMemoryMiB(null), 2048);
  assert.equal(recommendedMaxMemoryMiB(32 * 1024), 8192);
  assert.equal(recommendedMaxMemoryMiB(8 * 1024), 2048);
  assert.equal(recommendedMaxMemoryMiB(4 * 1024), 2048);
  assert.equal(recommendedMaxMemoryMiB(3 * 1024), 1024);
  assert.equal(automaticInitialMemoryMiB('compatibility', 8192), 1024);
  assert.equal(automaticInitialMemoryMiB('compatibility', 512), 512);
  assert.equal(automaticInitialMemoryMiB('custom', 8192), 1024);
  // G1 Balanced and Paper Aikar are server tuning profiles, with initial memory equal to max memory.
  assert.equal(automaticInitialMemoryMiB('g1-balanced', 8192), 8192);
  assert.equal(automaticInitialMemoryMiB('paper-aikar', 8192), 8192);
});

test('三个 JVM 预设可生成并反向识别', () => {
  assert.deepEqual(JVM_PRESETS.map((preset) => preset.id), [
    'compatibility',
    'g1-balanced',
    'paper-aikar',
  ]);
  const compatibility = buildJvmArgs({ xmsMiB: 1024, xmxMiB: 2048, presetId: 'compatibility' });
  const g1 = buildJvmArgs({ xmsMiB: 1024, xmxMiB: 4096, presetId: 'g1-balanced' });
  const paper = buildJvmArgs({ xmsMiB: 6144, xmxMiB: 6144, presetId: 'paper-aikar' });
  assert.equal(inspectJvmArgs(compatibility).presetId, 'compatibility');
  assert.equal(inspectJvmArgs(g1).presetId, 'g1-balanced');
  assert.equal(inspectJvmArgs(paper, { coreType: 'paper', javaMajor: 21 }).presetId, 'paper-aikar');
  assert.equal(validateJvmArgs(paper, { coreType: 'paper', javaMajor: 21 }).length, 0);
  // MC 26.x recommends Java 25, and the G1 and Aikar presets must not report a version mismatch because of it
  assert.equal(validateJvmArgs(g1, { javaMajor: 25 }).length, 0);
  assert.equal(validateJvmArgs(paper, { coreType: 'paper', javaMajor: 25 }).length, 0);
});

test('冲突内存、GC 和面板负责的启动参数会阻止保存', () => {
  const issues = validateJvmArgs(
    '-Xms4G -Xms2G -Xmx1G -XX:+UseG1GC -XX:+UseG1GC -jar server.jar nogui @args.txt',
  );
  const codes = new Set(issues.filter((item) => item.severity === 'error').map((item) => item.code));
  assert.equal(codes.has('XMS_COUNT'), true);
  assert.equal(codes.has('GC_CONFLICT'), true);
  assert.equal(codes.has('PANEL_OWNED_ARGUMENT'), true);
  const panelOwned = issues.find((item) => item.code === 'PANEL_OWNED_ARGUMENT');
  assert.equal(panelOwned?.key, 'server.jvm.issue.panelOwnedArgument');
  assert.deepEqual(panelOwned?.params, { argument: '-jar' });
  assert.equal(panelOwned?.message, "The panel manages -jar. You can't add it to JVM arguments.");

  const memoryOrder = validateJvmArgs('-Xms4G -Xmx2G');
  assert.equal(memoryOrder.some((item) => item.code === 'MEMORY_ORDER'), true);
  const advancedMemory = buildJvmArgs({
    xmsMiB: 1024,
    xmxMiB: 2048,
    presetId: 'compatibility',
    extraArgs: '-Xmx4G',
  });
  assert.equal(validateJvmArgs(advancedMemory).some((item) => item.code === 'XMX_COUNT'), true);
});

test('预设限制与旧参数错误均保留为结构化诊断', () => {
  const paper = buildJvmArgs({ xmsMiB: 4096, xmxMiB: 4096, presetId: 'paper-aikar' });
  const mismatch = validateJvmArgs(paper, { coreType: 'forge', javaMajor: 22 });
  assert.equal(mismatch.some((item) => item.code === 'PRESET_CORE_MISMATCH'), true);
  assert.equal(mismatch.some((item) => item.code === 'PRESET_JAVA_MISMATCH'), true);
  const coreMismatch = mismatch.find((item) => item.code === 'PRESET_CORE_MISMATCH');
  assert.equal(coreMismatch?.key, 'server.jvm.issue.presetCoreMismatch');
  assert.deepEqual(coreMismatch?.params, { preset: { key: 'server.jvm.preset.paperAikar' }, cores: 'paper' });
  assert.equal(coreMismatch?.message, 'Paper Aikar only works with paper cores.');
  assert.equal(mismatch.some((item) => item.code === 'PAPER_MEMORY_LOW' && item.severity === 'warning'), true);

  const oldValue = '-Xms1G "-Xmx2G';
  const inspected = inspectJvmArgs(oldValue);
  assert.equal(inspected.raw, oldValue);
  assert.equal(inspected.canonicalArgs, null);
  assert.equal(inspected.extraArgs, oldValue);
  assert.equal(inspected.issues[0]?.code, 'PARSE_ERROR');
  assert.equal(inspected.issues[0]?.key, 'server.jvm.issue.unclosedQuote');
  // Each diagnostic's key is server.jvm.issue.<code in camelCase> (except parse errors, which use the key given by the parser)
  for (const item of [...mismatch, ...validateJvmArgs('-Xms4G -Xmx2G')]) {
    const camel = item.code.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    assert.equal(item.key, `server.jvm.issue.${camel}`);
  }
});

test('服务端在实例保存和任务入队前拒绝非法参数', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-jvm-validation-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  process.env.JWT_SECRET = 'a'.repeat(64);
  process.env.SETUP_TOKEN = 'b'.repeat(64);
  process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
  const { initDb, closeDb, getDb } = await import('../db.js');
  const { createInstance, getInstance, updateInstance } = await import('./instance-service.js');
  const { deployCore } = await import('./core-depot.js');
  const { getTaskActivity } = await import('./task-service.js');
  const { PanelError } = await import('../utils/errors.js');
  initDb();
  t.after(() => {
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  assert.throws(
    () => createInstance({ name: '非法内存', jvmArgs: '-Xms4G -Xmx2G' }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.jvm.issue.memoryOrder',
  );
  const instance = createInstance({ name: '合法实例', jvmArgs: '-Xms1G -Xmx2G' });
  assert.throws(
    () => updateInstance(instance.id, { jvmArgs: '-Xms1G -Xmx2G -jar server.jar' }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.jvm.issue.panelOwnedArgument',
  );
  assert.equal(getInstance(instance.id)?.jvmArgs, '-Xms1G -Xmx2G');
  getDb().prepare('UPDATE instances SET jvm_args = ? WHERE id = ?').run('-Xmx2G', instance.id);
  assert.throws(
    () => updateInstance(instance.id, { name: '不能绕过旧参数错误' }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.jvm.issue.xmsCount',
  );
  getDb().prepare('UPDATE instances SET jvm_args = ? WHERE id = ?').run('-Xms1G -Xmx2G', instance.id);

  const activityBefore = getTaskActivity();
  await assert.rejects(
    () => deployCore({
      name: '非法部署',
      coreType: 'paper',
      mcVersion: '1.21.1',
      jvmArgs: '-Xms1G -Xmx2G nogui',
    }),
    (error: unknown) => error instanceof PanelError && error.messageKey === 'server.jvm.issue.panelOwnedArgument',
  );
  assert.deepEqual(getTaskActivity(), activityBefore);
});

test('recommendedJavaMajor 按 MC 版本推荐 Java，年份版本号 26.x 需要 Java 25', () => {
  // Year-based version numbers (from 26.1)
  assert.equal(recommendedJavaMajor('26.1'), 25);
  assert.equal(recommendedJavaMajor('26.1.2'), 25);
  assert.equal(recommendedJavaMajor('26.3'), 25);
  assert.equal(recommendedJavaMajor('26.3-rc-3'), 25);
  assert.equal(recommendedJavaMajor('27.1'), 25);
  // Old 1.x version numbers keep their original ranges
  assert.equal(recommendedJavaMajor('1.21.11'), 21);
  assert.equal(recommendedJavaMajor('1.21.11-rc3'), 21);
  assert.equal(recommendedJavaMajor('1.20.5'), 21);
  assert.equal(recommendedJavaMajor('1.20.4'), 17);
  assert.equal(recommendedJavaMajor('1.17'), 17);
  assert.equal(recommendedJavaMajor('1.16.5'), 8);
  // No recommendation for unrecognized formats, to avoid false reports
  assert.equal(recommendedJavaMajor('25w14a'), null);
  assert.equal(recommendedJavaMajor('snapshot'), null);
  assert.equal(recommendedJavaMajor(''), null);
  assert.equal(recommendedJavaMajor(null), null);
  assert.equal(recommendedJavaMajor(undefined), null);
});
