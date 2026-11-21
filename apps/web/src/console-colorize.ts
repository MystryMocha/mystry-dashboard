/**
 * Console log coloring: maps common levels to the standard ECMA-48 / ISO 6429 SGR colors.
 * INFO=green, WARN=yellow, ERROR=red (bright variants, for readability on dark terminals).
 */
import { LOCALES, translate, type MessageKey } from './i18n';

const RESET = '\x1b[0m';

const ANSI = {
  info: '\x1b[92m', // Bright green
  warn: '\x1b[93m', // Bright yellow
  error: '\x1b[91m', // Bright red
  debug: '\x1b[96m', // Bright cyan
  fatal: '\x1b[95m', // Bright magenta
  command: '\x1b[1;97m', // Bold bright white: sent commands echoed by the panel
} as const;

/** How the server's process-manager echoes a sent command: "> command". */
const COMMAND_ECHO_PREFIX = '> ';

const HAS_ANSI = /\x1b\[/;

/**
 * Prefix of the panel's own notices: the forms in every UI language are collected, so after switching languages old logs and
 * the Chinese "[面板]" written by the server's process-manager are still colored.
 */
function prefixesFor(key: MessageKey): string[] {
  return [...new Set(LOCALES.map((locale) => translate(locale, key)))];
}

const PANEL_PREFIXES = prefixesFor('console.prefix.panel');
const ERROR_PREFIXES = prefixesFor('console.prefix.error');

/**
 * Strips OSC (ESC ]…: clipboard read/write, title, clear screen) and CSI control sequences other than SGR (ESC [ … m),
 * keeping only coloring, so xterm does not execute dangerous terminal sequences from server logs.
 */
function sanitizeAnsi(line: string): string {
  const withoutOsc = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  return withoutOsc.replace(/\x1b\[[0-9;?]*([A-Za-z@-~])/g, (sequence, final: string) =>
    final === 'm' ? sequence : '',
  );
}

/** Matches common Minecraft / Log4j level forms, e.g. [Server thread/INFO], /WARN] */
const LEVEL_RE =
  /(?:^|[^A-Za-z0-9_])(?:\/)?(FATAL|ERROR|SEVERE|WARN(?:ING)?|INFO|DEBUG|TRACE)(?=[\]:\s])/i;

export type ConsoleColorizeState = {
  pending: string;
};

export function createConsoleColorizeState(): ConsoleColorizeState {
  return { pending: '' };
}

function colorForLevel(level: string): string | null {
  switch (level.toUpperCase()) {
    case 'FATAL':
      return ANSI.fatal;
    case 'ERROR':
    case 'SEVERE':
      return ANSI.error;
    case 'WARN':
    case 'WARNING':
      return ANSI.warn;
    case 'INFO':
      return ANSI.info;
    case 'DEBUG':
    case 'TRACE':
      return ANSI.debug;
    default:
      return null;
  }
}

/** Adds ANSI color to a single log line; lines that already contain escape sequences are sanitized and returned as is. */
export function colorizeConsoleLine(line: string): string {
  if (!line || HAS_ANSI.test(line)) return sanitizeAnsi(line);

  // The panel's own notices
  if (ERROR_PREFIXES.some((prefix) => line.startsWith(prefix))) return `${ANSI.error}${line}${RESET}`;
  if (PANEL_PREFIXES.some((prefix) => line.startsWith(prefix))) return `${ANSI.debug}${line}${RESET}`;
  if (line.startsWith(COMMAND_ECHO_PREFIX)) return `${ANSI.command}${line}${RESET}`;

  const match = LEVEL_RE.exec(line);
  if (!match?.[1]) return line;
  const color = colorForLevel(match[1]);
  if (!color) return line;
  return `${color}${line}${RESET}`;
}

/**
 * Streaming coloring: colors complete lines and keeps the unfinished fragment in state.pending.
 * The original line break form (\n or \r\n) is preserved.
 */
export function colorizeConsoleStream(chunk: string, state: ConsoleColorizeState): string {
  const text = state.pending + chunk;
  let out = '';
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10 /* \n */) continue;
    const rawLine = text.slice(start, i);
    const hadCr = rawLine.endsWith('\r');
    const content = hadCr ? rawLine.slice(0, -1) : rawLine;
    out += colorizeConsoleLine(content) + (hadCr ? '\r\n' : '\n');
    start = i + 1;
  }

  state.pending = text.slice(start);
  return out;
}

/** Flushes the unfinished fragment when the connection ends or the history has been written. */
export function flushConsoleColorize(state: ConsoleColorizeState): string {
  if (!state.pending) return '';
  const out = colorizeConsoleLine(state.pending);
  state.pending = '';
  return out;
}
