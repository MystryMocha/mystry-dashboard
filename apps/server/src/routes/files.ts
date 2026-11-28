import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  fileDownloadQuerySchema,
  fileDownloadTicketBodySchema,
  type ApiErrorBody,
  type ServerMessageKey,
  type TextFileSaveRequest,
} from '@mystry/shared';
import { config } from '../config.js';
import {
  acquireFileDownloadSlot,
  assertTextFileWithinLimit,
  deletePath,
  getAbsoluteFilePath,
  isFileDownloadCapacityError,
  listFiles,
  mkdirPath,
  readTextFile,
  renamePath,
  saveUploadedFile,
  writeTextFile,
} from '../services/file-service.js';
import {
  beginDownloadStream,
  cancelReservedDownloadTicket,
  completeDownloadStream,
  failDownloadStream,
  getDownloadTicketStatus,
  reserveDownloadTicket,
  type DownloadTicketFailure,
} from '../services/download-ticket-service.js';
import { noteInstanceFilesChanged } from '../services/backup-schedule-service.js';
import { getInstance } from '../services/instance-service.js';
import { processManager } from '../services/process-manager.js';
import {
  previewServerPropertiesWrite,
  writeServerProperties,
  readServerProperties,
} from '../services/config-service.js';
import { sendRouteError } from '../http-errors.js';
import { errorBody, errorMessage, isPanelError, PanelError, panelErrorBody, toPanelMessage } from '../utils/errors.js';
import { switchToStreamingUploadTimeout } from '../utils/request-timeout.js';

const { maxTextFileBytes } = config;
const maxPathLength = 1_024;
const maxPropertyKeys = 256;
const maxPropertyKeyLength = 256;

const optionalPathQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { path: { type: 'string', maxLength: maxPathLength } },
} as const;

const requiredPathQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: { path: { type: 'string', maxLength: maxPathLength } },
} as const;

const textContentBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', maxLength: maxPathLength },
    content: { type: 'string', maxLength: maxTextFileBytes },
    onConflict: { type: 'string', enum: ['fail', 'overwrite'] },
  },
} as const;

/**
 * Body limit of the text save endpoint. The content travels as a JSON string, where one UTF-8 byte can take up to six bytes
 * (a control character becomes `\u00XX`), so under the general JSON limit a file within the text limit could be opened but not
 * saved. Sized for the worst case of both fields plus the JSON punctuation around them, and never below the general limit.
 */
const JSON_STRING_MAX_BYTES_PER_UTF8_BYTE = 6;
const textContentBodyLimit = Math.max(
  config.maxJsonBodyBytes,
  // The path limit counts characters, and no character takes more than six bytes in JSON either.
  (maxTextFileBytes + maxPathLength) * JSON_STRING_MAX_BYTES_PER_UTF8_BYTE + 64,
);

const pathBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: { path: { type: 'string', maxLength: maxPathLength } },
} as const;

const renameBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: { type: 'string', maxLength: maxPathLength },
    to: { type: 'string', maxLength: maxPathLength },
  },
} as const;

const serverPropertiesBodySchema = {
  type: 'object',
  maxProperties: maxPropertyKeys,
  propertyNames: { type: 'string', minLength: 1, maxLength: maxPropertyKeyLength },
  additionalProperties: { type: 'string', maxLength: maxTextFileBytes },
} as const;

/** A restore replaces the whole instance directory; all modifying file operations are rejected meanwhile, so changes do not land in the old directory that is about to be replaced. */
function rejectWhileRestoring(instanceId: string): void {
  if (processManager.getMaintenance(instanceId) === 'server.backups.busyRestoring') {
    throw new PanelError('server.backups.busyRestoring', undefined, { statusCode: 409 });
  }
}

/**
 * File manager delete. The removal yields to the event loop while it works through the tree, so the check made before it is not
 * enough on its own: the delete takes the instance lock, which a restore also holds while it swaps the instance directory, so the
 * two cannot interleave. A restore may enter maintenance while this call waits for the lock, hence the second check inside it.
 */
