// 持久高亮标注：按论文 path 分桶，纯文本锚点（重开后在 textLayer 里再定位）。
// 不存像素坐标——缩放/懒渲染后仍可靠。

export const HIGHLIGHTS_MAX_PER_PAPER = 200;
export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink']);

export function emptyHighlights() {
  return {}; // { [paperPath]: Highlight[] }
}

export function normalizeHighlight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (text.length < 2) return null;
  const page = Math.max(1, Math.round(Number(raw.page) || 1));
  const color = HIGHLIGHT_COLORS.includes(raw.color) ? raw.color : 'yellow';
  const id = String(raw.id || '').trim()
    || `h${Math.abs(hash(`${page}|${text}`)).toString(36)}`;
  return {
    id,
    page,
    text,
    color,
    note: String(raw.note || '').trim().slice(0, 300),
    createdAt: Number(raw.createdAt) || 0,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function normalizeHighlightsMap(raw) {
  const out = emptyHighlights();
  if (!raw || typeof raw !== 'object') return out;
  for (const [path, list] of Object.entries(raw)) {
    const key = String(path || '').trim();
    if (!key) continue;
    const items = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const h = normalizeHighlight(item);
      if (!h || seen.has(h.id)) continue;
      seen.add(h.id);
      items.push(h);
    }
    if (items.length) out[key] = items.slice(0, HIGHLIGHTS_MAX_PER_PAPER);
  }
  return out;
}

export function listHighlights(map, paperPath) {
  const all = normalizeHighlightsMap(map);
  const key = String(paperPath || '').trim();
  return key ? (all[key] || []) : [];
}

export function listHighlightsForPage(map, paperPath, page) {
  const p = Math.round(Number(page) || 0);
  return listHighlights(map, paperPath).filter((h) => h.page === p);
}

/** 添加高亮；同页同文案去重。 */
export function addHighlight(map, paperPath, highlight, now = Date.now()) {
  const all = normalizeHighlightsMap(map);
  const key = String(paperPath || '').trim();
  if (!key) return { map: all, added: false, highlight: null };
  const item = normalizeHighlight({ ...highlight, createdAt: now });
  if (!item) return { map: all, added: false, highlight: null };
  const list = all[key] || [];
  const dup = list.find((h) => h.page === item.page && h.text === item.text);
  if (dup) return { map: all, added: false, highlight: dup };
  all[key] = [item, ...list].slice(0, HIGHLIGHTS_MAX_PER_PAPER);
  return { map: all, added: true, highlight: item };
}

export function removeHighlight(map, paperPath, id) {
  const all = normalizeHighlightsMap(map);
  const key = String(paperPath || '').trim();
  if (!key || !all[key]) return all;
  all[key] = all[key].filter((h) => h.id !== String(id || ''));
  if (!all[key].length) delete all[key];
  return all;
}

export function clearPaperHighlights(map, paperPath) {
  const all = normalizeHighlightsMap(map);
  delete all[String(paperPath || '').trim()];
  return all;
}

/**
 * 在 textLayer spans 的拼接文本中找高亮片段的起止 span 下标。
 * spans: string[]（每 span 的 textContent）
 * 返回 { start, end } 或 null。
 */
export function findHighlightSpanRange(spans, needle) {
  const list = Array.isArray(spans) ? spans.map((s) => String(s || '')) : [];
  const target = String(needle || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!list.length || target.length < 2) return null;
  // 累积拼接，记录每个字符对应的 span 下标
  let joined = '';
  const charToSpan = [];
  for (let i = 0; i < list.length; i += 1) {
    const part = list[i].replace(/\s+/g, ' ');
    for (let c = 0; c < part.length; c += 1) {
      joined += part[c].toLowerCase();
      charToSpan.push(i);
    }
  }
  const at = joined.indexOf(target);
  if (at < 0) {
    // 宽松：去空格再找
    const compactJoined = joined.replace(/\s+/g, '');
    const compactTarget = target.replace(/\s+/g, '');
    const cat = compactJoined.indexOf(compactTarget);
    if (cat < 0) return null;
    // 映射回带空格坐标较难，退化为整页弱提示——返回含 needle 词的首个 span
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].toLowerCase().includes(target.slice(0, Math.min(12, target.length)))) {
        return { start: i, end: i, weak: true };
      }
    }
    return null;
  }
  const start = charToSpan[at];
  const end = charToSpan[Math.min(charToSpan.length - 1, at + target.length - 1)];
  return { start, end, weak: false };
}
