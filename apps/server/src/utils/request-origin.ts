import type net from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * Where a request comes from. The panel's built-in EasyTier network runs in no-TUN mode, so connections from virtual-network devices also appear to the panel as coming from 127.0.0.1,
 * and looking at req.ip alone would treat them as this machine. So the built-in network has a loopback port used only by it (panel-network.ts),
 * and connections accepted on that port are registered here; they must be excluded when deciding "local", and counted as one separate origin for rate limiting.
 */

const panelNetworkSockets = new WeakSet<net.Socket>();

/** panel-network.ts registers connections accepted on the dedicated virtual-network port before handing them to the HTTP server. */
export function markPanelNetworkSocket(socket: net.Socket): void {
  panelNetworkSockets.add(socket);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

/** Whether the connection came in through the panel's built-in network. */
export function viaPanelNetwork(req: FastifyRequest): boolean {
  return panelNetworkSockets.has(req.raw.socket);
}

/** Truly from this machine: a loopback origin that was not forwarded in through the panel's built-in network. The launcher endpoints and the process fingerprint accept only this. */
export function isLocalRequest(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip) && !viaPanelNetwork(req);
}

/** Origin used for rate limiting and failed sign-in counting: virtual-network devices have no real address available, so they count as one origin, separate from this machine. */
export function clientKey(req: FastifyRequest): string {
  return viaPanelNetwork(req) ? 'panel-network' : req.ip;
}
