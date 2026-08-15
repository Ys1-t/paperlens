import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESEARCH_AGENT_MAX_HISTORY_TURNS,
  RESEARCH_AGENT_MAX_ROUNDS,
  RESEARCH_TOOLS,
  assembleAgentDialogueTurns,
  buildAgentBootstrap,
  buildContextualEvidenceQuery,
  defaultResearchAgentStarters,
  dedupeResearchToolCalls,
  detectPageAnchor,
  executeResearchTool,
  formatToolResultsForModel,
  parseAgentResponse,
  researchAgentSystemPrompt,
} from '../src/lib/research-agent.js';

const provider = {
  getPaperMeta: () => ({
    title: 'Demo Paper',
    totalPages: 10,
    translatedCount: 4,
    currentPage: 2,
  }),
  getCurrentPage: () => ({ page: 2, status: '已完成', text: '当前页讲了方法概述。' }),
  getPage: (n) => ({ page: n, status: '已完成', text: `第 ${n} 页正文内容` }),
  gotoPage: (n) => ({ page: n, status: '已完成', text: `跳转后第 ${n} 页正文` }),
  searchPaper: (query) => ({
    matches: query.includes('复杂度')
      ? [{ page: 7, snippet: '时间复杂度为 O(n log n)' }]
      : [],
  }),
  listPages: () => ({
    pages: [
      { page: 1, status: '已完成', preview: '摘要' },
      { page: 2, status: '翻译中', preview: '' },
    ],
  }),
  getOutline: () => ({
    items: [
      { page: 1, level: 1, text: 'Introduction' },
      { page: 3, level: 2, text: 'Related Work' },
    ],
  }),
  getMyNotes: () => ({
    items: [
      { id: 'n1', title: '一键导读', content: '本文提出 LEO 优化器，收敛更快。', source: 'ai', createdAt: 1 },
      { id: 'n2', title: '我的想法', content: '可以试试把它用在扩散模型上。', source: 'manual', createdAt: 2 },
    ],
  }),
  searchMyNotes: (query) => (query === 'attention'
    ? [{ docKey: 't:Old Paper|p:9', docTitle: 'Old Paper', noteTitle: '方法拆解', snippet: '…self-attention 的开销是平方级…' }]
    : []),
};

test('research agent system prompt documents CALL/FINAL protocol and tools', () => {
  const prompt = researchAgentSystemPrompt('简体中文');
  assert.match(prompt, /CALL get_page/);
  assert.match(prompt, /CALL get_paper_meta|get_paper_meta/);
  assert.match(prompt, /FINAL/);
  for (const tool of RESEARCH_TOOLS) {
    assert.match(prompt, new RegExp(tool.name));
  }
  assert.ok(RESEARCH_AGENT_MAX_ROUNDS >= 3);
  assert.ok(RESEARCH_TOOLS.some((t) => t.name === 'goto_page'));
  assert.ok(RESEARCH_TOOLS.some((t) => t.name === 'get_outline'));
  assert.match(prompt, /CALL get_outline \{\}/);
  assert.ok(RESEARCH_TOOLS.some((t) => t.name === 'get_my_notes'));
  assert.ok(RESEARCH_TOOLS.some((t) => t.name === 'search_my_notes'));
  assert.match(prompt, /CALL get_my_notes \{\}/);
  assert.match(prompt, /CALL search_my_notes/);
  assert.match(prompt, /你的笔记/);
});

test('parseAgentResponse extracts CALL lines and FINAL body', () => {
  const parsed = parseAgentResponse([
    'CALL list_pages {}',
    'CALL get_page {"page":3}',
    'CALL search_paper {"query":"复杂度"}',
  ].join('\n'));
  assert.equal(parsed.calls.length, 3);
  assert.equal(parsed.calls[1].args.page, 3);
  assert.equal(parsed.calls[2].args.query, '复杂度');
  assert.equal(parsed.finalAnswer, '');

  const final = parseAgentResponse('FINAL\n这是最终回答。\n第二行。');
  assert.equal(final.calls.length, 0);
  assert.match(final.finalAnswer, /最终回答/);
});

test('parseAgentResponse treats plain prose as final answer', () => {
  const parsed = parseAgentResponse('这篇论文主要改进了采样效率。');
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.finalAnswer, /采样效率/);
});

