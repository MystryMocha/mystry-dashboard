import { useRef } from 'react';
import { ExternalLink, Upload } from 'lucide-react';
import type { RuntimeArchiveInfo } from '@mystry/shared';
import { useI18n } from '../i18n';

/**
 * 连不上 GitHub 时的备用安装：用户在任意设备（官方或镜像）下载同名压缩包再上传，
 * 服务端只按钉死的 SHA-256 接受。
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
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = archive.name.endsWith('.zip') ? '.zip,application/zip' : '.tar.gz,.tgz,application/gzip';
  return (
    <div className="runtime-upload">
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
  );
}
