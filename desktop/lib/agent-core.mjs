// PaperLens Desktop agent 核心：真·工具循环（OpenAI 原生 function calling），
// 模型自由（DeepSeek / GPT / Gemini-OpenAI 兼容端点均可）。
// 与扩展的 CALL 行协议本质区别：
//  - 工具调用走 API 的 tools/tool_calls 结构化通道，模型专门为此训练过，
//    不会「装作调用了工具」或把协议格式写进答案。
//  - 循环在 Node 里执行，联网工具（arXiv/S2/网页）无 CORS 限制。
//  - registry 可插拔：论文工具、联网工具、之后的 Obsidian/MCP 工具统一注册。

/** 工具注册表：{ name, description, parameters(JSONSchema), run(args) } */
export function createToolRegistry(tools = []) {
  const map = new Map();
  for (const tool of tools) {
    if (!tool?.name || typeof tool.run !== 'function') continue;
    map.set(tool.name, tool);
  }
  return {
    list: () => [...map.values()],
    get: (name) => map.get(name) || null,
    toOpenAiTools: () => [...map.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: String(tool.description || '').slice(0, 1024),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    })),
  };
}

export function agentSystemPrompt({ targetLang = '简体中文', paperTitle = '' } = {}) {
  return [
    `你是 PaperLens Desktop 的科研助手，一个可以联网的论文深读智能体。请用${targetLang}回答。`,
    paperTitle ? `当前打开的论文：《${paperTitle}》。` : '当前没有打开论文。',
    '',
    '能力边界与诚实原则：',
    '- 论文内问题：先 get_paper_overview 了解结构，再 read_paper_page / search_paper_text 取证，结论标注「第 N 页」。',
    '- 论文外问题（引用文献讲什么 / 相关工作 / 概念溯源）：必须用联网工具（lookup_citation / search_arxiv / fetch_url）查到原始来源再回答，并给出来源链接。',
    '- 用户问「文献 [N] / 这篇引用」时：先 search_paper_text 在参考文献里找到该条目的标题作者，再 lookup_citation 查它本身——绝不能只复述本论文对它的转述。',
    '- 区分三种来源并明确标注：本论文内容（页码）、外部文献（链接）、你的推断。',
    '- 查不到就说查不到；不编造标题、作者、结论或链接。',
    '- 回答用短标题 + 分点，公式用 $...$ / $$...$$。',
  ].join('\n');
}

/**
 * 运行一轮 agent 对话（含多步工具循环）。
 * chatFn({messages, tools}) → OpenAI 兼容响应 message（{content, tool_calls?}）。
 * onEvent(type, data)：'tool-start' | 'tool-done' | 'answer'（UI 展示查阅过程）。
 */
export async function runAgentTurn({
  chatFn,
  registry,
  messages,
  maxRounds = 8,
  onEvent = () => {},
}) {
  const turns = [...messages];
  const trace = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const reply = await chatFn({
      messages: turns,
      tools: registry.toOpenAiTools(),
      onDelta: (delta) => onEvent('delta', { delta }),
    });
    const toolCalls = reply?.tool_calls || [];
    if (!toolCalls.length) {
      const answer = String(reply?.content || '').trim();
      onEvent('answer', { answer });
      return { answer, trace, rounds: round + 1 };
    }
    turns.push({ role: 'assistant', content: reply.content || '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      const name = call?.function?.name || '';
      let args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
      onEvent('tool-start', { name, args });
      const tool = registry.get(name);
      let result;
      if (!tool) {
        result = { ok: false, error: `未知工具：${name}` };
      } else {
        try {
          result = { ok: true, data: await tool.run(args) };
        } catch (error) {
          result = { ok: false, error: String(error?.message || error) };
        }
      }
      trace.push({ name, args, ok: result.ok });
      onEvent('tool-done', { name, ok: result.ok });
      turns.push({
        role: 'tool',
        tool_call_id: call.id || `${name}-${round}`,
        content: JSON.stringify(result).slice(0, 24000),
      });
    }
  }
  const answer = '（已达到工具调用轮次上限，请把问题拆小或重试）';
  onEvent('answer', { answer });
  return { answer, trace, rounds: maxRounds };
}

/** OpenAI 兼容 chat 实现（非流式；desktop UI 后续换流式）。 */
export function createOpenAiChat({ baseUrl, apiKey, model, fetchImpl = fetch }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return async function chatFn({ messages, tools }) {
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.3,
      }),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 400);
      throw new Error(`模型请求失败 HTTP ${response.status}：${body}`);
    }
    const data = await response.json();
    return data?.choices?.[0]?.message || { content: '' };
  };
}

/**
 * 流式 chat（SSE）：正文增量经 onDelta 实时回调（工具调用轮之间也在吐字），
 * tool_calls 按 index 聚合增量拼装。返回值与非流式 chatFn 相同结构。
 * 设计参考 Grok Build：agent 循环中「思考正文」与「工具调用」同流交织展示。
 */
export function createOpenAiStreamingChat({ baseUrl, apiKey, model, fetchImpl = fetch }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return async function chatFn({ messages, tools, onDelta = () => {} }) {
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.3,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const body = (await response.text().catch(() => '')).slice(0, 400);
      throw new Error(`模型请求失败 HTTP ${response.status}：${body}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const payload = line.replace(/^data:\s*/, '').trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk?.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; onDelta(delta.content); }
        for (const tc of delta.tool_calls || []) {
          const i = Number(tc.index) || 0;
          toolCalls[i] ||= { id: '', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
    const calls = toolCalls.filter((c) => c?.function?.name);
    return { content, ...(calls.length ? { tool_calls: calls } : {}) };
  };
}
