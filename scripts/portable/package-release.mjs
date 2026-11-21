import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../is-main-module.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const FLAG_OPTIONS = ['skip-install', 'skip-verify', 'skip-smoke', 'no-force', 'allow-dirty'];

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    const name = token.slice(2);
    if (FLAG_OPTIONS.includes(name)) {
      result[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} needs a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function assertNodeVersion() {
  const match = /^v(\d+)\./.exec(process.version);
  const major = match ? Number(match[1]) : 0;
  if (major < 22) {
    throw new Error(`Node.js must be 22 or later; current: ${process.version}`);
  }
}

function npmCommand() {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c'],
    };
  }
  return { command: 'npm', args: [] };
}

function runNpm(label, scriptArguments) {
  const { command, args } = npmCommand();
  if (process.platform === 'win32') {
    args.push(`npm.cmd ${scriptArguments.join(' ')}`);
  } else {
    args.push(...scriptArguments);
  }
  run(label, command, args);
}

function run(label, command, args) {
  console.log(`\n[${label}] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Step "${label}" failed: ${command} ${args.join(' ')}`);
  }
}

function releasePlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

function archiveExtension(platform) {
  return platform === 'win32' ? 'zip' : 'tar.gz';
}

export async function createReleaseMetadata(outputDir, execute = run) {
  await execute(
    'Generate SBOM',
    process.execPath,
    [
      path.join(scriptDir, 'create-sbom.mjs'),
      '--output',
      path.join(outputDir, 'sbom.cdx.json'),
    ],
  );
  await execute(
    'Generate checksums',
    process.execPath,
    [path.join(scriptDir, 'create-checksums.mjs'), outputDir],
  );
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const outputDir = path.resolve(args['output-dir'] || 'release');
  const allowDirty = Boolean(args['allow-dirty']);
  const force = !args['no-force'];
  const skipInstall = Boolean(args['skip-install']);
  const skipVerify = Boolean(args['skip-verify']);
  const skipSmoke = Boolean(args['skip-smoke']);

  assertNodeVersion();

  const rootPackage = JSON.parse(
    await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const version = rootPackage.version;
  const platformName = releasePlatform(process.platform);
  const arch = process.arch === 'amd64' ? 'x64' : process.arch;
  const archiveName = `mystry-v${version}-${platformName}-${arch}.${archiveExtension(process.platform)}`;
  const archivePath = path.join(outputDir, archiveName);

  console.log(`One-step packaging started: v${version} (${platformName}/${arch})`);
  console.log(`Output directory: ${outputDir}`);
  console.log(
    `Switches: skip install=${skipInstall} skip verify=${skipVerify} skip smoke=${skipSmoke} `
      + `force=${force} allow dirty tree=${allowDirty}`,
  );

  if (!skipInstall) {
    runNpm('Install dependencies', ['ci']);
  }

  if (skipVerify) {
    runNpm('Build the app', ['run', 'build']);
  } else {
    runNpm('Full verification', ['run', 'verify']);
    runNpm('Production dependency audit', ['run', 'audit:production']);
  }

  const packageArguments = [
    path.join(scriptDir, 'package-portable.mjs'),
    '--platform', process.platform,
    '--arch', process.arch,
    '--output-dir', outputDir,
  ];
  if (force) packageArguments.push('--force');
  if (allowDirty) packageArguments.push('--allow-dirty');
  if (args['runtime-dir']) {
    packageArguments.push('--runtime-dir', path.resolve(args['runtime-dir']));
  }
  run('Assemble the portable package', process.execPath, packageArguments);

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Packaging did not produce the expected archive: ${archivePath}`);
  }
  console.log(`Archive generated: ${archivePath}`);

  if (!skipSmoke) {
    run(
      'Smoke test',
      process.execPath,
      [path.join(scriptDir, 'smoke-portable.mjs'), archivePath],
    );
  }

  await createReleaseMetadata(outputDir);

  const artifacts = (await fsp.readdir(outputDir)).sort((left, right) =>
    left.localeCompare(right),
  );
  console.log(`\nOne-step packaging finished. Files in the release directory ${outputDir}:`);
  for (const name of artifacts) {
    console.log(`  - ${name}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nOne-step packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
