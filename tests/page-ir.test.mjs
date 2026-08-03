import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_IR_LIMITS,
  PageIrLimitError,
  collectTranslatableItems,
  normalizePageIr,
} from '../src/lib/page-ir.js';

function basePage(blocks) {
  return {
    index: 3,
    width: 595,
    height: 842,
    blocks,
    images: {},
  };
}

test('normalizePageIr rejects duplicate IDs across nested IR nodes', () => {
  assert.throws(() => normalizePageIr(basePage([
    {
      id: 'p3-b0',
      kind: 'paragraph',
      bbox: [0.1, 0.1, 0.8, 0.2],
      segments: [{ id: 'shared', kind: 'text', text: 'First' }],
    },
    {
      id: 'p3-t0',
      kind: 'table',
      bbox: [0.1, 0.3, 0.9, 0.7],
      columns: 1,
      rows: [[{ id: 'shared', text: 'Method', role: 'header' }]],
    },
  ])), /duplicate IR id: shared/i);
});

test('unknown block kinds degrade to plain_text without dropping source text', () => {
  const source = basePage([{
    id: 'p3-future0',
    kind: 'future_block',
    text: 'Keep this future content',
    bbox: [0.2, 0.3, 0.4, 0.5],
  }]);

  const page = normalizePageIr(source);

  assert.equal(page.blocks[0].kind, 'plain_text');
  assert.equal(page.blocks[0].text, 'Keep this future content');
  assert.deepEqual(page.blocks[0].bbox, [0.2, 0.3, 0.4, 0.5]);
  assert.equal(source.blocks[0].kind, 'future_block');
});

test('invalid bboxes and table rows receive deterministic empty fallbacks', () => {
  const page = normalizePageIr(basePage([
    { id: 'p3-b0', kind: 'plain_text', text: 'Text', bbox: [0.1, Number.NaN] },
    { id: 'p3-t0', kind: 'table', bbox: null, columns: 4, rows: 'not-an-array' },
  ]));

  assert.deepEqual(page.blocks[0].bbox, [0, 0, 0, 0]);
  assert.deepEqual(page.blocks[1].bbox, [0, 0, 0, 0]);
  assert.deepEqual(page.blocks[1].rows, []);
  assert.equal(page.blocks[1].columns, 4);
});

test('paragraph fragment boxes and figure captions survive normalization', () => {
  const page = normalizePageIr(basePage([
    {
      id: 'p3-b0', kind: 'paragraph', bbox: [0.1, 0.1, 0.9, 0.4],
      segments: [{
        id: 'p3-b0-s0', kind: 'text', text: 'Wrapped text',
        bbox: [0.1, 0.1, 0.9, 0.4],
        bboxes: [[0.1, 0.1, 0.4, 0.14], [0.6, 0.36, 0.9, 0.4], ['bad']],
      }],
    },
    {
      id: 'p3-f0', kind: 'figure', bbox: [0.1, 0.5, 0.5, 0.8], image_ref: 'p3-f0.png',
      caption: { id: 'p3-f0-caption', text: 'Fig. 1. Result.', position: 'below' },
    },
  ]));

  assert.deepEqual(page.blocks[0].segments[0].bboxes, [
    [0.1, 0.1, 0.4, 0.14],
    [0.6, 0.36, 0.9, 0.4],
  ]);
  assert.equal(page.blocks[1].caption.text, 'Fig. 1. Result.');
  assert.deepEqual(
    collectTranslatableItems(page).map(({ id }) => id),
    ['p3-b0-s0', 'p3-f0-caption'],
  );
});

test('table normalization never drops cells beyond the explicit column count', () => {
  const page = normalizePageIr(basePage([{
    id: 'p3-t0',
    kind: 'table',
    columns: 1,
    rows: [[
      { id: 'p3-t0-r0-c0', text: 'A' },
      { id: 'p3-t0-r0-c1', text: 'B' },
      { id: 'p3-t0-r0-c2', text: 'C' },
    ]],
  }]));

  assert.equal(page.blocks[0].columns, 3);
  assert.deepEqual(page.blocks[0].rows[0].map((cell) => cell.text), ['A', 'B', 'C']);
});

test('table normalization preserves row_header semantics', () => {
  const page = normalizePageIr({
    index: 0, width: 595, height: 842, blocks: [{
      id: 'p0-t0', kind: 'table', columns: 2, header_rows: 1,
      rows: [
        [{ id: 'h0', text: 'Problem', role: 'header' }, { id: 'h1', text: 'HV', role: 'header' }],
        [{ id: 'r0', text: 'DTLZ2', role: 'row_header' }, { id: 'd0', text: '0.92', role: 'data' }],
      ],
    }],
  });
  assert.equal(page.blocks[0].rows[1][0].role, 'row_header');
});

test('duplicate validation includes cells beyond the explicit column count', () => {
  assert.throws(() => normalizePageIr(basePage([
    {
      id: 'p3-t0',
      kind: 'table',
      columns: 1,
      rows: [[
        { id: 'p3-t0-r0-c0', text: 'A' },
        { id: 'shared-extra', text: 'B' },
      ]],
    },
    { id: 'shared-extra', kind: 'plain_text', text: 'Duplicate' },
  ])), /duplicate IR id: shared-extra/i);
});

