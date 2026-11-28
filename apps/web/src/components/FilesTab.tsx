import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  TextCursor,
  TextCursorInput,
  Trash2,
  Upload,
} from 'lucide-react';
import type { FileEntry, TextFileSaveRequest } from '@mystry/shared';
import { ApiError, api, downloadAuthenticated, getPanelInfo, instanceApi } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useDialogOpen } from '../hooks/useDialogOpen';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useI18n, type MessageKey } from '../i18n';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

/**
 * Whether to offer "Edit". maxBytes is the server's text file limit; null means it could not be read, and then every file is
 * offered: the server still refuses to open one that is too large and says why.
 */
function canEditFile(file: FileEntry, maxBytes: number | null): boolean {
  return !file.isDirectory && (maxBytes === null || file.size <= maxBytes);
}

function parentOf(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/**
 * Turns a typed path into the form the tab keeps ("world/region"): either slash, with empty and "." segments dropped and ".."
 * applied, as the server would resolve it. Returns null when ".." climbs above the instance root, or for a Windows path with a
 * drive letter or a network path, as pasted from Explorer, which would otherwise be read as folders named "C:", "Users" and so
 * on. A first folder named like "c:data" is refused too, as it reads as a drive path; the server on Windows refuses it as
 * well. Such a folder, possible on Linux, is still opened from the list. The server still checks the result.
 */
function normalizeTypedPath(input: string): string | null {
  // Checked before the slashes are read: they hide the leading pair of a network path. Explorer's "Copy as path" wraps the
  // path in double quotes; anywhere else a quote belongs to the name.
  // A pasted path often carries spaces around it, which must not hide the drive letter or the quotes.
  if (/^(?:[A-Za-z]:|\\\\)/.test(input.trim().replace(/^"(.*)"$/, '$1').trimStart())) return null;
  const segments: string[] = [];
  // Whitespace can be part of a directory name, including the last segment: the caller tries the path as typed first.
  for (const segment of input.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      segments.push(segment);
    } else if (segments.pop() === undefined) {
      return null;
    }
  }
  // After "." and ".." are applied, so "./c:data" is refused as well.
  if (/^[A-Za-z]:/.test(segments[0] ?? '')) return null;
  return segments.join('/');
}

const SAVE_SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';

/**
 * Ctrl+S or Cmd+S. The physical key counts only when the layout does not type Latin letters (Russian, Greek...), which the
 * browser's own Ctrl+S still answers to; on a remapped Latin layout such as Dvorak it is another letter. Ctrl+Alt is AltGr on
 * some layouts.
 */
function isSaveShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  return key === 's' || (!/^[a-z]$/.test(key) && event.code === 'KeyS');
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
  editable: boolean;
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
 * A single file row. Isolated with memo: every keystroke in the editor, the path box, or the rename or create input re-renders FilesTab,
 * and with stable callbacks only rows whose props really changed (such as the one being downloaded) re-render.
 */
