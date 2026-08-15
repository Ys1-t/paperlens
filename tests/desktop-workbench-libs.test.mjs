import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildRadarQueryUrl,
  scoreRadarPaper,
  rankRadarPapers,
  fetchRadarPapers,
  radarDigestMarkdown,
  ARXIV_CATEGORY_PRESETS,
} from '../desktop/lib/arxiv-radar.mjs';
import {
  estimateTokens,
  emptyStats,
  normalizeStats,
  recordActivity,
  summarizeStats,
  heatmapModel,
  estimateCost,
  dayKey,
  STATS_MAX_DAYS,
} from '../desktop/lib/reading-stats.mjs';
import {
  deadlineCountdown,
  venueBoardModel,
  VENUE_PRESETS,
  SUBMISSION_CHECKLIST,
} from '../desktop/lib/submission-helper.mjs';
import {
  listVaultFiles,
  readVaultNote,
  snippetsInText,
  scoreVaultFile,
  searchVault,
  vaultOverview,
} from '../desktop/lib/knowledge-base.mjs';
import { createWorkbenchToolDefs } from '../desktop/lib/workbench-tool-defs.mjs';
import { createMemoryToolDefs } from '../desktop/lib/memory-tools.mjs';
import * as store from '../desktop/lib/workspace-store.mjs';

// ---------------------------------------------------------------------------
// arxiv-radar
// ---------------------------------------------------------------------------

test('radar query url joins categories with OR and clamps maxResults', () => {
  const url = buildRadarQueryUrl({ categories: ['cs.LG', 'cs.NE'], maxResults: 500 });
  assert.match(url, /cat:cs\.LG\+OR\+cat:cs\.NE/);
  assert.match(url, /max_results=80/);
  assert.match(url, /sortBy=submittedDate/);
  // 无分类时退化为关键词全文检索
  const kwUrl = buildRadarQueryUrl({ categories: [], keywords: ['pareto set learning'] });
  assert.match(kwUrl, /all%3Apareto%20set%20learning/);
  // 全空也能给出合法查询
  assert.match(buildRadarQueryUrl({}), /machine%20learning/);
});

test('radar scoring: title beats abstract, phrases boosted, freshness added', () => {
  const now = Date.parse('2026-08-04T00:00:00Z');
  const fresh = { title: 'Pareto Set Learning at scale', summary: 'x', published: '2026-08-03' };
  const stale = { title: 'Pareto Set Learning at scale', summary: 'x', published: '2026-01-01' };
  const interests = { keywords: ['pareto set learning'] };
  const a = scoreRadarPaper(fresh, interests, now);
  const b = scoreRadarPaper(stale, interests, now);
  // 标题+5 短语+3 近3日+8 → raw 更高；有关键词时 score = raw*4.2 capped
  assert.ok(a.score > b.score, `fresh ${a.score} should beat stale ${b.score}`);
  assert.ok(a.reasons.some((r) => /标题|短语|近/.test(r)));
  assert.deepEqual(a.matchedKeywords, ['pareto set learning']);
  const abstractOnly = scoreRadarPaper(
    { title: 'other', summary: 'we study moo problems', published: '2020-01-01' },
    { keywords: ['moo'] }, now,
  );
  assert.ok(abstractOnly.score > 0 && abstractOnly.score < a.score);
  assert.equal(scoreRadarPaper({ title: 'no hit' }, { keywords: ['zzz'] }, now).score, 0);
});

test('radar without keywords does not collapse all scores to the same value', () => {
  const now = Date.parse('2026-08-04T00:00:00Z');
  const interests = { categories: ['cs.LG'], keywords: [] };
  const papers = [
    { arxivId: '1', title: 'A', summary: 'a', published: '2026-08-04', primaryCategory: 'cs.LG', authors: ['x'] },
    { arxivId: '2', title: 'B', summary: 'b', published: '2026-07-01', primaryCategory: 'cs.LG', authors: ['x', 'y', 'z'] },
    { arxivId: '3', title: 'C', summary: 'c', published: '2025-01-01', primaryCategory: 'cs.CV', authors: ['x'] },
  ];
  const ranked = rankRadarPapers(papers, interests, { now });
  const scores = ranked.map((p) => p.score);
  // 校准后应拉开差距，不能全员同分（旧 bug：全是 16）
  assert.ok(new Set(scores).size >= 2, `scores should differ: ${scores}`);
  assert.ok(ranked[0].tier);
  assert.ok(ranked.every((p) => p.needsKeywords === true));
});