test('oversized page IR arrays reject with PageIrLimitError before allocation work', () => {
  const oversizedBlocks = basePage(new Array(PAGE_IR_LIMITS.blocks + 1));
  assert.throws(() => normalizePageIr(oversizedBlocks), PageIrLimitError);

  const oversizedSegments = basePage([{
    id: 'p3-b0',
    kind: 'paragraph',
    segments: new Array(PAGE_IR_LIMITS.segmentsPerBlock + 1),
  }]);
  assert.throws(() => normalizePageIr(oversizedSegments), PageIrLimitError);

  const oversizedRows = basePage([{
    id: 'p3-t0',
    kind: 'table',
    rows: new Array(PAGE_IR_LIMITS.tableRows + 1),
  }]);
  assert.throws(() => normalizePageIr(oversizedRows), PageIrLimitError);

  const oversizedColumns = basePage([{
    id: 'p3-t0',
    kind: 'table',
    columns: PAGE_IR_LIMITS.tableColumns + 1,
    rows: [],
  }]);
  assert.throws(() => normalizePageIr(oversizedColumns), PageIrLimitError);

  const rowsForTooManyCells = Math.floor(
    PAGE_IR_LIMITS.tableCells / PAGE_IR_LIMITS.tableColumns,
  ) + 1;
  const oversizedCells = basePage([{
    id: 'p3-t0',
    kind: 'table',
    columns: PAGE_IR_LIMITS.tableColumns,
    rows: Array.from({ length: rowsForTooManyCells }, () => []),
  }]);
  assert.throws(() => normalizePageIr(oversizedCells), PageIrLimitError);
});

test('aggregate table cell budget applies across individually valid tables', () => {
  const rowsPerTable = 101;
  const columns = 100;
  const table = (id) => ({
    id,
    kind: 'table',
    columns,
    rows: Array.from({ length: rowsPerTable }, () => []),
  });

  assert.ok(rowsPerTable * columns < PAGE_IR_LIMITS.totalTableCells);
  assert.throws(
    () => normalizePageIr(basePage([table('p3-t0'), table('p3-t1')])),
    PageIrLimitError,
  );
});

test('aggregate normalized node budget applies across individually valid blocks', () => {
  const segmentCount = 500;
  const blockCount = Math.floor(PAGE_IR_LIMITS.totalNodes / (segmentCount + 1)) + 1;
  const blocks = Array.from({ length: blockCount }, (_, blockIndex) => ({
    id: `p3-b${blockIndex}`,
    kind: 'paragraph',
    segments: Array.from({ length: segmentCount }, () => ({ kind: 'text', text: '' })),
  }));

  assert.ok(segmentCount < PAGE_IR_LIMITS.segmentsPerBlock);
  assert.ok(blockCount < PAGE_IR_LIMITS.blocks);
  assert.throws(() => normalizePageIr(basePage(blocks)), PageIrLimitError);
});

test('aggregate text character budget applies across individually valid blocks', () => {
  const text = 'x'.repeat(1024 * 1024);
  const blockCount = Math.floor(PAGE_IR_LIMITS.textChars / text.length) + 1;
  const blocks = Array.from({ length: blockCount }, (_, blockIndex) => ({
    id: `p3-b${blockIndex}`,
    kind: 'plain_text',
    text,
  }));

  assert.ok(text.length < PAGE_IR_LIMITS.textChars);
  assert.ok(blockCount < PAGE_IR_LIMITS.blocks);
  assert.throws(() => normalizePageIr(basePage(blocks)), PageIrLimitError);
});

test('sparse blocks, segments, and rows are densified without undefined nodes', () => {
  const segments = [];
  segments[1] = { id: 'p3-b0-s0', kind: 'text', text: 'Dense segment' };
  const rows = [];
  rows[2] = [{ id: 'p3-t0-r0-c0', text: 'Method' }];
  const blocks = [];
  blocks[1] = { id: 'p3-b0', kind: 'paragraph', text: 'Paragraph', segments };
  blocks[3] = { id: 'p3-t0', kind: 'table', columns: 1, rows };

  const page = normalizePageIr(basePage(blocks));

  assert.equal(page.blocks.length, 2);
  assert.equal(page.blocks[0].segments.length, 1);
  assert.equal(page.blocks[1].rows.length, 1);
  assert.deepEqual(collectTranslatableItems(page), [
    { id: 'p3-b0-s0', text: 'Dense segment' },
    { id: 'p3-t0-r0-c0', text: 'Method' },
  ]);
});

test('paragraph with empty segments falls back to one text segment', () => {
  const page = normalizePageIr(basePage([{
    id: 'p3-b0',
    kind: 'paragraph',
    text: 'Fallback paragraph text',
    segments: [],
  }]));

  assert.deepEqual(page.blocks[0].segments, [{
    id: 'p3-b0-s0',
    kind: 'text',
    text: 'Fallback paragraph text',
  }]);
  assert.deepEqual(collectTranslatableItems(page), [
    { id: 'p3-b0-s0', text: 'Fallback paragraph text' },
  ]);
});

