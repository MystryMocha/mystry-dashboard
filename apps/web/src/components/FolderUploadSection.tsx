import { useRef, useState } from 'react';
import { FolderCheck, FolderUp } from 'lucide-react';
import { parseLaunchTarget, type FolderUploadInfo } from '@mystry/shared';
import {
  selectedFolderFromDrop,
  selectedFolderFromFileList,
  type FolderUploadProgress,
  type SelectedFolder,
} from '../folder-upload';
import { useI18n } from '../i18n';
import { ProgressBar } from './TaskProgress';

/**
 * The source card for "Upload Folder" on the import page: pick a folder (button or drag in) → upload progress → the result after upload and check.
 * Upload and confirming the import are driven by the import page's submit button; this only handles display and selection.
 */
export function FolderUploadSection({
  folder,
  upload,
  progress,
  restoring,
  busy,
  onChoose,
  onError,
  onCancelUpload,
  onDiscard,
  onUseImports,
}: {
  folder: SelectedFolder | null;
  upload: FolderUploadInfo | null;
  /** Progress while uploading; null when not uploading. */
  progress: FolderUploadProgress | null;
  restoring: boolean;
  busy: boolean;
  onChoose: (folder: SelectedFolder) => void;
  onError: (message: string) => void;
  onCancelUpload: () => void;
  onDiscard: () => void;
  /** Switches to "Copy from the imports folder"; not passed when the mode switcher already has that item, and the link is not shown. */
  onUseImports?: () => void;
}) {
  const { t, tm, rich, fmt } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const disabled = busy || restoring;
  const check = upload?.state === 'ready' ? upload.check : undefined;
  const launchTarget = check?.launchTarget ? parseLaunchTarget(check.launchTarget) : null;

  function chooseFrom(next: SelectedFolder | 'empty' | null, notFolderKey: 'import.folder.empty' | 'import.folder.notFolder') {
    if (next === 'empty') onError(t('import.folder.empty'));
    else if (next === null) onError(t(notFolderKey));
    else onChoose(next);
  }

  // Once all files are sent and the panel is checking, the progress bar stays at the end and the text changes to "Checking".
  const allSent = progress !== null && progress.files === progress.totalFiles;
  const percent = progress === null ? 0
    : progress.totalBytes > 0 ? (progress.bytes / progress.totalBytes) * 100
      : (progress.files / Math.max(progress.totalFiles, 1)) * 100;

  return (
    <section className="form-section">
      <h2 className="form-section-title">{t('import.folder.title')}</h2>
      <div className="card form-card">
        <p className="field-help import-zip-lead">{t('import.folder.lead')}</p>
        {restoring ? (
          <p className="field-help" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" /> {t('import.folder.restoring')}
          </p>
        ) : null}

        {upload?.state === 'ready' ? (
          <div className={`callout ${check?.ready ? 'callout-success' : 'callout-warning'} import-preview-card`} aria-live="polite">
            <FolderCheck size={18} aria-hidden="true" className="callout-icon" />
            <div>
              <strong>{t('import.folder.uploaded.title')}</strong>
              <p>
                {t('import.folder.uploaded.info', {
                  name: upload.folderName,
                  count: fmt.number(upload.fileCount),
                  size: fmt.fileSize(upload.totalBytes),
                })}
              </p>
              {launchTarget && launchTarget.kind !== 'modloader' ? (
                <p>{rich('import.directory.launchTarget', { code: (chunk) => <code>{chunk}</code> }, { target: launchTarget.path })}</p>
              ) : null}
              {check?.error ? <p>{tm(check.errorI18n, check.error)}</p> : null}
              <p>{t('import.folder.uploaded.expires', { time: fmt.dateTime(upload.expiresAt) })}</p>
            </div>
            <button className="btn btn-sm" type="button" disabled={busy} onClick={onDiscard}>
              {t('import.folder.uploaded.cancel')}
            </button>
          </div>
        ) : progress ? (
          <ProgressBar
            label={t('import.folder.progress.label')}
            progress={percent}
            text={allSent
              ? t('import.folder.progress.checking')
              : t(progress.waiting ? 'import.folder.progress.waiting' : 'import.folder.progress.text', {
                name: folder?.name ?? '',
                done: fmt.number(progress.files),
                total: fmt.number(progress.totalFiles),
              })}
            action={(
              <button className="btn btn-sm btn-plain" type="button" onClick={onCancelUpload}>
                {t('import.folder.cancelUpload')}
              </button>
            )}
          />
        ) : (
          <div className="field">
            <label htmlFor="import-folder-input">{t('import.folder.label')}</label>
            <div
              className={`drop-zone${isDragging ? ' is-dragging' : ''}${folder ? ' has-file' : ''}${disabled ? ' is-disabled' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (!disabled) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (disabled) return;
                void selectedFolderFromDrop(e.dataTransfer.items)
                  .then((next) => chooseFrom(next, 'import.folder.notFolder'))
                  .catch(() => onError(t('import.folder.notFolder')));
              }}
            >
              <span className="drop-zone-icon" aria-hidden="true"><FolderUp size={28} /></span>
              <div className="drop-zone-title">{folder ? folder.name : t('import.folder.drop.title')}</div>
              {folder ? (
                <span className="drop-zone-hint">
                  {t('import.folder.drop.summary', { count: fmt.number(folder.files.length), size: fmt.fileSize(folder.totalBytes) })}
                </span>
              ) : null}
              <button className="btn" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
                {t('import.folder.choose')}
              </button>
            </div>
            <input
              id="import-folder-input"
              ref={(node) => {
                inputRef.current = node;
                // webkitdirectory is not in React's attribute types and is set on the element directly; it makes the file picker choose a whole folder.
                node?.setAttribute('webkitdirectory', '');
              }}
              type="file"
              multiple
              hidden
              disabled={disabled}
              onChange={(e) => {
                const files = e.target.files ? [...e.target.files] : [];
                e.target.value = '';
                chooseFrom(files.length === 0 ? 'empty' : selectedFolderFromFileList(files), 'import.folder.empty');
              }}
            />
          </div>
        )}
        {onUseImports && !upload && !progress && !restoring ? (
          <p className="field-help">
            {t('import.folder.importsHint')}{' '}
            <button type="button" className="link-button" disabled={busy} onClick={onUseImports}>
              {t('import.folder.useImports')}
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
