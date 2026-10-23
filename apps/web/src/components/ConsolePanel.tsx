import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Copy, Eraser, Send } from 'lucide-react';
import { isServerMessageKey, type ConsoleMessage, type PanelMessageParam } from '@mystry/shared';
import { createConsoleTicket } from '../api';
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
};

// 命令本身是 Minecraft 命令，不翻译；说明存文案键，渲染时再取当前语言。
const QUICK_COMMANDS: { label: string; descKey: MessageKey; cmd: string }[] = [
  { label: 'list', descKey: 'console.quick.list', cmd: 'list' },
  { label: 'save-all', descKey: 'console.quick.saveAll', cmd: 'save-all' },
  { label: 'tps', descKey: 'console.quick.tps', cmd: 'tps' },
  { label: 'whitelist list', descKey: 'console.quick.whitelist', cmd: 'whitelist list' },
  { label: 'help', descKey: 'console.quick.help', cmd: 'help' },
];

// 服务端写进控制台日志的面板提示整行：英文句式为当前写法，中文句式来自旧版本留下的历史缓冲。
const PROCESS_START_FAILED_RE = /^(?:\[Panel\] Process failed to start: |\[面板\] 进程启动失败：)(.*)$/gm;
const PROCESS_EXITED_RE = /^(?:\[Panel\] Process exited \(exit code (.*?), signal (.*?)\)|\[面板\] 进程已退出（退出码 (.*?)，信号 (.*?)）)$/gm;

/** 「无」占位换成可翻译消息，其余（退出码、信号名）原样显示。 */
function exitDetail(value: string): PanelMessageParam {
  return value === 'none' || value === '无' ? { key: 'server.instance.consoleNone' } : value;
}

/** 把服务端写入的面板提示行改写为当前界面语言；其余输出原样保留。 */
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

/** 控制台错误帧：有消息键时按当前语言显示，否则显示服务端原文。 */
function consoleErrorText(msg: ConsoleMessage): string {
  return isServerMessageKey(msg.code)
    ? translateMessageNow({ key: msg.code, params: msg.params }, msg.data)
    : msg.data;
}

export function ConsolePanel({ instanceId, canSend = true }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const draftRef = useRef('');

  const [command, setCommand] = useState('');
  const [connected, setConnected] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestRef = useRef(0);

  useEffect(() => () => {
    copyRequestRef.current += 1;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [instanceId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "'SF Mono', ui-monospace, Menlo, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      // 终端区域固定深色，配色取自 Apple 系统色的深色变体。
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
    const ticketRequest = new AbortController();
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

    // 终端连接副作用只随实例重建；写入终端的提示用模块级 t()，按写入时的界面语言取文案，
    // 避免把 t 放进依赖导致切换语言时重建终端并断开 WebSocket。
    const panelPrefix = () => translateNow('console.prefix.panel');

    const writeSystemLine = (line: string) => {
      const rest = flushConsoleColorize(colorState);
      if (rest) term.write(rest);
      term.write('\r\n');
      term.writeln(colorizeConsoleLine(line));
    };

    const scheduleReconnect = (reason: string) => {
      if (disposed) return;
      const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      retryAttempt += 1;
      writeSystemLine(translatePluralNow('console.system.reconnecting', Math.round(delay / 1000), {
        prefix: panelPrefix(),
        reason,
      }));
      retryTimer = setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      try {
        const { ticket } = await createConsoleTicket(instanceId, ticketRequest.signal);
        if (disposed) return;

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(
          `${proto}://${location.host}/ws/console/${encodeURIComponent(instanceId)}?ticket=${encodeURIComponent(ticket)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          if (disposed) return;
          if (retryAttempt > 0) writeSystemLine(translateNow('console.system.reconnected', { prefix: panelPrefix() }));
          retryAttempt = 0;
          setConnected(true);
        };

        ws.onmessage = (ev) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(String(ev.data)) as ConsoleMessage;
            if (msg.type === 'history') {
              writeColored(msg.data, true);
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

        ws.onclose = () => {
          if (disposed) return;
          setConnected(false);
          scheduleReconnect(translateNow('console.system.disconnected'));
        };
      } catch (err) {
        if (disposed || isAbortError(err)) return;
        setConnected(false);
        scheduleReconnect(errorMessage(err));
      }
    };

    void connect();

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      ticketRequest.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('resize', onResize);
      flushConsoleColorize(colorState);
      ws?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      setConnected(false);
    };
  }, [instanceId]);

  const inputEnabled = canSend && connected;

  function sendCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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
        if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
        await navigator.clipboard.writeText(text);
        message = t('console.copy.done');
      }
    } catch {
      message = t('console.copy.failed');
    }
    if (requestId !== copyRequestRef.current) return;
    setCopyMessage(message);
    copyTimerRef.current = setTimeout(() => setCopyMessage(''), 6000);
  }

  const connectionTone = connected ? 'is-online' : canSend ? 'is-connecting' : 'is-offline';

  return (
    <div className="console-panel">
      <div className="console-window">
        <div className="console-header-bar">
          <span className={`console-status ${connectionTone}`}>
            <span className="status-dot" aria-hidden="true" />
            <span>{connected ? t('console.status.connected') : canSend ? t('console.status.connecting') : t('console.status.offline')}</span>
          </span>
          <div className="console-tools">
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

      {/* 快捷命令按钮栏 */}
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
