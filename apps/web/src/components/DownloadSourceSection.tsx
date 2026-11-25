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
  /** The current source; null means still loading, and the buttons are not clickable for now. */
  source: DownloadSource | null;
  saving: boolean;
  error: string;
  saved: boolean;
  choose: (next: DownloadSource) => Promise<void>;
}

/** Save state of switching the source. When the buttons and the description are placed apart (left and right on the settings page), both sides share this one. */
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

/** Description of the current source, the save failure reason and the save state. */
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
      {/* The status area is always kept so screen readers announce it; it is hidden when empty and takes no spacing. */}
      <p className={picker.saved ? className : 'visually-hidden'} role="status">
        {picker.saved ? t('settings.downloadSource.saved') : ''}
      </p>
    </>
  );
}

/** A switch control with the buttons and description stacked together, used when the hint beside a download entry is expanded; the save state starts over when collapsed and expanded again. */
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

/** Reads the current download source; on failure the caller decides whether to show a message, and calling the third return value reads again. */
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
    // Read once on mount, then again only on retry
  }, [attempt]);
  return [source, setSource, () => setAttempt((count) => count + 1)] as const;
}

/** The download source row on the panel settings page; it takes effect right after saving, with no panel restart needed. */
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
 * A one-line hint beside a download entry showing the current source; clicking "Change" expands the switch control in place,
 * without leaving the current page (content already filled in, such as the deploy form, is not lost). Not shown when reading fails.
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
