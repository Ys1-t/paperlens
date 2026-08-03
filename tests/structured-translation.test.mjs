import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_READING_TABLE_CELLS,
  MAX_READING_UNIT_MATH_TOKENS,
  STRUCTURED_TABLE_CONFIDENCE,
  buildTableModel,
  chooseStructuredTranslation,
  createReadingTranslationPlan,
  createStructuredTranslationAccumulator,
  createStructuredTranslationPlan,
  expandReadingTranslationChange,
  isTrustedReadingTable,
  looksLikeAuthorLine,
  shouldTranslateTableCell,
  updateStructuredTextNode,
} from '../src/lib/structured-translation.js';

function pageWith(blocks) {
  return {
    index: 10,
    width: 595,
    height: 842,
    images: {},
    blocks,
  };
}

test('structured translation collects captions, headers, prose, and coherent algorithm text only', () => {
  const source = pageWith([
    { id: 'p10-h0', kind: 'heading', text: 'Experiments', bbox: [0, 0, 1, 0.05] },
    {
      id: 'p10-b0',
      kind: 'paragraph',
      text: 'The method converges for x.',
      segments: [
        { id: 'p10-b0-s0', kind: 'text', text: 'The method converges for ' },
        { id: 'p10-b0-m0', kind: 'inline_math', latex: 'x' },
        { id: 'p10-b0-s1', kind: 'text', text: '.' },
      ],
    },
    { id: 'p10-cap0', kind: 'caption', text: 'Figure overview' },
    {
      id: 'p10-alg0',
      kind: 'plain_text',
      text: 'Algorithm 1\n1: Initialize the population\n2: Return the best solution',
    },
    { id: 'p10-eq0', kind: 'display_math', latex: 'x^2', number: '(4)' },
    {
      id: 'p10-t0',
      kind: 'table',
      columns: 4,
      header_rows: 1,
      caption: { id: 'p10-t0-caption', text: 'TABLE III. Median results', alignment: 'center' },
      rows: [[
        { id: 'p10-t0-r0-c0', text: 'Problem', role: 'header' },
        { id: 'p10-t0-r0-c1', text: 'HV', role: 'header' },
        { id: 'p10-t0-r0-c2', text: '0.91', role: 'header' },
        { id: 'p10-t0-r0-c3', text: '', role: 'header' },
      ], [
        { id: 'p10-t0-r1-c0', text: 'Proposed method' },
        { id: 'p10-t0-r1-c1', text: '0.91 ± 0.02' },
        { id: 'p10-t0-r1-c2', text: 'x^2', kind: 'formula' },
        { id: 'p10-t0-r1-c3', text: '42%' },
      ]],
    },
  ]);

  const plan = createStructuredTranslationPlan(source);

  assert.deepEqual(plan.items, [
    { id: 'p10-h0', text: 'Experiments' },
    {
      id: 'p10-b0',
      kind: 'math_paragraph',
      text: 'The method converges for [[PLM:p10-b0-m0]].',
      mathTokens: ['[[PLM:p10-b0-m0]]'],
      textSlots: [
        [{ id: 'p10-b0-s0', text: 'The method converges for ' }],
        [{ id: 'p10-b0-s1', text: '.' }],
      ],
    },
    { id: 'p10-cap0', text: 'Figure overview' },
    {
      id: 'p10-alg0',
      text: 'Algorithm 1\n1: Initialize the population\n2: Return the best solution',
    },
    { id: 'p10-t0-caption', text: 'TABLE III. Median results' },
    { id: 'p10-t0-r0-c0', text: 'Problem' },
    { id: 'p10-t0-r0-c1', text: 'HV' },
    { id: 'p10-t0-r1-c0', text: 'Proposed method' },
  ]);
  assert.equal(plan.page.blocks[3].kind, 'plain_text');
  assert.equal(source.blocks[3].text.includes('Return the best solution'), true);
});

