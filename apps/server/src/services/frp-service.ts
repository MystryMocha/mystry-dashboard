import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  FrpEndpoint,
  FrpEndpointInput,
  FrpTransport,
  InstanceTunnelInput,
  TunnelMode,
} from '@mystry/shared';
import { FRP_TRANSPORTS, TUNNEL_MODES } from '@mystry/shared';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { forceSecureSensitiveFile } from '../utils/data-dir-permissions.js';
import { PanelError } from '../utils/errors.js';
import { defaultInstanceDir, nowIso } from '../utils/path.js';
import { getInstanceRow } from './instance-service.js';
import {
  assertFrpHost,
  assertFrpName,
  assertFrpToken,
  type FrpcRenderInput,
} from './frp-config.js';

export interface FrpEndpointRow {
  id: string;
  name: string;
  server_addr: string;
  server_port: number;
  visit_host: string;
  transport: string;
  tls: number;
  token: string;
  created_at: string;
  updated_at: string;
}

export interface InstanceTunnelRow {
  instance_id: string;
  endpoint_id: string;
  enabled: number;
  mode: string;
  remote_port: number | null;
  visitor_bind_port: number;
  secret_key: string | null;
  created_at: string;
  updated_at: string;
}

function isTransport(value: string): value is FrpTransport {
  return (FRP_TRANSPORTS as readonly string[]).includes(value);
}

function isMode(value: string): value is TunnelMode {
  return (TUNNEL_MODES as readonly string[]).includes(value);
}

export function toFrpEndpoint(row: FrpEndpointRow): FrpEndpoint {
  if (!isTransport(row.transport)) throw new PanelError('server.frp.invalidParams');
  return {
    id: row.id,
    name: row.name,
    serverAddr: row.server_addr,
    serverPort: row.server_port,
    visitHost: row.visit_host,
    transport: row.transport,
    tls: row.tls !== 0,
    tokenSet: row.token.length > 0,
  };
}

export function listFrpEndpoints(): FrpEndpoint[] {
  const rows = getDb().prepare('SELECT * FROM frp_endpoints ORDER BY created_at ASC').all() as unknown as FrpEndpointRow[];
  return rows.map(toFrpEndpoint);
}

export function getFrpEndpointRow(id: string): FrpEndpointRow | null {
  return getDb().prepare('SELECT * FROM frp_endpoints WHERE id = ?').get(id) as unknown as FrpEndpointRow | undefined ?? null;
}

