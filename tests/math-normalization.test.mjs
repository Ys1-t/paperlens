import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  extractBareEquationNumber,
  isStandaloneEquationNumber,
  mergeTrailingEquationNumbers,
  normalizeDelimitedMath,
  normalizeMathForKatex,
  prepareDelimitedMathForRender,
  softNormalizeMathForKatex,
} from '../src/lib/math-normalization.js';

test('normalizes every Unicode math glyph observed in the Edge error report', () => {
  const cases = new Map([
    ['\u2126', '\\Omega{}'],
    ['\u2225', '\\Vert{}'],
    ['\u02dc', '\\sim{}'],
    [String.fromCodePoint(0x1d706), '\\lambda{}'],
    [String.fromCodePoint(0x1d740), '\\boldsymbol{\\lambda}'],
    [String.fromCodePoint(0x1d73d), '\\boldsymbol{\\theta}'],
    [String.fromCodePoint(0x1d715), '\\partial{}'],
    [String.fromCodePoint(0x1d4db), '\\mathcal{L}'],
    ['\u2022', '\\bullet{}'],
    ['\u2206', '\\Delta{}'],
    ['\u00b5', '\\mu{}'],
  ]);

  for (const [source, expected] of cases) {
    assert.equal(normalizeMathForKatex(source), expected, `failed U+${source.codePointAt(0).toString(16)}`);
  }
});

test('normalizes mathematical compatibility letters by Unicode code point', () => {
  assert.equal(
    normalizeMathForKatex(`${String.fromCodePoint(0x1d706)}_1 + ${String.fromCodePoint(0x1d703)}^2`),
    '\\lambda{}_1 + \\theta{}^2',
  );
});

test('normalizes common operators and super- or subscript digits to ASCII LaTeX', () => {
  assert.equal(
    normalizeMathForKatex('x₂ ≤ y² → ∞'),
    'x_{2} \\le{} y^{2} \\to{} \\infty{}',
  );
});

test('rejects unknown, replacement, and lone-surrogate characters before KaTeX', () => {
  assert.equal(normalizeMathForKatex('\u0de9'), '');
  assert.equal(normalizeMathForKatex('\ufffd'), '');
  assert.equal(normalizeMathForKatex('\ud835'), '');
  assert.equal(normalizeMathForKatex(`x + \u0de9`), '');
});

test('softNormalizeMathForKatex drops unknown Unicode but keeps surrounding latex', () => {
  assert.equal(softNormalizeMathForKatex('x + 是 + y'), 'x +  + y');
  assert.equal(softNormalizeMathForKatex('\u2126 = R'), '\\Omega{} = R');
  assert.equal(softNormalizeMathForKatex('是向量'), '');
});

test('prepareDelimitedMathForRender marks incomplete formulas after soft strip', () => {
  const ok = prepareDelimitedMathForRender('$x + y$');
  assert.equal(ok.incomplete, false);
  assert.equal(ok.text, '$x + y$');

  const mixed = prepareDelimitedMathForRender('$x + 是 + y$');
  assert.equal(mixed.incomplete, true);
  assert.equal(mixed.plain, false);
  assert.equal(mixed.text, '$x +  + y$');

  const dead = prepareDelimitedMathForRender('$是向量$');
  assert.equal(dead.incomplete, true);
  assert.equal(dead.plain, true);
  assert.equal(dead.text, '是向量');
});

test('unsafe delimited math soft-strips or becomes plain text for auto-render', () => {
  // Soft path keeps remaining latex (marked incomplete) instead of dumping junk into KaTeX.
  assert.equal(normalizeDelimitedMath('$$x + \u0de9$$'), '$$x +$$');
  assert.equal(normalizeDelimitedMath('\\[\ufffd\\]'), '\ufffd');
  assert.equal(normalizeDelimitedMath('$\ud835$'), '\ud835');
  assert.equal(normalizeDelimitedMath('$\u2126 = R$'), '$\\Omega{} = R$');
  const prepared = prepareDelimitedMathForRender('$$x + \u0de9$$');
  assert.equal(prepared.incomplete, true);
  assert.equal(prepared.text, '$$x +$$');
});

test('mergeTrailingEquationNumbers folds (N) after display math into \\tag{N}', () => {
  const src = [
    '正文',
    '$$',
    'x = y + z',
    '$$',
    '(3)',
    '下一段',
  ].join('\n');
  const out = mergeTrailingEquationNumbers(src);
  assert.match(out, /\\tag\{3\}/);
  assert.doesNotMatch(out, /\$\$\s*\n\s*\(3\)/);
  assert.match(out, /下一段/);
});

test('mergeTrailingEquationNumbers supports fullwidth parens and same-line labels', () => {
  assert.match(
    mergeTrailingEquationNumbers('$$a+b$$ （12）\nmore'),
    /\\tag\{12\}/,
  );
  assert.match(
    mergeTrailingEquationNumbers('\\[a+b\\]\n(7)\n'),
    /\\tag\{7\}/,
  );
});

test('mergeTrailingEquationNumbers does not double-tag already tagged displays', () => {
  const src = '$$x\\tag{3}$$\n(3)';
  const out = mergeTrailingEquationNumbers(src);
  assert.equal((out.match(/\\tag/g) || []).length, 1);
});

test('standalone equation number helpers recognize paper-style labels', () => {
  assert.equal(isStandaloneEquationNumber('(3)'), true);
  assert.equal(isStandaloneEquationNumber(' （12） '), true);
  assert.equal(isStandaloneEquationNumber('see (3)'), false);
  assert.equal(extractBareEquationNumber('（12）'), '12');
});

test('the bundled KaTeX renders the complete reported glyph set without warnings', async () => {
  const warnings = [];
  const context = {
    console: { warn: (...args) => warnings.push(args.join(' ')) },
  };
  context.self = context;
  const katexSource = await readFile(
    new URL('../src/vendor/katex/katex.min.js', import.meta.url),
    'utf8',
  );
  vm.runInNewContext(katexSource, context);

  const latex = normalizeMathForKatex('\u2126 \u2225 \u02dc 𝜆 𝝀 𝜽 𝜕 𝓛 \u2022 \u2206 \u00b5');
  const html = context.katex.renderToString(latex, {
    displayMode: true,
    throwOnError: true,
    strict: 'ignore',
  });

  assert.match(html, /class="katex"/);
  assert.deepEqual(warnings, []);
});
