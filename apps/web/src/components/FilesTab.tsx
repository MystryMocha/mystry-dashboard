import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, File, FileText, Folder, FolderPlus, Pencil, RefreshCw, TextCursorInput, Trash2, Upload } from 'lucide-react';
import type { FileEntry } from '@mystry/shared';
import { ApiError, api, downloadAuthenticated, instanceApi } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useDialogOpen } from '../hooks/useDialogOpen';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n, type MessageKey } from '../i18n';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

/** Aligned with the server's default MAX_TEXT_FILE_BYTES, used to decide whether to show "Edit". */
const MAX_EDITABLE_FILE_BYTES = 1_048_576;

function canEditFile(file: FileEntry): boolean {
  return !file.isDirectory && file.size <= MAX_EDITABLE_FILE_BYTES;
}

function parentOf(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** Validates a name within the same directory and returns the error string key; when folder is true the "folder name" messages are used. */
function validateEntryName(name: string, folder = false): MessageKey | null {
  const trimmed = name.trim();
  if (!trimmed) return folder ? 'files.validation.folderNameEmpty' : 'files.validation.nameEmpty';
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return folder ? 'files.validation.folderNameSeparator' : 'files.validation.nameSeparator';
  }
  return null;
}

type FileRowProps = {
  file: FileEntry;
  /** This file is being prepared for download. */
  busy: boolean;
  deleting: boolean;
  renaming: boolean;
  onOpenDir: (path: string) => void;
  onEdit: (file: FileEntry) => void;
  onDownload: (file: FileEntry) => void;
  onRename: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
};

/** On a list refresh the server returns new objects; rows with the same content are treated as the same row and need no re-render. */
function sameFileRowProps(prev: FileRowProps, next: FileRowProps): boolean {
  for (const key of Object.keys(next) as (keyof FileRowProps)[]) {
    if (key !== 'file' && prev[key] !== next[key]) return false;
  }
  const a = prev.file;
  const b = next.file;
  return a === b || (a.path === b.path && a.name === b.name && a.isDirectory === b.isDirectory
    && a.size === b.size && a.modifiedAt === b.modifiedAt);
}

/**
 * A single file row. Isolated with memo: every keystroke in the editor, rename or new-folder input re-renders FilesTab,
 * and with stable callbacks only rows whose props really changed (such as the one being downloaded) re-render.
 */
