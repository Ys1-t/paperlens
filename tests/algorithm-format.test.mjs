import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatAlgorithmsInMarkdown,
  indentAlgorithmLines,
  localizeAlgorithmKeywords,
  localizeAlgorithmTitle,
  looksLikeCompactAlgorithm,
  looksLikeLatexHeavy,
  prepareAlgorithmBodyForDisplay,
  prepareAlgorithmDisplayLine,
  recoverAlgorithmFromPlainText,
  reflowCompactAlgorithmLines,
  splitAlgorithmTitleAndBody,
  stripMarkdownNoiseFromAlgorithm,
} from '../src/lib/algorithm-format.js';
import { visionSystemPrompt, markdownSystemPrompt } from '../src/lib/translator.js';

test('looksLikeCompactAlgorithm detects numbered pseudocode dumps', () => {
  const compact = '1: Begin 2: // init 3: g ← 0 4: While true Do 5: End While 6: End';
  assert.equal(looksLikeCompactAlgorithm(compact), true);
  assert.equal(looksLikeCompactAlgorithm('普通段落没有编号步骤。'), false);
  // Fullwidth colon + dense markers
  assert.equal(
    looksLikeCompactAlgorithm('1：Begin 2：init 3：x 4：While 5：End While 6：End'),
    true,
  );
  // Body prose with p-values / decimals must NOT look like an algorithm.
  const prose = '显著性水平设为 0.05。如果 p 值大于 0.05，则两种算法在多个问题上的性能相似。效应量 0.2 为小，0.5 为中，0.8 为大。';
  assert.equal(looksLikeCompactAlgorithm(prose), false);
  assert.doesNotMatch(reflowCompactAlgorithmLines(prose), /^0:\s*05/m);
});

test('math range subscripts 0:i-1 and latex dumps are never treated as algorithms', () => {
  // User regression: natural-gradient page turned into "0: i-1}})}\\partial..." garbage.
  const formulaDump = [
    'However, the partial derivative $\\partial \\ln \\mathcal{N}(x_i;\\varphi_{\\theta}(x_{0:i-1}))/\\partial \\varphi_{\\theta}(x_{0:i-1})$',
    'rarely yields stable convergence. See (9) and (10):',
    '$$\\tilde{\\nabla} J_{\\alpha}(\\boldsymbol{\\theta}) := \\sum_{i=1}^{p} \\mathbb{E}_{\\pi(x;\\varphi)}\\left[ f(x)\\frac{\\partial}{\\partial\\boldsymbol{\\theta}}\\left(\\mathcal{F}(\\varphi_i)^{-1}\\frac{\\partial\\ln\\mathcal{N}(x_i;\\varphi_{\\theta}(x_{0:i-1}))}{\\partial\\varphi_{\\theta}(x_{0:i-1})}\\right)\\right],$$',
    'where $\\mathcal{F}(\\varphi_i)$ is the Fisher information matrix.',
  ].join('\n');

  assert.equal(looksLikeLatexHeavy(formulaDump), true);
  assert.equal(looksLikeCompactAlgorithm(formulaDump), false);
  assert.equal(recoverAlgorithmFromPlainText(formulaDump), null);

  const formatted = formatAlgorithmsInMarkdown(formulaDump);
  assert.doesNotMatch(formatted, /```algorithm/);
  assert.doesNotMatch(formatted, /^0:\s*i-1/m);
  // Math delimiters preserved.
  assert.match(formatted, /\$\$/);
  assert.match(formatted, /0:i-1/);

  // Bare latex soup without $ (vision failure mode) still must not become steps.
  const bareSoup = [
    '\\partial \\boldsymbol{\\theta} \\left( \\frac{\\partial \\ln \\mathcal{N}(x_i; \\boldsymbol{\\varphi}_{\\boldsymbol{\\theta}}(x_{0:i-1}))}{\\partial \\boldsymbol{\\varphi}_{\\boldsymbol{\\theta}}(x_{0:i-1})} \\right)',
    '\\boldsymbol{\\varphi}_{0:i-1} \\quad (9) \\partial \\ln \\mathcal{N}',
    'C_{\\boldsymbol{\\theta}}(x_{0:i-1}) m_{\\boldsymbol{\\theta}}(x_{0:i-1})',
  ].join(' ');
  assert.equal(looksLikeLatexHeavy(bareSoup), true);
  assert.equal(looksLikeCompactAlgorithm(bareSoup), false);
  assert.doesNotMatch(formatAlgorithmsInMarkdown(bareSoup), /```algorithm/);
  assert.doesNotMatch(formatAlgorithmsInMarkdown(bareSoup), /^0:\s/m);
});