export function createFrpEndpoint(input: FrpEndpointInput): FrpEndpoint {
  const name = assertFrpName(input.name);
  const serverAddr = assertFrpHost(input.serverAddr);
  const visitHost = input.visitHost && input.visitHost.trim().length > 0 ? assertFrpHost(input.visitHost) : '';
  if (!input.token) throw new PanelError('server.frp.tokenRequired');
  const token = assertFrpToken(input.token);
  if (!isTransport(input.transport)) throw new PanelError('server.frp.invalidParams');
  const now = nowIso();
  const row: FrpEndpointRow = {
    id: nanoid(12),
    name,
    server_addr: serverAddr,
    server_port: input.serverPort,
    visit_host: visitHost,
    transport: input.transport,
    tls: input.tls === false ? 0 : 1,
    token,
    created_at: now,
    updated_at: now,
  };
  getDb().prepare(`
    INSERT INTO frp_endpoints (
      id, name, server_addr, server_port, visit_host, transport, tls, token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.name,
    row.server_addr,
    row.server_port,
    row.visit_host,
    row.transport,
    row.tls,
    row.token,
    row.created_at,
    row.updated_at,
  );
  return toFrpEndpoint(row);
}

export function updateFrpEndpoint(id: string, input: Partial<FrpEndpointInput>): FrpEndpoint {
  const current = getFrpEndpointRow(id);
  if (!current) throw new PanelError('server.frp.endpointNotFound', undefined, { statusCode: 404 });
  const name = input.name === undefined ? current.name : assertFrpName(input.name);
  const serverAddr = input.serverAddr === undefined ? current.server_addr : assertFrpHost(input.serverAddr);
  const visitHost = input.visitHost === undefined
    ? current.visit_host
    : input.visitHost.trim().length > 0 ? assertFrpHost(input.visitHost) : '';
  const transport = input.transport ?? current.transport;
  if (!isTransport(transport)) throw new PanelError('server.frp.invalidParams');
  let token = current.token;
  if (input.token !== undefined && input.token.length > 0) token = assertFrpToken(input.token);
  const tls = input.tls === undefined ? current.tls : input.tls ? 1 : 0;
  const serverPort = input.serverPort ?? current.server_port;
  const updatedAt = nowIso();
  getDb().prepare(`
    UPDATE frp_endpoints
    SET name = ?, server_addr = ?, server_port = ?, visit_host = ?, transport = ?, tls = ?, token = ?, updated_at = ?
    WHERE id = ?
  `).run(name, serverAddr, serverPort, visitHost, transport, tls, token, updatedAt, id);
  return toFrpEndpoint(getFrpEndpointRow(id)!);
}

export function deleteFrpEndpoint(id: string): void {
  const current = getFrpEndpointRow(id);
  if (!current) throw new PanelError('server.frp.endpointNotFound', undefined, { statusCode: 404 });
  const db = getDb();
  let staleInstanceIds: string[] = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    // 只有仍在启用的隧道才算占用；已关闭的隧道行在前端没有删除入口，留着会让端点永远删不掉。
    const used = db.prepare(
      'SELECT COUNT(*) AS c FROM instance_tunnels WHERE endpoint_id = ? AND enabled = 1',
    ).get(id) as { c: number };
    if (Number(used.c) > 0) throw new PanelError('server.frp.endpointInUse', undefined, { statusCode: 409 });
    const stale = db.prepare(
      'SELECT instance_id FROM instance_tunnels WHERE endpoint_id = ? AND enabled = 0',
    ).all(id) as unknown as { instance_id: string }[];
    staleInstanceIds = stale.map((row) => row.instance_id);
    db.prepare('DELETE FROM instance_tunnels WHERE endpoint_id = ? AND enabled = 0').run(id);
    db.prepare('DELETE FROM frp_endpoints WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // 文件系统不在事务内，提交成功后再清理这些已关闭隧道留下的配置和令牌文件。
  for (const instanceId of staleInstanceIds) removeTunnelDir(instanceId);
}

export function getInstanceTunnelRow(instanceId: string): InstanceTunnelRow | null {
  return getDb().prepare('SELECT * FROM instance_tunnels WHERE instance_id = ?').get(instanceId) as
    | InstanceTunnelRow
    | undefined ?? null;
}
export function listEnabledTunnelInstanceIds(): string[] {
  const rows = getDb().prepare(
    'SELECT instance_id FROM instance_tunnels WHERE enabled = 1',
  ).all() as unknown as { instance_id: string }[];
  return rows.map((row) => row.instance_id);
}


export function saveInstanceTunnel(instanceId: string, input: InstanceTunnelInput): InstanceTunnelRow {
  defaultInstanceDir(instanceId);
  if (!getInstanceRow(instanceId)) {
    throw new PanelError('server.frp.instanceNotFound', undefined, { statusCode: 404 });
  }
  const endpoint = getFrpEndpointRow(input.endpointId);
  if (!endpoint) throw new PanelError('server.frp.endpointNotFound', undefined, { statusCode: 404 });
  if (!isMode(input.mode)) throw new PanelError('server.frp.invalidParams');
  const visitorBindPort = input.visitorBindPort ?? 25565;
  if (input.mode === 'public' && input.remotePort === undefined) {
    throw new PanelError('server.frp.remotePortRequired');
  }
  if (input.enabled && input.mode === 'public' && input.remotePort !== undefined) {
    const clash = getDb().prepare(`
      SELECT instance_id FROM instance_tunnels
      WHERE endpoint_id = ? AND mode = 'public' AND enabled = 1 AND remote_port = ? AND instance_id != ?
    `).get(input.endpointId, input.remotePort, instanceId) as { instance_id: string } | undefined;
    if (clash) throw new PanelError('server.frp.remotePortInUse', undefined, { statusCode: 409 });
  }
  const existing = getInstanceTunnelRow(instanceId);
  const secret = input.mode === 'public'
    ? existing?.secret_key ?? null
    : existing?.secret_key ?? randomBytes(32).toString('hex');
  const now = nowIso();
  const remotePort = input.mode === 'public' ? input.remotePort ?? null : null;
  getDb().prepare(`
    INSERT INTO instance_tunnels (
      instance_id, endpoint_id, enabled, mode, remote_port, visitor_bind_port, secret_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      endpoint_id = excluded.endpoint_id,
      enabled = excluded.enabled,
      mode = excluded.mode,
      remote_port = excluded.remote_port,
      visitor_bind_port = excluded.visitor_bind_port,
      secret_key = excluded.secret_key,
      updated_at = excluded.updated_at
  `).run(
    instanceId,
    input.endpointId,
    input.enabled ? 1 : 0,
    input.mode,
    remotePort,
    visitorBindPort,
    secret,
    existing?.created_at ?? now,
    now,
  );
  return getInstanceTunnelRow(instanceId)!;
}

export function tunnelWorkDir(instanceId: string): string {
  defaultInstanceDir(instanceId);
  return path.join(config.dataDir, 'frp', instanceId);
}

export function renderInputForTunnel(instanceId: string, localPort: number): FrpcRenderInput | null {
  const tunnel = getInstanceTunnelRow(instanceId);
  if (!tunnel) return null;
  const endpoint = getFrpEndpointRow(tunnel.endpoint_id);
  if (!endpoint || !isTransport(endpoint.transport) || !isMode(tunnel.mode)) return null;
  return {
    instanceId,
    mode: tunnel.mode,
    localPort,
    remotePort: tunnel.remote_port,
    visitorBindPort: tunnel.visitor_bind_port,
    serverAddr: endpoint.server_addr,
    serverPort: endpoint.server_port,
    visitHost: endpoint.visit_host.length > 0 ? endpoint.visit_host : endpoint.server_addr,
    transport: endpoint.transport,
    tls: endpoint.tls !== 0,
    token: endpoint.token,
    secretKey: tunnel.secret_key,
    tokenPath: path.join(tunnelWorkDir(instanceId), 'token'),
  };
}

/** 把令牌和 frpc 配置写到数据目录。配置正文不含令牌。 */
export function writeTunnelFiles(input: FrpcRenderInput, toml: string): void {
  const dir = tunnelWorkDir(input.instanceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dir, 'token');
  const configPath = path.join(dir, 'frpc.toml');
  fs.writeFileSync(tokenPath, input.token, { mode: 0o600 });
  fs.writeFileSync(configPath, toml, { mode: 0o600 });
  forceSecureSensitiveFile(tokenPath);
  forceSecureSensitiveFile(configPath);
}

/** 只删 DATA_DIR/frp/<instanceId> 目录，不动数据库。实例 ID 不合法时直接跳过。 */
function removeTunnelDir(instanceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId)) return;
  fs.rmSync(path.join(config.dataDir, 'frp', instanceId), { recursive: true, force: true });
}

export function removeTunnelFiles(instanceId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(instanceId)) return;
  getDb().prepare('DELETE FROM instance_tunnels WHERE instance_id = ?').run(instanceId);
  removeTunnelDir(instanceId);
}
