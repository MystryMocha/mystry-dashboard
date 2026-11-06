import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  changePasswordBodySchema,
  loginBodySchema,
  setupBodySchema,
  type ChangePasswordInput,
  type LoginInput,
  type SetupInput,
} from '@mystry/shared';
import { changePassword, needsSetup, setupAdmin, verifyLogin, getUserById } from '../services/auth-service.js';
import { config } from '../config.js';
import { errorBody, panelErrorBody, PanelError } from '../utils/errors.js';
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
        return reply.code(401).send(panelErrorBody('server.auth.invalidSetupToken'));
      }
      if (req.validationError) {
        return reply.code(400).send(panelErrorBody('server.auth.invalidCredentialFormat'));
      }
      try {
        const user = setupAdmin(req.body.username, req.body.password);
        const token = await reply.jwtSign(user, { expiresIn: config.jwtExpiresIn });
        return { token, user };
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
      const token = await reply.jwtSign(user, { expiresIn: config.jwtExpiresIn });
      return { token, user };
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
      try {
        changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send(errorBody(err));
      }
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
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}
