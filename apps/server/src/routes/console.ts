import type { FastifyInstance } from 'fastify';
import {
  CONSOLE_CLOSE_RATE_LIMITED,
  CONSOLE_CLOSE_SEND_BACKLOG,
  CONSOLE_CLOSE_SESSION_REVOKED,
  renderPanelMessage,
  type ConsoleMessage,
  type InstanceStatus,
  type PanelMessageParams,
  type ServerMessageKey,
} from '@mystry/shared';
import { config } from '../config.js';
import { errorMessage, panelErrorBody, toPanelMessage } from '../utils/errors.js';
import { processManager } from '../services/process-manager.js';
import { getInstance } from '../services/instance-service.js';
import { issueConsoleTicket, consumeConsoleTicket } from '../services/console-ticket-service.js';
import { onUserSessionsRevoked } from '../services/session-revocation-service.js';

const { maxConsoleBufferBytes, maxConsoleChunkBytes } = config;
const maxIncomingMessageBytes = config.maxConsoleIncomingBytes;
const maxOutgoingMessageBytes = maxConsoleBufferBytes + maxConsoleChunkBytes;
const maxSocketBufferedBytes = maxConsoleBufferBytes + maxConsoleChunkBytes;

let activeConsoleConnections = 0;

type ConsoleSocket = {
  readyState: number;
  bufferedAmount: number;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
};

const socketClosedState = 3;

/** Console connections that passed the ticket check, with the user they belong to; used to drop connections opened by an old sign-in when the password is changed or reset. */
const authenticatedSockets = new Map<ConsoleSocket, string>();

function closeSocket(
  socket: ConsoleSocket,
  code = 1000,
  reason = '',
): void {
  if (socket.readyState === 0 || socket.readyState === 1) {
    try {
      socket.close(code, reason);
    } catch {
      // The connection may already be closing.
    }
  }
}

function terminateSocketLater(socket: ConsoleSocket): void {
  const timer = setTimeout(() => {
    if (socket.readyState === socketClosedState) return;
    try {
      if (socket.terminate) {
        socket.terminate();
      } else {
        socket.close(1000, 'Console connection close timed out');
      }
    } catch {
      // The connection may already have been closed by the lower layer.
    }
  }, 1_000);
  timer.unref?.();
}

/** UTF-8 byte length of a single Unicode code point (or lone surrogate) after JSON string escaping, excluding outer quotes. */
export function jsonEscapedCharBytes(codePoint: number): number {
  if (
    codePoint === 0x08
    || codePoint === 0x09
    || codePoint === 0x0A
    || codePoint === 0x0C
    || codePoint === 0x0D
    || codePoint === 0x22
    || codePoint === 0x5C
  ) {
    return 2;
  }
  // Control characters and lone surrogates are escaped as \uXXXX by JSON.stringify.
  if (codePoint < 0x20 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
    return 6;
  }
  if (codePoint <= 0x7F) return 1;
  if (codePoint <= 0x7FF) return 2;
  if (codePoint <= 0xFFFF) return 3;
  return 4;
}

/** Trims oldest characters from console history so the JSON-serialized history frame fits within maxFrameBytes. */
export function fitConsoleHistory(
  history: string,
  status: InstanceStatus,
  maxFrameBytes: number,
): string {
  if (maxFrameBytes <= 0 || history.length === 0) return '';
  const fullBytes = Buffer.byteLength(
    JSON.stringify({ type: 'history', data: history, status }),
    'utf8',
  );
  if (fullBytes <= maxFrameBytes) return history;

  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ type: 'history', data: '', status }),
    'utf8',
  );
  const dataBudget = maxFrameBytes - emptyBytes;
  if (dataBudget <= 0) return '';

  let usedBytes = 0;
  let startIndex = history.length;
  while (startIndex > 0) {
    let step = 1;
    const tailCode = history.charCodeAt(startIndex - 1);
    let codePoint = tailCode;
    if (tailCode >= 0xDC00 && tailCode <= 0xDFFF && startIndex >= 2) {
      const leadCode = history.charCodeAt(startIndex - 2);
      if (leadCode >= 0xD800 && leadCode <= 0xDBFF) {
        codePoint = ((leadCode - 0xD800) << 10) + (tailCode - 0xDC00) + 0x10000;
        step = 2;
      }
    }
    const charBytes = jsonEscapedCharBytes(codePoint);
    if (usedBytes + charBytes > dataBudget) break;
    usedBytes += charBytes;
    startIndex -= step;
  }
  return history.slice(skipPartialCsiSequence(history, startIndex));
}

/** Longest CSI sequence worth looking back for; real SGR and cursor sequences are far shorter. */
const MAX_CSI_LOOKBACK = 64;

