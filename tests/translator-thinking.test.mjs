import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createThinkingStatusHeartbeat,
  THINKING_STATUS_HEARTBEAT_MS,
  translate,
} from '../src/lib/translator.js';

const openAiConfig = {
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.example/v1',
  apiKey: 'test-key',
  model: 'reasoner-test',
  targetLang: '简体中文',
  temperature: 0.2,
  stream: true,
};

const geminiConfig = {
  provider: 'gemini',
  protocol: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'gemini-key',
  model: 'gemini-thinking-test',
  targetLang: '简体中文',
  temperature: 0.2,
  stream: true,
};

test('thinking heartbeat emits immediately, throttles within the interval, and repeats after it', () => {
  let now = 0;
  const statuses = [];
  const note = createThinkingStatusHeartbeat((phase) => statuses.push(phase), {
    intervalMs: THINKING_STATUS_HEARTBEAT_MS,
    now: () => now,
  });

  note(); // 第一个 reasoning 增量立即发一次
  assert.deepEqual(statuses, ['thinking']);
  now += THINKING_STATUS_HEARTBEAT_MS - 1;
  note(); // 间隔内抑制
  assert.deepEqual(statuses, ['thinking']);
  now += 1;
  note(); // 到达间隔，重发心跳
  now += THINKING_STATUS_HEARTBEAT_MS;
  note();
  assert.deepEqual(statuses, ['thinking', 'thinking', 'thinking']);
});

// 用脚本化 SSE reader 驱动 translate()：每个分片之间推进假时钟。
function scriptedSseResponse(script, clock) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (index >= script.length) return { done: true, value: undefined };
          const step = script[index++];
          clock.advance(step.advance || 0);
          return { done: false, value: encoder.encode(step.line) };
        },
        releaseLock() {},
      }),
    },
  };
}

function fakeClock() {
  let now = 0;
  return { advance(ms) { now += ms; }, now: () => now };
}

function openAiSse(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
}

test('OpenAI long reasoning re-emits thinking heartbeats and never after streaming starts', async () => {
  const clock = fakeClock();
  const script = [
    { advance: 0, line: openAiSse({ reasoning_content: 'r1' }) },
    { advance: 16000, line: openAiSse({ reasoning_content: 'r2' }) }, // 超过 15s，重发
    { advance: 1000, line: openAiSse({ reasoning_content: 'r3' }) },  // 间隔内，抑制
    { advance: 16000, line: openAiSse({ reasoning_content: 'r4' }) }, // 再次重发
    { advance: 0, line: openAiSse({ content: '你好' }) },
    { advance: 20000, line: openAiSse({ reasoning_content: 'late' }) }, // 流式开始后不再发 thinking
    { advance: 0, line: 'data: [DONE]\n' },
  ];
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => clock.now();
  globalThis.fetch = async () => scriptedSseResponse(script, clock);

  const statuses = [];
  const deltas = [];
  try {
    const full = await translate({
      config: openAiConfig,
      text: 'hello',
      onDelta: (d) => deltas.push(d),
      onStatus: (phase) => statuses.push(phase),
    });
    assert.equal(full, '你好');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }

  assert.deepEqual(statuses, ['thinking', 'thinking', 'thinking', 'streaming']);
  assert.deepEqual(deltas, ['你好']);
});

function geminiSse(parts) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n`;
}

test('Gemini long thinking re-emits thinking heartbeats and never after streaming starts', async () => {
  const clock = fakeClock();
  const script = [
    { advance: 0, line: geminiSse([{ thought: true, text: 't1' }]) },
    { advance: 15000, line: geminiSse([{ thought: true, text: 't2' }]) }, // 达到间隔，重发
    { advance: 5000, line: geminiSse([{ thought: true, text: 't3' }]) },  // 间隔内，抑制
    { advance: 0, line: geminiSse([{ text: '译文' }]) },
    { advance: 30000, line: geminiSse([{ thought: true, text: 'late' }]) },
  ];
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  Date.now = () => clock.now();
  globalThis.fetch = async () => scriptedSseResponse(script, clock);

  const statuses = [];
  try {
    const full = await translate({
      config: geminiConfig,
      text: 'hello',
      onStatus: (phase) => statuses.push(phase),
    });
    assert.equal(full, '译文');
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }

  assert.deepEqual(statuses, ['thinking', 'thinking', 'streaming']);
});
