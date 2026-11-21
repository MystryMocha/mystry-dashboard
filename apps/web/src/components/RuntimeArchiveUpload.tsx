import { useId, useRef, useState } from 'react';
import { ExternalLink, Upload } from 'lucide-react';
import type { RuntimeArchiveInfo } from '@mystry/shared';
import { DownloadSourceHint } from './DownloadSourceSection';
import { useI18n } from '../i18n';

/**
 * Fallback install when GitHub is unreachable: the user downloads the same archive on any device (official or mirror) and uploads it,
 * and the server accepts it only by the pinned SHA-256. Normally only one line shows, "Can't reach GitHub? Install manually", and the checksum and button appear only when opened.
 */
export function RuntimeArchiveUpload({
  archive,
  busy,
  uploading,
  onUpload,
}: {
  archive: RuntimeArchiveInfo;
  busy: boolean;
  uploading: boolean;
  onUpload: (file: File) => Promise<void>;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Stay expanded while uploading, so the button state remains visible.
  const [open, setOpen] = useState(false);
  const expanded = open || uploading;
  const accept = archive.name.endsWith('.zip') ? '.zip,application/zip' : '.tar.gz,.tgz,application/gzip';
  return (
    <div className="runtime-upload">
      <p className="field-help">
        {t('multiplayer.runtime.manualPrompt')}{' '}
        <button
          type="button"
          className="link-button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {t('multiplayer.runtime.manualToggle')}
        </button>
      </p>
      {expanded && (
        <div className="runtime-upload-panel" id={panelId}>
          <p className="field-help">{t('multiplayer.runtime.manual', { file: archive.name })}</p>
          <p className="field-help runtime-upload-hash">
            {t('multiplayer.runtime.sha256Label')} <code>{archive.sha256}</code>
          </p>
          <div className="instance-actions">
            <a className="btn" href={archive.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={15} aria-hidden="true" />
              {t('multiplayer.runtime.officialLink')}
            </a>
            <button className="btn" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Upload size={15} aria-hidden="true" />
              {uploading ? t('multiplayer.runtime.uploading') : t('multiplayer.runtime.upload')}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                // After clearing, the same file can be chosen once more.
                event.target.value = '';
                if (file) void onUpload(file);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The "client not installed" block shared by the virtual LAN and frp: one line with the status and download button, and below it the download source and the manual install entry,
 * combined in one notice bar rather than split into two blocks.
 */
export function RuntimeInstallCallout({
  missing,
  installLabel,
  archive,
  busy,
  uploading,
  onInstall,
  onUpload,
}: {
  missing: string;
  installLabel: string;
  archive: RuntimeArchiveInfo | null | undefined;
  busy: boolean;
  uploading: boolean;
  onInstall: () => void;
  onUpload: (file: File) => Promise<void>;
}) {
  return (
    <div className="callout runtime-install">
      <div className="runtime-install-row">
        <p>{missing}</p>
        <button className="btn btn-primary" type="button" disabled={busy} onClick={onInstall}>
          {installLabel}
        </button>
      </div>
      <DownloadSourceHint />
      {archive && <RuntimeArchiveUpload archive={archive} busy={busy} uploading={uploading} onUpload={onUpload} />}
    </div>
  );
}