test('radar ranking dedups by id and floats new papers above seen ones', () => {
  const papers = [
    { arxivId: '1', title: 'seen high', summary: 'moo moo', published: '2026-08-03' },
    { arxivId: '2', title: 'new low', summary: '', published: '2026-08-01' },
    { arxivId: '1', title: 'duplicate', summary: '', published: '2026-08-03' },
  ];
  const ranked = rankRadarPapers(papers, { keywords: ['moo'] }, {
    seenIds: ['1'], now: Date.parse('2026-08-04T00:00:00Z'),
  });
  assert.equal(ranked.length, 2);
  // 「2」虽然分低但 isNew，排在已看过的「1」前面
  assert.equal(ranked[0].arxivId, '2');
  assert.equal(ranked[0].isNew, true);
  assert.equal(ranked[1].isNew, false);
});

test('fetchRadarPapers parses atom via injected fetch; digest renders picks', async () => {
  const atom = `<feed><entry><id>http://arxiv.org/abs/2608.01234v1</id>
    <title>Test Paper</title><summary>About pareto fronts.</summary>
    <published>2026-08-03T00:00:00Z</published><author><name>A. Author</name></author>
    </entry></feed>`;
  const papers = await fetchRadarPapers({ categories: ['cs.LG'], keywords: [] }, {
    fetchImpl: async () => ({ ok: true, text: async () => atom }),
  });
  assert.equal(papers.length, 1);
  assert.equal(papers[0].arxivId, '2608.01234v1');
  assert.equal(papers[0].pdfUrl, 'https://arxiv.org/pdf/2608.01234v1');

  const md = radarDigestMarkdown(
    [{ ...papers[0], score: 40, matchedKeywords: ['pareto'], tier: 'skim', reasons: ['标题含「pareto」'] }],
    { date: '2026-08-04', interests: { keywords: ['pareto'] } },
  );
  assert.match(md, /前沿雷达日报 · 2026-08-04/);
  assert.match(md, /### Test Paper/);
  assert.match(md, /相关度 \*\*40\*\*/);
  assert.match(radarDigestMarkdown([], {}), /没有命中|无新论文|关键词/);
  // 抓取失败要抛可读错误
  await assert.rejects(
    () => fetchRadarPapers({}, { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});

test('arxiv category presets stay unique and well-formed', () => {
  const ids = ARXIV_CATEGORY_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of ARXIV_CATEGORY_PRESETS) assert.ok(preset.label);
});

// ---------------------------------------------------------------------------
// reading-stats
// ---------------------------------------------------------------------------

test('estimateTokens counts CJK as one token each, latin at 4 chars/token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('多目标优化'), 5);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('优化 ab'), Math.ceil(2 + 3 / 4));
});

test('recordActivity accumulates per-day and survives normalize round-trips', () => {
  const now = Date.parse('2026-08-04T10:00:00');
  let stats = emptyStats();
  stats = recordActivity(stats, 'read-minutes', 5, now);
  stats = recordActivity(stats, 'page-translated', 2, now);
  stats = recordActivity(stats, 'tokens', 1200, now);
  stats = recordActivity(stats, 'agent-ask', 1, now);
  stats = recordActivity(stats, 'nonsense-kind', 9, now); // 未知 kind 静默忽略
  const day = normalizeStats(stats).days[dayKey(now)];
  assert.deepEqual(day, { readMinutes: 5, pagesTranslated: 2, tokens: 1200, papersOpened: 0, agentAsks: 1 });
  // 坏输入回退空表
  assert.deepEqual(normalizeStats(null).days, {});
  assert.deepEqual(normalizeStats({ days: { 'not-a-date': { readMinutes: 3 } } }).days, {});
});

test('stats capacity keeps only the most recent days', () => {
  let stats = emptyStats();
  const base = Date.parse('2020-01-01T12:00:00');
  for (let i = 0; i < STATS_MAX_DAYS + 30; i += 1) {
    stats = recordActivity(stats, 'read-minutes', 1, base + i * 86400000);
  }
  assert.equal(Object.keys(stats.days).length, STATS_MAX_DAYS);
  // 最老的 30 天被裁掉
  assert.equal(stats.days[dayKey(base)], undefined);
});

test('summarizeStats windows the last N days and counts active days', () => {
  const now = Date.parse('2026-08-04T12:00:00');
  let stats = emptyStats();
  stats = recordActivity(stats, 'read-minutes', 30, now);
  stats = recordActivity(stats, 'page-translated', 4, now - 86400000);
  stats = recordActivity(stats, 'read-minutes', 60, now - 10 * 86400000); // 窗口外
  const week = summarizeStats(stats, { days: 7, now });
  assert.equal(week.readMinutes, 30);
  assert.equal(week.pagesTranslated, 4);
  assert.equal(week.activeDays, 2);
  const all = summarizeStats(stats, { days: 30, now });
  assert.equal(all.readMinutes, 90);
});

test('heatmapModel emits weeks×7 grid with levels and null future cells', () => {
  const now = Date.parse('2026-08-04T12:00:00'); // 周二
  let stats = emptyStats();
  stats = recordActivity(stats, 'read-minutes', 100, now);
  const { grid, max } = heatmapModel(stats, { weeks: 2, now });
  assert.equal(grid.length, 2);
  assert.equal(grid[0].length, 7);
  assert.ok(max >= 100);
  const cells = grid.flat();
  // 今天之后的格子是 null（本周三~周日）
  assert.ok(cells.some((c) => c === null));
  const todayCell = cells.find((c) => c && c.key === dayKey(now));
  assert.equal(todayCell.level, 4);
});

test('estimateCost multiplies accumulated tokens by price per million', () => {
  const now = Date.parse('2026-08-04T12:00:00');
  const stats = recordActivity(emptyStats(), 'tokens', 2_000_000, now);
  const { tokens, cost } = estimateCost(stats, 3);
  assert.equal(tokens, 2_000_000);
  assert.equal(cost, 6);
  assert.equal(estimateCost(stats, 0).cost, 0);
});

// ---------------------------------------------------------------------------
// submission-helper
// ---------------------------------------------------------------------------

test('deadlineCountdown honours AoE and grades urgency', () => {
  // AoE：截稿日 23:59 UTC-12 == 次日 11:59 UTC
  const beforeAoE = Date.parse('2026-08-05T10:00:00Z'); // 8-04 截稿但 AoE 还没过
  const cd = deadlineCountdown('2026-08-04', beforeAoE);
  assert.equal(cd.passed, false);
  assert.equal(cd.urgency, 'critical');
  assert.match(cd.label, /今天截稿/);

  const now = Date.parse('2026-08-04T00:00:00Z');
  assert.equal(deadlineCountdown('2026-08-06', now).urgency, 'critical');
  assert.equal(deadlineCountdown('2026-08-14', now).urgency, 'soon');
  assert.equal(deadlineCountdown('2026-09-10', now).urgency, 'normal');
  assert.equal(deadlineCountdown('2027-01-01', now).urgency, 'far');
  const passed = deadlineCountdown('2026-07-01', now);
  assert.equal(passed.passed, true);
  assert.match(passed.label, /已截稿/);
  assert.equal(deadlineCountdown('not-a-date'), null);
});

test('venueBoardModel sorts by deadline with passed venues sunk to bottom', () => {
  const now = Date.parse('2026-08-04T00:00:00Z');
  const board = venueBoardModel([
    { id: 'a', abbr: 'AAAI', deadline: '2026-09-01' },
    { id: 'b', abbr: 'OLD', deadline: '2026-01-01' },
    { id: 'c', abbr: 'ICLR', deadline: '2026-08-10' },
    { id: 'd', abbr: 'NODDL' },
  ], now);
  assert.deepEqual(board.map((v) => v.abbr), ['ICLR', 'AAAI', 'NODDL', 'OLD']);
  assert.equal(board[3].countdown.passed, true);
  assert.equal(board[2].countdown, null);
});

test('venue presets never fabricate deadlines; checklist ids unique', () => {
  for (const preset of VENUE_PRESETS) {
    assert.equal(preset.deadline, undefined, `${preset.abbr} 不应预置截稿日期`);
    assert.ok(preset.url.startsWith('http'));
  }
  const ids = SUBMISSION_CHECKLIST.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// knowledge-base（真实临时 vault）
// ---------------------------------------------------------------------------

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-vault-'));
  mkdirSync(join(dir, 'papers'));
  mkdirSync(join(dir, '.obsidian'));
  mkdirSync(join(dir, '.trash'));
  writeFileSync(join(dir, 'papers', 'DRL-MOA.md'), '# DRL-MOA\n用分解 + 深度强化学习解多目标 TSP，邻居参数迁移。pareto front 近似。');
  writeFileSync(join(dir, 'idea.md'), '备忘：把 pareto set learning 用到车间调度。');
  writeFileSync(join(dir, '.obsidian', 'config.md'), 'pareto 不应被索引');
  writeFileSync(join(dir, '.trash', 'old.md'), 'pareto 不应被索引');
  writeFileSync(join(dir, 'note.txt'), '非 md 文件不收');
  return dir;
}

test('vault listing skips dot-dirs and non-md files', () => {
  const dir = makeVault();
  try {
    const files = listVaultFiles(dir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.md')));
    assert.ok(!files.some((f) => f.includes('.obsidian') || f.includes('.trash')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vault search scores filename over body and returns snippets', () => {
  const dir = makeVault();
  try {
    const hits = searchVault(dir, 'pareto');
    assert.equal(hits.length, 2);
    for (const hit of hits) {
      assert.ok(hit.score > 0);
      assert.ok(hit.snippets.length >= 1);
      assert.ok(!hit.relPath.includes('.obsidian'));
    }
    // 文件名命中权重更高
    const byName = searchVault(dir, 'idea');
    assert.equal(byName[0].name, 'idea');
    assert.deepEqual(searchVault(dir, 'zzz-not-there'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vault note read, snippet extraction and overview shape', () => {
  const dir = makeVault();
  try {
    const files = listVaultFiles(dir);
    const note = readVaultNote(files.find((f) => f.endsWith('DRL-MOA.md')));
    assert.equal(note.name, 'DRL-MOA');
    assert.match(note.text, /深度强化学习/);
    assert.equal(readVaultNote(join(dir, 'missing.md')), null);

    const snippets = snippetsInText(note.text, 'pareto 分解', { radius: 10 });
    assert.ok(snippets.length >= 1);
    assert.deepEqual(snippetsInText(note.text, ''), []);

    const overview = vaultOverview(dir);
    assert.equal(overview.totalNotes, 2);
    assert.ok(overview.recent.length >= 1);
    assert.ok(overview.recent[0].relPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// workbench-tool-defs（Agent 工具面接线）
// ---------------------------------------------------------------------------

function makeWorkbenchDeps(vaultFolder = '') {
  let ws = store.emptyWorkspace();
  return {
    deps: {
      getVaultFolder: () => vaultFolder,
      readWorkspace: () => ws,
      writeWorkspace: (next) => { ws = next; },
      store,
      fetchImpl: async () => ({ ok: true, text: async () => '<feed></feed>' }),
    },
    getWs: () => ws,
    setWs: (next) => { ws = next; },
  };
}

test('workbench tools expose the promised tool surface', () => {
  const { deps } = makeWorkbenchDeps();
  const names = createWorkbenchToolDefs(deps).map((t) => t.name);
  for (const expected of [
    'search_knowledge_base', 'read_knowledge_note', 'get_knowledge_base_overview',
    'fetch_frontier_papers', 'add_to_reading_list', 'list_reading_list',
    'list_submission_deadlines',
  ]) assert.ok(names.includes(expected), expected);
});

test('kb tools demand a configured vault and reject path escapes', async () => {
  const { deps } = makeWorkbenchDeps('');
  const tools = createWorkbenchToolDefs(deps);
  const search = tools.find((t) => t.name === 'search_knowledge_base');
  await assert.rejects(async () => search.run({ query: 'x' }), /尚未配置 Obsidian vault/);

  const dir = makeVault();
  try {
    const withVault = createWorkbenchToolDefs(makeWorkbenchDeps(dir).deps);
    const read = withVault.find((t) => t.name === 'read_knowledge_note');
    await assert.rejects(async () => read.run({ relPath: '../secrets.md' }), /非法路径/);
    const hits = withVault.find((t) => t.name === 'search_knowledge_base').run({ query: 'pareto' });
    assert.equal(hits.hits.length, 2);
    const note = withVault.find((t) => t.name === 'read_knowledge_note').run({ relPath: 'idea.md' });
    assert.match(note.text, /车间调度/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('frontier tool guides user when interests are empty, fetches when set', async () => {
  const { deps, getWs, setWs } = makeWorkbenchDeps();
  const atom = `<feed><entry><id>http://arxiv.org/abs/2608.9v1</id><title>MOO news</title>
    <summary>pareto</summary><published>2026-08-03T00:00:00Z</published>
    <author><name>A</name></author></entry></feed>`;
  deps.fetchImpl = async () => ({ ok: true, text: async () => atom });
  const tools = createWorkbenchToolDefs(deps);
  const fetchTool = tools.find((t) => t.name === 'fetch_frontier_papers');

  const empty = await fetchTool.run({});
  assert.match(empty.note, /尚未设置兴趣/);

  setWs(store.setInterests(getWs(), { categories: ['cs.LG'], keywords: ['pareto'] }));
  const result = await fetchTool.run({});
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].title, 'MOO news');
  assert.ok(result.papers[0].score > 0);
});

test('reading list tools persist through workspace writes', async () => {
  const { deps, getWs } = makeWorkbenchDeps();
  const tools = createWorkbenchToolDefs(deps);
  const add = tools.find((t) => t.name === 'add_to_reading_list');
  const list = tools.find((t) => t.name === 'list_reading_list');

  const r = await add.run({ title: 'Paper X', arxivId: '2608.1', summary: '值得读' });
  assert.equal(r.added, true);
  assert.equal(getWs().readingList.length, 1);
  const shown = await list.run();
  assert.equal(shown.count, 1);
  assert.equal(shown.items[0].title, 'Paper X');
});

test('deadline tool renders countdown labels from workspace venues', async () => {
  const { deps, getWs, setWs } = makeWorkbenchDeps();
  setWs(store.addVenue(getWs(), { abbr: 'NeurIPS', name: 'NeurIPS', deadline: '2099-05-20' }).workspace);
  const tools = createWorkbenchToolDefs(deps);
  const result = await tools.find((t) => t.name === 'list_submission_deadlines').run();
  assert.equal(result.venues.length, 1);
  assert.equal(result.venues[0].abbr, 'NeurIPS');
  assert.match(result.venues[0].countdown, /剩 \d+ 天/);

  const emptyResult = await createWorkbenchToolDefs(makeWorkbenchDeps().deps)
    .find((t) => t.name === 'list_submission_deadlines').run();
  assert.match(emptyResult.note, /尚未添加投稿目标/);
});

// ---------------------------------------------------------------------------
// memory-tools（课题记忆）
// ---------------------------------------------------------------------------

test('memory tools add/list/complete todos and remember facts across saves', async () => {
  let ws = store.emptyWorkspace();
  const tools = createMemoryToolDefs({
    getContext: () => ({ paperPath: '/d/x.pdf', paperTitle: 'X paper' }),
    readWorkspace: () => ws,
    writeWorkspace: (next) => { ws = next; },
    store,
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const added = await byName.add_research_todo.run({ text: '精读实验节' });
  assert.equal(added.added, true);
  const fact = await byName.remember_research_fact.run({ fact: '主指标 HV（第 8 页）' });
  assert.equal(fact.added, true);

  const memory = await byName.list_project_memory.run({});
  assert.equal(memory.paperTitle, 'X paper');
  assert.equal(memory.todos.length, 1);
  assert.equal(memory.memory.length, 1);

  await byName.complete_research_todo.run({ id: memory.todos[0].id });
  const after = await byName.list_project_memory.run({});
  assert.equal(after.todos.length, 0);
  const withDone = await byName.list_project_memory.run({ includeDone: true });
  assert.equal(withDone.todos.length, 1);
  assert.equal(withDone.todos[0].done, true);
});
