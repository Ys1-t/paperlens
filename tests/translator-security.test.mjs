import test from 'node:test';
import assert from 'node:assert/strict';

import { translate } from '../src/lib/translator.js';
import { TRANSLATION_PORT_NAME } from '../src/lib/build-info.js';

const geminiConfig = {
  provider: 'gemini',
  protocol: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'gemini-secret-123456',
  model: 'gemini-test',
  targetLang: '简体中文',
  temperature: 0.2,
  stream: false,
};

test('Gemini sends key in x-goog-api-key and never in URL', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '你好' }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    assert.equal(await translate({ config: geminiConfig, text: 'hello' }), '你好');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url.includes('key='), false);
  assert.equal(fetchCalls[0].url.includes(geminiConfig.apiKey), false);
  assert.equal(fetchCalls[0].options.headers['x-goog-api-key'], geminiConfig.apiKey);
});

test('model HTTP errors never expose credentials or credential-bearing URLs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      message: `Bearer ${geminiConfig.apiKey} https://user:pass@example.test/v1?access_token=${geminiConfig.apiKey}`,
    },
  }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await assert.rejects(
      translate({ config: geminiConfig, text: 'hello' }),
      (error) => {
        assert.equal(error.message.includes(geminiConfig.apiKey), false);
        assert.equal(error.message.includes('user:pass@'), false);
        assert.match(error.message, /Bearer \*\*\*/);
        assert.match(error.message, /access_token=\*\*\*/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('service worker redacts errors returned to extension callers', async () => {
  const leaked = 'abcdef123456';
  const harness = await importServiceWorker({
    storageGet: async () => {
      throw new Error(`Bearer ${leaked} https://u:p@example.test/v1?token=${leaked}`);
    },
  });

  const response = await harness.sendRuntimeMessage({ type: 'testConnection' });

  assert.equal(response.ok, false);
  assert.equal(response.error.includes(leaked), false);
  assert.equal(response.error.includes('u:p@'), false);
  assert.match(response.error, /Bearer \*\*\*/);
  assert.match(response.error, /token=\*\*\*/);
});

test('testConnection override is used transiently without persisting provider state', async () => {
  const originalFetch = globalThis.fetch;
  const initialState = providerState([profile()], 'p1');
  const harness = await importServiceWorker({ state: initialState });
  globalThis.fetch = async () => okOpenAiResponse('override accepted');

  try {
    const response = await harness.sendRuntimeMessage({
      type: 'testConnection',
      override: {
        baseUrl: 'https://temporary.example/v1',
        apiKey: 'temporary-key',
        model: 'temporary-model',
      },
    });
    assert.equal(response.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(harness.getStorageState(), initialState);
  assert.deepEqual(harness.getStorageWrites(), []);
});

test('testConnection rejects unsafe override URLs before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const harness = await importServiceWorker({
    state: providerState([profile()], 'p1'),
  });
  globalThis.fetch = async () => {
    fetchCount += 1;
    return okOpenAiResponse('must not happen');
  };

  try {
    const response = await harness.sendRuntimeMessage({
      type: 'testConnection',
      override: { baseUrl: 'http://public.example/v1', apiKey: 'temporary-key' },
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /HTTPS/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing-key errors identify the request snapshot profile', async () => {
  const harness = await importServiceWorker({
    state: providerState([
      profile({ id: 'p1', name: 'No Key Profile', apiKey: '' }),
    ], 'p1'),
    cachedValue: 'cached translation must not bypass the key guard',
  });
  const port = harness.connectPort();

  const result = port.waitFor((message) => (
    message.id === 'missing-key' && (message.type === 'error' || message.type === 'done')
  ));
  port.send({ type: 'translate', id: 'missing-key', text: 'hello', priority: true });
  const message = await result;

  assert.equal(message.type, 'error');
  assert.match(message.message, /No Key Profile/);
});

test('queued requests keep the config snapshot loaded before a profile switch', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return firstResponse;
    return okOpenAiResponse('second');
  };

  const p1 = profile({ id: 'p1', name: 'First', apiKey: 'key-one', model: 'model-one' });
  const p2 = profile({ id: 'p2', name: 'Second', apiKey: 'key-two', model: 'model-two' });
  const harness = await importServiceWorker({ state: providerState([p1, p2], 'p1', { concurrency: 1, stream: false }) });
  const port = harness.connectPort();

  try {
    const firstDone = port.waitFor((message) => message.type === 'done' && message.id === 'first');
    port.send({ type: 'translate', id: 'first', text: 'one' });
    await waitFor(() => calls.length === 1);

    const queued = port.waitFor((message) => message.type === 'status' && message.id === 'second' && message.phase === 'queued');
    port.send({ type: 'translate', id: 'second', text: 'two' });
    await queued;
    harness.setActiveProfile('p2');

    releaseFirst(okOpenAiResponse('first'));
    await firstDone;
    await port.waitFor((message) => message.type === 'done' && message.id === 'second');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api-one\.example/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer key-one');
  assert.match(calls[1].options.body, /model-one/);
});

test('service worker retries a transient model fetch once before output starts', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const harness = await importServiceWorker({
    state: providerState([profile()], 'p1', { concurrency: 1, stream: false }),
  });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return okOpenAiResponse('recovered translation');
  };

  try {
    const port = harness.connectPort();
    const done = port.waitFor((message) => message.id === 'network-retry' && message.type === 'done');
    port.send({ type: 'translate', id: 'network-retry', text: 'hello', priority: true });
    const result = await done;
    assert.equal(result.full, 'recovered translation');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 2);
});

test('service worker never replays a stream after a translation chunk was emitted', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const harness = await importServiceWorker({
    state: providerState([profile()], 'p1', { concurrency: 1, stream: true }),
  });
  const encoder = new TextEncoder();
  globalThis.fetch = async () => {
    calls += 1;
    let pullCount = 0;
    const body = new ReadableStream({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
          ));
          return;
        }
        controller.error(new TypeError('Failed to fetch'));
      },
    });
    return new Response(body, { status: 200 });
  };

  try {
    const port = harness.connectPort();
    const chunk = port.waitFor((message) => message.id === 'partial-stream' && message.type === 'chunk');
    const error = port.waitFor((message) => message.id === 'partial-stream' && message.type === 'error');
    port.send({ type: 'translate', id: 'partial-stream', text: 'hello', priority: true });
    assert.equal((await chunk).delta, 'partial');
    assert.match((await error).message, /Failed to fetch/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 1);
});

