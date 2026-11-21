import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  assertLogsShowLine,
  assertNoCredentialsShown,
  assertRequestNotLogged,
  lastLogLine,
} from './smoke-checks.mjs';

/** Runs a command and returns the raw result, without judging by exit code; throws on timeout or failure to start. */
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not complete: ${result.error.message}`);
  }
  return result;
}

function run(command, args, options = {}) {
  const result = execute(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`,
    );
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/**
 * Requests the panel over a new connection each time and reads the whole response. fetch is not used: it reuses connections from its pool, while controller commands run with spawnSync,
 * during which the event loop is blocked and cannot see the old panel process closing the connection, so the first request after restart would land on a closed connection (ECONNRESET).
 */
function requestPanel(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          // A non-JSON response is treated as body null, and the caller reports the error by status code.
        }
        resolve({ status, ok: status >= 200 && status < 300, body });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error(`Request to the panel timed out: ${url}`)));
    request.on('error', reject);
  });
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function controlInvocation(root, command, env) {
  const nodeExecutable = process.platform === 'win32'
    ? path.join(root, 'runtime', 'node.exe')
    : path.join(root, 'runtime', 'bin', 'node');
  return [
    nodeExecutable,
    ['--experimental-sqlite', path.join(root, 'app', 'mystryctl.mjs'), command],
    { cwd: root, env },
  ];
}

function runControl(root, command, env) {
  return run(...controlInvocation(root, command, env));
}

