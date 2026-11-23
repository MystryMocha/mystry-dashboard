import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Download, History, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { BackupInfo, InstanceInfo, TaskInfo } from '@mystry/shared';
import { createBackup, deleteBackup, downloadBackup, listBackups, pollTask, restoreBackup, uploadBackup } from '../api';
import { errorMessage, isAbortError } from '../errors';
import { useI18n, type MessageKey } from '../i18n';
import { isLifecycleBusy, isProcessAlive } from '../instance-status';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { BackupScheduleSection } from './BackupScheduleSection';
import { ConfirmDialog } from './ConfirmDialog';
import { TaskProgress } from './TaskProgress';

const SOURCE_LABEL: Record<BackupInfo['source'], MessageKey> = {
  manual: 'backups.source.manual',
  'pre-restore': 'backups.source.preRestore',
  upload: 'backups.source.upload',
  scheduled: 'backups.source.scheduled',
};

/** Instance backups: one-click backup, upload, download, restore and delete, and the daily automatic backup. Remounted by the parent when the instance changes. */
export function BackupsTab({ instance, onRestored }: { instance: InstanceInfo; onRestored: () => void }) {
  const { t, fmt } = useI18n();
  const instanceId = instance.id;
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Counts successful reads of the list; the automatic backup section reads its latest run again with each one.
  const [listVersion, setListVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Kept apart from action errors: the list reload that follows a failed backup or restore would otherwise wipe its reason.
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [backupCurrent, setBackupCurrent] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** True once clicked and before the server has replied with a task; repeated clicks, or clicking another action right after, must be blocked. */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const controllersRef = useRef(new Set<AbortController>());

  const running = isProcessAlive(instance.status);
  const busy = task !== null || starting || uploading || deleting;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBackups(await listBackups(instanceId));
      setLoaded(true);
      setListVersion((version) => version + 1);
      setListError('');
    } catch (err) {
      setListError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  /** Tracks a background task until it ends; polling stops when the component unmounts, and the task itself stays visible in the task center. */
  async function follow(
    start: () => Promise<TaskInfo>,
    doneKey: MessageKey | ((result: TaskInfo['result']) => MessageKey),
    after?: () => void,
  ) {
    // A second click within the same event loop cannot see starting yet, so a ref blocks it synchronously.
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setError('');
    setNotice('');
    try {
      let started: TaskInfo;
      try {
        started = await start();
      } finally {
        startingRef.current = false;
        if (!controller.signal.aborted) setStarting(false);
      }
      setTask(started);
      const result = await pollTask(started.id, setTask, controller.signal);
      setNotice(t(typeof doneKey === 'function' ? doneKey(result) : doneKey));
      after?.();
    } catch (err) {
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      controllersRef.current.delete(controller);
      if (!controller.signal.aborted) {
        setTask(null);
        void load();
      }
    }
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setUploading(true);
    setError('');
    setNotice('');
    try {
      await uploadBackup(instanceId, file, controller.signal);
      setNotice(t('backups.notice.uploaded'));
      await load();
    } catch (err) {
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      controllersRef.current.delete(controller);
      if (!controller.signal.aborted) setUploading(false);
    }
  }

  async function download(backup: BackupInfo) {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setDownloadingId(backup.id);
    setError('');
    try {
      await downloadBackup(instanceId, backup.id, controller.signal);
    } catch (err) {
      if (!isAbortError(err)) setError(errorMessage(err));
    } finally {
      controllersRef.current.delete(controller);
      if (!controller.signal.aborted) setDownloadingId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    setNotice('');
    try {
      await deleteBackup(instanceId, deleteTarget.id);
      setDeleteTarget(null);
      setNotice(t('backups.notice.deleted'));
      await load();
    } catch (err) {
      setDeleteTarget(null);
      setError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  function startRestore() {
    const target = restoreTarget;
    if (!target) return;
    setRestoreTarget(null);
    void follow(
      () => restoreBackup(instanceId, target.id, backupCurrent),
      (result) => (result?.instanceRecordUpdated ? 'backups.notice.restoredRecordUpdated' : 'backups.notice.restored'),
      onRestored,
    );
  }

  function menuItems(backup: BackupInfo): ActionMenuItem[] {
    return [
      {
        key: 'download',
        label: downloadingId === backup.id ? t('backups.menu.downloading') : t('action.download'),
        icon: <Download size={14} />,
        disabled: downloadingId === backup.id,
        onSelect: () => void download(backup),
      },
      {
        key: 'restore',
        label: t('backups.menu.restore'),
        icon: <History size={14} />,
        disabled: busy || running,
        title: running ? t('backups.restore.stopFirst') : undefined,
        onSelect: () => {
          setBackupCurrent(true);
          setRestoreTarget(backup);
        },
      },
      {
        key: 'delete',
        label: t('action.delete'),
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: busy,
        onSelect: () => setDeleteTarget(backup),
      },
    ];
  }

  return (
    <div className="files-workspace backups-workspace">
      <div className="files-toolbar">
        <p className="muted backups-hint">
          {running ? t('backups.hint.running') : t('backups.hint.stopped')}
        </p>
        <div className="files-actions">
          <button
            className="btn btn-icon"
            type="button"
            title={t('action.refresh')}
            aria-label={t('backups.toolbar.refreshLabel')}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} aria-hidden="true" className={loading ? 'spin' : undefined} />
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => uploadInputRef.current?.click()}
          >
            <Upload size={15} aria-hidden="true" />
            {uploading ? t('backups.toolbar.uploading') : t('backups.toolbar.upload')}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            hidden
            onChange={(e) => void upload(e)}
          />
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy || isLifecycleBusy(instance.status)}
            onClick={() => void follow(() => createBackup(instanceId), 'backups.notice.created')}
          >
            <Archive size={15} aria-hidden="true" />
            {t('backups.toolbar.create')}
          </button>
        </div>
      </div>

      {task && <TaskProgress task={task} label={t('backups.progress.label')} />}
      {listError && <p className="callout callout-danger" role="alert">{listError}</p>}
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
      {notice && <p className="callout callout-success" role="status">{notice}</p>}

      {/* Shown once the list has loaded: an instance that cannot be backed up fails there, with one message rather than two. */}
      {loaded && (
        <BackupScheduleSection
          instanceId={instanceId}
          scheduledCount={backups.filter((backup) => backup.source === 'scheduled').length}
          reloadSignal={listVersion}
        />
      )}

      {!loaded ? (
        loading ? (
          <div className="page-loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {t('backups.list.loading')}
          </div>
        ) : null
      ) : backups.length === 0 ? (
        <div className="empty-state card" role="status">
          <span className="empty-icon" aria-hidden="true"><Archive size={28} /></span>
          <h3>{t('backups.empty.title')}</h3>
          <p>{t('backups.empty.body')}</p>
        </div>
      ) : (
        <ul className={`file-list list-group${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
          {backups.map((backup) => (
            <li key={backup.id} className="file-row">
              <span className="file-main">
                <span className="file-icon is-file" aria-hidden="true">
                  <Archive size={18} />
                </span>
                <span className="file-text">
                  <span className="file-name">{fmt.dateTime(backup.createdAt)}</span>
                  <span className="file-meta">
                    {downloadingId === backup.id
                      ? t('backups.row.preparingDownload')
                      : t('backups.row.meta', {
                        source: t(SOURCE_LABEL[backup.source]),
                        size: fmt.fileSize(backup.sizeBytes),
                        files: String(backup.fileCount),
                      })}
                  </span>
                </span>
              </span>
              <div className="file-actions">
                <ActionMenu
                  label={t('backups.row.actions', { date: fmt.dateTime(backup.createdAt) })}
                  items={menuItems(backup)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={restoreTarget !== null}
        title={t('backups.restore.title')}
        description={restoreTarget ? (
          <>
            <p>
              {t('backups.restore.description', {
                date: fmt.dateTime(restoreTarget.createdAt),
                name: instance.name,
              })}
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={backupCurrent}
                onChange={(e) => setBackupCurrent(e.target.checked)}
              />
              <span>{t('backups.restore.backupCurrent')}</span>
            </label>
            {!backupCurrent && <p className="callout callout-danger">{t('backups.restore.noSafetyNet')}</p>}
          </>
        ) : ''}
        confirmLabel={t('backups.restore.confirm')}
        danger
        onConfirm={startRestore}
        onCancel={() => setRestoreTarget(null)}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('backups.delete.title')}
        description={deleteTarget ? t('backups.delete.description', { date: fmt.dateTime(deleteTarget.createdAt) }) : ''}
        confirmLabel={t('action.delete')}
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
