import type { FastifyInstance } from 'fastify';
import type {
  ConfirmZipImportInput,
  DeployCoreInput,
  ImportExistingServerInput,
} from '@mystry/shared';
import {
  DEPLOYABLE_CORE_TYPE_ENUM,
  deployCoreBodySchema,
  confirmZipImportBodySchema,
  importExistingServerBodySchema,
} from '@mystry/shared';
import { deployCore } from '../services/core-depot.js';
import {
  listCoreVersions,
  listFabricInstallers,
  listFabricLoaders,
  listForgeLoaders,
  listNeoForgeLoaders,
  listPaperBuilds,
} from '../services/core-metadata.js';
import {
  importExistingServerDirectory,
  listExistingServerSources,
} from '../services/existing-server-import-service.js';
import { getTask, listTasks } from '../services/task-service.js';
import { removeUploadTemp, streamToUploadTemp } from '../services/upload-service.js';
import {
  cancelImportPreview,
  confirmImportPreview,
  createImportPreview,
  getImportPreview,
} from '../services/import-preview-service.js';
import { sendRouteError } from '../http-errors.js';

export async function coreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get<{ Params: { type: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge' } }>(
    '/api/cores/:type/versions',
    {
      attachValidation: true,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { type: 'string', enum: [...DEPLOYABLE_CORE_TYPE_ENUM] } },
        },
      },
    },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send({ error: '不支持的核心类型' });
      }
      try {
        const versions = await listCoreVersions(req.params.type);
        return { versions };
      } catch (err) {
        return sendRouteError(reply, err, 502);
      }
    },
  );

  app.get<{ Params: { version: string } }>('/api/cores/paper/:version/builds', async (req, reply) => {
    try {
      return { builds: await listPaperBuilds(req.params.version) };
    } catch (err) {
      return sendRouteError(reply, err, 502);
    }
  });

  app.get<{ Params: { version: string } }>(
    '/api/cores/fabric/:version/loaders',
    async (req, reply) => {
      try {
        return {
          loaders: await listFabricLoaders(req.params.version),
          installers: await listFabricInstallers(),
        };
      } catch (err) {
        return sendRouteError(reply, err, 502);
      }
    },
  );

  app.get<{ Params: { version: string } }>(
    '/api/cores/forge/:version/loaders',
    async (req, reply) => {
      try {
        return { loaders: await listForgeLoaders(req.params.version) };
      } catch (err) {
        return sendRouteError(reply, err, 502);
      }
    },
  );

  app.get<{ Params: { version: string } }>(
    '/api/cores/neoforge/:version/loaders',
    async (req, reply) => {
      try {
        return { loaders: await listNeoForgeLoaders(req.params.version) };
      } catch (err) {
        return sendRouteError(reply, err, 502);
      }
    },
  );

  app.post<{
    Body: DeployCoreInput;
  }>('/api/cores/deploy', { attachValidation: true, schema: { body: deployCoreBodySchema } }, async (req, reply) => {
    if (req.validationError) {
      return reply.code(400).send({ error: '部署参数包含不支持的字段或格式不正确' });
    }
    // schema 已保证字段齐全，这里只拦截纯空白名称和空版本号。
    if (!req.body.name.trim() || !req.body.mcVersion) {
      return reply.code(400).send({ error: '缺少必要参数' });
    }
    try {
      return await deployCore(req.body);
    } catch (err) {
      return sendRouteError(reply, err);
    }
  });

  app.get('/api/tasks', async () => ({ tasks: listTasks(50) }));

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const task = getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    return task;
  });

  app.get('/api/import/sources', async (_req, reply) => {
    try {
      return { sources: await listExistingServerSources() };
    } catch (err) {
      return sendRouteError(reply, err, 500);
    }
  });

  app.post<{
    Body: ImportExistingServerInput;
  }>(
    '/api/import/existing',
    { attachValidation: true, schema: { body: importExistingServerBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send({ error: '已有服务端导入参数包含不支持的字段或格式不正确' });
      }
      if (!req.body.name.trim()) {
        return reply.code(400).send({ error: '实例名称不能为空' });
      }
      try {
        return await importExistingServerDirectory({
          ...req.body,
          name: req.body.name.trim(),
        });
      } catch (err) {
        return sendRouteError(reply, err);
      }
    },
  );

  app.post('/api/import/previews', async (req, reply) => {
    const parts = req.parts();
    let zipPath: string | null = null;
    let fileName = 'server.zip';
    let handedOff = false;
    try {
      for await (const part of parts) {
        if (part.type !== 'file') {
          return reply.code(400).send({ error: 'ZIP 预览只接受一个安装包文件' });
        }
        if (zipPath) {
          const discarded = await streamToUploadTemp(part.file, 'discard');
          removeUploadTemp(discarded);
          return reply.code(400).send({ error: '只能上传一个 ZIP 安装包' });
        }
        fileName = part.filename || fileName;
        zipPath = await streamToUploadTemp(part.file, 'import-preview');
        if (part.file.truncated) {
          removeUploadTemp(zipPath);
          zipPath = null;
          return reply.code(413).send({ error: '上传文件超过大小限制' });
        }
      }
      if (!zipPath) return reply.code(400).send({ error: '请上传 ZIP 安装包' });
      const preview = await createImportPreview({
        userId: req.user.id,
        fileName,
        zipPath,
      });
      handedOff = true;
      return preview;
    } catch (error) {
      return sendRouteError(reply, error);
    } finally {
      if (!handedOff && zipPath) {
        try {
          removeUploadTemp(zipPath);
        } catch {
          /* 清理失败不覆盖原始响应。 */
        }
      }
    }
  });

  app.get<{ Params: { id: string } }>('/api/import/previews/:id', async (req, reply) => {
    try {
      return getImportPreview(req.params.id, req.user.id);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: ConfirmZipImportInput }>(
    '/api/import/previews/:id/confirm',
    { attachValidation: true, schema: { body: confirmZipImportBodySchema } },
    async (req, reply) => {
      if (req.validationError || !req.body.name.trim()) {
        return reply.code(400).send({ error: 'ZIP 导入确认参数包含不支持的字段或格式不正确' });
      }
      try {
        return await confirmImportPreview(req.params.id, req.user.id, {
          ...req.body,
          name: req.body.name.trim(),
        });
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/import/previews/:id', async (req, reply) => {
    try {
      cancelImportPreview(req.params.id, req.user.id);
      return { ok: true };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
