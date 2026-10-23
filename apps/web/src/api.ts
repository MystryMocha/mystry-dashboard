import type {
  ConfirmZipImportInput,
  ExistingServerSourceListResult,
  FileDownloadTicketResult,
  FileDownloadTicketStatusResult,
  JavaRuntimeListResult,
  JavaDetectResult,
  ImportPreviewInfo,
  InstanceInfo,
  InstanceStopPendingResult,
  NodeInfo,
  TaskInfo,
  TaskListResult,
} from '@mystry/shared';
import { isInstanceStopPendingResult } from '@mystry/shared';
import { isAbortError } from './errors';
import { t } from './i18n';

const TOKEN_KEY = 'mystry_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 登录态失效事件：auth.tsx 监听后清空用户并自动跳回登录页。 */
export const UNAUTHORIZED_EVENT = 'mystry:unauthorized';

/** 这些路径的 401 是业务结果（如密码错误），不能当作会话失效处理。 */
const AUTH_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/setup', '/api/auth/status'];

function handleUnauthorized(path: string): void {
  if (AUTH_EXEMPT_PATHS.some((exempt) => path.startsWith(exempt))) return;
  if (!getToken()) return;
  setToken(null);
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

export async function api<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  }

  const res = await fetch(path, { ...options, headers, body });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) handleUnauthorized(path);
    const message =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: string }).error)
        : t('request.failed', { status: String(res.status) });
    throw new ApiError(res.status, message);
  }

  return data as T;
}

/** 实例接口路径；实例 ID 统一编码后再拼进路径。 */
export function instanceApi(instanceId: string, suffix = ''): string {
  return `/api/instances/${encodeURIComponent(instanceId)}${suffix}`;
}

function abortError(): DOMException {
  return new DOMException(t('request.aborted'), 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 等待指定毫秒；signal 中止时立即以 AbortError 结束并清理定时器。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortError());
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createConsoleTicket(
  instanceId: string,
  signal?: AbortSignal,
): Promise<{ ticket: string; expiresIn: number }> {
  return api<{ ticket: string; expiresIn: number }>(
    instanceApi(instanceId, '/console-ticket'),
    { method: 'POST', signal },
  );
}

const DOWNLOAD_STATUS_POLL_INTERVAL_MS = 3_000;
const DOWNLOAD_STATUS_RATE_LIMIT_MAX_DELAY_MS = 15_000;

/** Abort 信号已经触发时，取消请求不能复用该信号，否则浏览器会在发出前直接终止请求。 */
function cancelReservedDownloadTicket(instanceId: string, ticket: string): void {
  void api<unknown>(
    instanceApi(instanceId, `/files/download-ticket/${encodeURIComponent(ticket)}`),
    { method: 'DELETE', keepalive: true },
  ).catch(() => undefined);
}

/**
 * 在用户手势里打开同源下载窗。
 * 不能把 noopener/noreferrer 放进 window.open 的 feature：现代浏览器会因此返回 null，
 * 前端会误判为弹窗拦截，ticket 都来不及申请。改为打开后再断开 opener。
 */
export function openDownloadPopup(): Window {
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    throw new Error(t('request.download.popupBlocked'));
  }
  try {
    popup.opener = null;
  } catch {
    // 部分浏览器清空 opener 时可能抛错，不影响随后导航到同源下载地址。
  }
  return popup;
}

/**
 * 认证下载：同步打开空白下载窗，再申请 ticket 并导航至流式 GET；轮询状态把失败回传 SPA。
 * 禁止使用 res.blob() / ArrayBuffer 整体缓冲文件体（见 KF-001 / KF-002）。
 */
