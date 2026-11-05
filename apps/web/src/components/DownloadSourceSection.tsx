import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DownloadSource } from '@mystry/shared';
import { getDownloadSource, saveDownloadSource } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

const SOURCE_LABELS: Record<DownloadSource, MessageKey> = {
  official: 'nodes.downloadSource.official',
  china: 'nodes.downloadSource.china',
};

const SOURCES = Object.keys(SOURCE_LABELS) as DownloadSource[];

/** 本机环境页的下载来源设置；保存后立即生效，不需要重启面板。 */
export function DownloadSourceSection() {
  const { t } = useI18n();
  const titleId = useId();
  const [source, setSource] = useState<DownloadSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    getDownloadSource()
      .then((setting) => {
        if (active) setSource(setting.source);
      })
      .catch((err: unknown) => {
        if (active) setError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  async function choose(next: DownloadSource) {
    if (next === source || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      setSource((await saveDownloadSource(next)).source);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="form-section download-source-section" aria-labelledby={titleId}>
      <h2 className="form-section-title" id={titleId}>{t('nodes.downloadSource.title')}</h2>
      <div className="card form-card">
        <p className="section-lead">{t('nodes.downloadSource.lead')}</p>
        <div className="segmented" role="group" aria-labelledby={titleId}>
          {SOURCES.map((item) => (
            <button
              key={item}
              type="button"
              className={`segmented-item${source === item ? ' active' : ''}`}
              aria-pressed={source === item}
              disabled={source === null || saving}
              onClick={() => void choose(item)}
            >
              {t(SOURCE_LABELS[item])}
            </button>
          ))}
        </div>
        {source === 'official' && <p className="field-help">{t('nodes.downloadSource.official.desc')}</p>}
        {source === 'china' && (
          <>
            <p className="field-help">{t('nodes.downloadSource.china.desc')}</p>
            <p className="field-help">{t('nodes.downloadSource.china.limits')}</p>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {/* 状态区一直保留，读屏软件才会播报；空的时候隐藏，不占卡片间距。 */}
        <p className={saved ? 'field-help' : 'visually-hidden'} role="status">
          {saved ? t('nodes.downloadSource.saved') : ''}
        </p>
      </div>
    </section>
  );
}

/** 下载入口旁的一行提示，让用户知道当前用的来源并能跳去修改；读取失败时不显示。 */
export function DownloadSourceHint() {
  const { t } = useI18n();
  const [source, setSource] = useState<DownloadSource | null>(null);

  useEffect(() => {
    let active = true;
    getDownloadSource()
      .then((setting) => {
        if (active) setSource(setting.source);
      })
      .catch(() => {
        /* 只是提示信息，读取失败不打扰下载流程 */
      });
    return () => {
      active = false;
    };
  }, []);

  const label = source && SOURCE_LABELS[source];
  if (!label) return null;
  return (
    <p className="field-help">
      {t('nodes.downloadSource.hint', { source: t(label) })}{' '}
      <Link className="link" to="/nodes">{t('nodes.downloadSource.hint.change')}</Link>
    </p>
  );
}
