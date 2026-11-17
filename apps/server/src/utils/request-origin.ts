import type net from 'node:net';
import type { FastifyRequest } from 'fastify';

/**
 * 请求来自哪里。面板自带 EasyTier 网络用无 TUN 模式，组网设备的连接在面板看来来源也是 127.0.0.1，
 * 只看 req.ip 会把它们当成本机。所以自带网络有一个只给它用的回环端口（panel-network.ts），
 * 从那个端口接进来的连接在这里登记；判断「本机」时要把它们排除，限流时把它们单独算一个来源。
 */

const panelNetworkSockets = new WeakSet<net.Socket>();

/** panel-network.ts 在交给 HTTP 服务前登记从组网专用端口接进来的连接。 */
export function markPanelNetworkSocket(socket: net.Socket): void {
  panelNetworkSockets.add(socket);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

/** 连接是不是经面板自带网络进来的。 */
export function viaPanelNetwork(req: FastifyRequest): boolean {
  return panelNetworkSockets.has(req.raw.socket);
}

/** 真正来自本机：回环来源，且不是经面板自带网络转进来的。启动器接口和进程指纹只认这个。 */
export function isLocalRequest(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.ip) && !viaPanelNetwork(req);
}

/** 限流和登录失败计数用的来源：组网设备拿不到真实地址，统一算一个来源，和本机分开。 */
export function clientKey(req: FastifyRequest): string {
  return viaPanelNetwork(req) ? 'panel-network' : req.ip;
}