test('port message waiters reject after a bounded timeout', { timeout: 1000 }, async () => {
  const harness = await importServiceWorker({
    state: providerState([profile()], 'p1'),
  });
  const port = harness.connectPort();

  await assert.rejects(
    port.waitFor(() => false, { timeoutMs: 20 }),
    /Timed out waiting for port message/,
  );
});

function profile(overrides = {}) {
  return {
    id: 'p1',
    name: 'Primary',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api-one.example/v1',
    apiKey: 'key-one',
    model: 'model-one',
    ...overrides,
  };
}

function providerState(profiles, activeProfileId, config = {}) {
  return {
    config: { targetLang: '简体中文', concurrency: 4, stream: false, ...config },
    providerProfiles: profiles,
    activeProfileId,
  };
}

function okOpenAiResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function importServiceWorker({ state, storageGet, cachedValue = null } = {}) {
  let storageData = structuredClone(state || {});
  const storageWrites = [];
  const events = Object.fromEntries([
    'connect', 'message', 'installed', 'startup', 'storageChanged', 'contextMenuClicked', 'actionClicked',
  ].map((name) => [name, createEvent()]));

  globalThis.__paperLensTestCacheValue = cachedValue;
  globalThis.indexedDB = { open: openFakeIndexedDb };
  globalThis.chrome = {
    runtime: {
      onConnect: events.connect,
      onMessage: events.message,
      onInstalled: events.installed,
      onStartup: events.startup,
      getURL: (path) => `chrome-extension://test/${path}`,
      lastError: null,
    },
    storage: {
      local: {
        get: storageGet || (async () => structuredClone(storageData)),
        async set(patch) {
          const cloned = structuredClone(patch);
          storageWrites.push(cloned);
          Object.assign(storageData, cloned);
        },
      },
      onChanged: events.storageChanged,
    },
    tabs: { async create() { return { id: 1 }; } },
    declarativeNetRequest: { async updateDynamicRules() {} },
    contextMenus: { create() {}, onClicked: events.contextMenuClicked },
    action: { onClicked: events.actionClicked },
  };

  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const url = new URL('../src/background/service-worker.js', import.meta.url);
    url.searchParams.set('test', `${Date.now()}-${Math.random()}`);
    await import(url.href);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  return {
    setActiveProfile(id) { storageData.activeProfileId = id; },
    getStorageState() { return structuredClone(storageData); },
    getStorageWrites() { return structuredClone(storageWrites); },
    async sendRuntimeMessage(message) {
      const listener = events.message.listeners[0];
      return new Promise((resolve) => listener(message, {}, resolve));
    },
    connectPort() {
      const incoming = createEvent();
      const disconnected = createEvent();
      const messages = [];
      const waiters = [];
      const port = {
        name: TRANSLATION_PORT_NAME,
        onMessage: incoming,
        onDisconnect: disconnected,
        postMessage(message) {
          messages.push(message);
          for (const waiter of waiters.splice(0)) {
            if (waiter.predicate(message)) {
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            } else {
              waiters.push(waiter);
            }
          }
        },
      };
      events.connect.listeners[0](port);
      return {
        send(message) { incoming.listeners[0](message); },
        waitFor(predicate, { timeoutMs = 2000 } = {}) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(new Error(`Timed out waiting for port message after ${timeoutMs}ms`));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
      };
    },
  };
}

function openFakeIndexedDb() {
  const openRequest = {};
  queueMicrotask(() => {
    openRequest.result = {
      objectStoreNames: { contains: () => true },
      transaction() {
        const transaction = {
          objectStore() {
            return {
              get() {
                const request = {};
                queueMicrotask(() => {
                  request.result = globalThis.__paperLensTestCacheValue;
                  request.onsuccess?.();
                });
                return request;
              },
              put() { queueMicrotask(() => transaction.oncomplete?.()); },
            };
          },
        };
        return transaction;
      },
    };
    openRequest.onsuccess?.();
  });
  return openRequest;
}

function createEvent() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}
