/**
 * Authenticated download ticket protocol regression.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

process.env.JWT_SECRET = 'a'.repeat(64);
process.env.SETUP_TOKEN = 'b'.repeat(64);
process.env.LAUNCHER_TOKEN = 'c'.repeat(64);

test('a ticket is consumed once and replays are rejected (in-memory service)', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    beginDownloadStream,
    completeDownloadStream,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  let released = 0;
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
    released += 1;
  });
  assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log')?.userId, 'user-1');
  assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log'), null);
  completeDownloadStream(issued.ticket);
  assert.equal(released, 1);
  assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log'), null);
  assert.deepEqual(getDownloadTicketStatus(issued.ticket, 'user-1'), { status: 'consumed' });
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-2'), null);
});

test('POST issuing should pre-claim a concurrent download slot', async () => {
  const { resetDownloadTicketsForTests, reserveDownloadTicket } = await import('../services/download-ticket-service.js');
  const { config } = await import('../config.js');
  const {
    acquireFileDownloadSlot,
    FileDownloadCapacityError,
  } = await import('../services/file-service.js');
  resetDownloadTicketsForTests();
  const releases: Array<() => void> = [];
  for (let index = 0; index < config.maxConcurrentFileDownloads; index += 1) {
    releases.push(acquireFileDownloadSlot());
    reserveDownloadTicket('user-1', 'inst-1', `file-${index}.txt`, releases[index]!);
  }
  assert.throws(() => acquireFileDownloadSlot(), FileDownloadCapacityError);
  for (const release of releases) release();
});

test('a failure to open the stream on GET should be reported to the SPA through the ticket status query', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    failDownloadStream,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  let released = false;
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'missing.txt', () => {
    released = true;
  });
  failDownloadStream(issued.ticket, { key: 'server.files.fileNotFound' });
  assert.equal(released, true);
  const status = getDownloadTicketStatus(issued.ticket, 'user-1');
  assert.equal(status?.status, 'failed');
  assert.equal(status?.errorI18n?.key, 'server.files.fileNotFound');
  assert.equal(status?.error, 'File not found.');

  // Raw error text from Node.js streams is kept as is, without a message key.
  const raw = reserveDownloadTicket('user-1', 'inst-1', 'raw.txt', () => {});
  failDownloadStream(raw.ticket, 'EACCES: permission denied');
  assert.deepEqual(getDownloadTicketStatus(raw.ticket, 'user-1'), {
    status: 'failed',
    error: 'EACCES: permission denied',
  });
});

test('after a download completes the status query returns consumed rather than 404 (short-lived tombstone)', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    beginDownloadStream,
    completeDownloadStream,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {});
  assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log')?.userId, 'user-1');
  completeDownloadStream(issued.ticket);
  const status = getDownloadTicketStatus(issued.ticket, 'user-1');
  assert.equal(status?.status, 'consumed');
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-2'), null);
});

test('after the consumed tombstone expires the status query falls back to null', async () => {
  const { mock } = test;
  mock.timers.enable({ now: 1_000_000, apis: ['Date'] });
  try {
    const {
      resetDownloadTicketsForTests,
      reserveDownloadTicket,
      completeDownloadStream,
      getDownloadTicketStatus,
    } = await import('../services/download-ticket-service.js');
    resetDownloadTicketsForTests();
    const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {});
    completeDownloadStream(issued.ticket);
    assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'consumed');
    mock.timers.tick(61_000);
    assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1'), null);
  } finally {
    mock.timers.reset();
  }
});

test('a reserved ticket is released automatically on expiry and keeps the expired status', async () => {
  const { mock } = test;
  mock.timers.enable({ now: 1_000_000, apis: ['Date', 'setTimeout'] });
  try {
    const {
      resetDownloadTicketsForTests,
      reserveDownloadTicket,
      getDownloadTicketStatus,
    } = await import('../services/download-ticket-service.js');
    const { config } = await import('../config.js');
    resetDownloadTicketsForTests();
    let released = 0;
    const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
      released += 1;
    });

    mock.timers.tick(config.fileDownloadTicketTtlSeconds * 1000);

    assert.equal(released, 1);
    assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'expired');
  } finally {
    const { resetDownloadTicketsForTests } = await import('../services/download-ticket-service.js');
    resetDownloadTicketsForTests();
    mock.timers.reset();
  }
});

test('a streaming ticket is not reclaimed by the issue TTL and is released only once when it ends', async () => {
  const { mock } = test;
  mock.timers.enable({ now: 2_000_000, apis: ['Date', 'setTimeout'] });
  try {
    const {
      resetDownloadTicketsForTests,
      reserveDownloadTicket,
      beginDownloadStream,
      completeDownloadStream,
      getDownloadTicketStatus,
    } = await import('../services/download-ticket-service.js');
    const { config } = await import('../config.js');
    resetDownloadTicketsForTests();
    let released = 0;
    const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
      released += 1;
    });
    assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log')?.userId, 'user-1');

    mock.timers.tick(config.fileDownloadTicketTtlSeconds * 1000 + 1);

    assert.equal(released, 0);
    assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'streaming');
    completeDownloadStream(issued.ticket);
    completeDownloadStream(issued.ticket);
    assert.equal(released, 1);
    assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'consumed');
  } finally {
    const { resetDownloadTicketsForTests } = await import('../services/download-ticket-service.js');
    resetDownloadTicketsForTests();
    mock.timers.reset();
  }
});

test('a streaming failure can still be queried for its reason after the issue TTL', async () => {
  const { mock } = test;
  mock.timers.enable({ now: 3_000_000, apis: ['Date', 'setTimeout'] });
  try {
    const {
      resetDownloadTicketsForTests,
      reserveDownloadTicket,
      beginDownloadStream,
      failDownloadStream,
      getDownloadTicketStatus,
    } = await import('../services/download-ticket-service.js');
    const { config } = await import('../config.js');
    resetDownloadTicketsForTests();
    const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {});
    assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log')?.userId, 'user-1');

    mock.timers.tick(config.fileDownloadTicketTtlSeconds * 1000 + 1);
    failDownloadStream(issued.ticket, { key: 'server.files.download.idleTimeout' });

    const status = getDownloadTicketStatus(issued.ticket, 'user-1');
    assert.equal(status?.status, 'failed');
    assert.equal(status?.errorI18n?.key, 'server.files.download.idleTimeout');
  } finally {
    const { resetDownloadTicketsForTests } = await import('../services/download-ticket-service.js');
    resetDownloadTicketsForTests();
    mock.timers.reset();
  }
});

test('a close before the stream opens should end the wait and remove the listener', async () => {
  const { waitForDownloadStreamOpen } = await import('./files.js');
  const stream = new EventEmitter();
  const opening = waitForDownloadStreamOpen(stream);

  stream.emit('close');

  await assert.rejects(opening, (err: unknown) => (
    err instanceof Error && (err as { messageKey?: string }).messageKey === 'server.files.download.aborted'
  ));
  assert.equal(stream.listenerCount('open'), 0);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('close'), 0);
});

test('the owning user cancelling a reserved ticket should release the slot immediately and enter the cancelled final state', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    cancelReservedDownloadTicket,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  let released = 0;
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
    released += 1;
  });

  assert.equal(cancelReservedDownloadTicket(issued.ticket, 'user-1', 'inst-1'), 'cancelled');
  assert.equal(released, 1);
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'failed');
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.errorI18n?.key, 'server.files.download.cancelled');
});

test('cancelling a ticket across users or instances should be rejected without releasing it', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    cancelReservedDownloadTicket,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  let released = 0;
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
    released += 1;
  });

  assert.equal(cancelReservedDownloadTicket(issued.ticket, 'user-2', 'inst-1'), 'not_found');
  assert.equal(cancelReservedDownloadTicket(issued.ticket, 'user-1', 'inst-2'), 'not_found');
  assert.equal(released, 0);
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'reserved');
});

test('cancelling a streaming ticket should be a no-op, still released by the stream final state', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
    beginDownloadStream,
    cancelReservedDownloadTicket,
    completeDownloadStream,
    getDownloadTicketStatus,
  } = await import('../services/download-ticket-service.js');
  resetDownloadTicketsForTests();
  let released = 0;
  const issued = reserveDownloadTicket('user-1', 'inst-1', 'logs/latest.log', () => {
    released += 1;
  });
  assert.equal(beginDownloadStream(issued.ticket, 'inst-1', 'logs/latest.log')?.userId, 'user-1');

  assert.equal(cancelReservedDownloadTicket(issued.ticket, 'user-1', 'inst-1'), 'streaming');
  assert.equal(released, 0);
  assert.equal(getDownloadTicketStatus(issued.ticket, 'user-1')?.status, 'streaming');
  completeDownloadStream(issued.ticket);
  assert.equal(released, 1);
});

test('the cancel route mapping does not depend on the instance record, so a deleted instance can still release its reserved ticket', async () => {
  const {
    resetDownloadTicketsForTests,
    reserveDownloadTicket,
  } = await import('../services/download-ticket-service.js');
  const { cancelDownloadTicketRoute } = await import('./files.js');
  resetDownloadTicketsForTests();
  let released = 0;
  const issued = reserveDownloadTicket('user-1', 'deleted-inst', 'logs/latest.log', () => {
    released += 1;
  });

  const result = cancelDownloadTicketRoute(issued.ticket, 'user-1', 'deleted-inst');

  assert.deepEqual(result, { statusCode: 204 });
  assert.equal(released, 1);
});
