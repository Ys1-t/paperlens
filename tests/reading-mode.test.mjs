import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessVisionTranslationQuality,
  buildVisionTranslationContext,
  createFormulaBatchRequest,
  createFormulaRequest,
  describeVisionQualityIssue,
  escapeHtmlText,
  finalizeReadingTranslation,
  getReadingMediaPresentation,
  neutralizeRawHtml,
  parseFormulaBatchTranscription,
  parseFormulaTranscription,
  sanitizeMarkedHtml,
  selectVisionRenderWidth,
  shouldAutoRefineVisionQuality,
  stripTrailingModelSelfTalk,
  transitionPageOutcome,
} from '../src/lib/reading-mode.js';

test('assessVisionTranslationQuality rejects self-talk and repetition loops', () => {
  assert.equal(assessVisionTranslationQuality('正常的中文译文，包含算法和公式。').ok, true);
  const loop = Array.from({ length: 20 }, () => 'Wait, it\'s O(M(k_D!)^2)? No, it\'s ').join('');
  const bad = assessVisionTranslationQuality(loop);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /重试|异常|自言自语|循环/);

  const meta = assessVisionTranslationQuality([
    'Wait, let me look at the image again.',
    'Let me check the formula.',
    'Wait, it is O(M).',
    'Wait no.',
  ].join(' '));
  assert.equal(meta.ok, false);
});

test('vision quality gate catches English residue, damaged math and bare LaTeX', () => {
  const english = assessVisionTranslationQuality([
    '### 方法',
    '本文先定义优化目标。',
    'This entire paragraph remains untranslated even though it contains many ordinary English words and should have been converted into the requested target language for comfortable reading.',
    'Another complete English paragraph also remains in the result and demonstrates that the visual translation skipped a substantial region of prose on this page.',
  ].join('\n\n'));
  assert.equal(english.ok, false);
  assert.ok(english.reasons.includes('english-residual'));

  const delimiter = assessVisionTranslationQuality('目标函数为 $f(x，并使用中文继续解释。');
  assert.equal(delimiter.ok, false);
  assert.ok(delimiter.reasons.includes('math-delimiter-damaged'));

  const bare = assessVisionTranslationQuality('梯度写成 \\partial f / \\partial x，随后使用 \\frac{a}{b} 更新。');
  assert.equal(bare.ok, false);
  assert.ok(bare.reasons.includes('bare-latex'));
});

test('vision quality gate ignores English references on a mixed conclusion page', () => {
  const mixedPage = assessVisionTranslationQuality([
    '## 6 结论',
    '本文提出了一种个性化联邦学习方法。实验结果表明，该方法在多个数据集上具有稳定表现。',
    '',
    '## 致谢',
    '本论文的工作得到了 NSF ECCS 2207457 和 NSF ECCS 2412484 的支持。',
    '',
    '## 参考文献',
    '[1] Durmus Alp Emre Acar, Yue Zhao, Ruizhao Zhu, Ramon Matas, Matthew Mattina, Paul Whatmough, and Venkatesh Saligrama. Debiasing model updates for improving personalized federated training. Proceedings of International Conference on Machine Learning, 2021.',
    '[2] Noga Alon, Nicolo Cesa-Bianchi, Claudio Gentile, Shie Mannor, Yishay Mansour, and Ohad Shamir. Nonstochastic multi-armed bandits with graph-structured feedback. SIAM Journal on Computing, 2017.',
    '[3] Peter Auer, Nicolo Cesa-Bianchi, Yoav Freund, and Robert Schapire. The nonstochastic multiarmed bandit problem. SIAM Journal on Computing, 2003.',
  ].join('\n'));

  assert.equal(mixedPage.ok, true);
  assert.ok(mixedPage.metrics.ignoredBibliographyChars > 300);
  assert.equal(mixedPage.reasons.includes('english-residual'), false);
});

test('vision quality gate still catches untranslated body text before references', () => {
  const mixedPage = assessVisionTranslationQuality([
    '## 6 结论',
    '这里只翻译了一句。',
    'This complete body paragraph remains untranslated and contains enough ordinary English prose to indicate a genuine omission in the translated conclusion section of the paper.',
    'Another substantial body paragraph is also left in English even though it belongs to the conclusion rather than the protected bibliography section below.',
    '',
    '## References',
    '[1] A. Author, A complete English paper title, Journal 10, 2024.',
    '[2] B. Author, Another English paper title, Proceedings of a Conference, 2023.',
  ].join('\n'));

  assert.equal(mixedPage.ok, false);
  assert.ok(mixedPage.reasons.includes('english-residual'));
});

