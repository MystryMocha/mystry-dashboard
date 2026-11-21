import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { resolveSafePath } from '../utils/path.js';
import { parseJvmArgs, serializeJvmArgFile, type PanelMessage } from '@mystry/shared';
import { getMinecraftChildEnv } from '../utils/child-env.js';
import { abortError, PanelError } from '../utils/errors.js';

const INSTALLER_MAX_ATTEMPTS = 2;

/** Installer progress callback: the progress text is a message key plus params, recorded by the task and handed to Web for translation. */
type InstallerReport = (progress: number, message: PanelMessage) => void;

class InstallerProcessError extends PanelError {
  constructor(
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    // Installer output is original Java text; it is only attached as a param and not translated.
    super(
      exitCode === null ? 'server.deploy.installerExitUnknown' : 'server.deploy.installerExitCode',
      exitCode === null ? { output } : { exitCode, output },
    );
    this.name = 'InstallerProcessError';
  }
}

export function isRetryableInstallerFailure(output: string): boolean {
  return /These libraries failed to download\. Try again\./i.test(output)
    || /(?:SocketTimeoutException|ConnectException|UnknownHostException|SSL(?:Handshake)?Exception)/i.test(output);
}

/** Summarizes the installer's dependency download failure output into a translatable diagnostic message. */
export function summarizeInstallerDownloadFailure(output: string, attempts: number): PanelMessage {
  const failedBlock = output.match(
    /These libraries failed to download\. Try again\.\s*([\s\S]*?)\s*There was an error during installation/i,
  )?.[1];
  const failedLibraries = failedBlock
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  const failedUrl = output.match(/Failed to establish connection to (https?:\/\/\S+)/i)?.[1];
  let failedHost = '';
  if (failedUrl) {
    try {
      failedHost = new URL(failedUrl).host;
    } catch {
      // The URL is only used to improve the error hint; a parse failure does not affect finishing the task.
    }
  }

  let reason: PanelMessage = { key: 'server.deploy.installerReason.connectFailed' };
  if (/SocketTimeoutException:\s*Read timed out/i.test(output)) reason = { key: 'server.deploy.installerReason.readTimeout' };
  else if (/UnknownHostException/i.test(output)) reason = { key: 'server.deploy.installerReason.dnsFailed' };
  else if (/SSL(?:Handshake)?Exception/i.test(output)) reason = { key: 'server.deploy.installerReason.tlsFailed' };

  // Dependency coordinates are the installer's original text, comma-separated in every language.
  const libraries: PanelMessage | string = failedLibraries?.length
    ? { key: 'server.deploy.installerFailedLibraries', params: { libraries: failedLibraries.join(', ') } }
    : '';
  const hostDetail: PanelMessage = failedHost
    ? { key: 'server.deploy.installerHostReason', params: { host: failedHost, reason } }
    : reason;
  const detail: PanelMessage = attempts > 1
    ? { key: 'server.deploy.installerRetried', params: { count: attempts - 1, detail: hostDetail } }
    : hostDetail;
  return { key: 'server.deploy.installerDownloadFailed', params: { detail, libraries } };
}

type InstallerProgressState = {
  progress: number;
  completedDownloads: number;
};

/** Takes the file name from a download URL; returns undefined when it cannot, and the caller uses the generic "dependency file" wording instead. */
function installerArtifactName(urlText: string): string | undefined {
  try {
    const pathname = new URL(urlText).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1)) || undefined;
  } catch {
    return undefined;
  }
}

