import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAPER_RETRIEVAL_VERSION,
  auditAnswerCitations,
  buildEvidencePack,
  buildPriorEvidenceBrief,
  chunkPaperPages,
  compactResearchDialogue,
  createPaperSearchIndex,
  expandEvidenceWithNeighbors,
  extractPageCitations,
  retrievePaperEvidence,
  normalizeEvidenceItems,
  scoreEvidenceSupport,
  tokenizePaperText,
} from '../src/lib/paper-retrieval.js';

const pages = [
  {
    page: 1,
    sourceType: 'translation',
    status: '已完成',
    text: '# 引言\n\n本文研究多目标组合优化，并总结主要贡献。',
  },
  {
    page: 2,
    sourceType: 'source',
    status: '等待翻译',
    text: '[未译·原文] The policy gradient estimator reduces variance with a learned baseline.',
  },
  {
    page: 3,
    sourceType: 'translation',
    status: '已完成',
    text: '## 复杂度分析\n\n该算法的时间复杂度随种群规模 N 和目标数 M 增长。实验使用 DTLZ2。',
  },
  {
    page: 4,
    sourceType: 'translation',
    status: '已完成',
    text: '## 消融实验\n\n移除 learned baseline 后方差明显增加。',
  },
];

test('mixed-language tokenizer keeps Chinese terms, English stems, acronyms and numbers', () => {
  const tokens = tokenizePaperText('复杂度分析: learned policies on DTLZ2, 3 objectives', { query: true });
  assert.ok(tokens.includes('复杂度'));
  assert.ok(tokens.includes('复杂'));
  assert.ok(tokens.includes('learned'));
  assert.ok(tokens.includes('learn'));
  assert.ok(tokens.includes('dtlz2'));
  assert.ok(tokens.includes('3'));
});

test('page chunking preserves page and source provenance', () => {
  const chunks = chunkPaperPages(pages, { maxChars: 260, overlapChars: 40 });
  assert.ok(chunks.length >= pages.length);
  assert.equal(chunks.find((chunk) => chunk.page === 2).sourceType, 'source');
  assert.equal(chunks.find((chunk) => chunk.page === 3).heading, '复杂度分析');
  assert.ok(chunks.every((chunk) => /^p\d+-c\d+$/u.test(chunk.id)));
});

test('BM25 evidence retrieval ranks exact Chinese heading and supports English source', () => {
  const index = createPaperSearchIndex(pages);
  assert.equal(index.version, PAPER_RETRIEVAL_VERSION);
  const complexity = retrievePaperEvidence(index, '算法复杂度', { currentPage: 1 });
  assert.equal(complexity[0].page, 3);
  assert.equal(complexity[0].sourceType, 'translation');

  const baseline = retrievePaperEvidence(index, 'policy gradient variance baseline');
  assert.equal(baseline[0].page, 2);
  assert.equal(baseline[0].sourceType, 'source');
});

test('retrieval deduplicates pages and current page is only a bounded bonus', () => {
  const dense = [{
    page: 8,
    text: `${'强化学习策略梯度与方差。'.repeat(120)}\n\n${'baseline estimator '.repeat(100)}`,
  }, ...pages];
  const results = retrievePaperEvidence(createPaperSearchIndex(dense, { maxChars: 320 }), '策略梯度方差', {
    currentPage: 1,
    maxPages: 5,
  });
  assert.equal(new Set(results.map((item) => item.page)).size, results.length);
  assert.equal(results[0].page, 8);
});

test('neighbor expansion remains labelled and bounded', () => {
  const seed = retrievePaperEvidence(pages, '复杂度', { maxPages: 1 });
  const expanded = expandEvidenceWithNeighbors(seed, pages, { radius: 1, maxPages: 3 });
  assert.deepEqual(expanded.map((item) => item.page), [3, 2, 4]);
  assert.equal(expanded[1].neighborOf, 3);
  assert.equal(expanded[1].sourceType, 'source');
});

test('evidence pack declares pages and original/translation provenance', () => {
  const results = retrievePaperEvidence(pages, 'baseline 方差', { maxPages: 4 });
  const pack = buildEvidencePack(results, { query: 'baseline 方差' });
  assert.ok(pack.pages.includes(2));
  assert.ok(pack.sourceTypes.includes('source'));
  assert.match(pack.text, /本地证据/u);
  assert.match(pack.text, /第 2 页 · PDF 原文/u);
});

