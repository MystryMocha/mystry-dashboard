import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordBodySchema,
  loginBodySchema,
  setupBodySchema,
  updateSessionDurationBodySchema,
  type AuthUser,
  type ChangePasswordInput,
  type ChangePasswordResult,
  type LoginInput,
  type SessionDurationSetting,
  type SetupInput,
  type UpdateSessionDurationResult,
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
import {
  getSessionDuration,
  isWithinSessionDuration,
  sessionExpiresIn,
  setSessionDuration,
} from '../services/session-duration-service.js';
import { config } from '../config.js';
import { errorBody, panelErrorBody, PanelError } from '../utils/errors.js';
import { createLoginFailureLimiter, createRateLimitHook, tokenMatches } from '../services/security-service.js';

/**
 * tv 为签发时的令牌版本；0.2.0-preview.3 及更早签发的令牌没有该字段，按 0 处理。
 * iat 为签发时间（秒），由 @fastify/jwt 自动写入，用来对照当前登录有效期。
 */
export type JwtUser = { id: string; username: string; tv?: number; iat?: number };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

/**
 * 签发带令牌版本的 JWT；有效期按面板里的登录有效期设置（D-040），「不过期」时不写 exp。
 * 这是唯一签发登录令牌的地方，@fastify/jwt 注册时不设默认有效期。响应里的 user 不含版本号。
 */
async function signSession(reply: FastifyReply, user: SessionUser): Promise<{ token: string; user: AuthUser }> {
  const expiresIn = sessionExpiresIn(getSessionDuration());
  const token = await reply.jwtSign(
    { id: user.id, username: user.username, tv: user.tokenVersion },
    expiresIn ? { expiresIn } : {},
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

  app.get(
    '/api/auth/session-duration',
    { preHandler: [app.authenticate] },
    async (): Promise<SessionDurationSetting> => ({ duration: getSessionDuration() }),
  );

  // 选择框改了就保存，不套用登录接口那样严的频率限制。
  app.put<{ Body: SessionDurationSetting }>(
    '/api/auth/session-duration',
    {
      attachValidation: true,
      schema: { body: updateSessionDurationBodySchema },
      preHandler: [app.authenticate],
    },
    async (req, reply) => {
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.sessionDurationInvalid'));
      }
      const user = getUserById(req.user.id);
      if (!user) {
        return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
      }
      setSessionDuration(req.body.duration);
      // 当前设备按新有效期换发令牌，改长也马上生效；令牌版本沿用，authenticate 已确认它是当前版本。
      const { token } = await signSession(reply, { ...user, tokenVersion: req.user.tv ?? 0 });
      const result: UpdateSessionDurationResult = { duration: getSessionDuration(), token };
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
    // 登录有效期改短后，按签发时间算已超时的令牌（包括按「不过期」签发、不带 exp 的）也要拒绝。
    if (!isWithinSessionDuration(req.user.iat)) {
      return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}
