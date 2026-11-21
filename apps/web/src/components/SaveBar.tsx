import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useI18n } from '../i18n';

/**
 * The save bar shared by pages that edit existing settings (config editor, instance settings).
 * Not shown when there are no changes; with changes it shows "N unsaved changes", "Discard Changes" and "Save";
 * after a successful save with the instance running it becomes "Saved, takes effect after restarting the instance" plus a restart entry, and when the instance is not running only a brief saved notice.
 * The outer placeholder container is always there with a fixed height: page content does not jump when the bar appears and disappears, and the last row is not covered when scrolled to the bottom.
 */

/** The restart entry the page hands to the save bar: it still goes through the restart confirmation in the instance page header. */
export interface RestartControl {
  /** The instance is running: what was saved takes effect only after a restart. */
  running: boolean;
  /** Same disabling conditions as the restart button in the page header. */
  disabled: boolean;
  /** Incremented on each confirmed restart, and the "takes effect after restart" notice collapses based on it. */
  signal: number;
  /** Opens the restart confirmation dialog. */
  request: () => void;
}

export type SavedNotice = 'restart' | 'saved' | null;

/** How long the brief "saved" notice stays. */
const SAVED_NOTICE_MS = 4000;

/**
 * The notice after a successful save. show(needsRestart): offers the restart entry when the instance is running and this save needs a restart to take effect, otherwise only a brief notice.
 * The restart entry collapses automatically after the instance is restarted or no longer running; on the next edit the page calls clear().
 */
export function useSavedNotice(restart: RestartControl | undefined): {
  notice: SavedNotice;
  show: (needsRestart: boolean) => void;
  clear: () => void;
} {
  const running = restart?.running ?? false;
  const signal = restart?.signal ?? 0;
  const [state, setState] = useState<{ kind: 'restart' | 'saved'; signal: number } | null>(null);

  useEffect(() => {
    if (state?.kind !== 'saved') return;
    const timer = window.setTimeout(() => setState(null), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  // After the instance is restarted or no longer running, the "takes effect after restart" notice no longer holds: clear it directly,
  // or it would pop up again after stopping and starting (the status returns to running). Its own state is adjusted from props during render, with no side effect needed.
  if (state?.kind === 'restart' && (!running || state.signal !== signal)) setState(null);

  const show = useCallback(
    (needsRestart: boolean) => setState({ kind: needsRestart && running ? 'restart' : 'saved', signal }),
    [running, signal],
  );
  const clear = useCallback(() => setState(null), []);

  return { notice: state?.kind ?? null, show, clear };
}

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'range', 'color', 'image', 'search']);

/**
 * Tells whether this keypress is "Enter in an input to submit".
 * While the primary button is disabled or the save bar is not showing the browser does not trigger submit, so the form handles Enter itself, and useFormSubmit calls preventDefault so there is only this one path.
 * Enter in multi-line text boxes, dropdowns, search boxes, switches and buttons does not count; nor does the Enter that confirms an IME candidate.
 */
export function isEnterSubmit(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'Enter' || event.defaultPrevented) return false;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return false;
  if (NON_TEXT_INPUT_TYPES.has(target.type)) return false;
  // Custom-built dropdowns and search boxes use Enter to select a candidate.
  if (target.getAttribute('role') === 'combobox' || target.hasAttribute('aria-autocomplete')) return false;
  return true;
}

/** How soon after an Enter on a switch, dropdown or similar control an arriving submit counts as caused by it. */
const IMPLICIT_SUBMIT_WINDOW_MS = 100;

/**
 * The form's submit entry; spread the return value onto <form>. submit is implemented by the page: save when valid, otherwise show the reason and jump to the field to fix.
 * - Enter in an input: taken over here, calling submit (see isEnterSubmit).
 * - Clicking the primary button: the browser fires the submit event, and submit is called as usual.
 * - Enter on a switch, radio or dropdown: the browser also "implicitly submits" the form (as if clicking the primary button for the user), which is not what the user meant, so it is ignored.
 *   preventDefault cannot be called on these Enters, since that would affect the control's own keyboard handling, so only the time is recorded and the submit event right after is voided.
 */
export function useFormSubmit(submit: () => void): {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => void;
} {
  const ignoreSubmitUntil = useRef(0);
  return {
    onSubmit(event) {
      event.preventDefault();
      if (Date.now() < ignoreSubmitUntil.current) {
        ignoreSubmitUntil.current = 0;
        return;
      }
      submit();
    },
    onKeyDown(event) {
      if (event.key !== 'Enter') return;
      if (isEnterSubmit(event)) {
        event.preventDefault();
        submit();
        return;
      }
      // Enter on a button is clicking that button (the primary button being submit), and is not an implicit submit.
      if (event.target instanceof HTMLButtonElement) return;
      ignoreSubmitUntil.current = Date.now() + IMPLICIT_SUBMIT_WINDOW_MS;
    },
  };
}

export interface SaveBarProps {
  /** How many changes are unsaved; 0 means no changes. */
  dirtyCount: number;
  saving: boolean;
  /** Primary button text, such as "Save Config". */
  saveLabel: string;
  /** Names the first field to fix when something is invalid (already translated); pass null when valid. */
  invalidLabel: string | null;
  /** The status text was clicked: makes the fields show their reasons and jumps to the first field to fix. */
  onFixInvalid: () => void;
  onDiscard: () => void;
  notice: SavedNotice;
  /** The "saved" text shown briefly when no restart is needed (or the instance is not running). */
  savedLabel: string;
  restart?: RestartControl;
  onDismissNotice: () => void;
}

export function SaveBar({
  dirtyCount,
  saving,
  saveLabel,
  invalidLabel,
  onFixInvalid,
  onDiscard,
  notice,
  savedLabel,
  restart,
  onDismissNotice,
}: SaveBarProps) {
  const { t, tp } = useI18n();
  const dirty = dirtyCount > 0;
  let bar = null;
  if (dirty || saving) {
    bar = (
      <div className="action-bar save-bar">
        <span className="action-bar-status" role="status" aria-live="polite">
          {invalidLabel ? (
            <button className="link-button" type="button" onClick={onFixInvalid}>{invalidLabel}</button>
          ) : tp('instance.saveBar.dirty', dirtyCount)}
        </span>
        <button className="btn" type="button" disabled={saving} onClick={onDiscard}>
          {t('instance.saveBar.discard')}
        </button>
        <button className="btn btn-primary" type="submit" disabled={!dirty || saving || invalidLabel !== null}>
          {saving ? t('action.saving') : saveLabel}
        </button>
      </div>
    );
  } else if (notice === 'restart' && restart) {
    bar = (
      <div className="action-bar save-bar is-notice">
        <span className="action-bar-status" role="status" aria-live="polite">{t('instance.saveBar.savedRestart')}</span>
        <button className="btn" type="button" disabled={restart.disabled} onClick={restart.request}>
          <RotateCcw size={14} aria-hidden="true" />
          {t('instance.saveBar.restart')}
        </button>
        <button
          className="btn btn-icon btn-plain"
          type="button"
          aria-label={t('action.close')}
          title={t('action.close')}
          onClick={onDismissNotice}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    );
  } else if (notice === 'saved') {
    bar = (
      <div className="action-bar save-bar is-notice">
        <span className="action-bar-status" role="status" aria-live="polite">{savedLabel}</span>
      </div>
    );
  }
  return <div className="save-bar-slot">{bar}</div>;
}
