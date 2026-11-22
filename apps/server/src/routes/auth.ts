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
 * tv is the token version at issue time; tokens issued by 0.2.0-preview.3 and earlier lack this field and are treated as 0.
 * iat is the issue time (seconds), written automatically by @fastify/jwt and used to check against the current session duration.
 */
export type JwtUser = { id: string; username: string; tv?: number; iat?: number };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

/**
 * Issues a JWT carrying the token version; the expiry follows the session duration set in the panel, and exp is not written for "never expire".
 * This is the only place that issues sign-in tokens; @fastify/jwt is registered without a default expiry. The user in the response does not include the version.
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
      // The old tokens (including the one used for this request) are all invalid now; the current session stays signed in with a reissued token.
      const result: ChangePasswordResult = { ok: true, ...(await signSession(reply, user)) };
      return result;
    },
  );

  app.get(
    '/api/auth/session-duration',
    { preHandler: [app.authenticate] },
    async (): Promise<SessionDurationSetting> => ({ duration: getSessionDuration() }),
  );

  // Saved as soon as the select changes, so the strict rate limit of the sign-in endpoints is not applied.
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
      // This device gets a token reissued with the new duration, so a longer one takes effect right away too; the token version is kept, and authenticate has already confirmed it is the current version.
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
    // A valid signature is not enough: after a password change or reset the token version has changed, and old tokens must be rejected before they expire too.
    if (!isTokenVersionCurrent(req.user.id, req.user.tv)) {
      return reply.code(401).send(panelErrorBody('server.common.unauthorized'));
    }
    // After the session duration is shortened, tokens that have timed out by their issue time (including ones issued as "never expire" without exp) must be rejected too.
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
