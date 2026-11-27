import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Accessibility, Copy, Eraser, RefreshCw, Send } from 'lucide-react';
import {
  CONSOLE_CLOSE_RATE_LIMITED,
  CONSOLE_CLOSE_SEND_BACKLOG,
  CONSOLE_CLOSE_SESSION_REVOKED,
  isServerMessageKey,
  type ConsoleMessage,
  type PanelMessageParam,
} from '@mystry/shared';
import { createConsoleTicket } from '../api';
import { copyText } from '../clipboard';
import { errorMessage, isAbortError } from '../errors';
import {
  colorizeConsoleLine,
  colorizeConsoleStream,
  createConsoleColorizeState,
  flushConsoleColorize,
} from '../console-colorize';
import { t as translateNow, tm as translateMessageNow, tp as translatePluralNow, useI18n, type MessageKey } from '../i18n';

type Props = {
  instanceId: string;
  canSend?: boolean;
  /** A server process left running by an earlier panel process: the panel neither streams its log nor sends it commands. */
  detached?: boolean;
};

// The commands themselves are Minecraft commands and not translated; descriptions store string keys, resolved in the current language at render time.
const QUICK_COMMANDS: { label: string; descKey: MessageKey; cmd: string }[] = [
  { label: 'list', descKey: 'console.quick.list', cmd: 'list' },
  { label: 'save-all', descKey: 'console.quick.saveAll', cmd: 'save-all' },
  { label: 'tps', descKey: 'console.quick.tps', cmd: 'tps' },
  { label: 'whitelist list', descKey: 'console.quick.whitelist', cmd: 'whitelist list' },
  { label: 'help', descKey: 'console.quick.help', cmd: 'help' },
];

// Whole lines of panel notices the server writes to the console log: the English pattern is the current form, and the Chinese pattern comes from history buffers left by older versions.
const PROCESS_START_FAILED_RE = /^(?:\[Panel\] Process failed to start: |\[面板\] 进程启动失败：)(.*)$/gm;
const PROCESS_EXITED_RE = /^(?:\[Panel\] Process exited \(exit code (.*?), signal (.*?)\)|\[面板\] 进程已退出（退出码 (.*?)，信号 (.*?)）)$/gm;

// Screen reader mode is a personal preference per browser; when reading or writing it fails (private mode, etc.) it is treated as off.
const SCREEN_READER_KEY = 'mystry_console_screen_reader';

// Close codes the client recovers from by itself, with the reason shown while it reconnects. After a revoked session the
// reconnect asks for a new ticket: a tab whose token was reissued carries on, any other gets a 401 and is sent to sign in.
const RETRYABLE_CLOSE_REASONS: Record<number, MessageKey> = {
  [CONSOLE_CLOSE_SESSION_REVOKED]: 'console.system.sessionChanged',
  [CONSOLE_CLOSE_RATE_LIMITED]: 'console.system.rateLimited',
  [CONSOLE_CLOSE_SEND_BACKLOG]: 'console.system.sendBacklog',
  // "Try again later": the global connection limit frees up as other consoles close or time out.
  1013: 'console.system.tooManyConnections',
};

// WebSocket close codes that indicate a hard limit or policy rejection rather than a transient drop.
const NON_RETRYABLE_CLOSE_MESSAGES: Record<number, MessageKey> = {
  1008: 'console.system.closedPolicy',
  1009: 'console.system.closedTooLarge',
};

function readScreenReaderPreference(): boolean {
  try {
    return localStorage.getItem(SCREEN_READER_KEY) === '1';
  } catch {
    return false;
  }
}

function storeScreenReaderPreference(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(SCREEN_READER_KEY, '1');
    else localStorage.removeItem(SCREEN_READER_KEY);
  } catch {
    // When it cannot be persisted only the next open is affected; the switch works as usual this time.
  }
}

/**
 * xterm's screen reader live region reads at most about 20 lines, after which it only says "too much output" until rebuilt.
 * Turning screen reader mode off and on rebuilds the accessibility layer: it is reset once after the history snapshot is written and once before a command is sent,
 * so the whole history is not read out, and the command's echo can be read.
 */
function resetScreenReaderAnnouncements(term: Terminal): void {
  if (!term.options.screenReaderMode) return;
  term.options.screenReaderMode = false;
  term.options.screenReaderMode = true;
}

