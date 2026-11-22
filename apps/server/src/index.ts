import type { Socket } from 'node:net';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { getDb, initDb } from './db.js';
import { takeStartupNotices } from './utils/data-dir-permissions.js';
import { registerFrontendAssets } from './frontend-assets.js';
import { authRoutes, registerAuthHooks } from './routes/auth.js';
import { instanceRoutes } from './routes/instances.js';
import { fileRoutes } from './routes/files.js';
import { backupRoutes } from './routes/backups.js';
import { coreRoutes } from './routes/cores.js';
import { consoleRoutes } from './routes/console.js';
import { systemRoutes } from './routes/system.js';
import { nodeRoutes } from './routes/nodes.js';
import { frpRoutes } from './routes/frp.js';
import { lanRoutes } from './routes/lan.js';
import {
  launcherRoutes,
  type LauncherRouteOptions,
  type ShutdownSummary,
} from './routes/launcher.js';
import { processManager } from './services/process-manager.js';
import { createRateLimitHook } from './services/security-service.js';
import { errorBody, PanelError, panelErrorBody } from './utils/errors.js';
import { isMainModule } from './utils/real-path.js';
import {
  getTaskActivity,
  recoverInterruptedTasks,
  shutdownTasks,
} from './services/task-service.js';
import {
  acquirePanelDataLock,
  type PanelDataLock,
} from './services/data-lock-service.js';
import { recoverInterruptedBackups } from './services/backup-service.js';
import {
  initializeImportPreviews,
  shutdownImportPreviews,
} from './services/import-preview-service.js';
import { initializeFolderUploads, shutdownFolderUploads } from './services/folder-upload-service.js';
import { attachFrpLifecycle, shutdownFrp } from './services/frp-manager.js';
import { attachLanLifecycle, shutdownLan } from './services/lan-manager.js';
import { isLocalRequest } from './utils/request-origin.js';
import {
  initRemoteAccess,
  shutdownRemoteAccess,
} from './services/remote-access-service.js';

export type BuildAppOptions = LauncherRouteOptions & {
  isShuttingDown?: () => boolean;
  /** Tests only: skips the data directory lock (must not be used on the production path) */
  skipDataLock?: boolean;
};

let activePanelDataLock: PanelDataLock | null = null;

const defaultCloseGraceMs = 5_000;

function getCloseGraceMs(): number {
  const fromEnv = process.env.MYSTRY_TEST_CLOSE_GRACE_MS;
  if (!fromEnv) return defaultCloseGraceMs;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultCloseGraceMs;
}

export function releasePanelDataLock(): void {
  activePanelDataLock?.release();
  activePanelDataLock = null;
}

