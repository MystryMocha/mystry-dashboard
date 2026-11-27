import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.SETUP_TOKEN = randomBytes(32).toString('hex');
process.env.LAUNCHER_TOKEN = randomBytes(32).toString('hex');

function sendChunkedRequest(
  port: number,
  urlPath: string,
  drive: (req: http.ClientRequest, isDone: () => boolean) => Promise<void> | void,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
      },
    });
    let settled = false;
    let responded = false;
    const finish = (result: { statusCode: number; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('response', (res) => {
      responded = true;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => finish({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    req.on('error', (error) => {
      // Ignore write-side errors after the server already started replying (e.g. 408).
      if (responded) return;
      setTimeout(() => {
        if (!responded) fail(error);
      }, 20);
    });
    Promise.resolve(drive(req, () => settled || responded || req.destroyed)).catch(fail);
  });
}

test('regular routes enforce total requestTimeout while streaming uploads use idle timeout and survive post-body verification', async (t) => {
  const { attachRequestTimeoutHook, switchToStreamingUploadTimeout } = await import('./request-timeout.js');
  const app = Fastify({ requestTimeout: 0 });
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  attachRequestTimeoutHook(app, 180);

  app.post('/regular', async (req) => {
    let total = 0;
    for await (const chunk of req.body as AsyncIterable<Buffer>) {
      total += chunk.length;
    }
    return { total };
  });

  app.post('/upload', async (req, reply) => {
    switchToStreamingUploadTimeout(req, reply, 140);
    let total = 0;
    for await (const chunk of req.body as AsyncIterable<Buffer>) {
      total += chunk.length;
    }
    return { total };
  });

  app.post('/upload-slow-verify', async (req, reply) => {
    switchToStreamingUploadTimeout(req, reply, 80);
    let total = 0;
    for await (const chunk of req.body as AsyncIterable<Buffer>) {
      total += chunk.length;
    }
    // Simulate post-upload archive verification lasting longer than uploadIdleTimeoutMs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { total };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
  });
  const { port } = app.server.address() as { port: number };

  // 1. Regular route times out with 408 even while chunks keep trickling in beyond 180ms.
  const regular = await sendChunkedRequest(port, '/regular', async (req, isDone) => {
    for (let i = 0; i < 8; i += 1) {
      if (isDone()) return;
      req.write('a');
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    if (!isDone()) req.end();
  });
  assert.equal(regular.statusCode, 408);
  assert.equal(JSON.parse(regular.body).code, 'server.common.requestTimeout');

  // 2. Streaming upload outlives the 180ms regular request deadline (~300ms total) because chunks arrive every 50ms (< 140ms idle).
  const upload = await sendChunkedRequest(port, '/upload', async (req) => {
    for (let i = 0; i < 6; i += 1) {
      req.write('chunk');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    req.end();
  });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.deepEqual(JSON.parse(upload.body), { total: 30 });

  // 3. Streaming upload that stalls mid-body exceeds the 140ms idle timeout and returns 408.
  const stalled = await sendChunkedRequest(port, '/upload', (req) => {
    req.write('start');
    // Intentionally never ends or writes again.
  });
  assert.equal(stalled.statusCode, 408);
  assert.equal(JSON.parse(stalled.body).code, 'server.files.upload.idleTimeout');

  // 4. Once the request body ends, post-upload verification longer than the 80ms idle timeout still succeeds.
  const verified = await sendChunkedRequest(port, '/upload-slow-verify', (req) => {
    req.end('archive-bytes');
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.deepEqual(JSON.parse(verified.body), { total: 13 });
});

test('request timeout hook does not abort slow streaming GET downloads or WebSocket upgrades', async (t) => {
  const { attachRequestTimeoutHook } = await import('./request-timeout.js');
  const app = Fastify({ requestTimeout: 0 });
  // Intentionally register the timeout hook BEFORE `@fastify/websocket` as well, verifying synthetic `injectWS`
  // requests without EventEmitter methods and real TCP upgrades are both handled safely regardless of hook order.
  attachRequestTimeoutHook(app, 100);
  await app.register(websocket);

  app.get('/slow-download', async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    reply.raw.write('part-1:');
    await new Promise((resolve) => setTimeout(resolve, 220));
    reply.raw.end('part-2');
    return reply;
  });

  app.get('/ws-echo', { websocket: true }, (socket) => {
    socket.on('message', (data) => {
      socket.send(`echo:${String(data)}`);
    });
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
  });
  const { port } = app.server.address() as { port: number };

  // 1. Slow GET download outlives the 100ms request receive timeout without being aborted.
  const download = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/slow-download' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, 'part-1:part-2');

  // 2. Real TCP WebSocket connection stays open and responsive past the 100ms HTTP request timeout.
  const wsReply = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws-echo`);
    ws.once('open', () => {
      setTimeout(() => {
        ws.send('still-alive');
      }, 220);
    });
    ws.once('message', (data) => {
      ws.close();
      resolve(String(data));
    });
    ws.once('error', reject);
  });
  assert.equal(wsReply, 'echo:still-alive');

  // 3. Synthetic `@fastify/websocket` `injectWS` upgrade request succeeds without crashing on `rawReq.once`.
  const injectedReply = await new Promise<string>((resolve, reject) => {
    app.injectWS('/ws-echo', {}, {
      onInit(ws) {
        ws.once('message', (data) => {
          ws.close();
          resolve(String(data));
        });
        ws.once('error', reject);
      },
      onOpen(ws) {
        ws.send('ping');
      },
    }).catch(reject);
  });
  assert.equal(injectedReply, 'echo:ping');
});
