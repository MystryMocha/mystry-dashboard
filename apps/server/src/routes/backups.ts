import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  backupDownloadQuerySchema,
  restoreBackupBodySchema,
  updateBackupScheduleBodySchema,
  type BackupScheduleInput,
  type RestoreBackupInput,
} from '@mystry/shared';
import { config } from '../config.js';
import {
  deleteBackup,
  getBackup,
  getBackupWithArchive,
  listBackups,
  saveUploadedBackup,
  startBackupTask,
  startRestoreTask,
} from '../services/backup-service.js';
import { getBackupSchedule, saveBackupSchedule } from '../services/backup-schedule-service.js';
import {
  beginDownloadStream,
  failDownloadStream,
  reserveDownloadTicket,
} from '../services/download-ticket-service.js';
import { acquireFileDownloadSlot, isFileDownloadCapacityError } from '../services/file-service.js';
import { getInstance } from '../services/instance-service.js';
import { sendRouteError } from '../http-errors.js';
import { errorBody, errorMessage, panelErrorBody, toPanelMessage } from '../utils/errors.js';
import { sendFileStream } from './files.js';

/** Backup downloads reuse file download tickets, told apart by a pseudo path so they are not confused with real file paths inside an instance. */
function backupTicketPath(backupId: string): string {
  return `@backup/${backupId}`;
}

function isBackupDownloadRoute(req: FastifyRequest): boolean {
  return req.routeOptions.url === '/api/instances/:id/backups/:backupId/download';
}

function requireInstance(reply: FastifyReply, id: string): boolean {
  if (getInstance(id)) return true;
  void reply.code(404).send(panelErrorBody('server.files.instanceNotFound'));
  return false;
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // Downloads can use a one-time ticket instead of the JWT (native browser navigation cannot send Authorization)
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isBackupDownloadRoute(req)) {
      const ticket = (req.query as { ticket?: string }).ticket;
      if (typeof ticket === 'string' && ticket.length > 0) return;
    }
    return app.authenticate(req, reply);
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/backups', async (req, reply) => {
    if (!requireInstance(reply, req.params.id)) return reply;
    try {
      return { backups: listBackups(req.params.id) };
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/backups', async (req, reply) => {
    if (!requireInstance(reply, req.params.id)) return reply;
    try {
      return await startBackupTask(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/backups/upload', async (req, reply) => {
    if (!requireInstance(reply, req.params.id)) return reply;
    try {
      const file = await req.file({ limits: { fileSize: config.maxBackupUploadBytes } });
      if (!file) return reply.code(400).send(panelErrorBody('server.backups.upload.missing'));
      return await saveUploadedBackup(req.params.id, file.file);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{ Params: { id: string; backupId: string }; Body: RestoreBackupInput }>(
    '/api/instances/:id/backups/:backupId/restore',
    { attachValidation: true, schema: { body: restoreBackupBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.backups.invalidParams'));
      if (!requireInstance(reply, req.params.id)) return reply;
      try {
        return await startRestoreTask(req.params.id, req.params.backupId, {
          backupCurrent: req.body?.backupCurrent ?? true,
        });
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId',
    async (req, reply) => {
      if (!requireInstance(reply, req.params.id)) return reply;
      try {
        deleteBackup(req.params.id, req.params.backupId);
        return reply.code(204).send();
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/backup-schedule', async (req, reply) => {
    if (!requireInstance(reply, req.params.id)) return reply;
    try {
      return getBackupSchedule(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: BackupScheduleInput }>(
    '/api/instances/:id/backup-schedule',
    { attachValidation: true, schema: { body: updateBackupScheduleBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.backups.schedule.invalidParams'));
      if (!requireInstance(reply, req.params.id)) return reply;
      try {
        return saveBackupSchedule(req.params.id, req.body);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; backupId: string } }>(
    '/api/instances/:id/backups/:backupId/download-ticket',
    async (req, reply) => {
      if (!requireInstance(reply, req.params.id)) return reply;
      let releaseDownload: (() => void) | null = null;
      try {
        getBackup(req.params.id, req.params.backupId);
        releaseDownload = acquireFileDownloadSlot();
        return reserveDownloadTicket(
          req.user.id,
          req.params.id,
          backupTicketPath(req.params.backupId),
          releaseDownload,
        );
      } catch (err) {
        releaseDownload?.();
        if (isFileDownloadCapacityError(err)) return reply.code(429).send(errorBody(err));
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string; backupId: string }; Querystring: { ticket?: string } }>(
    '/api/instances/:id/backups/:backupId/download',
    { attachValidation: true, schema: { querystring: backupDownloadQuerySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.backups.invalidParams'));
      const ticketParam = req.query.ticket;
      const hasTicket = typeof ticketParam === 'string' && ticketParam.length > 0;
      const ticketRef = { value: hasTicket ? ticketParam : null };
      if (hasTicket) {
        const began = beginDownloadStream(ticketParam, req.params.id, backupTicketPath(req.params.backupId));
        if (!began) return reply.code(401).send(panelErrorBody('server.files.download.linkExpired'));
      }
      let releaseDownload: (() => void) | null = null;
      try {
        const { info, archive: abs } = getBackupWithArchive(req.params.id, req.params.backupId);
        if (!hasTicket) releaseDownload = acquireFileDownloadSlot();
        // The file name keeps the instance name (including Chinese characters), replacing only characters the OS does not allow; Content-Disposition has a separate ASCII fallback.
        const safeName = info.instanceName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
        const downloadName = `${safeName || info.instanceId}-${info.id}.tar.gz`;
        return await sendFileStream(reply, abs, downloadName, ticketRef, releaseDownload);
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
        if (isFileDownloadCapacityError(err)) return reply.code(429).send(errorBody(err));
        if (reply.raw.destroyed) return reply;
        return sendRouteError(reply, err);
      }
    },
  );
}
