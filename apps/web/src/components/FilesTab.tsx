import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, File, FileText, Folder, FolderPlus, Pencil, RefreshCw, TextCursorInput, Trash2, Upload } from 'lucide-react';
import type { FileEntry } from '@mystry/shared';
import { ApiError, api, downloadAuthenticated, instanceApi } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useDialogOpen } from '../hooks/useDialogOpen';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { ConfirmDialog } from './ConfirmDialog';

/** 与服务端默认 MAX_TEXT_FILE_BYTES 对齐，用于判断是否显示「编辑」。 */
const MAX_EDITABLE_FILE_BYTES = 1_048_576;

function canEditFile(file: FileEntry): boolean {
  return !file.isDirectory && file.size <= MAX_EDITABLE_FILE_BYTES;
}

function parentOf(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function isValidRenameName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed.includes('/') || trimmed.includes('\\')) return '名称不能包含路径分隔符';
  return null;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatModified(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 实例文件管理。切换实例时由上层按实例 ID 重新挂载，这里不处理实例变化。 */
export function FilesTab({ instanceId }: { instanceId: string }) {
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [editError, setEditError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDir, setNewDir] = useState('');
  const [newDirError, setNewDirError] = useState('');
  const [creatingDir, setCreatingDir] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const editDialogRef = useDialogOpen(editPath !== null);
  const renameDialogRef = useDialogOpen(renameTarget !== null);
  const newDirDialogRef = useDialogOpen(newDirOpen);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  /** 编辑代次：关闭编辑器或打开新文件时递增，用于丢弃慢响应到达的旧文件内容。 */
  const editGenerationRef = useRef(0);
  /** 文件列表请求代次：切换目录后丢弃迟到的旧列表，避免覆盖当前视图。 */
  const loadGenerationRef = useRef(0);
  const downloadControllersRef = useRef(new Set<AbortController>());
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    try {
      const list = await api<FileEntry[]>(
        instanceApi(instanceId, `/files?path=${encodeURIComponent(path)}`),
      );
      if (generation !== loadGenerationRef.current) return;
      setFiles(list);
      setLoaded(true);
      setError('');
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      // 刷新失败时保留上一份成功列表，避免把暂时的网络问题误显示为目录为空。
      setError(errorMessage(err));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [instanceId, path]);

  useEffect(() => {
    const controllers = downloadControllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function closeEditor() {
    editGenerationRef.current += 1;
    setEditPath(null);
    setContent('');
    setEditError('');
    setLoadingEdit(false);
  }

  function closeRename() {
    setRenameTarget(null);
    setRenameName('');
    setRenameError('');
    setRenaming(false);
  }

  function closeNewDir() {
    if (creatingDir) return;
    setNewDirOpen(false);
    setNewDir('');
    setNewDirError('');
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteError('');
  }

  function changePath(nextPath: string) {
    loadGenerationRef.current += 1;
    setFiles([]);
    setLoaded(false);
    setLoading(true);
    setError('');
    setPath(nextPath);
  }

  async function startEdit(file: FileEntry) {
    if (!canEditFile(file)) return;
    const generation = editGenerationRef.current + 1;
    editGenerationRef.current = generation;
    setLoadingEdit(true);
    setEditError('');
    setEditPath(file.path);
    setContent('');
    try {
      const res = await api<{ content: string }>(
        instanceApi(instanceId, `/files/content?path=${encodeURIComponent(file.path)}`),
      );
      // 期间可能已关闭编辑器或打开其他文件，过期响应必须丢弃，否则会把 A 内容存进 B 文件。
      if (generation !== editGenerationRef.current) return;
      setContent(res.content);
    } catch (err) {
      if (generation !== editGenerationRef.current) return;
      setEditError(errorMessage(err));
    } finally {
      if (generation === editGenerationRef.current) setLoadingEdit(false);
    }
  }

  async function saveFile() {
    if (!editPath) return;
    setSaving(true);
    try {
      await api(instanceApi(instanceId, '/files/content'), {
        method: 'PUT',
        json: { path: editPath, content },
      });
      setEditError('');
      setError('');
      closeEditor();
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (err) {
      setEditError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function requestRemove(file: FileEntry) {
    setDeleteTarget(file);
    setDeleteError('');
  }

  async function confirmRemove() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await api(instanceApi(instanceId, `/files?path=${encodeURIComponent(deleteTarget.path)}`), {
        method: 'DELETE',
      });
      if (editPath === deleteTarget.path) closeEditor();
      await load();
      closeDelete();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  async function download(file: FileEntry) {
    if (file.isDirectory) return;
    const controller = new AbortController();
    downloadControllersRef.current.add(controller);
    setBusyPath(file.path);
    setError('');
    try {
      await downloadAuthenticated(instanceId, file.path, controller.signal);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err instanceof ApiError && err.status === 429 ? '下载繁忙，请稍后重试' : errorMessage(err));
    } finally {
      downloadControllersRef.current.delete(controller);
      setBusyPath((current) => (current === file.path ? null : current));
    }
  }

  function startRename(file: FileEntry) {
    setRenameTarget(file);
    setRenameName(file.name);
    setRenameError('');
  }

  async function confirmRename() {
    if (!renameTarget) return;
    const validation = isValidRenameName(renameName);
    if (validation) {
      setRenameError(validation);
      return;
    }
    const newName = renameName.trim();
    if (newName === renameTarget.name) {
      setRenameError('新名称与旧名称相同');
      return;
    }
    const parentPath = parentOf(renameTarget.path);
    const to = parentPath ? `${parentPath}/${newName}` : newName;
    setRenaming(true);
    setRenameError('');
    try {
      await api(instanceApi(instanceId, '/files/rename'), {
        method: 'POST',
        json: { from: renameTarget.path, to },
      });
      if (editPath === renameTarget.path) closeEditor();
      closeRename();
      setError('');
      await load();
    } catch (err) {
      setRenameError(errorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setUploading(true);
    setError('');
    try {
      await api(instanceApi(instanceId, `/files/upload?path=${encodeURIComponent(path)}`), {
        method: 'POST',
        body: form,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function createDir() {
    const validation = isValidRenameName(newDir);
    if (validation) {
      setNewDirError(validation.replace('名称', '文件夹名称'));
      return;
    }
    const target = path ? `${path}/${newDir.trim()}` : newDir.trim();
    setCreatingDir(true);
    setNewDirError('');
    try {
      await api(instanceApi(instanceId, '/files/mkdir'), {
        method: 'POST',
        json: { path: target },
      });
      setNewDirOpen(false);
      setNewDir('');
      await load();
    } catch (err) {
      setNewDirError(errorMessage(err));
    } finally {
      setCreatingDir(false);
    }
  }

  const segments = path.split('/').filter(Boolean);

  function menuItems(f: FileEntry): ActionMenuItem[] {
    const items: ActionMenuItem[] = [];
    if (!f.isDirectory) {
      items.push({
        key: 'download',
        label: busyPath === f.path ? '下载中…' : '下载',
        icon: <Download size={14} />,
        disabled: busyPath === f.path || deleting,
        onSelect: () => void download(f),
      });
    }
    if (canEditFile(f)) {
      items.push({
        key: 'edit',
        label: '编辑',
        icon: <Pencil size={14} />,
        disabled: deleting,
        onSelect: () => void startEdit(f),
      });
    }
    items.push(
      {
        key: 'rename',
        label: '重命名',
        icon: <TextCursorInput size={14} />,
        disabled: busyPath === f.path || renaming || deleting,
        onSelect: () => startRename(f),
      },
      {
        key: 'delete',
        label: '删除',
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: deleting,
        onSelect: () => requestRemove(f),
      },
    );
    return items;
  }

  return (
    <div className="files-workspace">
      <div className="files-toolbar">
        <div className="files-nav">
          <button
            className="btn btn-icon"
            type="button"
            title="上级目录"
            aria-label="上级目录"
            onClick={() => changePath(parentOf(path))}
            disabled={!path}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <nav className="breadcrumbs" aria-label="当前路径">
            <button
              type="button"
              className="breadcrumb"
              aria-current={segments.length === 0 ? 'page' : undefined}
              onClick={() => changePath('')}
            >
              实例根目录
            </button>
            {segments.map((segment, index) => {
              const target = segments.slice(0, index + 1).join('/');
              const last = index === segments.length - 1;
              return (
                <span key={target} className="breadcrumb-item">
                  <ChevronRight size={13} aria-hidden="true" className="breadcrumb-sep" />
                  <button
                    type="button"
                    className="breadcrumb"
                    aria-current={last ? 'page' : undefined}
                    onClick={() => changePath(target)}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </nav>
        </div>
        <div className="files-actions">
          <button
            className="btn btn-icon"
            type="button"
            title="刷新"
            aria-label="刷新文件列表"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} aria-hidden="true" className={loading ? 'spin' : undefined} />
          </button>
          <button className="btn" type="button" onClick={() => setNewDirOpen(true)}>
            <FolderPlus size={15} aria-hidden="true" />
            新建文件夹
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={uploading}
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload size={15} aria-hidden="true" />
            {uploading ? '上传中…' : '上传'}
          </button>
          <input ref={uploadInputRef} type="file" hidden onChange={(e) => void upload(e)} />
        </div>
      </div>

      {error && (
        <div className="callout callout-danger" role="alert">
          <p>
            {error}{loaded ? ' 当前继续显示上次成功读取的文件列表。' : ''}
          </p>
          <button className="btn btn-sm" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? '正在重试…' : '重新读取'}
          </button>
        </div>
      )}
      {saved && <p className="callout callout-success" role="status">文件已保存。</p>}

      {!loaded ? (
        loading ? (
          <div className="page-loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            正在读取文件列表…
          </div>
        ) : null
      ) : files.length === 0 ? (
        <div className="empty-state card" role="status">
          <span className="empty-icon" aria-hidden="true"><Folder size={28} /></span>
          <h3>当前目录为空。</h3>
          <p>可以上传文件，或新建一个文件夹。</p>
        </div>
      ) : (
        <ul className={`file-list list-group${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
          {files.map((f) => {
            const Icon = f.isDirectory ? Folder : canEditFile(f) ? FileText : File;
            const meta = f.isDirectory
              ? `文件夹 · ${formatModified(f.modifiedAt)}`
              : `${formatSize(f.size)} · ${formatModified(f.modifiedAt)}`;
            const body = (
              <>
                <span className={`file-icon ${f.isDirectory ? 'is-dir' : 'is-file'}`} aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="file-text">
                  <span className="file-name">{f.name}</span>
                  <span className="file-meta">{busyPath === f.path ? '正在准备下载…' : meta}</span>
                </span>
              </>
            );
            return (
              <li key={f.path} className="file-row">
                {f.isDirectory ? (
                  <button className="file-main" type="button" onClick={() => changePath(f.path)} title={`打开 ${f.name}`}>
                    {body}
                    <ChevronRight size={16} aria-hidden="true" className="file-chevron" />
                  </button>
                ) : canEditFile(f) ? (
                  <button className="file-main" type="button" onClick={() => void startEdit(f)} title={`编辑 ${f.name}`}>
                    {body}
                  </button>
                ) : (
                  <span className="file-main">{body}</span>
                )}
                <div className="file-actions">
                  <ActionMenu label={`${f.name} 的操作`} items={menuItems(f)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <dialog
        ref={editDialogRef}
        className="file-edit-dialog"
        aria-labelledby="file-edit-dialog-title"
        onClose={closeEditor}
        onCancel={(event) => {
          event.preventDefault();
          closeEditor();
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeEditor();
        }}
      >
        <div className="file-edit-dialog-panel">
          <header className="file-edit-dialog-header">
            <div>
              <h2 id="file-edit-dialog-title">编辑文件</h2>
              <p className="file-edit-dialog-path">{editPath}</p>
            </div>
            <button className="btn btn-plain" type="button" aria-label="关闭编辑" onClick={closeEditor}>
              关闭
            </button>
          </header>
          {editError && <p className="callout callout-danger file-edit-dialog-error">{editError}</p>}
          {loadingEdit ? (
            <div className="page-loading file-edit-dialog-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              加载中…
            </div>
          ) : (
            <textarea
              className="file-edit-dialog-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              aria-label={`文件内容：${editPath ?? ''}`}
            />
          )}
          <footer className="file-edit-dialog-footer">
            <button className="btn" type="button" onClick={closeEditor}>
              取消
            </button>
            <button
              className="btn btn-primary"
              type="button"
              disabled={saving || loadingEdit || !editPath}
              onClick={() => void saveFile()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </footer>
        </div>
      </dialog>

      <dialog
        ref={renameDialogRef}
        className="confirm-dialog"
        aria-labelledby="file-rename-dialog-title"
        onClose={closeRename}
        onCancel={(event) => {
          event.preventDefault();
          closeRename();
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeRename();
        }}
      >
        <form
          className="confirm-dialog-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmRename();
          }}
        >
          <h2 id="file-rename-dialog-title" className="confirm-dialog-title">
            重命名
          </h2>
          <div className="confirm-dialog-body">
            <p>仅同目录改名，不可包含路径分隔符。</p>
            <div className="field">
              <label htmlFor="file-rename-input">新名称</label>
              <input
                id="file-rename-input"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={renaming}
              />
            </div>
            {renameError && <p className="error">{renameError}</p>}
          </div>
          <footer className="confirm-dialog-footer">
            <button className="btn" type="button" disabled={renaming} onClick={closeRename}>
              取消
            </button>
            <button className="btn btn-primary" type="submit" disabled={renaming || !renameTarget}>
              {renaming ? '重命名中…' : '确认'}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={newDirDialogRef}
        className="confirm-dialog"
        aria-labelledby="file-mkdir-dialog-title"
        onClose={closeNewDir}
        onCancel={(event) => {
          event.preventDefault();
          closeNewDir();
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeNewDir();
        }}
      >
        <form
          className="confirm-dialog-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void createDir();
          }}
        >
          <h2 id="file-mkdir-dialog-title" className="confirm-dialog-title">
            新建文件夹
          </h2>
          <div className="confirm-dialog-body">
            <p>将在「/{path}」下创建。</p>
            <div className="field">
              <label htmlFor="file-mkdir-input">文件夹名称</label>
              <input
                id="file-mkdir-input"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                placeholder="例如 plugins"
                autoComplete="off"
                autoFocus
                disabled={creatingDir}
              />
            </div>
            {newDirError && <p className="error">{newDirError}</p>}
          </div>
          <footer className="confirm-dialog-footer">
            <button className="btn" type="button" disabled={creatingDir} onClick={closeNewDir}>
              取消
            </button>
            <button className="btn btn-primary" type="submit" disabled={creatingDir}>
              {creatingDir ? '创建中…' : '创建'}
            </button>
          </footer>
        </form>
      </dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.isDirectory ? `删除文件夹「${deleteTarget.name}」？` : `删除文件「${deleteTarget?.name ?? ''}」？`}
        description={
          <>
            <p>
              {deleteTarget?.isDirectory
                ? `将递归删除目录「/${deleteTarget.path}」及其中所有文件，且无法恢复。`
                : `将删除文件「/${deleteTarget?.path ?? ''}」，且无法恢复。`}
            </p>
            {deleting && (
              <p role="status" aria-live="polite">
                {deleteTarget?.isDirectory ? '正在删除文件夹…' : '正在删除文件…'}
              </p>
            )}
            {deleteError && <p className="error">{deleteError}</p>}
          </>
        }
        confirmLabel="确认删除"
        danger
        busy={deleting}
        onConfirm={() => void confirmRemove()}
        onCancel={closeDelete}
      />
    </div>
  );
}
