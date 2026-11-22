import { useEffect, useId, useRef, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { parseLaunchTarget, type ExistingServerSourceInfo } from '@mystry/shared';
import { copyText } from '../clipboard';
import { coreDisplayName } from './CoreIcon';
import { useI18n } from '../i18n';

type Props = {
  /** Path of the imports folder on the panel's computer; null before it is read. */
  importDir: string | null;
  sources: ExistingServerSourceInfo[];
  sourceId: string;
  loading: boolean;
  /** Description when reading imports fails, already translated into the UI language. */
  error: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

/**
 * "Copy from the imports folder": first tells the user where imports is on the panel's computer and how to put things there, then lists the servers inside to choose from.
 * The path is only for display and copying; the panel accepts no path submitted by the client.
 */
export function ImportsSourceSection({ importDir, sources, sourceId, loading, error, busy, onSelect, onRefresh }: Props) {
  const { t, tm } = useI18n();
  const listTitleId = useId();
  const groupName = useId();
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  async function copyPath(path: string) {
    const copied = await copyText(path);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(copied ? t('import.directory.copied') : t('import.directory.copyFailed'));
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  }

  /** Description under each row: the recognized core and version, the launch jar, and whether there is a user_jvm_args.txt; the reason is written when it cannot be imported. */
  function sourceDetail(source: ExistingServerSourceInfo): string {
    if (!source.ready) return tm(source.errorI18n, source.error ?? '');
    if (!source.launchTarget) return t('import.directory.source.pendingCheck');
    const core = coreDisplayName(source.coreType, t);
    const server = source.mcVersion
      ? t('import.directory.source.server', { core, version: source.mcVersion })
      : source.coreType === 'custom' ? core : t('import.directory.source.serverNoVersion', { core });
    // The Forge / NeoForge args file path is long, and the core and version already say what it is, so the file name is written only for a plain jar.
    const target = parseLaunchTarget(source.launchTarget);
    const detail = target.kind === 'jar' ? `${server} · ${target.path}` : server;
    return source.detectedJvmConfig
      ? t('import.directory.source.withJvmFile', { detail, file: source.detectedJvmConfig.source })
      : detail;
  }

  return (
    <>
      <section className="form-section">
        <h2 className="form-section-title">{t('import.directory.title')}</h2>
        <div className="card form-card">
          <p className="field-help import-zip-lead">{t('import.directory.lead')}</p>
          {importDir ? (
            <div className="import-dir-row">
              <code className="direct-address import-dir-path">{importDir}</code>
              <button className="btn btn-sm" type="button" onClick={() => void copyPath(importDir)}>
                <Copy size={13} aria-hidden="true" />
                {t('import.directory.copyPath')}
              </button>
            </div>
          ) : null}
          <p role="status" aria-live="polite" className={notice ? 'field-help' : 'visually-hidden'}>{notice}</p>
          <ol className="direct-checklist">
            <li>{t('import.directory.steps.stop')}</li>
            <li>{t('import.directory.steps.copy')}</li>
          </ol>
          <p className="field-help">{t('import.directory.readOnly')}</p>
          <p className="field-help">{t('import.directory.transferHint')}</p>
        </div>
      </section>

      <section className="form-section">
        <div className="import-source-head">
          <h2 className="form-section-title" id={listTitleId}>{t('import.directory.list.title')}</h2>
          <button className="btn btn-sm" type="button" disabled={busy || loading} onClick={onRefresh}>
            <RefreshCw size={13} aria-hidden="true" className={loading ? 'spin' : undefined} />
            {loading ? t('import.directory.refreshing') : t('action.refresh')}
          </button>
        </div>
        <div className="card form-card">
          {sources.length > 0 ? (
            <div className="list-group import-source-list" role="radiogroup" aria-labelledby={listTitleId}>
              {sources.map((source, index) => {
                const disabled = busy || !source.ready;
                // Folder names may contain spaces and cannot be put into an id reference list, so an index is used.
                const titleId = `${groupName}-${index}-title`;
                const detailId = `${groupName}-${index}-detail`;
                return (
                  <label key={source.id} className={`list-row import-source-option${source.ready ? '' : ' is-unavailable'}`}>
                    <input
                      type="radio"
                      name={groupName}
                      value={source.id}
                      checked={sourceId === source.id}
                      disabled={disabled}
                      aria-labelledby={titleId}
                      aria-describedby={detailId}
                      onChange={() => onSelect(source.id)}
                    />
                    <span className="list-row-text">
                      <span className="list-row-title" id={titleId}>{source.id}</span>
                      <span className={source.ready ? 'list-row-desc' : 'list-row-desc import-source-reason'} id={detailId}>
                        {sourceDetail(source)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : loading ? (
            <p className="field-help" role="status">{t('import.directory.source.loading')}</p>
          ) : error ? null : (
            <p className="field-help">{t('import.directory.empty')}</p>
          )}
          {error ? <p className="error">{t('import.directory.loadError', { error })}</p> : null}
        </div>
      </section>
    </>
  );
}
