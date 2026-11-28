/**
 * File endpoints over HTTP: what a request gets back before and after sign-in, and the limits on saving a text file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);
// Small limits keep the request bodies small. The two are equal, as they are by default (1 MiB each).
process.env.MAX_TEXT_FILE_BYTES = '4096';
process.env.MAX_JSON_BODY_BYTES = '4096';

test('file endpoints over HTTP', async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystry-files-http-test-'));
  process.env.MYSTRY_DATA_DIR = dataRoot;
  const { buildApp } = await import('../index.js');
  const { config } = await import('../config.js');
  const { defaultInstanceDir } = await import('../utils/path.js');
  const app = await buildApp({ skipDataLock: true });
  t.after(async () => {
    await app.close();
    const { closeDb } = await import('../db.js');
    closeDb();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'x-setup-token': 'b'.repeat(64) },
    payload: { username: 'admin12', password: 'password1234' },
  });
  assert.equal(setup.statusCode, 200);
  const authorization = { authorization: `Bearer ${setup.json<{ token: string }>().token}` };
  const created = await app.inject({ method: 'POST', url: '/api/instances', headers: authorization, payload: { name: 'files-http' } });
  assert.equal(created.statusCode, 200);
  const id = created.json<{ id: string }>().id;
  const root = defaultInstanceDir(id);
  const contentUrl = `/api/instances/${id}/files/content`;

  const save = (content: string, headers: Record<string, string> = authorization, filePath = 'notes.txt') => app.inject({
    method: 'PUT',
    url: contentUrl,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ path: filePath, content }),
  });

  await t.test('sign-in is checked before the request body is read', async () => {
    // A body far over every limit: answered with 413 if it were read first.
    const oversized = await save('x'.repeat(config.maxTextFileBytes * 16), {});
    assert.equal(oversized.statusCode, 401);
    assert.equal(oversized.json<{ code: string }>().code, 'server.common.unauthorized');
    assert.equal(fs.existsSync(path.join(root, 'notes.txt')), false);

    for (const request of [
      { method: 'GET', url: `/api/instances/${id}/files` },
      { method: 'POST', url: `/api/instances/${id}/files/mkdir`, payload: { path: 'plugins' } },
      { method: 'POST', url: `/api/instances/${id}/files/upload` },
      { method: 'PUT', url: `/api/instances/${id}/config/server.properties`, payload: { motd: 'x' } },
    ] as const) {
      assert.equal((await app.inject(request)).statusCode, 401, `${request.method} ${request.url}`);
    }
    assert.equal(fs.existsSync(path.join(root, 'plugins')), false);

    // A download may carry a one-time ticket instead of the sign-in token; a ticket that was never issued is still refused, by the route itself.
    fs.writeFileSync(path.join(root, 'download.txt'), 'download');
    const withoutTicket = await app.inject({ method: 'GET', url: `/api/instances/${id}/files/download?path=download.txt` });
    assert.equal(withoutTicket.statusCode, 401);
    assert.equal(withoutTicket.json<{ code: string }>().code, 'server.common.unauthorized');
    const unknownTicket = await app.inject({ method: 'GET', url: `/api/instances/${id}/files/download?path=download.txt&ticket=never-issued` });
    assert.equal(unknownTicket.statusCode, 401);
    assert.equal(unknownTicket.json<{ code: string }>().code, 'server.files.download.linkExpired');
    const signedIn = await app.inject({ method: 'GET', url: `/api/instances/${id}/files/download?path=download.txt`, headers: authorization });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.body, 'download');
  });
});
