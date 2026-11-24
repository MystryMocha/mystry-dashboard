import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  EASYTIER_VERSION,
  lanAdminRestartBodySchema,
  lanAdminStartBodySchema,
  updateInstanceLanBodySchema,
  type InstanceLanInput,
  type LanAdminRestartInput,
  type LanAdminStartInput,
  type LanRuntimeInfo,
} from '@mystry/shared';
import { sendRouteError } from '../http-errors.js';
import { panelErrorBody } from '../utils/errors.js';
import { isLocalRequest } from '../utils/request-origin.js';
import { adminRestartAvailable, requestAdminRestart, setStartAsAdmin, startsAsAdmin } from '../services/admin-restart.js';
import { removeUploadTemp, streamToUploadTemp } from '../services/upload-service.js';
import { getInstanceRow } from '../services/instance-service.js';
import {
  describeInstanceLan,
  renderLanFriendConfig,
  syncEnabledLans,
  syncInstanceLanQueued,
} from '../services/lan-manager.js';
import { saveInstanceLan } from '../services/lan-service.js';
import {
  ensureLanInstalled,
  installLanFromArchive,
  LAN_ARCHIVE_BYTE_LIMIT,
  lanArchiveInfo,
  lanInstalled,
  lanPlatformSupported,
} from '../services/lan-runtime.js';
import { windowsPanelElevated } from '../services/windows-elevation.js';

async function runtimeInfo(req: FastifyRequest): Promise<LanRuntimeInfo> {
  const elevated = await windowsPanelElevated();
  return {
    version: EASYTIER_VERSION,
    installed: lanInstalled(),
    platformSupported: lanPlatformSupported(),
    archive: lanArchiveInfo(),
    // Reported before the client is downloaded or the switch is turned on, so the user restarts the panel first instead of finding out from a failure.
    needsAdmin: elevated === false,
    // Java is spawned with the panel's own token, so every server and its plugins and mods are elevated too; the page keeps saying so while it holds.
    runsAsAdmin: elevated === true,
    // Depends on where this request comes from, so it is worked out per request and checked again when the restart is asked for.
    adminRestart: await adminRestartAvailable(isLocalRequest(req)),
    startAsAdmin: startsAsAdmin(),
  };
}

/** Virtual LAN. Only manages the official EasyTier at its pinned version; arbitrary config or executable paths are not accepted. */
export async function lanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/lan/runtime', async (req) => runtimeInfo(req));

  app.post('/api/lan/runtime', async (req, reply) => {
    try {
      await ensureLanInstalled();
      await syncEnabledLans();
      return await runtimeInfo(req);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  // When GitHub is unreachable, the user downloads the same official archive elsewhere and uploads it; it is accepted only by the pinned SHA-256.
  app.post('/api/lan/runtime/upload', async (req, reply) => {
    let temp: string | null = null;
    try {
      if (!lanPlatformSupported()) return reply.code(400).send(panelErrorBody('server.lan.platformUnsupported'));
      const file = await req.file({ limits: { fileSize: LAN_ARCHIVE_BYTE_LIMIT } });
      if (!file) return reply.code(400).send(panelErrorBody('server.lan.uploadMissing'));
      temp = await streamToUploadTemp(file.file, 'lan-runtime', { maxBytes: LAN_ARCHIVE_BYTE_LIMIT });
      await installLanFromArchive(temp);
      await syncEnabledLans();
      return await runtimeInfo(req);
    } catch (err) {
      return sendRouteError(reply, err);
    } finally {
      if (temp) removeUploadTemp(temp);
    }
  });

  // Answers once Windows has opened the elevated launcher window; the panel is stopped from there and comes back elevated.
  app.post<{ Body: LanAdminRestartInput }>(
    '/api/lan/admin-restart',
    { attachValidation: true, schema: { body: lanAdminRestartBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.lan.invalidParams'));
      try {
        await requestAdminRestart(req.body.startAsAdmin, isLocalRequest(req));
        return reply.code(202).send({ restarting: true });
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.put<{ Body: LanAdminStartInput }>(
    '/api/lan/admin-start',
    { attachValidation: true, schema: { body: lanAdminStartBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.lan.invalidParams'));
      try {
        setStartAsAdmin(req.body.enabled);
        return await runtimeInfo(req);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/lan', async (req, reply) => {
    if (!getInstanceRow(req.params.id)) return reply.code(404).send(panelErrorBody('server.lan.instanceNotFound'));
    return describeInstanceLan(req.params.id);
  });

  app.put<{ Params: { id: string }; Body: InstanceLanInput }>(
    '/api/instances/:id/lan',
    { attachValidation: true, schema: { body: updateInstanceLanBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.lan.invalidParams'));
      try {
        saveInstanceLan(req.params.id, req.body);
        return await syncInstanceLanQueued(req.params.id);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/lan/friend', async (req, reply) => {
    if (!getInstanceRow(req.params.id)) return reply.code(404).send(panelErrorBody('server.lan.instanceNotFound'));
    try {
      const body = renderLanFriendConfig(req.params.id);
      return reply
        .header('content-disposition', 'attachment; filename="friend-easytier.txt"')
        .type('text/plain; charset=utf-8')
        .send(body);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });
}
