// Lightweight research agent for PaperLens: multi-step tool use over the open paper.
// Tools run in the viewer; the model only proposes CALL lines then a final answer.
import { compactResearchDialogue, normalizeEvidenceItems } from './paper-retrieval.js';

export const RESEARCH_AGENT_MAX_ROUNDS = 5;
export const RESEARCH_AGENT_TOOL_RESULT_MAX = 3800;
/** Conversation turns kept for deep-read multi-turn continuity (excl. system). */
export const RESEARCH_AGENT_MAX_HISTORY_TURNS = 28;
/** Soft-clip long prior assistant answers so more dialogue rounds fit. */
export const RESEARCH_AGENT_HISTORY_TURN_MAX_CHARS = 4500;

export const RESEARCH_TOOLS = Object.freeze([
  {
    name: 'get_paper_meta',
    description: '获取论文标题、总页数、已译页数、当前阅读页。',
    args: {},
  },
  {
    name: 'get_current_page',
    description: '获取用户当前正在阅读的页码及该页译文/正文。',
    args: {},
  },
  {
    name: 'get_page',
    description: '获取指定页的译文/正文。args: {"page": 页码数字}',
    args: { page: 'number' },
  },
  {
    name: 'get_page_range',
    description: '连续读取一小段页码范围，适合跨页算法或实验。args: {"start": 起始页, "end": 结束页}（最多 6 页）',
    args: { start: 'number', end: 'number' },
  },
  {
    name: 'goto_page',
    description: '仅当用户明确要求跳页时请求跳转；普通取证必须用 get_page。args: {"page": 页码数字}',
    args: { page: 'number' },
  },
  {
    name: 'search_paper',
    description: '对译文与 PDF 原文做相关度检索（支持中英、词形、公式符号）。args: {"query": "关键词"}',
    args: { query: 'string' },
  },
  {
    name: 'retrieve_evidence',
    description: '按当前问题检索并返回带来源类型、相关度和页码的证据包。args: {"query": "问题或检索式"}',
    args: { query: 'string' },
  },
  {
    name: 'list_pages',
    description: '列出各页状态与前几十字摘要，便于定位要读的页。',
    args: {},
  },
  {
    name: 'get_outline',
    description: '提取全文标题大纲（章节标题 + 页码），用于把握结构、定位 Related Work / 实验等章节。',
    args: {},
  },
  {
    name: 'get_my_notes',
    description: '读取用户在本篇论文中已保存的科研笔记（用户亲自收藏的要点）。',
    args: {},
  },
  {
    name: 'search_my_notes',
    description: '跨论文检索用户的全部历史科研笔记，用于「结合我的笔记 / 和我读过的论文对比」。args: {"query": "关键词"}',
    args: { query: 'string' },
  },
]);

/**
 * @param {string} targetLang
 * @param {{ paperBrief?: string, currentPageBrief?: string }} [session]
 */