test('vision quality gate uses native PDF text only as conservative coverage evidence', () => {
  const sourceText = 'A long source paragraph about optimization and experimental analysis. '.repeat(30);
  const result = assessVisionTranslationQuality('只有一句译文。', { sourceText });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('source-coverage-low'));

  const bibliography = assessVisionTranslationQuality([
    '# 参考文献',
    '[1] A. Author, A complete English paper title, Journal 10 (2024) 1-10.',
    '[2] B. Author, Another English paper title, arXiv:2401.00001.',
    '[3] C. Author, Method and experiments, doi:10.1000/example.',
  ].join('\n\n'), { sourceText });
  assert.equal(bibliography.ok, true);
});

test('vision retry context carries failure reasons and a bounded source hint', () => {
  const context = buildVisionTranslationContext({
    sourceText: `Title\n${'source text '.repeat(1000)}`,
    quality: {
      ok: false,
      reason: 'english-residual',
      reasons: ['english-residual', 'math-delimiter-damaged'],
      message: '需要重试',
    },
  });
  assert.match(context, /PAPERLENS_VISION_CONTEXT_V3/u);
  assert.match(context, /VISION_QUALITY_RETRY/u);
  assert.match(context, /english-residual,math-delimiter-damaged/u);
  assert.match(context, /SOURCE_TEXT_HINT_BEGIN/u);
  assert.ok(context.length < 5700);
});

test('vision quality gate rejects refusals, broken fences and unbalanced formula braces', () => {
  const refusal = assessVisionTranslationQuality('抱歉，我无法完成这个页面的翻译请求。');
  assert.ok(refusal.reasons.includes('model-refusal'));

  const fence = assessVisionTranslationQuality('```algorithm\n1: 初始化\n2:   返回结果');
  assert.ok(fence.reasons.includes('code-fence-damaged'));

  const braces = assessVisionTranslationQuality('目标函数为 $\\frac{a}{b$，随后更新参数。');
  assert.ok(braces.reasons.includes('math-brace-damaged'));
});

test('vision quality gate enforces algorithm indentation and figure/table location tokens', () => {
  const source = [
    'Algorithm 1: Local Search. Input population. Output best solution.',
    'Initialize archive. For each solution, while condition, return archive.',
    'Figure 2: Architecture of the proposed model.',
    'Table 3: Main experimental results.',
  ].join(' ');
  const bad = assessVisionTranslationQuality('### 算法 1\n1: 初始化 2: 返回结果\n\n图 2：模型架构。\n\n表 3：实验结果。', { sourceText: source });
  assert.ok(bad.reasons.includes('algorithm-structure-damaged'));
  assert.ok(bad.reasons.includes('figure-structure-missing'));
  assert.ok(bad.reasons.includes('table-structure-missing'));

  const structured = assessVisionTranslationQuality([
    '### 算法 1：局部搜索',
    '```algorithm',
    '1: 初始化档案',
    '2:   对每个解执行更新',
    '3: 返回档案',
    '```',
    '@@FIGURE@@',
    '**图 2**：所提模型的架构。',
    '@@TABLE@@',
    '**表 3**：主要实验结果。',
  ].join('\n'), { sourceText: source });
  assert.equal(structured.reasons.includes('algorithm-structure-damaged'), false);
  assert.equal(structured.reasons.includes('figure-structure-missing'), false);
  assert.equal(structured.reasons.includes('table-structure-missing'), false);
});

test('vision quality gate preserves PDF citation, equation, numeric and term anchors', () => {
  const sourceText = [
    'This page explains the complete experimental protocol and reports detailed measurements. '.repeat(8),
    'Prior work [1] and [2] defines equations (1) and (2).',
    'The score is 12.5 and the improvement is 90%.',
    'CIFAR-10 is optimized with SGD and evaluated by DTLZ2.',
  ].join(' ');
  const result = assessVisionTranslationQuality('本页完整说明实验协议，并给出了详细的测量与分析结果。'.repeat(12), { sourceText });
  assert.ok(result.reasons.includes('citation-anchor-loss'));
  assert.ok(result.reasons.includes('equation-number-loss'));
  assert.ok(result.reasons.includes('numeric-anchor-loss'));
  assert.ok(result.reasons.includes('term-anchor-loss'));
  assert.deepEqual(result.metrics.missingAnchors.citations, ['[1]', '[2]']);
});

