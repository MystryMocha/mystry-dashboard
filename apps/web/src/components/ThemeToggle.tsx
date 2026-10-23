import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, SunMoon } from 'lucide-react';
import { usePopover } from '../hooks/usePopover';
import { useI18n } from '../i18n';
import {
  ACCENTS,
  ACCENT_LABEL_KEYS,
  APPEARANCES,
  APPEARANCE_LABEL_KEYS,
  getAccent,
  getAppearance,
  setAccent,
  setAppearance,
  THEME_CHANGE_EVENT,
  type Accent,
  type Appearance,
} from '../theme';

type Placement = 'topbar' | 'login';

const POPOVER_WIDTH = 300;

/**
 * 外观选择器：参照 macOS「外观」设置，上排选择自动/浅色/深色，下排选择强调色。
 * 两组都是原生单选框，方向键切换由浏览器提供；面板挂到 body 并用 fixed 定位，避免被裁切或错位。
 */
export function ThemeToggle({ placement = 'topbar' }: { placement?: Placement }) {
  const { t } = useI18n();
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const popover = usePopover(POPOVER_WIDTH);
  const groupName = useId();

  useEffect(() => {
    const onChange = () => {
      setAppearanceState(getAppearance());
      setAccentState(getAccent());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  const accentLabel = t(ACCENT_LABEL_KEYS[accent]);

  return (
    <div className={`appearance-picker appearance-picker-${placement}`} ref={popover.rootRef}>
      <button
        ref={popover.toggleRef}
        type="button"
        className="toolbar-button"
        aria-label={t('appearance.button', { appearance: t(APPEARANCE_LABEL_KEYS[appearance]), accent: accentLabel })}
        title={t('appearance.title')}
        aria-expanded={popover.open}
        aria-haspopup="dialog"
        aria-controls={popover.panelId}
        onClick={popover.toggle}
      >
        <SunMoon size={18} aria-hidden="true" />
      </button>

      {/* 工具栏的毛玻璃（backdrop-filter）会成为 fixed 定位的包含块，面板必须挂到 body。 */}
      {popover.open && createPortal(
        <div
          id={popover.panelId}
          ref={popover.panelRef}
          className="popover appearance-popover"
          style={popover.panelStyle}
          role="dialog"
          aria-label={t('appearance.title')}
        >
          <fieldset className="appearance-group">
            <legend className="popover-title">{t('appearance.title')}</legend>
            <div className="appearance-options">
              {APPEARANCES.map((id) => (
                <label key={id} className="appearance-option">
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={`${groupName}-appearance`}
                    value={id}
                    checked={appearance === id}
                    onChange={() => setAppearance(id)}
                  />
                  <span className={`appearance-thumb appearance-thumb-${id}`} aria-hidden="true">
                    <span className="appearance-thumb-bar" />
                    <span className="appearance-thumb-card" />
                  </span>
                  <span className="appearance-option-label">{t(APPEARANCE_LABEL_KEYS[id])}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="appearance-group">
            <legend className="popover-title">{t('appearance.accent')}</legend>
            <div className="accent-options">
              {ACCENTS.map((id) => (
                <label key={id} className="accent-option" title={t(ACCENT_LABEL_KEYS[id])}>
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={`${groupName}-accent`}
                    value={id}
                    checked={accent === id}
                    aria-label={t(ACCENT_LABEL_KEYS[id])}
                    onChange={() => setAccent(id)}
                  />
                  <span className={`accent-swatch accent-swatch-${id}`} aria-hidden="true">
                    {accent === id && <Check size={12} strokeWidth={3} />}
                  </span>
                </label>
              ))}
            </div>
            <p className="popover-footnote">{accentLabel}</p>
          </fieldset>
        </div>,
        document.body,
      )}
    </div>
  );
}
