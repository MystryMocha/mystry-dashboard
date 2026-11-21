import { useEffect, useId, useState } from 'react';
import type { DownloadSource } from '@mystry/shared';
import { getDownloadSource, saveDownloadSource } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

const SOURCE_LABELS: Record<DownloadSource, MessageKey> = {
  official: 'settings.downloadSource.official',
  china: 'settings.downloadSource.china',
};

const SOURCES = Object.keys(SOURCE_LABELS) as DownloadSource[];

interface SourcePicker {
  /** 当前来源；null 表示还在读取，按钮暂不可点。 */
  source: DownloadSource | null;
  saving: boolean;
  error: string;
  saved: boolean;
  choose: (next: DownloadSource) => Promise<void>;
}

/** 切换来源的保存状态。按钮和说明分开摆放时（设置页一左一右），两边共用这一份。 */
function useSourcePicker(source: DownloadSource | null, onSaved: (source: DownloadSource) => void): SourcePicker {
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

  return { source, saving, error, saved, choose };
}

/** 来源的分段按钮。 */
function SourceButtons({ picker, labelledBy }: { picker: SourcePicker; labelledBy: string }) {
  const { t } = useI18n();
  return (
    <div className="segmented" role="group" aria-labelledby={labelledBy}>
      {SOURCES.map((item) => (
        <button
          key={item}
          type="button"
          className={`segmented-item${picker.source === item ? ' active' : ''}`}
          aria-pressed={picker.source === item}
          disabled={picker.source === null || picker.saving}
          onClick={() => void picker.choose(item)}
        >
          {t(SOURCE_LABELS[item])}
        </button>
      ))}
    </div>
  );
}

/** 当前来源的说明、保存失败原因和保存状态。 */
function SourceNotes({ picker, className }: { picker: SourcePicker; className: string }) {
  const { t } = useI18n();
  return (
    <>
      {picker.source === 'official' && <p className={className}>{t('settings.downloadSource.official.desc')}</p>}
      {picker.source === 'china' && (
        <>
          <p className={className}>{t('settings.downloadSource.china.desc')}</p>
          <p className={className}>{t('settings.downloadSource.china.limits')}</p>
        </>
      )}
      {picker.error && <p className="error" role="alert">{picker.error}</p>}
      {/* 状态区一直保留，读屏软件才会播报；空的时候隐藏，不占间距。 */}
      <p className={picker.saved ? className : 'visually-hidden'} role="status">
        {picker.saved ? t('settings.downloadSource.saved') : ''}
      </p>
    </>
  );
}

/** 按钮和说明上下排在一起的切换控件，下载入口旁的提示展开后用；收起再展开时保存状态重新开始。 */
function InlineSourcePicker({
  source,
  onSaved,
  labelledBy,
}: {
  source: DownloadSource | null;
  onSaved: (source: DownloadSource) => void;
  labelledBy: string;
}) {
  const picker = useSourcePicker(source, onSaved);
  return (
    <>
      <SourceButtons picker={picker} labelledBy={labelledBy} />
      <SourceNotes picker={picker} className="field-help" />
    </>
  );
}

/** 读取当前下载来源；失败时交给调用方决定是否提示，调用第三个返回值可以重新读取。 */
function useDownloadSource(onError?: (err: unknown) => void) {
  const [source, setSource] = useState<DownloadSource | null>(null);
  const [attempt, setAttempt] = useState(0);
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
    // 挂载时读取一次，之后只在重试时再读
  }, [attempt]);
  return [source, setSource, () => setAttempt((count) => count + 1)] as const;
}

/** 面板设置页的下载来源一行；保存后立即生效，不需要重启面板。 */
export function DownloadSourceRow() {
  const { t } = useI18n();
  const titleId = useId();
  const [loadError, setLoadError] = useState('');
  const [source, setSource, reload] = useDownloadSource((err) => setLoadError(errorMessage(err)));
  const picker = useSourcePicker(source, setSource);

  return (
    <div className="list-row settings-row">
      <div className="list-row-text">
        <span className="list-row-title" id={titleId}>{t('settings.downloadSource.title')}</span>
        <p className="list-row-desc">{t('settings.downloadSource.lead')}</p>
        {loadError && (
          <div className="settings-load-error">
            <p className="error" role="alert">{loadError}</p>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setLoadError('');
                reload();
              }}
            >
              {t('action.retry')}
            </button>
          </div>
        )}
        <SourceNotes picker={picker} className="list-row-desc" />
      </div>
      <div className="list-row-control">
        <SourceButtons picker={picker} labelledBy={titleId} />
      </div>
    </div>
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
        {t('settings.downloadSource.hint', { source: t(label) })}{' '}
        <button
          type="button"
          className="link-button"
          aria-expanded={editing}
          aria-controls={panelId}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? t('settings.downloadSource.hint.done') : t('settings.downloadSource.hint.change')}
        </button>
      </p>
      {editing && (
        <div className="download-source-hint-panel" id={panelId}>
          <InlineSourcePicker source={source} onSaved={setSource} labelledBy={hintId} />
        </div>
      )}
    </div>
  );
}
