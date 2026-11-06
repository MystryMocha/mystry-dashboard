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
import { createPortableReadme } from './package-portable.mjs';
import { createReleaseMetadata } from './package-release.mjs';
import { assertLogsShowLine, lastLogLine } from './smoke-checks.mjs';

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

/** 取出两种语言都必须一致的事实：日期、版本号、地址、公告编号和审计计数。 */
function releaseFacts(text) {
  const pattern = /\d{4}-\d{2}-\d{2}|GHSA-[\w-]+|\b\d+(?:\.\d+)+\b|\b\d+ (?:critical|high|moderate)\b/g;
  return [...new Set(text.match(pattern) ?? [])].sort();
}

/** 取出行内代码（命令、文件名、变量名）；含中文的是界面文案，不参与比对。 */
function inlineCode(text) {
  const body = text.replace(/^```[\s\S]*?^```$/gm, '');
  const tokens = [...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...new Set(tokens.filter((token) => !/\p{Script=Han}/u.test(token)))].sort();
}

/** 统计结构：一种语言多出或漏掉一节、一条列表、一行表格时计数就不同。 */
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

/** 译文无法靠程序证明语义相同，这里只拦住事实、标识符和结构上的漂移。 */
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
  // 发布维护步骤只在中文版写全，英文版只放链接，因此不比对这一节
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
 * 以交互方式运行控制器：stdin 被标记为终端，默认打开菜单，选项通过管道逐步输入。
 * 返回读取输出、写入一行与等待退出的辅助函数。
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
  // 临时目录没有服务端构建产物，启动会失败。
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
  // 临时目录没有服务端构建产物，启动会失败。
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
    // Windows 不看 LANG（常被终端写死），只在类 Unix 上验证。
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
  assert.throws(() => assertLogsShowLine('--- Recent stdout ---\n', expectedLine), /缺少/);
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

// 伪造面板：响应健康检查；收到 SIGINT 后记录下来，稍等片刻（模拟安全关闭）再正常退出。
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

// 终端 Ctrl+C 会把 SIGINT 发给整个前台进程组，连按两次时控制器不能先被杀掉，
test('前台模式只显示可读日志，完整日志写入文件', { timeout: 60_000 }, async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-ctl-foreground-log-'));
  // Windows 上进程刚退出时目录句柄可能还没释放，清理要重试。
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
    if (!terminal) assert.match(output, /reset-password/);
    assert.doesNotMatch(await fsp.readFile(configPath, 'utf8'), /SETUP_TOKEN/);
    assert.equal(fs.readdirSync(path.join(home, 'logs')).some((name) => (
      fs.readFileSync(path.join(home, 'logs', name), 'utf8').includes(body.password)
    )), false, '密码不应进日志文件');
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
  // 管道没有原始模式，这里补一个空实现，用写入 0x03 模拟终端里的 Ctrl+C。
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

  // 强杀查看窗口相当于关窗口：面板不是它的子进程，要继续运行。
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

// 必须等面板自己关完再按面板的退出码退出。Windows 无法用 kill 模拟控制台 Ctrl+C。
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
  // 启动前检查需要 java；PATH 只放这个假 java，也避免把令牌写进开发机剪贴板。
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
    // 独立进程组，下面才能像终端一样把信号发给整个组。
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
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