test('citation audit rejects out-of-document and unconsulted page claims', () => {
  const answer = '方法定义见第 3 页，实验见第 7 页，附录见第 99 页。第 3 页给出复杂度。';
  assert.deepEqual(extractPageCitations(answer), [3, 7, 99]);
  const audit = auditAnswerCitations(answer, {
    totalPages: 10,
    evidencePages: [3],
    consultedPages: [4],
  });
  assert.deepEqual(audit.supportedPages, [3]);
  assert.deepEqual(audit.unsupportedPages, [7]);
  assert.deepEqual(audit.invalidPages, [99]);
  assert.equal(audit.coverage, 0.333);
  assert.equal(audit.ok, false);
});

test('citation audit marks fully grounded answers as verified', () => {
  const audit = auditAnswerCitations('核心方法在第 2 页，消融结果在第 4 页。', {
    totalPages: 4,
    evidencePages: [2, 4],
  });
  assert.equal(audit.ok, true);
  assert.equal(audit.coverage, 1);
});

test('older research turns are compacted while recent dialogue stays verbatim', () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `第 ${index + 1} 轮内容，参考第 ${Math.min(4, index + 1)} 页。${'细节'.repeat(40)}`,
  }));
  const compacted = compactResearchDialogue(turns, { maxTurns: 10, recentTurns: 6, digestEntryChars: 40 });
  assert.equal(compacted.length, 7);
  assert.match(compacted[0].content, /本地压缩记录/u);
  assert.match(compacted[0].content, /涉及页/u);
  assert.deepEqual(compacted.slice(1), turns.slice(-6));
});

test('evidence items are bounded, deduplicated and safe for history rendering', () => {
  const items = normalizeEvidenceItems([
    { page: 3, sourceType: 'translation', snippet: '  复杂度分析。  ', score: 4.23456, termCoverage: 1.4 },
    { page: 3, sourceType: 'translation', snippet: '复杂度分析。', score: 9 },
    { page: 4, sourceType: 'source', snippet: 'Ablation details.', score: 2, neighborOf: 3 },
    { page: -1, snippet: 'bad' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].score, 4.235);
  assert.equal(items[0].termCoverage, 1);
  assert.equal(items[1].sourceType, 'source');
  assert.equal(items[1].neighborOf, 3);
});

test('evidence support score distinguishes grounded and ungrounded answers', () => {
  const strong = scoreEvidenceSupport({
    audit: { coverage: 1, citedPages: [2, 3], invalidPages: [], unsupportedPages: [] },
    items: [
      { page: 2, snippet: 'method evidence', score: 7, termCoverage: 0.9 },
      { page: 3, snippet: 'experiment evidence', score: 6, termCoverage: 0.8 },
      { page: 4, snippet: 'neighbor context', score: 2, termCoverage: 0.4 },
      { page: 5, snippet: 'limitation evidence', score: 4, termCoverage: 0.6 },
    ],
  });
  const weak = scoreEvidenceSupport({
    audit: { coverage: 0, citedPages: [], invalidPages: [], unsupportedPages: [] },
    items: [{ page: 2, snippet: 'one weak result', score: 0.2, termCoverage: 0.1 }],
  });
  assert.equal(strong.level, 'strong');
  assert.ok(strong.score >= 78);
  assert.equal(weak.level, 'weak');
  assert.ok(weak.reasons.includes('回答未标注页码'));
});

test('prior evidence brief rehydrates snippets but not old assistant conclusions', () => {
  const history = [{
    role: 'assistant',
    content: '这是助手自己的旧结论，不应进入证据摘要。',
    evidence: {
      items: [
        { page: 3, sourceType: 'translation', snippet: '论文原始证据片段。', score: 3 },
        { page: 4, sourceType: 'source', snippet: 'Original evidence excerpt.', score: 2 },
      ],
    },
  }];
  const brief = buildPriorEvidenceBrief(history);
  assert.deepEqual(brief.pages, [3, 4]);
  assert.match(brief.text, /上轮已查阅证据/u);
  assert.match(brief.text, /论文原始证据片段/u);
  assert.doesNotMatch(brief.text, /助手自己的旧结论/u);
});
