// @vitest-environment jsdom
/**
 * 导入页「上传文件夹」：入口显示条件、选文件夹、分批上传、检查结果、确认导入、取消上传、读不了的文件和刷新后恢复。
 * jsdom 没有 webkitdirectory，也没有真正的文件夹选择框：这里给 input 补上属性、直接塞文件；真实选择框只能人工点。
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { FolderUploadInfo } from '@mystry/shared';
import { batchFolderFiles, uploadFolder, type SelectedFolder } from '../src/folder-upload';
import { ImportPage } from '../src/pages/ImportPage';
import { setupFormTestEnv } from './form-test-env';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function enableFolderPicking() {
  Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', { configurable: true, value: false, writable: true });
}

beforeEach(setupFormTestEnv);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLInputElement.prototype as { webkitdirectory?: boolean }).webkitdirectory;
});

/** 模拟文件夹选择框选中的文件：webkitRelativePath 带最外层文件夹名。 */
function folderFile(path: string, content: string): File {
  const file = new File([content], path.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

const readyUpload: FolderUploadInfo = {
  id: 'up1',
  folderName: 'myserver',
  fileCount: 3,
  totalBytes: 18,
  receivedFiles: 3,
  receivedBytes: 18,
  state: 'ready',
  expiresAt: '2099-01-01T00:00:00.000Z',
  check: { launchTarget: 'paper-1.21.1-100.jar', coreType: 'paper', mcVersion: '1.21.1', ready: true },
};

/** 导入页其它区域（Java、下载源、imports 列表）需要的接口；requests 记下每个上传相关请求。 */
function stubImportApis(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url).includes('/import/folder-uploads')) requests.push({ url, method, body: init?.body });
    const handler = handlers[`${method} ${url}`];
    if (handler) return handler(init);
    if (String(url).includes('/import/sources')) return json({ sources: [] });
    if (String(url).startsWith('/api/system/java-runtimes')) return json({ runtimes: [], installable: [] });
    if (url === '/api/system/java') return json({ available: true, version: '21.0.4', majorVersion: 21 });
    if (url === '/api/system/download-source') return json({ source: 'official' });
    if (url === '/api/system/memory') return json({ totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 });
    return json({});
  }));
  return requests;
}

function chooseFolder(files: File[]) {
  const input = document.getElementById('import-folder-input') as HTMLInputElement;
  expect(input.hasAttribute('webkitdirectory')).toBe(true);
  fireEvent.change(input, { target: { files } });
}

test('浏览器选不了文件夹时不显示「上传文件夹」，默认仍是 imports 交接区', async () => {
  stubImportApis({});
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  const imports = await screen.findByRole('button', { name: '从 imports 文件夹复制' });
  expect(imports.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('button', { name: '上传文件夹' })).toBeNull();
  expect(screen.queryByText(/用「上传文件夹」更方便/)).toBeNull();
});

const tabNames = () => within(screen.getByRole('group', { name: '导入方式' })).getAllByRole('button').map((button) => button.textContent);

test('imports 里没有东西时只列上传文件夹和 ZIP，点链接后才出现「从 imports 文件夹复制」并一直保留', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  stubImportApis({});
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  const link = await screen.findByRole('button', { name: '改为从 imports 文件夹复制' });
  expect(tabNames()).toEqual(['上传文件夹', '上传 ZIP 压缩包']);
  expect(screen.getByText(/通过 SSH 管理的服务器）？/)).toBeTruthy();

  await user.click(link);
  expect(screen.getByRole('button', { name: '从 imports 文件夹复制' }).getAttribute('aria-pressed')).toBe('true');
  // 切过去后先说明什么时候用 imports。
  expect(screen.getByText(/服务端已经在面板所在的电脑上（比如用 SSH 管理的云服务器）时/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '上传 ZIP 压缩包' }));
  await user.click(screen.getByRole('button', { name: '上传文件夹' }));
  expect(tabNames()).toEqual(['上传文件夹', '上传 ZIP 压缩包', '从 imports 文件夹复制']);
  expect(screen.queryByRole('button', { name: '改为从 imports 文件夹复制' })).toBeNull();
});

