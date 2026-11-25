import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

const PAGE_SIZE = 10;
const PANEL_MAX_HEIGHT = 400;
const PANEL_GAP = 4;
const VIEWPORT_MARGIN = 8;

type PanelLayout = {
  direction: 'above' | 'below';
  maxHeight: number;
};

type LazyScrollSelectProps<T extends string | number> = {
  value: T | '';
  options: T[];
  onChange: (value: T) => void;
  disabled?: boolean;
  loading?: boolean;
  /** Callback when the panel opens (used to fetch options on demand) */
  onOpen?: () => void;
  formatLabel?: (value: T) => string;
  placeholder?: string;
  emptyText?: string;
  /** id of the visible field label: the trigger button's accessible name is "label + current value", so screen readers read both. */
  labelId: string;
};

/** Computes how many items at least need to be shown from the selected index, so the selected item is within the list */
function countForSelectedIndex(index: number, total: number): number {
  if (index < 0) return Math.min(PAGE_SIZE, total);
  return Math.min(Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE, total);
}

/** Clamps the active index to the current option range, so screen readers do not point at a nonexistent option. */
function normalizeActiveIndex(index: number, total: number): number {
  return index >= 0 && index < total ? index : -1;
}

export function LazyScrollSelect<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  onOpen,
  formatLabel = (v) => String(v),
  placeholder,
  emptyText,
  labelId,
}: LazyScrollSelectProps<T>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const valueId = `${listboxId}-value`;
  const [panelLayout, setPanelLayout] = useState<PanelLayout>({
    direction: 'below',
    maxHeight: PANEL_MAX_HEIGHT,
  });

  const updatePanelLayout = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // visualViewport excludes the invisible area taken by mobile browser toolbars and the on-screen keyboard.
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const viewportHeight = window.visualViewport?.height ?? document.documentElement.clientHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const availableBelow = Math.max(0, viewportBottom - rect.bottom - PANEL_GAP - VIEWPORT_MARGIN);
    const availableAbove = Math.max(0, rect.top - viewportTop - PANEL_GAP - VIEWPORT_MARGIN);
    const direction =
      availableBelow < PANEL_MAX_HEIGHT && availableAbove > availableBelow ? 'above' : 'below';
    const availableHeight = direction === 'above' ? availableAbove : availableBelow;
    const maxHeight = Math.min(PANEL_MAX_HEIGHT, availableHeight);

    setPanelLayout((current) =>
      current.direction === direction && Math.abs(current.maxHeight - maxHeight) < 1
        ? current
        : { direction, maxHeight },
    );
  }, []);

  useEffect(() => {
    const index = value === '' ? -1 : options.indexOf(value as T);
    setVisibleCount(countForSelectedIndex(index, options.length));
  }, [options, value]);

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    const selectedIndex = value === '' ? -1 : options.indexOf(value as T);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.length > 0 ? 0 : -1);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
  }, [open]);

  // The first positioning is done before the browser paints the panel, so always opening downward does not overflow for one frame.
  useLayoutEffect(() => {
    if (!open) return;
    updatePanelLayout();
  }, [open, updatePanelLayout]);

  useEffect(() => {
    if (!open) return;
    const visualViewport = window.visualViewport;
    window.addEventListener('resize', updatePanelLayout);
    window.addEventListener('scroll', updatePanelLayout, true);
    visualViewport?.addEventListener('resize', updatePanelLayout);
    visualViewport?.addEventListener('scroll', updatePanelLayout);
    return () => {
      window.removeEventListener('resize', updatePanelLayout);
      window.removeEventListener('scroll', updatePanelLayout, true);
      visualViewport?.removeEventListener('resize', updatePanelLayout);
      visualViewport?.removeEventListener('scroll', updatePanelLayout);
    };
  }, [open, updatePanelLayout]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  function closePanel(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function openPanel() {
    if (disabled) return;
    const index = value === '' ? -1 : options.indexOf(value as T);
    setVisibleCount(countForSelectedIndex(index, options.length));
    updatePanelLayout();
    setOpen(true);
    onOpen?.();
  }

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (nearBottom) {
      setVisibleCount((n) => Math.min(n + PAGE_SIZE, options.length));
    }
  }

  // When the content does not fill the panel there is no scrollbar and onScroll never fires: after each render of new content it is checked once more, until a scrollbar appears or everything is loaded.
  // Options may arrive after opening and the panel height also changes with the viewport, so both go into the dependencies; running before paint avoids flashing the loading hint.
  useLayoutEffect(() => {
    if (open) handleScroll();
  }, [open, visibleCount, options.length, panelLayout.maxHeight]);

  function selectOption(opt: T) {
    onChange(opt);
    closePanel(true);
  }

  function moveActive(delta: number) {
    if (options.length === 0) return;
    // The next index is computed outside the updater, to avoid calling another setState inside a setState updater (not a pure function).
    const currentIndex = normalizeActiveIndex(activeIndex, options.length);
    const base = currentIndex < 0 ? 0 : currentIndex;
    const next = Math.max(0, Math.min(options.length - 1, base + delta));
    setActiveIndex(next);
    if (next >= visibleCount - 1 && visibleCount < options.length) {
      setVisibleCount((count) => Math.min(count + PAGE_SIZE, options.length));
    }
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) openPanel();
      else if (event.key === 'Enter' || event.key === ' ') {
        const opt = options[activeIndex];
        if (opt !== undefined) selectOption(opt);
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closePanel(true);
    }
  }

  function onPanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel(true);
      return;
    }
    if (event.key === 'Tab') {
      // Same as a native dropdown: Tab collapses the panel, focus goes back to the trigger button first, and the browser's default behavior then moves it to the next control.
      closePanel(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
      setVisibleCount(options.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const opt = options[activeIndex];
      if (opt !== undefined) selectOption(opt);
    }
  }

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const panel = listRef.current;
    const option = panel?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    option?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const display =
    value === '' || (typeof value === 'number' && Number.isNaN(value))
      ? placeholder ?? t('select.placeholder')
      : formatLabel(value as T);
  const hasValue = value !== '';
  const visibleOptions = options.slice(0, visibleCount);
  const visibleActiveIndex = normalizeActiveIndex(activeIndex, visibleOptions.length);
  const activeOptionId =
    visibleActiveIndex >= 0 ? `${listboxId}-option-${visibleActiveIndex}` : undefined;

  return (
    <div
      className={`lazy-select${open ? ' is-open' : ''}${panelLayout.direction === 'above' ? ' opens-up' : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="lazy-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (open ? closePanel(true) : openPanel())}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={valueId} className={hasValue ? undefined : 'lazy-select-placeholder'}>{display}</span>
        <span className="lazy-select-chevron" aria-hidden />
      </button>
      {open && (
        <div
          id={listboxId}
          className="lazy-select-panel"
          role="listbox"
          aria-labelledby={labelId}
          aria-activedescendant={activeOptionId}
          ref={listRef}
          style={{ maxHeight: panelLayout.maxHeight }}
          onScroll={handleScroll}
          onKeyDown={onPanelKeyDown}
          tabIndex={-1}
        >
          {loading && options.length === 0 && (
            <div className="lazy-select-more muted">{t('common.loading')}</div>
          )}
          {!loading && options.length === 0 && (
            <div className="lazy-select-more muted">{emptyText ?? t('select.empty')}</div>
          )}
          {visibleOptions.map((opt, index) => {
            const selected = opt === value;
            const active = index === visibleActiveIndex;
            return (
              <button
                id={`${listboxId}-option-${index}`}
                key={String(opt)}
                type="button"
                role="option"
                // Option focus is managed by the listbox's aria-activedescendant, and options do not enter the Tab sequence individually.
                tabIndex={-1}
                data-option-index={index}
                aria-selected={selected}
                className={`lazy-select-option${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(opt)}
              >
                {formatLabel(opt)}
              </button>
            );
          })}
          {visibleCount < options.length && (
            <div className="lazy-select-more muted">{t('select.loadMore')}</div>
          )}
        </div>
      )}
    </div>
  );
}
