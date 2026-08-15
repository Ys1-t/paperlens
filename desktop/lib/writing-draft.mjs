// 写作草稿：Related Work / 组会稿等本地草稿，纯函数。

export const DRAFTS_MAX = 40;

export function emptyDrafts() {
  return [];
}

export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名草稿';
  const body = String(raw.body || '').slice(0, 100000);
  if (!body.trim() && !raw.id) return null;
  return {
    id: String(raw.id || '').trim() || `d${Math.abs(hash(`${title}|${Date.now()}`)).toString(36)}`,
    title,
    body,
    kind: ['related-work', 'rebuttal', 'meeting', 'general', 'polish'].includes(raw.kind)
      ? raw.kind
      : 'general',
    paperPath: String(raw.paperPath || '').trim().slice(0, 500),
    paperTitle: String(raw.paperTitle || '').trim().slice(0, 160),
    updatedAt: Number(raw.updatedAt) || 0,
    createdAt: Number(raw.createdAt) || 0,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function normalizeDrafts(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const d = normalizeDraft(raw);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, DRAFTS_MAX);
}

export function upsertDraft(list, draft, now = Date.now()) {
  const items = normalizeDrafts(list);
  const next = normalizeDraft({ ...draft, updatedAt: now, createdAt: draft?.createdAt || now });
  if (!next) return { drafts: items, draft: null };
  const idx = items.findIndex((d) => d.id === next.id);
  if (idx >= 0) {
    next.createdAt = items[idx].createdAt || now;
    items[idx] = next;
  } else {
    items.unshift(next);
  }
  return { drafts: items.slice(0, DRAFTS_MAX), draft: next };
}

export function removeDraft(list, id) {
  return normalizeDrafts(list).filter((d) => d.id !== String(id || ''));
}

export function getDraft(list, id) {
  return normalizeDrafts(list).find((d) => d.id === String(id || '')) || null;
}

/** 简易 diff 行：返回 { type: 'same'|'add'|'del', text }[]（按行 LCS 近似：集合差）。 */
export function lineDiff(before, after) {
  const a = String(before || '').split(/\r?\n/);
  const b = String(after || '').split(/\r?\n/);
  // Myers 对长文过重；用行集合对齐：公共子序列贪心
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1; j += 1;
      continue;
    }
    // 在 b 中找 a[i]
    let foundInB = -1;
    if (i < a.length) {
      for (let k = j; k < Math.min(b.length, j + 8); k += 1) {
        if (b[k] === a[i]) { foundInB = k; break; }
      }
    }
    let foundInA = -1;
    if (j < b.length) {
      for (let k = i; k < Math.min(a.length, i + 8); k += 1) {
        if (a[k] === b[j]) { foundInA = k; break; }
      }
    }
    if (foundInB >= 0 && (foundInA < 0 || foundInB - j <= foundInA - i)) {
      while (j < foundInB) { out.push({ type: 'add', text: b[j] }); j += 1; }
      continue;
    }
    if (foundInA >= 0) {
      while (i < foundInA) { out.push({ type: 'del', text: a[i] }); i += 1; }
      continue;
    }
    if (i < a.length) { out.push({ type: 'del', text: a[i] }); i += 1; }
    else if (j < b.length) { out.push({ type: 'add', text: b[j] }); j += 1; }
  }
  return out;
}

export function draftPromptForKind(kind, { paperTitle = '', body = '' } = {}) {
  const paper = paperTitle ? `当前论文：《${paperTitle}》` : '（未绑定论文时可作通用草稿）';
  if (kind === 'related-work') {
    return [
      '请基于已打开论文与必要时联网检索，写一段 Related Work 中文草稿（可含 \\cite{} 占位）。',
      paper,
      '写完后我会放进写作视图；请分小节，结论标页码。',
      body ? `现有草稿供参考改写：\n${body.slice(0, 3000)}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'polish') {
    return [
      '请润色以下学术中文草稿：更紧凑、术语一致、保留原意与引用标记。',
      '输出完整润色后正文，不要解释过程。',
      '',
      body.slice(0, 8000) || '（空）',
    ].join('\n');
  }
  if (kind === 'meeting') {
    return `请生成组会讲稿大纲。${paper}`;
  }
  if (kind === 'rebuttal') {
    return `请基于当前论文帮我起草审稿意见的 rebuttal 要点。${paper}`;
  }
  return body ? `请继续完善这篇草稿：\n${body.slice(0, 4000)}` : '请帮我开始写一段研究相关草稿。';
}