/** The "none" placeholder is replaced with a translatable message; the rest (exit code, signal name) is shown as is. */
function exitDetail(value: string): PanelMessageParam {
  return value === 'none' || value === '无' ? { key: 'server.instance.consoleNone' } : value;
}

/** Rewrites panel notice lines written by the server into the current UI language; other output is kept as is. */
function localizePanelLines(text: string): string {
  if (!text.includes('[Panel]') && !text.includes('[面板]')) return text;
  return text
    .replace(PROCESS_START_FAILED_RE, (_line, reason: string) => translateMessageNow({
      key: 'server.instance.consoleProcessStartFailed',
      params: { reason },
    }))
    .replace(PROCESS_EXITED_RE, (_line, enCode?: string, enSignal?: string, zhCode?: string, zhSignal?: string) =>
      translateMessageNow({
        key: 'server.instance.consoleProcessExited',
        params: { code: exitDetail(enCode ?? zhCode ?? ''), signal: exitDetail(enSignal ?? zhSignal ?? '') },
      }));
}

/** Console error frame: shown in the current language when there is a message key, otherwise the server's original text. */
function consoleErrorText(msg: ConsoleMessage): string {
  return isServerMessageKey(msg.code)
    ? translateMessageNow({ key: msg.code, params: msg.params }, msg.data)
    : msg.data;
}

