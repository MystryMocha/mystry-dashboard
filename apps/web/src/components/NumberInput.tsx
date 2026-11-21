import { useId, useRef, type InputHTMLAttributes } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface NumberTextOptions {
  /** 允许小数点。 */
  decimal?: boolean;
  /** 允许开头的负号。 */
  allowNegative?: boolean;
}

/**
 * 把用户输入或粘贴的内容整理成数字文本：全角数字和符号转成半角，去掉空格和千分位逗号，
 * 再丢掉不可能出现在数字里的字符。「-」「4.」这类还没输完的中间状态会保留，由页面的校验去判断。
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
    // 只留第一个小数点。
    const dot = body.indexOf('.');
    if (dot !== -1) body = body.slice(0, dot + 1) + body.slice(dot + 1).replace(/\./g, '');
  }
  return (negative ? '-' : '') + body;
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'inputMode'>, NumberTextOptions {
  /** 页面自己保存的文本。传进来的值原样显示（文件里的脏值也是），只整理用户新输入的内容。 */
  value: string;
  onChange: (text: string) => void;
  /** 框内右侧的单位，比如「GB」。读屏通过 aria-describedby 读到它。 */
  suffix?: string;
  /**
   * 框内最右侧的上下箭头，和 type="number" 的箭头一样一次加减一步；框里按 ↑ ↓ 键也是。
   * 新的值由页面算（页面知道步长和下限），这里只报方向。不响应滚轮，免得滚页面时误改。
   */
  stepper?: {
    increaseLabel: string;
    decreaseLabel: string;
    onStep: (direction: 1 | -1) => void;
  };
}

/**
 * 数字输入框：普通文本框加数字键盘，代替 type="number"。
 * type="number" 在桌面上滚轮会改数字，还能输入 e 和 +，而且输到一半时读到的值是空串，分不清「清空」和「没输完」。
 * 需要箭头时用 stepper 自己画。放在 .field 外面时自己加 className="input"。
 */
export function NumberInput({ value, onChange, decimal = false, allowNegative = false, suffix, stepper, className, ...rest }: NumberInputProps) {
  const suffixId = useId();
  const composing = useRef(false);
  const options = { decimal, allowNegative };
  // iOS 的数字键盘没有负号，允许负数时退回普通键盘。
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
      // 输入法组合期间不改写内容，否则候选词会被打断；组合结束时再整理一次。
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
        // 和原生箭头一样不进 Tab 顺序（键盘用 ↑ ↓）；按下时不抢焦点，免得输入框失焦冒出错误。
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