const FileRow = memo(function FileRow({
  file: f,
  busy,
  deleting,
  renaming,
  onOpenDir,
  onEdit,
  onDownload,
  onRename,
  onDelete,
}: FileRowProps) {
  const { t, fmt } = useI18n();
  const editable = canEditFile(f);
  const Icon = f.isDirectory ? Folder : editable ? FileText : File;
  const meta = f.isDirectory
    ? t('files.row.folderMeta', { modified: fmt.dateTime(f.modifiedAt) })
    : `${fmt.fileSize(f.size)} · ${fmt.dateTime(f.modifiedAt)}`;

  const items: ActionMenuItem[] = [];
  if (!f.isDirectory) {
    items.push({
      key: 'download',
      label: busy ? t('files.menu.downloading') : t('action.download'),
      icon: <Download size={14} />,
      disabled: busy || deleting,
      onSelect: () => onDownload(f),
    });
  }
  if (editable) {
    items.push({
      key: 'edit',
      label: t('action.edit'),
      icon: <Pencil size={14} />,
      disabled: deleting,
      onSelect: () => onEdit(f),
    });
  }
  items.push(
    {
      key: 'rename',
      label: t('action.rename'),
      icon: <TextCursorInput size={14} />,
      disabled: busy || renaming || deleting,
      onSelect: () => onRename(f),
    },
    {
      key: 'delete',
      label: t('action.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: deleting,
      onSelect: () => onDelete(f),
    },
  );

  const body = (
    <>
      <span className={`file-icon ${f.isDirectory ? 'is-dir' : 'is-file'}`} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="file-text">
        <span className="file-name">{f.name}</span>
        <span className="file-meta">{busy ? t('files.row.preparingDownload') : meta}</span>
      </span>
    </>
  );
  return (
    <li className="file-row">
      {f.isDirectory ? (
        <button className="file-main" type="button" onClick={() => onOpenDir(f.path)} title={t('files.row.open', { name: f.name })}>
          {body}
          <ChevronRight size={16} aria-hidden="true" className="file-chevron" />
        </button>
      ) : editable ? (
        <button className="file-main" type="button" onClick={() => onEdit(f)} title={t('files.row.edit', { name: f.name })}>
          {body}
        </button>
      ) : (
        <span className="file-main">{body}</span>
      )}
      <div className="file-actions">
        <ActionMenu label={t('files.row.actions', { name: f.name })} items={items} />
      </div>
    </li>
  );
}, sameFileRowProps);

/** Instance file management. Remounted by the parent per instance ID when the instance changes, so instance changes are not handled here. */
export function FilesTab({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editPath, setEditPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  /** The original content on a successful read; null means not read yet or the read failed, in which case no edit box is shown and saving is not possible, so the original file is not overwritten with empty content. */
  const [editOriginal, setEditOriginal] = useState<string | null>(null);
  /** The server found a NUL byte near the start: the file is shown read-only, because saving the decoded text would break it. */
  const [editBinary, setEditBinary] = useState(false);
  const [error, setError] = useState('');
  const [editError, setEditError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [confirmDiscardEdit, setConfirmDiscardEdit] = useState(false);
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
  /** Edit generation: incremented when the editor is closed or a new file is opened, used to discard old file content arriving in a slow response. */
  const editGenerationRef = useRef(0);
  /** File list request generation: late old lists are discarded after a directory change, so they do not overwrite the current view. */
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
      // When a refresh fails the last successful list is kept, so a temporary network problem is not shown as an empty directory.
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

  const editDirty = editPath !== null && !editBinary && editOriginal !== null && content !== editOriginal;
  const blocker = useUnsavedGuard(editDirty, saving);

  function closeEditor() {
    editGenerationRef.current += 1;
    setEditPath(null);
    setContent('');
    setEditOriginal(null);
    setEditBinary(false);
    setEditError('');
    setLoadingEdit(false);
    setConfirmDiscardEdit(false);
  }

  function requestCloseEditor() {
    if (saving) return;
    if (editDirty) {
      setConfirmDiscardEdit(true);
      return;
    }
    closeEditor();
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

  // The callbacks passed to FileRow below keep stable references, so not every keystroke in an input re-renders the whole list.
  const changePath = useCallback((nextPath: string) => {
    loadGenerationRef.current += 1;
    setFiles([]);
    setLoaded(false);
    setLoading(true);
    setError('');
    setPath(nextPath);
  }, []);

  const startEdit = useCallback(async (file: FileEntry) => {
    if (!canEditFile(file)) return;
    const generation = editGenerationRef.current + 1;
    editGenerationRef.current = generation;
    setLoadingEdit(true);
    setEditError('');
    setEditPath(file.path);
    setContent('');
    setEditOriginal(null);
    setEditBinary(false);
    setConfirmDiscardEdit(false);
    try {
      const res = await api<{ content: string; binary?: boolean }>(
        instanceApi(instanceId, `/files/content?path=${encodeURIComponent(file.path)}`),
      );
      // The editor may have been closed or another file opened in the meantime; stale responses must be discarded, or A's content would be saved into file B.
      if (generation !== editGenerationRef.current) return;
      setContent(res.content);
      setEditOriginal(res.content);
      setEditBinary(res.binary === true);
    } catch (err) {
      if (generation !== editGenerationRef.current) return;
      setEditError(errorMessage(err));
    } finally {
      if (generation === editGenerationRef.current) setLoadingEdit(false);
    }
  }, [instanceId]);

  async function saveFile() {
    if (!editPath || editOriginal === null || editBinary) return;
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

  const requestRemove = useCallback((file: FileEntry) => {
    setDeleteTarget(file);
    setDeleteError('');
  }, []);

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

  const download = useCallback(async (file: FileEntry) => {
    if (file.isDirectory) return;
    const controller = new AbortController();
    downloadControllersRef.current.add(controller);
    setBusyPath(file.path);
    setError('');
    try {
      await downloadAuthenticated(instanceId, file.path, controller.signal);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err instanceof ApiError && err.status === 429 ? t('files.download.busy') : errorMessage(err));
    } finally {
      downloadControllersRef.current.delete(controller);
      setBusyPath((current) => (current === file.path ? null : current));
    }
  }, [instanceId, t]);

  const startRename = useCallback((file: FileEntry) => {
    setRenameTarget(file);
    setRenameName(file.name);
    setRenameError('');
  }, []);

  // The confirm button is disabled when the name does not comply or is unchanged; an explanation shows under the input only when something non-compliant is filled in, with no early error while empty.
  const renameIssue = renameTarget ? validateEntryName(renameName) : null;
  const renameUnchanged = renameTarget !== null && renameName.trim() === renameTarget.name;
  const newDirIssue = validateEntryName(newDir, true);

  async function confirmRename() {
    if (!renameTarget) return;
    const validation = validateEntryName(renameName);
    if (validation) {
      setRenameError(t(validation));
      return;
    }
    const newName = renameName.trim();
    if (newName === renameTarget.name) {
      setRenameError(t('files.rename.sameName'));
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
    const validation = validateEntryName(newDir, true);
    if (validation) {
      setNewDirError(t(validation));
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

  return (
    <div className="files-workspace">
      <div className="files-toolbar">
        <div className="files-nav">
          <button
            className="btn btn-icon"
            type="button"
            title={t('files.nav.parent')}
            aria-label={t('files.nav.parent')}
            onClick={() => changePath(parentOf(path))}
            disabled={!path}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <nav className="breadcrumbs" aria-label={t('files.nav.breadcrumbs')}>
            <button
              type="button"
              className="breadcrumb"
              aria-current={segments.length === 0 ? 'page' : undefined}
              onClick={() => changePath('')}
            >
              {t('files.nav.root')}
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
            title={t('action.refresh')}
            aria-label={t('files.toolbar.refreshLabel')}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} aria-hidden="true" className={loading ? 'spin' : undefined} />
          </button>
          <button className="btn" type="button" onClick={() => setNewDirOpen(true)}>
            <FolderPlus size={15} aria-hidden="true" />
            {t('files.toolbar.newFolder')}
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={uploading}
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload size={15} aria-hidden="true" />
            {uploading ? t('files.toolbar.uploading') : t('action.upload')}
          </button>
          <input ref={uploadInputRef} type="file" hidden onChange={(e) => void upload(e)} />
        </div>
      </div>

      {error && (
        <div className="callout callout-danger" role="alert">
          <p>
            {loaded ? t('files.list.errorWithStale', { error }) : error}
          </p>
          <button className="btn btn-sm" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? t('files.list.retrying') : t('files.list.reload')}
          </button>
        </div>
      )}
      {saved && <p className="callout callout-success" role="status">{t('files.list.saved')}</p>}

      {!loaded ? (
        loading ? (
          <div className="page-loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {t('files.list.loading')}
          </div>
        ) : null
      ) : files.length === 0 ? (
        <div className="empty-state card" role="status">
          <span className="empty-icon" aria-hidden="true"><Folder size={28} /></span>
          <h3>{t('files.empty.title')}</h3>
          <p>{t('files.empty.body')}</p>
        </div>
      ) : (
        <ul className={`file-list list-group${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              busy={busyPath === f.path}
              deleting={deleting}
              renaming={renaming}
              onOpenDir={changePath}
              onEdit={startEdit}
              onDownload={download}
              onRename={startRename}
              onDelete={requestRemove}
            />
          ))}
        </ul>
      )}

      <dialog
        ref={editDialogRef}
        className="file-edit-dialog"
        aria-labelledby="file-edit-dialog-title"
        onClose={() => {
          if (editPath !== null && (saving || editDirty)) {
            const dialog = editDialogRef.current;
            if (dialog && !dialog.open) dialog.showModal();
            if (editDirty && !saving) setConfirmDiscardEdit(true);
            return;
          }
          closeEditor();
        }}
        onCancel={(event) => {
          event.preventDefault();
          requestCloseEditor();
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestCloseEditor();
        }}
      >
        <div className="file-edit-dialog-panel">
          <header className="file-edit-dialog-header">
            <div>
              <h2 id="file-edit-dialog-title">{t('files.edit.title')}</h2>
              <p className="file-edit-dialog-path">{editPath}</p>
            </div>
            <button className="btn btn-plain" type="button" disabled={saving} aria-label={t('files.edit.closeLabel')} onClick={requestCloseEditor}>
              {t('action.close')}
            </button>
          </header>
          {editBinary && <p className="callout callout-warning file-edit-dialog-callout" role="status">{t('files.edit.binaryReadOnly')}</p>}
          {editError && <p className="callout callout-danger file-edit-dialog-callout">{editError}</p>}
          {loadingEdit ? (
            <div className="page-loading file-edit-dialog-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              {t('common.loading')}
            </div>
          ) : editOriginal !== null && (
            <textarea
              className="file-edit-dialog-textarea"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={editBinary || saving}
              spellCheck={false}
              aria-label={t('files.edit.contentLabel', { path: editPath ?? '' })}
            />
          )}
          <footer className="file-edit-dialog-footer">
            {editBinary ? (
              <button className="btn" type="button" onClick={closeEditor}>
                {t('action.close')}
              </button>
            ) : (
              <>
                <button className="btn" type="button" disabled={saving} onClick={requestCloseEditor}>
                  {t('action.cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={saving || loadingEdit || !editPath || editOriginal === null || content === editOriginal}
                  onClick={() => void saveFile()}
                >
                  {saving ? t('action.saving') : t('action.save')}
                </button>
              </>
            )}
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
            {t('action.rename')}
          </h2>
          <div className="confirm-dialog-body">
            <p>{t('files.rename.hint')}</p>
            <div className="field">
              <label htmlFor="file-rename-input">{t('files.rename.newName')}</label>
              <input
                id="file-rename-input"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={renaming}
                aria-invalid={renameIssue && renameName.trim() ? true : undefined}
              />
            </div>
            {renameIssue && renameName.trim() ? <p className="error">{t(renameIssue)}</p>
              : renameError && <p className="error">{renameError}</p>}
          </div>
          <footer className="confirm-dialog-footer">
            <button className="btn" type="button" disabled={renaming} onClick={closeRename}>
              {t('action.cancel')}
            </button>
            <button className="btn btn-primary" type="submit" disabled={renaming || !renameTarget || renameIssue !== null || renameUnchanged}>
              {renaming ? t('files.rename.renaming') : t('action.confirm')}
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
            {t('files.toolbar.newFolder')}
          </h2>
          <div className="confirm-dialog-body">
            <p>{t('files.mkdir.location', { path })}</p>
            <div className="field">
              <label htmlFor="file-mkdir-input">{t('files.mkdir.name')}</label>
              <input
                id="file-mkdir-input"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                placeholder={t('files.mkdir.placeholder')}
                autoComplete="off"
                autoFocus
                disabled={creatingDir}
                aria-invalid={newDirIssue && newDir.trim() ? true : undefined}
              />
            </div>
            {newDirIssue && newDir.trim() ? <p className="error">{t(newDirIssue)}</p>
              : newDirError && <p className="error">{newDirError}</p>}
          </div>
          <footer className="confirm-dialog-footer">
            <button className="btn" type="button" disabled={creatingDir} onClick={closeNewDir}>
              {t('action.cancel')}
            </button>
            <button className="btn btn-primary" type="submit" disabled={creatingDir || newDirIssue !== null}>
              {creatingDir ? t('files.mkdir.creating') : t('files.mkdir.create')}
            </button>
          </footer>
        </form>
      </dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.isDirectory
          ? t('files.delete.folderTitle', { name: deleteTarget.name })
          : t('files.delete.fileTitle', { name: deleteTarget?.name ?? '' })}
        description={
          <>
            <p>
              {deleteTarget?.isDirectory
                ? t('files.delete.folderBody', { path: deleteTarget.path })
                : t('files.delete.fileBody', { path: deleteTarget?.path ?? '' })}
            </p>
            {deleting && (
              <p role="status" aria-live="polite">
                {deleteTarget?.isDirectory ? t('files.delete.deletingFolder') : t('files.delete.deletingFile')}
              </p>
            )}
            {deleteError && <p className="error">{deleteError}</p>}
          </>
        }
        confirmLabel={t('files.delete.confirm')}
        danger
        busy={deleting}
        onConfirm={() => void confirmRemove()}
        onCancel={closeDelete}
      />

      <ConfirmDialog
        open={confirmDiscardEdit}
        title={t('files.edit.discard.title')}
        description={t('files.edit.discard.body')}
        confirmLabel={t('files.edit.discard.confirm')}
        danger
        busy={saving}
        onConfirm={closeEditor}
        onCancel={() => setConfirmDiscardEdit(false)}
      />

      <UnsavedChangesDialog
        blocker={blocker}
        saving={saving}
        title={t('files.edit.unsaved.title')}
        savingTitle={t('files.edit.unsaved.savingTitle')}
        description={t('files.edit.unsaved.description')}
      />
    </div>
  );
}
