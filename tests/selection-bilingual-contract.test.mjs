import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SELECTION_CONTEXT_MARKER,
  SELECTION_EXCERPT_MARKER,
  buildSelectionTranslationRequestText,
  chooseSelectionPopoverPlacement,
  collectSelectionContext,
  isTranslatableSelectionText,
  normalizeSelectionText,
} from '../src/lib/selection-translate.js';
import { defaultSystemPrompt } from '../src/lib/translator.js';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const viewerSource = readFileSync(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const viewerCss = readFileSync(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');
const serviceWorkerSource = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);
const optionsHtml = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
const optionsSource = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// 划词请求文本组织（纯逻辑）
// ---------------------------------------------------------------------------

test('selection text is normalized from multi-line textLayer selections', () => {
  assert.equal(normalizeSelectionText('  Pareto\n  Set \tLearning '), 'Pareto Set Learning');
  assert.equal(normalizeSelectionText(null), '');
});

test('untranslatable selections are rejected before any request', () => {
  assert.equal(isTranslatableSelectionText(''), false);
  assert.equal(isTranslatableSelectionText('a'), false);
  assert.equal(isTranslatableSelectionText('.,;)('), false);
  assert.equal(isTranslatableSelectionText('x'.repeat(1201)), false);
  assert.equal(isTranslatableSelectionText('Pareto set'), true);
});

test('selection context is collected from adjacent spans within a budget', () => {
  const spans = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
  assert.deepEqual(collectSelectionContext(spans, 2, 2), {
    before: 'aaa bbb',
    after: 'ddd eee',
  });
  assert.deepEqual(collectSelectionContext(spans, 2, 2, { beforeBudget: 4, afterBudget: 3 }), {
    before: 'bbb',
    after: '',
  });
  assert.deepEqual(collectSelectionContext(['aaa', '', 'bbb'], 2, 2), {
    before: 'aaa',
    after: '',
  });
});

test('invalid span indexes degrade to an empty context instead of throwing', () => {
  assert.deepEqual(collectSelectionContext(['aaa'], -1, -1), { before: '', after: '' });
  assert.deepEqual(collectSelectionContext(['aaa'], 0, 9), { before: '', after: '' });
  assert.deepEqual(collectSelectionContext(undefined, 0, 0), { before: '', after: '' });
});

test('selection request embeds context with markers and the bare excerpt', () => {
  const withContext = buildSelectionTranslationRequestText({
    selection: 'the Pareto front',
    before: 'We study',
    after: 'of this problem.',
  });
  const lines = withContext.split('\n');
  assert.equal(lines[0], SELECTION_CONTEXT_MARKER);
  assert.equal(lines[1], 'We study the Pareto front of this problem.');
  assert.equal(lines[3], SELECTION_EXCERPT_MARKER);
  assert.equal(lines[4], 'the Pareto front');
});

test('selection request without any context stays a plain text payload', () => {
  const bare = buildSelectionTranslationRequestText({ selection: '  Pareto\nfront ' });
  assert.equal(bare, 'Pareto front');
  assert.ok(!bare.includes(SELECTION_CONTEXT_MARKER));
  assert.equal(buildSelectionTranslationRequestText({ selection: '   ' }), '');
});

test('defaultSystemPrompt understands the exact selection context markers', () => {
  const prompt = defaultSystemPrompt('简体中文');
  assert.ok(prompt.includes(SELECTION_CONTEXT_MARKER));
  assert.ok(prompt.includes(SELECTION_EXCERPT_MARKER));
  assert.match(prompt, /translate ONLY the excerpt/);
});

// ---------------------------------------------------------------------------
// 浮层几何（纯逻辑）
// ---------------------------------------------------------------------------

test('popover prefers to sit above the selection anchored by bottom', () => {
  const placement = chooseSelectionPopoverPlacement({
    anchor: { left: 100, right: 200, top: 300, bottom: 320 },
    size: { width: 100, height: 80 },
    viewport: { width: 800, height: 600 },
  });
  assert.equal(placement.placement, 'above');
  assert.equal(placement.bottom, 310); // 600 - 300 + gap(10)：向上生长不遮挡选区
  assert.equal(placement.left, 100);
  assert.equal(placement.top, undefined);
});

test('popover falls below the selection when there is no room above', () => {
  const placement = chooseSelectionPopoverPlacement({
    anchor: { left: 100, right: 200, top: 50, bottom: 70 },
    size: { width: 100, height: 80 },
    viewport: { width: 800, height: 600 },
  });
  assert.equal(placement.placement, 'below');
  assert.equal(placement.top, 80);
  assert.equal(placement.bottom, undefined);
});

test('popover left edge is clamped inside the viewport margins', () => {
  const nearLeft = chooseSelectionPopoverPlacement({
    anchor: { left: 0, right: 10, top: 300, bottom: 320 },
    size: { width: 200, height: 40 },
    viewport: { width: 800, height: 600 },
  });
  assert.equal(nearLeft.left, 8);
  const nearRight = chooseSelectionPopoverPlacement({
    anchor: { left: 780, right: 800, top: 300, bottom: 320 },
    size: { width: 200, height: 40 },
    viewport: { width: 800, height: 600 },
  });
  assert.equal(nearRight.left, 592); // 800 - 200 - margin(8)
});

// ---------------------------------------------------------------------------
// 配置与设置页
// ---------------------------------------------------------------------------

test('selectionTranslate defaults to enabled and bilingual stays opt-in', () => {
  assert.equal(DEFAULT_CONFIG.selectionTranslate, true);
  assert.equal(DEFAULT_CONFIG.bilingual, false);
});

test('options page exposes both reading toggles and persists them as globals', () => {
  assert.match(optionsHtml, /<input type="checkbox" id="selectionTranslate"/);
  assert.match(optionsHtml, /<input type="checkbox" id="bilingual"/);
  assert.match(optionsSource, /GLOBAL_CHECKS = \[[^\]]*'selectionTranslate'[^\]]*\]/);
  assert.match(optionsSource, /GLOBAL_CHECKS = \[[^\]]*'bilingual'[^\]]*\]/);
});

