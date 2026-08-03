import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIMARY_SKILL_IDS,
  RESEARCH_SKILLS,
  appendResearchNote,
  docTitleFromDocKey,
  listAllResearchNotes,
  notesStorageKey,
  searchResearchNotes,
  buildSkillUserMessage,
  clearResearchNotes,
  extractPageCitations,
  formatPaperContextLine,
  formatResearchNotesMarkdown,
  buildFollowUpActions,
  formatToolCallLabel,
  formatToolTrailMarkdown,
  getResearchSkill,
  linkifyPageCitationsInElement,
  loadResearchNotes,
  pageFromToolCall,
  searchResearchSkills,
  shouldUseResearchAgent,
} from '../src/lib/research-skills.js';

test('research skills include briefing and force agent', () => {
  assert.ok(RESEARCH_SKILLS.length >= 6);
  const briefing = getResearchSkill('briefing');
  assert.equal(briefing.forceAgent, true);
  assert.match(buildSkillUserMessage('briefing', { docTitle: 'Demo' }), /一键导读|导读/);
  assert.match(buildSkillUserMessage('briefing', { docTitle: 'Demo' }), /Demo/);
});

test('research skill command search ranks names and searches intended use', () => {
  assert.equal(searchResearchSkills('')[0].id, RESEARCH_SKILLS[0].id);
  assert.equal(searchResearchSkills('实验')[0].id, 'experiment');
  assert.equal(searchResearchSkills('超参数 复现')[0].id, 'reproduce');
  assert.ok(searchResearchSkills('审稿').some((skill) => skill.id === 'review'));
  assert.deepEqual(searchResearchSkills('完全不存在的查询'), []);
});

test('scholar skills: review / reproduce / related / citation', () => {
  for (const id of ['review', 'reproduce', 'related', 'citation']) {
    const skill = getResearchSkill(id);
    assert.ok(skill, `missing skill ${id}`);
    assert.equal(skill.forceAgent, true);
  }
  assert.match(getResearchSkill('review').prompt, /Strengths[\s\S]*Weaknesses[\s\S]*Questions/);
  assert.match(getResearchSkill('reproduce').prompt, /超参数[\s\S]*未提供/);
  assert.match(getResearchSkill('related').prompt, /baseline/i);
  assert.match(getResearchSkill('citation').prompt, /BibTeX[\s\S]*GB\/T 7714[\s\S]*APA/);
  assert.match(getResearchSkill('citation').prompt, /"page":1/);
});

test('workflow skills: presentation / writing / ideas + primary fold list', () => {
  for (const id of ['presentation', 'writing', 'ideas']) {
    const skill = getResearchSkill(id);
    assert.ok(skill, `missing skill ${id}`);
    assert.equal(skill.forceAgent, true);
  }
  assert.match(getResearchSkill('presentation').prompt, /幻灯片大纲[\s\S]*逐张讲稿[\s\S]*预设提问/);
  assert.match(getResearchSkill('writing').prompt, /paraphrase|转述/);
  assert.match(getResearchSkill('writing').prompt, /baseline/i);
  assert.match(getResearchSkill('ideas').prompt, /search_my_notes/);
  assert.match(getResearchSkill('ideas').prompt, /单人可完成度/);
  // 折叠列表：是全集子集、含导读、且确实少于全部技能。
  assert.ok(PRIMARY_SKILL_IDS.includes('briefing'));
  assert.ok(PRIMARY_SKILL_IDS.every((id) => getResearchSkill(id)));
  assert.ok(PRIMARY_SKILL_IDS.length < RESEARCH_SKILLS.length);
});

test('shouldUseResearchAgent routes deep questions', () => {
  assert.equal(shouldUseResearchAgent('hi'), false);
  assert.equal(shouldUseResearchAgent('这篇论文的方法是什么？'), true);
  assert.equal(shouldUseResearchAgent('第 7 页复杂度怎么来的'), true);
  assert.equal(shouldUseResearchAgent('explain the algorithm and ablation'), true);
  assert.equal(shouldUseResearchAgent('帮我从审稿角度看看'), true);
  assert.equal(shouldUseResearchAgent('复现需要哪些超参'), true);
  assert.equal(shouldUseResearchAgent('give me the bibtex'), true);
  assert.equal(shouldUseResearchAgent('帮我准备组会讲稿'), true);
  assert.equal(shouldUseResearchAgent('结合我的笔记找找思路'), true);
});

