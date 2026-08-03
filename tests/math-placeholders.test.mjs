import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MathPlaceholderValidationError,
  buildMathPlaceholder,
  createPlaceholderStreamParser,
  createStructuredTranslationAccumulator,
  createStructuredTranslationPlan,
  serializeParagraph,
  validateMathTokens,
} from '../src/lib/structured-translation.js';

function paragraph() {
  return {
    id: 'p3-b0',
    kind: 'paragraph',
    bbox: [0.1, 0.2, 0.8, 0.3],
    segments: [
      { id: 'p3-b0-s0', kind: 'text', text: 'Let ' },
      {
        id: 'p3-b0-m0',
        kind: 'inline_math',
        latex: 'f_i(x^u)',
        source_text: 'fi(xu)',
        bbox: [0.2, 0.2, 0.3, 0.24],
      },
      { id: 'p3-b0-s1', kind: 'text', text: ' dominate ' },
      {
        id: 'p3-b0-m1',
        kind: 'inline_math',
        latex: 'x^v',
        source_text: 'xv',
        bbox: [0.4, 0.2, 0.45, 0.24],
      },
      { id: 'p3-b0-s2', kind: 'text', text: '.' },
    ],
  };
}

test('paragraph serialization keeps context but never sends LaTeX to translation', () => {
  const payload = serializeParagraph(paragraph());

  assert.equal(payload.kind, 'math_paragraph');
  assert.equal(
    payload.text,
    'Let [[PLM:p3-b0-m0]] dominate [[PLM:p3-b0-m1]].',
  );
  assert.deepEqual(payload.mathTokens, [
    '[[PLM:p3-b0-m0]]',
    '[[PLM:p3-b0-m1]]',
  ]);
  assert.equal(payload.text.includes('f_i'), false);
  assert.equal(payload.text.includes('x^v'), false);
  assert.deepEqual(payload.textSlots.map((slot) => slot.map((item) => item.id)), [
    ['p3-b0-s0'],
    ['p3-b0-s1'],
    ['p3-b0-s2'],
  ]);
});

test('structured plan replaces split paragraph fragments with one contextual item', () => {
  const plan = createStructuredTranslationPlan({
    index: 3,
    width: 595,
    height: 842,
    images: {},
    blocks: [
      paragraph(),
      { id: 'p3-b1', kind: 'plain_text', text: 'Another block.' },
    ],
  });

  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].id, 'p3-b0');
  assert.equal(plan.items[0].kind, 'math_paragraph');
  assert.equal(plan.items[1].id, 'p3-b1');
});

test('math tokens must have the same count, identity, and order', () => {
  const expected = [buildMathPlaceholder('m0'), buildMathPlaceholder('m1')];
  assert.deepEqual(validateMathTokens(expected, `A${expected[0]}B${expected[1]}C`), expected);

  for (const invalid of [
    `A${expected[0]}B`,
    `A${expected[0]}B${expected[0]}C${expected[1]}`,
    `A${expected[1]}B${expected[0]}C`,
    `A${expected[0]}B${buildMathPlaceholder('added')}C${expected[1]}`,
    `A${expected[0]}B${expected[1]}C[[PLM:unfinished`,
  ]) {
    assert.throws(
      () => validateMathTokens(expected, invalid),
      MathPlaceholderValidationError,
    );
  }
});

test('math token validation tolerates spacing and full-width bracket variants', () => {
  const expected = [buildMathPlaceholder('m0'), buildMathPlaceholder('m1')];
  const translated = '令［ ［ P L M ： m0 ］ ］支配 [[ PLM : m1 ]] 。';

  assert.deepEqual(validateMathTokens(expected, translated), expected);
  assert.throws(
    () => validateMathTokens(expected, '令［［PLM：m1］］支配 [[PLM:m0]]。'),
    MathPlaceholderValidationError,
  );
});

test('placeholder stream parser withholds a token split across arbitrary chunks', () => {
  const token = buildMathPlaceholder('p3-b0-m0');
  const parser = createPlaceholderStreamParser([token]);

  assert.deepEqual(parser.push('让[[PL'), ['让']);
  assert.deepEqual(parser.push('M:p3-b0-'), []);
  assert.deepEqual(parser.push('m0]]支配'), ['让', '支配']);
  assert.deepEqual(parser.finish(), {
    parts: ['让', '支配'],
    tokens: [token],
  });
});

