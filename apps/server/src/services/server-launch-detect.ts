import fs from 'node:fs';
import path from 'node:path';
import type { CoreType } from '@mystry/shared';
import { assertSafeInstanceRoot, resolveSafePath } from '../utils/path.js';
import { PanelError, throwIfAborted } from '../utils/errors.js';

export type ServerLaunchTarget = {
  value: string;
  coreType: CoreType;
  /** 从启动文件名里认出的 Minecraft 版本；认不出时为 null。 */
  mcVersion: string | null;
};

export type ModLoaderScanBudget = {
  maxDepth: number;
  maxEntries: number;
  deadlineMs: number;
  signal?: AbortSignal;
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

/** 探测实例根目录中的普通 jar 文件，不接受 symlink/junction。 */
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
 * 异步、有界地查找 Forge/NeoForge args 启动文件。
 * 返回相对实例根目录的路径，并拒绝遍历 symlink/junction。
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

  const preferredName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
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

    // 让出事件循环，避免长时间阻塞
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  return fallback[0] ?? null;
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
 * 「1.7」到「1.21.x」样式的版本号。前面不能紧挨数字或「数字.」，后面不能再跟数字段，
 * 这样 Forge 自己的版本号（14.23.5.2860）和 NeoForge 的（21.1.77）不会被当成 Minecraft 版本。
 */
const MC_VERSION_IN_NAME_RE = /(?<!\d)(?<!\d\.)1\.(\d{1,2})(?:\.\d{1,2})?(?!\.?\d)/;

/**
 * 从启动文件名（如 forge-1.12.2-14.23.5.2860.jar、minecraft_server.1.12.2.jar，
 * 或 Forge args 文件所在的 1.20.1-47.2.0 目录）里认 Minecraft 版本。
 * 只在核心类型已认出时才用：自定义 jar 名字里的数字不一定是游戏版本。
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

/** 根目录里已找到的 jar 属于哪种核心、哪个版本。 */
export function describeJarLaunchTarget(jarFile: string): ServerLaunchTarget {
  return launchTarget(jarFile, inferJarCoreType(jarFile));
}

/** 导入表单的「自动识别 / 自定义」提交的是 custom：有识别结果时以识别结果为准。 */
export function resolveImportedCoreType(requested: CoreType | undefined, detected: CoreType): CoreType {
  return requested && requested !== 'custom' ? requested : detected;
}

/** 自动识别普通 jar 或现代 Forge/NeoForge args 启动目标。 */
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
