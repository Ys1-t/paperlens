import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAutoRetryLabel,
  isRetriableTranslationError,
  nextRetryDelayMs,
  shouldScheduleAutoRetry,
} from '../src/lib/smart-retry.js';

test('retriable errors include connection, rate limit, timeout, and 5xx', () => {
  assert.equal(isRetriableTranslationError('与后台的连接已断开，请重试。'), true);
  // 标签页冻结期间 SW 被回收、onDisconnect 丢失时死端口的原生同步抛错。
  assert.equal(isRetriableTranslationError('Attempting to use a disconnected port object'), true);
  assert.equal(isRetriableTranslationError('HTTP 429 rate limit'), true);
  assert.equal(isRetriableTranslationError('请求超时（180s）'), true);
  assert.equal(isRetriableTranslationError('Bad Gateway 502'), true);
  assert.equal(isRetriableTranslationError('排队等待超时（240s）'), true);
  assert.equal(isRetriableTranslationError('模型输出了自言自语/推理过程而非译文，将自动重试本页'), true);
  assert.equal(isRetriableTranslationError('模型输出陷入重复循环，将自动重试本页'), true);
  assert.equal(isRetriableTranslationError('译文残留了成段英文，将自动定向补译本页'), true);
  assert.equal(isRetriableTranslationError('公式 LaTeX 定界符不完整，将自动重试本页'), true);
  assert.equal(isRetriableTranslationError('译文疑似漏段，将结合 PDF 原生文本自动重试本页'), true);
  assert.equal(isRetriableTranslationError('算法伪代码的分行、行号或缩进丢失，将自动精修本页'), true);
  assert.equal(isRetriableTranslationError('引用标记发生漏译，将按 PDF 原文锚点自动补齐'), true);
  assert.equal(isRetriableTranslationError('视觉模型拒绝了页面翻译，将自动重试'), true);
});

test('non-retriable errors include auth and cancel', () => {
  assert.equal(isRetriableTranslationError('尚未配置 API Key'), false);
  assert.equal(isRetriableTranslationError('HTTP 401 Unauthorized'), false);
  assert.equal(isRetriableTranslationError('已取消'), false);
});

test('backoff doubles and caps', () => {
  assert.equal(nextRetryDelayMs(0, { baseMs: 1000, maxMs: 10000 }), 1000);
  assert.equal(nextRetryDelayMs(1, { baseMs: 1000, maxMs: 10000 }), 2000);
  assert.equal(nextRetryDelayMs(2, { baseMs: 1000, maxMs: 10000 }), 4000);
  assert.equal(nextRetryDelayMs(10, { baseMs: 1000, maxMs: 10000 }), 10000);
});

test('shouldScheduleAutoRetry respects attempt budget', () => {
  assert.equal(shouldScheduleAutoRetry({ attempt: 0, maxAttempts: 3, error: 'timeout' }), true);
  assert.equal(shouldScheduleAutoRetry({ attempt: 2, maxAttempts: 3, error: 'timeout' }), true);
  assert.equal(shouldScheduleAutoRetry({ attempt: 3, maxAttempts: 3, error: 'timeout' }), false);
  assert.equal(shouldScheduleAutoRetry({ attempt: 0, error: '尚未配置 API Key' }), false);
});

test('formatAutoRetryLabel is human readable', () => {
  assert.match(formatAutoRetryLabel(2, 4500), /5s 后自动重试（第 2 次）/);
});
