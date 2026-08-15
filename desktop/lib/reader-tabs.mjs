// 阅读器多标签：单窗多论文会话（按 path 去重）。纯函数，可测。
// 实际 PDF 字节仍走 openByPath；标签只记元数据 + 续读页。

export const READER_TABS_MAX = 8;

export function emptyTabState() {
  return { tabs: [], activeId: null };
}

export function normalizeTab(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = String(raw.path || '').trim();
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!path && !name) return null;
  const id = String(raw.id || '').trim() || tabIdFromPath(path || name);
  return {
    id,
    path,
    name: name || path.split(/[/\\]/).pop() || 'paper.pdf',
    totalPages: Math.max(0, Math.round(Number(raw.totalPages) || 0)),
    lastPage: Math.max(1, Math.round(Number(raw.lastPage) || 1)),
    openedAt: Number(raw.openedAt) || 0,
  };
}

export function tabIdFromPath(path) {
  const s = String(path || 'untitled');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `tab_${Math.abs(h).toString(36)}`;
}

export function normalizeTabState(raw) {
  const out = emptyTabState();
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set();
  for (const item of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normalizeTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.tabs.push(tab);
  }
  out.tabs = out.tabs.slice(0, READER_TABS_MAX);
  const active = String(raw.activeId || '');
  out.activeId = out.tabs.some((t) => t.id === active) ? active : (out.tabs[0]?.id || null);
  return out;
}

/** 打开/聚焦一篇论文：同 path 则激活并更新 lastPage；否则插入到最前。 */
export function openTab(state, entry, now = Date.now()) {
  const next = normalizeTabState(state);
  const tab = normalizeTab({ ...entry, openedAt: now });
  if (!tab) return next;
  // 优先按 path 去重
  const existing = tab.path
    ? next.tabs.find((t) => t.path && t.path === tab.path)
    : next.tabs.find((t) => t.id === tab.id);
  if (existing) {
    existing.lastPage = tab.lastPage || existing.lastPage;
    existing.totalPages = tab.totalPages || existing.totalPages;
    existing.name = tab.name || existing.name;
    existing.openedAt = now;
    next.activeId = existing.id;
    // 移到最前
    next.tabs = [existing, ...next.tabs.filter((t) => t.id !== existing.id)];
    return next;
  }
  next.tabs = [tab, ...next.tabs].slice(0, READER_TABS_MAX);
  next.activeId = tab.id;
  return next;
}

export function setActiveTab(state, id) {
  const next = normalizeTabState(state);
  if (!next.tabs.some((t) => t.id === id)) return next;
  next.activeId = id;
  return next;
}

export function closeTab(state, id) {
  const next = normalizeTabState(state);
  const idx = next.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return next;
  next.tabs = next.tabs.filter((t) => t.id !== id);
  if (next.activeId === id) {
    const neighbor = next.tabs[Math.min(idx, next.tabs.length - 1)];
    next.activeId = neighbor?.id || null;
  }
  return next;
}

export function updateTabProgress(state, { id, path, lastPage, totalPages } = {}) {
  const next = normalizeTabState(state);
  const tab = next.tabs.find((t) => (id && t.id === id) || (path && t.path === path));
  if (!tab) return next;
  if (lastPage) tab.lastPage = Math.max(1, Math.round(Number(lastPage) || 1));
  if (totalPages) tab.totalPages = Math.max(0, Math.round(Number(totalPages) || 0));
  return next;
}

export function activeTab(state) {
  const s = normalizeTabState(state);
  return s.tabs.find((t) => t.id === s.activeId) || null;
}

/** 标签展示：截断文件名 */
export function tabLabel(tab, maxLen = 22) {
  const name = String(tab?.name || 'paper.pdf').replace(/\.pdf$/i, '');
  return name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
}
