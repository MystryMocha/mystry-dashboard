import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Users, X } from 'lucide-react';
import { useI18n } from '../i18n';

const DISMISSED_KEY = 'mystry_ready_hint_dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // When local storage cannot be read, such as in private mode, the hint is shown as usual.
    return false;
  }
}

/**
 * A line shown above the console once the server finishes starting: tells the user the server can be joined, and points to "Multiplayer".
 * After "Don't show again" is clicked it no longer appears in this browser.
 */
export function ReadyHint({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // When it cannot be stored it is hidden only for this open.
    }
  }

  // A one-line hint bar rather than a large notice box: the console is the main content of this page, and the hint takes only one line above it, wrapping automatically on narrow screens.
  return (
    <div className="ready-strip" role="status">
      <CircleCheck size={16} aria-hidden="true" className="ready-strip-icon" />
      <p className="ready-strip-text">
        <strong>{t('instance.ready.title')}</strong> {t('instance.ready.body')}
      </p>
      <Link className="btn btn-sm btn-tinted" to={`/multiplayer?instance=${encodeURIComponent(instanceId)}`}>
        <Users size={14} aria-hidden="true" />
        {t('instance.ready.action')}
      </Link>
      <button
        className="btn btn-sm btn-icon btn-plain"
        type="button"
        aria-label={t('instance.ready.dismiss')}
        title={t('instance.ready.dismiss')}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
