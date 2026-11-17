import type { FastifyInstance } from 'fastify';
import {
  updateAccessModeBodySchema,
  updateDownloadSourceBodySchema,
  updatePanelNetworkBodySchema,
  updatePublicHostBodySchema,
  type DownloadSourceSetting,
  type PublicHostSetting,
  type UpdateDirectAccessRequest,
  type UpdatePanelNetworkRequest,
  type UpdatePublicHostRequest,
} from '@mystry/shared';
import { getDownloadSource, setDownloadSource } from '../services/download-sources.js';
import { detectJava } from '../services/java-detect.js';
import { scanJavaRuntimes } from '../services/java-runtime-service.js';
import { MetricsService } from '../services/metrics-service.js';
import { processManager } from '../services/process-manager.js';
import {
  getPanelNetworkJoinInfo,
  refreshPanelNetworkDevices,
  resetPanelNetworkSecret,
  updatePanelNetwork,
} from '../services/panel-network.js';
import { getPublicHost, setPublicHost } from '../services/public-host.js';
import {
  getRemoteAccessStatus,
  renewPanelCertificate,
  setAccessMode,
  type AccessMode,
} from '../services/remote-access-service.js';
import { config } from '../config.js';
import { sendRouteError } from '../http-errors.js';
import { panelErrorBody } from '../utils/errors.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  const metrics = new MetricsService(config.dataDir, () => processManager.getMetricTargets());
  app.get('/api/system/metrics', () => metrics.get());

  app.get('/api/system/download-source', (): DownloadSourceSetting => ({ source: getDownloadSource() }));

  app.put<{ Body: DownloadSourceSetting }>(
    '/api/system/download-source',
    { attachValidation: true, schema: { body: updateDownloadSourceBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.system.downloadSourceInvalid'));
      }
      try {
        setDownloadSource(req.body.source);
        return { source: getDownloadSource() } satisfies DownloadSourceSetting;
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );

  // ---- 从其他设备访问面板：登录即可开关，不限本机 ----

  app.get('/api/system/remote-access', async (_req, reply) => {
    try {
      await refreshPanelNetworkDevices();
      return await getRemoteAccessStatus();
    } catch (err) {
      return sendRouteError(reply, err, 500);
    }
  });

  for (const mode of ['direct', 'overlay'] as const satisfies readonly AccessMode[]) {
    app.put<{ Body: UpdateDirectAccessRequest }>(
      `/api/system/remote-access/${mode}`,
      { attachValidation: true, schema: { body: updateAccessModeBodySchema } },
      async (req, reply) => {
        if (req.validationError) {
          return reply.code(400).send(panelErrorBody('server.remoteAccess.invalidRequest'));
        }
        try {
          return await setAccessMode(mode, req.body, req.ip);
        } catch (err) {
          return sendRouteError(reply, err, 500);
        }
      },
    );
  }

  app.post('/api/system/remote-access/certificate', async (req, reply) => {
    try {
      return await renewPanelCertificate(req.ip);
    } catch (err) {
      return sendRouteError(reply, err, 500);
    }
  });

  app.put<{ Body: UpdatePanelNetworkRequest }>(
    '/api/system/remote-access/panel-network',
    { attachValidation: true, schema: { body: updatePanelNetworkBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.panelNetwork.invalidRequest'));
      }
      try {
        return updatePanelNetwork(req.body, req.ip);
      } catch (err) {
        return sendRouteError(reply, err, 400);
      }
    },
  );

  // 含网络密钥：只在用户进到「让手机加入」那一步时请求，响应不缓存。
  app.get('/api/system/remote-access/panel-network/join', async (_req, reply) => {
    try {
      reply.header('Cache-Control', 'no-store');
      return getPanelNetworkJoinInfo();
    } catch (err) {
      return sendRouteError(reply, err, 400);
    }
  });

  app.post('/api/system/remote-access/panel-network/reset-secret', async (req, reply) => {
    try {
      return resetPanelNetworkSecret(req.ip);
    } catch (err) {
      return sendRouteError(reply, err, 400);
    }
  });

  app.get('/api/system/public-host', (): PublicHostSetting => ({ publicHost: getPublicHost() }));

  app.put<{ Body: UpdatePublicHostRequest }>(
    '/api/system/public-host',
    { attachValidation: true, schema: { body: updatePublicHostBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.publicHost.invalid'));
      }
      try {
        return { publicHost: setPublicHost(req.body.host) } satisfies PublicHostSetting;
      } catch (err) {
        return sendRouteError(reply, err, 400);
      }
    },
  );

  app.get('/api/system/java', async (_req, reply) => {
    try {
      return await detectJava();
    } catch (err) {
      return sendRouteError(reply, err, 500);
    }
  });

  app.get<{ Querystring: { refresh?: string } }>(
    '/api/system/java-runtimes',
    async (req, reply) => {
      try {
        const runtimes = await scanJavaRuntimes(req.query.refresh === '1');
        return { runtimes };
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );
}
