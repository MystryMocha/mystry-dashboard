import type {
  BackupInfo,
  BackupListResult,
  ConfirmZipImportInput,
  CreateFolderUploadInput,
  ExistingServerSourceListResult,
  FolderUploadInfo,
  FileDownloadTicketResult,
  FileDownloadTicketStatusResult,
  FrpEndpoint,
  FrpEndpointInput,
  FrpRuntimeInfo,
  InstanceTunnel,
  InstanceTunnelInput,
  InstanceLan,
  InstanceLanInput,
  InstanceLocalNetwork,
  LanRuntimeInfo,
  InstallJavaRequest,
  JavaRuntimeListResult,
  JavaDetectResult,
  DownloadSource,
  DownloadSourceSetting,
  SessionDuration,
  SessionDurationSetting,
  UpdateSessionDurationResult,
  PanelInfo,
  PanelNetworkJoinInfo,
  PanelNetworkStatus,
  PublicHostSetting,
  RemoteAccessStatus,
  UpdateDirectAccessRequest,
  UpdatePanelNetworkRequest,
  ImportPreviewInfo,
  InstanceInfo,
  InstanceStopPendingResult,
  NodeInfo,
  TaskInfo,
  TaskListResult,
} from '@mystry/shared';
import { isInstanceStopPendingResult, isServerMessageKey, type PanelMessage, type PanelMessageParams } from '@mystry/shared';
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
  /** Message key and params returned by the server; errorMessage() uses them to display in the UI language, and shows the English text when missing. */
  messageI18n?: PanelMessage;
  constructor(status: number, message: string, messageI18n?: PanelMessage) {
    super(message);
    this.status = status;
    this.messageI18n = messageI18n;
  }
}

/** Reads the message key from an error response body ({ error, code, params }); unknown keys are ignored and only the English text is shown. */
function responseMessage(data: unknown): PanelMessage | undefined {
  if (typeof data !== 'object' || !data || !('code' in data) || !isServerMessageKey(data.code)) return undefined;
  const params = 'params' in data && typeof data.params === 'object' && data.params
    ? data.params as PanelMessageParams
    : undefined;
  return params ? { key: data.code, params } : { key: data.code };
}

/** Session-expired event: auth.tsx listens for it, clears the user and redirects back to the login page automatically. */
export const UNAUTHORIZED_EVENT = 'mystry:unauthorized';

/** A 401 on these paths is a business result (such as a wrong password) and must not be handled as an expired session. */
const AUTH_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/setup', '/api/auth/status'];

function handleUnauthorized(path: string, usedToken: string | null): void {
  if (AUTH_EXEMPT_PATHS.some((exempt) => path.startsWith(exempt))) return;
  if (!getToken()) return;
  // The token was reissued after the request was sent (for example the password was just changed on this page): a 401 for the old token must not clear the new one.
  if (getToken() !== usedToken) return;
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
    if (res.status === 401) handleUnauthorized(path, token);
    const message =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: string }).error)
        : t('request.failed', { status: String(res.status) });
    throw new ApiError(res.status, message, responseMessage(data));
  }

  return data as T;
}

/** Instance API path; the instance ID is always encoded before being put into the path. */
export function instanceApi(instanceId: string, suffix = ''): string {
  return `/api/instances/${encodeURIComponent(instanceId)}${suffix}`;
}

