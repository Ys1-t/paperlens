// PaperLens Research Agent 核心（自有运行时）
// ---------------------------------------------------------------------------
// 目标：高完成度、可观察、证据优先的科研工具循环——产品是 PaperLens，
// 设计上吸收优秀开源 agent harness 的「规划 / 工具循环 / 可取消 / 可追踪」思路，
// 但不依赖、不嵌入外部 CLI。
//
// - 工具调用走 OpenAI 兼容 tools/tool_calls 结构化通道
// - 循环在 Node 执行，联网无 CORS
// - registry 可插拔：论文 / 联网 / 笔记 / 后续 Overleaf 等

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
    has: (name) => map.has(name),
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

/** 科研宪法：所有回合注入。 */
export function researchConstitution({ targetLang = '简体中文' } = {}) {
  return [
    `你是 PaperLens Research Agent——桌面科研工作台里的自主科研助手。请用${targetLang}回答。`,
    '',
    '## 身份',
    '- 你属于 PaperLens 产品，不是通用闲聊机器人。',
    '- 风格：高完成度、少空话、先取证再结论；用户应能「看着 Timeline 看你干活」。',
    '',
    '## 证据纪律（最高优先级）',
    '- 论文内主张：必须先 get_paper_overview / search_paper_text / read_paper_page（或 read_paper_pages）取证，结论标注「第 N 页」。',
    '- 外部文献：必须 search_arxiv / lookup_citation / fetch_url 查到原始来源，给出链接或 arXiv id；禁止只根据本论文 related work 转述就下定论。',
    '- 用户问「文献 [N]」：先在参考文献中 search/read 找到条目标题，再 lookup_citation 查它本身。',
    '- 三种来源必须分开写清：① 本论文（页码）② 外部来源（链接）③ 你的推断（标「推断」）。',
    '- 查不到就说查不到；不编造标题、作者、数字、链接或页码。',
    '',
    '## 执行方式',
    '- 复杂任务先在心中拆步，再连续调用工具直到证据足够，再给出最终结构化回答。',
    '- 不要在尚未取证时写长篇最终答案；工具轮可以很短或为空。',
    '- 同一检索不要无意义重复；换关键词或换页继续。',
    '- 公式用 $...$ / $$...$$；列表清晰；重要结论置顶。',
    '- 可用 save_research_note 把成熟结论写入工作台笔记（短标题 + 含页码正文）。',
    '- 长任务可 add_research_todo / remember_research_fact 写入课题记忆；先 list_project_memory 可接上跨会话进度。',
    '- 用户的个人积累在知识库：search_knowledge_base / read_knowledge_note 查用户自己的笔记（回答「我以前记过什么」）。',
    '- 前沿动态用 fetch_frontier_papers（按用户兴趣排序的最新提交）；值得读的可 add_to_reading_list。',
    '- 投稿规划用 list_submission_deadlines 查用户设置的 DDL；不要编造截稿日期。',
    '- 导出报告用 export_markdown_report；Overleaf 用 prepare_overleaf_section（复制 LaTeX，不直接改远程）。',
    '- 写盘类工具在副驾驶模式下会请求用户确认；被拒绝时换策略继续，不要假装已写入。',
    '- 凡引用本论文，正文里写「第 N 页」，便于界面生成可点击证据卡。',
    '- 逐页讲解或用户问「带我看」时，可用 show_page_to_user 把阅读器同步滚到该页（勿滥用，一次回答至多 2 次）。',
  ].join('\n');
}

/**
 * 组装 system prompt。
 * @param {{ targetLang?: string, paperTitle?: string, paperPages?: number, skillBlock?: string, extraRules?: string }} opts
 */
export function buildResearchSystemPrompt(opts = {}) {
  const {
    targetLang = '简体中文',
    paperTitle = '',
    paperPages = 0,
    skillBlock = '',
    extraRules = '',
  } = opts;
  const paperLine = paperTitle
    ? `当前打开的论文：《${paperTitle}》${paperPages ? `（共 ${paperPages} 页，文本层已注入工具）` : ''}。`
    : '当前没有打开论文。论文内问题请提示用户先打开 PDF；仍可做联网调研。';
  return [
    researchConstitution({ targetLang }),
    '',
    '## 当前工作区',
    paperLine,
    skillBlock ? `\n## 本回合技能\n${skillBlock}` : '',
    extraRules ? `\n## 额外规则\n${extraRules}` : '',
  ].filter(Boolean).join('\n');
}