test('collectTranslatableItems keeps prose, captions, and textual cells only', () => {
  const page = normalizePageIr(basePage([
    {
      id: 'p3-b0',
      kind: 'paragraph',
      bbox: [0, 0, 1, 0.2],
      segments: [
        { id: 'p3-b0-s0', kind: 'text', text: 'On the other hand, ' },
        { id: 'p3-b0-m0', kind: 'inline_math', latex: 'x^u' },
        { id: 'p3-b0-s1', kind: 'text', text: 'the method converges.' },
      ],
    },
    {
      id: 'p3-eq0',
      kind: 'display_math',
      bbox: [0, 0.2, 1, 0.3],
      latex: 'x(\\lambda)=h_\\theta(\\lambda)',
      number: '(2)',
    },
    {
      id: 'p3-t0',
      kind: 'table',
      bbox: [0, 0.3, 1, 0.8],
      columns: 4,
      caption: {
        id: 'p3-t0-caption',
        text: 'TABLE I. Median results',
        position: 'above',
        alignment: 'center',
      },
      rows: [[
        { id: 'p3-t0-r0-c0', text: 'Problem', role: 'header' },
        { id: 'p3-t0-r0-c1', text: '0.91 ± 0.02', role: 'data' },
        { id: 'p3-t0-r0-c2', text: '42%', role: 'data' },
        { id: 'p3-t0-r0-c3', text: 'Best', role: 'data' },
      ], [
        { id: 'p3-t0-r1-c0', text: 'x^2', role: 'data' },
        { id: 'p3-t0-r1-c1', text: 'α + β', role: 'data' },
        { id: 'p3-t0-r1-c2', text: '10 ms', role: 'data' },
        { id: 'p3-t0-r1-c3', text: 'Proposed method', role: 'data' },
      ], [
        { id: 'p3-t0-r2-c0', text: 'Accuracy <= baseline after tuning', role: 'data' },
        { id: 'p3-t0-r2-c1', text: 'The score x^2 improves', role: 'data' },
        { id: 'p3-t0-r2-c2', text: '-', role: 'data' },
        { id: 'p3-t0-r2-c3', text: '42', role: 'data' },
      ], [
        { id: 'p3-t0-r3-c0', text: 'Accuracy <= 1', role: 'data' },
        { id: 'p3-t0-r3-c1', text: '', role: 'data' },
        { id: 'p3-t0-r3-c2', text: '', role: 'data' },
        { id: 'p3-t0-r3-c3', text: '', role: 'data' },
      ], [
        { id: 'p3-t0-r4-c0', text: 'α', role: 'data' },
        { id: 'p3-t0-r4-c1', text: 'β', role: 'data' },
        { id: 'p3-t0-r4-c2', text: 'R²', role: 'data' },
        { id: 'p3-t0-r4-c3', text: 'x_i', role: 'data' },
      ], [
        { id: 'p3-t0-r5-c0', text: '𝛼', role: 'data' },
        { id: 'p3-t0-r5-c1', text: 'Problem', role: 'header' },
        { id: 'p3-t0-r5-c2', text: 'Best method', role: 'header' },
        { id: 'p3-t0-r5-c3', text: 'Results improve', role: 'data' },
      ]],
    },
    { id: 'p3-fig0', kind: 'figure', bbox: [0, 0.8, 1, 1], image_ref: 'fig.png' },
  ]));

  assert.deepEqual(collectTranslatableItems(page), [
    { id: 'p3-b0-s0', text: 'On the other hand, ' },
    { id: 'p3-b0-s1', text: 'the method converges.' },
    { id: 'p3-t0-caption', text: 'TABLE I. Median results' },
    { id: 'p3-t0-r0-c0', text: 'Problem' },
    { id: 'p3-t0-r0-c3', text: 'Best' },
    { id: 'p3-t0-r1-c3', text: 'Proposed method' },
    { id: 'p3-t0-r2-c0', text: 'Accuracy <= baseline after tuning' },
    { id: 'p3-t0-r2-c1', text: 'The score x^2 improves' },
    { id: 'p3-t0-r3-c0', text: 'Accuracy <= 1' },
    { id: 'p3-t0-r5-c1', text: 'Problem' },
    { id: 'p3-t0-r5-c2', text: 'Best method' },
    { id: 'p3-t0-r5-c3', text: 'Results improve' },
  ]);
});

test('plain text blocks without segments remain translatable', () => {
  const page = normalizePageIr(basePage([
    { id: 'p3-b0', kind: 'heading', bbox: [0, 0, 1, 0.1], text: 'Introduction' },
    { id: 'p3-b1', kind: 'plain_text', bbox: [0, 0.1, 1, 0.2], text: 'Fallback prose' },
  ]));

  assert.deepEqual(collectTranslatableItems(page), [
    { id: 'p3-b0', text: 'Introduction' },
    { id: 'p3-b1', text: 'Fallback prose' },
  ]);
});
