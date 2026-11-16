import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProjectKnowledge } from './check-project-knowledge.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

async function write(root, relative, content = '') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mystry-knowledge-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const scripts = {
    'knowledge:check': 'node scripts/check-project-knowledge.mjs',
  };
  const facts = {
    schemaVersion: 1,
    nodeEngine: '>=22',
    workspaces: ['apps/*', 'packages/*'],
    entrypoints: {
      shared: 'packages/shared/src/index.ts',
      server: 'apps/server/src/index.ts',
      web: 'apps/web/src/App.tsx',
    },
    routeModules: [
      { file: 'auth.ts', register: 'authRoutes' },
    ],
    environmentVariables: ['HOST', 'PORT'],
    requiredScripts: scripts,
    knowledgeDocuments: [
      'docs/ai/README.md',
      'docs/ai/current-state.md',
    ],
    sourcePaths: [
      'apps/server/src/config.ts',
    ],
    aiEntrypoints: {
      claudeCode: 'CLAUDE.md',
      knowledge: 'docs/ai/README.md',
    },
    requiredContent: [
      {
        path: 'CLAUDE.md',
        includes: ['@docs/ai/README.md'],
      },
    ],
  };

  await write(root, 'package.json', `${JSON.stringify({
    engines: { node: '>=22' },
    workspaces: ['apps/*', 'packages/*'],
    scripts,
  }, null, 2)}\n`);
  await write(root, 'docs/ai/project-facts.json', `${JSON.stringify(facts, null, 2)}\n`);
  await write(root, 'CLAUDE.md', '@docs/ai/README.md\n');
  await write(root, 'docs/ai/README.md', '[当前状态](current-state.md)\n');
  await write(root, 'docs/ai/current-state.md', '# 当前状态\n');
  await write(root, '.env.example', 'HOST=127.0.0.1\nPORT=3000\n');
  await write(
    root,
    'apps/server/src/config.ts',
    "const host = process.env.HOST;\nconst port = parsePositiveInt('PORT', 3000);\n",
  );
  await write(
    root,
    'apps/server/src/index.ts',
    'async function register(app) { await app.register(authRoutes); }\n',
  );
  await write(root, 'apps/server/src/routes/auth.ts', 'export const authRoutes = true;\n');
  await write(root, 'packages/shared/src/index.ts', 'export {};\n');
  await write(root, 'apps/web/src/App.tsx', 'export function App() { return null; }\n');

  return root;
}

test('基准知识库通过', async (t) => {
  const root = await createFixture(t);
  assert.deepEqual(await checkProjectKnowledge(root), []);
});

test('缺失 Markdown 链接会失败', async (t) => {
  const root = await createFixture(t);
  await write(root, 'docs/ai/README.md', '[缺失页面](missing.md)\n');
  const errors = await checkProjectKnowledge(root);
  assert.ok(errors.some((error) => error.includes('本地链接不存在') && error.includes('missing.md')));
});

test('新增但未登记的路由会失败', async (t) => {
  const root = await createFixture(t);
  await write(root, 'apps/server/src/routes/launcher.ts', 'export const launcherRoutes = true;\n');
  const errors = await checkProjectKnowledge(root);
  assert.ok(errors.some((error) => error.includes('服务端路由清单') && error.includes('launcher.ts')));
});

test('配置新增但未同步的环境变量会失败', async (t) => {
  const root = await createFixture(t);
  await write(
    root,
    'apps/server/src/config.ts',
    "const host = process.env.HOST;\nconst port = parsePositiveInt('PORT', 3000);\nconst extra = process.env.NEW_LIMIT;\n",
  );
  const errors = await checkProjectKnowledge(root);
  assert.ok(errors.some((error) => error.includes('环境变量') && error.includes('NEW_LIMIT')));
});

test('Claude Code 入口缺失会失败', async (t) => {
  const root = await createFixture(t);
  await fs.rm(path.join(root, 'CLAUDE.md'));
  const errors = await checkProjectKnowledge(root);
  assert.ok(errors.some((error) => error.includes('AI 入口') && error.includes('CLAUDE.md')));
});

test('经符号链接或 junction 路径运行时仍会执行检查，不会静默通过', async (t) => {
  const root = await createFixture(t);
  await fs.rm(path.join(root, 'CLAUDE.md'));
  // 复制脚本到临时目录再建链接，测试不在仓库里创建链接。
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mystry-knowledge-link-'));
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  await fs.mkdir(real);
  for (const name of ['check-project-knowledge.mjs', 'is-main-module.mjs']) {
    await fs.copyFile(path.join(scriptsDir, name), path.join(real, name));
  }
  await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => {
    await fs.rm(link, { force: true });
    await fs.rm(base, { recursive: true, force: true });
  });

  const result = spawnSync(process.execPath, [path.join(link, 'check-project-knowledge.mjs'), root], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `应发现缺失的 CLAUDE.md 并失败：${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /CLAUDE\.md/);
});