export async function downloadAuthenticated(
  instanceId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const popup = openDownloadPopup();

  let ticket: string | null = null;
  try {
    const issued = await api<FileDownloadTicketResult>(
      instanceApi(instanceId, '/files/download-ticket'),
      { method: 'POST', json: { path: relativePath } },
    );
    ticket = issued.ticket;
    throwIfAborted(signal);

    const url =
      instanceApi(instanceId, '/files/download')
      + `?path=${encodeURIComponent(relativePath)}`
      + `&ticket=${encodeURIComponent(ticket)}`;
    popup.location.href = url;

    let statusPollDelayMs = DOWNLOAD_STATUS_POLL_INTERVAL_MS;
    for (;;) {
      await delay(statusPollDelayMs, signal);
      let status: FileDownloadTicketStatusResult;
      try {
        status = await api<FileDownloadTicketStatusResult>(
          instanceApi(instanceId, `/files/download-ticket/${encodeURIComponent(ticket)}/status`),
          { signal },
        );
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        // 票据被服务端清理（过期等）时返回 404：关闭空白下载窗并明确报错。
        if (error instanceof ApiError && error.status === 404) {
          throw new Error(t('request.download.ticketExpiredRetry'));
        }
        if (error instanceof ApiError && error.status === 429) {
          statusPollDelayMs = Math.min(
            statusPollDelayMs * 2,
            DOWNLOAD_STATUS_RATE_LIMIT_MAX_DELAY_MS,
          );
          continue;
        }
        throw error;
      }
      statusPollDelayMs = DOWNLOAD_STATUS_POLL_INTERVAL_MS;
      if (status.status === 'consumed') {
        try {
          popup.close();
        } catch {
          // 下载窗可能已被浏览器改成文件保存对话框。
        }
        return;
      }
      if (status.status === 'reserved' || status.status === 'streaming') continue;
      if (status.status === 'failed') {
        throw new Error(status.error || t('request.download.failed'));
      }
      if (status.status === 'expired') {
        throw new Error(status.error || t('request.download.ticketExpired'));
      }
    }
  } catch (error) {
    if (ticket && (signal?.aborted || isAbortError(error))) {
      cancelReservedDownloadTicket(instanceId, ticket);
    }
    popup.close();
    throw error;
  }
}

/** 任务中心：拉取最近的任务列表（含排队/进行中和已结束任务）。 */
export async function listTasks() {
  const res = await api<TaskListResult>('/api/tasks');
  return res.tasks;
}

/** Java 运行时清单；refresh=true 强制重新扫描本机安装目录。 */
export async function listJavaRuntimes(refresh = false) {
  const res = await api<JavaRuntimeListResult>(
    `/api/system/java-runtimes${refresh ? '?refresh=1' : ''}`,
  );
  return res.runtimes;
}

/** PATH 中默认 Java 的探测结果。 */
export async function detectDefaultJava() {
  return api<JavaDetectResult>('/api/system/java');
}

/** 当前节点清单；第一阶段只使用内置本机节点的主机内存。 */
export async function listNodes() {
  return api<NodeInfo[]>('/api/nodes');
}

/** 固定 DATA_DIR/imports 交接区中的已有服务端候选。 */
export async function listExistingServerSources() {
  const res = await api<ExistingServerSourceListResult>('/api/import/sources');
  return res.sources;
}

export async function createImportPreview(file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append('file', file);
  return api<ImportPreviewInfo>('/api/import/previews', { method: 'POST', body: form, signal });
}

export async function getImportPreview(id: string, signal?: AbortSignal) {
  return api<ImportPreviewInfo>(`/api/import/previews/${encodeURIComponent(id)}`, { signal });
}

export async function confirmImportPreview(
  id: string,
  input: ConfirmZipImportInput,
  signal?: AbortSignal,
) {
  return api<TaskInfo>(`/api/import/previews/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    signal,
    json: input,
  });
}

export async function cancelImportPreview(id: string) {
  return api<{ ok: true }>(`/api/import/previews/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    keepalive: true,
  });
}

export type InstanceAction = 'start' | 'stop' | 'restart';

/** 启动、停止或重启实例；服务端仍在保存时按错误提示用户等待或强制停止。 */
export async function controlInstance(
  instanceId: string,
  action: InstanceAction,
  options?: { force?: boolean },
): Promise<void> {
  const query = action === 'stop' && options?.force ? '?force=1' : '';
  const result = await api<InstanceInfo | InstanceStopPendingResult>(
    instanceApi(instanceId, `/${action}${query}`),
    { method: 'POST' },
  );
  if (isInstanceStopPendingResult(result)) {
    throw new Error(result.error || t('request.stopPending'));
  }
}

const TASK_POLL_INTERVAL_MS = 2_000;
const TASK_RATE_LIMIT_BACKOFF_MS = 5_000;

/** 轮询任务直到完成或失败，返回任务结果；signal 中止时以 AbortError 结束。 */
export async function pollTask(
  taskId: string,
  onUpdate?: (task: TaskInfo) => void,
  signal?: AbortSignal,
): Promise<TaskInfo['result']> {
  for (;;) {
    throwIfAborted(signal);
    let task: TaskInfo;
    try {
      task = await api<TaskInfo>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
    } catch (error) {
      // 任务可能仍在排队，服务端限流不代表任务失败，退避后继续轮询。
      if (error instanceof ApiError && error.status === 429) {
        await delay(TASK_RATE_LIMIT_BACKOFF_MS, signal);
        continue;
      }
      throw error;
    }

    throwIfAborted(signal);
    onUpdate?.(task);
    if (task.status === 'completed') return task.result;
    if (task.status === 'failed') throw new Error(task.error || t('request.taskFailed'));
    await delay(TASK_POLL_INTERVAL_MS, signal);
  }
}
