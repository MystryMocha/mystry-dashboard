import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@mystry/shared';
import { ApiError, api, downloadAuthenticated, instanceApi } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useDialogOpen } from '../hooks/useDialogOpen';
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
  const [newDir, setNewDir] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const editDialogRef = useDialogOpen(editPath !== null);
  const renameDialogRef = useDialogOpen(renameTarget !== null);
  /** 编辑代次：关闭编辑器或打开新文件时递增，用于丢弃慢响应到达的旧文件内容。 */
  const editGenerationRef = useRef(0);
  /** 文件列表请求代次：切换目录后丢弃迟到的旧列表，避免覆盖当前视图。 */
  const loadGenerationRef = useRef(0);
  const downloadControllersRef = useRef(new Set<AbortController>());

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
      setTimeout(() => setSaved(false), 1500);
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
    try {
      await api(instanceApi(instanceId, `/files/upload?path=${encodeURIComponent(path)}`), {
        method: 'POST',
        body: form,
      });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      e.target.value = '';
    }
  }

  async function createDir() {
    if (!newDir.trim()) return;
    const target = path ? `${path}/${newDir.trim()}` : newDir.trim();
    try {
      await api(instanceApi(instanceId, '/files/mkdir'), {
        method: 'POST',
        json: { path: target },
      });
      setNewDir('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="files-workspace panel">
      <div className="files-toolbar">
        <div className="btn-row">
          <button className="btn btn-ghost" type="button" onClick={() => changePath(parentOf(path))} disabled={!path}>
            上级
          </button>
          <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
            上传
            <input type="file" hidden onChange={(e) => void upload(e)} />
          </label>
        </div>
        <p className="muted files-path">当前路径：/{path || ''}</p>
        {error && (
          <div role="alert">
            <p className="error">
              {error}{loaded ? ' 当前继续显示上次成功读取的文件列表。' : ''}
            </p>
            <button className="btn btn-ghost" type="button" disabled={loading} onClick={() => void load()}>
              {loading ? '正在重试…' : '重新读取'}
            </button>
          </div>
        )}
        {saved && <p className="muted">已保存</p>}
        {!loaded && loading && (
          <p className="muted" role="status" aria-live="polite">
            正在读取文件列表…
          </p>
        )}
        {loaded && loading && (
          <p className="muted" role="status" aria-live="polite">
            正在刷新文件列表，继续显示上次结果。
          </p>
        )}
      </div>

      {!loaded ? null : files.length === 0 ? (
        <p className="muted" role="status">当前目录为空。</p>
      ) : (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path}>
              {f.isDirectory ? (
                <button className="linkish" type="button" onClick={() => changePath(f.path)}>
                  <span className="file-kind dir" aria-hidden="true" />
                  {f.name}
                </button>
              ) : (
                <span className="file-name">
                  <span className="file-kind file" aria-hidden="true" />
                  {f.name}
                </span>
              )}
              <div className="file-actions">
                {!f.isDirectory && (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={busyPath === f.path || deleting}
                    onClick={() => void download(f)}
                  >
                    {busyPath === f.path ? '下载中…' : '下载'}
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busyPath === f.path || renaming || deleting}
                  onClick={() => startRename(f)}
                >
                  重命名
                </button>
                {canEditFile(f) && (
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={deleting}
                    onClick={() => void startEdit(f)}
                  >
                    编辑
                  </button>
                )}
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={deleting}
                  onClick={() => requestRemove(f)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="files-footer field">
        <label>新建文件夹</label>
        <div className="btn-row">
          <input value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="目录名" />
          <button className="btn btn-ghost" type="button" onClick={() => void createDir()}>
            创建
          </button>
        </div>
      </div>

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
            <button className="btn btn-ghost" type="button" aria-label="关闭编辑" onClick={closeEditor}>
              关闭
            </button>
          </header>
          {editError && <p className="error file-edit-dialog-error">{editError}</p>}
          {loadingEdit ? (
            <p className="muted file-edit-dialog-loading">加载中…</p>
          ) : (
            <textarea
              className="file-edit-dialog-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
            />
          )}
          <footer className="file-edit-dialog-footer">
            <button className="btn btn-ghost" type="button" onClick={closeEditor}>
              取消
            </button>
            <button
              className="btn"
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
        <div className="confirm-dialog-panel">
          <h2 id="file-rename-dialog-title" className="confirm-dialog-title">
            重命名
          </h2>
          <div className="confirm-dialog-body">
            <p className="muted" style={{ marginTop: 0 }}>
              仅同目录改名，不可包含路径分隔符。
            </p>
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
            <button className="btn btn-ghost" type="button" disabled={renaming} onClick={closeRename}>
              取消
            </button>
            <button
              className="btn"
              type="button"
              disabled={renaming || !renameTarget}
              onClick={() => void confirmRename()}
            >
              {renaming ? '重命名中…' : '确认'}
            </button>
          </footer>
        </div>
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
