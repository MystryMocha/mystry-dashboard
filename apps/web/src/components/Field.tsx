import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

/**
 * The common parts of a form field: label, description, error row, and "when to show the error".
 *
 * "Whether it is valid" and "whether the red text shows" are two separate things:
 * - validity is computed by the page on every render and decides the state of the primary button and the action bar;
 * - the red text appears only after this field has been blurred, or after the whole form is asked to show everything (Enter was pressed, or the action bar's status text was clicked).
 *   An error already showing is recomputed on every keystroke and disappears as soon as it is fixed.
 * Empty required items are not marked red: the page should not pass error while the value is empty.
 */

interface FormFeedbackValue {
  /** Whether all fields are asked to show their errors. */
  revealed: boolean;
  /** Incremented on each reset, which makes fields forget "blurred". */
  epoch: number;
}

const FormFeedbackContext = createContext<FormFeedbackValue>({ revealed: false, epoch: 0 });

export interface FormFeedback {
  /** Passed to FormFeedbackProvider. */
  value: FormFeedbackValue;
  /** Makes all fields show their own errors: called when Enter cannot submit, or the action bar's status text is clicked. */
  revealAll: () => void;
  /** Back to "nothing touched": called on discarding changes, a successful save or a change of data. */
  reset: () => void;
}

/** One per form. Fields not wrapped in FormFeedbackProvider still work, they are just not affected by revealAll and reset. */
export function useFormFeedback(): FormFeedback {
  const [value, setValue] = useState<FormFeedbackValue>({ revealed: false, epoch: 0 });
  const revealAll = useCallback(() => setValue((prev) => (prev.revealed ? prev : { ...prev, revealed: true })), []);
  const reset = useCallback(() => setValue((prev) => ({ revealed: false, epoch: prev.epoch + 1 })), []);
  return useMemo(() => ({ value, revealAll, reset }), [value, revealAll, reset]);
}

export function FormFeedbackProvider({ value, children }: { value: FormFeedbackValue; children: ReactNode }) {
  return <FormFeedbackContext.Provider value={value}>{children}</FormFeedbackContext.Provider>;
}

/**
 * Display timing for a single field. Layouts that do not use the Field shell (such as config editor rows) use this hook directly:
 * wire onBlur to the control, and render the error row and aria-invalid only when shown is true.
 */
export function useFieldFeedback(error: string | null | undefined): { shown: boolean; onBlur: () => void } {
  const { revealed, epoch } = useContext(FormFeedbackContext);
  // Records which round the blur happened in: after a form reset the epoch changes, so it naturally no longer counts as blurred, with no extra side effect to clear it.
  const [touchedEpoch, setTouchedEpoch] = useState<number | null>(null);
  const onBlur = useCallback(() => setTouchedEpoch(epoch), [epoch]);
  return { shown: Boolean(error) && (revealed || touchedEpoch === epoch), onBlur };
}

/** The page spreads these attributes onto the input control as is. */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  onBlur: () => void;
}

export interface FieldProps {
  /** Pass a fixed id when the field needs to be jumped to from elsewhere; otherwise one is generated. */
  id?: string;
  label: string;
  /** Optional items get "(optional)" after the label; required items are not marked. */
  optional?: boolean;
  help?: ReactNode;
  /** Set to true when the error and the description are about the same thing: once the error shows, the description is not shown, so one thing is not said twice. */
  errorReplacesHelp?: boolean;
  /** The already translated error reason; pass null when valid or empty. */
  error?: string | null;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** A field with the label on top, the control in the middle, and the error and description below. The class names field, error and field-help are kept, so the look is unchanged. */
export function Field({ id, label, optional = false, help: helpContent, errorReplacesHelp = false, error, className, children }: FieldProps) {
  const { t } = useI18n();
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const errorId = `${controlId}-error`;
  const helpId = `${controlId}-help`;
  const { shown, onBlur } = useFieldFeedback(error);
  const help = shown && errorReplacesHelp ? null : helpContent;
  const describedBy = [shown ? errorId : null, help ? helpId : null].filter(Boolean).join(' ') || undefined;
  return (
    // data-field-invalid is set whether or not the red text is showing, and focusFirstInvalidField uses it to find the first field to fix.
    <div className={className ? `field ${className}` : 'field'} data-field-invalid={error ? '' : undefined}>
      <label htmlFor={controlId}>{optional ? t('common.optionalLabel', { label }) : label}</label>
      {children({ id: controlId, 'aria-describedby': describedBy, 'aria-invalid': shown ? true : undefined, onBlur })}
      {shown && <p className="error" id={errorId}>{error}</p>}
      {help && <p className="field-help" id={helpId}>{help}</p>}
    </div>
  );
}

const CONTROL_SELECTOR = 'input, select, textarea';

function focusControl(control: HTMLElement | null): boolean {
  if (!control) return false;
  // Scroll to the middle of the view before focusing: focusing directly only guarantees the browser reveals it, often tucked behind the sticky bottom action bar.
  control.scrollIntoView?.({ block: 'center' });
  control.focus({ preventScroll: true });
  return true;
}

/** Jumps to the control with the given id. */
export function focusField(id: string): boolean {
  return focusControl(document.getElementById(id));
}

/**
 * Jumps to the first invalid field inside root. Usually called right after revealAll(), so the reason is shown at the same time.
 * Layouts that do not use the Field shell can be found by adding data-field-invalid to the field container themselves.
 */
export function focusFirstInvalidField(root: ParentNode | null): boolean {
  const holder = root?.querySelector<HTMLElement>('[data-field-invalid]');
  if (!holder) return false;
  return focusControl(holder.matches(CONTROL_SELECTOR) ? holder : holder.querySelector<HTMLElement>(CONTROL_SELECTOR));
}
