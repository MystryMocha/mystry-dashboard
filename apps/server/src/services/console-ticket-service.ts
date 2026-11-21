import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { PanelError } from '../utils/errors.js';

type ConsoleTicket = {
  userId: string;
  instanceId: string;
  expiresAt: number;
};

const tickets = new Map<string, ConsoleTicket>();

/** Limit on the number of unexpired tickets, so an abnormal client cannot exhaust memory by issuing them repeatedly. */
const MAX_CONSOLE_TICKETS = 1000;

function pruneExpired(now = Date.now()): void {
  for (const [ticket, value] of tickets) {
    if (value.expiresAt <= now) tickets.delete(ticket);
  }
}

export function issueConsoleTicket(userId: string, instanceId: string): {
  ticket: string;
  expiresIn: number;
} {
  const now = Date.now();
  pruneExpired(now);
  if (tickets.size >= MAX_CONSOLE_TICKETS) {
    throw new PanelError('server.instance.consoleTicketLimit');
  }
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    userId,
    instanceId,
    expiresAt: now + config.consoleTicketTtlSeconds * 1000,
  });
  return { ticket, expiresIn: config.consoleTicketTtlSeconds };
}

/** After a password change or reset, voids all of that user's console tickets that have not been used yet. */
export function revokeConsoleTickets(userId: string): void {
  for (const [ticket, value] of tickets) {
    if (value.userId === userId) tickets.delete(ticket);
  }
}

/** Validates and immediately consumes the ticket; whether or not the instance matches, a ticket that was found can never be used again. */
export function consumeConsoleTicket(
  ticket: string,
  instanceId: string,
): { userId: string } | null {
  const now = Date.now();
  const value = tickets.get(ticket);
  if (!value) return null;
  tickets.delete(ticket);
  if (value.expiresAt <= now || value.instanceId !== instanceId) return null;
  return { userId: value.userId };
}
