import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MAX_READING_UNIT_MATH_TOKENS,
  createReadingTranslationPlan,
  createTextNodeTranslationPlan,
  expandReadingTranslationChange,
  extractMathTokens,
  updateStructuredTextNode,
} from '../src/lib/structured-translation.js';
import {
  NODE_TRANSLATION_BATCH_CONCURRENCY,
  createNodeTranslationBatches,
  createNodeTranslationAccumulator,
  inspectNodeTranslation,
  isCacheableNodeTranslation,
  mapNodeTranslationBatches,
  nodeRecoveryFailureText,
  parseNodeTranslationResponse,
  retryNodeItemsOnce,
  serializeNodeTranslationRequest,
} from '../src/lib/node-translation.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('stable node payload is NDJSON keyed by source IDs with no positional controls', () => {
  const items = [
    { id: 'p2-b19-s0', text: 'where ' },
    { id: 'p2-b19-s2', text: ' is the decision variable.' },
  ];
  const payload = serializeNodeTranslationRequest(items);
  assert.deepEqual(payload.split('\n').map((line) => JSON.parse(line)), items);
  assert.doesNotMatch(payload, /\[\[PLM:|@@@BLK@@@/u);
});

test('partial failure message is scoped to unresolved text nodes', () => {
  assert.equal(
    nodeRecoveryFailureText(2),
    '局部修复未完成：2 个文本节点仍需重试。其他译文已保留。',
  );
});

test('short academic labels are validated without rejecting proper names', () => {
  const items = [
    { id: 'header', text: 'Problem' },
    { id: 'name', text: 'Pareto' },
  ];
  const result = inspectNodeTranslation({
    items,
    translatedText: [
      JSON.stringify({ id: 'header', text: 'Problem' }),
      JSON.stringify({ id: 'name', text: 'Pareto' }),
    ].join('\n'),
    targetLang: '简体中文',
  });
  assert.deepEqual(result.unresolvedIds, ['header']);
  assert.deepEqual(result.changes, [{ id: 'name', text: 'Pareto' }]);
});

test('streaming accumulator emits complete valid node records independently', () => {
  const items = [
    { id: 'left', text: 'where ' },
    { id: 'right', text: ' is the decision space.' },
  ];
  const accumulator = createNodeTranslationAccumulator(items, { targetLang: '简体中文' });

  assert.deepEqual(accumulator.push('{"id":"left","text":"其'), []);
  assert.deepEqual(accumulator.push('中"}\n{"id":"right","text":" 是决策空间。"}\n'), [
    { id: 'left', text: '其中' },
    { id: 'right', text: ' 是决策空间。' },
  ]);
});

test('node requests are split into ordered bounded batches with a smaller first batch', () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `node-${index}`,
    text: `Paragraph ${index} ${'academic '.repeat(20)}`,
  }));
  const batches = createNodeTranslationBatches(items, {
    firstMaxItems: 2,
    firstMaxCost: 500,
    maxItems: 3,
    maxCost: 700,
  });

  assert.ok(batches.length >= 3);
  assert.ok(batches[0].length <= 2, 'the first visible batch stays deliberately small');
  assert.ok(batches.slice(1).every((batch) => batch.length <= 3));
  assert.deepEqual(
    batches.flat().map((item) => item.id),
    items.map((item) => item.id),
    'stable source order and identity must survive batching',
  );
});

test('an oversized math-heavy node is isolated without changing its placeholders', () => {
  const mathTokens = Array.from({ length: 7 }, (_, index) => `[[PLM:eq-${index}]]`);
  const heavy = {
    id: 'heavy',
    text: `where ${mathTokens.join(' and ')} define ${'variable '.repeat(300)}`,
    mathTokens,
  };
  const batches = createNodeTranslationBatches([
    { id: 'before', text: 'Introduction.' },
    heavy,
    { id: 'after', text: 'Conclusion.' },
  ], { firstMaxCost: 80, maxCost: 300 });

  assert.deepEqual(batches.flat().map((item) => item.id), ['before', 'heavy', 'after']);
  assert.equal(batches.find((batch) => batch.some((item) => item.id === 'heavy')).length, 1);
  assert.deepEqual(batches.flat().find((item) => item.id === 'heavy').mathTokens, mathTokens);
});

