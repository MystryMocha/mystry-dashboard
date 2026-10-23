import { useEffect, useId, useRef, useState } from 'react';

/**
 * 工具栏弹层（外观、语言）共用的开关、定位与焦点逻辑：
 * 面板挂到 body 并用 fixed 定位在按钮下方右对齐；打开时聚焦选中的单选项，
 * Esc 关闭并把焦点还给按钮，点击或 Tab 到外部时自动收起。
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