test('reflowCompactAlgorithmLines puts each numbered step on its own line', () => {
  const compact = '1: Begin 2: // 初始化 3: g ← 0; 4: While 未停止 Do 5: End While 6: End';
  const out = reflowCompactAlgorithmLines(compact);
  const lines = out.split('\n');
  assert.ok(lines.length >= 5);
  assert.match(lines[0], /^1:\s*Begin/);
  assert.match(lines[1], /^2:/);
  assert.match(out, /^6:\s*End/m);
  assert.doesNotMatch(out, /1: Begin 2:/);
});

test('reflow handles no-space after colon and fullwidth colon', () => {
  const tight = '1:Begin 2://初始化 3:g←0 4:While true Do 5:End While 6:End';
  const out = reflowCompactAlgorithmLines(tight);
  assert.ok(out.split('\n').length >= 5);
  assert.match(out, /^1:\s*Begin/m);
  assert.match(out, /^4:\s*While/m);

  const fw = '1：Begin 2：//初始化 3：x 4：While Do 5：End While 6：End';
  const out2 = reflowCompactAlgorithmLines(fw);
  assert.ok(out2.split('\n').length >= 5);
  assert.match(out2, /^1:\s*Begin/m);
});

test('indentAlgorithmLines nests If/End bodies', () => {
  const src = [
    '1: Begin',
    '2: If g > 1 Then',
    '3: statement',
    '4: End If',
    '5: End',
  ].join('\n');
  const out = indentAlgorithmLines(src);
  assert.match(out, /^2:\s+If g > 1 Then/m);
  assert.match(out, /^3:\s{2,}statement/m);
  assert.match(out, /^4:\s+End If/m);
  assert.match(out, /^5:\s*End/m);
  const ifLine = out.split('\n').find((l) => /If g > 1 Then/.test(l));
  const stmtLine = out.split('\n').find((l) => /statement/.test(l));
  assert.ok(ifLine && stmtLine);
  assert.ok(stmtLine.indexOf('statement') > ifLine.indexOf('If'));
});

test('indentAlgorithmLines nests For / For-all like paper Algorithm 2', () => {
  const src = [
    '1: Set lmax',
    '2: Choose c1 c2',
    '3: Choose d1 d2',
    '4: For m = 1, ..., M do',
    '5: Set lm to random',
    '6: Update Lm',
    '7: For all lX in Lm do',
    '8: Set lX random',
    '9: End For',
    '10: End For',
    '11: Return Lm',
  ].join('\n');
  const out = indentAlgorithmLines(src);
  const lines = out.split('\n');
  const depth = (line) => {
    const m = line.match(/^\d+:(\s*)/);
    return m ? Math.floor(m[1].length / 2) : 0;
  };
  assert.equal(depth(lines[3]), 0); // For m
  assert.ok(depth(lines[4]) >= 1); // body of outer for
  assert.ok(depth(lines[6]) >= 1); // For all
  assert.ok(depth(lines[7]) >= 2); // body of inner for
  assert.ok(depth(lines[8]) >= 1); // End For inner
  assert.equal(depth(lines[9]), 0); // End For outer
  assert.equal(depth(lines[10]), 0); // Return
});

