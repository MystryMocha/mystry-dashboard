import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

/**
 * 表单字段的公共部分：标签、说明、错误行，以及「什么时候把错误显示出来」。
 *
 * 「合不合法」和「显不显示红字」是两件事：
 * - 合不合法由页面每次渲染时算，决定主按钮和操作栏的状态；
 * - 红字只在这个字段失焦过，或整张表单被要求全部显示之后才出现（按了 Enter、点了操作栏的状态文字）。
 *   已经在显示的错误每次按键重新计算，改对了马上消失。
 * 空的必填项不标红：页面在值为空时不要传 error。
 */

interface FormFeedbackValue {
  /** 是否要求所有字段都把错误显示出来。 */
  revealed: boolean;
  /** 每次重置加一，字段据此忘掉「失焦过」。 */
  epoch: number;
}

const FormFeedbackContext = createContext<FormFeedbackValue>({ revealed: false, epoch: 0 });

export interface FormFeedback {
  /** 交给 FormFeedbackProvider。 */
  value: FormFeedbackValue;
  /** 让所有字段显示各自的错误：按 Enter 提交不了、或点了操作栏的状态文字时调用。 */
  revealAll: () => void;
  /** 回到「谁都没碰过」：放弃修改、保存成功或换了一份数据时调用。 */
  reset: () => void;
}

/** 一张表单一份。不包 FormFeedbackProvider 的字段照样能用，只是不会被 revealAll 和 reset 影响。 */
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
 * 单个字段的显示时机。不用 Field 外壳的布局（比如参数配置的行）直接用这个钩子：
 * 把 onBlur 接到控件上，shown 为 true 时再渲染错误行和 aria-invalid。
 */
export function useFieldFeedback(error: string | null | undefined): { shown: boolean; onBlur: () => void } {
  const { revealed, epoch } = useContext(FormFeedbackContext);
  // 记下是在哪一轮失焦的：表单重置后 epoch 变了，自然就不算失焦过，不用额外的副作用去清。
  const [touchedEpoch, setTouchedEpoch] = useState<number | null>(null);
  const onBlur = useCallback(() => setTouchedEpoch(epoch), [epoch]);
  return { shown: Boolean(error) && (revealed || touchedEpoch === epoch), onBlur };
}

/** 页面把这些属性原样展开到输入控件上。 */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  onBlur: () => void;
}

export interface FieldProps {
  /** 需要从别处跳到这个字段时传固定的 id，否则自动生成。 */
  id?: string;
  label: string;
  /** 可选项在标签后标「（可选）」；必填项不标。 */
  optional?: boolean;
  help?: ReactNode;
  /** 错误和说明讲的是同一件事时设为 true：错误显示出来后不再显示说明，免得一句话说两遍。 */
  errorReplacesHelp?: boolean;
  /** 已经翻译好的错误原因；合法或为空时传 null。 */
  error?: string | null;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** 标签在上、控件居中、错误和说明在下的字段。类名沿用 field、error、field-help，外观不变。 */
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
    // data-field-invalid 不管红字显没显示都标着，focusFirstInvalidField 靠它找到第一个要改的字段。
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
  // 先滚到视野中间再聚焦：直接聚焦时浏览器只保证它露出来，常常贴在吸底的操作栏后面。
  control.scrollIntoView?.({ block: 'center' });
  control.focus({ preventScroll: true });
  return true;
}

/** 跳到指定 id 的控件。 */
export function focusField(id: string): boolean {
  return focusControl(document.getElementById(id));
}

/**
 * 跳到 root 里第一个不合法的字段。通常紧跟在 revealAll() 之后调用，让它同时显示出原因。
 * 不用 Field 外壳的布局，在字段容器上自己加 data-field-invalid 即可被找到。
 */
export function focusFirstInvalidField(root: ParentNode | null): boolean {
  const holder = root?.querySelector<HTMLElement>('[data-field-invalid]');
  if (!holder) return false;
  return focusControl(holder.matches(CONTROL_SELECTOR) ? holder : holder.querySelector<HTMLElement>(CONTROL_SELECTOR));
}
