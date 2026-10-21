import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChecksums } from './create-checksums.mjs';
import { createReleaseMetadata } from './package-release.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

test('便携脚本均可由 Node 直接解析', async () => {
  const scripts = (await fsp.readdir(scriptDir))
    .filter((name) => name.endsWith('.mjs'));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ['--check', path.join(scriptDir, script)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${script}\n${result.stderr}`);
  }
});

test('便携入口只调用包内 Node 运行时', async () => {
  const windows = await fsp.readFile(path.join(scriptDir, 'mystryctl.cmd'), 'utf8');
  const unix = await fsp.readFile(path.join(scriptDir, 'mystryctl.sh'), 'utf8');
  assert.match(windows, /runtime\\node\.exe/i);
  assert.doesNotMatch(windows, /\bnpm(?:\.cmd)?\b/i);
  assert.match(unix, /runtime\/bin\/node/);
  assert.doesNotMatch(unix, /\bnpm\b/i);
});

/**
 * 以「双击启动」方式运行控制器：stdin 被标记为终端，菜单选项通过管道逐步输入。
 * 返回读取输出、写入一行与等待退出的辅助函数。
 */
async function startInteractiveController(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-interactive-'));
  const preload = path.join(home, 'force-tty.mjs');
  await fsp.writeFile(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n", 'utf8');
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, path.join(scriptDir, 'mystryctl.mjs')],
    {
      env: {
        ...process.env,
        MYSTRY_HOME: home,
        MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
        MYSTRY_DATA_DIR: path.join(home, 'data'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const waitForOutput = async (text) => {
    const deadline = Date.now() + 10_000;
    while (!output.includes(text)) {
      if (Date.now() > deadline) assert.fail(`等待输出「${text}」超时：\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    child,
    exited,
    output: () => output,
    waitForOutput,
    send: (line) => child.stdin.write(`${line}\n`),
  };
}

test('双击启动执行完菜单命令后等待回车再关闭窗口', async (t) => {
  const controller = await startInteractiveController(t);
  await controller.waitForOutput('请选择');
  controller.send('3');
  await controller.waitForOutput('按回车键关闭窗口');
  assert.match(controller.output(), /暂无日志/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(controller.child.exitCode, null, '未按回车前不应退出');
  controller.send('');
  assert.equal(await controller.exited, 0);
});

test('双击启动时菜单命令出错也先显示错误并等待回车', async (t) => {
  const controller = await startInteractiveController(t);
  await controller.waitForOutput('请选择');
  // 临时目录没有服务端构建产物，前台启动会失败。
  controller.send('2');
  await controller.waitForOutput('按回车键关闭窗口');
  assert.match(controller.output(), /找不到服务端构建产物/);
  assert.equal(controller.child.exitCode, null, '未按回车前不应退出');
  controller.send('');
  assert.equal(await controller.exited, 1);
});

/** 异步运行控制器：测试进程里的伪造面板要在它运行期间响应请求，不能用 spawnSync。 */
function runController(command, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(scriptDir, 'mystryctl.mjs'), command], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

test('按配置文件中的 DATA_DIR 找运行状态；指纹不匹配时不发送 LAUNCHER_TOKEN', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-fingerprint-'));
  let fingerprint = 'expected-fingerprint';
  let shutdownRequested = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/launcher/shutdown') shutdownRequested = true;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'mystry-dashboard', processFingerprint: fingerprint }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(home, { recursive: true, force: true });
  });

  const configPath = path.join(home, 'config', 'panel.env');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  // 值带引号、数据目录写在配置文件里，与服务端的 dotenv 读法保持一致。
  await fsp.writeFile(configPath, [
    `PORT="${server.address().port}"`,
    'DATA_DIR=custom-data',
    `LAUNCHER_TOKEN=${'b'.repeat(64)}`,
    '',
  ].join('\n'), 'utf8');
  const launcherDir = path.join(home, 'custom-data', 'launcher');
  await fsp.mkdir(launcherDir, { recursive: true });
  await fsp.writeFile(
    path.join(launcherDir, 'state.json'),
    JSON.stringify({ version: 1, pid: process.pid, fingerprint: 'expected-fingerprint' }),
    'utf8',
  );
  const env = { ...process.env, MYSTRY_HOME: home, MYSTRY_CONFIG_PATH: configPath };
  for (const name of ['MYSTRY_DATA_DIR', 'DATA_DIR', 'PORT', 'HOST']) delete env[name];

  const status = await runController('status', env);
  assert.match(status.output, /状态：运行中/);
  assert.match(status.output, new RegExp(`PID：${process.pid}`));

  fingerprint = 'other-fingerprint';
  const stop = await runController('stop', env);
  assert.equal(stop.code, 1, stop.output);
  assert.match(stop.output, /拒绝停止未知进程/);
  assert.equal(shutdownRequested, false, '指纹不匹配时不应请求安全关闭接口');
});

