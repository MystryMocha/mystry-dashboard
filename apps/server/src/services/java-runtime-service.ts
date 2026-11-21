import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JavaRuntimeInfo } from '@mystry/shared';
import { config } from '../config.js';
import { getDb, type JavaRuntimeRow } from '../db.js';
import { nowIso } from '../utils/path.js';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { PanelError } from '../utils/errors.js';

/**
 * Java runtime registry:
 * - Candidate paths come only from the panel's own scan (JAVA_HOME, common install directories, the data directory where the panel installs Java itself); paths submitted in requests are never accepted.
 * - Each candidate's file name must be java/java.exe, and running -version must produce output from which a version number can be parsed;
 *   it is written to the registry only after passing both checks, ensuring it "definitely is java".
 * - Instances can only reference runtimes in the registry by ID; NULL means use the java on PATH.
 */

const execFileAsync = promisify(execFile);

/** Timeout for verifying a single candidate with -version; keeps abnormal binaries from slowing down the scan */
const VERIFY_TIMEOUT_MS = 4_000;
/** Scan result cache, so the frontend does not trigger full scans frequently */
const SCAN_CACHE_MS = 60_000;
/** Minimum interval allowed between manual refreshes, so authenticated requests cannot keep spawning large numbers of child processes */
const FORCE_SCAN_COOLDOWN_MS = 30_000;

let lastScanAt = 0;
let lastForcedScanAt = 0;
let scanPromise: Promise<JavaRuntimeInfo[]> | null = null;

type JavaVersionRunner = (
  javaPath: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

const runJavaVersion: JavaVersionRunner = async (javaPath, args, options) => {
  const result = await execFileAsync(javaPath, args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

let versionRunner: JavaVersionRunner = runJavaVersion;

/** For tests: replaces the execution of java -version (scan, registration and pre-start re-verification all go through it); pass null to restore real execution and clear the scan cache. */
export function setJavaVersionRunnerForTests(runner: JavaVersionRunner | null): void {
  versionRunner = runner ?? runJavaVersion;
  lastScanAt = 0;
  lastForcedScanAt = 0;
}

type RuntimeSource = JavaRuntimeRow['source'];

/** Java installed automatically by the panel all goes here (java-install-service.ts), one subdirectory per version. */
export function panelJavaRoot(): string {
  return path.join(config.dataDir, 'runtimes', 'java');
}

function runtimeId(javaPath: string): string {
  const normalized = process.platform === 'win32' ? javaPath.toLowerCase() : javaPath;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Verifies that a candidate really is Java: the file name must be java/java.exe, and a version number must be parseable from the -version output. */
export async function verifyJavaExecutable(
  javaPath: string,
  run: JavaVersionRunner = versionRunner,
): Promise<{ version: string; majorVersion: number } | null> {
  const base = path.basename(javaPath).toLowerCase();
  if (base !== 'java' && base !== 'java.exe') return null;
  try {
    const { stdout, stderr } = await run(javaPath, ['-version'], {
      windowsHide: true,
      timeout: VERIFY_TIMEOUT_MS,
      // Candidate executables are third-party programs and must never inherit panel secrets or data directory config.
      env: getMinecraftChildEnv(),
    });
    const text = `${stderr}\n${stdout}`;
    const match = text.match(/version\s+"([^"]+)"/i) || text.match(/version\s+(\S+)/i);
    if (!match) return null;
    const version = match[1];
    // "1.8.0_202" → 8; "17.0.2" / "21" → 17 / 21
    const majorVersion = version.startsWith('1.')
      ? Number(version.split('.')[1])
      : Number(version.split('.')[0]);
    if (!Number.isInteger(majorVersion) || majorVersion <= 0) return null;
    return { version, majorVersion };
  } catch {
    return null;
  }
}

/** Collects candidate paths (no deduplication or verification; verification is done together in scan). */
function collectCandidates(): Array<{ path: string; source: RuntimeSource }> {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates: Array<{ path: string; source: RuntimeSource }> = [];

  // Java installed by the panel must be found on every scan, or the next scan would mark it unavailable.
  try {
    for (const entry of fs.readdirSync(panelJavaRoot(), { withFileTypes: true })) {
      // Only version directories the panel itself created are accepted; .staging-* are temp directories of installs in progress.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      candidates.push({ path: path.join(panelJavaRoot(), entry.name, 'bin', exe), source: 'panel' });
    }
  } catch {
    // No Java has been installed yet: the directory does not exist.
  }

  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    candidates.push({ path: path.join(javaHome, 'bin', exe), source: 'env' });
  }

  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
      if (!base) continue;
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
        roots.push(path.join(base, vendor));
      }
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm', '/opt/java', '/usr/local/openjdk');
  }

  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const binDir =
        process.platform === 'darwin'
          ? path.join(root, entry.name, 'Contents', 'Home', 'bin')
          : path.join(root, entry.name, 'bin');
      candidates.push({ path: path.join(binDir, exe), source: 'scan' });
    }
  }

  return candidates;
}

function rowToInfo(row: JavaRuntimeRow): JavaRuntimeInfo {
  return {
    id: row.id,
    path: row.path,
    version: row.version,
    majorVersion: row.major_version,
    source: row.source,
    verifiedAt: row.verified_at,
    available: Boolean(row.available),
  };
}