/**
 * When a cut lands inside a CSI escape sequence (`ESC [ params final`), returns the index just past that sequence so
 * the client does not render a literal fragment such as `31m`. Moving the cut backwards is not an option because the
 * preceding characters are exactly the ones that did not fit the budget.
 */
function skipPartialCsiSequence(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return start;
  const escIndex = text.lastIndexOf('\x1b', start - 1);
  if (escIndex === -1 || start - escIndex > MAX_CSI_LOOKBACK || text[escIndex + 1] !== '[') return start;
  let index = escIndex + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x3F) break;
    index += 1;
  }
  // `index` is now at the final byte; a sequence that already ended before the cut leaves the cut untouched.
  return Math.max(start, Math.min(index + 1, text.length));
}

/**
 * Splits an output chunk into pieces whose JSON-serialized output frames each fit within maxFrameBytes.
 * Returns null when the budget cannot hold even a single character, so the caller closes the connection instead of
 * silently dropping output.
 */
export function splitOutputForJsonBudget(
  text: string,
  maxFrameBytes: number,
): string[] | null {
  if (!text) return [];
  const fullBytes = Buffer.byteLength(
    JSON.stringify({ type: 'output', data: text }),
    'utf8',
  );
  if (fullBytes <= maxFrameBytes) return [text];

  const emptyBytes = Buffer.byteLength(
    JSON.stringify({ type: 'output', data: '' }),
    'utf8',
  );
  const dataBudget = maxFrameBytes - emptyBytes;
  if (dataBudget <= 0) return null;

  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  let index = 0;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const unitLength = codePoint > 0xFFFF ? 2 : 1;
    const charBytes = jsonEscapedCharBytes(codePoint);
    if (charBytes > dataBudget) return null;
    if (chunkBytes + charBytes > dataBudget) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += charBytes;
    index += unitLength;
  }
  if (chunkStart < text.length) {
    chunks.push(text.slice(chunkStart));
  }
  return chunks;
}

export function sendSocketMessage(
  socket: {
    readyState: number;
    bufferedAmount: number;
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
  },
  payload: ConsoleMessage,
): boolean {
  if (socket.readyState !== 1) return false;
  const message = JSON.stringify(payload);
  const messageBytes = Buffer.byteLength(message, 'utf8');
  if (messageBytes > maxOutgoingMessageBytes) {
    closeSocket(socket, 1009, 'Console message too large');
    terminateSocketLater(socket);
    return false;
  }
  // A slow client is a passing condition, unlike an oversized frame: it gets its own code so the browser reconnects.
  if (socket.bufferedAmount + messageBytes > maxSocketBufferedBytes) {
    closeSocket(socket, CONSOLE_CLOSE_SEND_BACKLOG, 'Console send buffer full');
    terminateSocketLater(socket);
    return false;
  }
  try {
    socket.send(message);
    return true;
  } catch {
    closeSocket(socket, 1011, 'Console send failed');
    terminateSocketLater(socket);
    return false;
  }
}

/** Console error frame: data is English text; code / params are for Web to translate into the current language. */
function errorFrame(key: ServerMessageKey, params?: PanelMessageParams): ConsoleMessage {
  const frame: ConsoleMessage = { type: 'error', data: renderPanelMessage({ key, params }), code: key };
  if (params) frame.params = params;
  return frame;
}

function rawMessageToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

function rawMessageByteLength(raw: unknown): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + (Buffer.isBuffer(part) ? part.byteLength : Buffer.byteLength(String(part), 'utf8')), 0);
  }
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return Buffer.byteLength(String(raw), 'utf8');
}

