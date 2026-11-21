import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import type { CreateNodeInput, NodeInfo, NodeSecretResult, UpdateNodeInput } from '@mystry/shared';
import { REMOTE_NODE_CREATION_ENABLED } from '@mystry/shared';
import { getDb, type NodeRow } from '../db.js';
import { nowIso } from '../utils/path.js';
import { nodeRegistry } from './node-registry.js';
import { PanelError } from '../utils/errors.js';

/** Node secrets are stored as a sha256 digest: the secret itself is a high-entropy random string, so a slow bcrypt hash is unnecessary */
function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function rowToInfo(row: NodeRow): NodeInfo {
  const instanceCount = (
    getDb().prepare('SELECT COUNT(*) as c FROM instances WHERE node_id = ?').get(row.id) as {
      c: number;
    }
  ).c;
  return {
    id: row.id,
    name: row.name,
    isLocal: Boolean(row.is_local),
    status: nodeRegistry.getStatus(row.id),
    lastSeenAt: nodeRegistry.getLastSeenAt(row.id),
    hostInfo: nodeRegistry.getHostInfo(row.id) ?? parseHostInfo(row.host_info),
    instanceCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseHostInfo(raw: string | null): NodeInfo['hostInfo'] {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function listNodes(): NodeInfo[] {
  const rows = getDb().prepare('SELECT * FROM nodes ORDER BY is_local DESC, created_at ASC').all() as NodeRow[];
  return rows.map(rowToInfo);
}

export function getNode(id: string): NodeInfo | null {
  const row = getNodeRow(id);
  return row ? rowToInfo(row) : null;
}

export function getNodeRow(id: string): NodeRow | null {
  const row = getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
  return row ?? null;
}

/** Creates a remote node, returning the node info and the secret shown only once (to put into the config when deploying the Agent) */
export function createNode(input: CreateNodeInput): NodeSecretResult {
  if (!REMOTE_NODE_CREATION_ENABLED) {
    throw new PanelError('server.system.remoteNodeCreationDisabled');
  }
  if (!input.name?.trim()) {
    throw new PanelError('server.system.nodeNameRequired');
  }
  const id = nanoid(12);
  const now = nowIso();
  const secret = generateSecret();
  getDb()
    .prepare(
      `INSERT INTO nodes (id, name, secret_hash, is_local, host_info, created_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(id, input.name.trim(), hashSecret(secret), now, now);
  return { node: getNode(id)!, secret };
}

export function updateNode(id: string, input: UpdateNodeInput): NodeInfo {
  const existing = getNodeRow(id);
  if (!existing) throw new PanelError('server.system.nodeNotFound');
  if (input.name !== undefined && !input.name.trim()) {
    throw new PanelError('server.system.nodeNameRequired');
  }
  getDb()
    .prepare('UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?')
    .run(input.name?.trim() ?? existing.name, nowIso(), id);
  return getNode(id)!;
}

export function deleteNode(id: string): void {
  const existing = getNodeRow(id);
  if (!existing) return;
  if (existing.is_local) {
    throw new PanelError('server.system.localNodeDelete');
  }
  const { c } = getDb()
    .prepare('SELECT COUNT(*) as c FROM instances WHERE node_id = ?')
    .get(id) as { c: number };
  if (c > 0) {
    throw new PanelError('server.system.nodeHasInstances');
  }
  getDb().prepare('DELETE FROM nodes WHERE id = ?').run(id);
  nodeRegistry.markOffline(id);
}

/** Resets the node secret; the old secret is invalid immediately and the new one is returned only once */
export function resetNodeSecret(id: string): NodeSecretResult {
  const existing = getNodeRow(id);
  if (!existing) throw new PanelError('server.system.nodeNotFound');
  if (existing.is_local) {
    throw new PanelError('server.system.localNodeNoSecret');
  }
  const secret = generateSecret();
  getDb()
    .prepare('UPDATE nodes SET secret_hash = ?, updated_at = ? WHERE id = ?')
    .run(hashSecret(secret), nowIso(), id);
  return { node: getNode(id)!, secret };
}

export function nodeExists(id: string): boolean {
  return Boolean(getNodeRow(id));
}
