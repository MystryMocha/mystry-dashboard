import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  installJavaBodySchema,
  updateAccessModeBodySchema,
  updateAutoRestartBodySchema,
  updateDownloadSourceBodySchema,
  updatePanelNetworkBodySchema,
  updatePublicHostBodySchema,
  type AutoRestartSettings,
  type DownloadSourceSetting,
  type InstallJavaRequest,
  type JavaRuntimeListResult,
  type PanelInfo,
  type PublicHostSetting,
  type UpdateDirectAccessRequest,
  type UpdatePanelNetworkRequest,
  type UpdatePublicHostRequest,
} from '@mystry/shared';
import { getDownloadSource, setDownloadSource } from '../services/download-sources.js';
import { autoRestartService } from '../services/auto-restart-service.js';
import { getAutoRestartSettings, setAutoRestartSettings } from '../services/auto-restart-settings.js';
import { detectJava } from '../services/java-detect.js';
import { cancelJavaInstall, installableJavaMajors, startJavaInstall } from '../services/java-install-service.js';
import { scanJavaRuntimes } from '../services/java-runtime-service.js';
import { getSharedMetricsService } from '../services/stats-service.js';
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
  const metrics = getSharedMetricsService();
  app.get('/api/system/metrics', () => metrics.get());

  // Panel runtime info: shows the listen address and directories on the "Panel Settings" page. Read-only, returning only non-secret items from the config file.
  app.get('/api/system/panel-info', (): PanelInfo => ({
    host: config.host,
    port: config.port,
    dataDir: path.resolve(config.dataDir),
    backupDir: path.resolve(config.backupDir),
    configPath: path.resolve(config.configPath),
  }));

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

  app.get('/api/system/auto-restart', (): AutoRestartSettings => getAutoRestartSettings());

  app.put<{ Body: AutoRestartSettings }>(
    '/api/system/auto-restart',
    { attachValidation: true, schema: { body: updateAutoRestartBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.system.autoRestartInvalid'));
      }
      try {
        setAutoRestartSettings(req.body);
        if (!req.body.enabled) autoRestartService.cancelAll();
        return getAutoRestartSettings();
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );

  // ---- Access the panel from other devices: any signed-in user can toggle it, not limited to this machine ----

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

  // Contains the network secret: requested only when the user reaches the "join from a phone" step, and the response is not cached.
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
        return { runtimes, installable: installableJavaMajors() } satisfies JavaRuntimeListResult;
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );

  // One-click Java install: only accepts major versions whose installer the panel has pinned, and returns a background task;
  // when the same major version is already being installed, that task is returned.
  app.post<{ Body: InstallJavaRequest }>(
    '/api/system/java-runtimes/install',
    { attachValidation: true, schema: { body: installJavaBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        const major = (req.body as { major?: unknown } | undefined)?.major;
        return reply.code(400).send(panelErrorBody('server.jvm.javaInstall.unsupportedMajor', { major: String(major ?? '') }));
      }
      try {
        return await startJavaInstall(req.body.major);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  // Cancel a one-click install: only accepts a Java install task still in progress (any other task ID gets 409) and returns the task's current state;
  // a running task becomes cancelled only after the download stops and the temp directory is cleaned up, so the frontend keeps polling until it ends.
  app.post<{ Params: { taskId: string } }>(
    '/api/system/java-runtimes/install/:taskId/cancel',
    async (req, reply) => {
      try {
        return cancelJavaInstall(req.params.taskId);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );
}
