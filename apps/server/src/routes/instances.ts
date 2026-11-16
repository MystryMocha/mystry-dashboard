import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CreateInstanceInput, UpdateInstanceInput } from '@mystry/shared';
import { createInstanceBodySchema, updateInstanceBodySchema } from '@mystry/shared';
import { config } from '../config.js';
import {
  adoptManagedDirectory,
  createInstance,
  deleteInstance,
  getInstance,
  getInstanceRow,
  listInstances,
  updateInstance,
} from '../services/instance-service.js';
import { deleteInstanceBackups } from '../services/backup-service.js';
import { removeInstanceFrp } from '../services/frp-manager.js';
import { removeInstanceLan } from '../services/lan-manager.js';
import { describeLocalNetwork } from '../services/local-network-service.js';
import {
  isInstanceOperationConflictError,
  isInstanceStopPendingError,
  processManager,
} from '../services/process-manager.js';
import { sendRouteError } from '../http-errors.js';
import { errorBody, errorParam, panelErrorBody, PanelError, toPanelMessage } from '../utils/errors.js';

const commandBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1, maxLength: config.maxCommandBytes },
  },
} as const;

function replyProcessManagerError(reply: FastifyReply, err: unknown) {
  if (isInstanceStopPendingError(err)) {
    // `code` 是停止仍在进行的稳定标识（前端按 stillStopping 判断），可翻译消息放在 errorI18n。
    return reply.code(202).send({
      code: 'INSTANCE_STOP_PENDING',
      error: err.message,
      errorI18n: toPanelMessage(err),
      status: 'stopping',
      stillStopping: true as const,
    });
  }
  if (isInstanceOperationConflictError(err)) {
    // 冲突错误按通用错误体返回，`code` 为消息键，前端据此翻译。
    return reply.code(409).send(errorBody(err));
  }
  return sendRouteError(reply, err);
}

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/instances', async () => listInstances());

  app.get<{ Params: { id: string } }>('/api/instances/:id', async (req, reply) => {
    const inst = getInstance(req.params.id);
    if (!inst) return reply.code(404).send(panelErrorBody('server.instance.notFound'));
    return inst;
  });

  // 同一网络直连：只读返回本机局域网地址和游戏端口，不开端口也不改配置。
  app.get<{ Params: { id: string } }>('/api/instances/:id/local-network', async (req, reply) => {
    if (!getInstanceRow(req.params.id)) return reply.code(404).send(panelErrorBody('server.instance.notFound'));
    try {
      return describeLocalNetwork(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{
    Body: CreateInstanceInput;
  }>('/api/instances', { attachValidation: true, schema: { body: createInstanceBodySchema } }, async (req, reply) => {
    if (req.validationError) {
      return reply.code(400).send(panelErrorBody('server.instance.invalidParams'));
    }
    if (!req.body?.name?.trim()) {
      return reply.code(400).send(panelErrorBody('server.instance.nameRequired'));
    }
    try {
      return createInstance({ ...req.body, name: req.body.name.trim() });
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.patch<{
    Params: { id: string };
    Body: UpdateInstanceInput;
  }>('/api/instances/:id', { attachValidation: true, schema: { body: updateInstanceBodySchema } }, async (req, reply) => {
    if (req.validationError) {
      return reply.code(400).send(panelErrorBody('server.instance.invalidParams'));
    }
    if (!getInstanceRow(req.params.id)) {
      return reply.code(404).send(panelErrorBody('server.instance.notFound'));
    }
    try {
      return updateInstance(req.params.id, req.body);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/instances/:id/adopt-managed-directory',
    async (req, reply) => {
      try {
        return await adoptManagedDirectory(req.params.id);
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { keepBackups?: string } }>('/api/instances/:id', async (req, reply) => {
    try {
      await deleteInstance(req.params.id);
      await removeInstanceFrp(req.params.id);
      await removeInstanceLan(req.params.id);
    } catch (err) {
      return sendRouteError(reply, err);
    }
    // 实例删除后备份在界面里再也找不到，默认一起删除；keepBackups=1 时留在 BACKUP_DIR 由用户自行处理。
    if (req.query.keepBackups !== '1') {
      try {
        deleteInstanceBackups(req.params.id);
      } catch (err) {
        return sendRouteError(
          reply,
          new PanelError('server.backups.deleteWithInstanceFailed', { reason: errorParam(err) }, { statusCode: 500, cause: err }),
        );
      }
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/instances/:id/start', async (req, reply) => {
    const row = getInstanceRow(req.params.id);
    if (!row) return reply.code(404).send(panelErrorBody('server.instance.notFound'));
    try {
      await processManager.start(row);
      return getInstance(row.id);
    } catch (err) {
      return replyProcessManagerError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/instances/:id/stop',
    async (req, reply) => {
      if (!getInstanceRow(req.params.id)) {
        return reply.code(404).send(panelErrorBody('server.instance.notFound'));
      }
      try {
        await processManager.stop(req.params.id, req.query.force === '1');
        return getInstance(req.params.id);
      } catch (err) {
        return replyProcessManagerError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/instances/:id/restart', async (req, reply) => {
    const row = getInstanceRow(req.params.id);
    if (!row) return reply.code(404).send(panelErrorBody('server.instance.notFound'));
    try {
      await processManager.restart(row);
      return getInstance(row.id);
    } catch (err) {
      return replyProcessManagerError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: { command: string } }>(
    '/api/instances/:id/command',
    { attachValidation: true, schema: { body: commandBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.instance.commandInvalid'));
      }
      try {
        processManager.sendCommand(req.params.id, req.body.command);
        return { ok: true };
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );
}
