import { useId, useRef, type InputHTMLAttributes } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface NumberTextOptions {
  /** Allows a decimal point. */
  decimal?: boolean;
  /** Allows a leading minus sign. */
  allowNegative?: boolean;
}

/**
 * Tidies what the user typed or pasted into number text: full-width digits and symbols become ASCII, spaces and thousands separators are removed,
 * and characters that cannot appear in a number are dropped. Unfinished intermediate states such as "-" and "4." are kept, for the page's validation to judge.
 */
export function cleanNumberText(text: string, { decimal = false, allowNegative = false }: NumberTextOptions = {}): string {
  const halfWidth = text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[－−﹣]/g, '-')
    .replace(/[\s,，]/g, '');
  const negative = allowNegative && halfWidth.startsWith('-');
  let body = halfWidth.replace(decimal ? /[^\d.]/g : /\D/g, '');
  if (decimal) {
    // Keep only the first decimal point.
    const dot = body.indexOf('.');
    if (dot !== -1) body = body.slice(0, dot + 1) + body.slice(dot + 1).replace(/\./g, '');
  }
  return (negative ? '-' : '') + body;
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'>, NumberTextOptions {
  /** The text the page stores itself. A value passed in is shown as is (dirty values from a file too); only what the user newly types is tidied. */
  value: string;
  onChange: (text: string) => void;
  /** The unit on the right inside the box, such as "GB". Screen readers get it through aria-describedby. */
  suffix?: string;
  /**
   * The up/down arrows at the far right inside the box step one at a time like the arrows of type="number"; so do the ↑ ↓ keys in the box.
   * The new value is computed by the page (which knows the step and lower bound); only the direction is reported here. The wheel is not handled, so scrolling the page does not change it by accident.
   */
  stepper?: {
    increaseLabel: string;
    decreaseLabel: string;
    onStep: (direction: 1 | -1) => void;
  };
}

/**
 * Number input: a plain text box with a numeric keyboard, replacing type="number".
 * On desktop type="number" changes the number with the wheel, accepts e and +, and reads as an empty string mid-entry, so "cleared" cannot be told from "unfinished".
 * When arrows are needed they are drawn with stepper. Add className="input" yourself when placing it outside .field.
 */
export function NumberInput({ value, onChange, decimal = false, allowNegative = false, suffix, stepper, className, ...rest }: NumberInputProps) {
  const suffixId = useId();
  const composing = useRef(false);
  const options = { decimal, allowNegative };
  // The iOS numeric keyboard has no minus sign, so fall back to the regular keyboard when negatives are allowed.
  const inputMode = allowNegative ? 'text' : decimal ? 'decimal' : 'numeric';
  const describedBy = [rest['aria-describedby'], suffix ? suffixId : null].filter(Boolean).join(' ') || undefined;
  const input = (
    <input
      autoComplete="off"
      {...rest}
      className={className}
      type="text"
      inputMode={inputMode}
      value={value}
      aria-describedby={describedBy}
      onKeyDown={(event) => {
        rest.onKeyDown?.(event);
        if (!stepper || event.defaultPrevented || composing.current) return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        stepper.onStep(event.key === 'ArrowUp' ? 1 : -1);
      }}
      // Content is not rewritten during IME composition, or candidates would be interrupted; it is tidied once more when composition ends.
      onChange={(event) => onChange(composing.current ? event.target.value : cleanNumberText(event.target.value, options))}
      onCompositionStart={(event) => {
        composing.current = true;
        rest.onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onChange(cleanNumberText(event.currentTarget.value, options));
        rest.onCompositionEnd?.(event);
      }}
    />
  );
  if (!suffix && !stepper) return input;
  const affixClass = ['input-affix', suffix ? 'has-suffix-text' : null, stepper ? 'has-stepper' : null].filter(Boolean).join(' ');
  return (
    <span className={affixClass}>
      {input}
      {suffix && <span className="input-affix-text" id={suffixId}>{suffix}</span>}
      {stepper && (
        // Like the native arrows it stays out of the Tab order (the keyboard uses ↑ ↓); it does not take focus on press, so the input does not blur and pop up an error.
        <span className="input-stepper">
          {([[1, stepper.increaseLabel, ChevronUp], [-1, stepper.decreaseLabel, ChevronDown]] as const).map(([direction, label, Icon]) => (
            <button
              key={direction}
              type="button"
              tabIndex={-1}
              aria-label={label}
              disabled={rest.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepper.onStep(direction)}
            >
              <Icon size={12} strokeWidth={2.5} aria-hidden />
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