test('table model preserves all seven columns, including middle and trailing empty cells', () => {
  const model = buildTableModel({
    id: 'p10-t0',
    kind: 'table',
    columns: 7,
    header_rows: 1,
    confidence: 0.96,
    caption: {
      id: 'p10-t0-caption',
      text: 'TABLE IV. Ablation results',
      position: 'above',
      alignment: 'center',
    },
    rows: [[
      { id: 'p10-t0-r0-c0', text: 'Method', role: 'header' },
      { id: 'p10-t0-r0-c1', text: 'A', role: 'header' },
      { id: 'p10-t0-r0-c2', text: '', role: 'header' },
      { id: 'p10-t0-r0-c3', text: 'C', role: 'header' },
      { id: 'p10-t0-r0-c4', text: '', role: 'header' },
      { id: 'p10-t0-r0-c5', text: 'E', role: 'header' },
      { id: 'p10-t0-r0-c6', text: '', role: 'header' },
    ], [
      { id: 'p10-t0-r1-c0', text: 'Ours' },
      { id: 'p10-t0-r1-c1', text: '1.0' },
    ]],
  });

  assert.equal(model.columns, 7);
  assert.equal(model.headerRows.length, 1);
  assert.equal(model.bodyRows.length, 1);
  assert.deepEqual(model.headerRows[0].map((cell) => cell.text), ['Method', 'A', '', 'C', '', 'E', '']);
  assert.deepEqual(model.bodyRows[0].map((cell) => cell.text), ['Ours', '1.0', '', '', '', '', '']);
  assert.equal(model.bodyRows[0][1].numeric, true);
  assert.equal(model.caption.alignment, 'center');
  assert.equal(model.sourceReference, null);
});

test('scientific result cells with parenthesized deviation stay numeric instead of math', () => {
  const model = buildTableModel({
    id: 'p0-t-metrics',
    kind: 'table',
    bbox: [0, 0, 1, 1],
    columns: 3,
    header_rows: 1,
    confidence: 0.95,
    rows: [
      [
        { id: 'h0', text: 'Problem', role: 'header' },
        { id: 'h1', text: 'EPSL', role: 'header' },
        { id: 'h2', text: 'MTPSL', role: 'header' },
      ],
      [
        { id: 'r0', text: 'DTLZ1', role: 'row_header' },
        { id: 'd0', text: '5.87E-2(4.81E-3)≈', role: 'data' },
        { id: 'd1', text: '3.87E-2(4.98E-3)+', role: 'data' },
      ],
    ],
  });

  assert.equal(model.bodyRows[0][1].numeric, true);
  assert.equal(model.bodyRows[0][2].numeric, true);
});

test('table model selects multiple header rows before tbody', () => {
  const model = buildTableModel({
    id: 'p10-t1',
    kind: 'table',
    columns: 2,
    header_rows: 2,
    rows: [
      [{ text: 'Metric' }, { text: 'Score' }],
      [{ text: 'Dataset' }, { text: 'Mean' }],
      [{ text: 'MOKP' }, { text: '0.98' }],
    ],
  });

  assert.equal(model.headerRows.length, 2);
  assert.equal(model.bodyRows.length, 1);
  assert.equal(model.bodyRows[0][0].text, 'MOKP');
});

test('low-confidence table keeps its caption but falls back to a source reference', () => {
  const model = buildTableModel({
    id: 'p10-t2',
    kind: 'table',
    confidence: STRUCTURED_TABLE_CONFIDENCE - 0.01,
    columns: 2,
    caption: { id: 'p10-t2-caption', text: 'TABLE V. Difficult layout', alignment: 'left' },
    rows: [[{ text: 'Method' }, { text: 'Score' }]],
  });

  assert.deepEqual(model.sourceReference, {
    label: '查看左侧原表',
    bbox: [0, 0, 0, 0],
  });
  assert.equal(model.caption.text, 'TABLE V. Difficult layout');
  assert.equal(model.caption.alignment, 'left');
});

test('low-confidence table translates its caption without sending hidden cells', () => {
  const plan = createStructuredTranslationPlan(pageWith([{
    id: 'p10-t3',
    kind: 'table',
    confidence: STRUCTURED_TABLE_CONFIDENCE - 0.01,
    columns: 2,
    caption: { id: 'p10-t3-caption', text: 'TABLE VI. Source fallback' },
    rows: [[
      { id: 'p10-t3-r0-c0', text: 'Method', role: 'header' },
      { id: 'p10-t3-r0-c1', text: 'Description', role: 'header' },
    ]],
  }]));

  assert.deepEqual(plan.items, [
    { id: 'p10-t3-caption', text: 'TABLE VI. Source fallback' },
  ]);
});