test('abstract contribution numbering is not mistaken for equation numbers', () => {
  const sourceText = [
    'We make three contributions: (1) a stable training pipeline, (2) a scalable model, and (3) a fast implementation.',
    'This abstract discusses evolution strategies, GPU training, and reinforcement learning. '.repeat(8),
  ].join(' ');
  const result = assessVisionTranslationQuality(
    '本文总结了三项贡献，并详细讨论了演化策略、GPU 训练与强化学习。'.repeat(12),
    { sourceText },
  );
  assert.equal(result.reasons.includes('equation-number-loss'), false);
  assert.deepEqual(result.metrics.missingAnchors.equationNumbers, []);
});

test('equation tags satisfy native PDF equation-number anchors', () => {
  const sourceText = [
    'The derivation defines equations (1) and (2).',
    'This page provides a detailed mathematical derivation and explanatory discussion. '.repeat(8),
  ].join(' ');
  const output = [
    '本页给出了完整的数学推导与说明。'.repeat(12),
    '$$a=b\\tag{1}$$',
    '$$c=d\\tag{2}$$',
  ].join('\n');
  const result = assessVisionTranslationQuality(output, { sourceText });
  assert.equal(result.reasons.includes('equation-number-loss'), false);
  assert.equal(result.metrics.anchorCoverage.equationNumbers, 1);
});

test('quality notice describes the exact missing anchors being refined', () => {
  assert.equal(describeVisionQualityIssue({
    reason: 'equation-number-loss',
    metrics: { missingAnchors: { equationNumbers: ['(12)', '(13)'] } },
  }), '疑似缺少方程编号：(12)、(13)');
});

test('vision rendering width only increases for dense or failed pages', () => {
  assert.equal(selectVisionRenderWidth({ sourceChars: 800 }), 1500);
  assert.equal(selectVisionRenderWidth({ sourceChars: 3000 }), 1640);
  assert.equal(selectVisionRenderWidth({ sourceChars: 4600 }), 1780);
  assert.equal(selectVisionRenderWidth({ sourceChars: 800, qualityRetry: true }), 2050);
});

test('readable quality warnings never auto-refine a page', () => {
  for (const reason of [
    'english-residual',
    'equation-number-loss',
    'source-coverage-low',
    'algorithm-structure-damaged',
    'math-delimiter-damaged',
    'target-language-missing',
  ]) {
    assert.equal(shouldAutoRefineVisionQuality({ reason, reasons: [reason] }), false, reason);
  }
  assert.equal(shouldAutoRefineVisionQuality({ reasons: ['model-refusal'] }), true);
  assert.equal(shouldAutoRefineVisionQuality({ reasons: ['english-residual', 'model-self-talk'] }), true);
  assert.equal(shouldAutoRefineVisionQuality({ reasons: ['repetition-loop'] }), true);
});

test('stripTrailingModelSelfTalk keeps the translation prefix', () => {
  const text = [
    '### 方法',
    '本文提出一种新算法。',
    '',
    'Wait, let me look at the image again. Actually the formula is O(n).',
  ].join('\n');
  const cleaned = stripTrailingModelSelfTalk(text);
  assert.match(cleaned, /本文提出一种新算法/);
  assert.doesNotMatch(cleaned, /Wait, let me/);
});

test('finalizeReadingTranslation strips trailing self-talk from full stream', () => {
  const out = finalizeReadingTranslation(
    '前文',
    '完整中文译文内容足够长。\n\nWait, let me check again. No it\'s wrong.',
  );
  assert.match(out, /完整中文译文/);
  assert.doesNotMatch(out, /Wait, let me/);
});

test('parses fenced JSON formula transcription', () => {
  assert.deepEqual(
    parseFormulaTranscription('```json\n{"latex":"\\\\sum_{i=1}^n x_i","number":"(21)"}\n```'),
    { latex: '\\sum_{i=1}^n x_i', number: '(21)' },
  );
});

test('accepts raw LaTeX and strips display delimiters', () => {
  assert.deepEqual(parseFormulaTranscription('$$x^2 + y^2$$'), {
    latex: 'x^2 + y^2',
    number: '',
  });
});

test('rejects empty, prose, and unbalanced formula output', () => {
  assert.equal(parseFormulaTranscription(''), null);
  assert.equal(parseFormulaTranscription('This formula means x plus y.'), null);
  assert.equal(parseFormulaTranscription('\\frac{a}{b'), null);
});

