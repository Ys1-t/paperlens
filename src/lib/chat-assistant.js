// src/lib/chat-assistant.js
// AI 聊天辅助面板的纯逻辑：system prompt、多轮消息拼装、选中内容注入、页图、导出。
// DOM 渲染、Port 请求与面板事件绑定在 src/viewer/chat-panel.js。
//
// 聊天复用用户已配置的翻译 Profile（同一 baseUrl/apiKey/model），走**多轮 chat**，
// 与单条翻译不同：请求携带完整 messages 数组，SW 端新增 `chat` 消息类型处理
// （见 docs/TECHNICAL.md §6）。聊天历史仅存内存、不写译文缓存。

// 单条消息文本上限，防止极端长选区/长回复把请求体撑爆。
export const CHAT_MESSAGE_MAX_CHARS = 8000;
// 发送给模型的历史轮数上限（不含 system）；过长历史按最近若干条截断。
export const CHAT_HISTORY_MAX_MESSAGES = 20;
// 「问 AI」预填问题里引用选中原文的字符预算。
export const CHAT_SELECTION_MAX_CHARS = 1500;
// 多轮请求里最多附带几张页图，避免 payload 过大。
export const CHAT_MAX_IMAGES_IN_REQUEST = 2;

/** 选中即问的意图：一键解释 / 白话 / 为什么 / 仅挂引用由用户自拟问题。 */
export const ASK_AI_INTENTS = Object.freeze({
  explain: 'explain',
  plain: 'plain',
  why: 'why',
  custom: 'custom',
});

/** 帮助用户理解学术论文的助手提示词；用中文回答，可解释术语、概括段落、答疑。 */
export function chatSystemPrompt(targetLang = '简体中文') {
  return [
    `你是 PaperLens 阅读器里的科研助手，帮助用户理解正在阅读的学术论文。`,
    `请始终用${targetLang}回答，除非用户明确要求其他语言。`,
    `你可以：解释专业术语与符号、概括段落或章节大意、回答用户关于选中内容的问题、梳理论文方法与结论。`,
    `回答要求：`,
    `- 准确、简洁，紧扣用户的问题；不确定时如实说明，不要臆造论文中不存在的结论。`,
    `- 尽量标注依据（如「根据选中段落」「从页图可见」）；区分文中事实与你的推断。`,
    `- 涉及公式或数学符号时，用 $...$ 或 $$...$$ 的 LaTeX 表达，便于阅读器渲染。`,
    `- 保留论文中的方法名、数据集名、缩写和引用标记（如 [12]、(Smith et al., 2020)）不译。`,
    `- 用户可能会附上从论文里选中的一段文字作为引用上下文，请围绕它作答。`,
    `- 若用户从你之前的回答中再次选中片段追问，请基于该片段继续深入，避免整段重复。`,
    `- 用户可能附上当前 PDF 页的截图：请结合图像中的排版、公式、图表作答，不要假装看到图中没有的内容。`,
    `- 结构优先：短标题 + 分点；适合粘贴进科研笔记。`,
  ].join('\n');
}