/** A controller command expected to fail: returns the exit code and merged output for the caller to judge. */
function runControlExpectingFailure(root, command, env) {
  const result = execute(...controlInvocation(root, command, env));
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** In the smoke test all controller output goes through pipes, not a terminal; no file in the log directory (including rotated old logs) may contain the password. */
async function assertLogsHaveNoCredentials(logDir) {
  for (const name of await fsp.readdir(logDir)) {
    const filePath = path.join(logDir, name);
    if (!(await fsp.stat(filePath)).isFile()) continue;
    assertNoCredentialsShown(await fsp.readFile(filePath, 'utf8'), `logs/${name}`);
  }
}

function verifyWrapper(root, env) {
  const output = process.platform === 'win32'
    ? run(
        process.env.ComSpec || 'cmd.exe',
        // The current directory is spelled out: with NoDefaultCurrentDirectoryInExePath set, cmd does not look for commands in the current directory.
        ['/d', '/s', '/c', '.\\mystryctl.cmd help'],
        { cwd: root, env },
      )
    : run(path.join(root, 'mystryctl'), ['help'], { cwd: root, env });
  // The command name in the usage line does not change with the UI language, and in source mode it is PanelManager here.
  if (!output.includes('mystryctl <command>')) {
    throw new Error('The platform entry script failed to call the portable controller in the package');
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function verifyManifest(portableRoot, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('manifest.json has no file checksum list');
  }
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const actualPaths = [];

  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(portableRoot, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`The final archive contains a symlink: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && relative !== 'manifest.json') {
        actualPaths.push(relative);
        const expectedFile = expected.get(relative);
        if (!expectedFile) throw new Error(`File not registered in manifest.json: ${relative}`);
        const stat = await fsp.stat(absolute);
        if (stat.size !== expectedFile.size) throw new Error(`File size mismatch: ${relative}`);
        if (await hashFile(absolute) !== expectedFile.sha256) {
          throw new Error(`File SHA-256 mismatch: ${relative}`);
        }
      }
    }
  }

  await visit(portableRoot);
  actualPaths.sort((left, right) => left.localeCompare(right));
  const expectedPaths = [...expected.keys()].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('The manifest.json file list does not match the extracted result');
  }
}

async function main() {
  const archive = process.argv[2];
  if (!archive) throw new Error('Usage: node smoke-portable.mjs <archive>');
  const archivePath = path.resolve(archive);
  if (!fs.existsSync(archivePath)) throw new Error(`Portable package does not exist: ${archivePath}`);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-portable-smoke-'));
  const extractDir = path.join(tempRoot, 'extract');
  let portableRoot = '';
  let started = false;
  let controlEnv = null;
  try {
    await fsp.mkdir(extractDir);
    run('tar', ['-xf', archivePath, '-C', extractDir]);
    portableRoot = path.join(extractDir, 'mystry-dashboard');
    const manifest = JSON.parse(
      await fsp.readFile(path.join(portableRoot, 'manifest.json'), 'utf8'),
    );
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
      throw new Error(
        `The portable package target does not match this machine: package=${manifest.platform}/${manifest.arch} `
          + `host=${process.platform}/${process.arch}`,
      );
    }
    await verifyManifest(portableRoot, manifest);
    for (const name of ['config', 'data', 'logs']) {
      const entries = await fsp.readdir(path.join(portableRoot, name));
      if (entries.length !== 0) throw new Error(`${name}/ in the release package must be empty`);
    }
    const sharedStat = await fsp.lstat(
      path.join(portableRoot, 'app', 'node_modules', '@mystry', 'shared'),
    );
    if (!sharedStat.isDirectory() || sharedStat.isSymbolicLink()) {
      throw new Error('@mystry/shared must be a physical directory inside the release package');
    }
    if (fs.existsSync(path.join(portableRoot, 'app', 'node_modules', 'typescript'))) {
      throw new Error('The release package must not contain the TypeScript dev dependency');
    }

    const port = await reservePort();
    const env = {
      ...process.env,
      MYSTRY_HOME: portableRoot,
      MYSTRY_CONFIG_PATH: path.join(portableRoot, 'config', 'panel.env'),
      MYSTRY_DATA_DIR: path.join(portableRoot, 'data'),
      MYSTRY_NO_BROWSER: '1',
      PORT: String(port),
    };
    controlEnv = env;
    const logDir = path.join(portableRoot, 'logs');
    const stdoutLogPath = path.join(logDir, 'panel.stdout.log');
    verifyWrapper(portableRoot, env);
    // runControl throws on a non-zero exit code; success is judged by the exit code and the file and health checks below.
    const startOutput = runControl(portableRoot, 'start', env);
    started = true;
    if (!fs.existsSync(path.join(portableRoot, 'config', 'panel.env'))) {
      throw new Error('The first start did not generate config in config/panel.env');
    }
    if (!fs.existsSync(path.join(portableRoot, 'data', 'panel.db'))) {
      throw new Error('The first start did not create the database at data/panel.db');
    }
    if (fs.existsSync(path.join(portableRoot, '.env'))) {
      throw new Error('A source-mode .env must not be generated in the portable root');
    }
    const health = await requestPanel(`http://127.0.0.1:${port}/api/health`);
    if (!health.ok || health.body?.service !== 'mystry-dashboard') {
      throw new Error(`Health check failed: HTTP ${health.status}`);
    }
    // The first start creates the admin automatically with the internal token (D-027); the Web login page also uses this endpoint to tell whether setup is still needed.
    const authStatus = await requestPanel(`http://127.0.0.1:${port}/api/auth/status`);
    const authBody = authStatus.body;
    if (!authStatus.ok || authBody?.needsSetup !== false) {
      throw new Error(
        `The first start did not create the admin automatically: HTTP ${authStatus.status} needsSetup=${authBody?.needsSetup}`,
      );
    }
    // After the admin is created, the setup token must be removed from the config immediately.
    const panelEnv = await fsp.readFile(path.join(portableRoot, 'config', 'panel.env'), 'utf8');
    if (/^\s*SETUP_TOKEN\s*=/m.test(panelEnv)) {
      throw new Error('config/panel.env still has SETUP_TOKEN after the admin was created automatically');
    }
    // The smoke test runs through pipes, so output is not a terminal: neither the startup output nor the log files may contain the generated password.
    assertNoCredentialsShown(startOutput, 'start output');
    await assertLogsHaveNoCredentials(logDir);
    runControl(portableRoot, 'status', env);
    // __is-running reports through its exit code whether the managed process is running.
    runControl(portableRoot, '__is-running', env);
    // A non-interactive reset-password must refuse before contacting the server, rather than resetting and then hiding the new password.
    const resetAttempt = runControlExpectingFailure(portableRoot, 'reset-password', env);
    if (resetAttempt.status === 0) {
      throw new Error('reset-password should not succeed when output is not a terminal');
    }
    assertNoCredentialsShown(resetAttempt.output, 'reset-password output');
    // The /api/auth/status requested above serves as the control, proving the request log works and the reset endpoint really was not called.
    assertRequestNotLogged(
      await fsp.readFile(stdoutLogPath, 'utf8'),
      '/api/launcher/reset-password',
      '/api/auth/status',
    );
    runControl(portableRoot, '__is-running', env);
    const expectedLogLine = lastLogLine(stdoutLogPath);
    assertLogsShowLine(runControl(portableRoot, 'logs', env), expectedLogLine);
    const openOutput = runControl(portableRoot, 'open', env);
    if (!openOutput.includes(`http://127.0.0.1:${port}`)) {
      throw new Error(`The open command did not return the panel URL:\n${openOutput}`);
    }
    assertNoCredentialsShown(runControl(portableRoot, 'restart', env), 'restart output');
    const restartedHealth = await requestPanel(`http://127.0.0.1:${port}/api/health`);
    if (!restartedHealth.ok) {
      throw new Error(`Health check after restart failed: HTTP ${restartedHealth.status}`);
    }
    runControl(portableRoot, 'stop', env);
    started = false;
    // A restart rotates the logs, so all log files are checked once more after stopping.
    await assertLogsHaveNoCredentials(logDir);
    console.log(`Portable package smoke test passed: ${path.basename(archivePath)}`);
  } finally {
    if (started && portableRoot && controlEnv) {
      try {
        runControl(portableRoot, 'stop', controlEnv);
      } catch {
        // Later cleanup is still attempted, and the main error is kept by the caller.
      }
    }
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
      await fsp.rm(resolvedTemp, {
        recursive: true,
        force: true,
        maxRetries: 15,
        retryDelay: 1_000,
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
