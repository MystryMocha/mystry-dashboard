import type { FastifyInstance } from 'fastify';
import {
  EASYTIER_VERSION,
  updateInstanceLanBodySchema,
  type InstanceLanInput,
  type LanRuntimeInfo,
} from '@mystry/shared';
import { sendRouteError } from '../http-errors.js';
import { panelErrorBody } from '../utils/errors.js';
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

function runtimeInfo(): LanRuntimeInfo {
  return {
    version: EASYTIER_VERSION,
    installed: lanInstalled(),
    platformSupported: lanPlatformSupported(),
    archive: lanArchiveInfo(),
  };
}

/** 虚拟局域网。只管理钉死版本的官方 EasyTier，不接受任意配置或可执行路径。 */
export async function lanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/lan/runtime', async () => runtimeInfo());

  app.post('/api/lan/runtime', async (_req, reply) => {
    try {
      await ensureLanInstalled();
      await syncEnabledLans();
      return runtimeInfo();
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  // 连不上 GitHub 时，用户在别处下载同名官方压缩包再上传；只按钉死的 SHA-256 接受。
  app.post('/api/lan/runtime/upload', async (req, reply) => {
    let temp: string | null = null;
    try {
      if (!lanPlatformSupported()) return reply.code(400).send(panelErrorBody('server.lan.platformUnsupported'));
      const file = await req.file({ limits: { fileSize: LAN_ARCHIVE_BYTE_LIMIT } });
      if (!file) return reply.code(400).send(panelErrorBody('server.lan.uploadMissing'));
      temp = await streamToUploadTemp(file.file, 'lan-runtime', { maxBytes: LAN_ARCHIVE_BYTE_LIMIT });
      await installLanFromArchive(temp);
      await syncEnabledLans();
      return runtimeInfo();
    } catch (err) {
      return sendRouteError(reply, err);
    } finally {
      if (temp) removeUploadTemp(temp);
    }
  });

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
