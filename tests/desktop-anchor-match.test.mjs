import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForMatch,
  extractAnchors,
  findBestSpanWindow,
  findBlockForWord,
  positionRatioFallback,
} from '../desktop/lib/anchor-match.mjs';

test('extractAnchors keeps translation-invariant tokens from Chinese blocks', () => {
  const anchors = extractAnchors(
    '我们提出 WRPN（权重相关策略网络），在 MOTSP 上比 DRL-MOA 提高 3.52%，见文献 [12] 与公式 (3)。超参数 batch=1024。',
  );
  assert.ok(anchors.includes('[12]'));
  assert.ok(anchors.includes('(3)'));
  assert.ok(anchors.includes('wrpn'));
  assert.ok(anchors.includes('motsp'));
  assert.ok(anchors.includes('drl-moa'));
  assert.ok(anchors.includes('3.52%'));
  assert.ok(anchors.includes('1024'));
  // 纯中文没有锚点
  assert.deepEqual(extractAnchors('我们提出了一种新的方法来求解。'), []);
  // 限量
  const long = Array.from({ length: 60 }, (_, i) => `token${i} word${i}xx`).join(' ');
  assert.ok(extractAnchors(long).length <= 24);
});

test('findBestSpanWindow locates the span run covering most anchors', () => {
  const spans = [
    'I. INTRODUCTION',
    'Multiobjective combinatorial optimization problems',
    'we propose WRPN, a weight-related policy network',
    'improving DRL-MOA by 3.52% on MOTSP instances [12]',
    'The rest of this paper is organized as follows',
  ];
  const anchors = extractAnchors('我们提出 WRPN，在 MOTSP 上比 DRL-MOA 提高 3.52% [12]。');
  const win = findBestSpanWindow(spans, anchors);
  assert.ok(win, 'should find a window');
  assert.ok(win.start >= 2 && win.end <= 3, `window ${win.start}-${win.end} should cover spans 2-3`);
  assert.ok(win.matched.includes('wrpn'));
  assert.ok(win.matched.includes('3.52%'));
});

test('findBestSpanWindow returns null when anchors are absent or too weak', () => {
  const spans = ['alpha beta', 'gamma delta'];
  assert.equal(findBestSpanWindow(spans, ['zzz', 'qqq']), null);
  assert.equal(findBestSpanWindow(spans, []), null);
  assert.equal(findBestSpanWindow([], ['alpha']), null);
  // 单个短 token 命中（1 分）低于 minScore=2 → null，避免乱跳
  assert.equal(findBestSpanWindow(spans, ['beta']), null);
  // 长 token 一次命中就值 2 分
  assert.ok(findBestSpanWindow(['the gradient descent optimizer'], ['gradient']));
});

test('findBestSpanWindow shrinks window edges without hits', () => {
  const spans = ['no hit here', 'WRPN appears', 'MOTSP appears', 'nothing again'];
  const win = findBestSpanWindow(spans, ['wrpn', 'motsp', 'other', 'more', 'tokens', 'six']);
  assert.ok(win);
  assert.equal(win.start, 1);
  assert.equal(win.end, 2);
});

test('findBlockForWord matches PDF-selected latin word to translation block', () => {
  const blocks = [
    '摘要——近年来神经组合优化方法盛行。',
    '我们提出 WRPN（权重相关策略网络）。',
    '实验在 MOTSP 与 MOCVRP 上进行，见 [12]。',
  ];
  assert.deepEqual(findBlockForWord(blocks, 'WRPN'), { index: 1, exact: true });
  assert.deepEqual(findBlockForWord(blocks, 'MOCVRP'), { index: 2, exact: true });
  assert.equal(findBlockForWord(blocks, 'transformer'), null);
  assert.equal(findBlockForWord(blocks, 'x'), null); // 过短
  assert.equal(findBlockForWord([], 'WRPN'), null);
});

test('normalize and ratio fallback behave on edge inputs', () => {
  assert.equal(normalizeForMatch('  A  B\n C '), 'a b c');
  assert.equal(positionRatioFallback({ top: 150, height: 100 }, { top: 0, height: 400 }), 0.5);
  assert.equal(positionRatioFallback({ top: 0, height: 0 }, { top: 0, height: 0 }), 0.5);
  assert.equal(positionRatioFallback({ top: 1000, height: 100 }, { top: 0, height: 400 }), 1);
});
