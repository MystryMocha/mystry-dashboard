import type { FastifyInstance } from 'fastify';
import { statsOverviewQuerySchema, type StatsOverview, type StatsRange } from '@mystry/shared';
import { sendRouteError } from '../http-errors.js';
import { getStatsOverview } from '../services/stats-service.js';
import { panelErrorBody } from '../utils/errors.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get<{ Querystring: { range?: StatsRange } }>(
    '/api/stats/overview',
    { attachValidation: true, schema: { querystring: statsOverviewQuerySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.system.statsRangeInvalid'));
      }
      try {
        return getStatsOverview(req.query.range ?? '7d') satisfies StatsOverview;
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );
}