test('executeResearchTool runs page tools against provider', () => {
  const meta = executeResearchTool({ name: 'get_paper_meta', args: {} }, provider);
  assert.match(meta.text, /Demo Paper/);
  assert.match(meta.text, /已译页数：4/);

  const current = executeResearchTool({ name: 'get_current_page', args: {} }, provider);
  assert.equal(current.ok, true);
  assert.match(current.text, /第 2 页/);
  assert.match(current.text, /方法概述/);

  const page = executeResearchTool({ name: 'get_page', args: { page: 5 } }, provider);
  assert.match(page.text, /第 5 页正文内容/);

  const jumped = executeResearchTool({ name: 'goto_page', args: { page: 8 } }, provider);
  assert.match(jumped.text, /跳转/);
  assert.match(jumped.text, /第 8 页/);
  assert.match(jumped.text, /未自动跳转/u);

  const bad = executeResearchTool({ name: 'get_page', args: { page: 0 } }, provider);
  assert.equal(bad.ok, false);

  const hit = executeResearchTool({ name: 'search_paper', args: { query: '复杂度' } }, provider);
  assert.match(hit.text, /第 7 页/);
  assert.match(hit.text, /O\(n log n\)/);

  const miss = executeResearchTool({ name: 'search_paper', args: { query: '不存在' } }, provider);
  assert.match(miss.text, /未找到/);

  const list = executeResearchTool({ name: 'list_pages', args: {} }, provider);
  assert.match(list.text, /第 1 页/);
  assert.match(list.text, /翻译中/);

  const outline = executeResearchTool({ name: 'get_outline', args: {} }, provider);
  assert.equal(outline.ok, true);
  assert.match(outline.text, /Introduction（第 1 页）/);
  assert.match(outline.text, /  - Related Work（第 3 页）/);
  const noOutline = executeResearchTool({ name: 'get_outline', args: {} }, { getOutline: () => ({ items: [] }) });
  assert.match(noOutline.text, /未提取到标题大纲/);
});

test('executeResearchTool reads and searches user notes', () => {
  const mine = executeResearchTool({ name: 'get_my_notes', args: {} }, provider);
  assert.equal(mine.ok, true);
  assert.match(mine.text, /【一键导读】/);
  assert.match(mine.text, /扩散模型/);
  const empty = executeResearchTool({ name: 'get_my_notes', args: {} }, { getMyNotes: () => ({ items: [] }) });
  assert.match(empty.text, /还没有已保存的科研笔记/);

  const hit = executeResearchTool({ name: 'search_my_notes', args: { query: 'attention' } }, provider);
  assert.equal(hit.ok, true);
  assert.match(hit.text, /《Old Paper》/);
  assert.match(hit.text, /self-attention/);
  const miss = executeResearchTool({ name: 'search_my_notes', args: { query: '不存在' } }, provider);
  assert.match(miss.text, /未找到「不存在」/);
  const noQuery = executeResearchTool({ name: 'search_my_notes', args: {} }, provider);
  assert.equal(noQuery.ok, false);
  assert.match(noQuery.error, /query 不能为空/);
});

test('formatToolResultsForModel is model-readable and clipped', () => {
  const text = formatToolResultsForModel([
    { name: 'get_page', ok: true, text: '正文' },
    { name: 'search_paper', ok: false, error: 'query 不能为空' },
  ]);
  assert.match(text, /工具结果/);
  assert.match(text, /get_page \(ok\)/);
  assert.match(text, /search_paper \(error\)/);
  assert.match(text, /FINAL/);
});

test('defaultResearchAgentStarters provides usable Chinese prompts', () => {
  const starters = defaultResearchAgentStarters();
  assert.ok(starters.length >= 2);
  assert.ok(starters.every((s) => /[\u4e00-\u9fff]/.test(s)));
});

test('buildAgentBootstrap injects meta + list + current page without model round', () => {
  const boot = buildAgentBootstrap(provider);
  assert.equal(boot.steps.length, 3);
  assert.match(boot.modelMessage, /Demo Paper|工具结果/);
  assert.match(boot.paperBrief, /Demo Paper/);
  assert.match(boot.paperBrief, /全文结构/);
  assert.match(boot.paperBrief, /Related Work（第 3 页）/);
  assert.match(boot.currentPageBrief, /方法概述|第 2 页/);
  assert.equal(boot.translatedCount, 4);
  assert.equal(boot.totalPages, 10);
  assert.ok(!boot.warning || typeof boot.warning === 'string');
});

test('detectPageAnchor resolves explicit page numbers and current-page phrasing', () => {
  assert.deepEqual(detectPageAnchor('解释第 5 页的算法'), { anchored: true, page: 5 });
  assert.deepEqual(detectPageAnchor('当前页面的算法是什么', 5), { anchored: true, page: 5 });
  assert.deepEqual(detectPageAnchor('这一页在讲什么', 3), { anchored: true, page: 3 });
  // 「当前页」但拿不到页码：仍视为锚定意图，页码为 null（不强插证据）。
  assert.equal(detectPageAnchor('本页的公式', undefined).anchored, true);
  assert.equal(detectPageAnchor('本页的公式', undefined).page, null);
  assert.deepEqual(detectPageAnchor('这篇论文的贡献是什么', 5), { anchored: false, page: null });
  assert.deepEqual(detectPageAnchor(''), { anchored: false, page: null });
});

