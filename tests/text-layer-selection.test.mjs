import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [viewer, css] = await Promise.all([
  readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8'),
]);

// ---------------------------------------------------------------------------
// 问题 1：PDF 选择精准 —— textLayer 与 canvas 缩放对齐 + 选择连续性承接层
// ---------------------------------------------------------------------------

test('textLayer and canvas render at the same page scale', () => {
  // canvas 与 textLayer 都用同一个 wantScale = state.scale 派生的 viewport。
  assert.match(viewer, /const wantScale = state\.scale;/u);
  assert.match(viewer, /const viewport = p\.pageObj\.getViewport\(\{ scale: wantScale \}\);/u);
});

test('--scale-factor is set to the exact viewport scale PDF.js expects', () => {
  // PDF.js 3.x span 用 calc(var(--scale-factor)*Npx)，必须等于 viewport.scale。
  assert.match(viewer, /setProperty\('--scale-factor', wantScale\)/u);
});

test('viewer restores the endOfContent selection-continuity layer PDF.js omits', () => {
  assert.match(viewer, /enhanceTextLayerSelection\(tl\)/u);
  assert.match(viewer, /className = 'endOfContent'/u);
  assert.match(viewer, /classList\.add\('selecting'\)/u);
  // 选择手势收尾统一清除，避免每次重渲染泄漏 document 监听。
  assert.match(viewer, /classList\.remove\('selecting'\)/u);
  assert.match(viewer, /textLayerSelectionCleanupBound/u);
});

test('CSS drives the endOfContent hot-zone from the selecting state', () => {
  assert.match(css, /\.textLayer \.endOfContent/u);
  assert.match(css, /\.textLayer\.selecting \.endOfContent \{ top: 0; \}/u);
});
