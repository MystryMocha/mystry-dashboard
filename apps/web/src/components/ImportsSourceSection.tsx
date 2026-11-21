import { useEffect, useId, useRef, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { parseLaunchTarget, type ExistingServerSourceInfo } from '@mystry/shared';
import { copyText } from '../clipboard';
import { coreDisplayName } from './CoreIcon';
import { useI18n } from '../i18n';

type Props = {
  /** imports 文件夹在面板电脑上的路径；还没读到时为 null。 */
  importDir: string | null;
  sources: ExistingServerSourceInfo[];
  sourceId: string;
  loading: boolean;
  /** 读取 imports 失败时的说明，已按界面语言翻译。 */
  error: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

/**
 * 「从 imports 文件夹复制」：先告诉用户 imports 在面板电脑上的哪里、怎么放，再列出里面的服务端供选择。
 * 路径只用来显示和复制，面板不接收任何客户端提交的路径（D-015、D-041）。
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

  /** 每一行下方的说明：识别出的核心和版本、启动 jar、有没有 user_jvm_args.txt；不能导入时写原因。 */
  function sourceDetail(source: ExistingServerSourceInfo): string {
    if (!source.ready) return tm(source.errorI18n, source.error ?? '');
    if (!source.launchTarget) return t('import.directory.source.pendingCheck');
    const core = coreDisplayName(source.coreType, t);
    const server = source.mcVersion
      ? t('import.directory.source.server', { core, version: source.mcVersion })
      : source.coreType === 'custom' ? core : t('import.directory.source.serverNoVersion', { core });
    // Forge / NeoForge 的参数文件路径很长，核心和版本已经说明了是什么，这里只给普通 jar 写文件名。
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
                // 文件夹名里可能有空格，不能拼进 id 引用列表，用序号。
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
