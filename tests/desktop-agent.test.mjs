import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArxivAtom, shapeSemanticScholarPaper, htmlToReadableText } from '../desktop/lib/web-tools.mjs';
import { createToolRegistry, runAgentTurn, agentSystemPrompt } from '../desktop/lib/agent-core.mjs';
import { createWebToolDefs } from '../desktop/lib/web-tool-defs.mjs';

test('parseArxivAtom extracts entries with ids, authors and pdf links', () => {
  const xml = `<feed><entry><id>http://arxiv.org/abs/2103.00001v2</id>
    <title>Deep RL for  Multiobjective Optimization</title>
    <summary>We propose &amp; evaluate…</summary>
    <published>2021-03-01T00:00:00Z</published>
    <author><name>K. Li</name></author><author><name>T. Zhang</name></author>
    </entry></feed>`;
  const items = parseArxivAtom(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].arxivId, '2103.00001v2');
  assert.equal(items[0].title, 'Deep RL for Multiobjective Optimization');
  assert.deepEqual(items[0].authors, ['K. Li', 'T. Zhang']);
  assert.match(items[0].pdfUrl, /arxiv\.org\/pdf\/2103\.00001v2/);
  assert.match(items[0].summary, /propose & evaluate/);
  assert.deepEqual(parseArxivAtom(''), []);
});

test('shapeSemanticScholarPaper normalizes fields and survives junk', () => {
  const shaped = shapeSemanticScholarPaper({
    title: 'DRL-MOA', year: '2021', citationCount: '321',
    authors: [{ name: 'K. Li' }, {}], venue: 'IEEE T-CYB',
    tldr: { text: 'Uses DRL to solve MOO.' }, openAccessPdf: { url: 'https://x/pdf' },
  });
  assert.equal(shaped.year, 2021);
  assert.equal(shaped.citationCount, 321);
  assert.deepEqual(shaped.authors, ['K. Li']);
  assert.equal(shaped.tldr, 'Uses DRL to solve MOO.');
  assert.equal(shapeSemanticScholarPaper(null), null);
});

test('htmlToReadableText strips chrome and keeps paragraphs', () => {
  const text = htmlToReadableText(
    '<nav>menu</nav><script>x()</script><p>First para.</p><div>Second&nbsp;para &amp; more.</div>',
  );
  assert.doesNotMatch(text, /menu|x\(\)/);
  assert.match(text, /First para\.\n\s*Second para & more\./);
});

// 真工具循环：模型第一轮请求工具，第二轮基于工具结果作答。
test('runAgentTurn executes structured tool calls then returns the final answer', async () => {
  const registry = createToolRegistry([
    {
      name: 'lookup_citation',
      description: 'test',
      parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
      run: async ({ reference }) => ({ title: reference, tldr: 'DRL solves MOO subproblems.' }),
    },
  ]);
  const seen = [];
  const chatFn = async ({ messages, tools }) => {
    seen.push(messages.at(-1));
    assert.equal(tools[0].function.name, 'lookup_citation');
    if (!messages.some((m) => m.role === 'tool')) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'lookup_citation', arguments: '{"reference":"DRL-MOA"}' } }],
      };
    }
    const toolMsg = JSON.parse(messages.findLast((m) => m.role === 'tool').content);
    assert.equal(toolMsg.ok, true);
    return { content: `该文献提出：${toolMsg.data.tldr}（来源：Semantic Scholar）` };
  };
  const events = [];
  const { answer, trace, rounds } = await runAgentTurn({
    chatFn,
    registry,
    messages: [{ role: 'system', content: agentSystemPrompt({ paperTitle: 'Demo' }) }, { role: 'user', content: '文献 [5] 在讲什么' }],
    onEvent: (type) => events.push(type),
  });
  assert.equal(rounds, 2);
  assert.deepEqual(trace, [{ name: 'lookup_citation', args: { reference: 'DRL-MOA' }, ok: true }]);
  assert.match(answer, /DRL solves MOO/);
  // Research Agent 会额外发 status / round 等可观察事件
  assert.ok(events.includes('tool-start'));
  assert.ok(events.includes('tool-done'));
  assert.ok(events.includes('answer'));
  assert.ok(events.includes('status'));
});

test('runAgentTurn surfaces unknown tools and tool errors to the model, not as crashes', async () => {
  const registry = createToolRegistry([{
    name: 'boom', description: 'x', parameters: { type: 'object', properties: {} },
    run: async () => { throw new Error('network down'); },
  }]);
  const chatFn = async ({ messages }) => {
    if (!messages.some((m) => m.role === 'tool')) {
      return {
        content: '',
        tool_calls: [
          { id: '1', function: { name: 'boom', arguments: '{}' } },
          { id: '2', function: { name: 'missing_tool', arguments: '{}' } },
        ],
      };
    }
    const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /network down/);
    assert.equal(results[1].ok, false);
    assert.match(results[1].error, /未知工具/);
    return { content: '两个工具都失败了，我如实告知用户。' };
  };
  const { answer } = await runAgentTurn({ chatFn, registry, messages: [{ role: 'user', content: 'q' }] });
  assert.match(answer, /如实告知/);
});

test('system prompt forbids answering citation questions from in-paper paraphrase alone', () => {
  const prompt = agentSystemPrompt({ paperTitle: 'X' });
  assert.match(prompt, /lookup_citation|外部文献/);
  assert.match(prompt, /转述|related work|本论文/);
  assert.match(prompt, /查不到就说查不到/);
});

test('web tool defs declare valid schemas for function calling', () => {
  const defs = createWebToolDefs();
  const names = defs.map((d) => d.name);
  assert.deepEqual(names, ['search_arxiv', 'lookup_citation', 'fetch_url']);
  for (const def of defs) {
    assert.equal(def.parameters.type, 'object');
    assert.ok(def.parameters.required?.length >= 1);
    assert.ok(typeof def.run === 'function');
  }
});

// 流式 chat：SSE 增量正文 + 分片 tool_calls 聚合。
test('streaming chat assembles deltas and fragmented tool calls', async () => {
  const { createOpenAiStreamingChat } = await import('../desktop/lib/agent-core.mjs');
  const sse = [
    'data: {"choices":[{"delta":{"content":"先查"}}]}',
    'data: {"choices":[{"delta":{"content":"一下。"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup_","arguments":"{\\"refe"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"citation","arguments":"rence\\":\\"DRL-MOA\\"}"}}]}}]}',
    'data: [DONE]',
    '',
  ].join('\n');
  const fetchImpl = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    }),
  });
  const chatFn = createOpenAiStreamingChat({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', fetchImpl });
  const deltas = [];
  const reply = await chatFn({ messages: [], tools: [], onDelta: (d) => deltas.push(d) });
  assert.equal(deltas.join(''), '先查一下。');
  assert.equal(reply.content, '先查一下。');
  assert.equal(reply.tool_calls.length, 1);
  assert.equal(reply.tool_calls[0].function.name, 'lookup_citation');
  assert.deepEqual(JSON.parse(reply.tool_calls[0].function.arguments), { reference: 'DRL-MOA' });
});