export async function deleteInstancePath(instanceId: string, relativePath: string): Promise<void> {
  rejectWhileRestoring(instanceId);
  await processManager.runExclusive(instanceId, async () => {
    rejectWhileRestoring(instanceId);
    try {
      await deletePath(instanceId, relativePath);
    } finally {
      // Also when it failed: a folder may have been removed in part by then.
      noteInstanceFilesChanged(instanceId);
    }
  });
}

/** The instance's server process: the one the panel started, or one still running from before the panel restarted. */
function serverPids(instanceId: string): number[] {
  const started = processManager.getMetricTargets().find((target) => target.id === instanceId)?.pid;
  const detached = processManager.getOrphanProcess(instanceId)?.pid;
  return [started, detached].filter((pid): pid is number => typeof pid === 'number');
}

function validationMessage(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, key: ServerMessageKey) {
  return reply.code(400).send(panelErrorBody(key));
}

/** A failure to open the stream only exposes "file does not exist / not a regular file"; all other causes (including path validation) are reported as "failed to open file". */
function fileOpenErrorBody(err: unknown): ApiErrorBody {
  if (isPanelError(err)
    && (err.messageKey === 'server.files.fileNotFound' || err.messageKey === 'server.files.notRegularFile')) {
    return errorBody(err);
  }
  return panelErrorBody('server.files.download.openFailed');
}

/** Uses the basename only, with an RFC 5987 filename* attached; path injection is not allowed. */
function contentDispositionAttachment(fileName: string): string {
  const basename = path.basename(fileName);
  const asciiFallback = basename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(basename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function isDownloadRoute(req: FastifyRequest): boolean {
  const routePath = req.routeOptions.url;
  return routePath === '/api/instances/:id/files/download';
}

export function waitForDownloadStreamOpen(stream: EventEmitter): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('open', onOpen);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new PanelError('server.files.download.aborted'));
    };
    stream.once('open', onOpen);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

/**
 * Streams a file: the download slot and ticket state are each settled once on completion, failure, idle timeout or disconnect.
 * activeTicket is set to null after settling, and the caller's catch uses that to tell whether it still needs to mark a failure.
 */
export async function sendFileStream(
  reply: FastifyReply,
  abs: string,
  downloadName: string,
  activeTicket: { value: string | null },
  releaseDownload: (() => void) | null,
) {
  const stream = fs.createReadStream(abs);
  let responseStarted = false;
  let cleaned = false;
  function releaseResources(): void {
    try {
      reply.raw.setTimeout(0);
    } catch {
      // The response may already be closed.
    }
    reply.raw.off('finish', finishSuccess);
    reply.raw.off('close', onConnectionClosed);
    stream.off('error', onStreamError);
    stream.off('close', onStreamClosed);
    if (!stream.destroyed) stream.destroy();
  }
  function finishSuccess(): void {
    if (cleaned) return;
    cleaned = true;
    releaseDownload?.();
    if (activeTicket.value) {
      completeDownloadStream(activeTicket.value);
      activeTicket.value = null;
    }
    releaseResources();
  }
  function finishFailure(reason: DownloadTicketFailure): void {
    if (cleaned) return;
    cleaned = true;
    releaseDownload?.();
    if (activeTicket.value) {
      failDownloadStream(activeTicket.value, reason);
      activeTicket.value = null;
    }
    releaseResources();
  }
  function onStreamError(error: Error): void {
    // Node.js stream errors keep their original text; a translatable fallback message is used when there is no text.
    finishFailure(error.message || { key: 'server.files.download.readFailed' });
    if (responseStarted && !reply.raw.destroyed) {
      reply.raw.destroy();
    }
  }
  function onStreamClosed(): void {
    if (stream.readableEnded) return;
    finishFailure({ key: 'server.files.download.aborted' });
    if (responseStarted && !reply.raw.destroyed) reply.raw.destroy();
  }
  function onConnectionClosed(): void {
    if (!reply.raw.writableFinished) finishFailure({ key: 'server.files.download.aborted' });
  }
  stream.once('close', onStreamClosed);
  stream.once('error', onStreamError);
  reply.raw.once('finish', finishSuccess);
  reply.raw.once('close', onConnectionClosed);
  reply.raw.setTimeout(config.fileDownloadIdleTimeoutMs, () => {
    if (cleaned) return;
    finishFailure({ key: 'server.files.download.idleTimeout' });
    if (!reply.raw.destroyed) reply.raw.destroy();
  });
  if (reply.raw.destroyed) {
    finishFailure({ key: 'server.files.download.aborted' });
    throw new PanelError('server.files.download.aborted');
  }
  await waitForDownloadStreamOpen(stream);
  responseStarted = true;
  return reply
    .header('Content-Disposition', contentDispositionAttachment(downloadName))
    .type('application/octet-stream')
    .send(stream);
}

