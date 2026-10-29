/**
 * 零依赖的轻量多语言实现。
 * - 文案表按含义命名的扁平键（如 `instance.status.running`），en 为主表，其他语言缺键时回落到 en；
 * - `{name}` 形式插值；复数用 `<键>_one` / `<键>_other`，按 Intl.PluralRules 选择；
 * - 句中需要加粗、代码等标签时用 `rich()`，文案里写 `<code>…</code>`，不在组件里拼接半句话；
 * - 数字、大小和日期统一走 `formatters()`，按当前语言用 Intl 格式化。
 * React 组件用 `useI18n()` 订阅语言切换；非组件代码（如 api.ts）用模块级 `t()`，按调用时的语言取文案。
 */
import { createElement, Fragment, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { renderPanelMessage, type PanelMessage } from '@mystry/shared';
import en from './en';
import zhCN from './zh-CN';
import zhTW from './zh-TW';
import { DEFAULT_LOCALE, getLocale, LOCALE_CHANGE_EVENT, type Locale } from './locale';

export * from './locale';

export type MessageKey = keyof typeof en;
/** 有 `_one` / `_other` 变体的复数键，去掉后缀后的部分。 */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}_other` ? Base : never }[MessageKey];
export type MessageParams = Record<string, string | number>;

const TABLES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

function lookup(locale: Locale, key: string): string | undefined {
  return (TABLES[locale] as Record<string, string | undefined>)[key]
    ?? (TABLES[DEFAULT_LOCALE] as Record<string, string | undefined>)[key];
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return interpolate(lookup(locale, key) ?? key, params);
}

/**
 * 服务端消息（键 + 参数，参数可嵌套另一条消息）按界面语言渲染。
 * 没有消息键（旧任务、原始系统错误）时显示服务端给的文本 fallback；两者都没有时返回空字符串。
 */
export function translatePanelMessage(locale: Locale, message: PanelMessage | undefined, fallback?: string): string {
  if (!message) return fallback ?? '';
  return renderPanelMessage(message, (key) => lookup(locale, key));
}

/**
 * Intl 对象构造开销大（列表每行都要格式化日期和大小），按「语言 + 选项」缓存复用。
 * 选项序列化为键，调用方每次传入内容相同的新对象也能命中；语言种类和选项组合都有限，缓存不会无限增长。
 */
const intlCache = new Map<string, object>();

function cachedIntl<T extends object>(kind: string, locale: Locale, options: object | undefined, create: () => T): T {
  const key = `${kind}|${locale}|${options ? JSON.stringify(options) : ''}`;
  let formatter = intlCache.get(key) as T | undefined;
  if (!formatter) {
    formatter = create();
    intlCache.set(key, formatter);
  }
  return formatter;
}

export function numberFormat(locale: Locale, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cachedIntl('number', locale, options, () => new Intl.NumberFormat(locale, options));
}

export function dateTimeFormat(locale: Locale, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cachedIntl('dateTime', locale, options, () => new Intl.DateTimeFormat(locale, options));
}

function pluralRules(locale: Locale): Intl.PluralRules {
  return cachedIntl('plural', locale, undefined, () => new Intl.PluralRules(locale));
}

/** 复数文案：`{count}` 会按当前语言格式化后填入。 */
export function translatePlural(locale: Locale, key: PluralKey, count: number, params?: MessageParams): string {
  const template = lookup(locale, `${key}_${pluralRules(locale).select(count)}`) ?? lookup(locale, `${key}_other`) ?? key;
  return interpolate(template, { ...params, count: numberFormat(locale).format(count) });
}

export type RichTags = Record<string, (chunk: string) => ReactNode>;

/** 把文案中的 `<tag>…</tag>`（不嵌套）替换为对应节点，其余部分保持纯文本。 */
export function translateRich(locale: Locale, key: MessageKey, tags: RichTags, params?: MessageParams): ReactNode {
  const text = translate(locale, key, params);
  const parts: ReactNode[] = [];
  const pattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let index = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const render = tags[match[1]!];
    parts.push(createElement(Fragment, { key: index++ }, render ? render(match[2]!) : match[2]));
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}

const DEFAULT_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const TIME_ONLY: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' };

const formattersCache = new Map<Locale, ReturnType<typeof createFormatters>>();

/**
 * 当前语言的数字、大小和日期格式化；数字与单位之间保留空格。
 * 同一语言始终返回同一个对象，组件可放心把 `fmt` 或其方法作为依赖或 props 传给 memo 组件。
 */
export function formatters(locale: Locale) {
  let fmt = formattersCache.get(locale);
  if (!fmt) {
    fmt = createFormatters(locale);
    formattersCache.set(locale, fmt);
  }
  return fmt;
}

function createFormatters(locale: Locale) {
  const number = (value: number, options?: Intl.NumberFormatOptions) =>
    numberFormat(locale, options).format(value);
  const fixed = (value: number, digits: number) =>
    number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return {
    number,
    /** 固定小数位，例如 CPU 占用 24.0。 */
    fixed,
    /** 输入为 0–100 的百分数，例如 24.5 → "24.5%"。 */
    percent: (value: number, digits = 1) =>
      number(value / 100, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }),
    /** 字节数转 GiB 数值（不含单位），保留一位小数。 */
    gib: (bytes: number, digits = 1) => fixed(bytes / 1024 ** 3, digits),
    /** 文件大小：1024 进制，小于 100 保留一位小数，例如 "1.5 MB"。 */
    fileSize: (bytes: number) => {
      if (!Number.isFinite(bytes) || bytes < 0) return '';
      if (bytes < 1024) return `${number(bytes)} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${fixed(value, value >= 100 ? 0 : 1)} ${units[unit]}`;
    },
    /** 日期时间；无效输入返回空字符串。 */
    dateTime: (value: string | number | Date, options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME) => {
      const date = toDate(value);
      return date ? dateTimeFormat(locale, options).format(date) : '';
    },
    /** 仅时间（时:分:秒）；无效输入返回空字符串。 */
    time: (value: string | number | Date) => {
      const date = toDate(value);
      return date ? dateTimeFormat(locale, TIME_ONLY).format(date) : '';
    },
  };
}

export type Formatters = ReturnType<typeof formatters>;

/** 非组件代码使用：按调用时的界面语言取文案。 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(getLocale(), key, params);
}

export function tp(key: PluralKey, count: number, params?: MessageParams): string {
  return translatePlural(getLocale(), key, count, params);
}

export function tm(message: PanelMessage | undefined, fallback?: string): string {
  return translatePanelMessage(getLocale(), message, fallback);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(LOCALE_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(LOCALE_CHANGE_EVENT, onChange);
}

/** 组件内取文案与格式化函数；切换语言后自动重新渲染。 */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE);
  return useMemo(() => ({
    locale,
    t: (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    tp: (key: PluralKey, count: number, params?: MessageParams) => translatePlural(locale, key, count, params),
    rich: (key: MessageKey, tags: RichTags, params?: MessageParams) => translateRich(locale, key, tags, params),
    /** 服务端消息：有键按当前语言翻译，没有键显示 fallback 原文。 */
    tm: (message: PanelMessage | undefined, fallback?: string) => translatePanelMessage(locale, message, fallback),
    fmt: formatters(locale),
  }), [locale]);
}

export type I18n = ReturnType<typeof useI18n>;