test('校验和脚本稳定排序并排除自身', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-checksums-test-'));
  try {
    await fsp.writeFile(path.join(root, 'b.txt'), 'b', 'utf8');
    await fsp.writeFile(path.join(root, 'a.txt'), 'a', 'utf8');
    const script = path.join(scriptDir, 'create-checksums.mjs');
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const lines = (await fsp.readFile(path.join(root, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    assert.match(lines[0], /  a\.txt$/);
    assert.match(lines[1], /  b\.txt$/);
    assert.equal(lines.some((line) => line.includes('SHA256SUMS')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('发布元数据在每次覆盖 SBOM 后重新生成校验和', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-release-metadata-test-'));
  try {
    await fsp.writeFile(path.join(root, 'mystry-v0.0.0-test.zip'), 'archive', 'utf8');
    const calls = [];
    let sbomVersion = 0;
    const execute = async (label, command, args) => {
      const script = path.basename(args[0]);
      calls.push({ label, command, script });
      if (script === 'create-sbom.mjs') {
        const outputIndex = args.indexOf('--output');
        assert.notEqual(outputIndex, -1);
        await fsp.writeFile(args[outputIndex + 1], `SBOM ${++sbomVersion}`, 'utf8');
        return;
      }
      assert.equal(script, 'create-checksums.mjs');
      assert.deepEqual(args.slice(1), [root]);
      await createChecksums(args[1]);
    };
    const checksumForCurrentSbom = async () => {
      const sbom = await fsp.readFile(path.join(root, 'sbom.cdx.json'));
      return crypto.createHash('sha256').update(sbom).digest('hex');
    };
    const recordedSbomChecksum = async () => {
      const sums = await fsp.readFile(path.join(root, 'SHA256SUMS'), 'utf8');
      return sums.match(/^([a-f0-9]{64})  sbom\.cdx\.json$/m)?.[1];
    };

    await createReleaseMetadata(root, execute);
    const firstChecksum = await recordedSbomChecksum();
    assert.equal(firstChecksum, await checksumForCurrentSbom());

    await createReleaseMetadata(root, execute);
    const secondChecksum = await recordedSbomChecksum();
    assert.equal(secondChecksum, await checksumForCurrentSbom());
    assert.notEqual(secondChecksum, firstChecksum);
    assert.deepEqual(calls.map((call) => call.script), [
      'create-sbom.mjs',
      'create-checksums.mjs',
      'create-sbom.mjs',
      'create-checksums.mjs',
    ]);
    assert.equal(calls.every((call) => call.command === process.execPath), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('运行时版本固定为 Node 22', async () => {
  const runtime = JSON.parse(await fsp.readFile(path.join(scriptDir, 'runtime.json'), 'utf8'));
  assert.match(runtime.nodeVersion, /^22\.\d+\.\d+$/);
  assert.equal(fs.existsSync(path.join(scriptDir, 'fetch-node-runtime.mjs')), true);
});

test('SBOM 只包含生产依赖并使用 CycloneDX 1.6', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-sbom-test-'));
  try {
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/prod': { version: '2.0.0', license: 'MIT' },
        'node_modules/dev': { version: '3.0.0', dev: true },
      },
    };
    await fsp.writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify(lock),
      'utf8',
    );
    await fsp.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf8',
    );
    const output = path.join(root, 'sbom.cdx.json');
    const script = path.join(scriptDir, 'create-sbom.mjs');
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--lock', path.join(root, 'package-lock.json'),
        '--package', path.join(root, 'package.json'),
        '--output', output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const sbom = JSON.parse(await fsp.readFile(output, 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.equal(sbom.specVersion, '1.6');
    assert.deepEqual(sbom.components.map((component) => component.name), ['prod']);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
