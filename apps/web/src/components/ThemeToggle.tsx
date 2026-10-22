import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, SunMoon } from 'lucide-react';
import {
  ACCENTS,
  ACCENT_META,
  APPEARANCES,
  APPEARANCE_META,
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
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance);
  const [accent, setAccentState] = useState<Accent>(getAccent);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const groupName = useId();
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    const onChange = () => {
      setAppearanceState(getAppearance());
      setAccentState(getAccent());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
      setPanelStyle({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        width,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
    const isInside = (target: EventTarget | null) =>
      Boolean(target instanceof Node && (rootRef.current?.contains(target) || panelRef.current?.contains(target)));
    function onMouseDown(event: MouseEvent) {
      if (!isInside(event.target)) setOpen(false);
    }
    function onFocusIn(event: FocusEvent) {
      // Tab 离开面板时自动收起，避免浮层停留在页面上。
      if (!isInside(event.target)) setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  const summary = `${APPEARANCE_META[appearance].label}外观，${ACCENT_META[accent].label}强调色`;

  return (
    <div className={`appearance-picker appearance-picker-${placement}`} ref={rootRef}>
      <button
        ref={toggleRef}
        type="button"
        className="toolbar-button"
        aria-label={`外观设置，当前为${summary}`}
        title="外观"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <SunMoon size={18} aria-hidden="true" />
      </button>

      {/* 工具栏的毛玻璃（backdrop-filter）会成为 fixed 定位的包含块，面板必须挂到 body。 */}
      {open && createPortal(
        <div
          id={panelId}
          ref={panelRef}
          className="popover appearance-popover"
          style={panelStyle}
          role="dialog"
          aria-label="外观"
        >
          <fieldset className="appearance-group">
            <legend className="popover-title">外观</legend>
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
                  <span className="appearance-option-label">{APPEARANCE_META[id].label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="appearance-group">
            <legend className="popover-title">强调色</legend>
            <div className="accent-options">
              {ACCENTS.map((id) => (
                <label key={id} className="accent-option" title={ACCENT_META[id].label}>
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={`${groupName}-accent`}
                    value={id}
                    checked={accent === id}
                    aria-label={ACCENT_META[id].label}
                    onChange={() => setAccent(id)}
                  />
                  <span className={`accent-swatch accent-swatch-${id}`} aria-hidden="true">
                    {accent === id && <Check size={12} strokeWidth={3} />}
                  </span>
                </label>
              ))}
            </div>
            <p className="popover-footnote">{ACCENT_META[accent].label}</p>
          </fieldset>
        </div>,
        document.body,
      )}
    </div>
  );
}
