import { revokeConsoleTickets } from './console-ticket-service.js';
import { revokeReservedDownloadTickets } from './download-ticket-service.js';

type RevocationListener = (userId: string) => void;

/** 已建立的长连接（目前只有控制台 WebSocket）在这里登记，会话撤销时由各自的路由关闭。 */
const listeners = new Set<RevocationListener>();

export function onUserSessionsRevoked(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 修改或重置密码后调用：JWT 由令牌版本失效，这里再清掉由旧登录签发、只凭票据就能用的凭据——
 * 未消费的控制台 ticket、尚未开流的下载 ticket，以及已经打开的控制台连接。
 * 已经开始传输的下载不打断：它在开流时已通过授权，内容此时已在发送中。
 */
export function revokeUserSessions(userId: string): void {
  revokeConsoleTickets(userId);
  revokeReservedDownloadTickets(userId);
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      // 单个连接关闭失败不能阻止其余撤销。
    }
  }
}