test('canonicalizes OCR norm bars but rejects the flattened D4L pseudo-LaTeX', () => {
  const sourceText = '//∇θkEλk∼Λkg(hθ(t)(λk)|λk)//2 ≥ 0';
  assert.equal(
    parseFormulaTranscription(JSON.stringify({ latex: sourceText, number: '' }), { sourceText }),
    null,
  );

  const corrected = String.raw`-\eta \lVert \nabla_{\theta_k} \mathbb{E}_{\lambda_k \sim \Lambda_k} g(h_{\theta^{(t)}}(\lambda_k) \mid \lambda_k) \rVert_2 \ge 0`;
  assert.deepEqual(
    parseFormulaTranscription(JSON.stringify({ latex: corrected, number: '(20)' }), { sourceText }),
    { latex: corrected, number: '(20)' },
  );
});

test('parses the real D4L equation 17 with squared norms instead of forcing L2 subscripts', () => {
  const sourceText = '≈∇θshL(θ(t)) · ∆θsh + O(∥∆θ(t+1)sh∥2) K '
    + '=Ppk · ∇θshEλk∼Λkg(hθ(t)(λk)|λk) · ∆θsh + O(∥∆θ(t+1)sh∥2), k=1';
  const visionLatex = String.raw`\approx \nabla_{\theta_{sh}} \mathcal{L}(\theta^{(t)}) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right) = \sum_{k=1}^{K} p_k \cdot \nabla_{\theta_{sh}} \mathbb{E}_{\lambda_k \sim \Lambda_k} g\!\left(h_{\theta^{(t)}}(\lambda_k)\mid\lambda_k\right) \cdot \Delta\theta_{sh} + O\!\left(\left\|\Delta\theta_{sh}^{(t+1)}\right\|^2\right),`;
  const parsed = parseFormulaTranscription(
    JSON.stringify({ latex: visionLatex, number: '(17)' }),
    { sourceText },
  );
  assert.equal(parsed.number, '(17)');
  assert.match(parsed.latex, /\\left\\lVert/);
  assert.match(parsed.latex, /\\right\\rVert\^2/);
});

test('formula sprite response is mapped by stable IDs instead of array order', () => {
  const parsed = parseFormulaBatchTranscription(JSON.stringify({
    items: [
      { id: 'p4-eq1', latex: '\\sum_{i=1}^m x_i', number: '(8)' },
      { id: 'unknown', latex: 'z', number: '' },
      { id: 'p4-eq0', latex: 'x(\\lambda)=h_\\theta(\\lambda)', number: '(7)' },
    ],
  }), ['p4-eq0', 'p4-eq1', 'p4-eq2']);
  assert.deepEqual(parsed.items, [
    { id: 'p4-eq1', latex: '\\sum_{i=1}^m x_i', number: '(8)' },
    { id: 'p4-eq0', latex: 'x(\\lambda)=h_\\theta(\\lambda)', number: '(7)' },
  ]);
  assert.deepEqual(parsed.missingIds, ['p4-eq2']);
  assert.deepEqual(parsed.unknownIds, ['unknown']);
  assert.deepEqual(parsed.rejectedIds, []);
  assert.equal(parseFormulaBatchTranscription('not json', ['p4-eq0']), null);
});

test('formula sprite quality gate uses the source_text hint per stable ID', () => {
  const sourceText = '//∇θkEλk∼Λkg(hθ(t)(λk)|λk)//2 ≥ 0';
  const parsed = parseFormulaBatchTranscription(JSON.stringify({
    items: [{ id: 'eq-20', latex: sourceText, number: '(20)' }],
  }), [{ id: 'eq-20', source_text: sourceText }]);
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.missingIds, ['eq-20']);
  assert.deepEqual(parsed.rejectedIds, ['eq-20']);
});

test('reading mode turns images into source references', () => {
  assert.deepEqual(
    getReadingMediaPresentation({ kind: 'image', name: 'fig.png' }),
    { type: 'source-ref', label: '查看左侧原图' },
  );
});

test('reading mode prefers LaTeX and falls back to the formula crop', () => {
  assert.deepEqual(
    getReadingMediaPresentation(
      { kind: 'formula', name: 'eq.png' },
      { formulaState: { status: 'done', latex: 'x^2', number: '(3)' } },
    ),
    { type: 'latex', latex: 'x^2', number: '(3)' },
  );

  assert.deepEqual(
    getReadingMediaPresentation(
      { kind: 'formula', name: 'eq.png' },
      {
        formulaState: { status: 'failed' },
        imageUrl: 'data:image/png;base64,abc',
      },
    ),
    { type: 'formula-image', imageUrl: 'data:image/png;base64,abc' },
  );
});

