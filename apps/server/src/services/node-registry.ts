import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { NodeHostInfo, NodeStatus } from '@mystry/shared';
import { LOCAL_NODE_ID } from '@mystry/shared';

/**
 * Registry of node runtime state (in memory, reset when the panel restarts).
 *
 * The design matches ProcessManager: the database stores only a node's static metadata (name, secret hash),
 * while online status / heartbeat / host info are runtime information and are not written to the database.
 *
 * Currently there is only the local node, which represents the panel itself and is always online.
 */
class NodeRegistry extends EventEmitter {
  private online = new Map<string, { lastSeenAt: string; hostInfo: NodeHostInfo | null }>();

  constructor() {
    super();
    // The local node is the panel itself and is always online
    this.markOnline(LOCAL_NODE_ID, {
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    });
  }

  getStatus(nodeId: string): NodeStatus {
    if (nodeId === LOCAL_NODE_ID) return 'online';
    return this.online.has(nodeId) ? 'online' : 'offline';
  }

  getLastSeenAt(nodeId: string): string | null {
    return this.online.get(nodeId)?.lastSeenAt ?? null;
  }

  getHostInfo(nodeId: string): NodeHostInfo | null {
    return this.online.get(nodeId)?.hostInfo ?? null;
  }

  markOnline(nodeId: string, hostInfo: NodeHostInfo | null = null): void {
    this.online.set(nodeId, { lastSeenAt: new Date().toISOString(), hostInfo });
    this.emit('status', nodeId, 'online' satisfies NodeStatus);
  }

  markOffline(nodeId: string): void {
    if (nodeId === LOCAL_NODE_ID) return; // The local node cannot go offline
    this.online.delete(nodeId);
    this.emit('status', nodeId, 'offline' satisfies NodeStatus);
  }
}

export const nodeRegistry = new NodeRegistry();