test('bounded batch runner continues after one batch fails and preserves result order', async () => {
  const batches = [[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }], [{ id: 'd' }]];
  let running = 0;
  let peak = 0;
  const results = await mapNodeTranslationBatches(batches, async (batch, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 8 : 1));
    running -= 1;
    if (index === 1) throw new Error('isolated failure');
    return batch[0].id;
  });

  assert.ok(peak <= NODE_TRANSLATION_BATCH_CONCURRENCY);
  assert.deepEqual(results.map((result) => result.status), [
    'fulfilled', 'rejected', 'fulfilled', 'fulfilled',
  ]);
  assert.deepEqual(results.map((result) => result.value || result.reason.message), [
    'a', 'isolated failure', 'c', 'd',
  ]);
});

test('bounded batch runner does not launch queued batches after page cancellation', async () => {
  const batches = [[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }], [{ id: 'd' }]];
  const started = [];
  let current = true;
  const results = await mapNodeTranslationBatches(batches, async (_batch, index) => {
    started.push(index);
    await Promise.resolve();
    if (index === 0) current = false;
    return index;
  }, { concurrency: 2, isCurrent: () => current });

  assert.deepEqual(started, [0, 1]);
  assert.equal(results[2], undefined);
  assert.equal(results[3], undefined);
});

test('formula placeholders must survive every reading-unit translation unchanged and in order', () => {
  const items = [{
    id: 'p5-b9',
    text: 'where [[PLM:p5-b9-m0]] is sampled from [[PLM:p5-b9-m1]].',
    mathTokens: ['[[PLM:p5-b9-m0]]', '[[PLM:p5-b9-m1]]'],
  }];
  const valid = inspectNodeTranslation({
    items,
    translatedText: JSON.stringify({
      id: 'p5-b9',
      text: '其中 [[PLM:p5-b9-m0]] 采样自 [[PLM:p5-b9-m1]]。',
    }),
    targetLang: '简体中文',
  });
  assert.equal(valid.ok, true);

  for (const text of [
    '其中 [[PLM:p5-b9-m0]] 采样自该分布。',
    '其中 [[PLM:p5-b9-m1]] 采样自 [[PLM:p5-b9-m0]]。',
    '其中 [[PLM:p5-b9-m0]] 采样自 [[PLM:p5-b9-m9]]。',
  ]) {
    const result = inspectNodeTranslation({
      items,
      translatedText: JSON.stringify({ id: 'p5-b9', text }),
      targetLang: '简体中文',
    });
    assert.deepEqual(result.unresolvedIds, ['p5-b9']);
    assert.ok(result.diagnostics.some((item) => item.code === 'math_placeholder_mismatch'));
  }
});

test('cache validation derives formula placeholders from serialized source units', () => {
  const source = serializeNodeTranslationRequest([{
    id: 'unit',
    text: 'Let [[PLM:eq-inline]] denote the preference vector.',
  }]);
  const valid = JSON.stringify({
    id: 'unit',
    text: '令 [[PLM:eq-inline]] 表示偏好向量。',
  });
  const damaged = JSON.stringify({
    id: 'unit',
    text: '令偏好向量表示该变量。',
  });
  assert.equal(isCacheableNodeTranslation(source, valid, '简体中文'), true);
  assert.equal(isCacheableNodeTranslation(source, damaged, '简体中文'), false);
});

