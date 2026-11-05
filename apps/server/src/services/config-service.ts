import fs from 'node:fs';
import { assertTextFileWithinLimit } from './file-service.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { getInstanceDir, resolveSafePath } from '../utils/path.js';
import { PanelError } from '../utils/errors.js';

export type PropertiesMap = Record<string, string>;

type PropertyEntryLine = {
  kind: 'entry';
  /** 原始行文本（不含换行） */
  raw: string;
  key: string;
  separator: '=' | ':';
  value: string;
};

type PropertyRawLine = {
  kind: 'raw';
  raw: string;
};

type PropertyLine = PropertyEntryLine | PropertyRawLine;

export type PropertiesDocument = {
  eol: '\n' | '\r\n';
  lines: PropertyLine[];
};

const DEFAULT_PROPERTIES: PropertiesMap = {
  'server-port': '25565',
  gamemode: 'survival',
  difficulty: 'normal',
  'max-players': '20',
  motd: 'A Minecraft Server',
  'online-mode': 'true',
};

/**
 * 1.13 及更早的服务端只认数字形式的难度和模式，写单词会被静默重置成默认值。
 * 1.14 起文件里改存单词，但仍接受数字，所以数字是新旧版本都能读的写法。
 * 下标就是游戏里的数字编号。
 */
const NUMERIC_ENUM_PROPERTIES: Record<string, readonly string[]> = {
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
};

function requiresNumericEnums(mcVersion: string | null | undefined): boolean {
  const minor = mcVersion?.match(/^1\.(\d+)\b/)?.[1];
  return minor !== undefined && Number(minor) < 14;
}

function isNumericValue(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value);
}

/** 接口和表单只用单词；超出范围的数字保持原样，让用户看到文件里的真实内容。 */
function withNamedEnumValues(properties: PropertiesMap): PropertiesMap {
  const result = { ...properties };
  for (const [key, names] of Object.entries(NUMERIC_ENUM_PROPERTIES)) {
    const value = result[key];
    const name = isNumericValue(value) ? names[Number(value)] : undefined;
    if (name) result[key] = name;
  }
  return result;
}

/** 把单词换回文件该用的写法：文件原来是数字，或实例版本只认数字时写数字。 */
function withFileEnumValues(
  properties: PropertiesMap,
  current: PropertiesMap,
  mcVersion: string | null | undefined,
): PropertiesMap {
  const result = { ...properties };
  const numericOnly = requiresNumericEnums(mcVersion);
  for (const [key, names] of Object.entries(NUMERIC_ENUM_PROPERTIES)) {
    const value = result[key];
    if (value === undefined) continue;
    const index = names.indexOf(value);
    if (index !== -1 && (numericOnly || isNumericValue(current[key]))) {
      result[key] = String(index);
    }
  }
  return result;
}

function detectEol(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

function unescapePropertyValue(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '\\') {
      const next = value[index + 1];
      if (next === undefined) {
        result += char;
        continue;
      }
      if (next === 'u') {
        const hex = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 5;
          continue;
        }
      }
      if ('tnr\\f'.includes(next)) {
        const mapped: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f' };
        result += mapped[next] ?? next;
        index += 1;
        continue;
      }
      result += next;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

/** 找到第一个未被反斜杠转义的 = 或 :，key 中的 \= 不算分隔符。 */
function findSeparatorIndex(raw: string): number {
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '=' || char === ':') return index;
  }
  return -1;
}

function parseEntryLine(raw: string): PropertyEntryLine | null {
  const trimmedStart = raw.trimStart();
  if (!trimmedStart || trimmedStart.startsWith('#') || trimmedStart.startsWith('!')) {
    return null;
  }

  const keyEnd = findSeparatorIndex(raw);
  if (keyEnd === -1) return null;

  const key = raw.slice(0, keyEnd).trim();
  if (!key) return null;
  const separator = raw[keyEnd] as '=' | ':';
  const value = unescapePropertyValue(raw.slice(keyEnd + 1).trimStart());
  return { kind: 'entry', raw, key, separator, value };
}

/** 将已合并续行的逻辑行解析为文档行 */
function parseLogicalLines(logicalLines: string[]): PropertyLine[] {
  const lines: PropertyLine[] = [];
  for (const raw of logicalLines) {
    const entry = parseEntryLine(raw);
    lines.push(entry ?? { kind: 'raw', raw });
  }
  return lines;
}

function hasOddTrailingBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function joinLogicalLines(rawLines: string[]): string[] {
  const logical: string[] = [];
  let pending = '';
  for (const raw of rawLines) {
    pending = pending ? `${pending}${raw}` : raw;
    if (hasOddTrailingBackslash(pending)) {
      pending = pending.slice(0, -1);
      continue;
    }
    logical.push(pending);
    pending = '';
  }
  if (pending) logical.push(pending);
  return logical;
}

export function parsePropertiesDocument(content: string): PropertiesDocument {
  return {
    eol: detectEol(content),
    lines: parseLogicalLines(joinLogicalLines(splitLines(content))),
  };
}

/** 读取有效键值（重复键取最后一次定义） */
export function propertiesMapFromDocument(document: PropertiesDocument): PropertiesMap {
  const result: PropertiesMap = {};
  for (const line of document.lines) {
    if (line.kind === 'entry') {
      result[line.key] = line.value;
    }
  }
  return result;
}

