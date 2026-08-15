import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createToolRegistry,
  runAgentTurn,
  buildResearchSystemPrompt,
  researchConstitution,
  agentSystemPrompt,
} from '../desktop/lib/agent-core.mjs';
import {
  listResearchSkills,
  getResearchSkill,
  matchResearchSkill,
  formatSkillPromptBlock,
} from '../desktop/lib/research-skills.mjs';
import { createPaperToolDefs } from '../desktop/lib/paper-tool-defs.mjs';

test('research constitution requires evidence and forbids fabrication', () => {
  const text = researchConstitution({ targetLang: '简体中文' });
  assert.match(text, /PaperLens Research Agent/);
  assert.match(text, /第 N 页/);
  assert.match(text, /查不到就说查不到/);
  assert.match(text, /不编造/);
});

test('buildResearchSystemPrompt includes paper context and skill block', () => {
  const skill = getResearchSkill('deep-read');
  const prompt = buildResearchSystemPrompt({
    paperTitle: 'Demo Paper',
    paperPages: 12,
    skillBlock: formatSkillPromptBlock(skill),
  });
  assert.match(prompt, /Demo Paper/);
  assert.match(prompt, /12 页/);
  assert.match(prompt, /一键深读|deep-read|已激活科研技能/);
});

test('agentSystemPrompt remains backward compatible', () => {
  const prompt = agentSystemPrompt({ paperTitle: 'X' });
  assert.match(prompt, /PaperLens/);
  assert.match(prompt, /lookup_citation|外部/);
});

test('research skills catalog exposes core workflows', () => {
  const ids = listResearchSkills().map((s) => s.id);
  for (const need of ['deep-read', 'paper-qa', 'lit-survey', 'meeting', 'method']) {
    assert.ok(ids.includes(need), `missing skill ${need}`);
  }
  assert.equal(getResearchSkill('nope'), null);
  assert.equal(getResearchSkill('meeting')?.short, '组会');
});

test('matchResearchSkill picks strong keyword hits', () => {
  assert.equal(matchResearchSkill('请做组会讲稿')?.id, 'meeting');
  assert.equal(matchResearchSkill('帮我文献调研一下')?.id, 'lit-survey');
  assert.equal(matchResearchSkill('hi'), null);
});

test('paper tools read range and search with multi-hit cap', () => {
  const paper = {
    title: 'T',
    pages: [
      'Abstract: multi-objective optimization appears here.',
      'Method section with algorithm details and multi-objective again.',
      'Experiments on DTLZ.',
    ],
  };
  const defs = createPaperToolDefs(() => paper);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const overview = byName.get_paper_overview.run();
  assert.equal(overview.totalPages, 3);
  const page = byName.read_paper_page.run({ page: 2 });
  assert.match(page.text, /Method/);
  const range = byName.read_paper_pages.run({ from: 1, to: 3 });
  assert.equal(range.pages.length, 3);
  const hits = byName.search_paper_text.run({ query: 'multi-objective', maxHits: 5 });
  assert.ok(hits.hits.length >= 1);
  assert.equal(hits.hits[0].page, 1);
});

test('save_research_note uses injected writer', async () => {
  const saved = [];
  const defs = createPaperToolDefs(
    () => ({ title: 'P', pages: ['hello'] }),
    {
      saveNote: async (note) => {
        saved.push(note);
        return { ok: true, added: true, count: 1 };
      },
    },
  );
  const tool = defs.find((d) => d.name === 'save_research_note');
  const result = await tool.run({ title: 'Note', content: 'body 第 1 页' });
  assert.equal(result.saved, true);
  assert.equal(saved[0].paperTitle, 'P');
  assert.equal(saved[0].source, 'agent');
});

test('runAgentTurn emits timeline events and suppresses duplicate tools', async () => {
  let calls = 0;
  const registry = createToolRegistry([
    {
      name: 'get_paper_overview',
      description: 'x',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        calls += 1;
        return { totalPages: 2 };
      },
    },
  ]);
  const chatFn = async ({ messages }) => {
    const toolMsgs = messages.filter((m) => m.role === 'tool');
    if (toolMsgs.length === 0) {
      return {
        content: '先看结构',
        tool_calls: [
          { id: 'a', function: { name: 'get_paper_overview', arguments: '{}' } },
          { id: 'b', function: { name: 'get_paper_overview', arguments: '{}' } },
        ],
      };
    }
    // 第二轮：模型看到重复跳过结果后给出答案
    return { content: '共 2 页（第 1 页起）。' };
  };
  const events = [];
  const { answer, trace, rounds } = await runAgentTurn({
    chatFn,
    registry,
    messages: [{ role: 'user', content: '概览' }],
    maxRounds: 6,
    onEvent: (type, data) => events.push({ type, ...(data || {}) }),
  });
  assert.equal(calls, 1); // 第二次重复被抑制
  assert.equal(trace.filter((t) => t.duplicate).length, 1);
  assert.equal(rounds, 2);
  assert.match(answer, /2 页/);
  assert.ok(events.some((e) => e.type === 'plan' && /结构/.test(e.text)));
  assert.ok(events.some((e) => e.type === 'tool-start'));
  assert.ok(events.some((e) => e.type === 'status' && e.phase === 'done'));
});

test('runAgentTurn respects AbortSignal', async () => {
  const registry = createToolRegistry([]);
  const controller = new AbortController();
  const chatFn = async () => {
    controller.abort();
    const err = new Error('已取消');
    err.code = 'ABORTED';
    throw err;
  };
  await assert.rejects(
    () => runAgentTurn({
      chatFn,
      registry,
      messages: [{ role: 'user', content: 'q' }],
      signal: controller.signal,
    }),
    (err) => err.code === 'ABORTED' || /取消/.test(err.message),
  );
});
