import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeBibliographyEntry,
  looksLikeBibliographyList,
  normalizeBibliographyMarkdown,
  stripSpuriousBibliographyLineNumbers,
} from '../src/lib/bibliography-format.js';
import { looksLikeCompactAlgorithm } from '../src/lib/algorithm-format.js';
import { visionSystemPrompt, markdownSystemPrompt } from '../src/lib/translator.js';
import { createReadingTranslationPlan } from '../src/lib/structured-translation.js';

test('strips OCR/layout junk numbers before [n] citation markers', () => {
  const dirty = [
    'of Heuristics 19 (4) (2013) 679-',
    '695: [16] Y. Wang, Z. Lü, F. Glover, J. Hao, Probabilistic GRASP-tabu search algorithms for the UBQP problem,',
    '107: [17] Y. Wang, Z. Lü, F. Glover, J. Hao, Path relinking for unconstrained binary quadratic programming,',
    '296:[2] F. Harary, On the notion of balance of a signed graph, Michigan Mathematical Journal 2 (2) (1953) 143-',
  ].join('\n');

  const cleaned = stripSpuriousBibliographyLineNumbers(dirty);
  assert.match(cleaned, /^of Heuristics/m);
  assert.match(cleaned, /^\[16\] Y\. Wang/m);
  assert.match(cleaned, /^\[17\] Y\. Wang/m);
  assert.match(cleaned, /^\[2\] F\. Harary/m);
  assert.doesNotMatch(cleaned, /\d{2,4}\s*:\s*\[/);
});

test('normalizeBibliographyMarkdown yields clean [n] paragraphs', () => {
  const dirty = [
    '## 参考文献',
    '296: [2] F. Harary, On the notion of balance of a signed graph, Michigan Mathematical Journal 2 (2) (1953) 143-146.',
    '146: [3] J. Krarup, P. M. Pruzan, Computer-aided layout design, in: Mathematical Programming in Use, Springer, 1978.',
  ].join('\n');

  const out = normalizeBibliographyMarkdown(dirty);
  assert.match(out, /## 参考文献/);
  assert.match(out, /\[2\] F\. Harary/);
  assert.match(out, /\[3\] J\. Krarup/);
  assert.doesNotMatch(out, /296\s*:/);
  assert.doesNotMatch(out, /146\s*:/);
  // Entries separated for reading.
  assert.match(out, /\[2\][^\n]+\n\n\[3\]/);
});

test('bibliography lists are never treated as compact algorithms', () => {
  const refs = [
    '695: [16] Y. Wang, Z. Lü, F. Glover, J. Hao, Probabilistic GRASP-tabu search algorithms for the UBQP problem, Computers & Operations Research 40 (12) (2013) 3100-3.',
    '107: [17] Y. Wang, Z. Lü, F. Glover, J. Hao, Path relinking for unconstrained binary quadratic programming, European Journal of Operational Research 223 (3) (2012) 595-.',
    '604: [18] I. Borgulya, An evolutionary algorithm for the unconstrained binary quadratic problems, Springer, 2005.',
    '16: [19] A. Lodi, K. Allemand, T. M. Liebling, An evolutionary heuristic for quadratic 0-1 programming, European Journal of Operational Research 119 (3) (1999) 662-.',
  ].join('\n');

  assert.equal(looksLikeBibliographyList(refs), true);
  assert.equal(looksLikeCompactAlgorithm(refs), false);
  assert.equal(looksLikeBibliographyEntry(refs.split('\n')[0]), true);
});

test('year-led arXiv references are not pseudocode and code fences are removed', () => {
  const refs = [
    'thought prompting elicits reasoning in large language models. Advances in Neural Information Processing Systems 35: 24824-24837, 2022.',
    '2022: Wu, X., Zhong, Y., Wu, J., and Tan, R. C. As-LLM: When algorithm selection meets large language model. arXiv preprint arXiv:2311.13184.',
    '2023: Wu, X., Wu, S.-h., Wu, J., Feng, L., and Tan, K. C. Evolutionary computation in the era of large language model: Survey and roadmap. arXiv preprint arXiv:2401.10034.',
    '2024: Xiao, H. and Wang, P. Large language models enabled a search for robotics. arXiv preprint arXiv:2312.01797.',
  ].join('\n');
  assert.equal(looksLikeBibliographyList(refs), true);
  assert.equal(looksLikeCompactAlgorithm(refs), false);

  const normalized = normalizeBibliographyMarkdown(`\`\`\`algorithm\n${refs}\n\`\`\``);
  assert.doesNotMatch(normalized, /```/u);
  assert.match(normalized, /Wu, X\./u);
  assert.match(normalized, /arXiv:2401\.10034/u);
  assert.match(normalized, /2022:[^\n]+\n\n2023:/u);
  assert.match(normalized, /2023:[^\n]+\n\n2024:/u);

  const single = 'Xu, W., Banburski-Fahey, A., and Jojic, N. Reprompting: Automated chain-of-thought prompt inference through Gibbs sampling. arXiv preprint arXiv:2305.09993, 2023b.';
  const singleNormalized = normalizeBibliographyMarkdown(`\`\`\`algorithm\n${single}\n\`\`\``);
  assert.doesNotMatch(singleNormalized, /```/u);
  assert.equal(singleNormalized, single);
});

test('inline body citations are not mistaken for bibliography entries', () => {
  assert.equal(looksLikeBibliographyEntry('see [12] for details.'), false);
  assert.equal(looksLikeBibliographyEntry('The method follows prior work [30].'), false);
  assert.equal(
    looksLikeBibliographyEntry(
      '[24] M. Ehrgott, Multicriteria optimization, 2nd Edition, Springer, 2005.',
    ),
    true,
  );
});

test('structured reading plan keeps bibliography entries as source (no LLM slot)', () => {
  const plan = createReadingTranslationPlan({
    index: 12,
    width: 595,
    height: 842,
    images: {},
    blocks: [
      {
        id: 'p12-h',
        kind: 'heading',
        text: 'References',
        segments: [{ id: 'p12-h-s0', kind: 'text', text: 'References' }],
      },
      {
        id: 'p12-r1',
        kind: 'paragraph',
        text: '[1] F. Harary, On the notion of balance of a signed graph, Michigan Mathematical Journal 2 (2) (1953) 143-146.',
        segments: [{
          id: 'p12-r1-s0',
          kind: 'text',
          text: '[1] F. Harary, On the notion of balance of a signed graph, Michigan Mathematical Journal 2 (2) (1953) 143-146.',
        }],
      },
      {
        id: 'p12-r2',
        kind: 'paragraph',
        text: '[2] M. Ehrgott, Multicriteria optimization, 2nd Edition, Springer, 2005.',
        segments: [{
          id: 'p12-r2-s0',
          kind: 'text',
          text: '[2] M. Ehrgott, Multicriteria optimization, 2nd Edition, Springer, 2005.',
        }],
      },
      {
        id: 'p12-body',
        kind: 'paragraph',
        text: 'We compare with prior multiobjective optimizers.',
        segments: [{
          id: 'p12-body-s0',
          kind: 'text',
          text: 'We compare with prior multiobjective optimizers.',
        }],
      },
    ],
  });

  const ids = plan.items.map((item) => item.id);
  // Heading + body prose still translate; bibliography stays source-only so the
  // first entry is never "lost" to a failed LLM slot / purple skeleton.
  assert.ok(ids.includes('p12-h'));
  assert.ok(ids.includes('p12-body'));
  assert.ok(!ids.includes('p12-r1'));
  assert.ok(!ids.includes('p12-r2'));
});

test('vision and markdown prompts require clean [n] bibliography form and first entry', () => {
  const vision = visionSystemPrompt('简体中文');
  assert.match(vision, /References \/ bibliography/i);
  assert.match(vision, /NEVER prefix fake line numbers/i);
  assert.match(vision, /first COMPLETE reference/i);
  assert.match(vision, /NOT algorithms/i);
  assert.match(vision, /\[16\] Y\. Wang/);

  const md = markdownSystemPrompt('简体中文');
  assert.match(md, /Bibliography entries are NOT algorithms/i);
  assert.match(md, /never drop the first complete \[n\]/i);
});