export function listJavaRuntimes(): JavaRuntimeInfo[] {
  const rows = getDb()
    .prepare('SELECT * FROM java_runtimes ORDER BY available DESC, major_version DESC, path ASC')
    .all() as JavaRuntimeRow[];
  return rows.map(rowToInfo);
}

export function getJavaRuntime(id: string): JavaRuntimeRow | null {
  const row = getDb().prepare('SELECT * FROM java_runtimes WHERE id = ?').get(id) as
    | JavaRuntimeRow
    | undefined;
  return row ?? null;
}

function markRuntimeUnavailable(id: string): void {
  getDb().prepare('UPDATE java_runtimes SET available = 0 WHERE id = ?').run(id);
}

/**
 * Resolves the Java an instance should actually execute. A bound entry is re-verified before every execution,
 * so an unknown program is not run when the path was deleted or replaced after the scan.
 */
export async function resolveJavaRuntimeCommand(javaRuntimeId: string | null | undefined): Promise<string> {
  if (javaRuntimeId === null || javaRuntimeId === undefined) return 'java';
  const runtime = getJavaRuntime(javaRuntimeId);
  if (!runtime || !runtime.available) {
    throw new PanelError('server.instance.javaRuntimeUnavailable');
  }
  if (!fs.existsSync(runtime.path)) {
    markRuntimeUnavailable(runtime.id);
    throw new PanelError('server.instance.javaRuntimeFileMissing', { path: runtime.path });
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(runtime.path);
  } catch {
    markRuntimeUnavailable(runtime.id);
    throw new PanelError('server.instance.javaRuntimePathUnresolved', { path: runtime.path });
  }
  if (runtimeId(realPath) !== runtime.id) {
    markRuntimeUnavailable(runtime.id);
    throw new PanelError('server.instance.javaRuntimePathChanged');
  }

  const verified = await verifyJavaExecutable(realPath);
  if (!verified) {
    markRuntimeUnavailable(runtime.id);
    throw new PanelError('server.instance.javaRuntimeVerifyFailed');
  }
  getDb()
    .prepare(
      `UPDATE java_runtimes
       SET version = ?, major_version = ?, verified_at = ?, available = 1
       WHERE id = ?`,
    )
    .run(verified.version, verified.majorVersion, nowIso(), runtime.id);
  return realPath;
}

function runtimeUpsert() {
  return getDb().prepare(
    `INSERT INTO java_runtimes (id, path, version, major_version, source, verified_at, available)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path,
       version = excluded.version,
       major_version = excluded.major_version,
       source = excluded.source,
       verified_at = excluded.verified_at,
       available = 1`,
  );
}

async function performScan(): Promise<JavaRuntimeInfo[]> {
  const verifiedRuntimes: Array<{
    id: string;
    path: string;
    version: string;
    majorVersion: number;
    source: RuntimeSource;
  }> = [];
  const seen = new Set<string>();
  for (const candidate of collectCandidates()) {
    if (!fs.existsSync(candidate.path)) continue;
    let realPath = candidate.path;
    try {
      realPath = fs.realpathSync(candidate.path);
    } catch {
      continue;
    }
    const dedupeKey = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const verified = await verifyJavaExecutable(realPath);
    if (!verified) continue;
    verifiedRuntimes.push({
      id: runtimeId(realPath),
      path: realPath,
      version: verified.version,
      majorVersion: verified.majorVersion,
      source: candidate.source,
    });
  }

  const db = getDb();
  const markAllUnavailable = db.prepare('UPDATE java_runtimes SET available = 0');
  markAllUnavailable.run();
  const verifiedAt = nowIso();
  for (const runtime of verifiedRuntimes) {
    runtimeUpsert().run(
      runtime.id,
      runtime.path,
      runtime.version,
      runtime.majorVersion,
      runtime.source,
      verifiedAt,
    );
  }
  lastScanAt = Date.now();
  return listJavaRuntimes();
}

/**
 * Registers Java the panel has just installed: the path must be inside the panel install directory, and -version must pass verification.
 * Returns the registered entry; returns null when verification fails.
 */
export async function registerPanelJavaRuntime(javaPath: string): Promise<JavaRuntimeInfo | null> {
  let realPath: string;
  let realRoot: string;
  try {
    realPath = fs.realpathSync(javaPath);
    realRoot = fs.realpathSync(panelJavaRoot());
  } catch {
    return null;
  }
  const relative = path.relative(realRoot, realPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const verified = await verifyJavaExecutable(realPath);
  if (!verified) return null;
  const id = runtimeId(realPath);
  runtimeUpsert().run(id, realPath, verified.version, verified.majorVersion, 'panel', nowIso());
  return listJavaRuntimes().find((runtime) => runtime.id === id) ?? null;
}

/**
 * Scans and verifies candidates and upserts them into the registry. Entries not found by the latest scan are marked unavailable,
 * keeping instance bindings so the UI can prompt the user to choose again.
 */
export async function scanJavaRuntimes(force = false): Promise<JavaRuntimeInfo[]> {
  const now = Date.now();
  if (scanPromise) return scanPromise;
  if (!force && now - lastScanAt < SCAN_CACHE_MS) {
    return listJavaRuntimes();
  }
  if (force && now - lastForcedScanAt < FORCE_SCAN_COOLDOWN_MS) {
    return listJavaRuntimes();
  }
  if (force) lastForcedScanAt = now;
  scanPromise = performScan().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}
