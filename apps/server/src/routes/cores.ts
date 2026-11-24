import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  ConfirmZipImportInput,
  CreateFolderUploadInput,
  DeployCoreInput,
  ExistingServerSourceListResult,
  ImportExistingServerInput,
} from '@mystry/shared';
import {
  DEPLOYABLE_CORE_TYPE_ENUM,
  deployCoreBodySchema,
  confirmZipImportBodySchema,
  createFolderUploadBodySchema,
  importExistingServerBodySchema,
} from '@mystry/shared';
import { config } from '../config.js';
import {
  FOLDER_UPLOAD_BATCH_MAX_FILES,
  cancelFolderUpload,
  completeFolderUpload,
  confirmFolderUpload,
  createFolderUpload,
  getFolderUpload,
  receiveFolderUploadBatch,
  type FolderUploadPart,
} from '../services/folder-upload-service.js';
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
import { panelErrorBody } from '../utils/errors.js';

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
        return reply.code(400).send(panelErrorBody('server.deploy.unsupportedCore'));
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
      return reply.code(400).send(panelErrorBody('server.deploy.invalidParams'));
    }
    // The schema already guarantees the fields are present; this only rejects whitespace-only names and empty version numbers.
    if (!req.body.name.trim() || !req.body.mcVersion) {
      return reply.code(400).send(panelErrorBody('server.deploy.missingParams'));
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
    if (!task) return reply.code(404).send(panelErrorBody('server.tasks.notFound'));
    return task;
  });

  app.get('/api/import/sources', async (_req, reply) => {
    try {
      // The path only tells the user where to copy the server to; when the data root is a relative value it is still turned into an absolute path before being shown.
      const result: ExistingServerSourceListResult = {
        sources: await listExistingServerSources(),
        importDir: path.resolve(config.existingServerImportDir),
      };
      return result;
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
        return reply.code(400).send(panelErrorBody('server.imports.existing.invalidParams'));
      }
      if (!req.body.name.trim()) {
        return reply.code(400).send(panelErrorBody('server.imports.nameRequired'));
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
          return reply.code(400).send(panelErrorBody('server.imports.zip.singleFileOnly'));
        }
        if (zipPath) {
          const discarded = await streamToUploadTemp(part.file, 'discard');
          removeUploadTemp(discarded);
          return reply.code(400).send(panelErrorBody('server.imports.zip.oneArchiveOnly'));
        }
        fileName = part.filename || fileName;
        zipPath = await streamToUploadTemp(part.file, 'import-preview');
        if (part.file.truncated) {
          removeUploadTemp(zipPath);
          zipPath = null;
          return reply.code(413).send(panelErrorBody('server.imports.zip.tooLarge'));
        }
      }
      if (!zipPath) return reply.code(400).send(panelErrorBody('server.imports.zip.missing'));
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
          /* A cleanup failure does not override the original response. */
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
        return reply.code(400).send(panelErrorBody('server.imports.zip.invalidConfirmParams'));
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

  // Folder upload from the browser: start → send files in batches → precheck when done → confirm import or cancel.
  app.post<{ Body: CreateFolderUploadInput }>(
    '/api/import/folder-uploads',
    { attachValidation: true, schema: { body: createFolderUploadBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.imports.folder.invalidParams'));
      }
      try {
        return await createFolderUpload(req.user.id, req.body);
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/import/folder-uploads/:id/files', async (req, reply) => {
    try {
      // The global multipart limit allows only one file; here it is relaxed to the number of files in a batch, with no single file exceeding the folder's total size limit.
      const parts = req.parts({
        limits: {
          files: FOLDER_UPLOAD_BATCH_MAX_FILES,
          fields: FOLDER_UPLOAD_BATCH_MAX_FILES,
          parts: FOLDER_UPLOAD_BATCH_MAX_FILES * 2,
          fileSize: config.maxExistingImportBytes,
          fieldSize: 4096,
        },
      }) as AsyncIterable<FolderUploadPart>;
      return await receiveFolderUploadBatch(req.params.id, req.user.id, parts);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/import/folder-uploads/:id/complete', async (req, reply) => {
    try {
      return await completeFolderUpload(req.params.id, req.user.id);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/import/folder-uploads/:id', async (req, reply) => {
    try {
      return getFolderUpload(req.params.id, req.user.id);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: ConfirmZipImportInput }>(
    '/api/import/folder-uploads/:id/confirm',
    { attachValidation: true, schema: { body: confirmZipImportBodySchema } },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.imports.folder.invalidParams'));
      }
      if (!req.body.name.trim()) {
        return reply.code(400).send(panelErrorBody('server.imports.nameRequired'));
      }
      try {
        return await confirmFolderUpload(req.params.id, req.user.id, {
          ...req.body,
          name: req.body.name.trim(),
        });
      } catch (error) {
        return sendRouteError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/import/folder-uploads/:id', async (req, reply) => {
    try {
      await cancelFolderUpload(req.params.id, req.user.id);
      return { ok: true };
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