export function ConsolePanel({ instanceId, canSend = true, detached = false }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  const [command, setCommand] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnectStopped, setReconnectStopped] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [screenReaderMode, setScreenReaderMode] = useState(readScreenReaderPreference);
  // The terminal is rebuilt only with the instance; the current switch state is read from a ref at creation, so the switch does not go into the dependencies and cause a disconnect and reconnect.
  const screenReaderModeRef = useRef(screenReaderMode);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);
  const reconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    copyRequestRef.current += 1;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [instanceId]);

  useEffect(() => {
    if (!containerRef.current) return;

    // xterm's screen reader strings are global static values, set in the current UI language before the terminal is created; the terminal is read-only, so the input label is changed to "Console output".
    Terminal.strings.promptLabel = translateNow('console.output.label');
    Terminal.strings.tooMuchOutput = translateNow('console.output.tooMuchOutput');

    const term = new Terminal({
      screenReaderMode: screenReaderModeRef.current,
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      // The terminal area is always dark, with colors taken from the dark variants of Apple's system colors.
      theme: {
        background: '#161618',
        foreground: '#e5e5ea',
        cursor: '#0a84ff',
        selectionBackground: 'rgba(10, 132, 255, 0.35)',
        black: '#1c1c1e',
        red: '#ff453a',
        green: '#30d158',
        yellow: '#ffd60a',
        blue: '#0a84ff',
        magenta: '#bf5af2',
        cyan: '#64d2ff',
        white: '#e5e5ea',
        brightBlack: '#8e8e93',
        brightRed: '#ff6961',
        brightGreen: '#4ade80',
        brightYellow: '#ffe066',
        brightBlue: '#5eb0ff',
        brightMagenta: '#da8fff',
        brightCyan: '#8be4ff',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    let disposed = false;
    let ws: WebSocket | null = null;
    let ticketController: AbortController | null = null;
    const colorState = createConsoleColorizeState();
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

    const writeColored = (chunk: string, flush = false) => {
      const colored = colorizeConsoleStream(localizePanelLines(chunk), colorState);
      if (colored) term.write(colored);
      if (flush) {
        const rest = flushConsoleColorize(colorState);
        if (rest) term.write(rest);
      }
    };

    // The terminal connection side effect is rebuilt only with the instance; notices written to the terminal use the module-level t(), taking strings in the UI language at write time,
    // so t does not go into the dependencies and rebuild the terminal and drop the WebSocket when the language switches.
    const panelPrefix = () => translateNow('console.prefix.panel');

    const writeSystemLine = (line: string) => {
      const rest = flushConsoleColorize(colorState);
      if (rest) term.write(rest);
      term.write('\r\n');
      term.writeln(colorizeConsoleLine(line));
    };

    const scheduleReconnect = (reason: string) => {
      if (disposed) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      retryAttempt += 1;
      writeSystemLine(translatePluralNow('console.system.reconnecting', Math.round(delay / 1000), {
        prefix: panelPrefix(),
        reason,
      }));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      ticketController?.abort();
      const controller = new AbortController();
      ticketController = controller;
      try {
        const { ticket } = await createConsoleTicket(instanceId, controller.signal);
        if (disposed || controller.signal.aborted) return;

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const currentSocket = new WebSocket(
          `${proto}://${location.host}/ws/console/${encodeURIComponent(instanceId)}?ticket=${encodeURIComponent(ticket)}`,
        );
        ws = currentSocket;
        wsRef.current = currentSocket;

        currentSocket.onopen = () => {
          if (disposed || ws !== currentSocket) return;
          setConnected(true);
          setReconnectStopped(false);
        };

        currentSocket.onmessage = (ev) => {
          if (disposed || ws !== currentSocket) return;
          try {
            const msg = JSON.parse(String(ev.data)) as ConsoleMessage;
            if (msg.type === 'history') {
              // Reset reconnect backoff only after the server has actually delivered the history snapshot,
              // so a socket that opens and fails immediately still backs off exponentially.
              const reconnected = retryAttempt > 0;
              retryAttempt = 0;
              // A history frame is the full snapshot buffered by the server: clear the terminal and any unfinished half line first, then write it whole, so logs are not duplicated after a reconnect.
              term.reset();
              colorState.pending = '';
              writeColored(msg.data, true);
              // write is parsed asynchronously: the callback of an empty write fires after the history is parsed and before later writes are parsed,
              // so the history is not read out, while the "reconnected" notice right after it is still announced.
              term.write('', () => {
                if (!disposed) resetScreenReaderAnnouncements(term);
              });
              if (reconnected) {
                writeSystemLine(translateNow('console.system.reconnected', { prefix: panelPrefix() }));
              }
            } else if (msg.type === 'output') {
              writeColored(msg.data);
            }
            if (msg.type === 'error') {
              writeSystemLine(`${translateNow('console.prefix.error')} ${consoleErrorText(msg)}`);
            }
          } catch {
            writeColored(String(ev.data));
          }
        };

        currentSocket.onclose = (ev: CloseEvent) => {
          if (disposed || ws !== currentSocket) return;
          setConnected(false);
          const closeCode = typeof ev?.code === 'number' ? ev.code : undefined;
          const stopKey = closeCode !== undefined ? NON_RETRYABLE_CLOSE_MESSAGES[closeCode] : undefined;
          if (stopKey) {
            setReconnectStopped(true);
            writeSystemLine(translateNow(stopKey, { prefix: panelPrefix() }));
            return;
          }
          const retryKey = closeCode !== undefined ? RETRYABLE_CLOSE_REASONS[closeCode] : undefined;
          scheduleReconnect(translateNow(retryKey ?? 'console.system.disconnected'));
        };
      } catch (err) {
        if (disposed || controller.signal.aborted || isAbortError(err)) return;
        setConnected(false);
        scheduleReconnect(errorMessage(err));
      }
    };

    reconnectRef.current = () => {
      if (disposed) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      ticketController?.abort();
      ws?.close();
      ws = null;
      wsRef.current = null;
      retryAttempt = 0;
      setConnected(false);
      setReconnectStopped(false);
      void connect();
    };

    setReconnectStopped(false);
    void connect();

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      reconnectRef.current = null;
      ticketController?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('resize', onResize);
      flushConsoleColorize(colorState);
      ws?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      setConnected(false);
      setReconnectStopped(false);
    };
  }, [instanceId]);

  useEffect(() => {
    screenReaderModeRef.current = screenReaderMode;
    const term = termRef.current;
    if (term) term.options.screenReaderMode = screenReaderMode;
  }, [screenReaderMode]);

  function toggleScreenReaderMode() {
    const next = !screenReaderMode;
    storeScreenReaderPreference(next);
    setScreenReaderMode(next);
  }

  const inputEnabled = canSend && connected;

  function sendCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (termRef.current) resetScreenReaderAnnouncements(termRef.current);
    ws.send(JSON.stringify({ type: 'command', data: trimmed }));
    const history = historyRef.current;
    if (history[history.length - 1] !== trimmed) {
      history.push(trimmed);
      if (history.length > 50) history.shift();
    }
    historyIndexRef.current = -1;
    draftRef.current = '';
    setCommand('');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!inputEnabled) return;
    sendCommand(command);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const history = historyRef.current;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      if (historyIndexRef.current === -1) {
        draftRef.current = command;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      setCommand(history[historyIndexRef.current] || '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndexRef.current === -1) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        setCommand(history[historyIndexRef.current] || '');
      } else {
        historyIndexRef.current = -1;
        setCommand(draftRef.current);
      }
    }
  }

  function clearScreen() {
    termRef.current?.clear();
  }

  async function copyAll() {
    const requestId = ++copyRequestRef.current;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    const term = termRef.current;
    let message = t('console.copy.empty');
    try {
      term?.selectAll();
      const text = term?.getSelection() ?? '';
      term?.clearSelection();
      if (text.trim()) {
        message = await copyText(text) ? t('console.copy.done') : t('console.copy.failed');
      }
    } catch {
      message = t('console.copy.failed');
    }
    if (requestId !== copyRequestRef.current) return;
    setCopyMessage(message);
    copyTimerRef.current = setTimeout(() => setCopyMessage(''), 6000);
  }

  const connectionTone = detached
    ? 'is-offline'
    : connected ? 'is-online' : reconnectStopped ? 'is-offline' : canSend ? 'is-connecting' : 'is-offline';
  const statusLabel = detached
    ? t('console.status.detached')
    : connected
      ? t('console.status.connected')
      : reconnectStopped
        ? t('console.status.disconnected')
        : canSend
          ? t('console.status.connecting')
          : t('console.status.offline');

  return (
    <div className="console-panel">
      <div className="console-window">
        <div className="console-header-bar">
          <span className={`console-status ${connectionTone}`}>
            <span className="status-dot" aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
          <div className="console-tools">
            {reconnectStopped && (
              <button
                className="console-tool"
                type="button"
                onClick={() => reconnectRef.current?.()}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {t('console.tool.reconnect')}
              </button>
            )}
            <button
              className="console-tool"
              type="button"
              aria-pressed={screenReaderMode}
              title={t('console.tool.screenReaderTitle')}
              onClick={toggleScreenReaderMode}
            >
              <Accessibility size={14} aria-hidden="true" />
              {t('console.tool.screenReader')}
            </button>
            <button
              className="console-tool"
              type="button"
              title={t('console.tool.clear')}
              aria-label={t('console.tool.clear')}
              onClick={clearScreen}
            >
              <Eraser size={14} aria-hidden="true" />
            </button>
            <button
              className="console-tool"
              type="button"
              title={t('console.tool.copyTitle')}
              onClick={() => void copyAll()}
            >
              <Copy size={13} aria-hidden="true" />
              {t('console.tool.copy')}
            </button>
          </div>
        </div>

        <p role="status" aria-live="polite" className="console-copy-status">{copyMessage}</p>
        <div className="console-output" ref={containerRef} />

        <form className="console-input-bar" onSubmit={onSubmit}>
          <span className="console-prompt" aria-hidden="true">&gt;</span>
          <input
            className="console-input"
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!inputEnabled}
            placeholder={inputEnabled
              ? t('console.input.placeholder')
              : detached
                ? t('console.input.placeholderDetached')
                : reconnectStopped
                  ? t('console.input.placeholderDisconnected')
                  : canSend ? t('console.input.placeholderConnecting') : t('console.input.placeholderStopped')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('console.input.label')}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!inputEnabled || !command.trim()}>
            <Send size={13} aria-hidden="true" />
            {t('action.send')}
          </button>
        </form>
      </div>

      <div className="quick-cmd-bar" role="group" aria-label={t('console.quick.label')}>
        <span className="quick-cmd-label">{t('console.quick.label')}</span>
        {QUICK_COMMANDS.map((item) => (
          <button
            key={item.cmd}
            type="button"
            className="chip"
            disabled={!inputEnabled}
            onClick={() => sendCommand(item.cmd)}
            title={t('console.quick.sendTitle', { command: item.cmd })}
          >
            <span className="chip-mono">{item.label}</span>
            <span className="chip-desc">{t(item.descKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
