import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { PanelError } from '../utils/errors.js';

const require = createRequire(import.meta.url);
const BCRYPT_MODULE_PATH = require.resolve('bcryptjs');

const DEFAULT_MAX_CONCURRENT_VERIFICATIONS = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;

/**
 * Pure CommonJS worker script so eval works identically under tsx, compiled ESM dist and the portable build.
 * Running bcryptjs synchronously inside a worker keeps the main event loop completely unblocked.
 */
const WORKER_SCRIPT = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);

parentPort.on('message', (job) => {
  try {
    const result = job.op === 'compare'
      ? bcrypt.compareSync(job.password, job.hash)
      : bcrypt.hashSync(job.password, job.rounds);
    parentPort.postMessage({ id: job.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
`;

type WorkerRequest =
  | { id: number; op: 'compare'; password: string; hash: string }
  | { id: number; op: 'hash'; password: string; rounds: number };

type WorkerResponse =
  | { id: number; ok: true; result: string | boolean }
  | { id: number; ok: false; error: string };

type IdleWorkerEntry = {
  worker: Worker;
  timer: NodeJS.Timeout;
};

export type PasswordWorkerPool = {
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  hashPassword: (password: string, rounds?: number) => Promise<string>;
  shutdown: () => Promise<void>;
};

export function createPasswordWorkerPool(options?: {
  maxConcurrentVerifications?: number;
  idleTimeoutMs?: number;
}): PasswordWorkerPool {
  const maxConcurrentVerifications = Math.max(
    1,
    Math.floor(options?.maxConcurrentVerifications ?? DEFAULT_MAX_CONCURRENT_VERIFICATIONS),
  );
  const idleTimeoutMs = Math.max(100, Math.floor(options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));

  const idleWorkers: IdleWorkerEntry[] = [];
  const activeWorkers = new Set<Worker>();
  let activeVerifications = 0;
  let nextJobId = 1;

  function acquireWorker(): Worker {
    const idle = idleWorkers.pop();
    if (idle) {
      clearTimeout(idle.timer);
      idle.worker.ref();
      return idle.worker;
    }
    return new Worker(WORKER_SCRIPT, {
      eval: true,
      workerData: { bcryptPath: BCRYPT_MODULE_PATH },
    });
  }

  function releaseWorker(worker: Worker): void {
    activeWorkers.delete(worker);
    if (idleWorkers.length >= maxConcurrentVerifications) {
      void worker.terminate();
      return;
    }
    // Unref idle workers and their cleanup timer so they never keep the panel or tests from exiting.
    worker.unref();
    const timer = setTimeout(() => {
      const index = idleWorkers.findIndex((entry) => entry.worker === worker);
      if (index !== -1) idleWorkers.splice(index, 1);
      void worker.terminate();
    }, idleTimeoutMs);
    timer.unref();
    idleWorkers.push({ worker, timer });
  }

  function runInWorker<T extends string | boolean>(request: WorkerRequest): Promise<T> {
    const worker = acquireWorker();
    activeWorkers.add(worker);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const onMessage = (response: WorkerResponse) => {
        if (response.id !== request.id || settled) return;
        settled = true;
        cleanup();
        releaseWorker(worker);
        if (response.ok) resolve(response.result as T);
        else reject(new Error(response.error));
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        activeWorkers.delete(worker);
        void worker.terminate();
        reject(error);
      };
      const onExit = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        activeWorkers.delete(worker);
        reject(new Error(`Password worker exited unexpectedly with code ${code}`));
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage(request);
    });
  }

  return {
    async verifyPassword(password: string, hash: string): Promise<boolean> {
      if (activeVerifications >= maxConcurrentVerifications) {
        throw new PanelError('server.common.tooManyRequests', undefined, { statusCode: 429 });
      }
      activeVerifications += 1;
      try {
        return await runInWorker<boolean>({ id: nextJobId++, op: 'compare', password, hash });
      } finally {
        activeVerifications -= 1;
      }
    },
    async hashPassword(password: string, rounds = 10): Promise<string> {
      return await runInWorker<string>({ id: nextJobId++, op: 'hash', password, rounds });
    },
    async shutdown(): Promise<void> {
      const toTerminate: Worker[] = [];
      while (idleWorkers.length > 0) {
        const entry = idleWorkers.pop()!;
        clearTimeout(entry.timer);
        toTerminate.push(entry.worker);
      }
      for (const worker of activeWorkers) toTerminate.push(worker);
      activeWorkers.clear();
      await Promise.allSettled(toTerminate.map((worker) => worker.terminate()));
    },
  };
}

const defaultPool = createPasswordWorkerPool();

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return defaultPool.verifyPassword(password, hash);
}

export function hashPassword(password: string, rounds = 10): Promise<string> {
  return defaultPool.hashPassword(password, rounds);
}

export function shutdownPasswordWorkers(): Promise<void> {
  return defaultPool.shutdown();
}
