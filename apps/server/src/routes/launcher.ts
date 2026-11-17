import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  resetPasswordBodySchema,
  updateAccessModeBodySchema,
  type ResetPasswordInput,
  type UpdateDirectAccessRequest,
} from '@mystry/shared';
import { config } from '../config.js';
import { resetAdminPassword } from '../services/auth-service.js';
import {
  getRemoteAccessStatus,
  renewPanelCertificate,
  setAccessMode,
} from '../services/remote-access-service.js';
import { createRateLimitHook, tokenMatches } from '../services/security-service.js';
import { sendRouteError } from '../http-errors.js';
import { errorBody, panelErrorBody, PanelError } from '../utils/errors.js';
import { isLocalRequest } from '../utils/request-origin.js';

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

/** 仅供本机 PanelManager 调用的通道：安全关闭、重置管理员密码、开关「从其他设备访问」。 */
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
      if (!isLocalRequest(req)) {
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
      if (!isLocalRequest(req)) {
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

  // remote 命令每次要先读状态再改设置，SSH 登录时每次启动还会读一次：
  // 沿用关闭和重置密码的严格限额（默认 5 分钟 10 次）会让正常使用撞上 429，这组接口用全局限额。
  const remoteAccessLimit = createRateLimitHook({
    name: 'launcher-remote-access',
    max: config.rateLimitMax,
    windowMs: config.rateLimitWindowMs,
  });

  // 启动器没有登录令牌：这组接口只认回环来源加 LAUNCHER_TOKEN。
  // 从额外监听器（其他设备）进来的请求 req.ip 是对方的真实地址，过不了回环检查；
  // 经面板自带网络进来的请求虽然来源是 127.0.0.1，也按组网设备处理（request-origin.ts）。
  const rejectUnlessLauncher = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isLocalRequest(req)) {
      void reply.code(403).send(panelErrorBody('server.auth.launcherLocalOnly'));
      return true;
    }
    if (!tokenMatches(req.headers['x-launcher-token'], config.launcherToken)) {
      void reply.code(401).send(panelErrorBody('server.auth.invalidLauncherToken'));
      return true;
    }
    return false;
  };

  app.get(
    '/api/launcher/remote-access',
    { preHandler: [remoteAccessLimit] },
    async (req, reply) => {
      if (rejectUnlessLauncher(req, reply)) return reply;
      try {
        return await getRemoteAccessStatus();
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );

  app.put<{ Body: UpdateDirectAccessRequest }>(
    '/api/launcher/remote-access/direct',
    {
      attachValidation: true,
      schema: { body: updateAccessModeBodySchema },
      preHandler: [remoteAccessLimit],
    },
    async (req, reply) => {
      if (rejectUnlessLauncher(req, reply)) return reply;
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.remoteAccess.invalidRequest'));
      }
      try {
        return await setAccessMode('direct', req.body, req.ip);
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );

  app.post(
    '/api/launcher/remote-access/certificate',
    { preHandler: [remoteAccessLimit] },
    async (req, reply) => {
      if (rejectUnlessLauncher(req, reply)) return reply;
      try {
        return await renewPanelCertificate(req.ip);
      } catch (err) {
        return sendRouteError(reply, err, 500);
      }
    },
  );
}