test('imports 里已经放了服务端时直接列出「从 imports 文件夹复制」，不再显示链接', async () => {
  enableFolderPicking();
  stubImportApis({
    'GET /api/import/sources': () => json({ sources: [{ id: 'old-paper', launchTarget: 'paper.jar', coreType: 'paper', modifiedAt: '2026-11-01T00:00:00.000Z', ready: true }] }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: '从 imports 文件夹复制' })).toBeTruthy();
  expect(tabNames()).toEqual(['上传文件夹', '上传 ZIP 压缩包', '从 imports 文件夹复制']);
  expect(screen.getByRole('button', { name: '上传文件夹' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('button', { name: '改为从 imports 文件夹复制' })).toBeNull();
});

test('选文件夹 → 分批上传并检查 → 带出核心和版本 → 确认导入', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  const requests = stubImportApis({
    'POST /api/import/folder-uploads': () => json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined }),
    'POST /api/import/folder-uploads/up1/files': () => json({ ...readyUpload, state: 'uploading', check: undefined }),
    'POST /api/import/folder-uploads/up1/complete': () => json(readyUpload),
    'POST /api/import/folder-uploads/up1/confirm': () => json({ id: 't1', type: 'import', status: 'pending', progress: 0, message: 'Waiting', createdAt: '', updatedAt: '' }),
    'GET /api/tasks/t1': () => json({ id: 't1', type: 'import', status: 'running', progress: 30, message: 'Moving', createdAt: '', updatedAt: '' }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);

  const folderTab = await screen.findByRole('button', { name: '上传文件夹' });
  expect(folderTab.getAttribute('aria-pressed')).toBe('true');
  const submit = screen.getByRole('button', { name: '请选择文件夹' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);

  chooseFolder([
    folderFile('myserver/paper-1.21.1-100.jar', 'jar-bytes'),
    folderFile('myserver/world/level.dat', 'level'),
    folderFile('myserver/eula.txt', 'eula'),
  ]);
  expect(screen.getByText('myserver')).toBeTruthy();
  expect(screen.getByText(/3 个文件/)).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '上传并检查' }));
  expect(await screen.findByText('文件夹已上传并检查')).toBeTruthy();
  expect(screen.getByText(/myserver · 3 个文件/)).toBeTruthy();
  expect(sessionStorage.getItem('mystry_folder_upload_id')).toBe('up1');

  const created = requests.find((request) => request.url === '/api/import/folder-uploads')!;
  expect(JSON.parse(String(created.body))).toEqual({ folderName: 'myserver', fileCount: 3, totalBytes: 18 });
  const batch = requests.find((request) => request.url.endsWith('/files'))!.body as FormData;
  // 上传的路径去掉了最外层文件夹名，每个文件前面跟着它的路径。
  expect(batch.getAll('path')).toEqual(['paper-1.21.1-100.jar', 'world/level.dat', 'eula.txt']);
  expect(batch.getAll('file')).toHaveLength(3);

  // 检查结果带出的核心和版本填进表单。
  await waitFor(() => expect((screen.getByRole('combobox', { name: '核心类型' }) as HTMLSelectElement).value).toBe('paper'));
  expect((screen.getByRole('textbox', { name: 'Minecraft 版本（可选）' }) as HTMLInputElement).value).toBe('1.21.1');

  await user.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }));
  await user.click(screen.getByRole('button', { name: '确认设置并导入' }));
  await waitFor(() => expect(requests.some((request) => request.url.endsWith('/confirm'))).toBe(true));
  const confirm = requests.find((request) => request.url.endsWith('/confirm'))!;
  expect(JSON.parse(String(confirm.body))).toMatchObject({ coreType: 'paper', mcVersion: '1.21.1', acceptEula: true });
  expect(sessionStorage.getItem('mystry_folder_upload_id')).toBeNull();
});