test('one bad text node cannot roll back healthy siblings around inline math', () => {
  const items = [
    { id: 'slot-left', text: 'where ' },
    { id: 'slot-middle', text: ' is the decision variable and ' },
    { id: 'slot-right', text: ' is the decision space.' },
  ];
  const output = [
    { id: 'slot-right', text: ' 是决策空间。' },
    { id: 'slot-left', text: '其中' },
    { id: 'slot-middle', text: items[1].text },
  ].map(JSON.stringify).join('\n');

  const result = inspectNodeTranslation({ items, translatedText: output, targetLang: '简体中文' });
  assert.deepEqual(result.changes, [
    { id: 'slot-left', text: '其中' },
    { id: 'slot-right', text: ' 是决策空间。' },
  ]);
  assert.deepEqual(result.unresolvedIds, ['slot-middle']);
});

test('local retry sends and resolves only the failed node', async () => {
  const failed = { id: 'slot-middle', text: ' is the decision variable and ' };
  let requested;
  const changes = [];
  const result = await retryNodeItemsOnce({
    items: [failed],
    targetLang: '简体中文',
    request: (text) => {
      requested = text;
      return {
        id: 17,
        promise: Promise.resolve({
          full: JSON.stringify({ id: failed.id, text: ' 是决策变量，且 ' }),
        }),
      };
    },
    onChanges: (next) => changes.push(...next),
  });

  assert.deepEqual(parseNodeTranslationResponse(requested), [failed]);
  assert.deepEqual(result.unresolvedItems, []);
  assert.ok(changes.some((change) => change.id === failed.id));
});

test('formula-bearing retry translates prose slots and rebuilds immutable math locally', async () => {
  const mathTokens = [
    '[[PLM:p3-b0-m0]]',
    '[[PLM:p3-b0-m1]]',
    '[[PLM:p3-b0-m2]]',
  ];
  const item = {
    id: 'p3-b0-unit2',
    kind: 'reading_unit',
    text: `A point ${mathTokens[0]} is optimal if ${mathTokens[1]} ${mathTokens[2]} dominates the objective.`,
    mathTokens,
    textSlots: [
      [{ id: 'p3-b0-s0', text: 'A point ' }],
      [{ id: 'p3-b0-s1', text: ' is optimal if ' }],
      [{ id: 'p3-b0-s2', text: ' ' }],
      [{ id: 'p3-b0-s3', text: ' dominates the objective.' }],
    ],
  };
  const damaged = inspectNodeTranslation({
    items: [item],
    translatedText: JSON.stringify({
      id: item.id,
      text: `点 ${mathTokens[0]} 为最优点，且 ${mathTokens[2]} 支配目标。`,
    }),
    targetLang: '简体中文',
  });
  assert.deepEqual(damaged.unresolvedIds, [item.id]);
  assert.deepEqual(damaged.changes, []);

  let requested = [];
  const result = await retryNodeItemsOnce({
    items: [item],
    targetLang: '简体中文',
    request: (text) => {
      requested = parseNodeTranslationResponse(text);
      const full = requested.map((node, index) => JSON.stringify({
        id: node.id,
        text: `译文片段${index + 1}`,
      })).join('\n');
      return { id: 23, promise: Promise.resolve({ full }) };
    },
  });

  assert.deepEqual(requested.map((node) => node.id), [
    'p3-b0-s0',
    'p3-b0-s1',
    'p3-b0-s3',
  ]);
  assert.ok(requested.every((node) => !node.text.includes('[[PLM:')));
  assert.deepEqual(result.unresolvedItems, []);
  assert.deepEqual(result.changes.map((change) => change.id), [item.id]);
  assert.deepEqual(extractMathTokens(result.changes[0].text), mathTokens);
  assert.deepEqual(
    expandReadingTranslationChange(item, result.changes[0].text).map((change) => change.id),
    ['p3-b0-s0', 'p3-b0-s1', 'p3-b0-s2', 'p3-b0-s3'],
  );
});

