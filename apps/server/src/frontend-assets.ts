import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Vite 产物中带内容 hash 的文件，内容变化必然换文件名，可长期缓存。 */
const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** index.html 等入口必须每次向服务端确认，保证升级后立即拿到新的资源引用。 */
const ENTRY_CACHE_CONTROL = 'no-cache';

export async function registerFrontendAssets(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  if (!fs.existsSync(webDist)) return;

  const distRoot = path.resolve(webDist);
  // path.relative 在 Windows 上不区分大小写，比字符串前缀比较更稳妥。
  const isHashedAsset = (filePath: string) =>
    path.relative(distRoot, path.resolve(filePath)).split(path.sep)[0] === 'assets';

  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: true,
    // 构建脚本生成的 .br / .gz 副本按 Accept-Encoding 直接发送，缺失时回落原文件。
    preCompressed: true,
    setHeaders(reply, filePath) {
      reply.header(
        'cache-control',
        isHashedAsset(filePath) ? HASHED_ASSET_CACHE_CONTROL : ENTRY_CACHE_CONTROL,
      );
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });
}
