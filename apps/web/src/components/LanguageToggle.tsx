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
 * 语言选择器：自动（跟随浏览器）或固定某种语言，选择保存在本机浏览器。
 * 语言名称用该语言自身书写并标注 lang，读屏软件按对应语言朗读；交互方式与外观弹层一致。
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

      {/* 与外观弹层相同：工具栏毛玻璃会成为 fixed 定位的包含块，面板挂到 body。 */}
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