export async function buildApp(options: BuildAppOptions = {}) {
  if (!options.skipDataLock) {
    activePanelDataLock = acquirePanelDataLock(config.dataDir);
  }
  try {
    initDb();
    // Recovering an interrupted restore directory swap must come before task recovery: task recovery cleans up the staging directory.
    const backupRecovery = recoverInterruptedBackups();
    const taskRecovery = recoverInterruptedTasks();
    attachFrpLifecycle();
    attachLanLifecycle();
    const previewRecovery = initializeImportPreviews();
    const folderUploadRecovery = initializeFolderUploads();

  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          // ticket/token query parameters must not end up in logs (download tickets, console tickets, setup tokens, etc.).
          const url = request.url.replace(/([?&](?:ticket|token)=)[^&]*/gi, '$1[redacted]');
          return {
            method: request.method,
            url,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    bodyLimit: config.maxJsonBodyBytes,
    requestTimeout: config.httpRequestTimeoutMs,
    connectionTimeout: config.httpConnectionTimeoutMs,
    keepAliveTimeout: config.httpKeepAliveTimeoutMs,
    ajv: { customOptions: { removeAdditional: false } },
  });
  for (const notice of takeStartupNotices()) app.log.warn({ quiet: true }, notice);
  if (backupRecovery.restoresRolledBack > 0 || backupRecovery.restoresCompleted > 0 || backupRecovery.tempFilesRemoved > 0) {
    app.log.warn(backupRecovery, '已处理上次面板进程中断的备份或还原');
  }
  if (taskRecovery.interrupted > 0) {
    app.log.warn(taskRecovery, '已将上次面板进程遗留的任务标记为失败');
  }
  if (previewRecovery.purged > 0) {
    app.log.info(previewRecovery, '已清理上次面板进程遗留的 ZIP 导入预览');
  }
  if (folderUploadRecovery.purged > 0) {
    app.log.info(folderUploadRecovery, '已清理上次面板进程遗留的文件夹上传');
  }
  if (process.env.JWT_EXPIRES_IN?.trim()) {
    app.log.warn('JWT_EXPIRES_IN 已不再使用：登录有效期改在面板「面板设置」页设置，默认 12 小时');
  }
  app.addHook('onClose', async () => {
    shutdownImportPreviews();
    shutdownFolderUploads();
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  // No default expiry: sign-in tokens are issued only by signSession, using the session duration set in the panel.
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 10,
      parts: 20,
      fieldSize: 64 * 1024,
    },
  });
  await app.register(websocket, {
    options: {
      maxPayload: config.maxConsoleIncomingBytes,
      perMessageDeflate: false,
    },
  });

  app.addHook(
    'onRequest',
    createRateLimitHook({
      name: 'global',
      max: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
    }),
  );
  app.addHook('onRequest', async (req, reply) => {
    if (
      options.isShuttingDown?.()
      && req.url !== '/api/health'
      && req.url !== '/api/launcher/shutdown'
    ) {
      return reply.code(503).send(panelErrorBody('server.common.shuttingDown'));
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    // No aggressive CSP, so the frontend assets served in production are not broken; other responses still use the basic security headers.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    return payload;
  });

  // Normalize error responses to the site-wide {error} format; 500s do not leak internal messages (which may contain absolute paths).
  app.setErrorHandler((error, req, reply) => {
    req.log.error(error);
    if (reply.sent) return;
    const err = error as { statusCode?: unknown; message?: unknown; validation?: unknown };
    const rawStatus = error instanceof PanelError && error.statusCode !== undefined ? error.statusCode : err.statusCode;
    const statusCode =
      typeof rawStatus === 'number' && Number.isInteger(rawStatus) ? rawStatus : 500;
    const normalized = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (normalized === 500) {
      return reply.code(500).send(panelErrorBody('server.common.internal'));
    }
    if (error instanceof PanelError) return reply.code(normalized).send(errorBody(error));
    // Fastify request validation failure: the original text is the English description generated by AJV, passed as a param for the frontend to build a full sentence.
    if (err.validation && typeof err.message === 'string') {
      return reply.code(normalized).send(panelErrorBody('server.common.invalidRequest', { detail: err.message }));
    }
    return reply
      .code(normalized)
      .send(typeof err.message === 'string' ? { error: err.message } : panelErrorBody('server.common.requestFailed'));
  });

  registerAuthHooks(app);

  await app.register(authRoutes);
  await app.register(instanceRoutes);
  await app.register(fileRoutes);
  await app.register(backupRoutes);
  await app.register(coreRoutes);
  await app.register(consoleRoutes);
  await app.register(systemRoutes);
  await app.register(nodeRoutes);
  await app.register(frpRoutes);
  await app.register(lanRoutes);
  await app.register(launcherRoutes, {
    prepareShutdown: options.prepareShutdown,
    startShutdown: options.startShutdown,
  });

  // The process fingerprint only lets the local launcher recognize the panel it started; it is not returned to other devices.
  app.get('/api/health', async (req) => ({
    ok: true,
    service: 'mystry-dashboard',
    ...(config.processFingerprint && isLocalRequest(req)
      ? { processFingerprint: config.processFingerprint }
      : {}),
  }));

  // Serve the frontend build output in production.
  await registerFrontendAssets(app, config.webDist);

  return app;
  } catch (error) {
    shutdownImportPreviews();
    releasePanelDataLock();
    throw error;
  }
}

