import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordBodySchema,
  loginBodySchema,
  setupBodySchema,
  type AuthUser,
  type ChangePasswordInput,
  type ChangePasswordResult,
  type LoginInput,
  type SetupInput,
} from '@mystry/shared';
import {
  changePassword,
  getUserById,
  isTokenVersionCurrent,
  needsSetup,
  setupAdmin,
  verifyLogin,
  type SessionUser,
} from '../services/auth-service.js';
import { config } from '../config.js';
import { errorBody, panelErrorBody, PanelError } from '../utils/errors.js';
import { createLoginFailureLimiter, createRateLimitHook, tokenMatches } from '../services/security-service.js';

/** tv 为签发时的令牌版本；0.2.0-preview.3 及更早签发的令牌没有该字段，按 0 处理。 */
export type JwtUser = { id: string; username: string; tv?: number };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

/** 签发带令牌版本的 JWT；响应里的 user 不含版本号。 */
async function signSession(reply: FastifyReply, user: SessionUser): Promise<{ token: string; user: AuthUser }> {
  const token = await reply.jwtSign(
    { id: user.id, username: user.username, tv: user.tokenVersion },
    { expiresIn: config.jwtExpiresIn },
  );
  return { token, user: { id: user.id, username: user.username } };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const strictAuthLimit = createRateLimitHook({
    name: 'auth',
    max: config.authRateLimitMax,
    windowMs: config.authRateLimitWindowMs,
  });
  const loginFailureLimit = createLoginFailureLimiter({
    name: 'login-failure',
    max: config.authRateLimitMax,
    windowMs: config.authRateLimitWindowMs,
  });

  app.get('/api/auth/status', async () => ({ needsSetup: needsSetup() }));

  app.post<{ Body: SetupInput }>(
    '/api/auth/setup',
    {
      attachValidation: true,
      schema: { body: setupBodySchema },
      preHandler: [strictAuthLimit],
    },
    async (req, reply) => {
      if (!tokenMatches(req.headers['x-setup-token'], config.setupToken)) {
        return reply.code(401).send(panelErrorBody('server.auth.invalidSetupToken'));
      }
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.invalidCredentialFormat'));
      }
      try {
        return await signSession(reply, setupAdmin(req.body.username, req.body.password));
      } catch (err) {
        const alreadyInitialized = err instanceof PanelError && err.messageKey === 'server.auth.alreadyInitialized';
        return reply.code(alreadyInitialized ? 409 : 400).send(errorBody(err));
      }
    },
  );

  app.post<{ Body: LoginInput }>(
    '/api/auth/login',
    {
      attachValidation: true,
      schema: { body: loginBodySchema },
    },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.invalidCredentialFormat'));
      }
      if (loginFailureLimit.isBlocked(req, reply, req.body.username)) return reply;
      const user = verifyLogin(req.body.username, req.body.password);
      if (!user) {
        loginFailureLimit.recordFailure(req, reply, req.body.username);
        return reply.code(401).send(panelErrorBody('server.auth.invalidCredentials'));
      }
      loginFailureLimit.reset(req, req.body.username);
      return signSession(reply, user);
    },
  );

  app.post<{ Body: ChangePasswordInput }>(
    '/api/auth/password',
    {
      attachValidation: true,
      schema: { body: changePasswordBodySchema },
      preHandler: [app.authenticate, strictAuthLimit],
    },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.invalidCredentialFormat'));
      }
      let user: SessionUser;
      try {
        user = changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
      } catch (err) {
        return reply.code(400).send(errorBody(err));
      }
      // 旧令牌（包括本次请求用的）已全部失效，当前会话换发新令牌继续登录。
      const result: ChangePasswordResult = { ok: true, ...(await signSession(reply, user)) };
      return result;
    },
  );

  app.get('/api/auth/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = getUserById(req.user.id);
    if (!user) {
      return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
    }
    return { user };
  });
}

export function registerAuthHooks(app: FastifyInstance): void {
  app.decorate('authenticate', async (req: FastifyRequest, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
    }
    // 签名有效还不够：修改或重置密码后令牌版本已变，旧令牌在过期前也要拒绝。
    if (!isTokenVersionCurrent(req.user.id, req.user.tv)) {
      return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}