test('reading table trust requires learned provenance, high confidence, and a bounded dense shape', () => {
  const trusted = {
    id: 'p10-t-trusted',
    kind: 'table',
    detector: 'pymupdf-layout',
    confidence: 0.94,
    columns: 3,
    rows: [
      [{ text: 'Method' }, { text: 'HV' }, { text: 'Score' }],
      [{ text: 'Ours' }, { text: '0.91' }, { text: 'Best' }],
    ],
  };

  assert.equal(isTrustedReadingTable(trusted), true);
  assert.equal(isTrustedReadingTable({ ...trusted, detector: 'pymupdf-ruled-text' }), true);
  assert.equal(isTrustedReadingTable({ ...trusted, detector: 'pymupdf-text' }), false);
  assert.equal(isTrustedReadingTable({ ...trusted, confidence: 0.89 }), false);
  assert.equal(isTrustedReadingTable({
    ...trusted,
    columns: (MAX_READING_TABLE_CELLS / 2) + 1,
    rows: [[{ text: 'Method' }], [{ text: 'Ours' }]],
  }), false);
});

test('tables only translate the caption — grid cells never enter the reading plan', () => {
  const plan = createReadingTranslationPlan(pageWith([{
    id: 'p10-t-readable',
    kind: 'table',
    detector: 'pymupdf-layout',
    confidence: 0.96,
    columns: 4,
    header_rows: 1,
    caption: { id: 'p10-t-readable-caption', text: 'TABLE VII. Main results' },
    rows: [[
      { id: 'h-method', text: 'Method', role: 'header' },
      { id: 'h-hv', text: 'HV', role: 'header' },
      { id: 'h-score', text: 'Score', role: 'header' },
      { id: 'h-algorithm', text: 'NSGA-II', role: 'header' },
    ], [
      { id: 'r-method', text: 'Proposed method', role: 'row_header' },
      { id: 'r-value', text: '0.91', role: 'data' },
      { id: 'r-formula', text: 'x^2', kind: 'formula', role: 'data' },
      { id: 'r-dataset', text: 'DTLZ1', role: 'data' },
    ]],
  }]));

  // Product rule: scientific tables stay on the PDF side (like figures).
  assert.deepEqual(plan.items.map((item) => item.id), [
    'p10-t-readable-caption',
  ]);
  assert.equal(shouldTranslateTableCell({ text: 'Mean', role: 'header' }), false);
  assert.equal(shouldTranslateTableCell({ text: 'ImageNet', role: 'row_header' }), false);
  assert.equal(shouldTranslateTableCell({ text: '1.23 (0.04)', role: 'row_header' }), false);
});

test('author lines are detected and never enter the reading translation plan', () => {
  assert.equal(looksLikeAuthorLine('Weiyu Chen 1 James T. Kwok 1'), true);
  assert.equal(looksLikeAuthorLine('Weiyu Chen¹, James T. Kwok²'), true);
  assert.equal(looksLikeAuthorLine('Department of Computer Science, HKUST'), false);
  assert.equal(
    looksLikeAuthorLine('The method converges for multiple objectives.'),
    false,
  );

  const plan = createReadingTranslationPlan(pageWith([
    {
      id: 'p0-title',
      kind: 'heading',
      text: 'Efficient Pareto Manifold Learning with Low-Rank Structure',
    },
    {
      id: 'p0-authors',
      kind: 'paragraph',
      role: 'author',
      content_role: 'author',
      translatable: false,
      text: 'Weiyu Chen 1 James T. Kwok 1',
      segments: [{ id: 'p0-authors-s0', kind: 'text', text: 'Weiyu Chen 1 James T. Kwok 1' }],
    },
    {
      id: 'p0-authors-text-only',
      kind: 'paragraph',
      text: 'Alice Smith and Bob Jones 2',
      segments: [{ id: 'p0-authors-text-only-s0', kind: 'text', text: 'Alice Smith and Bob Jones 2' }],
    },
    {
      id: 'p0-body',
      kind: 'paragraph',
      text: 'We study multi-objective optimization with preference vectors.',
      segments: [{
        id: 'p0-body-s0',
        kind: 'text',
        text: 'We study multi-objective optimization with preference vectors.',
      }],
    },
  ]));

  assert.deepEqual(plan.items.map((item) => item.id).sort(), [
    'p0-body',
    'p0-title',
  ].sort());
  assert.ok(!plan.items.some((item) => /author/i.test(item.id) || /Chen|Smith/.test(item.text)));
});

