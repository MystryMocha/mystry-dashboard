import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { SunMoon } from 'lucide-react';
import { usePopover } from '../hooks/usePopover';
import { useI18n } from '../i18n';
import {
  APPEARANCES,
  APPEARANCE_LABEL_KEYS,
  getAppearance,
  setAppearance,
  THEME_CHANGE_EVENT,
  type Appearance,
} from '../theme';

type Placement = 'topbar' | 'login';

const POPOVER_WIDTH = 300;

/**
 * Appearance picker: modeled on the macOS "Appearance" setting, choosing auto/light/dark; the accent color is fixed to ink purple and not selectable.
 * The options are native radios, with arrow-key switching provided by the browser; the panel is attached to body and fixed-positioned, so it is not clipped or misplaced.
 */
export function ThemeToggle({ placement = 'topbar' }: { placement?: Placement }) {
  const { t } = useI18n();
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);
  const popover = usePopover(POPOVER_WIDTH);
  const groupName = useId();

  useEffect(() => {
    const onChange = () => {
      setAppearanceState(getAppearance());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  return (
    <div className={`appearance-picker appearance-picker-${placement}`} ref={popover.rootRef}>
      <button
        ref={popover.toggleRef}
        type="button"
        className="toolbar-button"
        aria-label={t('appearance.button', { appearance: t(APPEARANCE_LABEL_KEYS[appearance]) })}
        title={t('appearance.title')}
        aria-expanded={popover.open}
        aria-haspopup="dialog"
        aria-controls={popover.panelId}
        onClick={popover.toggle}
      >
        <SunMoon size={18} aria-hidden="true" />
      </button>

      {/* The toolbar's frosted glass (backdrop-filter) becomes the containing block for fixed positioning, so the panel must be attached to body. */}
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

        </div>,
        document.body,
      )}
    </div>
  );
}
