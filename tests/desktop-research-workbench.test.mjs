import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWorkspace,
  emptyWorkspace,
  addTodo,
  setTodoDone,
  listTodos,
  rememberFact,
  listMemory,
  formatProjectMemoryBlock,
  setAgentMode,
  setOverleafConfig,
} from '../desktop/lib/workspace-store.mjs';
import {
  extractPageCitations,
  buildEvidenceModel,
  pagesFromTrace,
} from '../desktop/lib/evidence.mjs';
import {
  buildOverleafSectionTex,
  writeMarkdownToPath,
} from '../desktop/lib/export-tools.mjs';
import { createToolRegistry, runAgentTurn } from '../desktop/lib/agent-core.mjs';
import { getResearchSkill, listResearchSkills } from '../desktop/lib/research-skills.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('workspace v2 keeps todos, memory, agentMode, overleaf', () => {
  let ws = emptyWorkspace();
  assert.equal(ws.agentMode, 'copilot');
  ws = setAgentMode(ws, 'autopilot');
  assert.equal(ws.agentMode, 'autopilot');
  ws = setOverleafConfig(ws, { projectUrl: 'https://www.overleaf.com/project/abc', enabled: true });
  assert.equal(ws.overleaf.projectUrl.includes('overleaf'), true);

  const r1 = addTodo(ws, { text: '精读实验', paperPath: '/a.pdf', paperTitle: 'A' });
  assert.equal(r1.added, true);
  ws = r1.workspace;
  const open = listTodos(ws, { paperPath: '/a.pdf', includeDone: false });
  assert.equal(open.length, 1);
  ws = setTodoDone(ws, r1.todo.id, true);
  assert.equal(listTodos(ws, { includeDone: false }).length, 0);

  const r2 = rememberFact(ws, { fact: '主指标是 HV（第 8 页）', paperPath: '/a.pdf' });
  ws = r2.workspace;
  assert.equal(listMemory(ws, { paperPath: '/a.pdf' })[0].fact.includes('HV'), true);

  const block = formatProjectMemoryBlock(
    addTodo(ws, { text: '核对 Table 2', paperPath: '/a.pdf' }).workspace,
    { paperPath: '/a.pdf', paperTitle: 'A' },
  );
  assert.match(block, /待办|Table 2|HV/);
});

test('normalizeWorkspace upgrades legacy payloads without todos', () => {
  const ws = normalizeWorkspace({ version: 1, recent: [], notes: [], glossary: [] });
  assert.ok(Array.isArray(ws.todos));
  assert.ok(Array.isArray(ws.memory));
  assert.equal(ws.agentMode, 'copilot');
});

test('extractPageCitations finds Chinese and English forms', () => {
  const pages = extractPageCitations('见第 3 页与第12页，also Page 7 and p. 9。');
  assert.deepEqual(pages, [3, 7, 9, 12]);
  assert.deepEqual(extractPageCitations('第 99 页', { maxPage: 20 }), []);
});

test('buildEvidenceModel merges answer and trace pages', () => {
  const model = buildEvidenceModel({
    answer: '方法在第 4 页，结果见第 8 页。',
    trace: [
      { name: 'read_paper_page', ok: true, args: { page: 4 } },
      { name: 'read_paper_page', ok: true, args: { page: 5 } },
      { name: 'search_paper_text', ok: true, resultPages: [8, 9] },
    ],
    maxPage: 20,
  });
  assert.deepEqual(model.pages, [4, 5, 8, 9]);
  assert.ok(model.cards.some((c) => c.page === 5 && c.source === 'tool'));
});

test('pagesFromTrace ignores failed tools', () => {
  assert.deepEqual(pagesFromTrace([
    { name: 'read_paper_page', ok: false, args: { page: 3 } },
    { name: 'read_paper_pages', ok: true, args: { from: 1, to: 2 } },
  ]), [1, 2]);
});

test('export helpers write markdown and build tex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-export-'));
  const file = join(dir, 'r.md');
  writeMarkdownToPath(file, '# hi\n');
  assert.equal(readFileSync(file, 'utf8'), '# hi\n');
  rmSync(dir, { recursive: true, force: true });

  const tex = buildOverleafSectionTex({ sectionTitle: 'Related Work', latexBody: 'We review MOO.' });
  assert.match(tex, /\\section\{Related Work\}/);
  assert.match(tex, /We review MOO/);
});

test('export and overleaf skills exist', () => {
  const ids = listResearchSkills().map((s) => s.id);
  assert.ok(ids.includes('export-report'));
  assert.ok(ids.includes('overleaf'));
  assert.match(getResearchSkill('overleaf').prompt, /prepare_overleaf_section/);
});

test('copilot mode denies write tools without confirmTool', async () => {
  const registry = createToolRegistry([
    {
      name: 'save_research_note',
      requiresConfirmation: true,
      description: 'x',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ saved: true }),
    },
  ]);
  let phase = 0;
  const chatFn = async ({ messages }) => {
    if (phase === 0) {
      phase = 1;
      return {
        content: '写入',
        tool_calls: [{ id: '1', function: { name: 'save_research_note', arguments: '{"title":"t","content":"c"}' } }],
      };
    }
    const tool = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    assert.equal(tool[0].denied, true);
    return { content: '用户拒绝了写入，我改为口头总结。' };
  };
  const events = [];
  const { answer, trace } = await runAgentTurn({
    chatFn,
    registry,
    messages: [{ role: 'user', content: '记笔记' }],
    agentMode: 'copilot',
    // 不提供 confirmTool → 拒绝
    onEvent: (t) => events.push(t),
  });
  assert.equal(trace[0].denied, true);
  assert.ok(events.includes('tool-confirm'));
  assert.match(answer, /拒绝|口头/);
});

test('autopilot mode skips confirmation for write tools', async () => {
  let ran = false;
  const registry = createToolRegistry([
    {
      name: 'save_research_note',
      requiresConfirmation: true,
      description: 'x',
      parameters: { type: 'object', properties: {} },
      run: async () => { ran = true; return { saved: true }; },
    },
  ]);
  let phase = 0;
  const chatFn = async () => {
    if (phase === 0) {
      phase = 1;
      return {
        tool_calls: [{ id: '1', function: { name: 'save_research_note', arguments: '{}' } }],
      };
    }
    return { content: '已保存' };
  };
  const { trace } = await runAgentTurn({
    chatFn,
    registry,
    messages: [{ role: 'user', content: 'x' }],
    agentMode: 'autopilot',
  });
  assert.equal(ran, true);
  assert.equal(trace[0].ok, true);
});

test('confirmTool allow path runs the write tool', async () => {
  let ran = false;
  const registry = createToolRegistry([
    {
      name: 'export_markdown_report',
      requiresConfirmation: true,
      description: 'x',
      parameters: { type: 'object', properties: {} },
      run: async () => { ran = true; return { saved: true, filePath: '/tmp/a.md' }; },
    },
  ]);
  let phase = 0;
  const chatFn = async () => {
    if (phase === 0) {
      phase = 1;
      return {
        tool_calls: [{ id: '1', function: { name: 'export_markdown_report', arguments: '{"content":"# a"}' } }],
      };
    }
    return { content: '导出完成' };
  };
  await runAgentTurn({
    chatFn,
    registry,
    messages: [{ role: 'user', content: '导出' }],
    agentMode: 'copilot',
    confirmTool: async () => true,
  });
  assert.equal(ran, true);
});