test('tool labels and trails are human readable', () => {
  assert.match(formatToolCallLabel({ name: 'get_page', args: { page: 3 } }), /第 3 页/);
  assert.match(formatToolCallLabel({ name: 'search_paper', args: { query: '复杂度' } }), /复杂度/);
  const trail = formatToolTrailMarkdown([
    { label: '浏览各页概览', ok: true },
    { label: '阅读第 2 页', ok: true },
  ]);
  assert.match(trail, /查阅过程/);
  assert.match(trail, /第 2 页/);
});

test('extractPageCitations finds page numbers', () => {
  assert.deepEqual(extractPageCitations('见第 3 页与第12页，以及第 3 页重复'), [3, 12]);
});

test('linkifyPageCitationsInElement is a no-op without DOM tree walker', () => {
  assert.equal(linkifyPageCitationsInElement(null), 0);
  assert.equal(linkifyPageCitationsInElement({}), 0);
});

test('research notes persist per document key', () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
  };
  clearResearchNotes('doc-a', storage);
  appendResearchNote('doc-a', { title: '导读', content: '要点在第 1 页', source: 'briefing' }, storage);
  const loaded = loadResearchNotes('doc-a', storage);
  assert.equal(loaded.items.length, 1);
  assert.match(loaded.items[0].content, /第 1 页/);
  const md = formatResearchNotesMarkdown(loaded, { docTitle: 'Paper' });
  assert.match(md, /Paper/);
  assert.match(md, /导读/);
  clearResearchNotes('doc-a', storage);
  assert.equal(loadResearchNotes('doc-a', storage).items.length, 0);
});

test('cross-paper notes: list, search, docKey title', () => {
  // 模拟 localStorage：需要 .length 与 .key(i) 才能被 listAllResearchNotes 枚举。
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
  };
  appendResearchNote('t:Paper A|p:10', { title: '方法拆解', content: 'A 文用 attention 做对齐。' }, storage);
  appendResearchNote('t:Paper B|p:8', { title: '我的想法', content: 'B 文的 baseline 太弱。' }, storage);
  storage.setItem('unrelated.key', 'x'); // 非笔记键应被跳过

  const all = listAllResearchNotes(storage);
  assert.equal(all.length, 2);
  assert.ok(all.every((d) => d.items.length === 1));
  assert.ok(all.some((d) => d.docTitle === 'Paper A'));

  const hits = searchResearchNotes('attention', { storage, limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docTitle, 'Paper A');
  assert.match(hits[0].snippet, /attention/);
  assert.equal(searchResearchNotes('不存在的词', { storage }).length, 0);
  assert.equal(searchResearchNotes('', { storage }).length, 0);

  assert.equal(docTitleFromDocKey('t:Paper A|p:10'), 'Paper A');
  assert.equal(docTitleFromDocKey('unknown'), '未命名论文');
  assert.ok(notesStorageKey('t:Paper A|p:10').includes('paperlens.researchNotes.v1:'));
});

test('formatPaperContextLine summarizes reading state', () => {
  const { line, title } = formatPaperContextLine({
    currentPage: 4,
    totalPages: 20,
    translatedCount: 6,
    title: 'A Very Long Paper Title About Optimization Methods',
  });
  assert.match(line, /第 4 页/);
  assert.match(line, /20/);
  assert.match(line, /已译 6/);
  assert.ok(title.length <= 30);
});

test('pageFromToolCall and follow-up actions support research workflow', () => {
  assert.equal(pageFromToolCall({ name: 'get_page', args: { page: 7 } }), 7);
  assert.equal(pageFromToolCall({ name: 'list_pages', args: {} }), null);
  const actions = buildFollowUpActions('见第 3 页与第 8 页的方法。', { skillId: 'briefing' });
  assert.ok(actions.some((a) => a.kind === 'goto' && a.page === 3));
  assert.ok(actions.some((a) => a.kind === 'note'));
  assert.ok(actions.some((a) => a.kind === 'skill' && a.skillId === 'method'));
  assert.ok(actions.some((a) => a.kind === 'prompt'));
  // 批判读之后追加「审稿视角」升级入口。
  const afterCritique = buildFollowUpActions('结论见第 2 页。', { skillId: 'critique' });
  assert.ok(afterCritique.some((a) => a.kind === 'skill' && a.skillId === 'review'));
  assert.ok(!afterCritique.some((a) => a.skillId === 'critique'));
  assert.match(formatToolCallLabel({ name: 'get_outline', args: {} }), /大纲/);
  assert.match(formatToolCallLabel({ name: 'get_my_notes', args: {} }), /本篇笔记/);
  assert.match(formatToolCallLabel({ name: 'search_my_notes', args: { query: 'gan' } }), /全部笔记「gan」/);
});
