// After the build, generates .br / .gz precompressed copies of the text assets in dist;
// with preCompressed enabled the server's @fastify/static sends them directly based on Accept-Encoding, with no compression at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);
// For very small files the compression gain is less than the extra header overhead, so they are skipped.
const MIN_BYTES = 1024;

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

if (!fs.existsSync(distDir)) {
  console.error(`找不到构建目录：${distDir}`);
  process.exit(1);
}

let compressed = 0;
for (const file of walkFiles(distDir)) {
  if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(file))) continue;
  const source = fs.readFileSync(file);
  if (source.length < MIN_BYTES) continue;

  const brotli = zlib.brotliCompressSync(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  const gzip = zlib.gzipSync(source, { level: zlib.constants.Z_BEST_COMPRESSION });
  if (brotli.length < source.length) fs.writeFileSync(`${file}.br`, brotli);
  if (gzip.length < source.length) fs.writeFileSync(`${file}.gz`, gzip);
  compressed += 1;
}

console.log(`已为 ${compressed} 个前端资源生成 .br / .gz 预压缩副本`);