const FileRow = memo(function FileRow({
  file: f,
  editable,
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
  /** The server's text file limit: undefined until the request settles, null when it failed (see canEditFile). */
  const [maxEditableBytes, setMaxEditableBytes] = useState<number | null | undefined>(undefined);
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
  /** What the "New" dialog creates; null while it is closed. */
  const [createKind, setCreateKind] = useState<'folder' | 'file' | null>(null);
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  /** The breadcrumbs are replaced by a text box holding pathDraft. */
  const [pathEditing, setPathEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [pathDraftError, setPathDraftError] = useState('');
  const [pathChecking, setPathChecking] = useState(false);
  const editDialogRef = useDialogOpen(editPath !== null);
  const renameDialogRef = useDialogOpen(renameTarget !== null);
  const createDialogRef = useDialogOpen(createKind !== null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const pathTriggerRef = useRef<HTMLButtonElement>(null);
  /** Set when leaving the path box should put focus back on the button that opened it. */
  const focusPathTriggerRef = useRef(false);
  /** Path check generation: a check still running when the box is closed must not navigate afterwards. */
  const pathCheckGenerationRef = useRef(0);
  /** Edit generation: incremented when the editor is closed or a new file is opened, used to discard old file content arriving in a slow response. */
  const editGenerationRef = useRef(0);
  /** The edit generation of a file just created, whose editor opens with the cursor in the text; 0 for none. */
  const focusTextGenerationRef = useRef(0);
  const editTextRef = useRef<HTMLTextAreaElement>(null);
  /** File list request generation: late old lists are discarded after a directory change, so they do not overwrite the current view. */
  const loadGenerationRef = useRef(0);
  /** A refresh started after an async file operation reads the directory currently shown. */
  const pathRef = useRef('');
  const downloadControllersRef = useRef(new Set<AbortController>());
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoading(true);
    try {
      const list = await api<FileEntry[]>(
        instanceApi(instanceId, `/files?path=${encodeURIComponent(pathRef.current)}`),
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
  }, [instanceId]);

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
    return () => {
      loadGenerationRef.current += 1;
      pathCheckGenerationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    getPanelInfo()
      .then((info) => {
        if (active) setMaxEditableBytes(typeof info.maxTextFileBytes === 'number' ? info.maxTextFileBytes : null);
      })
      .catch(() => {
        if (active) setMaxEditableBytes(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (pathEditing) {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    } else if (focusPathTriggerRef.current) {
      focusPathTriggerRef.current = false;
      pathTriggerRef.current?.focus();
    }
  }, [pathEditing]);

  const editDirty = editPath !== null && !editBinary && editOriginal !== null && content !== editOriginal;
  /** The Save button and Ctrl+S share this. */
  const canSave = editDirty && !saving && !loadingEdit;
  const blocker = useUnsavedGuard(editDirty, saving);

  const editorOpen = editPath !== null;
  // A confirmation over the editor takes the focus out of the editor's dialog, where the browser would still offer to save the
  // whole page. Nothing is saved from there: a save closes the editor beneath the open confirmation.
  useEffect(() => {
    if (!editorOpen) return;
    const keepFromBrowser = (event: KeyboardEvent) => {
      if (isSaveShortcut(event)) event.preventDefault();
    };
    document.addEventListener('keydown', keepFromBrowser);
    return () => document.removeEventListener('keydown', keepFromBrowser);
  }, [editorOpen]);

  const editTextShown = editOriginal !== null && !loadingEdit;
  // Only for a file just created, which is opened to be written; a file opened from the list keeps the dialog's own first focus.
  useEffect(() => {
    if (!editTextShown || focusTextGenerationRef.current !== editGenerationRef.current) return;
    focusTextGenerationRef.current = 0;
    editTextRef.current?.focus();
  }, [editTextShown]);

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

  function closeCreate() {
    if (creating) return;
    setCreateKind(null);
    setCreateName('');
    setCreateError('');
  }

  function startPathEdit() {
    setPathDraft(`/${path}`);
    setPathDraftError('');
    setPathEditing(true);
  }

  function endPathEdit(returnFocus: boolean) {
    pathCheckGenerationRef.current += 1;
    if (returnFocus) focusPathTriggerRef.current = true;
    setPathEditing(false);
    setPathChecking(false);
    setPathDraftError('');
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteError('');
  }

  // The callbacks passed to FileRow below keep stable references, so not every keystroke in an input re-renders the whole list.
  const changePath = useCallback((nextPath: string, listing?: FileEntry[]) => {
    if (nextPath === pathRef.current) return;
    pathRef.current = nextPath;
    setPath(nextPath);
    setError('');
    setFiles(listing ?? []);
    setLoaded(listing !== undefined);
    if (listing === undefined) {
      void load();
    } else {
      loadGenerationRef.current += 1;
      setLoading(false);
    }
  }, [load]);

  const startEdit = useCallback(async (file: FileEntry) => {
    if (file.isDirectory) return;
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
    if (!canSave || !editPath) return;
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
  const createFolder = (createKind ?? 'folder') === 'folder';
  const createIssue = validateEntryName(createName, createFolder);

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

  async function createEntry() {
    if (!createKind || creating) return;
    const folder = createKind === 'folder';
    const validation = validateEntryName(createName, folder);
    if (validation) {
      setCreateError(t(validation));
      return;
    }
    const name = createName.trim();
    const target = path ? `${path}/${name}` : name;
    setCreating(true);
    setCreateError('');
    try {
      if (folder) {
        await api(instanceApi(instanceId, '/files/mkdir'), {
          method: 'POST',
          json: { path: target },
        });
      } else {
        // An empty save that the server refuses when anything already has this name: the list may not show it yet,
        // or on Windows differ from it only in letter case, and an ordinary save would empty that file.
        const body: TextFileSaveRequest = { path: target, content: '', onConflict: 'fail' };
        await api(instanceApi(instanceId, '/files/content'), { method: 'PUT', json: body });
      }
      setCreateKind(null);
      setCreateName('');
      const editGeneration = editGenerationRef.current;
      await load();
      // Opened once the dialog has closed and handed focus back, so that hand-back cannot land behind the editor. The list
      // stays clickable while it reloads: a file opened from it meanwhile is left alone, edits and all.
      if (!folder && editGeneration === editGenerationRef.current) {
        void startEdit({ name, path: target, isDirectory: false, size: 0, modifiedAt: new Date().toISOString() });
        // startEdit has already taken its generation: only this file's text gets the cursor once it is shown.
        focusTextGenerationRef.current = editGenerationRef.current;
      }
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function submitPathDraft() {
    if (pathChecking) return;
    const target = normalizeTypedPath(pathDraft);
    if (target === null) {
      setPathDraftError(t('files.nav.pathOutside'));
      return;
    }
    if (target === path) {
      endPathEdit(true);
      return;
    }
    // The folder is listed before the view moves there, so a mistyped path leaves the current list and breadcrumbs as they were.
    const generation = pathCheckGenerationRef.current + 1;
    pathCheckGenerationRef.current = generation;
    setPathChecking(true);
    setPathDraftError('');
    const listPath = (candidate: string) => api<FileEntry[]>(instanceApi(instanceId, `/files?path=${encodeURIComponent(candidate)}`));
    try {
      const listing = await listPath(target);
      if (generation !== pathCheckGenerationRef.current) return;
      endPathEdit(true);
      changePath(target, listing);
    } catch (err) {
      if (generation !== pathCheckGenerationRef.current) return;
      // A folder whose name starts or ends with a space is rare, and a path pasted with spaces around it is not: when the
      // path as typed cannot be listed, the one without them is tried. Its failure is not shown, the first one says more.
      const trimmed = normalizeTypedPath(pathDraft.trim());
      if (trimmed !== null && trimmed !== target) {
        try {
          const listing = trimmed === path ? undefined : await listPath(trimmed);
          if (generation !== pathCheckGenerationRef.current) return;
          endPathEdit(true);
          if (listing) changePath(trimmed, listing);
          return;
        } catch {
          if (generation !== pathCheckGenerationRef.current) return;
        }
      }
      setPathDraftError(errorMessage(err));
      setPathChecking(false);
    }
  }

  const segments = path.split('/').filter(Boolean);
  // Disabled until a creation has finished, list reload included, so the dialog cannot reopen under the editor about to open.
  const createMenuItems: ActionMenuItem[] = [
    { key: 'folder', label: t('files.toolbar.newFolderItem'), icon: <FolderPlus size={14} />, disabled: creating, onSelect: () => setCreateKind('folder') },
    { key: 'file', label: t('files.toolbar.newFileItem'), icon: <FilePlus size={14} />, disabled: creating, onSelect: () => setCreateKind('file') },
  ];

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
          <div className={pathEditing ? 'files-path is-editing' : 'files-path'}>
            {/* Left in place and hidden while the box is open: the row keeps the trail's height, so closing the box moves nothing. */}
            <nav className="breadcrumbs" aria-label={t('files.nav.breadcrumbs')} inert={pathEditing}>
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
              {/* The space after the last folder, as in a desktop file manager's address bar. */}
              <button
                ref={pathTriggerRef}
                type="button"
                className="breadcrumbs-edit"
                title={t('files.nav.editPath')}
                aria-label={t('files.nav.editPath')}
                onClick={startPathEdit}
              >
                <TextCursor size={14} aria-hidden="true" />
              </button>
            </nav>
            {pathEditing && (
              <form
                className="files-path-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitPathDraft();
                }}
              >
                <input
                  ref={pathInputRef}
                  className="input files-path-input"
                  value={pathDraft}
                  onChange={(event) => {
                    setPathDraft(event.target.value);
                    setPathDraftError('');
                  }}
                  onKeyDown={(event) => {
                    // Escape during an IME composition only cancels the composition.
                    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    event.preventDefault();
                    endPathEdit(true);
                  }}
                  onBlur={(event) => {
                    // Switching to another window to copy a path keeps the box open: nothing on the page takes the focus.
                    if (!event.relatedTarget && !document.hasFocus()) return;
                    // Closed at once, before the click that moved the focus lands: the trail under the box keeps the row's
                    // height and the error floats over the list, so nothing moves under the pointer.
                    endPathEdit(false);
                  }}
                  readOnly={pathChecking}
                  aria-label={t('files.nav.pathLabel')}
                  aria-invalid={pathDraftError ? true : undefined}
                  aria-describedby={pathDraftError ? 'files-path-error' : undefined}
                  aria-busy={pathChecking || undefined}
                  enterKeyHint="go"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </form>
            )}
          </div>
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
          <ActionMenu label={t('files.toolbar.new')} triggerIcon={<Plus size={15} aria-hidden="true" />} items={createMenuItems} />
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
        {pathEditing && pathDraftError && (
          // A press on the message only dismisses it: the box keeps the focus and what was typed.
          <p
            id="files-path-error"
            className="callout callout-danger files-path-error"
            role="alert"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setPathDraftError('')}
          >
            {pathDraftError}
          </p>
        )}
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

      {!loaded || maxEditableBytes === undefined ? (
        // The rows wait for the text file limit too, so none of them changes between editable and not once it arrives.
        loading || loaded ? (
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
              editable={canEditFile(f, maxEditableBytes)}
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
        onKeyDown={(event) => {
          if (!isSaveShortcut(event)) return;
          // Also when there is nothing to save, or the browser offers to save the whole page instead.
          event.preventDefault();
          if (!event.repeat) void saveFile();
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
              ref={editTextRef}
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
                  disabled={!canSave}
                  title={t('files.edit.saveWithShortcut', { shortcut: SAVE_SHORTCUT })}
                  aria-keyshortcuts="Control+S Meta+S"
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
        ref={createDialogRef}
        className="confirm-dialog"
        aria-labelledby="file-create-dialog-title"
        onClose={closeCreate}
        onCancel={(event) => {
          event.preventDefault();
          closeCreate();
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeCreate();
        }}
      >
        <form
          className="confirm-dialog-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void createEntry();
          }}
        >
          <h2 id="file-create-dialog-title" className="confirm-dialog-title">
            {createFolder ? t('files.toolbar.newFolder') : t('files.toolbar.newFile')}
          </h2>
          <div className="confirm-dialog-body">
            <p>{createFolder ? t('files.mkdir.location', { path }) : t('files.newFile.location', { path })}</p>
            <div className="field">
              <label htmlFor="file-create-input">{createFolder ? t('files.mkdir.name') : t('files.newFile.name')}</label>
              <input
                id="file-create-input"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={createFolder ? t('files.mkdir.placeholder') : t('files.newFile.placeholder')}
                autoComplete="off"
                autoFocus
                disabled={creating}
                aria-invalid={createIssue && createName.trim() ? true : undefined}
              />
            </div>
            {createIssue && createName.trim() ? <p className="error">{t(createIssue)}</p>
              : createError && <p className="error">{createError}</p>}
          </div>
          <footer className="confirm-dialog-footer">
            <button className="btn" type="button" disabled={creating} onClick={closeCreate}>
              {t('action.cancel')}
            </button>
            <button className="btn btn-primary" type="submit" disabled={creating || createIssue !== null}>
              {creating ? t('files.create.creating') : t('files.create.submit')}
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