test('reading plan emits coherent paragraphs, merges citation continuations, and skips page numbers', () => {
  const plan = createReadingTranslationPlan(pageWith([
    { id: 'p10-page', kind: 'paragraph', text: '10', segments: [{ id: 'p10-page-s0', kind: 'text', text: '10' }] },
    {
      id: 'p10-b0',
      kind: 'paragraph',
      text: 'The method follows prior work [30],',
      segments: [{ id: 'p10-b0-s0', kind: 'text', text: 'The method follows prior work [30],' }],
    },
    {
      id: 'p10-b1',
      kind: 'paragraph',
      text: '[31].',
      segments: [{ id: 'p10-b1-s0', kind: 'text', text: '[31].' }],
    },
    {
      id: 'p10-t0',
      kind: 'table',
      columns: 2,
      header_rows: 1,
      caption: { id: 'p10-t0-caption', text: 'TABLE I. Results' },
      rows: [[
        { id: 'p10-t0-r0-c0', text: 'Method' },
        { id: 'p10-t0-r0-c1', text: 'Score' },
      ]],
    },
  ]));

  assert.deepEqual(plan.items.map((item) => item.id), ['p10-b0', 'p10-t0-caption']);
  assert.equal(plan.items[0].text, 'The method follows prior work [30], [31].');
  assert.deepEqual(plan.items[0].textSlots[0].map((slot) => slot.id), [
    'p10-b0-s0',
    'p10-b1-s0',
  ]);
  assert.equal(plan.items.some((item) => item.id.startsWith('p10-t0-r')), false);
});

test('reading plan translates a preserved figure caption without sending the image', () => {
  const plan = createReadingTranslationPlan(pageWith([{
    id: 'p10-f0',
    kind: 'figure',
    bbox: [0.1, 0.2, 0.5, 0.6],
    image_ref: 'p10-f0.png',
    caption: {
      id: 'p10-f0-caption',
      text: 'Fig. 4. Convergence comparison.',
      position: 'below',
      alignment: 'center',
    },
  }]));

  assert.deepEqual(plan.items.map(({ id, text }) => ({ id, text })), [{
    id: 'p10-f0-caption',
    text: 'Fig. 4. Convergence comparison.',
  }]);
});

test('reading translation expands around immutable inline-math DOM slots', () => {
  const plan = createReadingTranslationPlan(pageWith([{
    id: 'p10-b0',
    kind: 'paragraph',
    text: 'Let x be feasible.',
    segments: [
      { id: 'p10-b0-s0', kind: 'text', text: 'Let ' },
      { id: 'p10-b0-m0', kind: 'inline_math', latex: 'x' },
      { id: 'p10-b0-s1', kind: 'text', text: ' be feasible.' },
    ],
  }]));
  const item = plan.items[0];

  assert.deepEqual(expandReadingTranslationChange(
    item,
    '令[[PLM:p10-b0-m0]]为可行解。',
  ), [
    { id: 'p10-b0-s0', text: '令' },
    { id: 'p10-b0-s1', text: '为可行解。' },
  ]);
  assert.throws(() => expandReadingTranslationChange(item, '令 x 为可行解。'));
});

test('math-dense paragraphs stream as bounded reading units without duplicating text slots', () => {
  const segments = [];
  for (let index = 0; index < 16; index += 1) {
    segments.push({
      id: `p10-dense-s${index}`,
      kind: 'text',
      text: index === 0 ? 'Let ' : ` and term ${index} `,
    });
    segments.push({
      id: `p10-dense-m${index}`,
      kind: 'inline_math',
      latex: `x_${index}`,
    });
  }
  segments.push({ id: 'p10-dense-tail', kind: 'text', text: ' be feasible.' });

  const plan = createReadingTranslationPlan(pageWith([{
    id: 'p10-dense',
    kind: 'paragraph',
    text: 'A formula-dense paragraph.',
    segments,
  }]));

  assert.deepEqual(plan.items.map((item) => item.id), [
    'p10-dense-unit0',
    'p10-dense-unit1',
    'p10-dense-unit2',
  ]);
  assert.deepEqual(plan.items.map((item) => item.mathTokens.length), [7, 7, 2]);
  assert.ok(plan.items.every(
    (item) => item.mathTokens.length <= MAX_READING_UNIT_MATH_TOKENS,
  ));

  const targetIds = plan.items.flatMap((item) => (
    expandReadingTranslationChange(item, item.text).map((change) => change.id)
  ));
  const expectedTextIds = segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.id);
  assert.deepEqual(targetIds, expectedTextIds);
  assert.equal(new Set(targetIds).size, targetIds.length);
});

