// src/lib/selection-translate.js
// 划词即时翻译的纯逻辑：选区文本规范化、textLayer 上下文收集、
// 请求文本组织（Context/Excerpt 标记）与浮层几何放置。
// DOM 事件绑定、浮层渲染与 Port 请求在 src/viewer/viewer.js。
//
// 请求走「defaultSystemPrompt 普通文本路径 + priority 免排队通道」：
// Port 消息为既有形状 `translate{id,text,priority:true}`，不新增字段。
// 上下文标记是本模块与 translator.defaultSystemPrompt 的单一共享来源，
// 保证 user 文本组织方式与 prompt 规则不会漂移。

export const SELECTION_CONTEXT_MARKER = 'Context (for reference only, do not translate):';
export const SELECTION_EXCERPT_MARKER = 'Translate only this excerpt:';

export const SELECTION_TRANSLATE_MIN_CHARS = 2;
export const SELECTION_TRANSLATE_MAX_CHARS = 1200;
export const SELECTION_CONTEXT_BUDGET = 480; // 选区两侧各自的语境字符预算

/** PDF textLayer 选区文本常携带换行与逐行空白，规范化为单行请求文本。 */
export function normalizeSelectionText(raw) {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim();
}

/** 过短、过长或不含任何字母/数字的选区（纯标点、纯空白）不值得请求。 */
export function isTranslatableSelectionText(text) {
  const value = String(text ?? '');
  if (value.length < SELECTION_TRANSLATE_MIN_CHARS) return false;
  if (value.length > SELECTION_TRANSLATE_MAX_CHARS) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * 从 textLayer 的有序 span 文本收集选区两侧语境（选中文本所在段落的邻近行）。
 * startIndex / endIndex 是选区起止 span 的下标（含）；预算按 span 边界截断，
 * 避免把半个单词切进语境。索引无效时返回空语境（仍可翻译，只是没有上下文）。
 */
export function collectSelectionContext(spanTexts, startIndex, endIndex, {
  beforeBudget = SELECTION_CONTEXT_BUDGET,
  afterBudget = SELECTION_CONTEXT_BUDGET,
} = {}) {
  const texts = Array.isArray(spanTexts)
    ? spanTexts.map((text) => normalizeSelectionText(text))
    : [];
  const start = Number.isInteger(startIndex) ? startIndex : -1;
  const end = Number.isInteger(endIndex) ? endIndex : -1;
  if (start < 0 || end < start || start >= texts.length || end >= texts.length) {
    return { before: '', after: '' };
  }

  const before = [];
  let used = 0;
  for (let i = start - 1; i >= 0; i -= 1) {
    const piece = texts[i];
    if (!piece) continue;
    if (used + piece.length + 1 > beforeBudget) break;
    before.unshift(piece);
    used += piece.length + 1;
  }

  const after = [];
  used = 0;
  for (let i = end + 1; i < texts.length; i += 1) {
    const piece = texts[i];
    if (!piece) continue;
    if (used + piece.length + 1 > afterBudget) break;
    after.push(piece);
    used += piece.length + 1;
  }

  return { before: before.join(' '), after: after.join(' ') };
}

/**
 * 组织划词请求的 user 文本。有语境时使用 defaultSystemPrompt 认识的
 * Context / Excerpt 标记：语境（含选中片段所在位置）只供消歧，
 * 模型只输出 excerpt 的译文；无语境时直接发送所选文本本身。
 */
export function buildSelectionTranslationRequestText({ selection, before = '', after = '' } = {}) {
  const text = normalizeSelectionText(selection);
  if (!text) return '';
  const beforeText = normalizeSelectionText(before);
  const afterText = normalizeSelectionText(after);
  if (!beforeText && !afterText) return text;
  const context = [beforeText, text, afterText].filter(Boolean).join(' ');
  return [
    SELECTION_CONTEXT_MARKER,
    context,
    '',
    SELECTION_EXCERPT_MARKER,
    text,
  ].join('\n');
}

/**
 * 浮层几何：优先放在选区上方（返回 bottom 锚定，流式增高时向上生长，
 * 不遮挡选区）；上方空间不足时放下方（返回 top 锚定）。left 水平居中并
 * 收敛到视口安全边距内。所有值面向 position: fixed。
 */
export function chooseSelectionPopoverPlacement({
  anchor,
  size,
  viewport,
  gap = 10,
  margin = 8,
} = {}) {
  const width = Math.max(0, Number(size?.width) || 0);
  const height = Math.max(0, Number(size?.height) || 0);
  const viewWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewHeight = Math.max(0, Number(viewport?.height) || 0);
  const anchorLeft = Number(anchor?.left) || 0;
  const anchorRight = Number(anchor?.right) || 0;
  const anchorTop = Number(anchor?.top) || 0;
  const anchorBottom = Number(anchor?.bottom) || 0;

  const center = (anchorLeft + anchorRight) / 2;
  const left = Math.round(Math.min(
    Math.max(margin, center - width / 2),
    Math.max(margin, viewWidth - width - margin),
  ));

  if (anchorTop - gap - height >= margin) {
    return { placement: 'above', left, bottom: Math.round(viewHeight - anchorTop + gap) };
  }
  return { placement: 'below', left, top: Math.round(anchorBottom + gap) };
}
