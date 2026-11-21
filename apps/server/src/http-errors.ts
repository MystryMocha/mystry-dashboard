import type { FastifyReply } from 'fastify';
import { isFileRenameConflictError } from './services/file-service.js';
import { ImportPreviewHttpError } from './services/import-preview-service.js';
import { isTaskCapacityError, isTaskShuttingDownError } from './services/task-service.js';
import { isUploadCapacityError, isUploadTooLargeError } from './services/upload-service.js';
import { errorBody, PanelError } from './utils/errors.js';

/** HTTP status codes for known service-layer errors; other errors use the default status code given by the caller. */
export function routeErrorStatus(error: unknown, fallbackStatus = 400): number {
  if (error instanceof ImportPreviewHttpError) return error.statusCode;
  if (isUploadTooLargeError(error)) return 413;
  if (isTaskShuttingDownError(error)) return 503;
  if (isTaskCapacityError(error) || isUploadCapacityError(error)) return 429;
  if (isFileRenameConflictError(error)) return 409;
  if (error instanceof PanelError && error.statusCode !== undefined) return error.statusCode;
  return fallbackStatus;
}

export function sendRouteError(reply: FastifyReply, error: unknown, fallbackStatus = 400) {
  // Translatable errors carry the message key and params; the rest return only the original text.
  return reply.code(routeErrorStatus(error, fallbackStatus)).send(errorBody(error));
}
