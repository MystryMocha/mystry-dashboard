import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Languages } from 'lucide-react';
import { usePopover } from '../hooks/usePopover';
import {
  getLocalePreference,
  LOCALE_CHANGE_EVENT,
  LOCALE_NATIVE_NAMES,
  LOCALE_PREFERENCES,
  setLocalePreference,
  useI18n,
  type LocalePreference,
} from '../i18n';

type Placement = 'topbar' | 'login';

const POPOVER_WIDTH = 240;

/**
 * Language picker: auto (follow the browser) or a fixed language, with the choice saved in the local browser.
 * Language names are written in the language itself and tagged with lang, so screen readers read them in the matching language; the interaction matches the appearance popover.
 */
export function LanguageToggle({ placement = 'topbar' }: { placement?: Placement }) {
  const { t, locale } = useI18n();
  const [preference, setPreferenceState] = useState<LocalePreference>(getLocalePreference);
  const popover = usePopover(POPOVER_WIDTH);
  const groupName = useId();

  useEffect(() => {
    const onChange = () => setPreferenceState(getLocalePreference());
    window.addEventListener(LOCALE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LOCALE_CHANGE_EVENT, onChange);
  }, []);

  const current = LOCALE_NATIVE_NAMES[locale];

  return (
    <div className={`appearance-picker appearance-picker-${placement}`} ref={popover.rootRef}>
      <button
        ref={popover.toggleRef}
        type="button"
        className="toolbar-button"
        aria-label={t('language.button', { language: current })}
        title={t('language.title')}
        aria-expanded={popover.open}
        aria-haspopup="dialog"
        aria-controls={popover.panelId}
        onClick={popover.toggle}
      >
        <Languages size={18} aria-hidden="true" />
      </button>

      {/* Same as the appearance popover: the toolbar's frosted glass becomes the containing block for fixed positioning, so the panel is attached to body. */}
      {popover.open && createPortal(
        <div
          id={popover.panelId}
          ref={popover.panelRef}
          className="popover language-popover"
          style={popover.panelStyle}
          role="dialog"
          aria-label={t('language.title')}
        >
          <fieldset className="appearance-group">
            <legend className="popover-title">{t('language.title')}</legend>
            <div className="language-options">
              {LOCALE_PREFERENCES.map((id) => (
                <label key={id} className="language-option">
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={groupName}
                    value={id}
                    checked={preference === id}
                    onChange={() => setLocalePreference(id)}
                  />
                  <span className="language-option-label" lang={id === 'auto' ? undefined : id}>
                    {id === 'auto' ? t('language.auto') : LOCALE_NATIVE_NAMES[id]}
                  </span>
                  {preference === id && <Check size={15} strokeWidth={2.5} aria-hidden="true" />}
                </label>
              ))}
            </div>
            {preference === 'auto' && (
              <p className="popover-footnote">{t('language.auto.hint', { language: current })}</p>
            )}
          </fieldset>
        </div>,
        document.body,
      )}
    </div>
  );
}