/** @deprecated 兼容旧测试与 CLI；请优先用 buildResearchSystemPrompt */
export function agentSystemPrompt({ targetLang = '简体中文', paperTitle = '' } = {}) {
  return buildResearchSystemPrompt({ targetLang, paperTitle });
}

function toolCallKey(name, args) {
  try {
    return `${name}::${JSON.stringify(args, Object.keys(args || {}).sort())}`;
  } catch {
    return `${name}::`;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('已取消');
    err.code = 'ABORTED';
    throw err;
  }
}

/**
 * 运行一轮 Research Agent（多步工具循环）。
 * onEvent: status | round | plan | tool-confirm | tool-start | tool-done | delta | answer | cancelled
 * confirmTool: 写操作确认，返回 true 放行；副驾驶下 requiresConfirmation 工具会调用它。
 * agentMode: copilot（默认，写操作确认）| autopilot（跳过确认）。
 */
export async function runAgentTurn({
  chatFn,
  registry,
  messages,
  maxRounds = 16,
  signal = null,
  onEvent = () => {},
  suppressDuplicateTools = true,
  confirmTool = null,
  agentMode = 'copilot',
} = {}) {
  const turns = [...messages];
  const trace = [];
  const seenToolKeys = new Set();
  const limit = Math.max(1, Math.min(32, Number(maxRounds) || 16));
  const mode = agentMode === 'autopilot' ? 'autopilot' : 'copilot';

  onEvent('status', { phase: 'start', maxRounds: limit, agentMode: mode });

  for (let round = 0; round < limit; round += 1) {
    throwIfAborted(signal);
    onEvent('round', { round: round + 1, maxRounds: limit });

    const reply = await chatFn({
      messages: turns,
      tools: registry.toOpenAiTools(),
      onDelta: (delta) => {
        if (signal?.aborted) return;
        onEvent('delta', { delta });
      },
      signal,
    });

    throwIfAborted(signal);

    const toolCalls = (Array.isArray(reply?.tool_calls) ? reply.tool_calls : [])
      // 严格协议化：Gemini 等实现要求每个 tool_call 带 type:'function' 和非空 id，
      // 否则下一轮回传历史时报 400 INVALID_ARGUMENT（流式聚合默认没有 type）。
      .map((call, i) => ({
        id: String(call?.id || '').trim() || `call_${round}_${i}`,
        type: 'function',
        function: {
          name: call?.function?.name || '',
          arguments: call?.function?.arguments || '',
        },
      }));
    const preContent = String(reply?.content || '').trim();

    if (toolCalls.length && preContent) {
      onEvent('plan', { text: preContent, round: round + 1 });
    }

    if (!toolCalls.length) {
      const answer = preContent || '（空回答）';
      onEvent('answer', { answer });
      onEvent('status', { phase: 'done', rounds: round + 1 });
      return { answer, trace, rounds: round + 1, cancelled: false };
    }

    turns.push({
      role: 'assistant',
      content: reply.content || '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      throwIfAborted(signal);
      const name = call?.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(call?.function?.arguments || '{}');
      } catch {
        args = {};
      }

      const key = toolCallKey(name, args);
      if (suppressDuplicateTools && seenToolKeys.has(key)) {
        const dup = {
          ok: false,
          error: '重复的相同工具调用已跳过；请换参数或基于已有结果继续。',
          duplicate: true,
        };
        onEvent('tool-done', { name, ok: false, duplicate: true, args });
        trace.push({ name, args, ok: false, duplicate: true });
        turns.push({
          role: 'tool',
          tool_call_id: call.id || `${name}-${round}-dup`,
          content: JSON.stringify(dup).slice(0, 4000),
        });
        continue;
      }
      seenToolKeys.add(key);

      const tool = registry.get(name);
      const needsConfirm = Boolean(tool?.requiresConfirmation) && mode !== 'autopilot';

      if (needsConfirm) {
        const preview = buildConfirmPreview(name, args);
        onEvent('tool-confirm', { name, args, preview, round: round + 1 });
        let allowed = false;
        if (typeof confirmTool === 'function') {
          try {
            allowed = Boolean(await confirmTool({ name, args, preview }));
          } catch {
            allowed = false;
          }
        }
        throwIfAborted(signal);
        if (!allowed) {
          const denied = {
            ok: false,
            error: '用户拒绝了该写操作（副驾驶确认门）。请改用口头建议或等待用户明确允许。',
            denied: true,
          };
          onEvent('tool-done', { name, ok: false, denied: true, args, preview: '已拒绝' });
          trace.push({ name, args, ok: false, denied: true });
          turns.push({
            role: 'tool',
            tool_call_id: call.id || `${name}-${round}-deny`,
            content: JSON.stringify(denied).slice(0, 4000),
          });
          continue;
        }
      }

      onEvent('tool-start', { name, args, round: round + 1 });
      let result;
      if (!tool) {
        result = { ok: false, error: `未知工具：${name}` };
      } else {
        try {
          const data = await tool.run(args, { signal });
          result = { ok: true, data };
        } catch (error) {
          if (error?.code === 'ABORTED' || signal?.aborted) throw error;
          result = { ok: false, error: String(error?.message || error) };
        }
      }
      const traceEntry = { name, args, ok: result.ok };
      if (result.ok && name === 'read_paper_page' && args?.page) {
        traceEntry.resultPages = [Math.round(Number(args.page))];
      }
      if (result.ok && name === 'search_paper_text' && Array.isArray(result.data?.hits)) {
        traceEntry.resultPages = result.data.hits.map((h) => h.page).filter(Boolean);
      }
      trace.push(traceEntry);
      onEvent('tool-done', {
        name,
        ok: result.ok,
        args,
        preview: result.ok
          ? summarizeToolData(result.data)
          : String(result.error || '').slice(0, 160),
      });
      turns.push({
        role: 'tool',
        tool_call_id: call.id || `${name}-${round}`,
        content: JSON.stringify(result).slice(0, 24000),
      });
    }
  }

  const answer = '（已达到本回合工具轮次上限。你可以让我「继续」或把问题拆小。）';
  onEvent('answer', { answer });
  onEvent('status', { phase: 'limit', rounds: limit });
  return { answer, trace, rounds: limit, cancelled: false };
}

