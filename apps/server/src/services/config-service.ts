import fs from 'node:fs';
import { assertTextFileWithinLimit } from './file-service.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { getInstanceDir, resolveSafePath } from '../utils/path.js';
import { PanelError } from '../utils/errors.js';

export type PropertiesMap = Record<string, string>;

type PropertyEntryLine = {
  kind: 'entry';
  /** Raw line text (without the line break) */
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
 * Servers at 1.13 and earlier accept only the numeric form of difficulty and gamemode, and writing a word gets it silently reset to the default.
 * Since 1.14 the file stores words but still accepts numbers, so numbers are the form both old and new versions can read.
 * The index is the numeric ID used in the game.
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

/** The API and forms use words only; out-of-range numbers are kept as is, so the user sees what is really in the file. */
function withNamedEnumValues(properties: PropertiesMap): PropertiesMap {
  const result = { ...properties };
  for (const [key, names] of Object.entries(NUMERIC_ENUM_PROPERTIES)) {
    const value = result[key];
    const name = isNumericValue(value) ? names[Number(value)] : undefined;
    if (name) result[key] = name;
  }
  return result;
}

/** Converts a word back to the form the file should use: a number when the file originally had a number, or the instance version accepts only numbers. */
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

/** Finds the first = or : not escaped by a backslash; \= inside a key is not a separator. */
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

/** Parses logical lines (continuations already merged) into document lines */
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

/** Reads the effective key-value pairs (for duplicate keys the last definition wins) */
export function propertiesMapFromDocument(document: PropertiesDocument): PropertiesMap {
  const result: PropertiesMap = {};
  for (const line of document.lines) {
    if (line.kind === 'entry') {
      result[line.key] = line.value;
    }
  }
  return result;
}

/** Parses into a map of effective key-value pairs (for duplicate keys the last definition wins) */
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
 * Java properties escaping: backslash and \t \r \n \f must be escaped, or once written they would be taken as syntax rather than value.
 * Non-ASCII characters are written as \uXXXX: old servers read the file as Latin-1, so writing UTF-8 directly would turn into mojibake,
 * the server would then save the mojibake back to the file, and the original text could not be recovered. Emoji are split into two parts as UTF-16, which Java merges when reading.
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
 * Merges key-value pairs submitted by the guided form / advanced options into the document, modifying only the last definition of each key.
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

/** Used when creating a new file (no existing comments/order to preserve) */
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

/** The port the game uses when server.properties has no port or the port is left empty. */
const DEFAULT_GAME_PORT = 25565;

/**
 * Takes the game port from the server.properties key-value pairs, for the virtual network, tunneling and direct connection addresses.
 * When there is no server-port key, or the value is left empty, the game uses 25565 (empty was verified on a 1.21.10 server), and the same is done here;
 * when something is written that is not an integer in 1–65535, null is returned and the caller reports an invalid port.
 */
export function gamePortFromProperties(properties: PropertiesMap): number | null {
  const text = (properties['server-port'] ?? '').trim();
  if (text === '') return DEFAULT_GAME_PORT;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Writes the panel's default config before the first start; an existing server.properties is left unchanged. */
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
  // The default document does not mix in the patch: parse the pure defaults first, then apply everything through applyPropertiesPatch with escaping,
  // so unescaped values (line breaks, trailing backslashes) are not split into extra properties or made to swallow the next line during parsing.
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
