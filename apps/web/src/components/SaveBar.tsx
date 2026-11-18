import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useI18n } from '../i18n';

/**
 * 编辑已有设置的页面（参数配置、实例设置）共用的保存栏。
 * 没有改动时不显示；有改动时显示「N 项修改未保存」「放弃修改」「保存」；
 * 保存成功且实例在运行时变成「已保存，重启实例后生效」加重启入口，实例没在运行时只短暂提示已保存。
 * 外层占位容器一直在，高度固定：栏出现和消失时页面内容不跳，滚到底时最后一行也不会被挡住。
 */

/** 页面交给保存栏的重启入口：仍然走实例页头部那一套重启确认。 */
export interface RestartControl {
  /** 实例正在运行：保存的内容要重启才生效。 */
  running: boolean;
  /** 与页头重启按钮相同的禁用条件。 */
  disabled: boolean;
  /** 每确认一次重启加一，「重启后生效」的提示据此收起。 */
  signal: number;
  /** 打开重启确认框。 */
  request: () => void;
}

export type SavedNotice = 'restart' | 'saved' | null;

/** 「已保存」的短暂提示停留多久。 */
const SAVED_NOTICE_MS = 4000;

/**
 * 保存成功之后的提示。show(needsRestart)：实例在运行且这次保存要重启才生效时给出重启入口，否则只短暂提示。
 * 重启入口在实例被重启或不再运行后自动收起；再次修改时由页面调用 clear()。
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

  const show = useCallback(
    (needsRestart: boolean) => setState({ kind: needsRestart && running ? 'restart' : 'saved', signal }),
    [running, signal],
  );
  const clear = useCallback(() => setState(null), []);

  // 记下提示是在第几次重启之前给出的：之后确认过重启或实例停了，这条提示就不再成立，不用副作用去清。
  const notice: SavedNotice = !state ? null
    : state.kind === 'saved' ? 'saved'
      : running && state.signal === signal ? 'restart' : null;
  return { notice, show, clear };
}

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'range', 'color', 'image', 'search']);

/**
 * 表单 onKeyDown 里判断这次按键是不是「在输入框里按 Enter 提交」。
 * 主按钮禁用或保存栏没显示时浏览器不会触发 submit，所以表单自己接 Enter，并由调用方 preventDefault，只走这一条路。
 * 多行文本框、下拉框、搜索框、开关和按钮里的 Enter 不算；输入法选词的 Enter 也不算。
 */
export function isEnterSubmit(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'Enter' || event.defaultPrevented) return false;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return false;
  if (NON_TEXT_INPUT_TYPES.has(target.type)) return false;
  // 自己实现的下拉、搜索框用 Enter 选中候选项。
  if (target.getAttribute('role') === 'combobox' || target.hasAttribute('aria-autocomplete')) return false;
  return true;
}

export interface SaveBarProps {
  /** 有几项修改还没保存；0 表示没有改动。 */
  dirtyCount: number;
  saving: boolean;
  /** 主按钮文字，如「保存配置」。 */
  saveLabel: string;
  /** 有不合法项时点名第一个要改的字段（已翻译）；合法时传 null。 */
  invalidLabel: string | null;
  /** 点了状态文字：让各字段显示原因，并跳到第一个要改的字段。 */
  onFixInvalid: () => void;
  onDiscard: () => void;
  notice: SavedNotice;
  /** 不需要重启（或实例没在运行）时短暂显示的「已保存」文案。 */
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
