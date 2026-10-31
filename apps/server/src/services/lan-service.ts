import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InstanceLanInput } from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { nowIso } from '../utils/path.js';
import { getInstanceRow } from './instance-service.js';
import { type LanIdentity, renderLanToml, type LanRenderInput } from './lan-config.js';

export interface InstanceLanRow extends LanIdentity {
  instance_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function getInstanceLanRow(instanceId: string): InstanceLanRow | null {
  return readLanRow(instanceId);
}

export function listEnabledLanInstanceIds(): string[] {
  const rows = getDb().prepare('SELECT instance_id FROM instance_lans WHERE enabled = 1').all() as Array<{ instance_id: string }>;
  return rows.map((row) => row.instance_id);
}

/** 第一次保存才生成网络名、密钥和网段。之后关闭再打开仍用原来的，朋友不用重装。 */
export function saveInstanceLan(instanceId: string, input: InstanceLanInput): InstanceLanRow {
  if (!getInstanceRow(instanceId)) {
    throw new PanelError('server.lan.instanceNotFound', undefined, { statusCode: 404 });
  }
  if (typeof input.enabled !== 'boolean') throw new PanelError('server.lan.invalidParams');
  const existing = getInstanceLanRow(instanceId);
  const now = nowIso();
  if (!existing) {
    const row: InstanceLanRow = {
      instance_id: instanceId,
      enabled: input.enabled ? 1 : 0,
      networkName: `mystry-${randomBytes(16).toString('hex')}`,
      networkSecret: randomBytes(32).toString('hex'),
      octet: allocateOctet(instanceId),
      created_at: now,
      updated_at: now,
    };
    getDb().prepare(`
      INSERT INTO instance_lans (
        instance_id, enabled, network_name, network_secret, ipv4_octet, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.instance_id,
      row.enabled,
      row.networkName,
      row.networkSecret,
      row.octet,
      row.created_at,
      row.updated_at,
    );
    return requireLanRow(instanceId);
  }
  getDb().prepare('UPDATE instance_lans SET enabled = ?, updated_at = ? WHERE instance_id = ?')
    .run(input.enabled ? 1 : 0, now, instanceId);
  return requireLanRow(instanceId);
}

export function lanRenderInput(row: InstanceLanRow, gamePort: number): LanRenderInput {
  return {
    networkName: row.networkName,
    networkSecret: row.networkSecret,
    octet: row.octet,
    gamePort,
  };
}

export function writeLanFile(input: LanRenderInput, instanceId: string): void {
  const dir = lanWorkDir(instanceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dir, 'core.toml');
  fs.writeFileSync(configPath, renderLanToml(input), { mode: 0o600 });
  forceSecureSensitiveFile(configPath);
}

export function removeLanFiles(instanceId: string): void {
  if (!INSTANCE_ID.test(instanceId)) return;
  getDb().prepare('DELETE FROM instance_lans WHERE instance_id = ?').run(instanceId);
  fs.rmSync(path.join(config.dataDir, 'lan', instanceId), { recursive: true, force: true });
}

/** 实例虚拟局域网的工作目录（存放 core.toml），先校验实例 ID 再拼路径。 */
export function lanWorkDir(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) throw new PanelError('server.lan.invalidParams');
  return path.join(config.dataDir, 'lan', instanceId);
}

function requireLanRow(instanceId: string): InstanceLanRow {
  const row = readLanRow(instanceId);
  if (!row) throw new PanelError('server.lan.invalidParams');
  return row;
}

function readLanRow(instanceId: string): InstanceLanRow | null {
  const raw = getDb().prepare('SELECT * FROM instance_lans WHERE instance_id = ?').get(instanceId) as {
    instance_id: string;
    enabled: number;
    network_name: string;
    network_secret: string;
    ipv4_octet: number;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!raw) return null;
  return {
    instance_id: raw.instance_id,
    enabled: raw.enabled,
    networkName: raw.network_name,
    networkSecret: raw.network_secret,
    octet: raw.ipv4_octet,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function allocateOctet(instanceId: string): number {
  const used = new Set(
    (getDb().prepare('SELECT ipv4_octet FROM instance_lans').all() as Array<{ ipv4_octet: number }>)
      .map((row) => row.ipv4_octet),
  );
  let hash = 0;
  for (const char of instanceId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  for (let step = 0; step < 253; step += 1) {
    let octet = ((hash + step) % 253) + 1;
    if (octet >= 126) octet += 1;
    if (!used.has(octet)) return octet;
  }
  throw new PanelError('server.lan.invalidParams');
}
