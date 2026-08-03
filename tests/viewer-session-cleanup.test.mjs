import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLatestDocumentLoader,
  createViewerSessionCleanup,
  isCurrentDocumentPage,
} from '../src/lib/viewer-session.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('close cleanup cancels one generation and starts best-effort deletion without awaiting it', () => {
  const calls = [];
  let resolveDelete;
  const deletion = new Promise((resolve) => { resolveDelete = resolve; });
  const snapshot = {
    generation: 7,
    documentId: 'doc-7',
    baseUrl: 'http://localhost:8765',
  };
  const cleanup = createViewerSessionCleanup({
    getSnapshot: () => snapshot,
    abortDocument: (value) => calls.push(['abort', value.generation]),
    cancelScheduler: (value) => calls.push(['scheduler', value.generation]),
    cancelRequests: (value) => calls.push(['requests', value.generation]),
    deleteDocument: (value) => {
      calls.push(['delete', value.documentId]);
      return deletion;
    },
  });

  assert.equal(cleanup(), undefined);
  assert.deepEqual(calls, [
    ['scheduler', 7],
    ['requests', 7],
    ['abort', 7],
    ['delete', 'doc-7'],
  ]);
  resolveDelete();
});

test('pagehide and beforeunload cleanup are harmless when fired twice for one generation', async () => {
  let generation = 3;
  const calls = [];
  const cleanup = createViewerSessionCleanup({
    getSnapshot: () => ({ generation, documentId: `doc-${generation}` }),
    abortDocument: () => calls.push('abort'),
    cancelScheduler: () => calls.push('scheduler'),
    cancelRequests: () => calls.push('requests'),
    deleteDocument: async ({ documentId }) => calls.push(`delete:${documentId}`),
  });

  cleanup();
  cleanup();
  await Promise.resolve();
  assert.deepEqual(calls, ['scheduler', 'requests', 'abort', 'delete:doc-3']);

  generation = 4;
  cleanup();
  await Promise.resolve();
  assert.deepEqual(calls.slice(4), ['scheduler', 'requests', 'abort', 'delete:doc-4']);
});

test('delete failures are contained during unload cleanup', async () => {
  const cleanup = createViewerSessionCleanup({
    getSnapshot: () => ({ generation: 1, documentId: 'gone' }),
    abortDocument() {},
    cancelScheduler() {},
    cancelRequests() {},
    deleteDocument: async () => { throw new Error('network gone'); },
  });

  assert.doesNotThrow(cleanup);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('latest URL load aborts A and only opens B when B resolves first', async () => {
  const a = deferred();
  const b = deferred();
  const opened = [];
  const loader = createLatestDocumentLoader(async (document) => opened.push(document));
  let signalA;

  const first = loader.run(({ signal }) => {
    signalA = signal;
    return a.promise;
  });
  const second = loader.run(() => b.promise);

  assert.equal(signalA.aborted, true);
  b.resolve('B');
  assert.equal(await second, true);
  a.resolve('A');
  assert.equal(await first, false);
  assert.deepEqual(opened, ['B']);
});

test('stale file arrayBuffer completion cannot open after a newer file', async () => {
  const a = deferred();
  const b = deferred();
  const opened = [];
  const loader = createLatestDocumentLoader(async (document) => opened.push(document));

  const first = loader.run(() => a.promise);
  const second = loader.run(() => b.promise);
  b.resolve('new-file');
  await second;
  a.resolve('old-file');
  await first;

  assert.deepEqual(opened, ['new-file']);
});

test('isCurrentDocumentPage rejects closed, replaced, and retried page work', () => {
  const page = { documentGeneration: 5, renderGeneration: 9 };
  assert.equal(isCurrentDocumentPage(5, null, page, 5, 9), true);
  assert.equal(isCurrentDocumentPage(6, null, page, 5, 9), false);
  assert.equal(isCurrentDocumentPage(5, 5, page, 5, 9), false);
  assert.equal(isCurrentDocumentPage(5, null, page, 4, 9), false);
  assert.equal(isCurrentDocumentPage(5, null, page, 5, 10), false);
});
