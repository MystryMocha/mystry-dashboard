import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../is-main-module.mjs';
import yazl from 'yazl';
import { fetchNodeRuntime } from './fetch-node-runtime.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const packageRootName = 'mystry-dashboard';

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    const name = token.slice(2);
    if (name === 'force') {
      result.force = true;
      continue;
    }
    if (name === 'allow-dirty') {
      result.allowDirty = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} needs a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function normalizePlatform(value) {
  if (value === 'windows') return 'win32';
  if (value === 'macos') return 'darwin';
  return value;
}

function releasePlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

async function copyFileOrDirectory(source, destination, options = {}) {
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to copy a symlink: ${source}`);
  if (stat.isDirectory()) {
    await fsp.cp(source, destination, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: true,
      ...options,
    });
    return;
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || ''}`,
    );
  }
  return result.stdout.trim();
}

async function assertBuildOutputs() {
  const required = [
    'apps/server/dist/index.js',
    'apps/web/dist/index.html',
    'packages/shared/dist/index.js',
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(repoRoot, relative)));
  if (missing.length > 0) {
    throw new Error(`Build output is missing; run npm run build first: ${missing.join(', ')}`);
  }
}

async function installProductionDependencies(tempRoot) {
  const installRoot = path.join(tempRoot, 'production-install');
  const manifests = [
    'package.json',
    'package-lock.json',
    'apps/server/package.json',
    'apps/web/package.json',
    'packages/shared/package.json',
  ];
  for (const relative of manifests) {
    await copyFileOrDirectory(
      path.join(repoRoot, relative),
      path.join(installRoot, relative),
    );
  }
  const npmCommand = process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : 'npm';
  const npmArguments = process.platform === 'win32'
    ? [
        '/d',
        '/s',
        '/c',
        'npm.cmd ci --omit=dev --ignore-scripts --no-audit --fund=false',
      ]
    : ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--fund=false'];
  run(
    npmCommand,
    npmArguments,
    {
      cwd: installRoot,
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE
          || path.join(os.tmpdir(), 'mystry-portable-npm-cache'),
      },
    },
  );
  return path.join(installRoot, 'node_modules');
}

function workspaceEntry(relative) {
  const normalized = relative.split(path.sep).join('/');
  return [
    'node_modules/@mystry/server',
    'node_modules/@mystry/web',
    'node_modules/@mystry/shared',
  ].some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Paths in the portable package use only printable ASCII. Under a non-UTF-8 code page (verified under Chinese GBK), the tar shipped with Windows (bsdtar)
 * cannot convert non-ASCII file names in a ZIP, skips the entry and exits with an error, so both the smoke test and users extracting with tar would fail.
 * Among production dependencies only test fixtures are named this way (for example `test/fixtures/snow ☃` in @fastify/send), and they are not needed at runtime.
 */
export function isArchiveSafeName(name) {
  return /^[ -~]+$/.test(name);
}

async function copyProductionDependencies(source, destination) {
  await fsp.cp(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (current) => {
      const relative = path.relative(path.dirname(source), current);
      // When a directory is filtered out its whole subtree is not copied.
      return !workspaceEntry(relative) && isArchiveSafeName(path.basename(current));
    },
  });
  const sharedDestination = path.join(destination, '@mystry', 'shared');
  await fsp.mkdir(sharedDestination, { recursive: true });
  await copyFileOrDirectory(
    path.join(repoRoot, 'packages', 'shared', 'package.json'),
    path.join(sharedDestination, 'package.json'),
  );
  await copyFileOrDirectory(
    path.join(repoRoot, 'packages', 'shared', 'dist'),
    path.join(sharedDestination, 'dist'),
  );
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function collectFiles(rootDir) {
  const result = [];
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the portable package: ${relative}`);
      // Dependencies were already filtered while copying; a non-ASCII name among the panel's own files fails at packaging time, rather than being left until the user extracts.
      if (!isArchiveSafeName(entry.name)) throw new Error(`Non-ASCII file names are not allowed in the portable package: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && relative !== 'manifest.json') {
        const stat = await fsp.stat(absolute);
        result.push({
          path: relative,
          size: stat.size,
          sha256: await hashFile(absolute),
        });
      }
    }
  }
  await visit(rootDir);
  return result;
}