test('algorithm display restores Chinese keywords and wraps bare LaTeX locally', () => {
  assert.equal(localizeAlgorithmTitle('算法 4 Reproduction'), '算法 4 繁殖');
  assert.equal(localizeAlgorithmKeywords('Require: Pop; return Pop'), '输入： Pop; 返回 Pop');

  const cases = [
    [
      'Require: Pop = {x_1,\\dots,x_N} (种群), \\eta \\in [0,1] (交叉类型参数)',
      '输入： \\(Pop = \\{x_1,\\dots,x_N\\}\\) (种群), \\(\\eta \\in [0,1]\\) (交叉类型参数)',
    ],
    [
      '令 r(\\cdot) 为 1, \\dots, N 的随机排列;',
      '令 \\(r(\\cdot)\\) 为 \\(1, \\dots, N\\) 的随机排列;',
    ],
    [
      'if FE < \\eta \\cdot FE_{\\max} then',
      '如果 \\(FE < \\eta \\cdot FE_{\\max}\\) 则',
    ],
    ["Pop' = Pop' \\cup O;", "\\(Pop' = Pop' \\cup O\\);"],
    ["return Pop'", "返回 \\(Pop'\\)"],
  ];
  for (const [source, expected] of cases) {
    assert.equal(prepareAlgorithmBodyForDisplay(source), expected);
  }

  const alreadyDelimited = 'if $FE < \\eta$ then';
  assert.equal(prepareAlgorithmBodyForDisplay(alreadyDelimited), '如果 $FE < \\eta$ 则');
});

test('formatAlgorithmsInMarkdown wraps compact dumps in algorithm fences', () => {
  const md = [
    '前文。',
    '',
    '### 算法 1 基于 LEO 的 EC 算法',
    '',
    '1: Begin 2: // 初始化 3: g ← 0 4: While true Do 5: x ← 1 6: End While 7: End',
    '',
    '后文。',
  ].join('\n');
  const out = formatAlgorithmsInMarkdown(md);
  assert.match(out, /```algorithm/);
  assert.match(out, /^1:\s*Begin/m);
  assert.match(out, /^7:\s*End/m);
  assert.match(out, /后文/);
});

test('formatAlgorithmsInMarkdown handles title glued to steps (user regression)', () => {
  const md = '算法 1 基于LEO的EC算法 1: Begin 2: //初始化 3: g ← 0; 4: While 未满足停止条件 Do 5: End While 6: End';
  const out = formatAlgorithmsInMarkdown(md);
  assert.match(out, /算法 1 基于LEO的EC算法/);
  assert.match(out, /```algorithm/);
  assert.match(out, /^1:\s*Begin/m);
  assert.match(out, /^4:\s*While/m);
  assert.doesNotMatch(out, /1: Begin 2:/);
});