function buildConfirmPreview(name, args) {
  try {
    if (name === 'save_research_note') {
      return `写入笔记「${String(args?.title || '').slice(0, 40)}」`;
    }
    if (name === 'export_markdown_report') {
      return `导出 Markdown「${String(args?.title || 'report').slice(0, 40)}」（${String(args?.content || '').length} 字）`;
    }
    if (name === 'prepare_overleaf_section') {
      return `生成 Overleaf section「${String(args?.sectionTitle || 'Section').slice(0, 40)}」并复制`;
    }
    if (name === 'export_bibtex_stub') {
      return `生成 BibTeX：${String(args?.title || '').slice(0, 50)}`;
    }
    return `${name} ${JSON.stringify(args || {}).slice(0, 100)}`;
  } catch {
    return name;
  }
}

function summarizeToolData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.slice(0, 120);
  try {
    const s = JSON.stringify(data);
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  } catch {
    return '';
  }
}

/** OpenAI 兼容 chat（非流式）。 */
export function createOpenAiChat({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return async function chatFn({ messages, tools, signal } = {}) {
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.3,
      }),
      signal,
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
 * 流式 chat（SSE）：正文增量 onDelta；tool_calls 按 index 聚合。
 */
export function createOpenAiStreamingChat({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return async function chatFn({ messages, tools, onDelta = () => {}, signal } = {}) {
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
      signal,
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
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* noop */ }
        const err = new Error('已取消');
        err.code = 'ABORTED';
        throw err;
      }
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
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
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