test('上传中点「取消上传」会中止请求并删掉面板上的临时文件夹', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  const requests = stubImportApis({
    'POST /api/import/folder-uploads': () => json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined }),
    // 这一批一直不回，直到被中止。
    'POST /api/import/folder-uploads/up1/files': (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
    'DELETE /api/import/folder-uploads/up1': () => json({ ok: true }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  await screen.findByRole('button', { name: '上传文件夹' });
  chooseFolder([folderFile('myserver/server.jar', 'jar')]);
  await user.click(screen.getByRole('button', { name: '上传并检查' }));

  const progress = await screen.findByRole('progressbar', { name: '文件夹上传进度' });
  expect(progress).toBeTruthy();
  expect(screen.getByText('正在上传 myserver：0/1 个文件')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '取消上传' }));

  await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('progressbar', { name: '文件夹上传进度' })).toBeNull());
  // 取消不是错误；选好的文件夹还在，可以再点上传。
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '上传并检查' })).toBeTruthy();
});

test('有文件读不出来时说出是哪个文件，并删掉这次上传', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  const requests = stubImportApis({
    'POST /api/import/folder-uploads': () => json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined }),
    // 浏览器读文件失败时 fetch 直接抛 TypeError，拿不到面板的回应。
    'POST /api/import/folder-uploads/up1/files': () => Promise.reject(new TypeError('Failed to fetch')),
    'DELETE /api/import/folder-uploads/up1': () => json({ ok: true }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  await screen.findByRole('button', { name: '上传文件夹' });
  const readable = folderFile('myserver/server.jar', 'jar');
  const locked = folderFile('myserver/world/session.lock', 'lock');
  // jsdom 的 Blob 没有 arrayBuffer()，读得出的文件也替身一下。
  readable.slice = () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }) as unknown as Blob;
  locked.slice = () => ({ arrayBuffer: () => Promise.reject(new DOMException('locked', 'NotReadableError')) }) as unknown as Blob;
  chooseFolder([readable, locked]);
  await user.click(screen.getByRole('button', { name: '上传并检查' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('读不了 world/session.lock');
  expect(alert.textContent).toContain('先停掉它');
  await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
});

test('刷新页面后恢复已检查、待确认的文件夹', async () => {
  enableFolderPicking();
  sessionStorage.setItem('mystry_folder_upload_id', 'up1');
  stubImportApis({ 'GET /api/import/folder-uploads/up1': () => json(readyUpload) });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  expect(await screen.findByText('文件夹已上传并检查')).toBeTruthy();
  expect(screen.getByRole('button', { name: '确认设置并导入' })).toBeTruthy();
});

test('没有启动文件的文件夹：显示原因，不出现导入设置，可以重新选择', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  sessionStorage.setItem('mystry_folder_upload_id', 'up1');
  const requests = stubImportApis({
    'GET /api/import/folder-uploads/up1': () => json({
      ...readyUpload,
      check: { launchTarget: null, coreType: 'custom', ready: false, error: 'No server jar', errorI18n: { key: 'server.imports.existing.noLaunchTarget' } },
    }),
    'DELETE /api/import/folder-uploads/up1': () => json({ ok: true }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  expect(await screen.findByText('文件夹已上传并检查')).toBeTruthy();
  expect(screen.getByText(/未找到服务端 jar/)).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '实例名称' })).toBeNull();
  expect((screen.getByRole('button', { name: '请选择文件夹' }) as HTMLButtonElement).disabled).toBe(true);

  await user.click(screen.getByRole('button', { name: '取消并重新选择' }));
  await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
  expect(await screen.findByRole('button', { name: '选择文件夹' })).toBeTruthy();
  expect(sessionStorage.getItem('mystry_folder_upload_id')).toBeNull();
});

