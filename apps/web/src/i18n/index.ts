/**
 * A lightweight, zero-dependency i18n implementation.
 * - String tables use flat keys named by meaning (such as `instance.status.running`); en is the primary table, and other languages fall back to en for missing keys;
 * - interpolation uses the `{name}` form; plurals use `<key>_one` / `<key>_other`, chosen by Intl.PluralRules;
 * - when a sentence needs tags such as bold or code, use `rich()` and write `<code>…</code>` in the string, rather than concatenating half sentences in components;
 * - numbers, sizes and dates all go through `formatters()`, formatted with Intl in the current language.
 * React components subscribe to language changes with `useI18n()`; non-component code (such as api.ts) uses the module-level `t()`, taking strings in the language at call time.
 */
import { createElement, Fragment, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { renderPanelMessage, type PanelMessage } from '@mystry/shared';
import en from './en';
import zhCN from './zh-CN';
import zhTW from './zh-TW';
import { DEFAULT_LOCALE, getLocale, LOCALE_CHANGE_EVENT, type Locale } from './locale';

export * from './locale';

export type MessageKey = keyof typeof en;
/** Plural keys with `_one` / `_other` variants, with the suffix removed. */
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
 * Renders a server message (key + params, where a param may nest another message) in the UI language.
 * Without a message key (old tasks, raw system errors) the server-provided text fallback is shown; an empty string is returned when there is neither.
 */
export function translatePanelMessage(locale: Locale, message: PanelMessage | undefined, fallback?: string): string {
  if (!message) return fallback ?? '';
  return renderPanelMessage(message, (key) => lookup(locale, key));
}

/**
 * Intl objects are expensive to construct (every list row formats a date and a size), so they are cached and reused by "language + options".
 * Options are serialized into the key, so a caller passing a new object with the same content each time still hits; the languages and option combinations are finite, so the cache does not grow without bound.
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

/** Plural strings: `{count}` is formatted in the current language before being filled in. */
export function translatePlural(locale: Locale, key: PluralKey, count: number, params?: MessageParams): string {
  const template = lookup(locale, `${key}_${pluralRules(locale).select(count)}`) ?? lookup(locale, `${key}_other`) ?? key;
  return interpolate(template, { ...params, count: numberFormat(locale).format(count) });
}

export type RichTags = Record<string, (chunk: string) => ReactNode>;

/** Replaces `<tag>…</tag>` (not nested) in a string with the matching node, keeping the rest as plain text. */
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
 * Number, size and date formatting for the current language; a space is kept between number and unit.
 * The same language always returns the same object, so components can safely use `fmt` or its methods as dependencies or pass them as props to memo components.
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
    /** Fixed decimal places, e.g. CPU usage 24.0. */
    fixed,
    /** Input is a percentage in 0–100, e.g. 24.5 → "24.5%". */
    percent: (value: number, digits = 1) =>
      number(value / 100, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }),
    /** Bytes to a GiB number (without unit), with one decimal place. */
    gib: (bytes: number, digits = 1) => fixed(bytes / 1024 ** 3, digits),
    /** File size: base 1024, one decimal place below 100, e.g. "1.5 MB". */
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
    /** Date and time; returns an empty string for invalid input. */
    dateTime: (value: string | number | Date, options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME) => {
      const date = toDate(value);
      return date ? dateTimeFormat(locale, options).format(date) : '';
    },
    /** Time only (hour:minute:second); returns an empty string for invalid input. */
    time: (value: string | number | Date) => {
      const date = toDate(value);
      return date ? dateTimeFormat(locale, TIME_ONLY).format(date) : '';
    },
  };
}

export type Formatters = ReturnType<typeof formatters>;

/** For non-component code: takes strings in the UI language at call time. */
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

/** Gets strings and formatting functions inside a component; re-renders automatically after a language switch. */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE);
  return useMemo(() => ({
    locale,
    t: (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    tp: (key: PluralKey, count: number, params?: MessageParams) => translatePlural(locale, key, count, params),
    rich: (key: MessageKey, tags: RichTags, params?: MessageParams) => translateRich(locale, key, tags, params),
    /** Server message: translated into the current language when it has a key, otherwise the fallback text is shown. */
    tm: (message: PanelMessage | undefined, fallback?: string) => translatePanelMessage(locale, message, fallback),
    fmt: formatters(locale),
  }), [locale]);
}

export type I18n = ReturnType<typeof useI18n>;
