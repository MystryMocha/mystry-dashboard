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
import {
  type LanIdentity,
  normalizeLanPeer,
  normalizeLanPeers,
  renderLanToml,
  resolveLanPeers,
  type LanRenderInput,
} from './lan-config.js';

export interface InstanceLanRow extends LanIdentity {
  instance_id: string;
  enabled: number;
  /** Peers entered by the user (normalized) */
  peers: string[];
  useSharedPeers: boolean;
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

/** The network name, secret and subnet are generated only on the first save. Disabling and enabling again later reuses them, so friends do not have to set up again. */
export function saveInstanceLan(instanceId: string, input: InstanceLanInput): InstanceLanRow {
  if (!getInstanceRow(instanceId)) {
    throw new PanelError('server.lan.instanceNotFound', undefined, { statusCode: 404 });
  }
  if (typeof input.enabled !== 'boolean') throw new PanelError('server.lan.invalidParams');
  if (input.useSharedPeers !== undefined && typeof input.useSharedPeers !== 'boolean') {
    throw new PanelError('server.lan.invalidParams');
  }
  if (input.peers !== undefined && !Array.isArray(input.peers)) throw new PanelError('server.lan.invalidParams');
  const existing = getInstanceLanRow(instanceId);
  const peers = input.peers !== undefined ? normalizeLanPeers(input.peers) : (existing?.peers ?? []);
  const useSharedPeers = input.useSharedPeers ?? existing?.useSharedPeers ?? true;
  // Confirm there is at least one peer before writing to the database, so a setting that can never connect is not saved.
  resolveLanPeers(peers, useSharedPeers);
  const now = nowIso();
  if (!existing) {
    const row: InstanceLanRow = {
      instance_id: instanceId,
      enabled: input.enabled ? 1 : 0,
      networkName: `mystry-${randomBytes(16).toString('hex')}`,
      networkSecret: randomBytes(32).toString('hex'),
      octet: allocateOctet(instanceId),
      peers,
      useSharedPeers,
      created_at: now,
      updated_at: now,
    };
    getDb().prepare(`
      INSERT INTO instance_lans (
        instance_id, enabled, network_name, network_secret, ipv4_octet,
        custom_peers, use_shared_peers, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.instance_id,
      row.enabled,
      row.networkName,
      row.networkSecret,
      row.octet,
      JSON.stringify(row.peers),
      row.useSharedPeers ? 1 : 0,
      row.created_at,
      row.updated_at,
    );
    return requireLanRow(instanceId);
  }
  getDb().prepare(`
    UPDATE instance_lans
    SET enabled = ?, custom_peers = ?, use_shared_peers = ?, updated_at = ?
    WHERE instance_id = ?
  `).run(input.enabled ? 1 : 0, JSON.stringify(peers), useSharedPeers ? 1 : 0, now, instanceId);
  return requireLanRow(instanceId);
}

/** With listenPort null the result is the config key used for comparison: the listen port is reallocated on every start and should not trigger a restart. */
export function lanRenderInput(row: InstanceLanRow, gamePort: number, listenPort: number | null): LanRenderInput {
  return {
    networkName: row.networkName,
    networkSecret: row.networkSecret,
    octet: row.octet,
    gamePort,
    peers: resolveLanPeers(row.peers, row.useSharedPeers),
    listenPort,
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

/** Work directory of an instance's virtual LAN (holds core.toml); the instance ID is validated before the path is built. */
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
    custom_peers: string | null;
    use_shared_peers: number | null;
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
    peers: parseStoredPeers(raw.custom_peers),
    useSharedPeers: raw.use_shared_peers !== 0,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/** When the peer list in the database is corrupted, only unrecognized entries are dropped, so the whole virtual LAN does not become unreadable. */
function parseStoredPeers(text: string | null): string[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const peers: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    try {
      const peer = normalizeLanPeer(item);
      if (!peers.includes(peer)) peers.push(peer);
    } catch {
      // Skip unrecognized entries
    }
  }
  return peers;
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