/** 解析为有效键值映射（重复键取最后一次定义） */
export function parseProperties(content: string): PropertiesMap {
  return propertiesMapFromDocument(parsePropertiesDocument(content));
}

function replaceEntryValue(line: PropertyEntryLine, value: string): PropertyEntryLine {
  const separatorIndex = findSeparatorIndex(line.raw);
  const prefix = separatorIndex === -1 ? line.raw : line.raw.slice(0, separatorIndex + 1);
  return {
    ...line,
    raw: `${prefix}${value}`,
    value: unescapePropertyValue(value),
  };
}

/**
 * Java properties 转义：反斜杠与 \t \r \n \f 必须转义，否则写出后会被当作语法而非值。
 * 非 ASCII 字符写成 \uXXXX：旧版服务端按 Latin-1 读取，直接写 UTF-8 会变成乱码，
 * 服务端随后把乱码存回文件，原文就找不回来了。emoji 按 UTF-16 拆成两段，Java 读取时会合并。
 */
function escapePropertyValue(value: string): string {
  return value
    .replace(/[\\\t\r\n\f]/g, (char) => {
      const mapped: Record<string, string> = {
        '\\': '\\\\',
        '\t': '\\t',
        '\r': '\\r',
        '\n': '\\n',
        '\f': '\\f',
      };
      return mapped[char] ?? char;
    })
    .replace(/[^\x00-\x7f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * 将引导表单/高级选项提交的键值合并进文档，仅修改每个 key 的最后一次定义。
 */
export function applyPropertiesPatch(document: PropertiesDocument, patch: PropertiesMap): PropertiesDocument {
  const lastIndexByKey = new Map<string, number>();
  document.lines.forEach((line, index) => {
    if (line.kind === 'entry') lastIndexByKey.set(line.key, index);
  });

  const nextLines = document.lines.map((line) => ({ ...line })) as PropertyLine[];
  const appended: PropertyLine[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const escapedValue = escapePropertyValue(value);
    const lastIndex = lastIndexByKey.get(key);
    if (lastIndex === undefined) {
      appended.push({
        kind: 'entry',
        raw: `${key}=${escapedValue}`,
        key,
        separator: '=',
        value,
      });
      continue;
    }
    const current = nextLines[lastIndex];
    if (current?.kind === 'entry') {
      nextLines[lastIndex] = replaceEntryValue(current, escapedValue);
    }
  }

  return {
    eol: document.eol,
    lines: [...nextLines, ...appended],
  };
}

export function stringifyPropertiesDocument(document: PropertiesDocument): string {
  const body = document.lines.map((line) => line.raw).join(document.eol);
  if (body.length === 0) return '';
  return `${body}${document.eol}`;
}

/** 新建文件时使用（无历史注释/顺序可保留） */
export function stringifyProperties(map: PropertiesMap): string {
  const lines = Object.entries(map).map(([key, value]) => `${key}=${value}`);
  return `${lines.join('\n')}\n`;
}

function assertMutablePropertiesFile(instanceId: string, file: string): void {
  assertTextFileWithinLimit(instanceId, 'server.properties');
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PanelError('server.instance.propertiesNotRegularFile');
  }
}

export function readServerProperties(instanceId: string): PropertiesMap {
  const root = getInstanceDir(instanceId);
  const file = resolveSafePath(root, 'server.properties');
  if (!fs.existsSync(file)) {
    return { ...DEFAULT_PROPERTIES };
  }
  assertMutablePropertiesFile(instanceId, file);
  return withNamedEnumValues(parseProperties(fs.readFileSync(file, 'utf8')));
}

/** 首次启动前写入面板默认配置；已有 server.properties 保持不变。 */
export function ensureServerPropertiesDefaults(instanceId: string, mcVersion?: string | null): void {
  const root = getInstanceDir(instanceId);
  const file = resolveSafePath(root, 'server.properties');
  if (fs.existsSync(file)) return;
  writeServerProperties(instanceId, {}, mcVersion);
}

export function previewServerPropertiesWrite(
  instanceId: string,
  patch: PropertiesMap,
  mcVersion?: string | null,
): string {
  const root = getInstanceDir(instanceId);
  const file = resolveSafePath(root, 'server.properties');
  // 默认文档不混入 patch：先解析纯默认值，再统一经 applyPropertiesPatch 转义应用，
  // 避免未转义值（换行、尾随反斜杠）在解析阶段被拆成额外属性或吞并下一行。
  const baseDocument = fs.existsSync(file)
    ? parsePropertiesDocument(fs.readFileSync(file, 'utf8'))
    : parsePropertiesDocument(stringifyProperties(withFileEnumValues(DEFAULT_PROPERTIES, {}, mcVersion)));
  const filePatch = withFileEnumValues(patch, propertiesMapFromDocument(baseDocument), mcVersion);
  return stringifyPropertiesDocument(applyPropertiesPatch(baseDocument, filePatch));
}

export function writeServerProperties(
  instanceId: string,
  patch: PropertiesMap,
  mcVersion?: string | null,
): void {
  const root = getInstanceDir(instanceId);
  const file = resolveSafePath(root, 'server.properties');
  assertMutablePropertiesFile(instanceId, file);
  writeFileAtomic(file, previewServerPropertiesWrite(instanceId, patch, mcVersion));
}
