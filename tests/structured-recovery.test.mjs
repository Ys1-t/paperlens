import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMathPlaceholder } from '../src/lib/structured-translation.js';
import {
  inspectStructuredTranslation,
  retryStructuredItemsOnce,
  structuredRecoveryFailureText,
} from '../src/lib/structured-recovery.js';

const delimiter = '\n\n@@@BLK@@@\n\n';

function mathItem(id = 'math-block') {
  const token = buildMathPlaceholder(`${id}-formula`);
  return {
    id,
    kind: 'math_paragraph',
    text: `The preference vector ${token} encodes the relative importance of objectives.`,
    mathTokens: [token],
    textSlots: [
      [{ id: `${id}-left`, text: 'The preference vector ' }],
      [{ id: `${id}-right`, text: ' encodes the relative importance of objectives.' }],
    ],
  };
}

test('inspection consumes failedItems and diagnostics while retaining healthy items', () => {
  const formula = mathItem();
  const diagnosticOnly = {
    id: 'diagnostic-only',
    text: 'This additional long English paragraph was damaged by another validation diagnostic.',
  };
  const healthy = {
    id: 'healthy',
    text: 'This healthy source paragraph is long enough to activate translation quality checking.',
  };
  const untranslated = {
    id: 'untranslated',
    text: 'This long English paragraph was returned without any translation by the provider.',
  };
  const result = [];
  Object.defineProperties(result, {
    failedItems: { value: [{ id: formula.id, code: 'math_placeholder_validation' }] },
    diagnostics: { value: [{ id: diagnosticOnly.id, code: 'validation_diagnostic' }] },
  });
  const output = [
    '公式段损坏',
    diagnosticOnly.text,
    '这个健康段落已经被完整翻译。',
    untranslated.text,
  ].join(delimiter);

  const inspection = inspectStructuredTranslation({
    items: [formula, diagnosticOnly, healthy, untranslated],
    translatedText: output,
    result,
    targetLang: '简体中文',
  });

  assert.deepEqual(inspection.retryItems.map((item) => item.id), [
    formula.id,
    diagnosticOnly.id,
    untranslated.id,
  ]);
  assert.equal(inspection.placeholderFailures, 2);
  assert.equal(inspection.untranslatedItems, 1);
  assert.match(inspection.statusText, /2 个含公式段落需要重试/);
  assert.match(inspection.statusText, /1 个段落疑似未翻译/);
  assert.equal(inspection.retryItems.includes(healthy), false);
});

test('quality inspection strips math placeholders before judging English prose', () => {
  const token = buildMathPlaceholder('token-with-many-English-words');
  const item = {
    id: 'short-formula-context',
    kind: 'math_paragraph',
    text: `where ${token}.`,
  };

  const inspection = inspectStructuredTranslation({
    items: [item],
    translatedText: `其中 ${token}。`,
    result: [],
    targetLang: '简体中文',
  });

  assert.deepEqual(inspection.retryItems, []);
});

test('local recovery makes one request and never touches a healthy initial item', async () => {
  const formula = mathItem('failed-formula');
  const untranslated = {
    id: 'untranslated',
    text: 'This long English paragraph remains entirely untranslated after the local retry attempt.',
  };
  const healthy = {
    id: 'healthy',
    text: 'This healthy paragraph has already been translated and must never be rolled back.',
  };
  let requests = 0;
  const changedIds = [];
  const requestIds = [];

  const retry = await retryStructuredItemsOnce({
    items: [formula, untranslated],
    targetLang: '简体中文',
    request: (text) => {
      requests += 1;
      assert.equal(text, `${formula.text}${delimiter}${untranslated.text}`);
      return {
        id: 42,
        promise: Promise.resolve({
          full: `公式占位符被模型删除了${delimiter}${untranslated.text}`,
        }),
      };
    },
    onRequestId: (id) => requestIds.push(id),
    onChanges: (changes) => changedIds.push(...changes.map((change) => change.id)),
  });

  assert.equal(requests, 1);
  assert.deepEqual(requestIds, [42]);
  assert.deepEqual(retry.unresolvedItems.map((item) => item.id), [formula.id, untranslated.id]);
  assert.equal(changedIds.includes(healthy.id), false);
  assert.ok(changedIds.every((id) => id.startsWith('failed-formula-') || id === untranslated.id));
});

test('local recovery accepts a valid formula retry and translated prose', async () => {
  const formula = mathItem('recoverable-formula');
  const prose = {
    id: 'recoverable-prose',
    text: 'This sufficiently long source paragraph needs a complete Chinese translation from the model.',
  };

  const retry = await retryStructuredItemsOnce({
    items: [formula, prose],
    targetLang: '简体中文',
    request: () => ({
      id: 7,
      promise: Promise.resolve({
        full: `偏好向量 ${formula.mathTokens[0]} 编码目标的相对重要性。${delimiter}这个源段落已被完整翻译。`,
      }),
    }),
  });

  assert.equal(retry.attempted, true);
  assert.equal(retry.cancelled, false);
  assert.deepEqual(retry.unresolvedItems, []);
});

test('generation changes suppress stale retry deltas and completion', async () => {
  const item = {
    id: 'stale',
    text: 'This sufficiently long paragraph belongs to an obsolete document generation.',
  };
  let resolveRequest;
  let retryDelta;
  let current = true;
  const requestIds = [];
  const changes = [];

  const pending = retryStructuredItemsOnce({
    items: [item],
    targetLang: '简体中文',
    request: (_text, onDelta) => {
      retryDelta = onDelta;
      return {
        id: 88,
        promise: new Promise((resolve) => { resolveRequest = resolve; }),
      };
    },
    isCurrent: () => current,
    onRequestId: (id) => requestIds.push(id),
    onChanges: (next) => changes.push(...next),
  });

  assert.deepEqual(requestIds, [88]);
  current = false;
  retryDelta('不应写入旧页面');
  resolveRequest({ full: '也不应在完成时写入旧页面' });
  const result = await pending;

  assert.equal(result.cancelled, true);
  assert.deepEqual(changes, []);
});

test('a cancelled current retry remains an unresolved paragraph instead of looking successful', async () => {
  const item = {
    id: 'cancelled-current',
    text: 'This sufficiently long paragraph still needs translation after cancellation.',
  };
  const retry = await retryStructuredItemsOnce({
    items: [item],
    targetLang: '简体中文',
    request: () => ({
      id: 99,
      promise: Promise.reject(Object.assign(new Error('已取消'), { cancelled: true })),
    }),
  });

  assert.equal(retry.cancelled, true);
  assert.deepEqual(retry.unresolvedItems, [item]);
});

test('second-failure warning is localized and explicitly preserves other translations', () => {
  assert.equal(
    structuredRecoveryFailureText(2),
    '局部修复未完成：2 个段落仍需重试。其他译文已保留。',
  );
});
