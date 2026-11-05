import type { FastifyInstance } from 'fastify';
import { updateDownloadSourceBodySchema, type DownloadSourceSetting } from '@mystry/shared';
import { getDownloadSource, setDownloadSource } from '../services/download-sources.js';
import { detectJava } from '../services/java-detect.js';
import { scanJavaRuntimes } from '../services/java-runtime-service.js';
import { MetricsService } from '../services/metrics-service.js';
import { processManager } from '../services/process-manager.js';
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