function reportInstallerLine(
  line: string,
  state: InstallerProgressState,
  report?: InstallerReport,
): void {
  if (!report) return;
  const downloadUrl = line.match(/Downloading (?:library )?from (https?:\/\/\S+)/i)?.[1];
  if (downloadUrl) {
    state.progress = Math.min(83, state.progress + 1);
    const name = installerArtifactName(downloadUrl);
    report(
      state.progress,
      name
        ? { key: 'server.deploy.progress.installerDownloading', params: { name } }
        : { key: 'server.deploy.progress.installerDownloadingUnknown' },
    );
    return;
  }
  if (/Download completed:/i.test(line)) {
    state.completedDownloads += 1;
    state.progress = Math.min(84, Math.max(state.progress, 60 + state.completedDownloads));
    report(state.progress, {
      key: 'server.deploy.progress.installerDownloadsDone',
      params: { count: state.completedDownloads },
    });
    return;
  }
  if (/Failed to establish connection to /i.test(line)) {
    report(state.progress, { key: 'server.deploy.progress.installerNetworkIssue' });
  }
}

function runInstallerAttempt(
  installerJar: string,
  cwd: string,
  javaCommand: string,
  signal: AbortSignal,
  progressState: InstallerProgressState,
  report?: InstallerReport,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(javaCommand, ['-jar', installerJar, '--installServer'], {
      cwd,
      env: getMinecraftChildEnv(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = Buffer.alloc(0);
    let aborted = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    let pendingLine = '';
    const appendOutput = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > config.maxInstallerOutputBytes) {
        output = output.subarray(output.length - config.maxInstallerOutputBytes);
      }
      pendingLine += chunk.toString('utf8');
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) reportInstallerLine(line, progressState, report);
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const killProcessTree = (force: boolean) => {
      const pid = child.pid;
      if (!pid) return;
      if (process.platform === 'win32') {
        // Kill the process tree only for the installer's PID; the panel's own PID must never be used.
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* The child process may have already exited */
          }
        });
        return;
      }

      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* The child process may have already exited */
        }
      }
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      killProcessTree(false);
      forceTimer = setTimeout(() => {
        killProcessTree(true);
        // Some platforms never send the close event after a forced kill, and the task slot must not be held forever.
        finish(abortError(signal));
      }, config.installerKillGraceMs);
    };
    child.stdout.on('data', (c: Buffer) => {
      appendOutput(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      appendOutput(c);
    });
    // A pipe stream error without a listener becomes an uncaught exception; EPIPE on the pipe when the child exits is normal.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.once('error', (error) => finish(aborted || signal.aborted ? abortError(signal) : error));
    child.once('close', (code) => {
      if (aborted || signal.aborted) {
        finish(abortError(signal));
      } else if (code === 0) {
        finish();
      } else {
        if (pendingLine) reportInstallerLine(pendingLine, progressState, report);
        finish(new InstallerProcessError(code, output.toString('utf8')));
      }
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function runInstaller(
  installerJar: string,
  cwd: string,
  javaCommand: string,
  signal: AbortSignal,
  report?: InstallerReport,
): Promise<void> {
  const progressState: InstallerProgressState = { progress: 60, completedDownloads: 0 };
  for (let attempt = 1; attempt <= INSTALLER_MAX_ATTEMPTS; attempt += 1) {
    try {
      await runInstallerAttempt(installerJar, cwd, javaCommand, signal, progressState, report);
      return;
    } catch (error) {
      if (!(error instanceof InstallerProcessError) || signal.aborted) throw error;
      const retryable = isRetryableInstallerFailure(error.output);
      if (retryable && attempt < INSTALLER_MAX_ATTEMPTS) {
        report?.(progressState.progress, {
          key: 'server.deploy.progress.installerRetrying',
          params: { attempt: attempt + 1, max: INSTALLER_MAX_ATTEMPTS },
        });
        continue;
      }
      if (retryable) {
        const summary = summarizeInstallerDownloadFailure(error.output, attempt);
        throw new PanelError(summary.key, summary.params);
      }
      throw error;
    }
  }
}

/** Forge/NeoForge launch scripts read JVM arguments from user_jvm_args.txt. */
export function writeUserJvmArgs(dir: string, jvmArgs: string): void {
  const file = resolveSafePath(dir, 'user_jvm_args.txt');
  const lines = serializeJvmArgFile(parseJvmArgs(jvmArgs));
  fs.writeFileSync(file, `${lines}\n`, 'utf8');
}
