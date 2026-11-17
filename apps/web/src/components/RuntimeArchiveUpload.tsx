import { useId, useRef, useState } from 'react';
import { ExternalLink, Upload } from 'lucide-react';
import type { RuntimeArchiveInfo } from '@mystry/shared';
import { DownloadSourceHint } from './DownloadSourceSection';
import { useI18n } from '../i18n';

/**
 * 连不上 GitHub 时的备用安装：用户在任意设备（官方或镜像）下载同名压缩包再上传，
 * 服务端只按钉死的 SHA-256 接受。平时只露一行「连不上 GitHub？手动安装」，点开才显示校验值和按钮。
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
  // 上传中保持展开，免得按钮状态看不到。
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
                // 清空后同一个文件可以再选一次。
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
 * 虚拟局域网和 frp 共用的「客户端未安装」区块：一行状态和下载按钮，下面是下载来源和手动安装入口，
 * 合在同一个提示条里，不再拆成两块。
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
