import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Copy, Eraser, Send } from 'lucide-react';
import type { ConsoleMessage } from '@mystry/shared';
import { createConsoleTicket } from '../api';
import { errorMessage, isAbortError } from '../errors';
import {
  colorizeConsoleLine,
  colorizeConsoleStream,
  createConsoleColorizeState,
  flushConsoleColorize,
} from '../console-colorize';

type Props = {
  instanceId: string;
  canSend?: boolean;
};

const QUICK_COMMANDS = [
  { label: 'list', desc: '玩家列表', cmd: 'list' },
  { label: 'save-all', desc: '保存世界', cmd: 'save-all' },
  { label: 'tps', desc: '刻率性能', cmd: 'tps' },
  { label: 'whitelist list', desc: '白名单', cmd: 'whitelist list' },
  { label: 'help', desc: '命令帮助', cmd: 'help' },
];

export function ConsolePanel({ instanceId, canSend = true }: Props) {
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
      const colored = colorizeConsoleStream(chunk, colorState);
      if (colored) term.write(colored);
      if (flush) {
        const rest = flushConsoleColorize(colorState);
        if (rest) term.write(rest);
      }
    };

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
      writeSystemLine(`[面板] ${reason}，${Math.round(delay / 1000)} 秒后重连…`);
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
          if (retryAttempt > 0) writeSystemLine('[面板] 控制台已重新连接');
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
              writeSystemLine(`[错误] ${msg.data}`);
            }
          } catch {
            writeColored(String(ev.data));
          }
        };

        ws.onclose = () => {
          if (disposed) return;
          setConnected(false);
          scheduleReconnect('控制台连接已断开');
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
    let message = '暂无可复制的日志。';
    try {
      term?.selectAll();
      const text = term?.getSelection() ?? '';
      term?.clearSelection();
      if (text.trim()) {
        if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
        await navigator.clipboard.writeText(text);
        message = '日志已复制。';
      }
    } catch {
      message = '复制失败：浏览器剪贴板不可用或权限被拒绝，请手动选择日志并复制。';
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
            <span>{connected ? '实时日志 · 已连接' : canSend ? '控制台正在连接…' : '实例未运行'}</span>
          </span>
          <div className="console-tools">
            <button
              className="console-tool"
              type="button"
              title="清空屏幕"
              aria-label="清空屏幕"
              onClick={clearScreen}
            >
              <Eraser size={14} aria-hidden="true" />
            </button>
            <button
              className="console-tool"
              type="button"
              title="复制全部输出"
              onClick={() => void copyAll()}
            >
              <Copy size={13} aria-hidden="true" />
              复制日志
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
            placeholder={inputEnabled ? '输入控制台命令（如 list、say Hello、op 玩家名），按回车发送' : canSend ? '连接中…' : '实例已停止，启动后可发送命令'}
            autoComplete="off"
            spellCheck={false}
            aria-label="控制台命令"
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={!inputEnabled || !command.trim()}>
            <Send size={13} aria-hidden="true" />
            发送
          </button>
        </form>
      </div>

      {/* 快捷命令按钮栏 */}
      <div className="quick-cmd-bar" role="group" aria-label="常用命令">
        <span className="quick-cmd-label">常用命令</span>
        {QUICK_COMMANDS.map((item) => (
          <button
            key={item.cmd}
            type="button"
            className="chip"
            disabled={!inputEnabled}
            onClick={() => sendCommand(item.cmd)}
            title={`向服务器发送 /${item.cmd}`}
          >
            <span className="chip-mono">{item.label}</span>
            <span className="chip-desc">{item.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