export async function consoleRoutes(app: FastifyInstance): Promise<void> {
  // The connection is established with a one-time ticket and the JWT is not checked again afterwards; when the session is revoked it is dropped proactively, and the client reconnects with the new token.
  const unsubscribeRevocation = onUserSessionsRevoked((userId) => {
    for (const [socket, ownerId] of authenticatedSockets) {
      if (ownerId !== userId) continue;
      authenticatedSockets.delete(socket);
      closeSocket(socket, CONSOLE_CLOSE_SESSION_REVOKED, 'Session revoked');
      terminateSocketLater(socket);
    }
  });
  app.addHook('onClose', async () => {
    unsubscribeRevocation();
  });

  app.post<{ Params: { id: string } }>(
    '/api/instances/:id/console-ticket',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.instance.notFound'));
      return issueConsoleTicket(req.user.id, req.params.id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>(
    '/ws/console/:id',
    { websocket: true },
    async (socket, req) => {
      if (activeConsoleConnections >= config.maxConsoleConnections) {
        closeSocket(socket, 1013, 'Too many console connections');
        terminateSocketLater(socket);
        return;
      }

      activeConsoleConnections += 1;
      let connectionReleased = false;
      let detachRealtimeListeners: (() => void) | null = null;
      const releaseConnection = () => {
        if (connectionReleased) return;
        connectionReleased = true;
        detachRealtimeListeners?.();
        authenticatedSockets.delete(socket);
        activeConsoleConnections -= 1;
      };
      socket.on('close', releaseConnection);
      socket.on('error', () => {
        // Release the count only after close, so active connections are not undercounted when error fires before close.
        closeSocket(socket, 1011, 'Console connection error');
        terminateSocketLater(socket);
      });

      try {
        const ticket = req.query.ticket;
        if (!ticket) {
          sendSocketMessage(socket, errorFrame('server.instance.consoleTicketMissing'));
          closeSocket(socket);
          terminateSocketLater(socket);
          return;
        }
        const owner = consumeConsoleTicket(ticket, req.params.id);
        if (!owner) {
          sendSocketMessage(socket, errorFrame('server.instance.consoleTicketInvalid'));
          closeSocket(socket);
          terminateSocketLater(socket);
          return;
        }
        authenticatedSockets.set(socket, owner.userId);
      } catch {
        sendSocketMessage(socket, errorFrame('server.common.unauthorized'));
        closeSocket(socket);
        terminateSocketLater(socket);
        return;
      }

      const instanceId = req.params.id;
      if (!getInstance(instanceId)) {
        sendSocketMessage(socket, errorFrame('server.instance.notFound'));
        closeSocket(socket);
        terminateSocketLater(socket);
        return;
      }

      let commandWindowStartedAt = Date.now();
      let commandCount = 0;
      const status = processManager.getStatus(instanceId);
      const statusPayload: ConsoleMessage = { type: 'status', data: '', status };
      const statusBytes = Buffer.byteLength(JSON.stringify(statusPayload), 'utf8');
      // Reserve space for the synchronous status frame so history + status never exceed maxSocketBufferedBytes.
      const maxHistoryBytes = Math.max(0, maxOutgoingMessageBytes - statusBytes - 1024);
      const history = fitConsoleHistory(processManager.getHistory(instanceId), status, maxHistoryBytes);
      if (!sendSocketMessage(socket, {
        type: 'history',
        data: history,
        status,
      })) {
        terminateSocketLater(socket);
        return;
      }
      if (!sendSocketMessage(socket, statusPayload)) {
        terminateSocketLater(socket);
        return;
      }

      const onOutput = (id: string, text: string) => {
        if (id !== instanceId) return;
        if (Buffer.byteLength(text, 'utf8') > maxConsoleChunkBytes) {
          closeSocket(socket, 1009, 'Console output message too large');
          return;
        }
        const chunks = splitOutputForJsonBudget(text, maxOutgoingMessageBytes);
        if (!chunks) {
          closeSocket(socket, 1009, 'Console output message too large');
          return;
        }
        for (const chunk of chunks) {
          if (!sendSocketMessage(socket, { type: 'output', data: chunk })) return;
        }
      };
      const onStatus = (id: string, status: InstanceStatus) => {
        if (id !== instanceId) return;
        sendSocketMessage(socket, { type: 'status', data: '', status });
      };

      processManager.on('output', onOutput);
      processManager.on('status', onStatus);
      detachRealtimeListeners = () => {
        processManager.off('output', onOutput);
        processManager.off('status', onStatus);
      };

      socket.on('message', (raw) => {
        try {
          if (rawMessageByteLength(raw) > maxIncomingMessageBytes) {
            sendSocketMessage(socket, errorFrame('server.instance.consoleMessageTooLarge', { limit: maxIncomingMessageBytes }));
            closeSocket(socket, 1009, 'Console message too large');
            return;
          }
          const rawText = rawMessageToString(raw);
          const msg = JSON.parse(rawText) as { type?: string; data?: string };
          if (msg.type !== 'command' || typeof msg.data !== 'string') return;

          const now = Date.now();
          if (now - commandWindowStartedAt >= config.consoleCommandWindowMs) {
            commandWindowStartedAt = now;
            commandCount = 0;
          }
          if (commandCount >= config.maxConsoleCommandsPerWindow) {
            sendSocketMessage(socket, errorFrame('server.instance.consoleCommandRateLimited'));
            closeSocket(socket, CONSOLE_CLOSE_RATE_LIMITED, 'Commands sent too often');
            return;
          }
          commandCount += 1;
          processManager.sendCommand(instanceId, msg.data);
        } catch (err) {
          const message = toPanelMessage(err);
          sendSocketMessage(socket, message
            ? errorFrame(message.key, message.params)
            : { type: 'error', data: errorMessage(err) });
        }
      });

    },
  );
}
