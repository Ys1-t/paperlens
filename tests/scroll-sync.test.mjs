import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  anchorScrollDelta,
  createScrollSyncGuard,
  findColumnAnchor,
} from '../src/lib/reading-link.js';

// ---------------------------------------------------------------------------
// 滚动联动纯函数：当前可视锚点 + 跨栏对应位移
// ---------------------------------------------------------------------------

test('findColumnAnchor picks the first element crossing the viewport top', () => {
  const rects = [
    { top: -300, bottom: -100, height: 200 }, // 已滚出上方
    { top: -50, bottom: 150, height: 200 }, // 当前可视首个
    { top: 150, bottom: 350, height: 200 },
  ];
  const anchor = findColumnAnchor(rects, 0);
  assert.equal(anchor.index, 1);
  // 视口顶部(0) 落在该元素 (top=-50, height=200) 的 50/200 = 0.25 处
  assert.ok(Math.abs(anchor.ratio - 0.25) < 1e-9);
});

test('findColumnAnchor clamps ratio into [0,1] and falls back to last element', () => {
  const top = findColumnAnchor([{ top: 10, bottom: 210, height: 200 }], 0);
  assert.equal(top.index, 0);
  assert.equal(top.ratio, 0); // 视口顶部在元素之上 -> ratio 夹到 0

  const empty = findColumnAnchor([], 0);
  assert.equal(empty.index, 0);
  assert.equal(empty.ratio, 0);

  const past = findColumnAnchor(
    [{ top: -400, bottom: -200, height: 200 }],
    0,
  );
  assert.equal(past.index, 0); // 全部滚出 -> 落到最后一个
});

test('anchorScrollDelta aligns the target element ratio position to the viewport top', () => {
  // 目标元素 top=120（相对目标栏视口顶 20），锚点 ratio=0.5，height=200
  const delta = anchorScrollDelta({ top: 120, bottom: 320, height: 200 }, { ratio: 0.5 }, 20);
  // (120 + 0.5*200) - 20 = 200
  assert.equal(delta, 200);
});

test('anchorScrollDelta tolerates missing height by deriving it from bounds', () => {
  const delta = anchorScrollDelta({ top: 100, bottom: 300 }, { ratio: 0 }, 0);
  assert.equal(delta, 100);
});

// ---------------------------------------------------------------------------
// 回声防抖闸门：阻断 A→B→B→A 死循环
// ---------------------------------------------------------------------------

test('createScrollSyncGuard suppresses a side for a bounded time window', () => {
  let clock = 1000;
  const guard = createScrollSyncGuard({ now: () => clock, windowMs: 100 });

  assert.equal(guard.isSuppressed('panel'), false);
  guard.suppress('panel');
  assert.equal(guard.isSuppressed('panel'), true); // 窗口内：忽略回声
  assert.equal(guard.isSuppressed('pdf'), false); // 只压制被驱动的一侧

  clock += 101; // 窗口过期
  assert.equal(guard.isSuppressed('panel'), false); // 永不卡死
});

test('createScrollSyncGuard.clear resets all suppression', () => {
  let clock = 0;
  const guard = createScrollSyncGuard({ now: () => clock, windowMs: 500 });
  guard.suppress('pdf');
  guard.suppress('panel');
  guard.clear();
  assert.equal(guard.isSuppressed('pdf'), false);
  assert.equal(guard.isSuppressed('panel'), false);
});

// A 驱动 B：B 收到程序化 scroll 回声时应被 guard 吞掉，不反向驱动 A。
test('echo from a programmatically scrolled column does not re-trigger the source', () => {
  let clock = 0;
  const guard = createScrollSyncGuard({ now: () => clock, windowMs: 160 });
  // 用户滚 pdf -> 驱动 panel 前先压制 panel
  guard.suppress('panel');
  // panel 的 scroll 回声在窗口内到达 -> 被忽略，不会去驱动 pdf
  assert.equal(guard.isSuppressed('panel'), true);
});

// ---------------------------------------------------------------------------
// 源码契约：确保 viewer.js 用时间窗闸门而非鼠标悬停做防抖
// ---------------------------------------------------------------------------

test('viewer scroll sync uses the echo guard, not mouseenter activeCol', async () => {
  const source = await readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  assert.match(source, /createScrollSyncGuard/u);
  assert.match(source, /scrollSyncGuard\.isSuppressed\('pdf'\)/u);
  assert.match(source, /scrollSyncGuard\.isSuppressed\('panel'\)/u);
  // Whole-page correspondence for vision: PDF dblclick falls back to panel section.
  assert.match(source, /Vision[\s\S]*whole-page correspondence|whole-page correspondence/u);
  assert.match(source, /linkTo\('panel', els\.panelColumn, p\.sectionEl/u);
  assert.match(source, /Vision path has no per-block IR/u);
  assert.match(source, /mergeTrailingEquationNumbers/u);
  assert.match(source, /layoutDisplayEquationNumbers/u);
  assert.match(source, /scrollSyncGuard\?\.suppress\(other/u);
  assert.match(source, /requestAnimationFrame/u);
  // 用户可解除联动：译文更长时让原文停住
  assert.match(source, /isScrollLinkActive/u);
  assert.match(source, /scrollLinkEnabled/u);
  assert.match(source, /scrollLinkHoldOff/u);
  assert.match(source, /setScrollLinkEnabled/u);
  assert.match(source, /setupScrollLinkControls/u);
  assert.match(source, /独立滚动/u);
  assert.match(source, /SCROLL_LINK_STORAGE_KEY|paperlens\.scrollLink\.enabled/u);
  assert.match(source, /readScrollLinkPreference/u);
  assert.match(source, /Ctrl\+Shift\+L|ctrlKey && event\.shiftKey/u);
  // 窗口/分栏/缩放后按页比例重新对齐，避免左右漂移
  assert.match(source, /scheduleScrollRealign/u);
  assert.match(source, /forceSyncColumns/u);
  assert.match(source, /setupScrollLayoutRealign/u);
  assert.match(source, /ResizeObserver/u);
  assert.match(source, /fromLayout/u);
  // 不再依赖鼠标悬停判定活动栏
  assert.doesNotMatch(source, /state\.activeCol/u);
  assert.doesNotMatch(source, /addEventListener\('mouseenter'/u);
});

test('scroll-link toggle is exposed in the viewer toolbar', async () => {
  const html = await readFile(new URL('../src/viewer/viewer.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8');
  assert.match(html, /id="btn-scroll-link"/);
  assert.match(html, /scroll-link-label/);
  assert.match(css, /\.scroll-link-btn\.is-unlinked/);
  assert.match(css, /body\.scroll-unlinked/);
});
