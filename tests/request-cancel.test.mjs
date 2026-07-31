import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelRequestRecord,
  createRequestRecord,
  createRenderFrameGate,
  isTransientFetchError,
  rejectCancelledRequest,
  retryTransientOnce,
  settlePageRequest,
  startPageRequest,
} from '../src/lib/request-handlers.js';

test('cancelling an active request rejects and removes its handler', async () => {
  const handlers = new Map();
  let rejectPending;
  const pending = new Promise((resolve, reject) => { rejectPending = reject; });
  handlers.set(7, { resolve: () => {}, reject: rejectPending });

  assert.equal(rejectCancelledRequest(handlers, 7), true);
  assert.equal(handlers.has(7), false);
  await assert.rejects(pending, (error) => error.cancelled === true && error.message === '已取消');
});

test('cancelling an unknown request is a no-op', () => {
  assert.equal(rejectCancelledRequest(new Map(), 404), false);
});

test('a retry retires the previous generation and stale completion cannot settle the new one', () => {
  const page = { renderGeneration: 3, translationActive: true, trId: 41 };

  assert.deepEqual(startPageRequest(page), {
    generation: 4,
    previousRequestId: 41,
    replacedActive: true,
  });
  assert.equal(page.translationActive, true);
  assert.equal(page.trId, null);

  page.trId = 42;
  assert.equal(settlePageRequest(page, 3), false);
  assert.equal(page.translationActive, true);
  assert.equal(page.trId, 42);
  assert.equal(settlePageRequest(page, 4), true);
  assert.equal(page.translationActive, false);
  assert.equal(page.trId, null);
});

test('final rendering can cancel a queued streaming frame', () => {
  let queuedCallback;
  const cancelled = [];
  let renders = 0;
  const gate = createRenderFrameGate(
    (callback) => { queuedCallback = callback; return 91; },
    (id) => { cancelled.push(id); },
    () => { renders++; },
  );

  assert.equal(gate.schedule(), true);
  assert.equal(gate.schedule(), false);
  assert.equal(gate.pending, true);
  assert.equal(gate.cancel(), true);
  assert.deepEqual(cancelled, [91]);
  assert.equal(gate.pending, false);
  assert.equal(renders, 0);

  assert.equal(gate.schedule(), true);
  queuedCallback();
  assert.equal(renders, 1);
  assert.equal(gate.pending, false);
});

test('queued and active background request records are cancellable', () => {
  const queued = createRequestRecord();
  assert.equal(cancelRequestRecord(queued), true);
  assert.equal(queued.cancelled, true);

  let aborts = 0;
  const active = createRequestRecord();
  active.controller = { abort: () => { aborts++; } };
  assert.equal(cancelRequestRecord(active), true);
  assert.equal(active.cancelled, true);
  assert.equal(aborts, 1);
  assert.equal(cancelRequestRecord(null), false);
});

test('transient fetch failures retry exactly once after a short backoff', async () => {
  let calls = 0;
  const result = await retryTransientOnce(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return 'recovered';
  }, { delayMs: 0 });

  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
  assert.equal(isTransientFetchError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransientFetchError(new Error('Failed to fetch')), false);
  assert.equal(isTransientFetchError(new DOMException('Aborted', 'AbortError')), false);
});

test('a progress guard prevents replay after output has started', async () => {
  let calls = 0;
  let outputStarted = false;
  const failure = new TypeError('Failed to fetch');

  await assert.rejects(retryTransientOnce(async () => {
    calls += 1;
    outputStarted = true;
    throw failure;
  }, {
    delayMs: 0,
    shouldRetry: () => !outputStarted,
  }), (error) => error === failure);

  assert.equal(calls, 1);
});

test('cancellation during retry backoff prevents the second attempt', async () => {
  const controller = new AbortController();
  let calls = 0;

  await assert.rejects(retryTransientOnce(async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  }, {
    signal: controller.signal,
    delayMs: 100,
    onRetry: () => controller.abort(),
  }), { name: 'AbortError' });

  assert.equal(calls, 1);
});
