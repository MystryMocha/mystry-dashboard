import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerMessageKey } from '@mystry/shared';
import { config } from '../config.js';
import { panelErrorBody } from './errors.js';

type TimeoutHandle = {
  cancel: () => void;
};

const activeRequestTimeouts = new WeakMap<FastifyRequest, TimeoutHandle>();
/** Grace window after sending 408 + FIN so the client can read the error JSON before forcing a reset. */
const TIMEOUT_SOCKET_DESTROY_GRACE_MS = 500;

function sendTimeoutAndClose(
  req: FastifyRequest,
  reply: FastifyReply,
  messageKey: ServerMessageKey,
): void {
  const rawReq = req.raw;
  const socket = reply.raw.socket ?? rawReq.socket;
  if (!reply.sent && !reply.raw.headersSent && !reply.raw.destroyed) {
    reply.hijack();
    const body = JSON.stringify(panelErrorBody(messageKey));
    reply.raw.writeHead(408, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    reply.raw.end(body, () => {
      if (!socket || socket.destroyed) return;
      socket.end();
      const destroyTimer = setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, TIMEOUT_SOCKET_DESTROY_GRACE_MS);
      destroyTimer.unref();
      socket.once('close', () => clearTimeout(destroyTimer));
    });
    return;
  }
  rawReq.destroy();
}

/**
 * Enforces a total receive deadline (`requestTimeoutMs`) on regular requests while letting authenticated streaming
 * upload handlers switch to an inactivity timeout via `switchToStreamingUploadTimeout`.
 *
 * Node's built-in `http.Server.requestTimeout` is global per server and cuts off multi-gigabyte streaming uploads on
 * slow links even while bytes flow continuously. Running the server with `requestTimeout: 0` (while keeping
 * `headersTimeout` enabled against slow headers) and enforcing the deadline per request here protects ordinary API
 * routes without breaking large uploads.
 */
export function attachRequestTimeoutHook(
  app: FastifyInstance,
  requestTimeoutMs = config.httpRequestTimeoutMs,
): void {
  if (requestTimeoutMs <= 0) return;

  app.addHook('onRequest', async (req, reply) => {
    const rawReq = req.raw;
    if (rawReq.readableEnded || rawReq.destroyed) return;

    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rawReq.off('end', cancel);
      rawReq.off('close', cancel);
      reply.raw.off('close', cancel);
      reply.raw.off('finish', cancel);
      activeRequestTimeouts.delete(req);
    };

    timer = setTimeout(() => {
      if (cancelled || rawReq.readableEnded || reply.raw.writableEnded) {
        cancel();
        return;
      }
      cancel();
      sendTimeoutAndClose(req, reply, 'server.common.requestTimeout');
    }, requestTimeoutMs);
    timer.unref();

    rawReq.once('end', cancel);
    rawReq.once('close', cancel);
    reply.raw.once('close', cancel);
    reply.raw.once('finish', cancel);
    activeRequestTimeouts.set(req, { cancel });
  });
}

/**
 * Switches an authenticated streaming upload request from the total-duration request deadline to an inactivity timeout
 * (`uploadIdleTimeoutMs`). The inactivity timeout is cleared as soon as the request body ends so post-upload work
 * (such as streaming SHA-256 verification of a multi-gigabyte backup archive) is never aborted as idle.
 */
export function switchToStreamingUploadTimeout(
  req: FastifyRequest,
  reply: FastifyReply,
  idleTimeoutMs = config.uploadIdleTimeoutMs,
): void {
  activeRequestTimeouts.get(req)?.cancel();

  const rawReq = req.raw;
  if (
    idleTimeoutMs <= 0
    || rawReq.readableEnded
    || rawReq.destroyed
    || typeof rawReq.setTimeout !== 'function'
  ) {
    return;
  }

  let cleared = false;
  const clearIdle = () => {
    if (cleared) return;
    cleared = true;
    rawReq.off('end', clearIdle);
    rawReq.off('close', clearIdle);
    reply.raw.off('close', clearIdle);
    reply.raw.off('finish', clearIdle);
    try {
      rawReq.setTimeout(0);
    } catch {
      /* Socket may already be closed. */
    }
  };

  rawReq.setTimeout(idleTimeoutMs, () => {
    if (cleared || rawReq.readableEnded) return;
    clearIdle();
    sendTimeoutAndClose(req, reply, 'server.files.upload.idleTimeout');
  });

  rawReq.once('end', clearIdle);
  rawReq.once('close', clearIdle);
  reply.raw.once('close', clearIdle);
  reply.raw.once('finish', clearIdle);
}