async function main() {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let shutdownCompleted = false;
  const openSockets = new Set<Socket>();

  // app.close() returns only after every connection is closed. With a browser tab open, leftover connections may never close,
  // so shutdown would stall here and never reach releasing the data directory lock. Instances and tasks are already stopped by now, so after the grace period the remaining connections are dropped.
  const closeAppWithGrace = async (target: NonNullable<typeof app>): Promise<void> => {
    const closing = target.close();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      closing.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), getCloseGraceMs());
      }),
    ]);
    clearTimeout(timer);
    if (!timedOut) return;
    target.log.warn(
      { openConnections: openSockets.size },
      '等待连接断开超时，已强制断开剩余连接',
    );
    for (const socket of openSockets) socket.destroy();
    await closing;
  };

  const prepareShutdown = (): ShutdownSummary => {
    const alreadyShuttingDown = shuttingDown;
    const taskActivity = getTaskActivity();
    const summary = {
      runningInstances: processManager.getRunningCount(),
      runningTasks: taskActivity.running,
      queuedTasks: taskActivity.queued,
      alreadyShuttingDown,
    };
    shuttingDown = true;
    processManager.beginShutdown();
    return summary;
  };

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    if (!shuttingDown) prepareShutdown();

    shutdownPromise = (async () => {
      app?.log.info({ reason }, '正在安全关闭面板');
      await shutdownTasks();
      const instanceResult = await processManager.stopAll();
      if (instanceResult.errors.length > 0) {
        app?.log.error(
          { errors: instanceResult.errors },
          '部分 Minecraft 实例关闭时发生错误',
        );
      }
      if (instanceResult.stillStopping.length > 0) {
        app?.log.warn(
          { instanceIds: instanceResult.stillStopping },
          '部分 Minecraft 实例在宽限期内未能完全退出，未发送 SIGKILL',
        );
      }
      await shutdownFrp();
      await shutdownLan();
      // Stop the extra listeners and drop connections from other devices first, then wait for connections on the main listener to close.
      await shutdownRemoteAccess();
      if (app) await closeAppWithGrace(app);
      releasePanelDataLock();
      getDb().close();
    })().catch((error) => {
      process.exitCode = 1;
      console.error('安全关闭面板失败', error);
    }).finally(() => {
      shutdownCompleted = true;
    });
    return shutdownPromise;
  };

  app = await buildApp({
    isShuttingDown: () => shuttingDown,
    prepareShutdown,
    startShutdown: () => {
      void shutdown('launcher');
    },
  });
  // Track all TCP connections ourselves: upgraded WebSockets are not in Node's HTTP connection list, so closeAllConnections does not reach them.
  app.server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  // Ctrl+C in a terminal sends SIGINT to the whole process group, and the foreground controller forwards it once more.
  // The signal handlers stay attached until the process exits: once a handler is removed, a repeated signal takes the default action and kills the process,
  // skipping task cleanup, instance stop and releasing the data directory lock. When shutdown has finished but a handle still keeps the process alive,
  // another signal exits immediately with the existing exit code, so Ctrl+C is never completely ineffective.
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownCompleted) {
      process.exit();
    }
    if (shutdownPromise) {
      app?.log.info({ signal }, '面板正在安全关闭，已忽略重复的关闭信号');
      return;
    }
    prepareShutdown();
    void shutdown(signal);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  // Closing the console window on Windows, or the terminal on Linux, delivers SIGHUP, which must go through the safe shutdown too.
  process.on('SIGHUP', handleSignal);
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`面板已启动 http://${config.host}:${config.port}`);
    // Restore "access from other devices" from the settings; on failure only the reason is recorded, and the panel keeps listening on this machine only as usual.
    await initRemoteAccess({ httpServer: app.server, log: app.log }).catch((error: unknown) => {
      app?.log.warn({ err: error }, '恢复从其他设备访问的设置失败');
    });
  } catch (error) {
    await app.close();
    releasePanelDataLock();
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
