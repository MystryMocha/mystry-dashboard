import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChecksums } from './create-checksums.mjs';
import { createPortableReadme, isArchiveSafeName } from './package-portable.mjs';
import { createReleaseMetadata } from './package-release.mjs';
import {
  assertLogsShowLine,
  assertNoCredentialsShown,
  assertRequestNotLogged,
  lastLogLine,
} from './smoke-checks.mjs';

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

test('便携包路径只收可打印 ASCII，Windows 自带 tar 才能在任何代码页下解压', () => {
  for (const name of ['index.js', 'snow man', '@fastify', 'a-b_c.d~', 'mystry-dashboard']) {
    assert.equal(isArchiveSafeName(name), true, name);
  }
  // The test fixture directory in @fastify/send is named exactly like this, and under a non-UTF-8 code page (verified under GBK) bsdtar skips it and exits with an error.
  for (const name of ['snow ☃', '中文.txt', 'café', '', 'tab	name']) {
    assert.equal(isArchiveSafeName(name), false, JSON.stringify(name));
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

/** Extracts the facts that must match in both languages: dates, version numbers, URLs, advisory IDs and audit counts. */
function releaseFacts(text) {
  const pattern = /\d{4}-\d{2}-\d{2}|GHSA-[\w-]+|\b\d+(?:\.\d+)+\b|\b\d+ (?:critical|high|moderate)\b/g;
  return [...new Set(text.match(pattern) ?? [])].sort();
}

/** Extracts inline code (commands, file names, variable names); anything containing Chinese is UI text and takes no part in the comparison. */
function inlineCode(text) {
  const body = text.replace(/^```[\s\S]*?^```$/gm, '');
  const tokens = [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...new Set(tokens.filter((token) => !/\p{Script=Han}/u.test(token)))].sort();
}

/** Counts structure: when one language has an extra or missing section, list item or table row, the counts differ. */
function documentShape(text) {
  const count = (pattern) => (text.match(pattern) ?? []).length;
  return {
    headings: count(/^#{2,6} /gm),
    bullets: count(/^- /gm),
    numbered: count(/^\d+\. /gm),
    tableRows: count(/^\|/gm),
    fences: count(/^```/gm),
  };
}

/** A program cannot prove a translation means the same, so this only blocks drift in facts, identifiers and structure. */
function assertSameContent(english, chinese) {
  assert.ok(releaseFacts(english).length > 0, '没有提取到事实，比对没有意义');
  assert.deepEqual(releaseFacts(english), releaseFacts(chinese));
  assert.deepEqual(inlineCode(english), inlineCode(chinese));
  assert.deepEqual(documentShape(english), documentShape(chinese));
}

test('Release 正文英文在前，中英两段内容一致', async () => {
  const notes = await fsp.readFile(
    path.join(scriptDir, '..', '..', '.github', 'portable-preview-notes.md'),
    'utf8',
  );
  const [beforeChinese, chinese, ...rest] = notes.split('\n## 简体中文\n');
  assert.equal(rest.length, 0);
  assert.ok(chinese, '缺少简体中文段落');
  const [, english] = beforeChinese.split('\n## English\n');
  assert.ok(english, '英文段落必须在中文之前');
  assertSameContent(english, chinese);
});

test('便携说明文档中英两版内容一致', async () => {
  const docs = path.join(scriptDir, '..', '..', 'docs');
  const english = await fsp.readFile(path.join(docs, 'portable-release.md'), 'utf8');
  const chinese = await fsp.readFile(path.join(docs, 'portable-release.zh-CN.md'), 'utf8');
  // Release maintenance steps are written out in full only in the Chinese version, with the English version only linking to them, so this section is not compared
  const [englishBody, ...englishRest] = english.split('\n## Release Maintenance\n');
  const [chineseBody, ...chineseRest] = chinese.split('\n## 发布维护\n');
  assert.equal(englishRest.length, 1);
  assert.equal(chineseRest.length, 1);
  assertSameContent(englishBody, chineseBody);
});

test('包内 README.txt 英文在前，中英两段内容一致', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-readme-'));
  try {
    const destination = path.join(directory, 'README.txt');
    await createPortableReadme(destination, '9.9.9-test');
    const content = await fsp.readFile(destination, 'utf8');
    const [english, chinese, ...rest] = content.split(/\n-{20,}\n/);
    assert.equal(rest.length, 0);
    assert.match(english, /^Mystry Dashboard 9\.9\.9-test Portable Preview$/m);
    assert.match(chinese, /^Mystry Dashboard 9\.9\.9-test 便携预览版$/m);
    assertSameContent(english, chinese);
    for (const text of [english, chinese]) {
      assert.match(text, /start, watch, foreground, stop, restart, status, logs, open, reset-password, menu, help/);
      assert.match(text, /chmod \+x mystryctl/);
    }
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

/**
 * Runs the controller interactively: stdin is marked as a terminal, the menu opens by default, and choices are fed step by step through a pipe.
 * Returns helper functions for reading output, writing a line and waiting for exit.
 */
async function startInteractiveController(t, args = ['menu']) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-interactive-'));
  const preload = path.join(home, 'force-tty.mjs');
  await fsp.writeFile(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n", 'utf8');
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, path.join(scriptDir, 'mystryctl.mjs'), ...args],
    {
      env: {
        ...process.env,
        MYSTRY_HOME: home,
        MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
        MYSTRY_DATA_DIR: path.join(home, 'data'),
        MYSTRY_LANG: 'zh-CN',
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

test('双击启动直接运行面板，不显示菜单，出错时等待回车', async (t) => {
  const controller = await startInteractiveController(t, []);
  // The temp directory has no server build output, so starting fails.
  await controller.waitForOutput('按回车键关闭窗口');
  assert.match(controller.output(), /找不到服务端构建产物/);
  assert.doesNotMatch(controller.output(), /请选择/);
  controller.send('');
  assert.equal(await controller.exited, 1);
});

test('菜单命令执行完后等待回车再关闭窗口', async (t) => {
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

test('菜单命令出错时也先显示错误并等待回车', async (t) => {
  const controller = await startInteractiveController(t);
  await controller.waitForOutput('请选择');
  // The temp directory has no server build output, so starting fails.
  controller.send('2');
  await controller.waitForOutput('按回车键关闭窗口');
  assert.match(controller.output(), /找不到服务端构建产物/);
  assert.equal(controller.child.exitCode, null, '未按回车前不应退出');
  controller.send('');
  assert.equal(await controller.exited, 1);
});

/** Runs the controller asynchronously: the fake panel inside the test process has to answer requests while it runs, so spawnSync cannot be used. */
function runController(command, env, nodeArgs = [], { input } = {}) {
  return new Promise((resolve) => {
    // command may be an array: remote takes a subcommand and arguments. When input is not empty it is connected to standard input, to answer prompts.
    const child = spawn(process.execPath, [...nodeArgs, path.join(scriptDir, 'mystryctl.mjs'), ...[command].flat()], {
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) child.stdin.end(input);
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
  // The value is quoted and the data directory is written in the config file, matching how the server reads it with dotenv.
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
  const env = { ...process.env, MYSTRY_HOME: home, MYSTRY_CONFIG_PATH: configPath, MYSTRY_LANG: 'zh-CN' };
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

/**
 * A fake panel inside the test process: the health check returns a fixed fingerprint, and password reset requests are recorded.
 * state.json points at the test process's own PID, so the controller treats it as a panel it started.
 */
async function startFakeManagedPanel(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-reset-'));
  const fingerprint = 'reset-fingerprint';
  const launcherToken = 'c'.repeat(64);
  const resetRequests = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/launcher/reset-password') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        resetRequests.push({ token: request.headers['x-launcher-token'], body: JSON.parse(body) });
        response.end(JSON.stringify({ username: 'admin' }));
      });
      return;
    }
    response.end(JSON.stringify({ ok: true, service: 'mystry-dashboard', processFingerprint: fingerprint }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(home, { recursive: true, force: true });
  });

  const configPath = path.join(home, 'config', 'panel.env');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `PORT=${server.address().port}\nLAUNCHER_TOKEN=${launcherToken}\n`, 'utf8');
  const launcherDir = path.join(home, 'data', 'launcher');
  await fsp.mkdir(launcherDir, { recursive: true });
  await fsp.writeFile(
    path.join(launcherDir, 'state.json'),
    JSON.stringify({ version: 1, pid: process.pid, fingerprint }),
    'utf8',
  );
  const preload = path.join(home, 'force-stdout-tty.mjs');
  await fsp.writeFile(preload, "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n", 'utf8');
  const env = {
    ...process.env,
    MYSTRY_HOME: home,
    MYSTRY_CONFIG_PATH: configPath,
    MYSTRY_DATA_DIR: path.join(home, 'data'),
    MYSTRY_LANG: 'zh-CN',
  };
  for (const name of ['DATA_DIR', 'PORT', 'HOST']) delete env[name];
  return { env, launcherToken, resetRequests, terminalArgs: ['--import', pathToFileURL(preload).href] };
}

test('reset-password：输出不是终端时先拒绝，不请求服务端', async (t) => {
  const panel = await startFakeManagedPanel(t);
  for (const language of ['zh-CN', 'en-US']) {
    const result = await runController('reset-password', { ...panel.env, MYSTRY_LANG: language });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, language === 'zh-CN' ? /当前输出不是终端[\s\S]*没有重置密码/ : /not a terminal[\s\S]*not reset/);
    assert.match(result.output, /reset-password/);
    assert.doesNotThrow(() => assertNoCredentialsShown(result.output, 'reset-password'));
  }
  // The panel is running and managed, yet not a single reset was requested: the user's original password stays valid.
  assert.equal(panel.resetRequests.length, 0, '拒绝前不应请求重置接口');
});

for (const language of ['zh-CN', 'en-US']) {
  test(`reset-password：终端里重置并显示新密码（${language}）`, async (t) => {
    const panel = await startFakeManagedPanel(t);
    const result = await runController(
      'reset-password',
      { ...panel.env, MYSTRY_LANG: language },
      panel.terminalArgs,
    );
    assert.equal(result.code, 0, result.output);
    assert.equal(panel.resetRequests.length, 1);
    const [{ token, body }] = panel.resetRequests;
    assert.equal(token, panel.launcherToken);
    assert.match(body.password, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
    assert.equal(result.output.includes(body.password), true, '终端里应显示新密码');
    assert.equal(result.output.includes(panel.launcherToken), false, '令牌不应出现在输出里');
    // The release smoke test relies on this check to catch passwords, so the separator and the password line each have to be recognized in the controller's real output; errors must not echo the password either.
    const rejectsWithoutEcho = (error) => /password block/.test(error.message) && !error.message.includes(body.password);
    assert.throws(() => assertNoCredentialsShown(result.output, 'reset-password'), rejectsWithoutEcho);
    const withoutDivider = result.output.replace(/^=+\r?$/gm, '');
    assert.throws(() => assertNoCredentialsShown(withoutDivider, 'reset-password'), rejectsWithoutEcho);
    const withoutPasswordLine = result.output.split(/\r?\n/).filter((line) => !line.includes(body.password)).join('\n');
    assert.throws(() => assertNoCredentialsShown(withoutPasswordLine, 'reset-password'), rejectsWithoutEcho);
  });
}

test('界面语言跟随 MYSTRY_LANG 和 LANG，非中文一律用英文', () => {
  const help = (env) => {
    const result = spawnSync(process.execPath, [path.join(scriptDir, 'mystryctl.mjs'), 'help'], {
      env: { ...process.env, MYSTRY_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '', ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(help({ MYSTRY_LANG: 'zh-CN' }), /用法：/);
  assert.match(help({ MYSTRY_LANG: 'en-US' }), /Usage: .*\n[\s\S]*Commands:/);
  assert.match(help({ MYSTRY_LANG: 'ja-JP' }), /Usage: /);
  if (process.platform !== 'win32') {
    // Windows does not look at LANG (often hard-coded by the terminal), so this is verified only on Unix-like systems.
    assert.match(help({ LANG: 'zh_CN.UTF-8' }), /用法：/);
    assert.match(help({ LANG: 'en_US.UTF-8' }), /Usage: /);
    assert.match(help({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }), /用法：/);
  }
});

test('发布冒烟不按界面文案判断结果', async () => {
  const source = await fsp.readFile(path.join(scriptDir, 'smoke-portable.mjs'), 'utf8');
  assert.doesNotMatch(source, /MYSTRY_LANG/);
  assert.doesNotMatch(source, /\.includes\(\s*['"`][^'"`]*[一-鿿]/);
});

test('冒烟的日志检查在每种界面语言下都成立', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-smoke-logs-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const logPath = path.join(home, 'logs', 'panel.stdout.log');
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.writeFile(logPath, '{"msg":"first"}\n{"msg":"Server listening"}\n\n', 'utf8');
  const expectedLine = lastLogLine(logPath);
  assert.equal(expectedLine, '{"msg":"Server listening"}');

  for (const language of ['zh-CN', 'en-US']) {
    const result = spawnSync(process.execPath, [path.join(scriptDir, 'mystryctl.mjs'), 'logs'], {
      env: {
        ...process.env,
        MYSTRY_HOME: home,
        MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
        MYSTRY_LANG: language,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assertLogsShowLine(result.stdout, expectedLine);
  }
  assert.throws(() => assertLogsShowLine('--- Recent stdout ---\n', expectedLine), /missing/);
});

test('冒烟的密码检查认得两种语言的密码行，不误报未显示密码的提示', () => {
  assert.throws(() => assertNoCredentialsShown('  Password: abc\n', 'sample'), /password block/);
  assert.throws(() => assertNoCredentialsShown('  密码：abc\n', 'sample'), /password block/);
  assert.throws(() => assertNoCredentialsShown(`x\r\n${'='.repeat(64)}\r\n`, 'sample'), /password block/);
  assert.doesNotThrow(() => assertNoCredentialsShown(
    'Created administrator admin. Output is not a terminal, so the password was not shown.\n'
      + '已创建管理员 admin。当前输出不是终端，没有显示密码；\n',
    'sample',
  ));
});

test('冒烟用请求日志证明接口未被调用；日志不记请求时判失败', () => {
  const request = (url) => JSON.stringify({ level: 30, time: 1, msg: 'incoming request', req: { method: 'GET', url } });
  const log = [request('/api/health'), request('/api/auth/status?probe=1'), 'plain line', ''].join('\n');
  const forbidden = '/api/launcher/reset-password';
  assert.doesNotThrow(() => assertRequestNotLogged(log, forbidden, '/api/auth/status'));
  assert.throws(
    () => assertRequestNotLogged(`${log}${request(forbidden)}\n`, forbidden, '/api/auth/status'),
    /was requested/,
  );
  // Without a control request, "not seen" cannot be taken as "not requested".
  assert.throws(
    () => assertRequestNotLogged('{"msg":"Server listening"}\n', forbidden, '/api/auth/status'),
    /cannot be confirmed/,
  );
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

/**
 * A fake panel inside the test process: implements the launcher's "access from other devices" endpoints and records the requests received.
 * state.json points at the test process's own PID, so the controller treats it as a panel it started.
 */
async function startFakeRemotePanel(t, { publicUrl = false, failWith = null } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-remote-'));
  const fingerprint = 'remote-fingerprint';
  const launcherToken = 'd'.repeat(64);
  const requests = [];
  let direct = { enabled: false, interfaceName: null, restrictToSubnet: false, https: true };
  let certificate = null;
  let renewals = 0;
  const describe = (port) => ({
    managedByConfig: false,
    configuredHost: null,
    port,
    frontendServed: true,
    platform: 'linux',
    interfaces: [{ name: 'eth0', address: '172.16.0.8', cidr: '172.16.0.8/24', kind: 'lan' }],
    publicHost: publicUrl ? '203.0.113.10' : null,
    certificate,
    direct: {
      ...direct,
      urls: direct.enabled ? [
        { url: `${direct.https ? 'https' : 'http'}://172.16.0.8:${port}/`, interfaceName: 'eth0', kind: 'lan', listening: true, problem: null },
        ...(publicUrl ? [{ url: `${direct.https ? 'https' : 'http'}://203.0.113.10:${port}/`, interfaceName: null, kind: 'publicHost', listening: true, problem: null }] : []),
      ] : [],
      problem: null,
      firewall: direct.enabled ? 'skipped' : null,
    },
    overlay: { enabled: false, interfaceName: null, restrictToSubnet: false, https: false, urls: [], problem: null, firewall: null },
    panelNetwork: { enabled: false },
  });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const port = server.address().port;
    if (!request.url.startsWith('/api/launcher/remote-access')) {
      response.end(JSON.stringify({ ok: true, service: 'mystry-dashboard', processFingerprint: fingerprint }));
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, token: request.headers['x-launcher-token'], body: body ? JSON.parse(body) : null });
      if (request.method === 'PUT' && failWith) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: 'English text from the server', code: failWith }));
        return;
      }
      if (request.method === 'PUT') {
        direct = JSON.parse(body);
        if (direct.enabled && direct.https && !certificate) certificate = { fingerprint256: 'AA:BB:CC', notAfter: '2029-01-25T08:00:00.000Z', addresses: [] };
      }
      if (request.method === 'POST') {
        renewals += 1;
        certificate = { fingerprint256: `NEW:${renewals}`, notAfter: '2029-02-01T08:00:00.000Z', addresses: [] };
      }
      response.end(JSON.stringify(describe(port)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(home, { recursive: true, force: true });
  });
  const configPath = path.join(home, 'config', 'panel.env');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `PORT=${server.address().port}\nLAUNCHER_TOKEN=${launcherToken}\n`, 'utf8');
  const launcherDir = path.join(home, 'data', 'launcher');
  await fsp.mkdir(launcherDir, { recursive: true });
  await fsp.writeFile(path.join(launcherDir, 'state.json'), JSON.stringify({ version: 1, pid: process.pid, fingerprint }), 'utf8');
  const preload = path.join(home, 'force-tty.mjs');
  await fsp.writeFile(preload, [
    "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
    "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
    '',
  ].join('\n'), 'utf8');
  const env = {
    ...process.env,
    MYSTRY_HOME: home,
    MYSTRY_CONFIG_PATH: configPath,
    MYSTRY_DATA_DIR: path.join(home, 'data'),
    MYSTRY_LANG: 'zh-CN',
  };
  // Keep SSH variables, ports and the like in the test environment from affecting the result.
  for (const name of ['DATA_DIR', 'PORT', 'HOST', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[name];
  return {
    env,
    port: server.address().port,
    launcherToken,
    requests,
    terminalArgs: ['--import', pathToFileURL(preload).href],
    stop: () => fsp.rm(path.join(launcherDir, 'state.json')),
  };
}

test('remote 命令：开启、查看、切换 HTTPS、换证书和关闭都经启动器接口，令牌不进输出', async (t) => {
  const panel = await startFakeRemotePanel(t);
  const run = (args, env = panel.env) => runController(['remote', ...args], env);

  const before = await run(['status']);
  assert.equal(before.code, 0, before.output);
  assert.match(before.output, /从其他设备访问：未开启/);
  assert.match(before.output, /网卡：所有网卡 {2}HTTPS：开 {2}只允许同一网段：关/);
  assert.match(before.output, /eth0 {2}172\.16\.0\.8 {2}\(lan\)/);

  // Enable: same defaults as the UI, all interfaces, HTTPS, no source restriction.
  const on = await run(['on']);
  assert.equal(on.code, 0, on.output);
  assert.deepEqual(panel.requests.at(-1).body, { enabled: true, interfaceName: null, restrictToSubnet: false, https: true });
  assert.equal(panel.requests.at(-1).method, 'PUT');
  assert.equal(panel.requests.at(-1).url, '/api/launcher/remote-access/direct');
  assert.match(on.output, new RegExp(`https://172\\.16\\.0\\.8:${panel.port}/`));
  assert.match(on.output, /证书指纹（SHA-256）：AA:BB:CC/);
  assert.match(on.output, new RegExp(`安全组放行 TCP ${panel.port}`));
  assert.match(on.output, /remote https off（连接不再加密）/);
  // The placeholder URL is not printed when not logged in through SSH.
  assert.doesNotMatch(on.output, /<服务器地址>/);

  // Logged in through SSH with no public address on any interface: the placeholder URL and notes are printed.
  const ssh = await run(['on'], { ...panel.env, SSH_CONNECTION: '198.51.100.5 50000 172.16.0.8 22' });
  assert.match(ssh.output, new RegExp(`https://<服务器地址>:${panel.port}/`));
  assert.match(ssh.output, /<服务器地址> 是你 SSH 登录这台服务器时用的 IP 或域名/);

  // A specified interface name.
  await run(['on', 'eth0']);
  assert.equal(panel.requests.at(-1).body.interfaceName, 'eth0');

  // Turn off HTTPS: the URL becomes http without a fingerprint, with a hint on how to turn it back on.
  const plain = await run(['https', 'off']);
  assert.equal(plain.code, 0, plain.output);
  assert.equal(panel.requests.at(-1).body.https, false);
  assert.equal(panel.requests.at(-1).body.enabled, true);
  assert.match(plain.output, new RegExp(`http://172\\.16\\.0\\.8:${panel.port}/`));
  assert.doesNotMatch(plain.output, /证书指纹/);
  assert.match(plain.output, /想加密连接：运行 .* remote https on/);
  await run(['https', 'on']);
  assert.equal(panel.requests.at(-1).body.https, true);

  const renewed = await run(['renew-cert']);
  assert.equal(renewed.code, 0, renewed.output);
  assert.equal(panel.requests.at(-1).method, 'POST');
  assert.equal(panel.requests.at(-1).url, '/api/launcher/remote-access/certificate');
  assert.match(renewed.output, /新指纹（SHA-256）：NEW:1/);

  const status = await run(['status']);
  assert.match(status.output, /从其他设备访问：已开启/);
  assert.match(status.output, /证书指纹（SHA-256）：NEW:1/);
  assert.match(status.output, /证书有效期至：2029-02-01/);

  const off = await run(['off']);
  assert.equal(off.code, 0, off.output);
  assert.equal(panel.requests.at(-1).body.enabled, false);
  assert.match(off.output, /已关闭从其他设备访问/);

  const usage = await run(['bogus']);
  assert.equal(usage.code, 1);
  assert.match(usage.output, /用法：.* remote \[status \| on/);

  // Every request carries the launcher token, and the token appears in no output.
  assert.ok(panel.requests.every((request) => request.token === panel.launcherToken));
  for (const result of [before, on, ssh, plain, renewed, status, off, usage]) {
    assert.equal(result.output.includes(panel.launcherToken), false);
  }

  // English UI.
  const english = await run(['status'], { ...panel.env, MYSTRY_LANG: 'en-US' });
  assert.match(english.output, /Access from other devices: off/);
});

test('remote 命令：填过公网地址时直接打印公网网址；失败时说明原因', async (t) => {
  const panel = await startFakeRemotePanel(t, { publicUrl: true });
  const on = await runController(['remote', 'on'], { ...panel.env, SSH_TTY: '/dev/pts/0' });
  assert.equal(on.code, 0, on.output);
  assert.match(on.output, new RegExp(`https://203\\.0\\.113\\.10:${panel.port}/`));
  assert.doesNotMatch(on.output, /<服务器地址>/);
  // Public URLs come before LAN URLs.
  assert.ok(on.output.indexOf('203.0.113.10') < on.output.indexOf('172.16.0.8'));

  const failing = await startFakeRemotePanel(t, { failWith: 'server.remoteAccess.listenFailed' });
  const failed = await runController(['remote', 'on'], failing.env);
  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.output, /面板没能在任何地址上监听/);
  assert.doesNotMatch(failed.output, /English text from the server/);
  const unknown = await startFakeRemotePanel(t, { failWith: 'server.other.unknown' });
  assert.match((await runController(['remote', 'on'], unknown.env)).output, /English text from the server/);
});

test('remote 命令：面板未运行时除 status 外都提示先启动；无子命令在终端里可直接开关', async (t) => {
  const panel = await startFakeRemotePanel(t);
  // No subcommand and output is not a terminal: only the status is shown, with no question asked and no setting changed.
  const piped = await runController(['remote'], panel.env);
  assert.equal(piped.code, 0, piped.output);
  assert.match(piped.output, /从其他设备访问：未开启/);
  assert.equal(panel.requests.some((request) => request.method === 'PUT'), false);
  // Answer y in a terminal: enable. A bare Enter means no.
  const declined = await runController(['remote'], panel.env, panel.terminalArgs, { input: '\n' });
  assert.match(declined.output, /现在开启吗？\[y\/N\]/);
  assert.equal(panel.requests.some((request) => request.method === 'PUT'), false);
  const accepted = await runController(['remote'], panel.env, panel.terminalArgs, { input: 'y\n' });
  assert.equal(accepted.code, 0, accepted.output);
  assert.deepEqual(panel.requests.at(-1).body, { enabled: true, interfaceName: null, restrictToSubnet: false, https: true });
  assert.match(accepted.output, /可以在你自己的电脑或手机上打开面板/);

  await panel.stop();
  const count = panel.requests.length;
  const status = await runController(['remote', 'status'], panel.env);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, /状态：未运行/);
  for (const args of [['on'], ['off'], ['https', 'off'], ['renew-cert'], []]) {
    const result = await runController(['remote', ...args], panel.env);
    assert.equal(result.code, 1, `${args.join(' ')}\n${result.output}`);
    assert.match(result.output, /面板未运行。请先启动面板。/);
  }
  assert.equal(panel.requests.length, count, '面板不受管时不应请求启动器接口');
});

// Fake panel: answers the health check; on SIGINT it records it, waits a moment (simulating a safe shutdown) and then exits normally.
const FAKE_PANEL_SOURCE = `
import fs from 'node:fs';
import http from 'node:http';
const marker = process.env.FAKE_PANEL_MARKER;
const fingerprint = process.env.MYSTRY_PROCESS_FINGERPRINT;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/__exit') {
    res.end('{}', () => process.exit(0));
  } else if (req.url === '/__log') {
    process.stdout.write(process.env.FAKE_PANEL_WATCH_LINES);
    res.end('{}');
  } else if (req.url === '/api/launcher/shutdown' && req.method === 'POST') {
    res.end('{}', () => setTimeout(() => process.exit(0), 300));
  } else if (req.url === '/api/auth/setup' && process.env.FAKE_PANEL_SETUP_LOG) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      fs.writeFileSync(process.env.FAKE_PANEL_SETUP_LOG, JSON.stringify({ token: req.headers['x-setup-token'], body: JSON.parse(body) }));
      res.end('{}');
    });
  } else if (req.url.startsWith('/api/launcher/remote-access') && process.env.FAKE_PANEL_REMOTE_LOG) {
    // 启动器的「从其他设备访问」接口：记录请求；PUT 之后状态变为已开启。
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(process.env.FAKE_PANEL_REMOTE_LOG, JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }) + '\\n');
      if (req.method === 'PUT' && process.env.FAKE_PANEL_REMOTE_FAIL) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'failed', code: 'server.remoteAccess.listenFailed' }));
        return;
      }
      const enabled = req.method === 'PUT';
      const port = Number(process.env.PORT);
      res.end(JSON.stringify({
        managedByConfig: false, configuredHost: null, port, interfaces: [],
        certificate: enabled ? { fingerprint256: 'FA:KE', notAfter: '2029-01-25T08:00:00.000Z', addresses: [] } : null,
        direct: {
          enabled, interfaceName: null, restrictToSubnet: false, https: true, problem: null, firewall: null,
          urls: enabled ? [{ url: 'https://172.16.0.8:' + port + '/', interfaceName: 'eth0', kind: 'lan', listening: true, problem: null }] : [],
        },
      }));
    });
  } else if (req.url === '/api/health') {
    res.end(JSON.stringify({ ok: true, service: 'mystry-dashboard', processFingerprint: fingerprint }));
  } else if (req.url === '/api/auth/status') {
    res.end(JSON.stringify({ needsSetup: false }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
server.listen(Number(process.env.PORT), '127.0.0.1');
if (process.env.FAKE_PANEL_LOG_LINES) process.stdout.write(process.env.FAKE_PANEL_LOG_LINES);
let closing = false;
process.on('SIGINT', () => {
  fs.appendFileSync(marker, 'SIGINT;');
  if (closing) return;
  closing = true;
  setTimeout(() => {
    fs.appendFileSync(marker, 'closed;');
    server.close();
    process.exit(0);
  }, 800);
});
`;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

// Ctrl+C in a terminal sends SIGINT to the whole foreground process group, and when pressed twice the controller must not be killed first,
test('前台模式只显示可读日志，完整日志写入文件', { timeout: 60_000 }, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-foreground-log-'));
  // On Windows the directory handle may not be released yet right after the process exits, so cleanup has to retry.
  t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const fakeBin = path.join(home, 'bin');
  await fsp.mkdir(path.join(home, 'apps', 'server', 'dist'), { recursive: true });
  await fsp.writeFile(path.join(home, 'apps', 'server', 'dist', 'index.js'), FAKE_PANEL_SOURCE, 'utf8');
  await fsp.mkdir(fakeBin);
  await fsp.writeFile(path.join(fakeBin, 'java'), '#!/bin/sh\necho \'openjdk version "21"\' >&2\n', { mode: 0o755 });
  const time = Date.now();
  const rawLines = [
    JSON.stringify({ level: 30, time, msg: 'incoming request', req: { url: '/api/health' } }),
    JSON.stringify({ level: 30, time, msg: 'request completed', res: { statusCode: 200 } }),
    JSON.stringify({ level: 30, time, msg: 'Server listening' }),
    JSON.stringify({ level: 40, time, msg: 'startup notice', quiet: true }),
    JSON.stringify({ level: 50, time, msg: 'disk failed', err: { stack: 'long stack' } }),
    'plain line',
  ];
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(scriptDir, 'mystryctl.mjs'), 'foreground'], {
    env: {
      ...(process.platform === 'win32' ? process.env : { PATH: fakeBin }),
      MYSTRY_HOME: home,
      MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
      MYSTRY_DATA_DIR: path.join(home, 'data'),
      MYSTRY_LANG: 'zh-CN',
      MYSTRY_NO_BROWSER: '1',
      PORT: String(port),
      FAKE_PANEL_MARKER: path.join(home, 'panel-signals.log'),
      FAKE_PANEL_LOG_LINES: `${rawLines.join('\n')}\n`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  const deadline = Date.now() + 20_000;
  while (!output.includes('按 Ctrl+C 停止面板')) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`前台启动未完成：\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await fetch(`http://127.0.0.1:${port}/__exit`);
  assert.equal(await exited, 0, output);

  assert.match(output, /\d\d:\d\d:\d\d INFO  Server listening/);
  assert.match(output, /\d\d:\d\d:\d\d ERROR disk failed/);
  assert.match(output, /plain line/);
  assert.doesNotMatch(output, /incoming request|request completed|startup notice|"level"/);
  const fullLog = await fsp.readFile(path.join(home, 'logs', 'panel.stdout.log'), 'utf8');
  assert.equal(fullLog, `${rawLines.join('\n')}\n`);
});

for (const [name, terminal] of [['终端里显示账号和密码', true], ['输出重定向时不写出密码', false]]) {
  test(`首次启动自动创建管理员：${name}`, { timeout: 60_000 }, async (t) => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-admin-'));
    t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const fakeBin = path.join(home, 'bin');
    const setupLog = path.join(home, 'setup.json');
    const preload = path.join(home, 'force-tty.mjs');
    await fsp.mkdir(path.join(home, 'apps', 'server', 'dist'), { recursive: true });
    await fsp.writeFile(path.join(home, 'apps', 'server', 'dist', 'index.js'), FAKE_PANEL_SOURCE, 'utf8');
    await fsp.mkdir(fakeBin);
    await fsp.writeFile(path.join(fakeBin, 'java'), '#!/bin/sh\necho \'openjdk version "21"\' >&2\n', { mode: 0o755 });
    await fsp.writeFile(preload, "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n", 'utf8');
    const port = await reservePort();
    const configPath = path.join(home, 'config', 'panel.env');
    const child = spawn(process.execPath, [
      ...(terminal ? ['--import', pathToFileURL(preload).href] : []),
      path.join(scriptDir, 'mystryctl.mjs'),
      'foreground',
    ], {
      env: {
        ...(process.platform === 'win32' ? process.env : { PATH: fakeBin }),
        MYSTRY_HOME: home,
        MYSTRY_CONFIG_PATH: configPath,
        MYSTRY_DATA_DIR: path.join(home, 'data'),
        MYSTRY_LANG: 'zh-CN',
        MYSTRY_NO_BROWSER: '1',
        PORT: String(port),
        FAKE_PANEL_MARKER: path.join(home, 'panel-signals.log'),
        FAKE_PANEL_SETUP_LOG: setupLog,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

    const deadline = Date.now() + 20_000;
    while (!output.includes('按 Ctrl+C 停止面板')) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`前台启动未完成：\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fetch(`http://127.0.0.1:${port}/__exit`);
    assert.equal(await exited, 0, output);

    const { token, body } = JSON.parse(await fsp.readFile(setupLog, 'utf8'));
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(body.username, 'admin');
    assert.match(body.password, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
    assert.equal(output.includes(token), false, '令牌不应出现在输出里');
    assert.equal(output.includes(body.password), terminal);
    // The release smoke test uses the same check to tell whether the first start wrote out the password.
    if (terminal) {
      assert.throws(() => assertNoCredentialsShown(output, 'foreground'), /password block/);
    } else {
      assert.doesNotThrow(() => assertNoCredentialsShown(output, 'foreground'));
      assert.match(output, /reset-password/);
    }
    assert.doesNotMatch(await fsp.readFile(configPath, 'utf8'), /SETUP_TOKEN/);
    assert.equal(fs.readdirSync(path.join(home, 'logs')).some((name) => (
      fs.readFileSync(path.join(home, 'logs', name), 'utf8').includes(body.password)
    )), false, '密码不应进日志文件');
  });
}

// "Access from other devices" on first start: asked only when logged in through SSH, with the admin created, and with both input and output being terminals.
for (const scenario of [
  { name: 'SSH 登录且在终端里：提问，直接回车即开启并打印网址', ssh: true, terminal: true, input: '\n', expectPut: true },
  { name: 'SSH 登录且在终端里：回答 n 不开启，只打印提示行', ssh: true, terminal: true, input: 'n\n', expectPut: false },
  { name: 'SSH 登录但输出不是终端：不提问，只打印提示行', ssh: true, terminal: false, expectPut: false },
  { name: '不是 SSH 登录：不提问也不读状态', ssh: false, terminal: true, input: '\n', expectPut: false },
  { name: '创建管理员失败：不提问、不开启', ssh: true, terminal: true, input: '\n', setupFails: true, expectPut: false },
  { name: '开启失败：打印原因和重试命令', ssh: true, terminal: true, input: '\n', remoteFails: true, expectPut: true },
]) {
  test(`首次启动询问是否允许其他设备访问：${scenario.name}`, { timeout: 60_000 }, async (t) => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-first-remote-'));
    t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const fakeBin = path.join(home, 'bin');
    const remoteLog = path.join(home, 'remote.jsonl');
    const preload = path.join(home, 'force-tty.mjs');
    await fsp.mkdir(path.join(home, 'apps', 'server', 'dist'), { recursive: true });
    await fsp.writeFile(path.join(home, 'apps', 'server', 'dist', 'index.js'), FAKE_PANEL_SOURCE, 'utf8');
    await fsp.mkdir(fakeBin);
    await fsp.writeFile(path.join(fakeBin, 'java'), '#!/bin/sh\necho \'openjdk version "21"\' >&2\n', { mode: 0o755 });
    await fsp.writeFile(preload, [
      "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
      "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
      '',
    ].join('\n'), 'utf8');
    const port = await reservePort();
    const env = {
      ...(process.platform === 'win32' ? process.env : { PATH: fakeBin }),
      MYSTRY_HOME: home,
      MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
      MYSTRY_DATA_DIR: path.join(home, 'data'),
      MYSTRY_LANG: 'zh-CN',
      PORT: String(port),
      FAKE_PANEL_MARKER: path.join(home, 'panel-signals.log'),
      FAKE_PANEL_REMOTE_LOG: remoteLog,
      ...(scenario.setupFails ? {} : { FAKE_PANEL_SETUP_LOG: path.join(home, 'setup.json') }),
      ...(scenario.remoteFails ? { FAKE_PANEL_REMOTE_FAIL: '1' } : {}),
    };
    for (const name of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'HOST', 'DATA_DIR']) delete env[name];
    // When not logged in through SSH the controller tries to open a browser, which is turned off in tests; under SSH login it never opens one anyway, and should not even without this variable.
    if (scenario.ssh) env.SSH_CONNECTION = '198.51.100.5 50000 172.16.0.8 22';
    else env.MYSTRY_NO_BROWSER = '1';
    const child = spawn(process.execPath, [
      ...(scenario.terminal ? ['--import', pathToFileURL(preload).href] : []),
      path.join(scriptDir, 'mystryctl.mjs'),
      'foreground',
    ], { env, stdio: [scenario.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (scenario.input !== undefined) child.stdin.write(scenario.input);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('close', resolve));
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const deadline = Date.now() + 20_000;
    while (!output.includes('按 Ctrl+C 停止面板')) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`前台启动未完成：\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fetch(`http://127.0.0.1:${port}/__exit`);
    assert.equal(await exited, 0, output);

    const requests = fs.existsSync(remoteLog)
      ? fs.readFileSync(remoteLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : [];
    const puts = requests.filter((request) => request.method === 'PUT');
    assert.equal(puts.length, scenario.expectPut ? 1 : 0, output);
    const asked = output.includes('要让你自己的电脑或手机直接打开面板吗？[Y/n]');
    const hint = /要从其他电脑或手机打开面板，运行：.* remote on/.test(output);
    if (!scenario.ssh) {
      assert.equal(requests.length, 0, '不是 SSH 登录时不应请求启动器接口');
      assert.equal(asked || hint, false, output);
      return;
    }
    if (scenario.setupFails) {
      assert.equal(asked, false, output);
      assert.match(output, /创建好管理员之后，运行 .* remote on/);
      return;
    }
    assert.equal(asked, scenario.terminal, output);
    if (scenario.remoteFails) {
      assert.match(output, /开启失败：面板没能在任何地址上监听.*运行 .* remote on 重试/);
      return;
    }
    if (scenario.expectPut) {
      // Same defaults as the UI: all interfaces, HTTPS, no source restriction.
      assert.deepEqual(puts[0].body, { enabled: true, interfaceName: null, restrictToSubnet: false, https: true });
      assert.match(output, new RegExp(`https://172\\.16\\.0\\.8:${port}/`));
      assert.match(output, new RegExp(`https://<服务器地址>:${port}/`));
      assert.match(output, /证书指纹（SHA-256）：FA:KE/);
      assert.equal(hint, false, output);
    } else {
      assert.equal(hint, true, output);
    }
  });
}

test('双击后关闭窗口不影响后台面板，重新打开后 Ctrl+C 安全停止', { timeout: 60_000 }, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-watch-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const fakeBin = path.join(home, 'bin');
  const preload = path.join(home, 'force-raw-tty.mjs');
  await fsp.mkdir(path.join(home, 'apps', 'server', 'dist'), { recursive: true });
  await fsp.writeFile(path.join(home, 'apps', 'server', 'dist', 'index.js'), FAKE_PANEL_SOURCE, 'utf8');
  await fsp.mkdir(fakeBin);
  await fsp.writeFile(path.join(fakeBin, 'java'), '#!/bin/sh\necho \'openjdk version "21"\' >&2\n', { mode: 0o755 });
  // A pipe has no raw mode, so an empty implementation is added here, and writing 0x03 simulates Ctrl+C in a terminal.
  await fsp.writeFile(preload, `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    process.stdin.setRawMode = () => process.stdin;
  `, 'utf8');
  const port = await reservePort();
  const time = Date.now();
  const env = {
    ...(process.platform === 'win32' ? process.env : { PATH: fakeBin }),
    MYSTRY_HOME: home,
    MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
    MYSTRY_DATA_DIR: path.join(home, 'data'),
    MYSTRY_LANG: 'zh-CN',
    MYSTRY_NO_BROWSER: '1',
    PORT: String(port),
    FAKE_PANEL_MARKER: path.join(home, 'panel-signals.log'),
    FAKE_PANEL_WATCH_LINES: `${[
      JSON.stringify({ level: 30, time, msg: 'request completed' }),
      JSON.stringify({ level: 30, time, msg: 'instance started' }),
    ].join('\n')}\n`,
  };
  const health = async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.ok === true;
  const openWindow = () => {
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(preload).href, path.join(scriptDir, 'mystryctl.mjs'),
    ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const window = { child, output: '', exited: new Promise((resolve) => child.on('close', resolve)) };
    child.stdout.on('data', (chunk) => { window.output += chunk; });
    child.stderr.on('data', (chunk) => { window.output += chunk; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    return window;
  };
  const waitFor = async (window, expected) => {
    const deadline = Date.now() + 20_000;
    while (!window.output.includes(expected)) {
      if (Date.now() > deadline) assert.fail(`等待输出「${expected}」超时：\n${window.output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  t.after(async () => { if (await health()) await fetch(`http://127.0.0.1:${port}/__exit`).catch(() => {}); });

  const first = openWindow();
  await waitFor(first, '按 Ctrl+C 安全停止');
  await fetch(`http://127.0.0.1:${port}/__log`);
  await waitFor(first, 'INFO  instance started');
  assert.match(first.output, /作为 daemon 在后台运行，没有单独的窗口/);
  assert.match(first.output, /不会自动停止/);
  assert.doesNotMatch(first.output, /request completed/);

  // Force-killing the viewer window amounts to closing the window: the panel is not its child process and has to keep running.
  first.child.kill('SIGKILL');
  await first.exited;
  assert.equal(await health(), true);

  const second = openWindow();
  await waitFor(second, '面板已经在运行');
  await waitFor(second, '按 Ctrl+C 安全停止');
  second.child.stdin.write('\u0003');
  assert.equal(await second.exited, 0, second.output);
  assert.match(second.output, /面板已停止/);
  assert.equal(await health(), false);
  assert.equal(fs.existsSync(path.join(home, 'data', 'launcher', 'state.json')), false);
});

// It must wait for the panel to finish closing on its own and then exit with the panel's exit code. Windows cannot simulate a console Ctrl+C with kill.
test('前台模式下连按两次 Ctrl+C 仍等待面板安全关闭', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? 'Windows 无法用 kill 模拟控制台 Ctrl+C' : false,
}, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-foreground-'));
  const fakeBin = path.join(home, 'bin');
  const marker = path.join(home, 'panel-signals.log');
  await fsp.mkdir(path.join(home, 'apps', 'server', 'dist'), { recursive: true });
  await fsp.writeFile(path.join(home, 'apps', 'server', 'dist', 'index.js'), FAKE_PANEL_SOURCE, 'utf8');
  await fsp.mkdir(fakeBin);
  // The pre-start check needs java; PATH holds only this fake java, which also keeps the token out of the dev machine's clipboard.
  await fsp.writeFile(path.join(fakeBin, 'java'), '#!/bin/sh\necho \'openjdk version "21"\' >&2\n', { mode: 0o755 });

  const child = spawn(process.execPath, [path.join(scriptDir, 'mystryctl.mjs'), 'foreground'], {
    env: {
      PATH: fakeBin,
      MYSTRY_HOME: home,
      MYSTRY_CONFIG_PATH: path.join(home, 'config', 'panel.env'),
      MYSTRY_DATA_DIR: path.join(home, 'data'),
      MYSTRY_LANG: 'zh-CN',
      MYSTRY_NO_BROWSER: '1',
      PORT: String(await reservePort()),
      FAKE_PANEL_MARKER: marker,
    },
    // A separate process group, so that the signal can be sent to the whole group below, as a terminal does.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group has already exited */ }
      await exited;
    }
    await fsp.rm(home, { recursive: true, force: true });
  });

  const deadline = Date.now() + 20_000;
  while (!output.includes('面板已启动')) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`前台启动未完成：\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  process.kill(-child.pid, 'SIGINT');
  await new Promise((resolve) => setTimeout(resolve, 200));
  process.kill(-child.pid, 'SIGINT');

  const result = await exited;
  assert.deepEqual(result, { code: 0, signal: null }, `控制器没有等面板关完：\n${output}`);
  const signals = await fsp.readFile(marker, 'utf8');
  assert.match(signals, /closed/, '面板应完成安全关闭');
  assert.equal(fs.existsSync(path.join(home, 'data', 'launcher', 'state.json')), false, '退出后应清除运行状态');
});
