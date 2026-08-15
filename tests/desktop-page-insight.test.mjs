import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSymbols,
  extractKeyNumbers,
  extractClaimCandidates,
  extractSectionCues,
  buildPageInsight,
  contributionBulletsFromClaims,
  addToCompareQueue,
  removeFromCompareQueue,
  buildBatchComparePrompt,
  normalizeCompareQueue,
} from '../desktop/lib/page-insight.mjs';

test('extractSymbols finds acronyms and camel terms', () => {
  const sym = extractSymbols('We use the MOEA/D framework with HV and IGD+ metrics. ParetoFront is key.');
  const tokens = sym.map((s) => s.token);
  assert.ok(tokens.includes('HV') || tokens.some((t) => /HV|IGD|MOEA/i.test(t)));
  assert.ok(tokens.some((t) => /ParetoFront/i.test(t)));
});

test('extractKeyNumbers skips bare years but keeps percents', () => {
  const nums = extractKeyNumbers('In 2024 accuracy reached 92.5% on DTLZ2 with 0.834 HV.');
  assert.ok(nums.some((n) => n.value.includes('92.5') || n.value.includes('%')));
  assert.ok(!nums.some((n) => n.value === '2024'));
});

test('extractClaimCandidates scores cue sentences higher', () => {
  const text = 'Background noise here. We propose a novel edge-improvement operator for MOCO. Results are shown later.';
  const claims = extractClaimCandidates(text);
  assert.ok(claims.length >= 1);
  assert.match(claims[0].text, /propose|edge/i);
  assert.ok(claims[0].score >= 2);
});

test('buildPageInsight merges source and translation', () => {
  const insight = buildPageInsight({
    page: 3,
    sourceText: 'Abstract. Algorithm 1 uses NSGA-II. HV=0.72',
    translationText: '摘要。本文提出一种改进方法。实验表明 HV 达到 0.72。',
  });
  assert.equal(insight.page, 3);
  assert.ok(insight.sectionCues.includes('摘要') || insight.sectionCues.includes('算法'));
  assert.ok(insight.claims.length >= 1);
  assert.equal(insight.hasTranslation, true);
});

test('contributionBulletsFromClaims compresses claims', () => {
  const bullets = contributionBulletsFromClaims([
    { text: 'We propose a dual-archive strategy for many-objective optimization.' },
    { text: 'Experiments show significant gains on DTLZ.' },
  ]);
  assert.ok(bullets.length >= 1);
  assert.ok(bullets[0].length > 10);
});

test('compare queue add/remove and batch prompt', () => {
  let q = [];
  const r1 = addToCompareQueue(q, { title: 'Paper A', arxivId: '2401.1', summary: 'about A' });
  assert.equal(r1.added, true);
  q = r1.queue;
  const r2 = addToCompareQueue(q, { title: 'Paper A', arxivId: '2401.1' });
  assert.equal(r2.added, false);
  q = addToCompareQueue(q, { title: 'Paper B', arxivId: '2401.2', summary: 'B' }).queue;
  assert.equal(q.length, 2);
  const idA = q.find((x) => x.arxivId === '2401.1').id;
  q = removeFromCompareQueue(q, idA);
  assert.equal(q.length, 1);
  assert.equal(q[0].title, 'Paper B');
  const prompt = buildBatchComparePrompt('My Paper.pdf', q);
  assert.match(prompt, /My Paper/);
  assert.match(prompt, /Paper B/);
  assert.equal(normalizeCompareQueue(null).length, 0);
});