test('streaming accumulator updates text slots without ever exposing token fragments', () => {
  const item = serializeParagraph(paragraph());
  const accumulator = createStructuredTranslationAccumulator([item]);

  const first = accumulator.push('令[[PLM:p3-b0-');
  assert.deepEqual(first, [{ id: 'p3-b0-s0', text: '令' }]);
  assert.equal(first.some((update) => update.text.includes('[[PLM:')), false);

  const second = accumulator.push('m0]]支配[[PLM:p3-b0-m1]]。');
  assert.deepEqual(second, [
    { id: 'p3-b0-s1', text: '支配' },
    { id: 'p3-b0-s2', text: '。' },
  ]);
  assert.deepEqual(accumulator.finish(), []);
  assert.equal(accumulator.value('p3-b0-s0'), '令');
  assert.equal(accumulator.value('p3-b0-s1'), '支配');
  assert.equal(accumulator.value('p3-b0-s2'), '。');
});

test('invalid math item recovers only itself without throwing', () => {
  const item = serializeParagraph(paragraph());
  const accumulator = createStructuredTranslationAccumulator([item]);
  accumulator.push('令[[PLM:p3-b0-m0]]支配。');

  const result = accumulator.finish();
  assert.deepEqual(result, [
    { id: 'p3-b0-s0', text: 'Let ' },
    { id: 'p3-b0-s1', text: ' dominate ' },
    { id: 'p3-b0-s2', text: '.' },
  ]);
  assert.equal(result.changes, result);
  assert.deepEqual(result.successfulChanges, []);
  assert.deepEqual(result.recoveryChanges, result);
  assert.equal(result.failedItems.length, 1);
  assert.equal(result.diagnostics.failedItems, result.failedItems);
  assert.equal(result.diagnostics.recoveryChanges, result.recoveryChanges);
  assert.equal(result.ok, false);
  assert.equal(result.failedItems[0].id, 'p3-b0');
  assert.equal(result.failedItems[0].code, 'math_placeholder_validation');
  assert.deepEqual(result.failedItems[0].recoveryChanges, result.recoveryChanges);
  assert.equal(accumulator.value('p3-b0-s0'), 'Let ');
  assert.equal(accumulator.value('p3-b0-s1'), ' dominate ');
  assert.equal(accumulator.value('p3-b0-s2'), '.');
});

test('one invalid math item cannot block valid math and non-math items', () => {
  const invalid = serializeParagraph(paragraph());
  const valid = serializeParagraph({
    ...paragraph(),
    id: 'p3-b1',
    segments: paragraph().segments.map((segment) => ({
      ...segment,
      id: segment.id.replace('p3-b0', 'p3-b1'),
    })),
  });
  const plain = { id: 'p3-b2', text: 'A plain block.' };
  const accumulator = createStructuredTranslationAccumulator([invalid, valid, plain]);
  const result = accumulator.finish([
    '令[[PLM:p3-b0-m1]]先于[[PLM:p3-b0-m0]]。',
    '@@@BLK@@@',
    '令［［ PLM：p3-b1-m0 ］］支配 [[ PLM : p3-b1-m1 ]]。',
    '@@@BLK@@@',
    '这是普通译文。',
  ].join('\n'));

  assert.equal(result.failedItems.length, 1);
  assert.equal(result.failedItems[0].id, 'p3-b0');
  assert.equal(accumulator.value('p3-b0-s0'), 'Let ');
  assert.equal(accumulator.value('p3-b1-s0'), '令');
  assert.equal(accumulator.value('p3-b1-s1'), '支配 ');
  assert.equal(accumulator.value('p3-b1-s2'), '。');
  assert.equal(accumulator.value('p3-b2'), '这是普通译文。');
  assert.deepEqual(result.successfulChanges.map((change) => change.id), [
    'p3-b1-s0',
    'p3-b1-s1',
    'p3-b1-s2',
    'p3-b2',
  ]);
});