// ---------------------------------------------------------------------------
// viewer 源码契约：划词浮层
// ---------------------------------------------------------------------------

test('viewer sends selection requests on the priority lane of the frozen port shape', () => {
  assert.match(
    viewerSource,
    /postMessage\(\{ type: 'translate', id, text, priority: true \}\)/,
  );
  // 划词走 defaultSystemPrompt 普通文本路径：请求携带上下文组织后的纯文本。
  assert.match(viewerSource, /buildSelectionTranslationRequestText\(\{ selection: text, before, after \}\)/);
  assert.match(viewerSource, /collectSelectionContext\(/);
});

test('viewer cancels the selection request when the popover closes or a new selection starts', () => {
  assert.match(viewerSource, /function closeSelectionPopover\(\) \{\s*cancelSelectionTranslateRequest\(\);/);
  assert.match(viewerSource, /client\.cancel\(selectionPopover\.requestId\)/);
  assert.match(viewerSource, /function openSelectionPopover\(\{[^}]*\}\) \{\s*cancelSelectionTranslateRequest\(\);/);
});

test('selection popover dismisses on Escape, outside pointer down, and column scroll', () => {
  assert.match(viewerSource, /event\.key === 'Escape'\) closeSelectionPopover\(\)/);
  assert.match(viewerSource, /selectionPopover\.el\?\.contains\(event\.target\)\) return;\s*closeSelectionPopover\(\);/);
  assert.match(viewerSource, /SELECTION_POPOVER_SCROLL_CLOSE_PX/);
});

test('drag selections trigger the popover while multi-click link gestures do not', () => {
  assert.match(viewerSource, /if \(event\.detail > 1 \|\| event\.button !== 0\) return;/);
  // 双击定位逻辑保持原样（dblclick → handleSelectionLink）。
  assert.match(viewerSource, /document\.addEventListener\('dblclick'/);
  assert.match(viewerSource, /function handleSelectionLink\(/);
});

test('disabling selectionTranslate removes the listener entirely', () => {
  assert.match(viewerSource, /syncSelectionTranslateListener\(config\?\.selectionTranslate !== false\)/);
  assert.match(viewerSource, /selectionTranslateController\?\.abort\(\);\s*selectionTranslateController = null;\s*closeSelectionPopover\(\);/);
  assert.match(viewerSource, /if \(state\.config\?\.selectionTranslate === false\) return;/);
});

// ---------------------------------------------------------------------------
// service worker 源码契约：priority 免排队 + 不碰共享译文缓存
// ---------------------------------------------------------------------------

test('priority selection requests run immediately and never touch the shared cache', () => {
  assert.match(serviceWorkerSource, /msg\.priority \? runTask\(\) : scheduler\.schedule\(/);
  assert.match(serviceWorkerSource, /if \(!bypassCache && !msg\.priority\) \{/);
  assert.match(serviceWorkerSource, /if \(msg\.priority\) \{[^}]*\} else if \(reusableTranslation\(full\)\) \{/s);
});

// ---------------------------------------------------------------------------
// viewer 源码契约：原文对照（bilingual）
// ---------------------------------------------------------------------------

test('structured pages mount one persistent source line per prose block', () => {
  assert.match(viewerSource, /function createStructuredSourceLine\(/);
  assert.match(viewerSource, /line\.className = 'src-line'/);
  assert.match(viewerSource, /const sourceLine = createStructuredSourceLine\(p, block\);\s*if \(sourceLine\) fragment\.appendChild\(sourceLine\);/);
  // 公式 / 表格 / 图片引用节点不加原文行。
  assert.match(viewerSource, /return null; \/\/ display_math \/ table \/ figure：不渲染原文行/);
});

test('source lines stay hidden for pending or failed nodes and never re-render on stream', () => {
  assert.match(viewerSource, /function refreshStructuredSourceLines\(p\)/);
  assert.match(viewerSource, /!node\.classList\.contains\('structured-text-pending'\)/);
  assert.match(viewerSource, /!node\.classList\.contains\('structured-text-failed'\)/);
  assert.match(viewerSource, /entry\.el\.classList\.toggle\('src-ready', ready && !identical\)/);
  // 流式回填路径只刷新可见性，不重建原文 DOM。
  assert.match(viewerSource, /refreshStructuredSourceLines\(p\);\s*return \{ expandedChanges, rejectedUnitIds \};/);
});

test('bilingual preference toggles live through the public config refresh', () => {
  assert.match(viewerSource, /applyReadingPreferences\(config\)/);
  assert.match(viewerSource, /classList\.toggle\('bilingual-src', config\?\.bilingual === true\)/);
});

// ---------------------------------------------------------------------------
// 样式契约
// ---------------------------------------------------------------------------

test('popover styling is copy-friendly and respects reduced motion', () => {
  assert.match(viewerCss, /\.selection-popover \{[\s\S]*?user-select: text/);
  assert.match(viewerCss, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.selection-popover \{ animation/);
  assert.match(viewerCss, /\.selection-popover-result\.pending/);
});

test('source lines render as a muted secondary style only when enabled and ready', () => {
  assert.match(viewerCss, /\.structured-page \.src-line \{ display: none; \}/);
  assert.match(viewerCss, /body\.bilingual-src \.structured-page \.src-line\.src-ready \{[\s\S]*?color: var\(--muted\);[\s\S]*?font-size: 13px/);
});
