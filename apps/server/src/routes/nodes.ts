import type { FastifyInstance } from 'fastify';
import {
  REMOTE_NODE_CREATION_ENABLED,
  createNodeBodySchema,
  updateNodeBodySchema,
} from '@mystry/shared';
import {
  createNode,
  deleteNode,
  getNode,
  listNodes,
  resetNodeSecret,
  updateNode,
} from '../services/node-service.js';
import { sendRouteError } from '../http-errors.js';
import { panelErrorBody } from '../utils/errors.js';

/**
 * Node management API. At startup the panel creates or keeps the built-in local node `local`;
 * the remote Agent is not implemented yet, and creating remote nodes is rejected while REMOTE_NODE_CREATION_ENABLED is false.
 */
export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/nodes', async () => listNodes());

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    const node = getNode(req.params.id);
    if (!node) return reply.code(404).send(panelErrorBody('server.system.nodeNotFound'));
    return node;
  });

  app.post<{ Body: { name: string } }>(
    '/api/nodes',
    { attachValidation: true, schema: { body: createNodeBodySchema } },
    async (req, reply) => {
      if (!REMOTE_NODE_CREATION_ENABLED) {
        return reply.code(403).send(panelErrorBody('server.system.remoteNodeCreationDisabled'));
      }
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.system.nodeInvalidParams'));
      }
      try {
        return createNode(req.body);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/nodes/:id',
    { attachValidation: true, schema: { body: updateNodeBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.system.nodeInvalidParams'));
      }
      try {
        return updateNode(req.params.id, req.body);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    if (!getNode(req.params.id)) {
      return reply.code(404).send(panelErrorBody('server.system.nodeNotFound'));
    }
    try {
      deleteNode(req.params.id);
      return { ok: true };
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/nodes/:id/secret/reset', async (req, reply) => {
    if (!REMOTE_NODE_CREATION_ENABLED) {
      return reply.code(403).send(panelErrorBody('server.system.remoteNodeSecretDisabled'));
    }
    try {
      return resetNodeSecret(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });
}
