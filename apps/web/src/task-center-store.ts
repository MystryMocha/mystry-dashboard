import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { TaskInfo } from '@mystry/shared';
import { ApiError, listTasks } from './api';
import { errorMessage } from './errors';
import { POLL_INTERVAL_MS } from './hooks/usePolling';

/**
 * Module-level shared state of the task center; all subscribers share one polling loop.
 * Polling stops when the subscriber count is 0 (such as after signing out), avoiding pointless 401 requests.
 */

const RATE_LIMIT_BACKOFF_MS = 10_000;

let tasks: TaskInfo[] = [];
let loadError = '';
let lastSuccessAt: string | null = null;
let hasLoaded = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let pollingGeneration = 0;
let inFlight: { generation: number; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function isActive(generation: number): boolean {
  return polling && listeners.size > 0 && generation === pollingGeneration;
}

async function runTick(generation: number): Promise<void> {
  try {
    const nextTasks = await listTasks();
    if (!isActive(generation)) return;
    tasks = nextTasks;
    loadError = '';
    lastSuccessAt = new Date().toISOString();
    hasLoaded = true;
    schedule(POLL_INTERVAL_MS, generation);
  } catch (error) {
    if (!isActive(generation)) return;
    // 429 means the server is rate limiting, so back off and continue; errors such as 401 are left to the global handler and only recorded here.
    loadError = errorMessage(error);
    hasLoaded = true;
    schedule(
      error instanceof ApiError && error.status === 429 ? RATE_LIMIT_BACKOFF_MS : POLL_INTERVAL_MS,
      generation,
    );
  }
  if (isActive(generation)) emit();
}

function tick(): Promise<void> {
  const generation = pollingGeneration;
  if (!isActive(generation)) return Promise.resolve();
  if (inFlight?.generation === generation) return inFlight.promise;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  const promise = runTick(generation).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { generation, promise };
  return promise;
}

function schedule(delay: number, generation: number): void {
  if (!isActive(generation)) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!isActive(generation)) return;
    // Polling pauses while the page is hidden, and runs once right away when it becomes visible again.
    if (document.hidden) {
      schedule(POLL_INTERVAL_MS, generation);
      return;
    }
    void tick();
  }, delay);
}

function onVisibilityChange(): void {
  if (!document.hidden && listeners.size > 0) void tick();
}

function start(): void {
  if (polling) return;
  polling = true;
  pollingGeneration += 1;
  document.addEventListener('visibilitychange', onVisibilityChange);
  void tick();
}

function stop(): void {
  polling = false;
  pollingGeneration += 1;
  inFlight = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  // When subscriptions drop to zero (sign-out / leaving to the login page) the module-level cache is cleared, so the previous session's tasks do not flash after switching users.
  tasks = [];
  loadError = '';
  lastSuccessAt = null;
  hasLoaded = false;
}

export function retryTaskCenterPoll(): void {
  if (listeners.size === 0) return;
  void tick();
}

export function useTaskCenter(): {
  tasks: TaskInfo[];
  error: string;
  loading: boolean;
  activeCount: number;
  lastSuccessAt: string | null;
  retry: () => void;
} {
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const retryRef = useRef(retryTaskCenterPoll);
  retryRef.current = retryTaskCenterPoll;

  useEffect(() => {
    listeners.add(forceRender);
    start();
    return () => {
      listeners.delete(forceRender);
      if (listeners.size === 0) stop();
    };
  }, []);

  return {
    tasks,
    error: loadError,
    loading: !hasLoaded,
    activeCount: tasks.filter((task) => task.status === 'pending' || task.status === 'running').length,
    lastSuccessAt,
    retry: useCallback(() => retryRef.current(), []),
  };
}
