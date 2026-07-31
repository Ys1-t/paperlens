import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  installKatexGuard,
  KATEX_GUARD_VERSION,
} from '../src/lib/katex-guard.js';
import { canonicalizeFormulaLatex } from '../src/lib/formula-quality.js';
import { prepareAlgorithmBodyForDisplay } from '../src/lib/algorithm-format.js';

test('global guard normalizes input and overrides an explicit strict warn', () => {
  const calls = [];
  const katex = {
    renderToString: (...args) => {
      calls.push(args);
      return '<span></span>';
    },
  };

  assert.equal(installKatexGuard(katex), true);
  katex.renderToString('\u2126 \u2225 𝜆', { displayMode: true, strict: 'warn' });

  assert.equal(calls[0][0], '\\Omega{} \\Vert{} \\lambda{}');
  assert.deepEqual(calls[0][1], { displayMode: true, strict: 'ignore' });
  assert.equal(katex.__paperLensMathGuard, KATEX_GUARD_VERSION);
});

test('global guard rejects damaged math before any KaTeX parser is called', () => {
  let calls = 0;
  const katex = { renderToString: () => { calls += 1; } };
  installKatexGuard(katex);

  assert.throws(
    () => katex.renderToString('x + \u0de9', { strict: 'warn' }),
    (error) => error?.code === 'PAPERLENS_UNSAFE_MATH',
  );
  assert.equal(calls, 0);
});

test('global guard soft-strips unsafe Unicode when throwOnError is false', () => {
  const calls = [];
  const katex = {
    renderToString: (...args) => {
      calls.push(args);
      return '<span></span>';
    },
  };
  installKatexGuard(katex);

  // CJK mixed into latex: common vision-model failure mode.
  assert.doesNotThrow(() => {
    katex.renderToString('x + 是 + y', { throwOnError: false, strict: 'warn' });
  });
  assert.equal(calls.length, 1);
  // Unknown CJK dropped; remaining ascii latex kept.
  assert.equal(calls[0][0], 'x +  + y');
  assert.equal(calls[0][1].throwOnError, false);
  assert.equal(calls[0][1].strict, 'ignore');
});

test('global guard installation is idempotent', () => {
  const calls = [];
  const katex = { renderToString: (...args) => calls.push(args) };
  installKatexGuard(katex);
  const guarded = katex.renderToString;
  assert.equal(installKatexGuard(katex), true);
  assert.equal(katex.renderToString, guarded);

  katex.renderToString('\u2126');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '\\Omega{}');
});

test('bundled KaTeX stays silent even when a caller requests strict warn', async () => {
  const warnings = [];
  const context = { console: { warn: (...args) => warnings.push(args.join(' ')) } };
  context.self = context;
  const katexSource = await readFile(
    new URL('../src/vendor/katex/katex.min.js', import.meta.url),
    'utf8',
  );
  vm.runInNewContext(katexSource, context);
  installKatexGuard(context.katex);

  const html = context.katex.renderToString(
    '\u2126 \u2225 \u02dc 𝜆 𝝀 𝜽 𝜕 𝓛 \u2022 \u2206 \u00b5',
    { displayMode: true, throwOnError: true, strict: 'warn' },
  );

  assert.match(html, /class="katex"/);
  assert.deepEqual(warnings, []);
});

test('bundled KaTeX renders the accepted D4L equation 17 transcription', async () => {
  const context = { console: { warn: () => {} } };
  context.self = context;
  const katexSource = await readFile(
    new URL('../src/vendor/katex/katex.min.js', import.meta.url),
    'utf8',
  );
  vm.runInNewContext(katexSource, context);
  installKatexGuard(context.katex);

  const latex = canonicalizeFormulaLatex(String.raw`\approx \nabla_{\theta_{sh}} \mathcal{L}(\theta^{(t)}) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right) = \sum_{k=1}^{K} p_k \cdot \nabla_{\theta_{sh}} \mathbb{E}_{\lambda_k \sim \Lambda_k} g\!\left(h_{\theta^{(t)}}(\lambda_k)\mid\lambda_k\right) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right),`);
  const html = context.katex.renderToString(latex, {
    displayMode: true,
    throwOnError: true,
    strict: 'warn',
  });

  assert.match(html, /class="katex-display"/);
});

test('bundled KaTeX renders locally repaired algorithm math without raw commands', async () => {
  const warnings = [];
  const context = { console: { warn: (...args) => warnings.push(args.join(' ')) } };
  context.self = context;
  const katexSource = await readFile(
    new URL('../src/vendor/katex/katex.min.js', import.meta.url),
    'utf8',
  );
  vm.runInNewContext(katexSource, context);
  installKatexGuard(context.katex);

  const repaired = [
    prepareAlgorithmBodyForDisplay('Require: Pop = {x_1,\\dots,x_N} (种群), \\eta \\in [0,1] (交叉类型参数)'),
    prepareAlgorithmBodyForDisplay('if FE < \\eta \\cdot FE_{\\max} then'),
    prepareAlgorithmBodyForDisplay("Pop' = Pop' \\cup O;"),
  ].join('\n');
  const formulas = [...repaired.matchAll(/\\\(([\s\S]*?)\\\)/gu)].map((match) => match[1]);
  assert.ok(formulas.length >= 4);
  for (const latex of formulas) {
    const html = context.katex.renderToString(latex, {
      displayMode: false,
      throwOnError: true,
      strict: 'warn',
    });
    assert.match(html, /class="katex"/);
  }
  assert.deepEqual(warnings, []);
});
