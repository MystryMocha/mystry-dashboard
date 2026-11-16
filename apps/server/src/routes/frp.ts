import type { FastifyInstance } from 'fastify';
import {
  FRP_CLIENT_VERSION,
  createFrpEndpointBodySchema,
  updateFrpEndpointBodySchema,
  updateInstanceTunnelBodySchema,
  type FrpEndpointInput,
  type FrpRuntimeInfo,
  type InstanceTunnelInput,
} from '@mystry/shared';
import { sendRouteError } from '../http-errors.js';
import { panelErrorBody } from '../utils/errors.js';
import { removeUploadTemp, streamToUploadTemp } from '../services/upload-service.js';
import { getInstanceRow } from '../services/instance-service.js';
import {
  describeInstanceTunnel,
  renderFriendConfig,
  syncEnabledTunnels,
  syncInstanceTunnelQueued,
} from '../services/frp-manager.js';
import {
  createFrpEndpoint,
  deleteFrpEndpoint,
  listFrpEndpoints,
  saveInstanceTunnel,
  updateFrpEndpoint,
} from '../services/frp-service.js';
import {
  ensureFrpcInstalled,
  FRPC_ARCHIVE_BYTE_LIMIT,
  frpcArchiveInfo,
  frpcInstalled,
  frpcPlatformSupported,
  installFrpcFromArchive,
} from '../services/frp-runtime.js';

function runtimeInfo(): FrpRuntimeInfo {
  return {
    version: FRP_CLIENT_VERSION,
    installed: frpcInstalled(),
    platformSupported: frpcPlatformSupported(),
    archive: frpcArchiveInfo(),
  };
}

/** 联机穿透。只管理官方 frpc，不接受任意配置或可执行路径。 */
export async function frpRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/frp/runtime', async () => runtimeInfo());

  app.post('/api/frp/runtime', async (_req, reply) => {
    try {
      await ensureFrpcInstalled();
      await syncEnabledTunnels();
      return runtimeInfo();
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  // 连不上 GitHub 时，用户在别处下载同名官方压缩包再上传；只按钉死的 SHA-256 接受。
  app.post('/api/frp/runtime/upload', async (req, reply) => {
    let temp: string | null = null;
    try {
      if (!frpcPlatformSupported()) return reply.code(400).send(panelErrorBody('server.frp.platformUnsupported'));
      const file = await req.file({ limits: { fileSize: FRPC_ARCHIVE_BYTE_LIMIT } });
      if (!file) return reply.code(400).send(panelErrorBody('server.frp.uploadMissing'));
      temp = await streamToUploadTemp(file.file, 'frp-runtime', { maxBytes: FRPC_ARCHIVE_BYTE_LIMIT });
      await installFrpcFromArchive(temp);
      await syncEnabledTunnels();
      return runtimeInfo();
    } catch (err) {
      return sendRouteError(reply, err);
    } finally {
      if (temp) removeUploadTemp(temp);
    }
  });

  app.get('/api/frp/endpoints', async () => listFrpEndpoints());

  app.post<{ Body: FrpEndpointInput }>(
    '/api/frp/endpoints',
    { attachValidation: true, schema: { body: createFrpEndpointBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.frp.invalidParams'));
      try {
        return createFrpEndpoint(req.body);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<FrpEndpointInput> }>(
    '/api/frp/endpoints/:id',
    { attachValidation: true, schema: { body: updateFrpEndpointBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.frp.invalidParams'));
      try {
        const endpoint = updateFrpEndpoint(req.params.id, req.body);
        // 地址、端口、令牌等变化后让已启用的隧道按新配置重启；失败记入隧道状态，不会抛出。
        await syncEnabledTunnels();
        return endpoint;
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/frp/endpoints/:id', async (req, reply) => {
    try {
      deleteFrpEndpoint(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/tunnel', async (req, reply) => {
    if (!getInstanceRow(req.params.id)) return reply.code(404).send(panelErrorBody('server.frp.instanceNotFound'));
    try {
      return describeInstanceTunnel(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: InstanceTunnelInput }>(
    '/api/instances/:id/tunnel',
    { attachValidation: true, schema: { body: updateInstanceTunnelBodySchema } },
    async (req, reply) => {
      if (req.validationError) return reply.code(400).send(panelErrorBody('server.frp.invalidParams'));
      try {
        saveInstanceTunnel(req.params.id, req.body);
        return await syncInstanceTunnelQueued(req.params.id);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/tunnel/friend-config', async (req, reply) => {
    if (!getInstanceRow(req.params.id)) return reply.code(404).send(panelErrorBody('server.frp.instanceNotFound'));
    try {
      const body = renderFriendConfig(req.params.id);
      return reply
        .header('content-disposition', 'attachment; filename="friend-frpc.toml"')
        .type('application/toml; charset=utf-8')
        .send(body);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });
}
