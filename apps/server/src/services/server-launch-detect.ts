import fs from 'node:fs';
import path from 'node:path';
import type { CoreType } from '@mystry/shared';
import { assertSafeInstanceRoot, resolveSafePath } from '../utils/path.js';
import { PanelError, throwIfAborted } from '../utils/errors.js';

export type ServerLaunchTarget = {
  value: string;
  coreType: CoreType;
  /** Minecraft version recognized from the launch file name; null when unrecognized. */
  mcVersion: string | null;
};

export type ModLoaderScanBudget = {
  maxDepth: number;
  maxEntries: number;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Target platform for choosing win_args.txt vs unix_args.txt; defaults to process.platform. */
  platform?: NodeJS.Platform;
};

class ModLoaderScanLimitError extends PanelError {
  constructor(key: 'server.imports.launchScan.timeout' | 'server.imports.launchScan.tooManyEntries' | 'server.imports.launchScan.tooDeep') {
    super(key);
    this.name = 'ModLoaderScanLimitError';
  }
}

function isRegularFile(root: string, relativePath: string): boolean {
  try {
    const target = resolveSafePath(root, relativePath);
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Detects regular jar files in the instance root; symlinks/junctions are not accepted. */
export function detectJarFile(dir: string): string | null {
  assertSafeInstanceRoot(dir);
  const preferred = ['server.jar', 'paper.jar', 'fabric-server-launch.jar', 'minecraft_server.jar'];
  for (const name of preferred) {
    if (isRegularFile(dir, name)) return name;
  }

  const jars = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jar') && !entry.name.includes('installer'))
    .map((entry) => entry.name)
    .filter((name) => isRegularFile(dir, name));
  return jars[0] ?? null;
}

function modLoaderRelativeBase(kind: 'forge' | 'neoforge'): string {
  return kind === 'forge'
    ? 'libraries/net/minecraftforge/forge'
    : 'libraries/net/neoforged/neoforge';
}

/**
 * Asynchronously finds the Forge/NeoForge args launch file within bounds.
 * Returns a path relative to the instance root, and refuses to traverse symlinks/junctions.
 */
export async function findModLoaderArgsFile(
  dir: string,
  kind: 'forge' | 'neoforge',
  budget: ModLoaderScanBudget,
): Promise<string | null> {
  const startedAt = Date.now();
  const relativeBase = modLoaderRelativeBase(kind);
  const base = resolveSafePath(dir, relativeBase);
  if (!fs.existsSync(base)) return null;
  assertSafeInstanceRoot(base);

  const preferredName = (budget.platform ?? process.platform) === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const fallback: string[] = [];
  let visited = 0;

  type QueueItem = { relative: string; depth: number };
  const queue: QueueItem[] = [{ relative: relativeBase, depth: 0 }];

  const checkBudget = (): void => {
    throwIfAborted(budget.signal);
    if (Date.now() - startedAt > budget.deadlineMs) {
      throw new ModLoaderScanLimitError('server.imports.launchScan.timeout');
    }
    if (visited >= budget.maxEntries) {
      throw new ModLoaderScanLimitError('server.imports.launchScan.tooManyEntries');
    }
  };

  while (queue.length > 0) {
    checkBudget();
    const currentItem = queue.pop()!;
    if (currentItem.depth > budget.maxDepth) {
      throw new ModLoaderScanLimitError('server.imports.launchScan.tooDeep');
    }

    const current = resolveSafePath(dir, currentItem.relative);
    assertSafeInstanceRoot(current);
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      checkBudget();
      visited += 1;
      const relative = path.join(currentItem.relative, entry.name);
      const full = resolveSafePath(dir, relative);
      const stat = await fs.promises.lstat(full);
      if (stat.isSymbolicLink()) {
        throw new PanelError('server.imports.launchScan.symlink');
      }
      if (stat.isDirectory()) {
        assertSafeInstanceRoot(full);
        queue.push({ relative, depth: currentItem.depth + 1 });
        continue;
      }
      if (!stat.isFile()) continue;
      const normalized = relative.replace(/\\/g, '/');
      if (entry.name === preferredName) return normalized;
      if (entry.name.endsWith('_args.txt')) fallback.push(normalized);
    }

    // Yield to the event loop, to avoid blocking for a long time
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  return fallback[0] ?? null;
}

/**
 * Resolves a Forge/NeoForge args file path for the target platform: modern installers ship both win_args.txt
 * and unix_args.txt side by side, so a backup restored (or data directory moved) across Windows and Linux must
 * switch to the current platform's sibling instead of keeping the source OS's args file.
 */
export function resolvePlatformModLoaderArgsFile(
  instanceDir: string,
  argsRelPath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const normalized = argsRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const base = path.posix.basename(normalized);
  const preferredName = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  if (base === 'win_args.txt' || base === 'unix_args.txt') {
    const dir = path.posix.dirname(normalized);
    const preferredRel = dir === '.' ? preferredName : `${dir}/${preferredName}`;
    if (isRegularFile(instanceDir, preferredRel)) return preferredRel;
  }
  return isRegularFile(instanceDir, normalized) ? normalized : null;
}

function inferJarCoreType(jarFile: string): CoreType {
  const normalized = jarFile.toLowerCase();
  if (normalized.includes('paper')) return 'paper';
  if (normalized.includes('fabric')) return 'fabric';
  if (normalized.includes('neoforge')) return 'neoforge';
  if (normalized.includes('forge')) return 'forge';
  if (normalized === 'server.jar' || normalized.includes('minecraft_server')) return 'vanilla';
  return 'custom';
}

/**
 * Version numbers in the "1.7" to "1.21.x" style. It must not be immediately preceded by a digit or "digit.", nor followed by another numeric segment,
 * so Forge's own version numbers (14.23.5.2860) and NeoForge's (21.1.77) are not taken as Minecraft versions.
 */
const MC_VERSION_IN_NAME_RE = /(?<!\d)(?<!\d\.)1\.(\d{1,2})(?:\.\d{1,2})?(?!\.?\d)/;

/**
 * Recognizes the Minecraft version from a launch file name (such as forge-1.12.2-14.23.5.2860.jar or minecraft_server.1.12.2.jar,
 * or the 1.20.1-47.2.0 directory holding a Forge args file).
 * Used only when the core type is already recognized: numbers in a custom jar name are not necessarily the game version.
 */
export function inferMcVersionFromLaunchTarget(target: string, coreType: CoreType): string | null {
  if (coreType === 'custom' || coreType === 'neoforge') return null;
  const match = MC_VERSION_IN_NAME_RE.exec(target.replace(/\\/g, '/'));
  if (!match) return null;
  const minor = Number(match[1]);
  return minor >= 7 && minor <= 21 ? match[0] : null;
}

function launchTarget(value: string, coreType: CoreType): ServerLaunchTarget {
  return { value, coreType, mcVersion: inferMcVersionFromLaunchTarget(value, coreType) };
}

/** Which core and version the jar found in the root belongs to. */
export function describeJarLaunchTarget(jarFile: string): ServerLaunchTarget {
  return launchTarget(jarFile, inferJarCoreType(jarFile));
}

/** "Auto-detect / Custom" in the import form submits custom: when there is a detection result, it wins. */
export function resolveImportedCoreType(requested: CoreType | undefined, detected: CoreType): CoreType {
  return requested && requested !== 'custom' ? requested : detected;
}

/** Auto-detects a regular jar or a modern Forge/NeoForge args launch target. */
export async function detectServerLaunchTarget(
  dir: string,
  budget: ModLoaderScanBudget,
): Promise<ServerLaunchTarget | null> {
  const neoForgeArgs = await findModLoaderArgsFile(dir, 'neoforge', budget);
  if (neoForgeArgs) return launchTarget(`@args:${neoForgeArgs}`, 'neoforge');

  const forgeArgs = await findModLoaderArgsFile(dir, 'forge', budget);
  if (forgeArgs) return launchTarget(`@args:${forgeArgs}`, 'forge');

  const jarFile = detectJarFile(dir);
  return jarFile ? launchTarget(jarFile, inferJarCoreType(jarFile)) : null;
}

export function isModLoaderScanLimitError(error: unknown): error is ModLoaderScanLimitError {
  return error instanceof ModLoaderScanLimitError;
}
