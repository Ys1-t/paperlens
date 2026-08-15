import { redactSecrets } from './secrets.js';

export const RUNTIME_DIAGNOSTICS_KEY = 'paperlensRuntimeDiagnostics';

function diagnosticText(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function clippedRedactedText(value, maxLength = 8000) {
  return redactSecrets(diagnosticText(value)).slice(0, maxLength);
}

export async function loadRuntimeDiagnostics(storageArea) {
  const stored = await storageArea.get(RUNTIME_DIAGNOSTICS_KEY);
  return Array.isArray(stored?.[RUNTIME_DIAGNOSTICS_KEY])
    ? stored[RUNTIME_DIAGNOSTICS_KEY]
    : [];
}

export async function appendRuntimeDiagnostic(storageArea, event, {
  buildId = '',
  maxEntries = 40,
  now = () => new Date().toISOString(),
} = {}) {
  const entry = {
    timestamp: now(),
    buildId: clippedRedactedText(buildId, 200),
    component: clippedRedactedText(event?.component, 100),
    kind: clippedRedactedText(event?.kind, 100),
    message: clippedRedactedText(event?.message),
    source: clippedRedactedText(event?.source, 1000),
    stack: clippedRedactedText(event?.stack),
  };
  const entries = await loadRuntimeDiagnostics(storageArea);
  entries.push(entry);
  await storageArea.set({
    [RUNTIME_DIAGNOSTICS_KEY]: entries.slice(-Math.max(1, maxEntries)),
  });
  return entry;
}

export function formatRuntimeDiagnostics(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry, index) => [
    `#${index + 1} ${entry.timestamp || ''}`,
    `build=${entry.buildId || ''} component=${entry.component || ''} kind=${entry.kind || ''}`,
    entry.source ? `source=${entry.source}` : '',
    entry.message ? `message=${entry.message}` : '',
    entry.stack ? `stack=${entry.stack}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function callRecorder(record, event) {
  try {
    const pending = record(event);
    if (pending?.catch) pending.catch(() => {});
  } catch {
    // Diagnostics must never become a second application error.
  }
}

export function installRuntimeDiagnosticCapture({ target, consoleObject, component, record }) {
  target.addEventListener('error', (event) => {
    callRecorder(record, {
      component,
      kind: 'error',
      message: event.message || diagnosticText(event.error),
      stack: diagnosticText(event.error),
      source: [event.filename, event.lineno, event.colno].filter(Boolean).join(':'),
    });
  });

  target.addEventListener('unhandledrejection', (event) => {
    callRecorder(record, {
      component,
      kind: 'unhandledrejection',
      message: diagnosticText(event.reason),
      stack: diagnosticText(event.reason),
      source: '',
    });
  });

  for (const level of ['warn', 'error']) {
    const original = consoleObject[level]?.bind(consoleObject);
    if (!original) continue;
    consoleObject[level] = (...args) => {
      original(...args);
      callRecorder(record, {
        component,
        kind: `console.${level}`,
        message: args.map(diagnosticText).join(' '),
        stack: '',
        source: '',
      });
    };
  }
}