/** 规范化聊天输入文本：去除首尾空白，折叠不可见控制字符，按上限截断。 */
export function normalizeChatText(raw, { maxChars = CHAT_MESSAGE_MAX_CHARS } = {}) {
  const text = String(raw ?? '').replace(/\r\n?/gu, '\n').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/** 选中片段是否适合拿去问 AI（短标点、空白不要）。 */
export function isAskableSelectionText(text, {
  minChars = 1,
  maxChars = CHAT_SELECTION_MAX_CHARS,
} = {}) {
  const value = collapseWhitespace(text);
  if (value.length < minChars) return false;
  if (value.length > maxChars) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

/** 截断后的选中摘录（供引用条展示 / 提问模板）。 */
export function clipSelectionExcerpt(selection, { maxChars = CHAT_SELECTION_MAX_CHARS } = {}) {
  return collapseWhitespace(selection).slice(0, maxChars);
}

/**
 * 选中即问：把选中文本 + 可选上下文组织成一条预填问题。
 * intent=custom 时只返回空字符串（由 UI 挂引用、用户自拟问题）。
 */
export function buildAskAiQuestion(selection, {
  context = '',
  intent = ASK_AI_INTENTS.explain,
  maxChars = CHAT_SELECTION_MAX_CHARS,
} = {}) {
  const excerpt = clipSelectionExcerpt(selection, { maxChars });
  if (!excerpt) return '';
  if (intent === ASK_AI_INTENTS.custom) return '';

  const ctx = collapseWhitespace(context).slice(0, maxChars);
  const lead = ({
    [ASK_AI_INTENTS.explain]: '请解释这段内容：',
    [ASK_AI_INTENTS.plain]: '请用通俗白话解释这段内容，尽量少用术语：',
    [ASK_AI_INTENTS.why]: '请说明这段内容在论证什么、为什么这样写：',
  })[intent] || '请解释这段内容：';

  const lines = [lead, '', `“${excerpt}”`];
  if (ctx && ctx !== excerpt) {
    lines.push('', `（上下文参考：${ctx}）`);
  }
  return lines.join('\n');
}

/**
 * 用户自拟问题 + 挂载的选中引用 → 最终发送文本。
 * 无引用时仅返回问题；无问题时仅返回「请解释…」模板。
 */
export function composeUserMessageWithQuote({
  question = '',
  selection = '',
  context = '',
  maxChars = CHAT_SELECTION_MAX_CHARS,
} = {}) {
  const q = normalizeChatText(question);
  const excerpt = clipSelectionExcerpt(selection, { maxChars });
  const ctx = collapseWhitespace(context).slice(0, maxChars);

  if (!excerpt && !q) return '';
  if (!excerpt) return q;
  if (!q) return buildAskAiQuestion(excerpt, { context: ctx, intent: ASK_AI_INTENTS.explain, maxChars });

  const lines = [
    '关于下面这段内容：',
    '',
    `“${excerpt}”`,
  ];
  if (ctx && ctx !== excerpt) {
    lines.push('', `（上下文参考：${ctx}）`);
  }
  lines.push('', q);
  return normalizeChatText(lines.join('\n'));
}

/** 引用条上的短预览（中间省略）。 */
export function formatSelectionQuotePreview(selection, { maxChars = 72 } = {}) {
  const excerpt = clipSelectionExcerpt(selection);
  if (!excerpt) return '';
  if (excerpt.length <= maxChars) return excerpt;
  const head = Math.max(24, Math.floor(maxChars * 0.55));
  const tail = Math.max(12, maxChars - head - 1);
  return `${excerpt.slice(0, head)}…${excerpt.slice(-tail)}`;
}

/** 仅附页图、未写问题时的默认提问。 */
export function defaultPageImageQuestion(pageNum) {
  const n = Number(pageNum);
  const label = Number.isFinite(n) && n > 0 ? `第 ${n} 页` : '当前页';
  return `请结合附图（PDF ${label} 截图）解释这一页在讲什么：核心论点、关键公式/图表，以及和上下文的关系。请用条理清晰的中文回答。`;
}

/** 规范化用户消息附带的 data URL 图片列表。 */
export function normalizeChatImages(images, { maxImages = CHAT_MAX_IMAGES_IN_REQUEST } = {}) {
  const list = [];
  for (const value of Array.isArray(images) ? images : []) {
    const url = String(value || '').trim();
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) continue;
    list.push(url);
    if (maxImages > 0 && list.length >= maxImages) break;
  }
  return list;
}

/** 解析 data URL，供 Gemini inlineData 使用。 */
export function parseDataUrlImage(dataUrl) {
  const source = String(dataUrl || '').trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(source);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * 把内存中的对话历史拼装成发给模型的 messages 数组。
 * history: {role, content, images?, pageNum?}
 * system 置顶；空 assistant 占位不入组；最近 maxImages 条带图 user 保留图像。
 */
export function buildChatMessages(history, {
  targetLang = '简体中文',
  systemPrompt = '',
  maxMessages = CHAT_HISTORY_MAX_MESSAGES,
  maxImages = CHAT_MAX_IMAGES_IN_REQUEST,
} = {}) {
  const system = String(systemPrompt || '').trim() || chatSystemPrompt(targetLang);
  const turns = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = normalizeChatText(entry.content);
    const images = role === 'user' ? normalizeChatImages(entry.images, { maxImages: 1 }) : [];
    if (!content && !images.length) continue;
    const turn = { role, content: content || (images.length ? defaultPageImageQuestion(entry.pageNum) : '') };
    if (images.length) {
      turn.images = images;
      if (entry.pageNum != null) turn.pageNum = entry.pageNum;
    }
    turns.push(turn);
  }
  const trimmed = maxMessages > 0 && turns.length > maxMessages
    ? turns.slice(turns.length - maxMessages)
    : turns;

  // 从后往前只保留 maxImages 张图，更早的 user 消息去掉图像只留文字说明。
  let imageBudget = Math.max(0, Number(maxImages) || 0);
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const turn = trimmed[i];
    if (!turn.images?.length) continue;
    if (imageBudget > 0) {
      imageBudget -= turn.images.length;
      continue;
    }
    const pageNote = turn.pageNum != null ? `（原消息附有第 ${turn.pageNum} 页截图，此处从略）` : '（原消息附有页面截图，此处从略）';
    turn.content = normalizeChatText(`${turn.content}\n\n${pageNote}`);
    delete turn.images;
  }

  return [{ role: 'system', content: system }, ...trimmed];
}

/** 是否含有可供发送的 user 文本或图片。 */
export function userMessageHasContent(message) {
  if (!message || message.role !== 'user') return false;
  if (String(message.content || '').trim()) return true;
  return normalizeChatImages(message.images).length > 0;
}

/** chat 请求至少需要一条非空 user 消息才值得发送。 */
export function hasSendableChatTurn(messages) {
  return Array.isArray(messages) && messages.some((m) => userMessageHasContent(m));
}

/** OpenAI 兼容协议的 message.content（字符串或多模态数组）。 */
export function toOpenAiChatContent(message) {
  const text = String(message?.content ?? '');
  const images = normalizeChatImages(message?.images, { maxImages: 4 });
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const url of images) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  if (!parts.length) parts.push({ type: 'text', text: defaultPageImageQuestion(message?.pageNum) });
  return parts;
}

