import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../i18n';

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 紧跟在输入框后面渲染的内容。登录页的浮动标签靠「input + label」相邻选择器定位，要从这里放进来。 */
  after?: ReactNode;
}

/**
 * 带「显示 / 隐藏」按钮的密码框。默认隐藏；始终允许粘贴。
 * 放在 .field 外面时自己加 className="input"。
 */
export function PasswordInput({ after, className, disabled, ...rest }: PasswordInputProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <span className="input-affix has-affix-button">
      <input
        // 明文显示时不要让浏览器拼写检查和自动大写去动密码。
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
        onClick={() => setVisible((prev) => !prev)}
      >
        {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </span>
  );
}
