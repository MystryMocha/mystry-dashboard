import { useEffect, useId, useRef, useState } from 'react';

/**
 * Toggle, positioning and focus logic shared by toolbar popovers (appearance, language):
 * the panel is attached to body and fixed-positioned below the button, right-aligned; on open the selected radio item is focused,
 * Esc closes it and returns focus to the button, and clicking or tabbing outside collapses it automatically.
 */
export function usePopover(width: number) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = Math.min(width, window.innerWidth - 16);
      setPanelStyle({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8)),
        width: panelWidth,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, width]);

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
      // Collapse automatically when Tab leaves the panel, so the popover does not linger on the page.
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

  return {
    open,
    toggle: () => setOpen((value) => !value),
    rootRef,
    toggleRef,
    panelRef,
    panelId,
    panelStyle,
  };
}