test('slot retries flag the transport request while direct retries stay generic', async () => {
  const meta = [];
  const request = (text, onDelta, onPhase, requestMeta) => {
    meta.push(requestMeta);
    const full = parseNodeTranslationResponse(text)
      .map((node, index) => JSON.stringify({ id: node.id, text: `重译片段${index + 1}` }))
      .join('\n');
    return { id: 30 + meta.length, promise: Promise.resolve({ full }) };
  };

  const direct = await retryNodeItemsOnce({
    items: [{ id: 'plain-unit', text: 'This paragraph still needs a faithful translation.' }],
    targetLang: '简体中文',
    request,
  });
  assert.deepEqual(meta[0], { nodeSlotRetry: false });
  assert.deepEqual(direct.unresolvedItems, []);

  const mathTokens = ['[[PLM:m0]]'];
  const slotItem = {
    id: 'unit-with-math',
    kind: 'reading_unit',
    text: `where ${mathTokens[0]} denotes the preference vector.`,
    mathTokens,
    textSlots: [
      [{ id: 'seg-left', text: 'where ' }],
      [{ id: 'seg-right', text: ' denotes the preference vector.' }],
    ],
  };
  const slots = await retryNodeItemsOnce({
    items: [slotItem],
    targetLang: '简体中文',
    request,
  });
  assert.deepEqual(meta[1], { nodeSlotRetry: true });
  assert.deepEqual(slots.unresolvedItems, []);
  assert.deepEqual(extractMathTokens(slots.changes[0].text), mathTokens);
});

test('completed JSON arrays are accepted but missing and English nodes are not cacheable', () => {
  const items = [
    { id: 'a', text: 'This paragraph needs a faithful Chinese translation.' },
    { id: 'b', text: 'Another paragraph also needs a complete translation.' },
  ];
  const source = serializeNodeTranslationRequest(items);
  const valid = JSON.stringify([
    { id: 'b', text: '另一段也需要完整翻译。' },
    { id: 'a', text: '这一段需要忠实的中文翻译。' },
  ]);
  assert.equal(isCacheableNodeTranslation(source, valid, '简体中文'), true);
  assert.equal(isCacheableNodeTranslation(source, JSON.stringify([{ id: 'a', text: items[0].text }]), '简体中文'), false);
});

