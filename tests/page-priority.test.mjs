import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPagePriorityOrder,
  createPageScheduler,
} from '../src/lib/page-priority.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('buildPagePriorityOrder puts current, neighbors, and next two pages first', () => {
  assert.deepEqual(buildPagePriorityOrder(4, 10), [4, 3, 5, 6, 7]);
});

test('buildPagePriorityOrder removes duplicates and out-of-range boundary pages', () => {
  assert.deepEqual(buildPagePriorityOrder(0, 3), [0, 1, 2]);
  assert.deepEqual(buildPagePriorityOrder(2, 3), [2, 1]);
  assert.deepEqual(buildPagePriorityOrder(0, 1), [0]);
  assert.deepEqual(buildPagePriorityOrder(0, 0), []);
});

test('scheduler runs at most two page tasks concurrently', async () => {
  const scheduler = createPageScheduler();
  const gates = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;

  const jobs = gates.map((gate, pageIndex) => scheduler.schedule(pageIndex, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gate.promise;
    running -= 1;
  }));

  await flushMicrotasks();
  assert.equal(peak, 2);
  assert.equal(running, 2);

  gates[0].resolve();
  await jobs[0];
  await flushMicrotasks();
  assert.equal(running, 2);

  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(jobs);
});

test('visible work reprioritizes a deduplicated queued prefetch and overtakes it', async () => {
  const scheduler = createPageScheduler();
  const runningOne = deferred();
  const runningTwo = deferred();
  const started = [];

  const first = scheduler.schedule(0, async () => {
    started.push('running-0');
    await runningOne.promise;
  }, { priority: 0 });
  const second = scheduler.schedule(1, async () => {
    started.push('running-1');
    await runningTwo.promise;
  }, { priority: 0 });
  const prefetch = scheduler.schedule(2, async () => {
    started.push('prefetch-2');
  }, { priority: 20 });
  const queuedVisiblePage = scheduler.schedule(3, async () => {
    started.push('visible-3');
    return 'page-3';
  }, { priority: 30 });
  const duplicate = scheduler.schedule(3, async () => {
    started.push('duplicate-must-not-run');
  }, { priority: 0 });

  assert.equal(duplicate, queuedVisiblePage);
  await flushMicrotasks();
  assert.deepEqual(started, ['running-0', 'running-1']);

  runningOne.resolve();
  await first;
  assert.equal(await queuedVisiblePage, 'page-3');
  assert.deepEqual(started.slice(0, 3), ['running-0', 'running-1', 'visible-3']);

  runningTwo.resolve();
  await Promise.all([second, prefetch]);
  assert.deepEqual(started, ['running-0', 'running-1', 'visible-3', 'prefetch-2']);
});

test('scheduler passes generation and cancellation signal to tasks', async () => {
  const scheduler = createPageScheduler();
  let received;

  const result = await scheduler.schedule(5, async (context) => {
    received = context;
    return 'done';
  }, { generation: 12 });

  assert.equal(result, 'done');
  assert.equal(received.pageIndex, 5);
  assert.equal(received.generation, 12);
  assert.equal(received.signal.aborted, false);
});

test('a settled page can be scheduled again immediately', async () => {
  const scheduler = createPageScheduler();
  let runs = 0;

  assert.equal(await scheduler.schedule(4, async () => ++runs), 1);
  assert.equal(await scheduler.schedule(4, async () => ++runs), 2);
  assert.equal(runs, 2);
});

test('cancelGeneration removes queued work without disturbing another generation', async () => {
  const scheduler = createPageScheduler();
  const firstGate = deferred();
  const secondGate = deferred();
  let cancelledStarted = false;

  const first = scheduler.schedule(0, async () => firstGate.promise, { generation: 1 });
  const second = scheduler.schedule(1, async () => secondGate.promise, { generation: 1 });
  const cancelled = scheduler.schedule(2, async () => {
    cancelledStarted = true;
  }, { generation: 1 });
  const survivor = scheduler.schedule(3, async ({ generation }) => generation, { generation: 2 });

  await flushMicrotasks();
  scheduler.cancelGeneration(1);

  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(cancelledStarted, false);

  firstGate.resolve();
  secondGate.resolve();
  await Promise.all([first, second]);
  assert.equal(await survivor, 2);
});

test('a cancelled running generation does not deduplicate a fresh generation', async () => {
  const scheduler = createPageScheduler({ concurrency: 1 });
  const staleGate = deferred();
  let freshRuns = 0;

  const stale = scheduler.schedule(0, async () => {
    await staleGate.promise;
    return 'stale';
  }, { generation: 1 });
  await flushMicrotasks();
  scheduler.cancelGeneration(1);

  const fresh = scheduler.schedule(0, async () => {
    freshRuns += 1;
    return 'fresh';
  }, { generation: 2 });
  assert.notEqual(fresh, stale);

  staleGate.resolve();
  assert.equal(await stale, 'stale');
  assert.equal(await fresh, 'fresh');
  assert.equal(freshRuns, 1);
});

test('queued work for a fresh generation survives cancellation of the stale generation', async () => {
  const scheduler = createPageScheduler({ concurrency: 1 });
  const blocker = deferred();

  const running = scheduler.schedule(9, async () => blocker.promise, { generation: 0 });
  const stale = scheduler.schedule(2, async () => 'stale', { generation: 1, priority: 20 });
  const fresh = scheduler.schedule(2, async () => 'fresh', { generation: 2, priority: 0 });

  assert.notEqual(fresh, stale);
  scheduler.cancelGeneration(1);
  await assert.rejects(stale, { name: 'AbortError' });

  blocker.resolve();
  await running;
  assert.equal(await fresh, 'fresh');
});

test('immediate cancelGeneration prevents task invocation and rejects AbortError', async () => {
  const scheduler = createPageScheduler();
  let invoked = false;
  const pending = scheduler.schedule(0, async () => {
    invoked = true;
  }, { generation: 7 });

  scheduler.cancelGeneration(7);

  await assert.rejects(pending, { name: 'AbortError' });
  await flushMicrotasks();
  assert.equal(invoked, false);
});

test('immediate cancelAll prevents task invocation and rejects AbortError', async () => {
  const scheduler = createPageScheduler();
  let invoked = false;
  const pending = scheduler.schedule(0, async () => {
    invoked = true;
  });

  scheduler.cancelAll();

  await assert.rejects(pending, { name: 'AbortError' });
  await flushMicrotasks();
  assert.equal(invoked, false);
});
