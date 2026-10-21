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

/**
 * 节点管理 API。面板启动时会创建或保留内置本机节点 `local`；
 * 远程 Agent 尚未实现，REMOTE_NODE_CREATION_ENABLED 为 false 时拒绝创建远程节点。
 */
export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/nodes', async () => listNodes());

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    const node = getNode(req.params.id);
    if (!node) return reply.code(404).send({ error: '节点不存在' });
    return node;
  });

  app.post<{ Body: { name: string } }>(
    '/api/nodes',
    { attachValidation: true, schema: { body: createNodeBodySchema } },
    async (req, reply) => {
      if (!REMOTE_NODE_CREATION_ENABLED) {
        return reply.code(403).send({ error: '当前版本暂不支持创建远程节点，敬请期待 Agent 接入后开放' });
      }
      if (req.validationError) {
        return reply.code(400).send({ error: '节点参数包含不支持的字段或格式不正确' });
      }
      try {
        return createNode(req.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/nodes/:id',
    { attachValidation: true, schema: { body: updateNodeBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send({ error: '节点参数包含不支持的字段或格式不正确' });
      }
      try {
        return updateNode(req.params.id, req.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req, reply) => {
    if (!getNode(req.params.id)) {
      return reply.code(404).send({ error: '节点不存在' });
    }
    try {
      deleteNode(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/nodes/:id/secret/reset', async (req, reply) => {
    if (!REMOTE_NODE_CREATION_ENABLED) {
      return reply.code(403).send({ error: '当前版本暂不支持远程节点密钥操作' });
    }
    try {
      return resetNodeSecret(req.params.id);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