const pythonCandidates = [
  `${root}\\.tools\\python312\\python.exe`,
  `${root}\\server\\.venv\\Scripts\\python.exe`,
];
const python = pythonCandidates.find(existsSync);
const d4lFixture = `${root}\\tests\\fixtures\\D4L-user-20p.pdf`;
const legacyExtractorPath = `${root}\\server\\page_ir.py`;
const legacyExtractorAvailable = Boolean(
  python
  && existsSync(d4lFixture)
  && existsSync(legacyExtractorPath)
  && /def\s+extract_page_ir\s*\(/u.test(readFileSync(legacyExtractorPath, 'utf8'))
);

test('real D4L Page IR translation payload contains zero formula placeholders', {
  // Page IR extraction was intentionally removed in 0.9.6 when full-page
  // vision became the sole production path. Keep this regression fixture only
  // for old branches that still expose extract_page_ir.
  // "D4L" is the 20-page regression paper (arXiv 2010.04104); its PDF is not
  // distributed with the repo (copyright), so this test auto-skips when the
  // fixture, the local python runtime, or the legacy extractor is absent.
  skip: legacyExtractorAvailable ? false : 'legacy Page IR extractor removed in 0.9.6',
}, async () => {
  const script = [
    'import json, sys, fitz',
    'sys.path.insert(0, sys.argv[2])',
    'from server.page_ir import extract_page_ir',
    'doc = fitz.open(sys.argv[1])',
    'pages = [extract_page_ir(fitz, doc[i], i) for i in (2, 3)]',
    'doc.close()',
    'print(json.dumps(pages, ensure_ascii=True))',
  ].join('; ');
  const stdout = execFileSync(python, ['-c', script, d4lFixture, root], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const pages = JSON.parse(stdout.trim().split(/\r?\n/gu).at(-1));

  for (const page of pages) {
    const plan = createTextNodeTranslationPlan(page);
    const payload = serializeNodeTranslationRequest(plan.items);
    assert.ok(plan.items.length > 0);
    assert.doesNotMatch(payload, /\[\[PLM:|@@@BLK@@@/u);
    assert.ok(plan.items.every((item) => typeof item.id === 'string' && typeof item.text === 'string'));
  }

  const readingPlan = createReadingTranslationPlan(pages[1]);
  const readingBatches = createNodeTranslationBatches(readingPlan.items);
  const mathCounts = readingPlan.items.map((item) => item.mathTokens.length);
  const targetIds = readingPlan.items.flatMap((item) => (
    item.textSlots.flat().map((slot) => slot.id)
  ));
  assert.equal(Math.max(...mathCounts), MAX_READING_UNIT_MATH_TOKENS);
  assert.deepEqual(
    readingBatches.flat().map((item) => item.id),
    readingPlan.items.map((item) => item.id),
    'real Page IR batching must preserve every reading-unit ID in source order',
  );
  assert.ok(readingBatches[0].length <= 2);
  assert.equal(new Set(targetIds).size, targetIds.length);
  assert.deepEqual(
    readingPlan.items.filter((item) => item.id.startsWith('p3-b0')).map((item) => item.id),
    ['p3-b0-unit0', 'p3-b0-unit1', 'p3-b0-unit2', 'p3-b0-unit3'],
  );

  const denseBlock = pages[1].blocks.find((block) => block.id === 'p3-b0');
  const denseItems = readingPlan.items.filter((item) => item.id.startsWith('p3-b0-unit'));
  assert.deepEqual(denseItems.map((item) => item.mathTokens.length), [7, 7, 3, 2]);
  assert.match(denseItems[2].text, /^\.\s*A point\b/u);
  assert.match(denseItems[3].text, /^\s*such that\b/u);
  let recoveryPayload = [];
  const recovery = await retryNodeItemsOnce({
    items: denseItems,
    targetLang: '简体中文',
    request: (text) => {
      recoveryPayload = parseNodeTranslationResponse(text);
      const full = recoveryPayload.map((node, index) => JSON.stringify({
        id: node.id,
        text: `译文片段${index + 1}`,
      })).join('\n');
      return { id: 91, promise: Promise.resolve({ full }) };
    },
  });
  assert.ok(recoveryPayload.length > denseItems.length);
  assert.ok(recoveryPayload.every((node) => !node.text.includes('[[PLM:')));
  assert.deepEqual(recovery.unresolvedItems, []);

  const itemsById = new Map(denseItems.map((item) => [item.id, item]));
  const recoveredTextIds = recovery.changes.flatMap((change) => (
    expandReadingTranslationChange(itemsById.get(change.id), change.text)
      .map((expanded) => expanded.id)
  ));
  const sourceTextIds = denseBlock.segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.id);
  assert.deepEqual(recoveredTextIds, sourceTextIds);
  assert.equal(new Set(recoveredTextIds).size, recoveredTextIds.length);

  const pendingNodes = new Map(sourceTextIds.map((id) => {
    const classes = new Set(['structured-text-pending']);
    const attributes = new Set(['aria-label']);
    return [id, {
      textContent: '',
      classList: { remove: (...names) => names.forEach((name) => classes.delete(name)) },
      removeAttribute: (name) => attributes.delete(name),
      classes,
      attributes,
    }];
  }));
  for (const change of recovery.changes) {
    for (const expanded of expandReadingTranslationChange(itemsById.get(change.id), change.text)) {
      assert.equal(updateStructuredTextNode(pendingNodes, expanded.id, expanded.text), true);
    }
  }
  for (const node of pendingNodes.values()) {
    assert.equal(node.classes.has('structured-text-pending'), false);
    assert.equal(node.attributes.has('aria-label'), false);
  }
});
