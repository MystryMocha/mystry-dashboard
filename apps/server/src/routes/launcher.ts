import type { FastifyInstance } from 'fastify';
import { resetPasswordBodySchema, type ResetPasswordInput } from '@mystry/shared';
import { config } from '../config.js';
import { resetAdminPassword } from '../services/auth-service.js';
import { createRateLimitHook, tokenMatches } from '../services/security-service.js';
import { errorBody, panelErrorBody, PanelError } from '../utils/errors.js';

export type ShutdownSummary = {
  runningInstances: number;
  runningTasks: number;
  queuedTasks: number;
  alreadyShuttingDown: boolean;
};

export type LauncherRouteOptions = {
  prepareShutdown?: () => ShutdownSummary;
  startShutdown?: () => void;
};

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

/** 仅供本机 PanelManager 调用的通道：安全关闭和重置管理员密码。 */
export async function launcherRoutes(
  app: FastifyInstance,
  options: LauncherRouteOptions,
): Promise<void> {
  const strictLauncherLimit = createRateLimitHook({
    name: 'launcher',
    max: config.authRateLimitMax,
    windowMs: config.authRateLimitWindowMs,
  });

  app.post(
    '/api/launcher/shutdown',
    { preHandler: [strictLauncherLimit] },
    async (req, reply) => {
      if (!isLoopbackAddress(req.ip)) {
        return reply.code(403).send(panelErrorBody('server.auth.launcherLocalOnly'));
      }
      if (!tokenMatches(req.headers['x-launcher-token'], config.launcherToken)) {
        return reply.code(401).send(panelErrorBody('server.auth.invalidLauncherToken'));
      }
      if (!options.prepareShutdown || !options.startShutdown) {
        return reply.code(503).send(panelErrorBody('server.auth.launcherShutdownUnsupported'));
      }

      const summary = options.prepareShutdown();
      // 客户端在响应刷新前断开时 reply 'finish' 不会触发，'close' 兜底启动关闭流程，
      // 否则面板会停留在 503 拒服务空窗。startShutdown 内部对重复调用有去重。
      reply.raw.once('finish', options.startShutdown);
      reply.raw.once('close', options.startShutdown);
      return reply.code(202).send({ accepted: true, ...summary });
    },
  );

  // 新密码由本机控制器生成，只显示在用户的终端里；请求体不进日志。
  app.post<{ Body: ResetPasswordInput }>(
    '/api/launcher/reset-password',
    {
      attachValidation: true,
      schema: { body: resetPasswordBodySchema },
      preHandler: [strictLauncherLimit],
    },
    async (req, reply) => {
      if (!isLoopbackAddress(req.ip)) {
        return reply.code(403).send(panelErrorBody('server.auth.launcherLocalOnly'));
      }
      if (!tokenMatches(req.headers['x-launcher-token'], config.launcherToken)) {
        return reply.code(401).send(panelErrorBody('server.auth.invalidLauncherToken'));
      }
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.invalidCredentialFormat'));
      }
      try {
        return resetAdminPassword(req.body.password);
      } catch (err) {
        const noAdministrator = err instanceof PanelError && err.messageKey === 'server.auth.noAdministrator';
        return reply.code(noAdministrator ? 409 : 400).send(errorBody(err));
      }
    },
  );
}
