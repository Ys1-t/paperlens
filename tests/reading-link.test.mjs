import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let linkModule = {};
try {
  linkModule = await import('../src/lib/reading-link.js');
} catch {
  // RED phase: precise reading-target selection has not been implemented yet.
}

test('selection mapping prefers the smallest containing text segment', () => {
  assert.equal(typeof linkModule.chooseClosestReadingTarget, 'function');
  const id = linkModule.chooseClosestReadingTarget([
    { id: 'whole-paragraph', bbox: [0.10, 0.20, 0.90, 0.60] },
    { id: 'exact-segment', bbox: [0.12, 0.24, 0.42, 0.30] },
    { id: 'neighbor', bbox: [0.45, 0.24, 0.75, 0.30] },
  ], { x: 0.25, y: 0.27 });

  assert.equal(id, 'exact-segment');
});

test('selection mapping falls back to the nearest valid segment box', () => {
  const id = linkModule.chooseClosestReadingTarget([
    { id: 'invalid', bbox: [0, 0, 0, 0] },
    { id: 'upper', bbox: [0.10, 0.10, 0.40, 0.18] },
    { id: 'lower', bbox: [0.10, 0.30, 0.40, 0.38] },
  ], { x: 0.22, y: 0.27 });

  assert.equal(id, 'lower');
});

test('selection mapping uses line fragments instead of a misleading multi-line union', () => {
  const id = linkModule.chooseClosestReadingTarget([
    {
      id: 'wrapped-prose',
      bbox: [0.10, 0.10, 0.90, 0.40],
      bboxes: [[0.10, 0.10, 0.35, 0.14], [0.62, 0.36, 0.90, 0.40]],
    },
    { id: 'inline-formula', bbox: [0.45, 0.22, 0.55, 0.26] },
  ], { x: 0.50, y: 0.24 });

  assert.equal(id, 'inline-formula');
});

test('selection mapping rejects a distant arbitrary node', () => {
  const id = linkModule.chooseClosestReadingTarget([
    { id: 'top-left', bbox: [0.05, 0.05, 0.20, 0.10] },
    { id: 'bottom-right', bbox: [0.80, 0.80, 0.95, 0.90] },
  ], { x: 0.50, y: 0.50 });

  assert.equal(id, null);
});

test('rotated PDF points and boxes use the same Page IR coordinate space', () => {
  const point = linkModule.displayPointToIr({ x: 0.70, y: 0.20 }, 90);
  assert.equal(point.x, 0.20);
  assert.ok(Math.abs(point.y - 0.30) < 1e-12);
  assert.deepEqual(
    linkModule.irBoxToDisplay([0.10, 0.20, 0.30, 0.40], 90),
    [0.60, 0.10, 0.80, 0.30],
  );
  assert.deepEqual(
    linkModule.irBoxToDisplay([0.10, 0.20, 0.30, 0.40], 270),
    [0.20, 0.70, 0.40, 0.90],
  );
});

test('viewer requires a double click for both translation and PDF navigation', async () => {
  const source = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(source, /md\.addEventListener\('dblclick'/u);
  assert.doesNotMatch(source, /md\.addEventListener\('click'/u);
  assert.match(source, /document\.addEventListener\('dblclick'/u);
  assert.doesNotMatch(source, /document\.addEventListener\('mouseup'/u);
  assert.match(source, /handleSelectionLink\(\{ pageDiv, displayPoint \}\)/u);
  assert.match(source, /selectionIsCurrent \? selectedPoint : displayPoint/u);
  assert.match(source, /displayPointToIr\(/u);
  assert.match(source, /p\.irBboxes\.set\(block\.id, block\.bbox\)/u);
  // 滚动联动的死循环防抖改用时间窗回声闸门（不再依赖鼠标悬停 activeCol）。
  assert.match(source, /state\.scrollSyncSuspended \|\| state\.scrollSyncGuard\.isSuppressed/u);
});
