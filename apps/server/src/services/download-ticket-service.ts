import { randomBytes } from 'node:crypto';
import {
  renderPanelMessage,
  type FileDownloadTicketResult,
  type FileDownloadTicketStatus,
  type FileDownloadTicketStatusResult,
  type PanelMessage,
} from '@mystry/shared';
import { config } from '../config.js';

type DownloadTicketRecord = {
  userId: string;
  instanceId: string;
  path: string;
  expiresAt: number;
  status: FileDownloadTicketStatus;
  releaseSlot: () => void;
  expiresTimer: NodeJS.Timeout | null;
};

const tickets = new Map<string, DownloadTicketRecord>();

type EndedTicket = {
  userId: string;
  status: 'expired' | 'consumed' | 'failed';
  error?: string;
  errorI18n?: PanelMessage;
  expiresAt: number;
};

/** Ticket failure reason: a translatable message, or the raw error text of a Node.js stream. */
export type DownloadTicketFailure = PanelMessage | string;

/**
 * Short-lived tombstones for finished tickets, so frontend polling still gets the final state after the ticket leaves the in-memory pool:
 * expired for expiry, consumed for a completed download, failed with the reason for failure or cancel, instead of being mistaken for 404.
 */
const endedTickets = new Map<string, EndedTicket>();
const ENDED_TOMBSTONE_MS = 60_000;

export type CancelReservedDownloadTicketResult = 'cancelled' | 'streaming' | 'not_found';

function noopRelease(): void {}

function releaseTicketSlot(record: DownloadTicketRecord): void {
  record.releaseSlot();
  record.releaseSlot = noopRelease;
}

function clearReservedExpiry(record: DownloadTicketRecord): void {
  if (!record.expiresTimer) return;
  clearTimeout(record.expiresTimer);
  record.expiresTimer = null;
}

function failureFields(failure?: DownloadTicketFailure): Pick<EndedTicket, 'error' | 'errorI18n'> {
  if (!failure) return {};
  if (typeof failure === 'string') return { error: failure };
  return { error: renderPanelMessage(failure), errorI18n: failure };
}

/** Releases the slot, removes it from the in-memory pool, and leaves a tombstone. */
function endTicket(
  ticket: string,
  record: DownloadTicketRecord,
  status: EndedTicket['status'],
  failure?: DownloadTicketFailure,
  now = Date.now(),
): void {
  clearReservedExpiry(record);
  releaseTicketSlot(record);
  tickets.delete(ticket);
  endedTickets.set(ticket, {
    userId: record.userId,
    status,
    ...failureFields(failure),
    expiresAt: now + ENDED_TOMBSTONE_MS,
  });
}

function expireReservedTicket(ticket: string, record: DownloadTicketRecord, now = Date.now()): void {
  if (tickets.get(ticket) !== record || record.status !== 'reserved' || record.expiresAt > now) return;
  endTicket(ticket, record, 'expired', { key: 'server.files.download.ticketExpired' }, now);
}

function scheduleReservedExpiry(ticket: string, record: DownloadTicketRecord): void {
  clearReservedExpiry(record);
  const delay = Math.max(0, record.expiresAt - Date.now());
  record.expiresTimer = setTimeout(() => {
    record.expiresTimer = null;
    expireReservedTicket(ticket, record);
  }, delay);
  record.expiresTimer.unref?.();
}

function pruneExpired(now = Date.now()): void {
  for (const [ticket, value] of tickets) {
    if (value.status === 'reserved' && value.expiresAt <= now) {
      expireReservedTicket(ticket, value, now);
    }
  }
  for (const [ticket, value] of endedTickets) {
    if (value.expiresAt <= now) endedTickets.delete(ticket);
  }
}

/** Issued by POST: pre-claims a download slot and enters the reserved state. */
export function reserveDownloadTicket(
  userId: string,
  instanceId: string,
  relativePath: string,
  releaseSlot: () => void,
): FileDownloadTicketResult {
  const now = Date.now();
  pruneExpired(now);
  const ticket = randomBytes(32).toString('base64url');
  const record: DownloadTicketRecord = {
    userId,
    instanceId,
    path: relativePath,
    expiresAt: now + config.fileDownloadTicketTtlSeconds * 1000,
    status: 'reserved',
    releaseSlot,
    expiresTimer: null,
  };
  tickets.set(ticket, record);
  scheduleReservedExpiry(ticket, record);
  return { ticket, expiresIn: config.fileDownloadTicketTtlSeconds };
}

export function getDownloadTicketStatus(
  ticket: string,
  userId: string,
): FileDownloadTicketStatusResult | null {
  const now = Date.now();
  pruneExpired(now);
  const value = tickets.get(ticket);
  if (value) return value.userId === userId ? { status: value.status } : null;
  const ended = endedTickets.get(ticket);
  if (!ended || ended.userId !== userId) return null;
  return {
    status: ended.status,
    ...(ended.error ? { error: ended.error } : {}),
    ...(ended.errorI18n ? { errorI18n: ended.errorI18n } : {}),
  };
}

/** Before GET opens the stream: reserved → streaming. */
export function beginDownloadStream(
  ticket: string,
  instanceId: string,
  relativePath: string,
): { userId: string } | null {
  const now = Date.now();
  pruneExpired(now);
  const value = tickets.get(ticket);
  if (!value) return null;
  if (value.instanceId !== instanceId || value.path !== relativePath) {
    return null;
  }
  if (value.status !== 'reserved') return null;
  clearReservedExpiry(value);
  value.status = 'streaming';
  return { userId: value.userId };
}

/** Only the user the ticket was issued to may cancel the pre-claimed slot, before the native GET opens the stream. */
export function cancelReservedDownloadTicket(
  ticket: string,
  userId: string,
  instanceId: string,
): CancelReservedDownloadTicketResult {
  pruneExpired();
  const value = tickets.get(ticket);
  if (!value || value.userId !== userId || value.instanceId !== instanceId) return 'not_found';
  if (value.status === 'streaming') return 'streaming';
  if (value.status !== 'reserved') return 'not_found';

  endTicket(ticket, value, 'failed', { key: 'server.files.download.cancelled' });
  return 'cancelled';
}

/** After a password change or reset, voids that user's download tickets that have not opened a stream yet; downloads already transferring are not interrupted. */
export function revokeReservedDownloadTickets(userId: string): void {
  for (const [ticket, value] of tickets) {
    if (value.userId !== userId || value.status !== 'reserved') continue;
    endTicket(ticket, value, 'failed', { key: 'server.files.download.cancelled' });
  }
}

export function completeDownloadStream(ticket: string): void {
  const value = tickets.get(ticket);
  if (!value) return;
  endTicket(ticket, value, 'consumed');
}

export function failDownloadStream(ticket: string, failure: DownloadTicketFailure): void {
  const value = tickets.get(ticket);
  if (!value) return;
  endTicket(ticket, value, 'failed', failure);
}

/** Tests only: clears the in-memory tickets. */
export function resetDownloadTicketsForTests(): void {
  for (const value of tickets.values()) {
    clearReservedExpiry(value);
    releaseTicketSlot(value);
  }
  tickets.clear();
  endedTickets.clear();
}