type DownloadTicketCancelRouteResult =
  | { statusCode: 204 }
  | { statusCode: 409; error: ApiErrorBody }
  | { statusCode: 404; error: ApiErrorBody };

export function cancelDownloadTicketRoute(
  ticket: string,
  userId: string,
  instanceId: string,
): DownloadTicketCancelRouteResult {
  const result = cancelReservedDownloadTicket(ticket, userId, instanceId);
  if (result === 'cancelled') return { statusCode: 204 };
  if (result === 'streaming') return { statusCode: 409, error: panelErrorBody('server.files.download.ticketStreaming') };
  return { statusCode: 404, error: panelErrorBody('server.files.download.ticketNotFoundCancel') };
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Downloads can use a one-time ticket instead of the JWT (native browser navigation cannot send Authorization).
  // The check runs in onRequest, before the body is read: a request that is not signed in must not get a body parsed for it.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isDownloadRoute(req)) {
      const ticket = (req.query as { ticket?: string }).ticket;
      if (typeof ticket === 'string' && ticket.length > 0) return;
    }
    return app.authenticate(req, reply);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files',
    { attachValidation: true, schema: { querystring: optionalPathQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.path');
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      try {
        return listFiles(req.params.id, req.query.path || '');
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/instances/:id/files/content',
    { attachValidation: true, schema: { querystring: requiredPathQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.path');
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      try {
        const { content, binary } = readTextFile(req.params.id, req.query.path);
        return { path: req.query.path, content, binary };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: TextFileSaveRequest }>(
    '/api/instances/:id/files/content',
    { attachValidation: true, bodyLimit: textContentBodyLimit, schema: { body: textContentBodySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.textBody');
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      try {
        rejectWhileRestoring(req.params.id);
        writeTextFile(req.params.id, req.body.path, req.body.content, {
          onConflict: req.body.onConflict,
          serverPids: serverPids(req.params.id),
        });
        noteInstanceFilesChanged(req.params.id);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { path: string } }>(
    '/api/instances/:id/files',
    { attachValidation: true, schema: { querystring: requiredPathQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.path');
      try {
        await deleteInstancePath(req.params.id, req.query.path);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/api/instances/:id/files/mkdir',
    { attachValidation: true, schema: { body: pathBodySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.dirBody');
      try {
        rejectWhileRestoring(req.params.id);
        mkdirPath(req.params.id, req.body.path);
        noteInstanceFilesChanged(req.params.id);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/api/instances/:id/files/rename',
    { attachValidation: true, schema: { body: renameBodySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.renameBody');
      try {
        rejectWhileRestoring(req.params.id);
        renamePath(req.params.id, req.body.from, req.body.to);
        noteInstanceFilesChanged(req.params.id);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/api/instances/:id/files/download-ticket',
    { attachValidation: true, schema: { body: fileDownloadTicketBodySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.pathBody');
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      let releaseDownload: (() => void) | null = null;
      try {
        getAbsoluteFilePath(req.params.id, req.body.path);
        releaseDownload = acquireFileDownloadSlot();
        return reserveDownloadTicket(
          req.user.id,
          req.params.id,
          req.body.path,
          releaseDownload,
        );
      } catch (err) {
        releaseDownload?.();
        if (isFileDownloadCapacityError(err)) {
          return reply.code(429).send(errorBody(err));
        }
        return reply.code(400).send(fileOpenErrorBody(err));
      }
    },
  );

  app.get<{ Params: { id: string; ticket: string } }>(
    '/api/instances/:id/files/download-ticket/:ticket/status',
    async (req, reply) => {
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      const status = getDownloadTicketStatus(req.params.ticket, req.user.id);
      if (!status) return reply.code(404).send(panelErrorBody('server.files.download.ticketNotFoundView'));
      return status;
    },
  );

  app.delete<{ Params: { id: string; ticket: string } }>(
    '/api/instances/:id/files/download-ticket/:ticket',
    async (req, reply) => {
      const result = cancelDownloadTicketRoute(req.params.ticket, req.user.id, req.params.id);
      if (result.statusCode === 204) return reply.code(204).send();
      return reply.code(result.statusCode).send(result.error);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path: string; ticket?: string } }>(
    '/api/instances/:id/files/download',
    { attachValidation: true, schema: { querystring: fileDownloadQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.path');
      const ticketParam = req.query.ticket;
      const hasTicket = typeof ticketParam === 'string' && ticketParam.length > 0;
      const ticketRef = { value: hasTicket ? ticketParam : null };
      if (hasTicket) {
        const began = beginDownloadStream(ticketParam, req.params.id, req.query.path);
        if (!began) return reply.code(401).send(panelErrorBody('server.files.download.linkExpired'));
      }
      let releaseDownload: (() => void) | null = null;
      try {
        const abs = getAbsoluteFilePath(req.params.id, req.query.path);
        if (!hasTicket) {
          releaseDownload = acquireFileDownloadSlot();
        }
        return await sendFileStream(reply, abs, path.basename(abs), ticketRef, releaseDownload);
      } catch (err) {
        if (ticketRef.value) {
          failDownloadStream(
            ticketRef.value,
            err instanceof Error
              ? toPanelMessage(err) ?? errorMessage(err)
              : { key: 'server.files.download.openFailed' },
          );
          ticketRef.value = null;
        }
        releaseDownload?.();
        if (isFileDownloadCapacityError(err)) {
          return reply.code(429).send(errorBody(err));
        }
        if (reply.raw.destroyed) return reply;
        return reply.code(400).send(fileOpenErrorBody(err));
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/instances/:id/files/upload',
    { attachValidation: true, schema: { querystring: optionalPathQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return validationMessage(reply, 'server.files.validation.dirPath');
      if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      try {
        rejectWhileRestoring(req.params.id);
        switchToStreamingUploadTimeout(req, reply);
        const file = await req.file();
        if (!file) return reply.code(400).send(panelErrorBody('server.files.upload.missing'));
        const saved = await saveUploadedFile(
          req.params.id,
          req.query.path || '',
          file.filename,
          file.file,
          { beforeCommit: () => rejectWhileRestoring(req.params.id) },
        );
        noteInstanceFilesChanged(req.params.id);
        return { path: saved };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/config/server.properties', async (req, reply) => {
    if (!getInstance(req.params.id)) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
    try {
      assertTextFileWithinLimit(req.params.id, 'server.properties');
      return readServerProperties(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: Record<string, string> }>(
    '/api/instances/:id/config/server.properties',
    { attachValidation: true, schema: { body: serverPropertiesBodySchema } },
    async (req, reply) => {
      const instance = getInstance(req.params.id);
      if (!instance) return reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
      if (req.validationError) return validationMessage(reply, 'server.files.validation.serverProperties');
      try {
        rejectWhileRestoring(req.params.id);
        assertTextFileWithinLimit(req.params.id, 'server.properties');
        const preview = previewServerPropertiesWrite(req.params.id, req.body, instance.mcVersion);
        if (Buffer.byteLength(preview, 'utf8') > maxTextFileBytes) {
          return reply.code(400).send(panelErrorBody('server.files.serverProperties.tooLarge', { limit: maxTextFileBytes }));
        }
        writeServerProperties(req.params.id, req.body, instance.mcVersion);
        noteInstanceFilesChanged(req.params.id);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );
}
