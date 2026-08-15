import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_TOKEN_ESTIMATE,
  PROMPT_OVERHEAD_TOKENS,
  USAGE_STORAGE_KEY,
  accumulateUsage,
  addUsageSample,
  emptyUsageStats,
  estimateCost,
  estimateRequestTokens,
  estimateTokens,
  formatTokenCount,
  loadUsageStats,
  resetUsageStats,
} from '../src/lib/usage-stats.js';

function fakeArea() {
  const store = {};
  return {
    store,
    async get(key) { return { [key]: store[key] }; },
    async set(obj) { Object.assign(store, obj); },
  };
}

test('estimateTokens counts CJK per char and other text per 4 chars', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('注意力机制'), 5);
  // 混排：4 个 CJK + 8 个 ASCII → 4 + 2
  assert.equal(estimateTokens('注意力头attention'), Math.ceil(3 + 9 / 4) + 1);
  assert.ok(estimateTokens('Transformer 模型很强') > 0);
});

test('estimateRequestTokens adds overhead and image cost', () => {
  const textOnly = estimateRequestTokens({ text: 'abcd', full: '译文四字' });
  assert.equal(textOnly.promptTokens, 1 + PROMPT_OVERHEAD_TOKENS);
  assert.equal(textOnly.completionTokens, 4);
  const vision = estimateRequestTokens({ text: '', full: '', image: true });
  assert.equal(vision.promptTokens, PROMPT_OVERHEAD_TOKENS + IMAGE_TOKEN_ESTIMATE);
});

test('accumulateUsage adds totals, day buckets, and prunes stale days', () => {
  let stats = emptyUsageStats();
  stats = accumulateUsage(stats, { promptTokens: 100, completionTokens: 50, day: '2026-07-27' });
  stats = accumulateUsage(stats, { promptTokens: 10, completionTokens: 5, day: '2026-07-27' });
  assert.equal(stats.requests, 2);
  assert.equal(stats.promptTokens, 110);
  assert.equal(stats.completionTokens, 55);
  assert.equal(stats.days['2026-07-27'].requests, 2);

  // 46+ 天的旧分桶被裁剪，只保留最近的
  for (let i = 1; i <= 50; i += 1) {
    stats = accumulateUsage(stats, { promptTokens: 1, day: `2026-05-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  assert.ok(Object.keys(stats.days).length <= 45);
  assert.equal(stats.requests, 52); // 总数不受裁剪影响
});

test('addUsageSample / loadUsageStats / resetUsageStats roundtrip via storage area', async () => {
  const area = fakeArea();
  await addUsageSample({ promptTokens: 700, completionTokens: 300 }, area);
  await addUsageSample({ promptTokens: 300, completionTokens: 200 }, area);
  const stats = await loadUsageStats(area);
  assert.equal(stats.requests, 2);
  assert.equal(stats.promptTokens, 1000);
  assert.equal(stats.completionTokens, 500);
  assert.ok(area.store[USAGE_STORAGE_KEY]);

  await resetUsageStats(area);
  const cleared = await loadUsageStats(area);
  assert.equal(cleared.requests, 0);
  assert.equal(cleared.promptTokens, 0);

  // 坏存储静默降级
  assert.equal(await addUsageSample({ promptTokens: 1 }, { get: async () => { throw new Error('x'); }, set: async () => { throw new Error('x'); } }), null);
  assert.deepEqual(await loadUsageStats(null), emptyUsageStats());
});

test('formatTokenCount uses 万/亿 units', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(12345), '1.2万');
  assert.equal(formatTokenCount(123456789), '1.23亿');
});

test('estimateCost multiplies per-million prices; null when no prices', () => {
  const stats = { requests: 1, promptTokens: 2_000_000, completionTokens: 500_000, days: {} };
  assert.equal(estimateCost(stats, {}), null);
  assert.equal(estimateCost(stats, { inPricePerM: 2 }), 4);
  assert.equal(estimateCost(stats, { inPricePerM: 2, outPricePerM: 8 }), 8);
});
