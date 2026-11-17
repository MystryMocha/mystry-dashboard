import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Users, X } from 'lucide-react';
import { useI18n } from '../i18n';

const DISMISSED_KEY = 'mystry_ready_hint_dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // 隐私模式等读不到本地存储时照常显示提示。
    return false;
  }
}

/**
 * 服务端完成启动后显示在控制台上方的一行：告诉用户可以进服了，并指向「联机」。
 * 点过「不再提示」后在这个浏览器里不再出现。
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
      // 存不下时只在本次打开期间隐藏。
    }
  }

  // 一行提示条而不是大块提示框：控制台才是这一页的主体，提示只占它上方一行，窄屏时自动折行。
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
