import type { FastifyReply } from 'fastify';
import { isFileRenameConflictError } from './services/file-service.js';
import { ImportPreviewHttpError } from './services/import-preview-service.js';
import { isTaskCapacityError, isTaskShuttingDownError } from './services/task-service.js';
import { isUploadCapacityError, isUploadTooLargeError } from './services/upload-service.js';
import { errorMessage } from './utils/errors.js';

/** 服务层已知错误对应的 HTTP 状态码；其余错误使用调用方给的默认状态码。 */
export function routeErrorStatus(error: unknown, fallbackStatus = 400): number {
  if (error instanceof ImportPreviewHttpError) return error.statusCode;
  if (isUploadTooLargeError(error)) return 413;
  if (isTaskShuttingDownError(error)) return 503;
  if (isTaskCapacityError(error) || isUploadCapacityError(error)) return 429;
  if (isFileRenameConflictError(error)) return 409;
  return fallbackStatus;
}

export function sendRouteError(reply: FastifyReply, error: unknown, fallbackStatus = 400) {
  return reply.code(routeErrorStatus(error, fallbackStatus)).send({ error: errorMessage(error) });
}
