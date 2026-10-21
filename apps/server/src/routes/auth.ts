import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginBodySchema, setupBodySchema, type LoginInput, type SetupInput } from '@mystry/shared';
import { needsSetup, setupAdmin, verifyLogin, getUserById } from '../services/auth-service.js';
import { config } from '../config.js';
import { errorMessage } from '../utils/errors.js';
import { createLoginFailureLimiter, createRateLimitHook, tokenMatches } from '../services/security-service.js';

export type JwtUser = { id: string; username: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
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
        return reply.code(401).send({ error: '初始化令牌无效' });
      }
      if (req.validationError) {
        return reply.code(400).send({ error: '用户名或密码格式不正确' });
      }
      try {
        const user = setupAdmin(req.body.username, req.body.password);
        const token = await reply.jwtSign(user, { expiresIn: config.jwtExpiresIn });
        return { token, user };
      } catch (err) {
        const message = errorMessage(err);
        return reply.code(message === '管理员已初始化' ? 409 : 400).send({ error: message });
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
        return reply.code(400).send({ error: '用户名或密码格式不正确' });
      }
      if (loginFailureLimit.isBlocked(req, reply, req.body.username)) return reply;
      const user = verifyLogin(req.body.username, req.body.password);
      if (!user) {
        loginFailureLimit.recordFailure(req, reply, req.body.username);
        return reply.code(401).send({ error: '用户名或密码错误' });
      }
      loginFailureLimit.reset(req, req.body.username);
      const token = await reply.jwtSign(user, { expiresIn: config.jwtExpiresIn });
      return { token, user };
    },
  );

  app.get('/api/auth/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = getUserById(req.user.id);
    if (!user) {
      return reply.code(401).send({ error: '登录已失效，请重新登录' });
    }
    return { user };
  });
}

export function registerAuthHooks(app: FastifyInstance): void {
  app.decorate('authenticate', async (req: FastifyRequest, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: '登录已失效，请重新登录' });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}
