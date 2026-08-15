import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUARD_FIRST_WINDOW_MS,
  GUARD_HOLD_MAX_MS,
  GUARD_IDLE_WINDOW_MS,
  makeInactivityGuard,
} from '../src/lib/inactivity-guard.js';
import { NORMAL_QUEUE_TIMEOUT_MS } from '../src/lib/translation-queue.js';

const REQUEST_TIMEOUT_MS = 180000; // SW 单请求硬超时（service-worker.js）

function createFakeTimers() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++sequence;
      timers.set(id, { fn, at: now + Number(ms) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pendingCount() { return timers.size; },
    advance(ms) {
      const target = now + Number(ms);
      while (true) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) { nextAt = timer.at; nextId = id; }
        }
        if (nextId == null) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function createGuard(overrides = {}) {
  const timers = createFakeTimers();
  let fired = 0;
  const guard = makeInactivityGuard(() => { fired += 1; }, {
    setTimeoutFn: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeoutFn: (id) => timers.clearTimeout(id),
    ...overrides,
  });
  return { guard, timers, firedCount: () => fired };
}

test('guard arms the 90s first-byte window on creation', () => {
  const { guard, timers, firedCount } = createGuard();
  timers.advance(GUARD_FIRST_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
  assert.equal(guard.settled, true);
});

test('bump before first output resets the full first window instead of shrinking to idle', () => {
  // connecting 一到就 bump：旧实现会把窗口压成 45s，新语义必须仍给完整 90s。
  const { guard, timers, firedCount } = createGuard();
  timers.advance(60000);
  guard.bump(); // status: connecting
  timers.advance(GUARD_IDLE_WINDOW_MS + 1); // 旧实现在这里就误杀
  assert.equal(firedCount(), 0);
  timers.advance(GUARD_FIRST_WINDOW_MS - GUARD_IDLE_WINDOW_MS - 2); // bump 后共 90s-1
  assert.equal(firedCount(), 0);
  timers.advance(2);
  assert.equal(firedCount(), 1);
});

test('periodic thinking heartbeats keep renewing the first window during long reasoning', () => {
  const { guard, timers, firedCount } = createGuard();
  for (let beat = 0; beat < 20; beat++) {
    timers.advance(15000); // 思考期每 15s 一次 thinking 心跳
    guard.bump();
    assert.equal(firedCount(), 0);
  }
  // 心跳停止（请求真死了）后，完整 firstMs 静默才触发超时。
  timers.advance(GUARD_FIRST_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
});

test('first output byte switches the guard to the 45s idle window', () => {
  const { guard, timers, firedCount } = createGuard();
  timers.advance(10000);
  guard.output(); // 第一个 chunk 或 status: streaming
  assert.equal(guard.outputStarted, true);
  timers.advance(GUARD_IDLE_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
});

test('after output has started every activity renews only the idle window', () => {
  const { guard, timers, firedCount } = createGuard();
  guard.output();
  timers.advance(30000);
  guard.output(); // 后续 chunk
  timers.advance(30000);
  guard.bump(); // 输出开始后收到的状态也只续 idleMs
  timers.advance(GUARD_IDLE_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
});

test('hold pauses the clock while queued and bump restores the full first window', () => {
  const { guard, timers, firedCount } = createGuard();
  timers.advance(80000);
  guard.hold(); // status: queued
  timers.advance(NORMAL_QUEUE_TIMEOUT_MS - 1000); // 排队等待不算无响应
  assert.equal(firedCount(), 0);
  guard.bump(); // queued 恢复：status: connecting
  timers.advance(GUARD_FIRST_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
});

test('hold has a hard cap so lost port messages cannot leave the page queued forever', () => {
  const { guard, timers, firedCount } = createGuard();
  guard.hold();
  guard.hold(); // 重复 hold 不得重置兜底死线
  timers.advance(GUARD_HOLD_MAX_MS - 1);
  assert.equal(firedCount(), 0);
  guard.hold();
  timers.advance(1);
  assert.equal(firedCount(), 1);
  assert.equal(guard.settled, true);
});

test('hold cap covers one full queue deadline plus one full request timeout plus margin', () => {
  // 排队最长 240s（NORMAL_QUEUE_TIMEOUT_MS），随后请求本身最长 180s，加 30s 余量。
  assert.equal(GUARD_HOLD_MAX_MS, NORMAL_QUEUE_TIMEOUT_MS + REQUEST_TIMEOUT_MS + 30000);
});

test('activity after hold cancels the pending hold cap', () => {
  const { guard, timers, firedCount } = createGuard();
  guard.hold();
  assert.equal(timers.pendingCount(), 1); // 兜底计时器
  timers.advance(100000);
  guard.output(); // 排队结束直接收到首字节
  assert.equal(timers.pendingCount(), 1); // 只剩 idle 计时器，兜底已取消
  timers.advance(GUARD_IDLE_WINDOW_MS - 1);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1); // 由 idle 窗口触发，而不是兜底
});

test('done settles the guard permanently and later signals are no-ops', () => {
  const { guard, timers, firedCount } = createGuard();
  guard.bump();
  guard.done();
  guard.bump();
  guard.output();
  guard.hold();
  timers.advance(GUARD_HOLD_MAX_MS * 3);
  assert.equal(firedCount(), 0);
  assert.equal(guard.settled, true);
  assert.equal(timers.pendingCount(), 0);
});

test('onTimeout fires at most once even with stale timers', () => {
  const { guard, timers, firedCount } = createGuard();
  timers.advance(GUARD_FIRST_WINDOW_MS);
  assert.equal(firedCount(), 1);
  guard.bump();
  guard.output();
  timers.advance(GUARD_FIRST_WINDOW_MS * 2);
  assert.equal(firedCount(), 1);
});

test('custom windows are honoured for future tuning', () => {
  const { guard, timers, firedCount } = createGuard({ firstMs: 100, idleMs: 20, holdMaxMs: 500 });
  timers.advance(99);
  guard.output();
  timers.advance(19);
  assert.equal(firedCount(), 0);
  guard.hold();
  timers.advance(499);
  assert.equal(firedCount(), 0);
  timers.advance(1);
  assert.equal(firedCount(), 1);
  assert.equal(guard.settled, true);
});
