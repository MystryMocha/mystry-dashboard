import { useEffect, useId, useState } from 'react';
import type { DownloadSource } from '@mystry/shared';
import { getDownloadSource, saveDownloadSource } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

const SOURCE_LABELS: Record<DownloadSource, MessageKey> = {
  official: 'nodes.downloadSource.official',
  china: 'nodes.downloadSource.china',
};

const SOURCES = Object.keys(SOURCE_LABELS) as DownloadSource[];

interface PickerProps {
  /** 当前来源；null 表示还在读取，按钮暂不可点。 */
  source: DownloadSource | null;
  onSaved: (source: DownloadSource) => void;
  labelledBy: string;
}

/** 来源切换控件：分段按钮、说明、错误和保存状态。本机环境页和下载入口旁的提示共用。 */
function DownloadSourcePicker({ source, onSaved, labelledBy }: PickerProps) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function choose(next: DownloadSource) {
    if (next === source || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      onSaved((await saveDownloadSource(next)).source);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="segmented" role="group" aria-labelledby={labelledBy}>
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
    </>
  );
}

/** 读取当前下载来源；失败时交给调用方决定是否提示。 */
function useDownloadSource(onError?: (err: unknown) => void) {
  const [source, setSource] = useState<DownloadSource | null>(null);
  useEffect(() => {
    let active = true;
    getDownloadSource()
      .then((setting) => {
        if (active) setSource(setting.source);
      })
      .catch((err: unknown) => {
        if (active) onError?.(err);
      });
    return () => {
      active = false;
    };
    // 只在挂载时读取一次
  }, []);
  return [source, setSource] as const;
}

/** 本机环境页的下载来源设置；保存后立即生效，不需要重启面板。 */
export function DownloadSourceSection() {
  const { t } = useI18n();
  const titleId = useId();
  const [loadError, setLoadError] = useState('');
  const [source, setSource] = useDownloadSource((err) => setLoadError(errorMessage(err)));

  return (
    <section className="form-section download-source-section" aria-labelledby={titleId}>
      <h2 className="form-section-title" id={titleId}>{t('nodes.downloadSource.title')}</h2>
      <div className="card form-card">
        <p className="section-lead">{t('nodes.downloadSource.lead')}</p>
        {loadError && <p className="error" role="alert">{loadError}</p>}
        <DownloadSourcePicker source={source} onSaved={setSource} labelledBy={titleId} />
      </div>
    </section>
  );
}

/**
 * 下载入口旁的一行提示，显示当前来源，点「更改」就地展开切换控件，
 * 不跳离当前页面（部署表单等已填内容不会丢）。读取失败时不显示。
 */
export function DownloadSourceHint() {
  const { t } = useI18n();
  const hintId = useId();
  const panelId = useId();
  const [source, setSource] = useDownloadSource();
  const [editing, setEditing] = useState(false);

  const label = source && SOURCE_LABELS[source];
  if (!label) return null;
  return (
    <div className="download-source-hint">
      <p className="field-help" id={hintId}>
        {t('nodes.downloadSource.hint', { source: t(label) })}{' '}
        <button
          type="button"
          className="link-button"
          aria-expanded={editing}
          aria-controls={panelId}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? t('nodes.downloadSource.hint.done') : t('nodes.downloadSource.hint.change')}
        </button>
      </p>
      {editing && (
        <div className="download-source-hint-panel" id={panelId}>
          <DownloadSourcePicker source={source} onSaved={setSource} labelledBy={hintId} />
        </div>
      )}
    </div>
  );
}
