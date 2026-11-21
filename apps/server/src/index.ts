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
  /** 测试专用：跳过数据目录锁（生产路径不得使用） */
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
    // 还原换目录现场必须先于任务恢复处理：任务恢复会清理 staging 目录。
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
          // ticket/token 类查询参数不应进入日志（下载票据、控制台票据、设置令牌等）。
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
    app.log.warn('JWT_EXPIRES_IN 已不再使用：登录有效期改在面板「本机环境」页设置，默认 12 小时');
  }
  app.addHook('onClose', async () => {
    shutdownImportPreviews();
    shutdownFolderUploads();
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  // 不设默认有效期：登录令牌只由 signSession 按面板里的登录有效期签发。
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
    // 不设置激进 CSP，避免破坏生产环境托管的前端资源；其余响应仍使用基础安全头。
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    return payload;
  });

  // 统一错误响应为全站 {error} 格式；500 不泄露内部消息（可能含绝对路径）。
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
    // Fastify 请求校验失败：原文为 AJV 生成的英文说明，作为参数交给前端拼成完整句子。
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

  // 进程指纹只用来让本机启动器认出自己启动的面板，其他设备访问时不返回。
  app.get('/api/health', async (req) => ({
    ok: true,
    service: 'mystry-dashboard',
    ...(config.processFingerprint && isLocalRequest(req)
      ? { processFingerprint: config.processFingerprint }
      : {}),
  }));

  // 生产环境托管前端构建产物。
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

  // app.close() 要等所有连接断开才返回。浏览器标签页开着时，残留的连接可能一直不断，
  // 关闭流程就停在这里，走不到释放数据目录锁。此时实例和任务都已停止，宽限期过后直接断开剩余连接。
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
      // 先停掉额外监听器并断开其他设备的连接，再等主监听器上的连接断开。
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
  // 自行跟踪全部 TCP 连接：已升级的 WebSocket 不在 Node 的 HTTP 连接列表里，closeAllConnections 管不到。
  app.server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });
  // 终端 Ctrl+C 会把 SIGINT 同时发给整个进程组，前台控制器还会再转发一次。
  // 信号处理器一直挂到进程退出：处理器一旦移除，重复信号会走默认动作直接杀掉进程，
  // 跳过任务清理、实例停止和释放数据目录锁。关闭已完成但仍有句柄让进程挂着时，
  // 再收到信号就按已有退出码直接退出，避免 Ctrl+C 完全无效。
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
  // Windows 关闭控制台窗口、Linux 关闭终端时收到的是 SIGHUP，同样要走安全关闭。
  process.on('SIGHUP', handleSignal);
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`面板已启动 http://${config.host}:${config.port}`);
    // 按设置恢复「从其他设备访问」；失败只记录原因，面板照常只监听本机。
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