/** Gemini contents.parts。 */
export function toGeminiChatParts(message) {
  const text = String(message?.content ?? '');
  const images = normalizeChatImages(message?.images, { maxImages: 4 });
  const parts = [];
  if (text.trim()) parts.push({ text });
  for (const url of images) {
    const parsed = parseDataUrlImage(url);
    if (!parsed) continue;
    parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
  }
  if (!parts.length) parts.push({ text: defaultPageImageQuestion(message?.pageNum) });
  return parts;
}

/** 空状态快捷提问（无选中时也能先聊起来）。 */
export function defaultChatStarterPrompts() {
  return [
    '用三句话概括这篇论文在解决什么问题、核心方法是什么。',
    '文中有哪些关键假设或局限性？请分点说明。',
    '如果我是初学者，应该按什么顺序读这篇论文？',
  ];
}

/**
 * 把内存对话导出为 Markdown（页图只记页码，不嵌入 base64）。
 */
export function exportConversationMarkdown(history, {
  docTitle = '',
  exportedAt = new Date(),
} = {}) {
  const title = String(docTitle || '').trim() || '未命名 PDF';
  const when = exportedAt instanceof Date && !Number.isNaN(exportedAt.getTime())
    ? exportedAt.toISOString().replace('T', ' ').slice(0, 19)
    : String(exportedAt || '');
  const lines = [
    '# PaperLens 对话导出',
    '',
    `- 文档：${title}`,
    `- 导出时间：${when}`,
    '',
  ];
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length) {
    lines.push('_（暂无对话）_', '');
    return lines.join('\n');
  }
  let index = 0;
  for (const entry of entries) {
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(entry.content || '').trim();
    const images = normalizeChatImages(entry.images, { maxImages: 4 });
    if (!content && !images.length) continue;
    index += 1;
    const heading = role === 'user' ? `## ${index}. 用户` : `## ${index}. AI 助手`;
    lines.push(heading, '');
    if (images.length) {
      const page = entry.pageNum != null ? `第 ${entry.pageNum} 页` : '页面';
      lines.push(`> 附图：${page}截图（导出时未嵌入二进制图像）`, '');
    }
    lines.push(content || '_（仅附图）_', '');
    if (role === 'assistant') {
      const evidenceLines = conversationEvidenceMarkdown(entry?.evidence);
      if (evidenceLines.length) lines.push(...evidenceLines, '');
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Export bounded evidence provenance without trusting snippets as Markdown. */
export function conversationEvidenceMarkdown(evidence) {
  if (!evidence || typeof evidence !== 'object') return [];
  const supportScore = Number(evidence.support?.score);
  const pages = [...new Set((evidence.citedPages?.length ? evidence.citedPages : evidence.pages || [])
    .map(Number).filter((page) => Number.isFinite(page) && page >= 1))].slice(0, 24);
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(evidence.items) ? evidence.items : []) {
    const page = Number(raw?.page);
    const snippet = String(raw?.snippet || raw?.text || '').replace(/\s+/gu, ' ').trim().slice(0, 520);
    if (!Number.isFinite(page) || page < 1 || !snippet) continue;
    const key = `${page}:${snippet.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      page,
      snippet,
      sourceType: raw?.sourceType === 'source' ? 'PDF 原文' : '译文',
      heading: String(raw?.heading || '').replace(/\s+/gu, ' ').trim().slice(0, 120),
      neighborOf: Number(raw?.neighborOf),
    });
    if (items.length >= 8) break;
  }
  if (!pages.length && !items.length && !Number.isFinite(supportScore)) return [];

  const lines = ['### 证据溯源', ''];
  if (Number.isFinite(supportScore)) {
    const label = String(evidence.support?.label || '').trim();
    lines.push(`- 证据支持度：${Math.max(0, Math.min(100, Math.round(supportScore)))}%${label ? `（${label}）` : ''}`);
  }
  if (pages.length) lines.push(`- 核对页：${pages.map((page) => `第 ${page} 页`).join('、')}`);
  if (items.length) {
    lines.push('');
    items.forEach((item, index) => {
      const heading = item.heading ? ` · ${item.heading}` : '';
      const neighbor = Number.isFinite(item.neighborOf) && item.neighborOf >= 1
        ? ` · 第 ${item.neighborOf} 页的邻页上下文`
        : '';
      lines.push(`- E${index + 1} · 第 ${item.page} 页 · ${item.sourceType}${heading}${neighbor}`);
      lines.push(`  > ${item.snippet.replace(/^>+/gu, '').trim()}`);
    });
  }
  lines.push('', '> 支持度只表示回答可追溯到已查阅片段，不代表结论必然正确。');
  return lines;
}

/** 导出文件名（不含路径）。 */
export function conversationExportFilename({ docTitle = '', now = new Date() } = {}) {
  const stamp = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
    : 'export';
  const base = String(docTitle || 'paper')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || 'paper';
  return `paperlens-chat-${base}-${stamp}.md`;
}