// 回归：问「当前页(第5页)的算法」时，第 5 页必须置顶为第一证据。
// 此前引言页靠「算法」词频抢占 BM25 前排，回答全在引第 1 页。
test('page-anchored questions pin the anchored page as the top evidence', () => {
  const anchoredProvider = {
    ...provider,
    getCurrentPage: () => ({ page: 5, status: '已完成', text: '第 5 页：Algorithm 1 LEOPMAN 主循环。' }),
    retrieveEvidence: () => ({
      text: '#### E1 · 第 1 页 · 译文\n引言综述了各类算法。',
      pages: [1],
      sourceTypes: ['translation'],
      matches: [{ page: 1, snippet: '引言综述了各类算法。', sourceType: 'translation', score: 8 }],
    }),
  };
  const boot = buildAgentBootstrap(anchoredProvider, { query: '我说对当前页面的算法' });
  // 锚定页全文在证据区顶部，BM25 的第 1 页只能排在后面。
  assert.match(boot.evidenceBrief, /^### 用户问题锚定页：第 5 页/);
  assert.ok(boot.evidenceBrief.indexOf('第 5 页') < boot.evidenceBrief.indexOf('第 1 页'));
  assert.ok(boot.evidencePages.includes(5));
  assert.equal(boot.evidenceItems[0].page, 5);
  assert.ok(boot.steps.some((step) => step.name === 'get_page' && step.page === 5));

  // 显式「第 N 页」同样生效,且不依赖当前阅读页。
  const explicit = buildAgentBootstrap(anchoredProvider, { query: '第 7 页的实验设置是什么' });
  assert.match(explicit.evidenceBrief, /^### 用户问题锚定页：第 7 页/);
  assert.equal(explicit.evidenceItems[0].page, 7);

  // 未锚定的问题不注入锚定块,行为与之前一致。
  const plain = buildAgentBootstrap(anchoredProvider, { query: '这篇论文的贡献' });
  assert.ok(!/锚定页/.test(plain.evidenceBrief));
});

test('research agent prompt keeps multi-turn context and paper session briefs', () => {
  const prompt = researchAgentSystemPrompt('简体中文', {
    paperBrief: '### 论文快照\n标题：Demo',
    currentPageBrief: '### 用户当前阅读页\n第 2 页',
  });
  assert.match(prompt, /左侧 PDF|原表/);
  assert.match(prompt, /多轮对话/);
  assert.match(prompt, /指代|上文/);
  assert.match(prompt, /会话论文上下文/);
  assert.match(prompt, /Demo/);
  assert.match(prompt, /第 2 页/);
});

test('assembleAgentDialogueTurns keeps latest user question last and clips history', () => {
  const history = [
    { role: 'user', content: '问题一：方法是什么' },
    { role: 'assistant', content: '回答一：核心是 LEO' },
    { role: 'user', content: '继续展开讲这个方法' },
    { role: 'assistant', content: '' }, // placeholder being generated
  ];
  const placeholder = history[3];
  const turns = assembleAgentDialogueTurns(history, { excludeEntry: placeholder, maxTurns: 10 });
  assert.equal(turns.length, 3);
  assert.equal(turns[turns.length - 1].role, 'user');
  assert.match(turns[turns.length - 1].content, /继续展开/);
  assert.match(turns[0].content, /问题一/);
  assert.ok(RESEARCH_AGENT_MAX_HISTORY_TURNS >= 20);
});

test('short follow-up reuses the previous user topic for local evidence retrieval', () => {
  const query = buildContextualEvidenceQuery([
    { role: 'user', content: '请解释论文的策略梯度方差降低方法' },
    { role: 'assistant', content: '它使用了基线。' },
  ], '为什么？');
  assert.match(query, /策略梯度方差/u);
  assert.match(query, /跟进问题：为什么/u);
  assert.equal(buildContextualEvidenceQuery([], '实验比较了哪些基线模型？'), '实验比较了哪些基线模型？');
});

test('duplicate research tool calls are removed across rounds', () => {
  const first = dedupeResearchToolCalls([
    { name: 'get_page', args: { page: 3 } },
    { name: 'get_page', args: { page: 3 } },
    { name: 'search_paper', args: { query: 'complexity' } },
  ]);
  assert.deepEqual(first.calls.map((call) => call.name), ['get_page', 'search_paper']);
  assert.equal(first.skipped.length, 1);
  const second = dedupeResearchToolCalls([
    { name: 'search_paper', args: { query: 'complexity' } },
    { name: 'get_page', args: { page: 4 } },
  ], first.signatures);
  assert.deepEqual(second.calls.map((call) => call.name), ['get_page']);
  assert.equal(second.skipped.length, 1);
});
