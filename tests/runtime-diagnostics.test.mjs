import test from 'node:test';
import assert from 'node:assert/strict';

let diagnosticsModule = {};
try {
  diagnosticsModule = await import('../src/lib/runtime-diagnostics.js');
} catch {
  // RED phase: the diagnostic module does not exist yet.
}

test('runtime diagnostic capture records thrown errors, rejected promises, and console warnings', async () => {
  assert.equal(typeof diagnosticsModule.installRuntimeDiagnosticCapture, 'function');

  const listeners = new Map();
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const originalCalls = [];
  const consoleObject = {
    warn(...args) { originalCalls.push(['warn', ...args]); },
    error(...args) { originalCalls.push(['error', ...args]); },
  };
  const captured = [];

  diagnosticsModule.installRuntimeDiagnosticCapture({
    target,
    consoleObject,
    component: 'viewer',
    record: (event) => captured.push(event),
  });

  listeners.get('error')({
    message: 'render failed',
    filename: 'viewer.js',
    lineno: 42,
    colno: 7,
    error: new Error('render failed'),
  });
  listeners.get('unhandledrejection')({ reason: new Error('request rejected') });
  consoleObject.warn('KaTeX warning', '\\Omega');

  assert.deepEqual(captured.map((event) => event.kind), [
    'error',
    'unhandledrejection',
    'console.warn',
  ]);
  assert.equal(captured[0].component, 'viewer');
  assert.match(captured[0].source, /viewer\.js:42:7/);
  assert.match(captured[1].message, /request rejected/);
  assert.match(captured[2].message, /KaTeX warning/);
  assert.deepEqual(originalCalls, [['warn', 'KaTeX warning', '\\Omega']]);
});

test('runtime diagnostics persist a bounded redacted report with build identity', async () => {
  assert.equal(typeof diagnosticsModule.appendRuntimeDiagnostic, 'function');
  assert.equal(typeof diagnosticsModule.loadRuntimeDiagnostics, 'function');
  assert.equal(typeof diagnosticsModule.formatRuntimeDiagnostics, 'function');

  const values = {};
  const storageArea = {
    async get(key) { return { [key]: values[key] }; },
    async set(patch) { Object.assign(values, patch); },
  };
  let tick = 0;
  const options = {
    buildId: 'build-test',
    maxEntries: 2,
    now: () => new Date(1_700_000_000_000 + (tick += 1) * 1_000).toISOString(),
  };

  await diagnosticsModule.appendRuntimeDiagnostic(storageArea, {
    component: 'viewer', kind: 'console.warn', message: 'first',
  }, options);
  await diagnosticsModule.appendRuntimeDiagnostic(storageArea, {
    component: 'viewer', kind: 'error', message: 'Bearer sk-secret-value', source: 'viewer.js:10:2',
  }, options);
  await diagnosticsModule.appendRuntimeDiagnostic(storageArea, {
    component: 'service-worker', kind: 'unhandledrejection', message: 'https://api.test/v1?api_key=secret-query',
  }, options);

  const entries = await diagnosticsModule.loadRuntimeDiagnostics(storageArea);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.kind), ['error', 'unhandledrejection']);
  assert.ok(entries.every((entry) => entry.buildId === 'build-test'));
  const report = diagnosticsModule.formatRuntimeDiagnostics(entries);
  assert.match(report, /build-test/);
  assert.match(report, /viewer\.js:10:2/);
  assert.doesNotMatch(report, /sk-secret-value|secret-query/);
  assert.match(report, /Bearer \*\*\*/);
  assert.match(report, /api_key=\*\*\*/);
});