export function researchAgentSystemPrompt(targetLang = '简体中文', session = {}) {
  const toolLines = RESEARCH_TOOLS.map(
    (tool) => `- ${tool.name}: ${tool.description}`,
  ).join('\n');
  const paperBrief = String(session?.paperBrief || '').trim();
  const currentPageBrief = String(session?.currentPageBrief || '').trim();
  const evidenceBrief = String(session?.evidenceBrief || '').trim();
  const priorEvidenceBrief = String(session?.priorEvidenceBrief || '').trim();
  const lines = [
    `你是 PaperLens 的科研助手（Research Agent），帮助用户深读当前打开的学术论文。`,
    `请始终用${targetLang}回答，除非用户明确要求其他语言。`,
    ``,
    `## 多轮对话（非常重要）`,
    `- 消息历史是连续深读对话：必须结合上文用户问题与你已给出的回答理解指代。`,
    `- 「这个 / 那个 / 上面 / 继续 / 为什么 / 展开讲」都指向上文话题或你刚写过的结论，不要当成全新开场。`,
    `- 接话时先对齐上文主题，再补充或修正；不要每次重新自我介绍或假装不记得上文。`,
    `- 若上文证据已够，可直接 FINAL；仅在需要新页码/新检索时再 CALL。`,
    `- 最终回答面向用户，不要复述 CALL 协议。`,
    ``,
    `你可以通过工具查阅论文（禁止编造页码、实验数字或论文未写的结论）：`,
    toolLines,
    ``,
    `工作方式：`,
    `1. 需要证据时，先只输出工具调用，每行一个，格式严格为：`,
    `CALL <tool_name> <json_args>`,
    `例如：`,
    `CALL get_paper_meta {}`,
    `CALL list_pages {}`,
    `CALL get_current_page {}`,
    `CALL get_page {"page":3}`,
    `CALL get_page_range {"start":3,"end":5}`,
    `CALL search_paper {"query":"复杂度"}`,
    `CALL retrieve_evidence {"query":"本文的核心创新和实验依据"}`,
    `CALL goto_page {"page":7}`,
    `CALL get_outline {}`,
    `CALL get_my_notes {}`,
    `CALL search_my_notes {"query":"attention"}`,
    `2. 拿到工具结果后继续推理；需要再查就继续 CALL。`,
    `3. 信息足够时输出最终回答：单独一行 FINAL，下一行起写正文：`,
    `FINAL`,
    `（完整回答）`,
    ``,
    `回答规范（科研笔记风格）：`,
    `- 结论必须尽量带来源页码，写作「第 N 页」以便用户点击跳转。`,
    `- 区分「文中写到」与「我的推断」；未读到就写「文中未找到」或「该页尚未翻译」。`,
    `- 表格与图片以左侧 PDF 为准；不要编造表中数字。若工具未返回表数据，请写「见表（左侧原表）」并标页码。`,
    `- 下方「会话论文上下文」已含 meta / 页列表 / 当前页摘要与问题相关证据时，优先使用，不要重复 CALL 相同内容，除非需要刷新或读其它页。`,
    `- 只引用自动证据包或工具实际返回过的页；不能仅凭页列表摘要扩写实验数字。`,
    `- 普通取证不得 CALL goto_page，以免打断用户当前阅读位置；只有用户明确说“跳到第 N 页”时才可调用。`,
    `- 结构清晰：短标题 + 分点；公式用 $...$ / $$...$$。`,
    `- 保留方法名、数据集、缩写与引用标记。`,
    `- 工具返回「[未译·原文]」开头的内容是该页尚未翻译的原文，可直接依据它作答，但请注明「基于原文」。`,
    `- 不要输出与论文无关的客套；不要假装调用了工具。`,
    `- 当用户问「结合我的笔记 / 我以前读过的 / 和我读过的论文对比 / 我记过什么」时，先 CALL get_my_notes 或 search_my_notes；笔记是用户个人观点与摘录，引用时注明「你的笔记」，并与论文原文区分。`,
  ];
  if (paperBrief || currentPageBrief || evidenceBrief || priorEvidenceBrief) {
    lines.push('', '## 会话论文上下文（每轮自动刷新，请当作已知背景）');
    if (paperBrief) lines.push(paperBrief);
    if (currentPageBrief) lines.push('', currentPageBrief);
    if (evidenceBrief) lines.push('', evidenceBrief);
    if (priorEvidenceBrief) lines.push('', priorEvidenceBrief);
  }
  return lines.join('\n');
}

/**
 * Build pure dialogue turns for the agent (user/assistant only).
 * Ensures the latest user question remains the last message.
 */
