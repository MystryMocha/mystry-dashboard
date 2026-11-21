import { revokeConsoleTickets } from './console-ticket-service.js';
import { revokeReservedDownloadTickets } from './download-ticket-service.js';

type RevocationListener = (userId: string) => void;

/** Established long-lived connections (currently only the console WebSocket) are registered here, and closed by their own routes when the session is revoked. */
const listeners = new Set<RevocationListener>();

export function onUserSessionsRevoked(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called after a password change or reset: JWTs are invalidated by the token version, and this additionally clears credentials issued by the old sign-in that work on a ticket alone:
 * unconsumed console tickets, download tickets that have not opened a stream yet, and console connections already open.
 * Downloads already transferring are not interrupted: they passed authorization when the stream opened, and the content is already being sent.
 */
export function revokeUserSessions(userId: string): void {
  revokeConsoleTickets(userId);
  revokeReservedDownloadTickets(userId);
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      // A failure to close one connection must not stop the rest of the revocation.
    }
  }
}