test('formatAlgorithmsInMarkdown recovers LEO-style long dump', () => {
  const body = '1: Begin 2: // 初始化 3: g ← 0; 4: 初始化种群 5: 随机初始化 6: 初始化 arch 7: While 未满足停止条件 Do 8: g ← g + 1; 9: // 个体进化 10: 采样 r; 11: If g > 1 Then 12: newX ← 学习 13: Else 14: // 传统 15: newX ← 传统 16: End If 17: 评估 18: // 选择 19: 选择 20: // SEP 21: For 每个 i Do 22: If 更优 Then 23: 添加 24: End If 25: End For 26: If 过多 Then 27: 裁剪 28: End If 29: // 更新 30: 训练 31: End While 32: End';
  const md = `算法 1 基于LEO的EC算法\n\n${body}`;
  const out = formatAlgorithmsInMarkdown(md);
  assert.match(out, /```algorithm/);
  assert.match(out, /^1:\s*Begin/m);
  assert.match(out, /^32:\s*End/m);
  assert.doesNotMatch(out.split('```')[1] || '', /1: Begin 2:/);
});

test('formatAlgorithmsInMarkdown never turns references into algorithm blocks', () => {
  const refs = [
    '```algorithm',
    '2022: Wu, X., Zhong, Y., Wu, J., and Tan, R. C. As-LLM: When algorithm selection meets large language model. arXiv preprint arXiv:2311.13184.',
    '2023: Wu, X., Wu, S.-h., Wu, J., Feng, L., and Tan, K. C. Evolutionary computation in the era of large language model. arXiv preprint arXiv:2401.10034.',
    '2024: Xiao, H. and Wang, P. Large language models enabled a search for robotics. arXiv preprint arXiv:2312.01797.',
    '2023: Xin, L., Song, W., Cao, Z., and Zhang, J. Step-wise deep learning models for solving routing problems. IEEE Transactions on Industrial Informatics, 17(7):4861-4871.',
    '```',
  ].join('\n');
  const out = formatAlgorithmsInMarkdown(refs);
  assert.doesNotMatch(out, /```algorithm/u);
  assert.doesNotMatch(out, /^\s*\d{1,3}:\s{2,}/mu);
  assert.match(out, /arXiv:2401\.10034/u);
});

test('four-digit publication years cannot become three-digit algorithm steps', () => {
  const references = 'Wu, X. Paper one. arXiv preprint arXiv:2311.13184, 2022. Zhang, Y. Paper two. IEEE Transactions, 2023. Zhao, Z. Paper three, 2024.';
  const out = formatAlgorithmsInMarkdown(references);
  assert.doesNotMatch(out, /```algorithm/u);
  assert.doesNotMatch(out, /(?:^|\n)0(?:22|23|24):/u);
  assert.match(out, /2022\./u);
  assert.match(out, /2023\./u);
  assert.match(out, /2024\./u);
});

test('splitAlgorithmTitleAndBody and recoverAlgorithmFromPlainText', () => {
  const raw = '算法 1 基于LEO的EC算法 1: Begin 2: // init 3: x 4: While Do 5: End While 6: End';
  const { title, body } = splitAlgorithmTitleAndBody(raw);
  assert.match(title, /算法 1/);
  assert.match(body, /^1:/);
  const recovered = recoverAlgorithmFromPlainText(raw);
  assert.ok(recovered);
  assert.ok(recovered.lines.length >= 5);
  assert.match(recovered.lines[0], /^1:\s*Begin/);
});

test('stripMarkdownNoiseFromAlgorithm removes **keyword** emphasis (user regression)', () => {
  const noisy = [
    '**',
    '1: **Begin**',
    '7: **While** 未满足停止条件 **Do**',
    '11: **If** g > 1 **Then**',
    '16: **End If**',
    '32: **End**',
    '**',
  ].join('\n');
  const clean = stripMarkdownNoiseFromAlgorithm(noisy);
  assert.doesNotMatch(clean, /\*\*/);
  assert.match(clean, /1:\s*Begin/);
  assert.match(clean, /While 未满足停止条件 Do/);
  assert.match(clean, /End If/);
  const recovered = recoverAlgorithmFromPlainText(noisy);
  assert.ok(recovered?.lines?.length >= 4);
  assert.ok(recovered.lines.every((l) => !l.includes('**')));
  assert.equal(prepareAlgorithmDisplayLine('  12: **newX** ← 1'), '12: newX ← 1');
});

test('vision and markdown prompts require algorithm structure preservation', () => {
  const vision = visionSystemPrompt('简体中文');
  assert.match(vision, /Algorithms \/ pseudocode/i);
  assert.match(vision, /```algorithm/);
  assert.match(vision, /NEVER collapse the algorithm/i);
  assert.match(vision, /2 spaces per level/i);
  assert.match(vision, /Require\/Input.*输入/u);
  assert.match(vision, /Return.*返回/u);

  const md = markdownSystemPrompt('简体中文');
  assert.match(md, /algorithm|pseudocode/i);
  assert.match(md, /do not collapse/i);
});
