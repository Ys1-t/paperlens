import test from 'node:test';
import assert from 'node:assert/strict';

import { createTranslationScheduler, NORMAL_QUEUE_TIMEOUT_MS } from '../src/lib/translation-queue.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('formula OCR uses an independent single-concurrency lane', async () => {
  const scheduler = createTranslationScheduler(() => 1);
  const formulaOne = deferred();
  const formulaTwo = deferred();
  const normal = deferred();
  const started = [];

  const f1 = scheduler.schedule(async () => { started.push('formula-1'); await formulaOne.promise; }, { formula: true });
  const f2 = scheduler.schedule(async () => { started.push('formula-2'); await formulaTwo.promise; }, { formula: true });
  const text = scheduler.schedule(async () => { started.push('text'); await normal.promise; });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(started, ['formula-1', 'text']);
  normal.resolve();
  formulaOne.resolve();
  await Promise.all([text, f1]);
  await Promise.resolve();
  assert.deepEqual(started, ['formula-1', 'text', 'formula-2']);
  formulaTwo.resolve();
  await f2;
});

test('high-priority local recovery overtakes queued prefetch work', async () => {
  const scheduler = createTranslationScheduler(() => 1);
  const blocker = deferred();
  const started = [];
  const running = scheduler.schedule(async () => {
    started.push('running');
    await blocker.promise;
  });
  const prefetch = scheduler.schedule(async () => { started.push('prefetch'); }, { priority: 10 });
  const recovery = scheduler.schedule(async () => { started.push('recovery'); }, { priority: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ['running']);

  blocker.resolve();
  await running;
  await recovery;
  await prefetch;
  assert.deepEqual(started, ['running', 'recovery', 'prefetch']);
});

test('normal translation queue wait has a finite deadline', async () => {
  const scheduler = createTranslationScheduler(() => 1);
  const blocker = deferred();
  const running = scheduler.schedule(() => blocker.promise);
  const queued = scheduler.schedule(async () => 'must-not-run', { queueTimeoutMs: 15 });

  await assert.rejects(queued, (error) => {
    assert.equal(error?.code, 'translation_queue_timeout');
    // 排队超时文案必须与模型响应超时（「请求超时/模型响应较慢」）可区分。
    assert.match(error.message, /排队等待超时/);
    assert.doesNotMatch(error.message, /请求超时|模型响应/);
    return true;
  });
  blocker.resolve();
  await running;
});

test('default queue deadline waits out one full slow request instead of 60s', async () => {
  // 并发槽位可被慢请求合法占满 180s（SW REQUEST_TIMEOUT_MS）；
  // 死线 = 180s + 60s 缓冲 = 240s，必须存在且有限。
  assert.equal(NORMAL_QUEUE_TIMEOUT_MS, 240000);
  assert.ok(Number.isFinite(NORMAL_QUEUE_TIMEOUT_MS) && NORMAL_QUEUE_TIMEOUT_MS > 0);

  const scheduler = createTranslationScheduler(() => 1);
  const blocker = deferred();
  const running = scheduler.schedule(() => blocker.promise);

  const scheduledDelays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    scheduledDelays.push(Number(ms));
    return originalSetTimeout(fn, ms, ...args);
  };
  let queued;
  try {
    queued = scheduler.schedule(async () => 'ran-after-slot-freed');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(scheduledDelays, [NORMAL_QUEUE_TIMEOUT_MS]);
  blocker.resolve();
  await running;
  assert.equal(await queued, 'ran-after-slot-freed');
});