test('formula-only inline clusters remain local and never create translation work', () => {
  const plan = createReadingTranslationPlan(pageWith([{
    id: 'p10-formula-only',
    kind: 'paragraph',
    text: 'x y',
    segments: [
      { id: 'p10-formula-only-m0', kind: 'inline_math', latex: 'x' },
      { id: 'p10-formula-only-s0', kind: 'text', text: ' ' },
      { id: 'p10-formula-only-m1', kind: 'inline_math', latex: 'y' },
    ],
  }]));

  assert.deepEqual(plan.items, []);
});

test('translation updates only the mapped text node', () => {
  const first = { textContent: 'First source' };
  const second = { textContent: 'Second source' };
  const nodes = new Map([['first', first], ['second', second]]);

  assert.equal(updateStructuredTextNode(nodes, 'second', '第二段'), true);
  assert.equal(first.textContent, 'First source');
  assert.equal(second.textContent, '第二段');
  assert.equal(updateStructuredTextNode(nodes, 'missing', 'ignored'), false);
});

test('translated text keeps meaningful boundary whitespace and empty output keeps source', () => {
  assert.equal(chooseStructuredTranslation('source ', '译文 '), '译文 ');
  assert.equal(chooseStructuredTranslation(' source', ' 译文'), ' 译文');
  assert.equal(chooseStructuredTranslation('source ', '   '), 'source ');
});

test('incremental translation accumulator reports changed items only', () => {
  const accumulator = createStructuredTranslationAccumulator([
    { id: 'first', text: 'First source' },
    { id: 'second', text: 'Second source' },
  ]);

  assert.deepEqual(accumulator.push('第一段'), [
    { id: 'first', text: '第一段' },
  ]);
  assert.deepEqual(accumulator.push(''), []);
  assert.deepEqual(accumulator.push('\n\n@@@BLK@@@\n\n'), []);
  assert.deepEqual(accumulator.push('第二段'), [
    { id: 'second', text: '第二段' },
  ]);
  assert.deepEqual(accumulator.finish('第一段\n\n@@@BLK@@@\n\n第二段'), []);
});

test('incremental accumulator holds a split separator instead of leaking it into visible text', () => {
  const accumulator = createStructuredTranslationAccumulator([
    { id: 'first', text: 'First source' },
    { id: 'second', text: 'Second source' },
  ]);

  assert.deepEqual(accumulator.push('第一段\n\n@@@BL'), [
    { id: 'first', text: '第一段' },
  ]);
  assert.equal(accumulator.value('first').includes('@@@'), false);
  assert.deepEqual(accumulator.push('K@@@\n\n第二段'), [
    { id: 'second', text: '第二段' },
  ]);
});

test('CRLF separators are removed in streaming and final output', () => {
  const accumulator = createStructuredTranslationAccumulator([
    { id: 'first', text: 'First source' },
    { id: 'second', text: 'Second source' },
  ]);
  accumulator.push('第一段\r\n@@@BLK@@@\r');
  accumulator.push('\n第二段');
  accumulator.finish('第一段\r\n@@@BLK@@@\r\n第二段');
  assert.equal(accumulator.value('first'), '第一段');
  assert.equal(accumulator.value('second'), '第二段');
});

test('extra separators in the last item never leak the marker token', () => {
  const accumulator = createStructuredTranslationAccumulator([
    { id: 'first', text: 'First source' },
    { id: 'second', text: 'Second source' },
  ]);
  accumulator.push('A\n@@@BLK@@@\nB\n@@@B');
  accumulator.push('LK@@@\nC');
  accumulator.finish();
  assert.equal(accumulator.value('second').includes('@@@BLK@@@'), false);
  assert.equal(accumulator.value('second'), 'B\n\nC');
});

test('fine-grained streaming does not rebuild the full item on every character', () => {
  const accumulator = createStructuredTranslationAccumulator([{ id: 'one', text: 'source' }]);
  let updates = 0;
  for (let index = 0; index < 10000; index += 1) updates += accumulator.push('x').length;
  assert.ok(updates < 30, `expected batched accumulator updates, got ${updates}`);
  assert.equal(accumulator.raw.length, 10000);
});

test('final accumulator output falls back per item and preserves boundary whitespace', () => {
  const accumulator = createStructuredTranslationAccumulator([
    { id: 'first', text: 'First source ' },
    { id: 'second', text: ' Second source' },
  ]);

  assert.deepEqual(accumulator.finish('第一段 \n\n@@@BLK@@@\n\n   '), [
    { id: 'first', text: '第一段 ' },
  ]);
  assert.equal(accumulator.value('second'), ' Second source');
});
