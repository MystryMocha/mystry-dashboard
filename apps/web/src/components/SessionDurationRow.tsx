import { useEffect, useId, useState } from 'react';
import { SESSION_DURATION_ENUM, type SessionDuration } from '@mystry/shared';
import { getSessionDuration, saveSessionDuration } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

const DURATION_LABELS: Record<SessionDuration, MessageKey> = {
  '2h': 'settings.session.option.2h',
  '12h': 'settings.session.option.12h',
  '1d': 'settings.session.option.1d',
  '7d': 'settings.session.option.7d',
  '30d': 'settings.session.option.30d',
  never: 'settings.session.option.never',
};

function isSessionDuration(value: unknown): value is SessionDuration {
  return (SESSION_DURATION_ENUM as readonly unknown[]).includes(value);
}

/** The session duration row on the panel settings page: saved as soon as chosen, and this device then switches to a token issued with the new duration. */
export function SessionDurationRow() {
  const { t } = useI18n();
  const selectId = useId();
  const helpId = useId();
  // null means still loading (or the value read is unrecognized), and the select is unavailable for now.
  const [duration, setDuration] = useState<SessionDuration | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Incremented on each "Retry", to read again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError('');
    getSessionDuration()
      .then((setting) => {
        if (active && isSessionDuration(setting?.duration)) setDuration(setting.duration);
      })
      .catch((err: unknown) => {
        if (active) setLoadError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  async function choose(next: SessionDuration) {
    if (next === duration || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      setDuration((await saveSessionDuration(next)).duration);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="list-row settings-row">
      <div className="list-row-text">
        <label className="list-row-title" htmlFor={selectId}>{t('settings.session.label')}</label>
        <div className="settings-row-notes" id={helpId}>
          <p className="list-row-desc">{t('settings.session.lead')}</p>
          <p className="list-row-desc">{t('settings.session.help')}</p>
          {duration === 'never' && <p className="list-row-desc">{t('settings.session.never.desc')}</p>}
        </div>
        {loadError && (
          <div className="settings-load-error">
            <p className="error" role="alert">{loadError}</p>
            <button type="button" className="link-button" onClick={() => setAttempt((count) => count + 1)}>
              {t('action.retry')}
            </button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {/* The status area is always kept so screen readers announce it; it is hidden when empty and takes no inline spacing. */}
        <p className={saved ? 'list-row-desc' : 'visually-hidden'} role="status">
          {saved ? t('settings.session.saved') : ''}
        </p>
      </div>
      <div className="list-row-control settings-row-select">
        <select
          id={selectId}
          className="input"
          value={duration ?? ''}
          disabled={duration === null || saving}
          aria-describedby={helpId}
          onChange={(event) => {
            const next = event.target.value;
            if (isSessionDuration(next)) void choose(next);
          }}
        >
          {duration === null && <option value="" />}
          {SESSION_DURATION_ENUM.map((item) => (
            <option key={item} value={item}>{t(DURATION_LABELS[item])}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