export function assembleAgentDialogueTurns(history = [], {
  excludeEntry = null,
  maxTurns = RESEARCH_AGENT_MAX_HISTORY_TURNS,
  maxChars = RESEARCH_AGENT_HISTORY_TURN_MAX_CHARS,
} = {}) {
  const turns = [];
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry === excludeEntry) continue;
    if (entry?.role !== 'user' && entry?.role !== 'assistant') continue;
    let content = String(entry.content || '').trim();
    if (!content && entry.role === 'assistant') continue;
    if (maxChars > 0 && content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n…(上文已截断，仅保留要点前缀)`;
    }
    turns.push({ role: entry.role, content });
  }
  if (maxTurns > 0 && turns.length > maxTurns) {
    return compactResearchDialogue(turns, {
      maxTurns,
      recentTurns: Math.max(6, Math.floor(maxTurns * 0.62)),
    });
  }
  return turns;
}

/** Expand a short follow-up into a searchable query using the previous user turn. */
export function buildContextualEvidenceQuery(history = [], currentQuestion = '', { maxChars = 700 } = {}) {
  const current = String(currentQuestion || '').replace(/\s+/gu, ' ').trim();
  if (!current) return '';
  const referential = current.length <= 18
    || /^(继续|展开|详细说|为什么|怎么理解|这个|那个|上面|这里|还有呢|然后呢|具体呢)/u.test(current);
  if (!referential) return current.slice(0, maxChars);
  const prior = [...(Array.isArray(history) ? history : [])].reverse().find((turn) => (
    turn?.role === 'user' && String(turn?.content || '').trim()
  ));
  const previous = String(prior?.content || '').replace(/\s+/gu, ' ').trim();
  if (!previous || previous === current) return current.slice(0, maxChars);
  return `${previous}\n跟进问题：${current}`.slice(0, maxChars);
}

/**
 * 问题是否明确锚定某一页（「当前页 / 这页 / 本页」或「第 N 页」）。
 * 锚定页的完整内容会被强制置顶为第一证据——否则 BM25 容易被引言/综述页
 * 的高词频带偏（如问「当前页的算法」，第 1 页满屏“XX 算法”反而排最前）。
 */
export function detectPageAnchor(question, currentPage = null) {
  const text = String(question || '').trim();
  if (!text) return { anchored: false, page: null };
  const explicit = /第\s*(\d{1,5})\s*页/u.exec(text);
  if (explicit) {
    const page = Number(explicit[1]);
    return { anchored: true, page: Number.isFinite(page) && page >= 1 ? page : null };
  }
  if (/(当前页面?|这一?页|本页|这个页面|页面上|screenshot|截图里|附图)/u.test(text)) {
    const page = Number(currentPage);
    return { anchored: true, page: Number.isFinite(page) && page >= 1 ? page : null };
  }
  return { anchored: false, page: null };
}

/** Parse model output into tool calls and/or final answer. */
export function parseAgentResponse(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const calls = [];
  const callRe = /^CALL\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*?\})?\s*$/gm;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const name = match[1];
    let args = {};
    if (match[2]) {
      try {
        args = JSON.parse(match[2]);
      } catch {
        args = {};
      }
    }
    if (RESEARCH_TOOLS.some((tool) => tool.name === name)) {
      calls.push({ name, args: args && typeof args === 'object' ? args : {} });
    }
  }

  // Some OpenAI-compatible models ignore the line protocol but return a
  // conventional JSON tool object. Accept it only when no explicit CALL was
  // parsed, keeping ordinary JSON in final prose untouched.
  if (!calls.length) {
    const candidates = source.match(/\{[^{}]*(?:"(?:tool|name)"\s*:\s*"[A-Za-z_][A-Za-z0-9_]*")[^{}]*\}/gu) || [];
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const name = String(parsed.tool || parsed.name || '');
        if (!RESEARCH_TOOLS.some((tool) => tool.name === name)) continue;
        const args = parsed.args && typeof parsed.args === 'object'
          ? parsed.args
          : parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
        calls.push({ name, args });
      } catch { /* not a tool object */ }
    }
  }

  const finalMatch = /^FINAL\s*\n([\s\S]*)$/im.exec(source);
  let finalAnswer = finalMatch ? String(finalMatch[1] || '').trim() : '';

  if (!finalAnswer && !calls.length) {
    finalAnswer = source.trim();
  }

  return { calls, finalAnswer, raw: source };
}

function stableToolSignature(call = {}) {
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  const sorted = {};
  Object.keys(args).sort().forEach((key) => { sorted[key] = args[key]; });
  return `${String(call?.name || '')}:${JSON.stringify(sorted)}`;
}

/** Remove repeated model tool calls so a confused model cannot loop forever. */
export function dedupeResearchToolCalls(calls = [], executedSignatures = new Set()) {
  const unique = [];
  const skipped = [];
  const seen = new Set(executedSignatures instanceof Set ? executedSignatures : []);
  for (const call of Array.isArray(calls) ? calls : []) {
    const signature = stableToolSignature(call);
    if (!call?.name || seen.has(signature)) {
      skipped.push({ call, signature });
      continue;
    }
    seen.add(signature);
    unique.push({ ...call, signature });
  }
  return { calls: unique, skipped, signatures: seen };
}

export function formatToolResultsForModel(results = []) {
  const lines = ['工具结果：'];
  for (const item of Array.isArray(results) ? results : []) {
    const name = item?.name || 'tool';
    const ok = item?.ok !== false;
    const body = clipToolText(item?.text || item?.error || '');
    lines.push(`### ${name} (${ok ? 'ok' : 'error'})`);
    lines.push(body || '（空）');
    lines.push('');
  }
  lines.push('若仍需查阅请继续 CALL；否则输出 FINAL 与最终回答。回答中请用「第 N 页」标注证据。');
  return lines.join('\n');
}