function abortError(): DOMException {
  return new DOMException(t('request.aborted'), 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Waits the given milliseconds; when signal aborts, ends immediately with AbortError and clears the timer. */
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

/** When the abort signal has already fired, the cancel request cannot reuse it, or the browser terminates the request before it is sent. */
function cancelReservedDownloadTicket(instanceId: string, ticket: string): void {
  void api<unknown>(
    instanceApi(instanceId, `/files/download-ticket/${encodeURIComponent(ticket)}`),
    { method: 'DELETE', keepalive: true },
  ).catch(() => undefined);
}

/**
 * Opens a same-origin download window within a user gesture.
 * noopener/noreferrer cannot go into the window.open features: modern browsers return null because of it,
 * the frontend would mistake that for a blocked popup, and the ticket would never even be requested. Instead the opener is detached after opening.
 */
export function openDownloadPopup(): Window {
  const popup = window.open('about:blank', '_blank');
  if (!popup) {
    throw new Error(t('request.download.popupBlocked'));
  }
  try {
    popup.opener = null;
  } catch {
    // Some browsers may throw when opener is cleared; it does not affect the navigation to the same-origin download URL that follows.
  }
  return popup;
}

/**
 * Authenticated download: opens a blank download window synchronously, then requests a ticket and navigates to the streaming GET; status polling reports failures back to the SPA.
 * Buffering the whole file body with res.blob() / ArrayBuffer is forbidden (see KF-001 / KF-002).
 */
export async function downloadAuthenticated(
  instanceId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<void> {
  return downloadWithTicket(
    instanceId,
    () => api<FileDownloadTicketResult>(
      instanceApi(instanceId, '/files/download-ticket'),
      { method: 'POST', json: { path: relativePath } },
    ),
    (ticket) =>
      instanceApi(instanceId, '/files/download')
      + `?path=${encodeURIComponent(relativePath)}`
      + `&ticket=${encodeURIComponent(ticket)}`,
    signal,
  );
}

/** Downloads an instance backup archive; shares the ticket status and cancel endpoints with file downloads. */
export async function downloadBackup(
  instanceId: string,
  backupId: string,
  signal?: AbortSignal,
): Promise<void> {
  const backupPath = `/backups/${encodeURIComponent(backupId)}`;
  return downloadWithTicket(
    instanceId,
    () => api<FileDownloadTicketResult>(
      instanceApi(instanceId, `${backupPath}/download-ticket`),
      { method: 'POST' },
    ),
    (ticket) => instanceApi(instanceId, `${backupPath}/download`) + `?ticket=${encodeURIComponent(ticket)}`,
    signal,
  );
}

async function downloadWithTicket(
  instanceId: string,
  issueTicket: () => Promise<FileDownloadTicketResult>,
  buildUrl: (ticket: string) => string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const popup = openDownloadPopup();

  let ticket: string | null = null;
  try {
    const issued = await issueTicket();
    ticket = issued.ticket;
    throwIfAborted(signal);

    popup.location.href = buildUrl(ticket);

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
        // 404 is returned when the server has cleaned up the ticket (expiry, etc.): close the blank download window and report the error clearly.
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
          // The download window may already have been turned into a file save dialog by the browser.
        }
        return;
      }
      if (status.status === 'reserved' || status.status === 'streaming') continue;
      if (status.status === 'failed') {
        throw Object.assign(new Error(status.error || t('request.download.failed')), { messageI18n: status.errorI18n });
      }
      if (status.status === 'expired') {
        throw Object.assign(new Error(status.error || t('request.download.ticketExpired')), { messageI18n: status.errorI18n });
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

/** Instance backup list, newest first by creation time. */
export async function listBackups(instanceId: string, signal?: AbortSignal) {
  const res = await api<BackupListResult>(instanceApi(instanceId, '/backups'), { signal });
  return res.backups;
}

/** Creates a one-click backup task; a running server first pauses autosave and flushes to disk. */
export async function createBackup(instanceId: string) {
  return api<TaskInfo>(instanceApi(instanceId, '/backups'), { method: 'POST' });
}

/** Uploads a backup archive; it appears in the list only after server-side verification passes. */
export async function uploadBackup(instanceId: string, file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append('file', file);
  return api<BackupInfo>(instanceApi(instanceId, '/backups/upload'), { method: 'POST', body: form, signal });
}

/** Overwrites the instance directory with the given backup; when backupCurrent is true the current files are backed up first. */
export async function restoreBackup(instanceId: string, backupId: string, backupCurrent: boolean) {
  return api<TaskInfo>(instanceApi(instanceId, `/backups/${encodeURIComponent(backupId)}/restore`), {
    method: 'POST',
    json: { backupCurrent },
  });
}

export async function deleteBackup(instanceId: string, backupId: string) {
  await api<unknown>(instanceApi(instanceId, `/backups/${encodeURIComponent(backupId)}`), { method: 'DELETE' });
}

/** Task center: fetches the recent task list (including queued/running and finished tasks). */
export async function listTasks() {
  const res = await api<TaskListResult>('/api/tasks');
  return res.tasks;
}

/** The Java runtime list and the major versions the panel can install automatically; refresh=true forces a rescan of local install directories. */
export async function listJavaRuntimes(refresh = false): Promise<JavaRuntimeListResult> {
  const res = await api<JavaRuntimeListResult>(
    `/api/system/java-runtimes${refresh ? '?refresh=1' : ''}`,
  );
  return { runtimes: res.runtimes, installable: res.installable ?? [] };
}

/** Has the panel download and install the given Java major version (a background task; on completion result.javaRuntimeId is the new runtime). */
export async function installJavaRuntime(major: number) {
  return api<TaskInfo>('/api/system/java-runtimes/install', { method: 'POST', json: { major } satisfies InstallJavaRequest });
}

/** Cancels a one-click Java install. A running task ends only after the server stops the download and cleans up temp files, so the caller keeps polling until it ends. */
export async function cancelJavaInstall(taskId: string) {
  return api<TaskInfo>(`/api/system/java-runtimes/install/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
}

/** Detection result for the default Java on PATH. */
export async function detectDefaultJava() {
  return api<JavaDetectResult>('/api/system/java');
}

/** Panel runtime info: listen address, data directory, backup directory and config file path, read-only. */
export async function getPanelInfo() {
  return api<PanelInfo>('/api/system/panel-info');
}

/** The panel's current download source setting. */
export async function getDownloadSource() {
  return api<DownloadSourceSetting>('/api/system/download-source');
}

/** Saves the download source; downloads started afterwards use the new source immediately. */
export async function saveDownloadSource(source: DownloadSource) {
  return api<DownloadSourceSetting>('/api/system/download-source', { method: 'PUT', json: { source } });
}

export async function getSessionDuration() {
  return api<SessionDurationSetting>('/api/auth/session-duration');
}

/** Saves the session duration; the panel reissues this device's token with the new duration and it is swapped in right here, so a longer one takes effect immediately too. */
export async function saveSessionDuration(duration: SessionDuration) {
  const result = await api<UpdateSessionDurationResult>('/api/auth/session-duration', { method: 'PUT', json: { duration } });
  setToken(result.token);
  return result;
}

/** Status of accessing the panel from other devices: interfaces, URLs, security options and the panel's built-in network. Interfaces are re-enumerated on every read. */
export async function getRemoteAccess() {
  return api<RemoteAccessStatus>('/api/system/remote-access');
}

/** Enables, disables or modifies "direct access" or "installed virtual networking software". */
export async function saveAccessMode(mode: 'direct' | 'overlay', input: UpdateDirectAccessRequest) {
  return api<RemoteAccessStatus>(`/api/system/remote-access/${mode}`, { method: 'PUT', json: input });
}

/** Regenerates the panel's HTTPS certificate; the fingerprint changes and the browser has to confirm once more. */
export async function renewPanelCertificate() {
  return api<RemoteAccessStatus>('/api/system/remote-access/certificate', { method: 'POST' });
}

export async function savePanelNetwork(input: UpdatePanelNetworkRequest) {
  return api<PanelNetworkStatus>('/api/system/remote-access/panel-network', { method: 'PUT', json: input });
}

/** What to enter on a phone to join the panel's built-in network, including the secret; requested only when the user wants to see it. */
export async function getPanelNetworkJoinInfo() {
  return api<PanelNetworkJoinInfo>('/api/system/remote-access/panel-network/join');
}

export async function resetPanelNetworkSecret() {
  return api<PanelNetworkStatus>('/api/system/remote-access/panel-network/reset-secret', { method: 'POST' });
}

/** Saves this computer's public IP or domain; pass null to clear. */
export async function savePublicHost(host: string | null) {
  return api<PublicHostSetting>('/api/system/public-host', { method: 'PUT', json: { host } });
}

/** The current node list; phase one uses only the host memory of the built-in local node. */
export async function listNodes() {
  return api<NodeInfo[]>('/api/nodes');
}

export async function listFrpEndpoints() {
  return api<FrpEndpoint[]>('/api/frp/endpoints');
}

export async function createFrpEndpoint(input: FrpEndpointInput) {
  return api<FrpEndpoint>('/api/frp/endpoints', { method: 'POST', json: input });
}

export async function deleteFrpEndpoint(id: string) {
  await api<unknown>(`/api/frp/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getFrpRuntime() {
  return api<FrpRuntimeInfo>('/api/frp/runtime');
}

export async function installFrpRuntime() {
  return api<FrpRuntimeInfo>('/api/frp/runtime', { method: 'POST' });
}

/** Uploads an official frp archive you downloaded yourself when GitHub is unreachable; the server accepts it only by the pinned SHA-256. */
export async function uploadFrpRuntime(file: File) {
  const form = new FormData();
  form.append('file', file);
  return api<FrpRuntimeInfo>('/api/frp/runtime/upload', { method: 'POST', body: form });
}

export async function getLanRuntime() {
  return api<LanRuntimeInfo>('/api/lan/runtime');
}

export async function installLanRuntime() {
  return api<LanRuntimeInfo>('/api/lan/runtime', { method: 'POST' });
}

/** Answers once Windows has opened the administrator window on the computer running the panel; the panel then stops and comes back elevated. */
export async function restartLanAsAdmin(startAsAdmin: boolean) {
  return api<{ restarting: true }>('/api/lan/admin-restart', { method: 'POST', json: { startAsAdmin } });
}

export async function setLanStartAsAdmin(enabled: boolean) {
  return api<LanRuntimeInfo>('/api/lan/admin-start', { method: 'PUT', json: { enabled } });
}

/**
 * The fingerprint of the panel process answering right now, or null while no panel answers. It is only given to a browser on the
 * computer running the panel, which is the only one offered the restart; a different value means a new process has taken over.
 */
export async function panelProcessFingerprint(): Promise<string | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json() as { processFingerprint?: unknown };
    return typeof body.processFingerprint === 'string' ? body.processFingerprint : null;
  } catch {
    return null;
  }
}

/** Uploads an official EasyTier archive you downloaded yourself when GitHub is unreachable; the server accepts it only by the pinned SHA-256. */
export async function uploadLanRuntime(file: File) {
  const form = new FormData();
  form.append('file', file);
  return api<LanRuntimeInfo>('/api/lan/runtime/upload', { method: 'POST', body: form });
}

export async function getInstanceLocalNetwork(instanceId: string) {
  return api<InstanceLocalNetwork>(instanceApi(instanceId, '/local-network'));
}

export async function getInstanceLan(instanceId: string) {
  return api<InstanceLan>(instanceApi(instanceId, '/lan'));
}

export async function saveInstanceLan(instanceId: string, input: InstanceLanInput) {
  return api<InstanceLan>(instanceApi(instanceId, '/lan'), { method: 'PUT', json: input });
}

export async function fetchFriendLanInstructions(instanceId: string): Promise<string> {
  const text = await api<string>(instanceApi(instanceId, '/lan/friend'));
  return typeof text === 'string' ? text : '';
}

export async function getInstanceTunnel(instanceId: string) {
  return api<InstanceTunnel>(instanceApi(instanceId, '/tunnel'));
}

export async function saveInstanceTunnel(instanceId: string, input: InstanceTunnelInput) {
  return api<InstanceTunnel>(instanceApi(instanceId, '/tunnel'), { method: 'PUT', json: input });
}

/** The friend config is only a few KB and uses a plain text response; large file downloads must still use the ticket stream. */
export async function fetchFriendTunnelConfig(instanceId: string): Promise<string> {
  const text = await api<string>(instanceApi(instanceId, '/tunnel/friend-config'));
  return typeof text === 'string' ? text : '';
}

/** Existing server candidates in the fixed DATA_DIR/imports handoff area, plus the path of this folder on the panel's computer. */
export async function listExistingServerSources() {
  return api<ExistingServerSourceListResult>('/api/import/sources');
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

/** One file in a browser-uploaded folder: relativePath is the relative path with the outermost folder name removed, separated by /. */
export type FolderUploadFile = { file: File; relativePath: string };

function folderUploadApi(id: string, suffix = '') {
  return `/api/import/folder-uploads/${encodeURIComponent(id)}${suffix}`;
}

export async function createFolderUpload(input: CreateFolderUploadInput, signal?: AbortSignal) {
  return api<FolderUploadInfo>('/api/import/folder-uploads', { method: 'POST', json: input, signal });
}

/** Sends a batch of files: each file is preceded by its relative path. File is read by the browser as a stream and not loaded into memory whole. */
export async function uploadFolderBatch(id: string, files: FolderUploadFile[], signal?: AbortSignal) {
  const form = new FormData();
  for (const { file, relativePath } of files) {
    form.append('path', relativePath);
    form.append('file', file, 'file');
  }
  return api<FolderUploadInfo>(folderUploadApi(id, '/files'), { method: 'POST', body: form, signal });
}

export async function completeFolderUpload(id: string, signal?: AbortSignal) {
  return api<FolderUploadInfo>(folderUploadApi(id, '/complete'), { method: 'POST', signal });
}

export async function getFolderUpload(id: string, signal?: AbortSignal) {
  return api<FolderUploadInfo>(folderUploadApi(id), { signal });
}

export async function confirmFolderUpload(id: string, input: ConfirmZipImportInput, signal?: AbortSignal) {
  return api<TaskInfo>(folderUploadApi(id, '/confirm'), { method: 'POST', signal, json: input });
}

export async function cancelFolderUpload(id: string) {
  return api<{ ok: true }>(folderUploadApi(id), { method: 'DELETE', keepalive: true });
}

export type InstanceAction = 'start' | 'stop' | 'restart';

/** Starts, stops or restarts an instance; while the server is still saving, the error tells the user to wait or force stop. */
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
    throw Object.assign(new Error(result.error || t('request.stopPending')), { messageI18n: result.errorI18n });
  }
}

const TASK_POLL_INTERVAL_MS = 2_000;
const TASK_RATE_LIMIT_BACKOFF_MS = 5_000;

/** Polls a task until it completes or fails and returns the task result; ends with AbortError when signal aborts. */
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
      // The task may still be queued, and server rate limiting does not mean the task failed; back off and keep polling.
      if (error instanceof ApiError && error.status === 429) {
        await delay(TASK_RATE_LIMIT_BACKOFF_MS, signal);
        continue;
      }
      throw error;
    }

    throwIfAborted(signal);
    onUpdate?.(task);
    if (task.status === 'completed') return task.result;
    if (task.status === 'failed') {
      // When the failure reason carries a message key, errorMessage() displays it in the UI language.
      throw Object.assign(new Error(task.error || t('request.taskFailed')), { messageI18n: task.errorI18n });
    }
    await delay(TASK_POLL_INTERVAL_MS, signal);
  }
}
