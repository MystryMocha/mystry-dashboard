import { useEffect, useId, useState } from 'react';
import { SESSION_DURATION_ENUM, type SessionDuration } from '@mystry/shared';
import { getSessionDuration, saveSessionDuration } from '../api';
import { errorMessage } from '../errors';
import { useI18n, type MessageKey } from '../i18n';

const DURATION_LABELS: Record<SessionDuration, MessageKey> = {
  '2h': 'nodes.session.option.2h',
  '12h': 'nodes.session.option.12h',
  '1d': 'nodes.session.option.1d',
  '7d': 'nodes.session.option.7d',
  '30d': 'nodes.session.option.30d',
  never: 'nodes.session.option.never',
};

function isSessionDuration(value: unknown): value is SessionDuration {
  return (SESSION_DURATION_ENUM as readonly unknown[]).includes(value);
}

/** 本机环境页的登录有效期设置：选了就保存，这台设备随即换上按新有效期签发的令牌。 */
export function SessionDurationSection() {
  const { t } = useI18n();
  const titleId = useId();
  const selectId = useId();
  const helpId = useId();
  // null 表示还在读取（或读到的值认不出），选择框暂不可用。
  const [duration, setDuration] = useState<SessionDuration | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
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
  }, []);

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
    <section className="form-section session-duration-section" aria-labelledby={titleId}>
      <h2 className="form-section-title" id={titleId}>{t('nodes.session.title')}</h2>
      <div className="card form-card">
        <p className="section-lead">{t('nodes.session.lead')}</p>
        {loadError && <p className="error" role="alert">{loadError}</p>}
        <div className="field session-duration-field">
          <label htmlFor={selectId}>{t('nodes.session.label')}</label>
          <select
            id={selectId}
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
          <div className="session-duration-help" id={helpId}>
            <p className="field-help">{t('nodes.session.help')}</p>
            {duration === 'never' && <p className="field-help">{t('nodes.session.never.desc')}</p>}
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {/* 状态区一直保留，读屏软件才会播报；空的时候隐藏，不占卡片间距。 */}
        <p className={saved ? 'field-help' : 'visually-hidden'} role="status">
          {saved ? t('nodes.session.saved') : ''}
        </p>
      </div>
    </section>
  );
}
