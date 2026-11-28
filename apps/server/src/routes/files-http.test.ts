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

  await t.test('a text file within the size limit can be saved however much its content grows as JSON', async () => {
    const limit = config.maxTextFileBytes;
    const read = () => fs.readFileSync(path.join(root, 'notes.txt'), 'utf8');

    // Line breaks double in JSON: a config file of the full size with many of them is over the general JSON limit.
    const lineBreaks = '\n'.repeat(limit);
    assert.ok(Buffer.byteLength(JSON.stringify(lineBreaks)) > config.maxJsonBodyBytes);
    const savedLineBreaks = await save(lineBreaks);
    assert.equal(savedLineBreaks.statusCode, 200, savedLineBreaks.body);
    assert.equal(read(), lineBreaks);

    // The worst case: every byte is a control character that JSON writes as six.
    const controlCharacters = '\u0001'.repeat(limit);
    const savedControlCharacters = await save(controlCharacters);
    assert.equal(savedControlCharacters.statusCode, 200, savedControlCharacters.body);
    assert.equal(read(), controlCharacters);

    // Over the text limit by bytes or by characters: refused with a message that says so, and the file is left alone.
    const tooManyBytes = await save('中'.repeat(Math.floor(limit / 3) + 1));
    assert.equal(tooManyBytes.statusCode, 400);
    assert.equal(tooManyBytes.json<{ code: string }>().code, 'server.files.text.tooLarge');
    const tooManyCharacters = await save('x'.repeat(limit + 1));
    assert.equal(tooManyCharacters.statusCode, 400);
    assert.equal(tooManyCharacters.json<{ code: string }>().code, 'server.files.validation.textBody');

    // The body limit is still there: nothing within the text limit can reach it.
    const overBodyLimit = await save('x'.repeat(limit * 16));
    assert.equal(overBodyLimit.statusCode, 413);
    assert.equal(overBodyLimit.json<{ code: string }>().code, 'server.common.bodyTooLarge');
    assert.equal(read(), controlCharacters);

    // Other endpoints keep the general limit.
    const mkdir = await app.inject({
      method: 'POST',
      url: `/api/instances/${id}/files/mkdir`,
      headers: authorization,
      payload: { path: 'x'.repeat(config.maxJsonBodyBytes) },
    });
    assert.equal(mkdir.statusCode, 413);
  });

  await t.test('a save that must not replace anything is refused with 409 when the name is taken', async () => {
    const saveWithPolicy = (filePath: string, content: string, onConflict: unknown = 'fail') => app.inject({
      method: 'PUT',
      url: contentUrl,
      headers: { ...authorization, 'content-type': 'application/json' },
      payload: JSON.stringify({ path: filePath, content, onConflict }),
    });
    fs.writeFileSync(path.join(root, 'ops.json'), '[]');

    const taken = await saveWithPolicy('ops.json', '');
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json<{ code: string }>().code, 'server.files.alreadyExists');
    assert.equal(fs.readFileSync(path.join(root, 'ops.json'), 'utf8'), '[]');

    const empty = await saveWithPolicy('config/new.yml', '');
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(fs.readFileSync(path.join(root, 'config', 'new.yml'), 'utf8'), '');

    const created = await saveWithPolicy('settings/new.yml', 'enabled: true\n');
    assert.equal(created.statusCode, 200, created.body);
    const createdPath = path.join(root, 'settings', 'new.yml');
    assert.equal(fs.readFileSync(createdPath, 'utf8'), 'enabled: true\n');

    const replaced = await saveWithPolicy('settings/new.yml', 'enabled: false\n', 'overwrite');
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.equal(fs.readFileSync(createdPath, 'utf8'), 'enabled: false\n');

    const unknownPolicy = await saveWithPolicy('other.yml', '', 'merge');
    assert.equal(unknownPolicy.statusCode, 400);
    assert.equal(unknownPolicy.json<{ code: string }>().code, 'server.files.validation.textBody');
    assert.equal(fs.existsSync(path.join(root, 'other.yml')), false);
  });

  await t.test('a name the system cannot handle is refused with a message that names it', async () => {
    const bad = 'bad\u0001name';
    const refused = (response: { statusCode: number; json: <T>() => T }, name: string) => {
      assert.equal(response.statusCode, 400);
      const { code, params } = response.json<{ code: string; params: unknown }>();
      assert.deepEqual({ code, params }, { code: 'server.files.name.invalidCharacter', params: { name } });
    };

    refused(await app.inject({
      method: 'POST',
      url: `/api/instances/${id}/files/mkdir`,
      headers: authorization,
      payload: { path: `plugins/${bad}` },
    }), bad);
    assert.equal(fs.existsSync(path.join(root, 'plugins')), false);
    refused(await save('x', authorization, `${bad}.yml`), `${bad}.yml`);
    refused(await app.inject({
      method: 'POST',
      url: `/api/instances/${id}/files/rename`,
      headers: authorization,
      payload: { from: 'download.txt', to: bad },
    }), bad);
    assert.equal(fs.readFileSync(path.join(root, 'download.txt'), 'utf8'), 'download');
  });
});
