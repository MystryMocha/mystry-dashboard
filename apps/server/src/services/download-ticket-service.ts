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

/** 票据失败原因：可翻译消息，或 Node.js 流的原始错误文本。 */
export type DownloadTicketFailure = PanelMessage | string;

/**
 * 已结束票据的短时 tombstone，让前端轮询在票据离开内存池后仍能拿到最终状态：
 * 过期返回 expired、下载完成返回 consumed、失败或取消返回 failed 和原因，而不是误判 404。
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

/** 释放槽位、移出内存池，并留下 tombstone。 */
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

/** POST 签发：预占下载槽并进入 reserved 状态。 */
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

/** GET 开流前：reserved → streaming。 */
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

/** 仅允许签发该票据的用户在原生 GET 开流前取消预占槽位。 */
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

/** 测试专用：清空内存票据。 */
export function resetDownloadTicketsForTests(): void {
  for (const value of tickets.values()) {
    clearReservedExpiry(value);
    releaseTicketSlot(value);
  }
  tickets.clear();
  endedTickets.clear();
}