test('service-provided LaTeX has priority and empty completed OCR falls back', () => {
  assert.deepEqual(
    getReadingMediaPresentation(
      { kind: 'formula', name: 'eq.png', latex: '\\alpha + \\beta', number: '(8)' },
      { formulaState: { status: 'pending' } },
    ),
    { type: 'latex', latex: '\\alpha + \\beta', number: '(8)' },
  );

  assert.deepEqual(
    getReadingMediaPresentation(
      { kind: 'formula', name: 'eq.png' },
      {
        formulaState: { status: 'done', latex: '' },
        imageUrl: 'data:image/png;base64,abc',
      },
    ),
    { type: 'formula-image', imageUrl: 'data:image/png;base64,abc' },
  );
});

test('reading mode reports pending and source-only formula states', () => {
  assert.deepEqual(
    getReadingMediaPresentation({ kind: 'formula', name: 'eq.png' }),
    { type: 'pending', label: '公式识别中…' },
  );

  assert.deepEqual(
    getReadingMediaPresentation(
      { kind: 'formula', name: 'eq.png' },
      { formulaState: { status: 'failed' } },
    ),
    { type: 'source-ref', label: '查看左侧公式' },
  );
});

test('formula request uses the dedicated protocol flag and source hint', () => {
  assert.deepEqual(createFormulaRequest(7, 'data:image/png;base64,abc', '∥x∥2'), {
    type: 'translate',
    id: 7,
    image: 'data:image/png;base64,abc',
    text: '∥x∥2',
    formula: true,
    priority: false,
  });
});

test('formula sprite request uses one page-level OCR protocol flag', () => {
  assert.deepEqual(
    createFormulaBatchRequest(8, 'data:image/png;base64,sprite', [
      { id: 'p4-eq0', source_text: 'x(λ)=hθ(λ)' },
      { id: 'p4-eq1', source_text: '∑mi=1 xi' },
    ]),
    {
      type: 'translate',
      id: 8,
      image: 'data:image/png;base64,sprite',
      text: '{"formulas":[{"id":"p4-eq0","source_text":"x(λ)=hθ(λ)"},{"id":"p4-eq1","source_text":"∑mi=1 xi"}]}',
      formulaBatch: true,
      priority: false,
    },
  );
});

test('cached final translation becomes the persistent render source', () => {
  assert.equal(finalizeReadingTranslation('', '缓存中的完整译文'), '缓存中的完整译文');
  assert.equal(finalizeReadingTranslation('流式部分译文', ''), '流式部分译文');
});

test('page outcome transitions keep done and failed counts mutually consistent', () => {
  const page = {};
  assert.deepEqual(transitionPageOutcome(page, 'done'), { doneDelta: 1, failedDelta: 0 });
  assert.deepEqual(transitionPageOutcome(page, 'done'), { doneDelta: 0, failedDelta: 0 });
  assert.deepEqual(transitionPageOutcome(page, 'failed'), { doneDelta: -1, failedDelta: 1 });
  assert.deepEqual(transitionPageOutcome(page, 'done'), { doneDelta: 1, failedDelta: -1 });
  assert.deepEqual(transitionPageOutcome(page, 'partial'), { doneDelta: -1, failedDelta: 0 });
  assert.deepEqual(transitionPageOutcome(page, 'partial'), { doneDelta: 0, failedDelta: 0 });
  assert.deepEqual(transitionPageOutcome(page, 'failed'), { doneDelta: 0, failedDelta: 1 });
  assert.deepEqual(transitionPageOutcome(page, 'partial'), { doneDelta: 0, failedDelta: -1 });
  assert.deepEqual(transitionPageOutcome(page, 'done'), { doneDelta: 1, failedDelta: 0 });
});

test('raw HTML and unsafe Markdown URLs are neutralized', () => {
  assert.equal(neutralizeRawHtml('<form action="/x">x</form> and x < y'), '&lt;form action="/x">x&lt;/form> and x < y');
  const sanitized = sanitizeMarkedHtml('<a href="javascript:alert(1)">bad</a><img src="https://evil/x.png"><a href="https://safe.example">ok</a>');
  assert.doesNotMatch(sanitized, /javascript:|https:\/\/evil/);
  assert.match(sanitized, /href="https:\/\/safe\.example"/);
  assert.equal(escapeHtmlText('"quoted" and \'single\''), '&quot;quoted&quot; and &#39;single&#39;');
  const unquoted = sanitizeMarkedHtml('<img src=https://evil.example/pixel><a href=javascript:alert(1)>x</a>');
  assert.doesNotMatch(unquoted, /https:\/\/evil|javascript:/);
});