function clipToolText(value, max = RESEARCH_AGENT_TOOL_RESULT_MAX) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(已截断)`;
}

/**
 * Execute one tool against a paper snapshot provider.
 * provider may implement:
 *   getPaperMeta(), getCurrentPage(), getPage(n), gotoPage(n),
 *   searchPaper(query), listPages(), getOutline(), getMyNotes(), searchMyNotes(query)
 */
export function executeResearchTool(call, provider = {}) {
  const name = call?.name;
  const args = call?.args || {};
  try {
    if (name === 'get_paper_meta') {
      const data = provider.getPaperMeta?.() || provider.getMeta?.() || {};
      const title = data.title || '（未知标题）';
      const total = data.totalPages ?? data.pages ?? '?';
      const translated = data.translatedCount ?? data.translated ?? '?';
      const current = data.currentPage ?? data.page ?? '?';
      return {
        name,
        ok: true,
        text: [
          `标题：${title}`,
          `总页数：${total}`,
          `已译页数：${translated}`,
          `当前阅读页：${current}`,
        ].join('\n'),
      };
    }
    if (name === 'get_current_page') {
      const data = provider.getCurrentPage?.() || {};
      return { name, ok: true, text: formatPagePayload(data), data };
    }
    if (name === 'get_page') {
      const page = Number(args.page);
      if (!Number.isFinite(page) || page < 1) {
        return { name, ok: false, error: 'page 必须是 >= 1 的数字' };
      }
      const data = provider.getPage?.(page) || {};
      return { name, ok: true, text: formatPagePayload(data), data };
    }
    if (name === 'get_page_range') {
      const start = Math.round(Number(args.start));
      const requestedEnd = Math.round(Number(args.end));
      if (!Number.isFinite(start) || start < 1 || !Number.isFinite(requestedEnd) || requestedEnd < start) {
        return { name, ok: false, error: 'start/end 必须是有效页码，且 end >= start' };
      }
      const end = Math.min(requestedEnd, start + 5);
      const data = provider.getPageRange?.(start, end) || {
        start,
        end,
        pages: Array.from({ length: end - start + 1 }, (_, index) => provider.getPage?.(start + index) || {}),
      };
      const pages = Array.isArray(data.pages) ? data.pages : [];
      return {
        name,
        ok: true,
        text: pages.map((page) => formatPagePayload(page)).join('\n\n') || `第 ${start}–${end} 页暂无可用文本。`,
        data: { ...data, pages },
      };
    }
    if (name === 'goto_page') {
      const page = Number(args.page);
      if (!Number.isFinite(page) || page < 1) {
        return { name, ok: false, error: 'page 必须是 >= 1 的数字' };
      }
      // Agent research is read-only by default. The visible jump remains
      // available through explicit UI page chips, where the user is in control.
      const mayNavigate = provider.allowAgentNavigation === true;
      const data = mayNavigate
        ? (provider.gotoPage?.(page) || provider.getPage?.(page) || {})
        : (provider.getPage?.(page) || {});
      return {
        name,
        ok: true,
        text: `${mayNavigate ? '已请求跳转' : '为避免打断阅读，未自动跳转；已只读查阅'}第 ${page} 页。\n${formatPagePayload(data)}`,
        data,
      };
    }
    if (name === 'search_paper') {
      const query = String(args.query || '').trim();
      if (!query) return { name, ok: false, error: 'query 不能为空' };
      const data = provider.searchPaper?.(query) || { matches: [] };
      const matches = Array.isArray(data.matches) ? data.matches : [];
      if (!matches.length) {
        return { name, ok: true, text: `未找到包含「${query}」的译文片段。可换中/英关键词，或先翻译更多页。` };
      }
      const lines = matches.slice(0, 12).map((m, i) => (
        `${i + 1}. 第 ${m.page} 页${m.sourceType ? ` · ${m.sourceType === 'source' ? 'PDF 原文' : '译文'}` : ''}${Number.isFinite(Number(m.score)) ? ` · 相关度 ${Number(m.score).toFixed(2)}` : ''}：${clipToolText(m.snippet, 320)}`
      ));
      return { name, ok: true, text: lines.join('\n'), data: { matches } };
    }
    if (name === 'retrieve_evidence') {
      const query = String(args.query || '').trim();
      if (!query) return { name, ok: false, error: 'query 不能为空' };
      const data = provider.retrieveEvidence?.(query, { includeNeighbors: true, maxPages: 6 }) || {};
      const body = String(data.text || '').trim();
      if (!body) return { name, ok: true, text: `未检索到与「${query}」相关的可用证据。` };
      return { name, ok: true, text: body, data };
    }
    if (name === 'list_pages') {
      const data = provider.listPages?.() || { pages: [] };
      const pages = Array.isArray(data.pages) ? data.pages : [];
      if (!pages.length) return { name, ok: true, text: '当前没有打开的 PDF 页。' };
      const lines = pages.map((p) => (
        `- 第 ${p.page} 页 · ${p.status || '未知'}${p.preview ? ` · ${clipToolText(p.preview, 80)}` : ''}`
      ));
      return { name, ok: true, text: lines.join('\n') };
    }
    if (name === 'get_outline') {
      const data = provider.getOutline?.() || { items: [] };
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        return {
          name,
          ok: true,
          text: '未提取到标题大纲（页面尚未翻译，或译文中没有 Markdown 标题）。可改用 list_pages 浏览各页摘要。',
        };
      }
      const lines = items.slice(0, 80).map((it) => {
        const level = Math.max(1, Math.min(4, Number(it.level) || 1));
        return `${'  '.repeat(level - 1)}- ${String(it.text || '').trim()}（第 ${it.page} 页）`;
      });
      return { name, ok: true, text: lines.join('\n') };
    }
    if (name === 'get_my_notes') {
      const notes = provider.getMyNotes?.() || { items: [] };
      const items = Array.isArray(notes.items) ? notes.items : [];
      if (!items.length) {
        return { name, ok: true, text: '本篇论文还没有已保存的科研笔记。可建议用户在回答下点「收入笔记」。' };
      }
      const lines = items.slice(-12).map((it, i) => {
        const title = String(it.title || '笔记').trim();
        const content = clipToolText(String(it.content || ''), 400);
        return `${i + 1}. 【${title}】${content}`;
      });
      return { name, ok: true, text: `用户在本篇论文保存的笔记（共 ${items.length} 条，展示最近 ${lines.length} 条）：\n${lines.join('\n')}` };
    }
    if (name === 'search_my_notes') {
      const query = String(args.query || '').trim();
      if (!query) return { name, ok: false, error: 'query 不能为空' };
      const hits = provider.searchMyNotes?.(query) || [];
      if (!Array.isArray(hits) || !hits.length) {
        return { name, ok: true, text: `你的历史笔记（所有论文）中未找到「${query}」。` };
      }
      const lines = hits.slice(0, 10).map((hit, i) => {
        const docTitle = String(hit.docTitle || '未命名论文').slice(0, 60);
        const noteTitle = String(hit.noteTitle || '笔记').slice(0, 40);
        const snippet = clipToolText(String(hit.snippet || ''), 240);
        return `${i + 1}. 《${docTitle}》· ${noteTitle}：${snippet}`;
      });
      return { name, ok: true, text: `在你的历史笔记中找到 ${lines.length} 条与「${query}」相关：\n${lines.join('\n')}` };
    }
    return { name: name || 'unknown', ok: false, error: `未知工具：${name}` };
  } catch (error) {
    return { name: name || 'tool', ok: false, error: String(error?.message || error) };
  }
}

function formatPagePayload(data = {}) {
  const page = data.page ?? '?';
  const status = data.status || '';
  const text = clipToolText(data.text || '', RESEARCH_AGENT_TOOL_RESULT_MAX);
  if (!text) {
    return `第 ${page} 页（${status || '无译文'}）：暂无可用文本。可请用户先翻译该页。`;
  }
  return `第 ${page} 页（${status || '已加载'}）：\n${text}`;
}

/** Default starter prompts for research-agent empty state. */
export function defaultResearchAgentStarters() {
  return [
    '先了解全文结构，再做一键导读：问题、方法、实验与局限，标明页码。',
    '定位并解释时间复杂度 / 计算开销相关论述，标明页码。',
    '根据算法伪代码，用白话说明主流程与关键创新点。',
    '以审稿人视角列出本文 3 个优点、3 个弱点和 2 个该问作者的问题，标明页码。',
    '这篇和我读过的论文有何关联？先检索我的历史笔记再对比。',
  ];
}

/**
 * Run a free local bootstrap (no model round): paper meta + page list + current page.
 * Used as system-session context (not appended after the user question).
 */
export function buildAgentBootstrap(provider = {}, { query = '' } = {}) {
  const metaResult = executeResearchTool({ name: 'get_paper_meta', args: {} }, provider);
  const listResult = executeResearchTool({ name: 'list_pages', args: {} }, provider);
  const currentResult = executeResearchTool({ name: 'get_current_page', args: {} }, provider);
  const results = [metaResult, listResult, currentResult];
  const steps = [
    { name: 'get_paper_meta', label: '读取论文元信息', ok: metaResult.ok !== false, page: null },
    { name: 'list_pages', label: '浏览各页概览', ok: listResult.ok !== false, page: null },
    {
      name: 'get_current_page',
      label: '阅读当前页',
      ok: currentResult.ok !== false,
      page: null,
    },
  ];

  let evidenceBrief = '';
  let evidencePages = [];
  let evidenceSourceTypes = [];
  let evidenceItems = [];
  const cleanQuery = String(query || '').trim();

  // 页码锚定：用户明确问「当前页 / 第 N 页」时，该页全文强制置顶为第一证据，
  // BM25 结果只作补充。防止引言/综述页靠词频挤掉用户真正指定的页。
  let liveCurrentPage = null;
  try {
    const live = provider.getCurrentPage?.();
    if (live?.page != null) liveCurrentPage = Number(live.page);
  } catch { /* noop */ }
  const anchor = detectPageAnchor(cleanQuery, liveCurrentPage);
  let anchorBrief = '';
  if (anchor.anchored && Number.isFinite(anchor.page) && anchor.page >= 1) {
    try {
      const anchorData = provider.getPage?.(anchor.page) || {};
      const anchorText = clipToolText(anchorData.text || '', RESEARCH_AGENT_TOOL_RESULT_MAX);
      if (anchorText) {
        anchorBrief = [
          `### 用户问题锚定页：第 ${anchor.page} 页（回答必须以本页内容为主要依据）`,
          anchorText,
        ].join('\n');
        evidencePages.push(anchor.page);
        evidenceItems.push(...normalizeEvidenceItems([{
          page: anchor.page,
          snippet: anchorData.text || '',
          sourceType: anchorData.sourceType === 'source' ? 'source' : 'translation',
          heading: anchorData.heading || '',
          score: 99,
          termCoverage: 1,
        }]));
        steps.push({
          name: 'get_page',
          label: `精读锚定页 · 第 ${anchor.page} 页`,
          ok: true,
          page: anchor.page,
        });
      }
    } catch { /* anchored page unavailable — retrieval still runs below */ }
  }

  if (cleanQuery && typeof provider.retrieveEvidence === 'function') {
    try {
      const evidence = provider.retrieveEvidence(cleanQuery, { includeNeighbors: true, maxPages: 6 }) || {};
      evidenceBrief = clipToolText(evidence.text || '', 7200);
      evidencePages = [...new Set([
        ...evidencePages,
        ...(evidence.pages || []).map(Number).filter((page) => page >= 1),
      ])];
      evidenceSourceTypes = [...new Set((evidence.sourceTypes || []).map(String).filter(Boolean))];
      evidenceItems = normalizeEvidenceItems([
        ...evidenceItems,
        ...(evidence.matches || []),
      ]);
      if (evidenceBrief) {
        steps.push({
          name: 'retrieve_evidence',
          label: `自动检索证据${evidencePages.length ? ` · ${evidencePages.length} 页` : ''}`,
          ok: true,
          page: evidencePages.length === 1 ? evidencePages[0] : null,
        });
      }
    } catch { /* evidence retrieval is an optional local accelerator */ }
  }
  // 锚定页排最前：无论 BM25 怎么排，锚定页内容都在证据区顶部。
  if (anchorBrief) {
    evidenceBrief = evidenceBrief ? `${anchorBrief}\n\n${evidenceBrief}` : anchorBrief;
  }

  let translatedCount = 0;
  let totalPages = 0;
  let currentPage = null;
  try {
    const meta = provider.getPaperMeta?.() || provider.getMeta?.() || {};
    translatedCount = Number(meta.translatedCount ?? meta.translated) || 0;
    totalPages = Number(meta.totalPages ?? meta.pages) || 0;
    currentPage = meta.currentPage ?? meta.page ?? null;
    const live = provider.getCurrentPage?.();
    if (live?.page != null) currentPage = live.page;
    // Prefer numeric page on the current-page tool step for clickable trail.
    const n = Number(currentPage);
    if (Number.isFinite(n) && n >= 1) steps[2].page = n;
  } catch { /* noop */ }

  // 未译页现在能回退到 PDF 原文文本（[未译·原文]），所以「零译文」不再等于「零信息」。
  let pagesWithText = 0;
  try {
    const data = provider.listPages?.() || { pages: [] };
    const pages = Array.isArray(data.pages) ? data.pages : [];
    pagesWithText = pages.filter((p) => String(p?.preview || '').trim()).length;
  } catch { /* noop */ }

  const warning = translatedCount <= 0
    ? (pagesWithText > 0
      ? '尚无已译页：助手将直接基于 PDF 原文文本作答（结论会注明来源页码）。翻译完成后回答会更贴合译文。'
      : '当前几乎没有已译页。请先等待或重试翻译若干页，再问方法/实验问题；否则只能基于空结果作答。')
    : (translatedCount < 3 && totalPages > 5
      ? `目前仅约 ${translatedCount}/${totalPages || '?'} 页有译文，导读与跨页结论可能不完整。`
      : '');

  // 免费本地大纲：有标题时并入快照，模型无需先 CALL get_outline。
  let outlineBrief = '';
  try {
    const outlineResult = executeResearchTool({ name: 'get_outline', args: {} }, provider);
    if (outlineResult.ok !== false && outlineResult.text && !/未提取到标题大纲/.test(outlineResult.text)) {
      outlineBrief = clipToolText(outlineResult.text, 1800);
    }
  } catch { /* noop */ }

  // Compact briefs for system prompt (keep tool payloads shorter than full formatToolResults).
  const paperBrief = [
    '### 论文快照',
    metaResult.text || '',
    '',
    ...(outlineBrief ? ['### 全文结构（标题 + 页码）', outlineBrief, ''] : []),
    '### 各页概览',
    listResult.text || '',
  ].join('\n').trim();

  const currentPageBrief = [
    '### 用户当前阅读页（指代「这页 / 这里」时优先看这里）',
    currentResult.text || '',
  ].join('\n').trim();

  return {
    results,
    steps,
    modelMessage: formatToolResultsForModel(results),
    paperBrief: clipToolText(paperBrief, 6000),
    currentPageBrief: clipToolText(currentPageBrief, RESEARCH_AGENT_TOOL_RESULT_MAX),
    evidenceBrief,
    evidencePages,
    evidenceSourceTypes,
    evidenceItems,
    translatedCount,
    totalPages,
    currentPage,
    warning,
  };
}
