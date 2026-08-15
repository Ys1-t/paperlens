import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCacheableStructuredTranslation,
  isLikelyUntranslated,
  structuredWarningText,
} from '../src/lib/translation-quality.js';

test('detects a long English paragraph returned unchanged for Chinese output', () => {
  const source = 'Pareto set learning maps preference vectors to Pareto optimal solutions for multiple objectives.';
  assert.equal(isLikelyUntranslated(source, source, '简体中文'), true);
  assert.equal(isLikelyUntranslated(source, `其中，${source}`, '简体中文'), true);
  assert.equal(isLikelyUntranslated(source, '帕累托集合学习将偏好向量映射为多目标问题的帕累托最优解。', '简体中文'), false);
  assert.equal(isLikelyUntranslated(source, '该方法保留 Pareto set learning 这一标准术语，并将偏好向量映射到帕累托最优解。', '简体中文'), false);
});

test('detects residual English sentences even when Chinese text is also present', () => {
  assert.equal(
    isLikelyUntranslated(
      'where x is the decision variable and y belongs to the feasible set',
      '其中 x is the decision variable，且 y 属于可行集。',
      '简体中文',
    ),
    true,
  );
  assert.equal(
    isLikelyUntranslated(
      'The framework learns a shared representation across multiple related tasks.',
      '该框架用于学习 shared representation across multiple related tasks。',
      '简体中文',
    ),
    true,
  );
  assert.equal(
    isLikelyUntranslated(
      'Preference vectors guide the search.',
      'Preference vectors guide the search.',
      '简体中文',
    ),
    true,
  );
  assert.equal(
    isLikelyUntranslated(
      'The method learns representations from multiple tasks.',
      '该方法 learns representations from multiple tasks。',
      '简体中文',
    ),
    true,
  );
  assert.equal(
    isLikelyUntranslated(
      'The framework learns a shared representation across multiple related tasks.',
      '该框架学习多个相关任务之间的共享表示。',
      '简体中文',
    ),
    false,
  );
});

test('does not flag short headings, formulas, or non-Chinese targets', () => {
  assert.equal(isLikelyUntranslated('Pareto Set Learning', 'Pareto Set Learning', '简体中文'), false);
  assert.equal(isLikelyUntranslated('x = f(lambda)', 'x = f(lambda)', '简体中文'), false);
  assert.equal(isLikelyUntranslated('A sufficiently long English source paragraph remains here.', 'A sufficiently long English source paragraph remains here.', 'English'), false);
});

test('structured warning is localized and scoped', () => {
  assert.equal(
    structuredWarningText({ placeholderFailures: 1, untranslatedItems: 2 }),
    '1 个含公式段落需要重试，2 个段落疑似未翻译。正在局部修复…',
  );
  assert.equal(structuredWarningText(), '');
});

test('structured cache rejects damaged placeholders, missing blocks, and untranslated English', () => {
  const source = [
    'The preference vector [[PLM:p0-m0]] encodes objective importance.',
    'This sufficiently long paragraph also needs a Chinese translation.',
  ].join('\n\n@@@BLK@@@\n\n');
  const valid = [
    '偏好向量 [[PLM:p0-m0]] 编码目标的相对重要性。',
    '这个足够长的段落也已经翻译为中文。',
  ].join('\n\n@@@BLK@@@\n\n');

  assert.equal(isCacheableStructuredTranslation(source, valid, '简体中文'), true);
  assert.equal(isCacheableStructuredTranslation(source, valid.replace('[[PLM:p0-m0]]', ''), '简体中文'), false);
  assert.equal(isCacheableStructuredTranslation(source, valid.replace(/@@@BLK@@@[\s\S]*/u, ''), '简体中文'), false);
  assert.equal(isCacheableStructuredTranslation(source, source, '简体中文'), false);
});
