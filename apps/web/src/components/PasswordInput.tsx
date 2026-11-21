import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../i18n';

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Content rendered right after the input. The login page's floating label is positioned with the "input + label" adjacent selector and has to be passed in here. */
  after?: ReactNode;
}

/**
 * A password box with a "show / hide" button. Hidden by default; pasting is always allowed.
 * Add className="input" yourself when placing it outside .field.
 */
export function PasswordInput({ after, className, disabled, ...rest }: PasswordInputProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <span className="input-affix has-affix-button">
      <input
        // While shown in plain text, keep the browser's spell check and auto-capitalization away from the password.
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...rest}
        className={className}
        disabled={disabled}
        type={visible ? 'text' : 'password'}
      />
      {after}
      <button
        type="button"
        className="input-affix-button"
        aria-label={t(visible ? 'common.password.hide' : 'common.password.show')}
        aria-pressed={visible}
        disabled={disabled}
        // Do not let the input blur on press: otherwise one click on "show" would count as having left the field, and an unfinished password would report an error early.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((prev) => !prev)}
      >
        {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </span>
  );
}