test('分批：按文件数和大小切，比上限还大的文件自己一批', () => {
  const item = (size: number) => ({ file: { size } as File, relativePath: 'x' });
  expect(batchFolderFiles(Array.from({ length: 1001 }, () => item(1)), 500, 1000).map((batch) => batch.length)).toEqual([500, 500, 1]);
  expect(batchFolderFiles([item(300), item(800), item(5000), item(1)], 500, 1000).map((batch) => batch.length)).toEqual([1, 1, 1, 1]);
  expect(batchFolderFiles([item(300), item(600), item(200)], 500, 1000).map((batch) => batch.length)).toEqual([2, 1]);
  expect(batchFolderFiles([item(300), item(600), item(50)], 500, 1000).map((batch) => batch.length)).toEqual([3]);
});

test('撞上面板请求频率限制时等一会儿重发同一批，不算失败', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/import/folder-uploads') return json({ ...readyUpload, state: 'uploading', check: undefined });
    if (url.endsWith('/files')) {
      attempts += 1;
      return attempts === 1
        ? json({ error: 'Too many requests', code: 'server.common.tooManyRequests' }, 429)
        : json({ ...readyUpload, state: 'uploading', check: undefined });
    }
    if (url.endsWith('/complete')) return json(readyUpload);
    return json({});
  }));
  const folder: SelectedFolder = { name: 'myserver', files: [{ file: new File(['x'], 'a'), relativePath: 'a' }], totalBytes: 1 };
  const waiting: boolean[] = [];
  const result = uploadFolder(folder, { onProgress: (progress) => waiting.push(progress.waiting) });
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(result).resolves.toMatchObject({ state: 'ready' });
  expect(attempts).toBe(2);
  // 等待重发时告诉页面「暂停中」，这一批发完后恢复正常进度。
  expect(waiting).toEqual([false, true, false]);
});

/** jsdom 的 Blob 没有 arrayBuffer()：读得出的文件替身一下，探测读不读得出时用。 */
function readableFile(name: string, content: string): File {
  const file = new File([content], name);
  file.slice = () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }) as unknown as Blob;
  return file;
}

test('请求体没发完面板就回 429、浏览器只报网络错误时，查到这批没被处理就重发', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const statusChecks: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/import/folder-uploads') return json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined });
    if (url.endsWith('/files')) {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return json({ ...readyUpload, state: 'uploading', receivedFiles: 1, receivedBytes: 1, check: undefined });
    }
    if (method === 'GET' && url === '/api/import/folder-uploads/up1') {
      statusChecks.push(url);
      return json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined });
    }
    if (url.endsWith('/complete')) return json(readyUpload);
    return json({});
  }));
  const folder: SelectedFolder = { name: 'myserver', files: [{ file: readableFile('a', 'x'), relativePath: 'a' }], totalBytes: 1 };
  const result = uploadFolder(folder);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(result).resolves.toMatchObject({ state: 'ready' });
  expect(attempts).toBe(2);
  expect(statusChecks).toHaveLength(1);
});

test('上传中途连接断开、面板上这次上传已作废时，提示上传中断并删掉这次上传', async () => {
  enableFolderPicking();
  const user = userEvent.setup();
  const requests = stubImportApis({
    'POST /api/import/folder-uploads': () => json({ ...readyUpload, state: 'uploading', receivedFiles: 0, receivedBytes: 0, check: undefined }),
    'POST /api/import/folder-uploads/up1/files': () => Promise.reject(new TypeError('Failed to fetch')),
    'GET /api/import/folder-uploads/up1': () => json({ error: 'Not found', code: 'server.imports.folder.notFound' }, 404),
    'DELETE /api/import/folder-uploads/up1': () => json({ ok: true }),
  });
  render(<MemoryRouter><ImportPage /></MemoryRouter>);
  await screen.findByRole('button', { name: '上传文件夹' });
  const file = folderFile('myserver/server.jar', 'jar');
  file.slice = () => ({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }) as unknown as Blob;
  chooseFolder([file]);
  await user.click(screen.getByRole('button', { name: '上传并检查' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('上传中断：和面板的连接断开了。检查网络后重新上传文件夹。');
  expect(requests.filter((request) => request.url.endsWith('/files'))).toHaveLength(1);
  await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
});
