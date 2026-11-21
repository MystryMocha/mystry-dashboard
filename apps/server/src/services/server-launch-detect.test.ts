import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-launch-detect-test-'));
process.env.MYSTRY_HOME = dataRoot;
process.env.MYSTRY_DATA_DIR = dataRoot;
test.after(async () => {
  try {
    const { closeDb } = await import('../db.js');
    closeDb();
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('从启动文件名认出核心类型和 Minecraft 版本', async () => {
  const { describeJarLaunchTarget, inferMcVersionFromLaunchTarget } = await import('./server-launch-detect.js');

  assert.deepEqual(describeJarLaunchTarget('forge-1.12.2-14.23.5.2860.jar'), {
    value: 'forge-1.12.2-14.23.5.2860.jar',
    coreType: 'forge',
    mcVersion: '1.12.2',
  });
  assert.deepEqual(describeJarLaunchTarget('minecraft_server.1.7.10.jar'), {
    value: 'minecraft_server.1.7.10.jar',
    coreType: 'vanilla',
    mcVersion: '1.7.10',
  });
  assert.equal(describeJarLaunchTarget('paper-1.20.4-496.jar').mcVersion, '1.20.4');
  assert.equal(describeJarLaunchTarget('fabric-server-mc.1.20.1-loader.0.15.7-launcher.1.0.0.jar').mcVersion, '1.20.1');
  assert.equal(describeJarLaunchTarget('server.jar').mcVersion, null);

  // The directory name of a Forge args file contains the game version; Windows backslashes are recognized too.
  assert.equal(
    inferMcVersionFromLaunchTarget('@args:libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt', 'forge'),
    '1.20.1',
  );
  assert.equal(
    inferMcVersionFromLaunchTarget('@args:libraries\\net\\minecraftforge\\forge\\1.18.2-40.2.0\\win_args.txt', 'forge'),
    '1.18.2',
  );
  // Forge's and NeoForge's own version numbers, and numbers in custom jar names, are not taken as the game version.
  assert.equal(inferMcVersionFromLaunchTarget('forge-14.23.5.2860.jar', 'forge'), null);
  assert.equal(
    inferMcVersionFromLaunchTarget('@args:libraries/net/neoforged/neoforge/21.1.77/win_args.txt', 'neoforge'),
    null,
  );
  assert.equal(inferMcVersionFromLaunchTarget('my-server-1.12.2.jar', 'custom'), null);
  assert.equal(inferMcVersionFromLaunchTarget('paper-1.5.2.jar', 'paper'), null);
});

test('导入表单提交的 custom 表示自动识别，明确选的核心类型优先', async () => {
  const { resolveImportedCoreType } = await import('./server-launch-detect.js');
  assert.equal(resolveImportedCoreType('custom', 'forge'), 'forge');
  assert.equal(resolveImportedCoreType(undefined, 'paper'), 'paper');
  assert.equal(resolveImportedCoreType('fabric', 'forge'), 'fabric');
  assert.equal(resolveImportedCoreType('custom', 'custom'), 'custom');
});

test('从本机文件夹导入旧版 Forge：预检和导入结果都认出 Forge 与版本', async () => {
  const { initDb } = await import('../db.js');
  const { importExistingServerDirectory, listExistingServerSources } = await import('./existing-server-import-service.js');
  const { getInstance } = await import('./instance-service.js');
  const { getTask } = await import('./task-service.js');
  initDb();

  const source = path.join(dataRoot, 'imports', 'old-forge');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'forge-1.12.2-14.23.5.2860.jar'), 'forge-jar');
  fs.writeFileSync(path.join(source, 'minecraft_server.1.12.2.jar'), 'vanilla-jar');

  const [listed] = await listExistingServerSources();
  assert.equal(listed.id, 'old-forge');
  assert.equal(listed.launchTarget, 'forge-1.12.2-14.23.5.2860.jar');
  assert.equal(listed.coreType, 'forge');
  assert.equal(listed.mcVersion, '1.12.2');

  const waitFor = async (taskId: string) => {
    let task = getTask(taskId);
    for (let attempt = 0; attempt < 300 && task?.status !== 'completed' && task?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = getTask(taskId);
    }
    assert.equal(task?.status, 'completed', task?.error);
    const instanceId = task?.result?.instanceId;
    if (typeof instanceId !== 'string') assert.fail('导入任务未返回实例 ID');
    return getInstance(instanceId)!;
  };

  // The form stays on "auto-detect" with the version left empty: the detection result wins.
  const auto = await waitFor((await importExistingServerDirectory({
    name: 'auto',
    sourceId: 'old-forge',
    coreType: 'custom',
    acceptEula: false,
  })).id);
  assert.equal(auto.coreType, 'forge');
  assert.equal(auto.mcVersion, '1.12.2');

  // A core type and version the user entered are not overwritten.
  const manual = await waitFor((await importExistingServerDirectory({
    name: 'manual',
    sourceId: 'old-forge',
    coreType: 'paper',
    mcVersion: '1.16.5',
    acceptEula: false,
  })).id);
  assert.equal(manual.coreType, 'paper');
  assert.equal(manual.mcVersion, '1.16.5');
});
