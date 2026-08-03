import test from 'node:test';
import assert from 'node:assert/strict';

import {
  protectMathSegments,
  restoreMathSegments,
  renderMarkdownHtml,
} from '../src/lib/markdown-math.js';

// 回归：手机版/桌面版公式不渲染的根因——$x_i$ … $x_j$ 之间的下划线被
// marked 当斜体配对，定界符被 <em> 拆散，KaTeX 找不到成对 $。
test('math segments are protected from marked emphasis mangling', () => {
  const src = '设 $x_i$ 与 $x_j$ 满足 $a_* + b_*$，则收敛。';
  const { masked, math } = protectMathSegments(src);
  assert.doesNotMatch(masked, /\$/);
  assert.equal(math.length, 3);
  // 模拟 marked：残余下划线会被斜体化——保护后的文本不含任何公式字符。
  const fakeParsed = `<p>${masked.replace(/_(.+?)_/g, '<em>$1</em>')}</p>`;
  const restored = restoreMathSegments(fakeParsed, math);
  assert.match(restored, /\$x_i\$/);
  assert.match(restored, /\$x_j\$/);
  assert.doesNotMatch(restored, /<em>/);
});

test('block math and \\[..\\] are stashed before inline $', () => {
  const src = '$$\\sum_{i=1}^n w_i f_i(x)$$ 与 \\(\\lambda\\in\\Lambda\\)';
  const { masked, math } = protectMathSegments(src);
  assert.equal(math.length, 2);
  assert.match(math[0].text, /^\$\$[\s\S]*\$\$$/);
  assert.doesNotMatch(masked, /\\sum|\\lambda/);
});

test('renderMarkdownHtml keeps formulas intact through a real-ish parser', () => {
  // 简化 marked：段落 + 斜体 + 代码围栏。
  const parse = (s) => s
    .split(/\n{2,}/)
    .map((p) => (/^```/m.test(p)
      ? `<pre><code class="language-algorithm">${p.replace(/^```algorithm\n?|```$/g, '')}</code></pre>`
      : `<p>${p.replace(/_(.+?)_/g, '<em>$1</em>')}</p>`))
    .join('');
  const html = renderMarkdownHtml(
    '目标函数 $g(x \\mid \\lambda_i)$ 定义如下。\n\n```algorithm\n1: For $t = 1$ To $T$\n2:   更新 $\\theta_{t}$\n3: End For\n```',
    parse,
  );
  assert.match(html, /\$g\(x \\mid \\lambda_i\)\$/);
  assert.doesNotMatch(html, /<em>/);
  // 算法围栏此时仍是 pre/code（DOM 提升在 hydrateAlgorithmFences 做），
  // 公式文本必须原样保留在里面等待提升后渲染。
  assert.match(html, /language-algorithm/);
  assert.match(html, /\$\\theta_\{t\}\$|\$\\theta_{t}\$/);
});

test('incomplete math (CJK inside $) is wrapped with a marker instead of dropped', () => {
  const html = renderMarkdownHtml('设 $\\lambda 是偏好向量$ 成立。', (s) => `<p>${s}</p>`);
  assert.match(html, /math-incomplete/);
});

test('outer markdown code fence unwrap and script sanitization', () => {
  const html = renderMarkdownHtml('```markdown\n# 标题\n```', (s) => s);
  assert.doesNotMatch(html, /```/);
  const dirty = renderMarkdownHtml('<script>alert(1)</script>正文', (s) => s);
  assert.doesNotMatch(dirty, /<script/);
});
