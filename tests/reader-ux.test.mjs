import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPagePresentation,
  buildReaderProgress,
  friendlyReaderError,
  isBackgroundConnectionError,
} from '../src/lib/reader-ux.js';

test('reader errors become short actionable messages without leaking transport jargon', () => {
  assert.equal(friendlyReaderError(new Error('Failed to fetch')), '网络连接中断，请检查模型服务后重试。');
  assert.equal(friendlyReaderError('HTTP 401 Unauthorized'), '模型授权失败，请检查当前供应商的 API Key。');
  assert.equal(friendlyReaderError('request timeout'), '模型响应较慢，本页可以稍后重试。');
  assert.equal(friendlyReaderError('math placeholder mismatch'), '公式保护校验未通过，原公式已保留，请重试本页。');
});

test('background port disconnects explain multi-document and retry', () => {
  assert.equal(isBackgroundConnectionError('与后台的连接已断开，请重试。'), true);
  // Chrome 在死端口上 postMessage 的原生错误（冻结标签页 onDisconnect 丢失时）。
  assert.equal(isBackgroundConnectionError('Attempting to use a disconnected port object'), true);
  const message = friendlyReaderError('与后台的连接已断开，请重试。');
  assert.match(message, /与后台连接中断/);
  assert.match(message, /重试/);
  assert.match(message, /多篇|重载/);
  assert.match(friendlyReaderError('Attempting to use a disconnected port object'), /与后台连接中断/);
});

test('queue-wait timeouts stay distinguishable from slow-model timeouts', () => {
  // 排队超时（并发槽位被占满）与模型响应超时是不同的故障，不得归一化成同一句话。
  const queueMessage = friendlyReaderError('排队等待超时（240s）：前方翻译任务较多，请稍后重试本页');
  const modelMessage = friendlyReaderError('请求超时（180s）——请检查网络 / Base URL / 模型名是否正确');
  assert.match(queueMessage, /排队等待超时：前方任务较多/);
  assert.equal(modelMessage, '模型响应较慢，本页可以稍后重试。');
  assert.notEqual(queueMessage, modelMessage);
  // 旧版短文案与错误码同样能被识别为排队超时。
  assert.match(friendlyReaderError('翻译请求排队超时（60s）'), /排队等待超时：前方任务较多/);
  assert.match(friendlyReaderError('translation_queue_timeout'), /排队等待超时：前方任务较多/);
});

test('reader progress prioritizes completion, active work, and recoverable issues', () => {
  // Toolbar shows a short page count; full sentence lives in `detail` (title).
  assert.deepEqual(buildReaderProgress({ total: 10 }), {
    label: '0/10 页', detail: '准备翻译 · 共 10 页', tone: 'idle', percent: 0,
  });
  assert.deepEqual(buildReaderProgress({ total: 10, done: 3, inProgress: 2 }), {
    label: '3/10 页', detail: '正在翻译 · 3/10 页完成', tone: 'busy', percent: 30,
  });
  assert.deepEqual(buildReaderProgress({ total: 10, done: 8, issues: 1 }), {
    label: '8/10 · 1待处理', detail: '8/10 页完成 · 1 页待处理', tone: 'warning', percent: 80,
  });
  assert.deepEqual(buildReaderProgress({ total: 10, done: 10 }), {
    label: '10/10 页', detail: '全文翻译完成 · 10 页', tone: 'success', percent: 100,
  });
});

test('page presentation exposes retry only when the reader can act on it', () => {
  assert.equal(buildPagePresentation({}).retry, false);
  assert.deepEqual(buildPagePresentation({ active: true }), {
    label: '正在翻译', tone: 'busy', retry: false,
  });
  assert.deepEqual(buildPagePresentation({ active: true, qualityWarning: true }), {
    label: '精修中 · 译文可读', tone: 'warning', retry: false,
  });
  assert.deepEqual(buildPagePresentation({ outcome: 'partial', qualityWarning: true }), {
    label: '译文可读 · 待精修', tone: 'warning', retry: true,
  });
  assert.deepEqual(buildPagePresentation({ outcome: 'partial', unresolvedCount: 2 }), {
    label: '2 处待补全', tone: 'warning', retry: true,
  });
  assert.deepEqual(buildPagePresentation({ outcome: 'failed' }), {
    label: '需要重试', tone: 'error', retry: true,
  });
  assert.deepEqual(buildPagePresentation({ outcome: 'done', error: true }), {
    label: '需要重试', tone: 'error', retry: true,
  });
});