function assertCleanWorktreeForRelease(allowDirty) {
  if (allowDirty || process.env.MYSTRY_PORTABLE_ALLOW_DIRTY === '1') return;
  try {
    const status = run('git', ['status', '--porcelain']);
    if (status) {
      throw new Error(
        'The working tree is not clean; refusing to build a releasable portable package. For local debugging set MYSTRY_PORTABLE_ALLOW_DIRTY=1 or pass --allow-dirty',
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('working tree is not clean')) throw error;
    // Skipped when not a Git repo (local, non-release cases only)
  }
}

function getGitSha() {
  try {
    return run('git', ['rev-parse', 'HEAD']);
  } catch {
    if (process.env.GITHUB_SHA?.trim()) return process.env.GITHUB_SHA.trim();
    return 'unknown';
  }
}

// Notes that public users read directly: English first, Chinese after, and both sections must be changed together when a fact changes
export async function createPortableReadme(destination, version) {
  const content = `Mystry Dashboard ${version} Portable Preview
中文说明在英文之后。

Windows:
  Double-click mystryctl.cmd. The panel runs in the background with no window of its own. The window you see shows the account and logs.
  Closing the window does not affect the panel or your servers. To stop them, open mystryctl.cmd again and press Ctrl+C.

Linux / macOS:
  chmod +x mystryctl
  ./mystryctl start

Commands:
  start, watch, foreground, stop, restart, status, logs, open, reset-password, menu, help

Important notes:
1. Node.js is bundled. You don't need to install Node or run npm install.
2. First start creates the admin account and a random 16-character password shown once in the window (default address: http://127.0.0.1:3000). Use reset-password locally if you forget it.
3. This package doesn't include the Java runtime Minecraft needs. It uses the java on your system PATH by default. You can also scan for and select another installed runtime in the panel.
4. This preview doesn't register a system service or start automatically at boot.
5. The config, data and logs folders are created on first start. When you upgrade, stop the panel and keep these folders.
6. The panel only listens on 127.0.0.1 by default. Don't expose the panel port directly to the untrusted public internet.

Project home: https://github.com/MystryMocha/mystry-dashboard

----------------------------------------

Mystry Dashboard ${version} 便携预览版

Windows：
  双击 mystryctl.cmd，面板在后台运行，没有单独的窗口，看到的窗口显示账号和日志。
  关闭窗口不影响面板和服务端。要停止时，重新打开 mystryctl.cmd 并按 Ctrl+C。

Linux / macOS：
  chmod +x mystryctl
  ./mystryctl start

支持命令：
  start, watch, foreground, stop, restart, status, logs, open, reset-password, menu, help

重要说明：
1. 本包自带 Node.js，不需要安装 Node 或运行 npm install。
2. 首次启动会自动创建管理员 admin 和随机 16 位密码，只在窗口里显示一次（默认访问地址 http://127.0.0.1:3000）；忘记密码可在面板运行期间执行 reset-password 重置。
3. 本包不含 Minecraft Java；默认使用系统 PATH 中的 java，也可在面板中扫描并选择其他已安装运行时。
4. 本预览版不会注册系统服务，也不会开机自动启动。
5. config、data、logs 由首次启动创建。升级时请停止面板，并保留这些目录。
6. 默认只监听 127.0.0.1。不要把面板端口直接暴露到不可信公网。

项目主页：https://github.com/MystryMocha/mystry-dashboard
`;
  await fsp.writeFile(destination, content, 'utf8');
}

async function archivePackage(stageRoot, packageDir, archivePath, platform) {
  if (platform !== 'win32') {
    run('tar', ['-czf', archivePath, path.basename(packageDir)], { cwd: stageRoot });
    return;
  }

  const zipFile = new yazl.ZipFile();
  const rootName = path.basename(packageDir);
  zipFile.addEmptyDirectory(rootName);

  async function addDirectory(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(stageRoot, absolute).split(path.sep).join('/');
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Refusing to write a symlink into the ZIP: ${relative}`);
      if (entry.isDirectory()) {
        zipFile.addEmptyDirectory(relative, { mtime: stat.mtime, mode: stat.mode });
        await addDirectory(absolute);
      } else if (entry.isFile()) {
        zipFile.addFile(absolute, relative, { mtime: stat.mtime, mode: stat.mode });
      }
    }
  }

  await addDirectory(packageDir);
  const output = fs.createWriteStream(archivePath, { flags: 'wx' });
  const completed = pipeline(zipFile.outputStream, output);
  zipFile.end();
  await completed;
}

export async function packagePortable({
  platform = process.platform,
  arch = process.arch,
  outputDir = path.join(repoRoot, 'release'),
  runtimeDir,
  force = false,
  allowDirty = false,
}) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = arch === 'amd64' ? 'x64' : arch;
  if (targetPlatform !== process.platform || targetArch !== process.arch) {
    throw new Error(
      `The portable package must be built natively on the target system: target=${targetPlatform}/${targetArch} `
        + `runner=${process.platform}/${process.arch}`,
    );
  }
  if (!['win32', 'linux', 'darwin'].includes(targetPlatform)) {
    throw new Error(`Unsupported platform: ${targetPlatform}`);
  }
  if (targetPlatform === 'win32' && targetArch !== 'x64') {
    throw new Error('The initial Windows release supports x64 only');
  }
  if (!['x64', 'arm64'].includes(targetArch)) throw new Error(`Unsupported architecture: ${targetArch}`);

  await assertBuildOutputs();
  assertCleanWorktreeForRelease(allowDirty);
  const rootPackage = JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = rootPackage.version;
  const extension = targetPlatform === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `mystry-v${version}-${releasePlatform(targetPlatform)}-${targetArch}.${extension}`;
  const resolvedOutput = path.resolve(outputDir);
  const archivePath = path.join(resolvedOutput, archiveName);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  if (fs.existsSync(archivePath)) {
    if (!force) throw new Error(`The output file already exists; pass --force to allow overwriting: ${archivePath}`);
    await fsp.unlink(archivePath);
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mystry-portable-package-'));
  const stageRoot = path.join(tempRoot, 'stage');
  const portableRoot = path.join(stageRoot, packageRootName);
  try {
    await Promise.all([
      fsp.mkdir(path.join(portableRoot, 'app'), { recursive: true }),
      fsp.mkdir(path.join(portableRoot, 'config'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(portableRoot, 'data'), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(portableRoot, 'logs'), { recursive: true, mode: 0o700 }),
    ]);

    if (runtimeDir) {
      await copyFileOrDirectory(path.resolve(runtimeDir), path.join(portableRoot, 'runtime'));
    } else {
      await fetchNodeRuntime({
        platform: targetPlatform,
        arch: targetArch,
        outputDir: path.join(portableRoot, 'runtime'),
      });
    }

    await copyFileOrDirectory(
      path.join(repoRoot, 'apps', 'server', 'dist'),
      path.join(portableRoot, 'app', 'server', 'dist'),
    );
    await copyFileOrDirectory(
      path.join(repoRoot, 'apps', 'server', 'package.json'),
      path.join(portableRoot, 'app', 'server', 'package.json'),
    );
    await copyFileOrDirectory(
      path.join(repoRoot, 'apps', 'web', 'dist'),
      path.join(portableRoot, 'app', 'web', 'dist'),
    );
    await copyFileOrDirectory(
      path.join(repoRoot, 'packages', 'shared', 'dist'),
      path.join(portableRoot, 'app', 'shared', 'dist'),
    );
    await copyFileOrDirectory(
      path.join(repoRoot, 'packages', 'shared', 'package.json'),
      path.join(portableRoot, 'app', 'shared', 'package.json'),
    );
    await copyFileOrDirectory(
      path.join(scriptDir, 'mystryctl.mjs'),
      path.join(portableRoot, 'app', 'mystryctl.mjs'),
    );
    await copyFileOrDirectory(
      path.join(repoRoot, 'LICENSE'),
      path.join(portableRoot, 'LICENSE'),
    );

    if (targetPlatform === 'win32') {
      await copyFileOrDirectory(
        path.join(scriptDir, 'mystryctl.cmd'),
        path.join(portableRoot, 'mystryctl.cmd'),
      );
    } else {
      const wrapperPath = path.join(portableRoot, 'mystryctl');
      await copyFileOrDirectory(path.join(scriptDir, 'mystryctl.sh'), wrapperPath);
      await fsp.chmod(wrapperPath, 0o755);
    }

    const productionNodeModules = await installProductionDependencies(tempRoot);
    await copyProductionDependencies(
      productionNodeModules,
      path.join(portableRoot, 'app', 'node_modules'),
    );

    await fsp.writeFile(path.join(portableRoot, 'VERSION'), `${version}\n`, 'utf8');
    await createPortableReadme(path.join(portableRoot, 'README.txt'), version);
    const runtime = JSON.parse(
      await fsp.readFile(path.join(portableRoot, 'runtime', 'runtime.json'), 'utf8'),
    );
    const files = await collectFiles(portableRoot);
    const manifest = {
      schemaVersion: 1,
      product: 'mystry-dashboard',
      version,
      gitSha: getGitSha(),
      nodeVersion: runtime.nodeVersion,
      platform: targetPlatform,
      arch: targetArch,
      builtAt: new Date().toISOString(),
      entrypoint: 'app/server/dist/index.js',
      files,
    };
    await fsp.writeFile(
      path.join(portableRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await archivePackage(stageRoot, portableRoot, archivePath, targetPlatform);
    return { archivePath, archiveName, manifest };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
      await fsp.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await packagePortable({
    platform: args.platform || process.platform,
    arch: args.arch || process.arch,
    outputDir: args['output-dir'] ? path.resolve(args['output-dir']) : undefined,
    runtimeDir: args['runtime-dir'] ? path.resolve(args['runtime-dir']) : undefined,
    force: Boolean(args.force),
    allowDirty: Boolean(args.allowDirty),
  });
  console.log(`Portable package generated: ${result.archivePath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
