// 阅读续读 + 最近文库：按文档（docKey = 标题+页数）记录最后阅读页，
// 供阅读器重开时「继续上次阅读」，以及 popup 的「最近阅读」列表。
// 存 localStorage（viewer / popup 同源共享；SW 不需要）。注入 storage 便于测试。

export const READING_HISTORY_KEY = 'paperlens.readingHistory.v1';
export const READING_HISTORY_MAX = 30;

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** 规范化一条阅读记录；无效返回 null。 */
export function normalizeReadingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const docKey = String(entry.docKey || '').trim();
  const page = Math.round(Number(entry.page) || 0);
  if (!docKey || docKey === 'unknown' || page < 1) return null;
  const pageCount = Math.max(0, Math.round(Number(entry.pageCount) || 0));
  return {
    docKey,
    title: String(entry.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    page: pageCount ? Math.min(page, pageCount) : page,
    pageCount,
    sourceUrl: /^https?:\/\//i.test(String(entry.sourceUrl || '')) ? String(entry.sourceUrl) : '',
    updatedAt: Number(entry.updatedAt) || Date.now(),
  };
}

export function loadReadingHistory(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(READING_HISTORY_KEY) || '[]');
    return (Array.isArray(parsed) ? parsed : [])
      .map(normalizeReadingEntry)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function persist(list, storage) {
  const sorted = [...list].sort((a, b) => a.updatedAt - b.updatedAt).slice(-READING_HISTORY_MAX);
  try { storage?.setItem?.(READING_HISTORY_KEY, JSON.stringify(sorted)); } catch { /* quota */ }
  return sorted;
}

/** 记录/更新一条阅读进度（按 docKey 覆盖），返回持久化后的列表。 */
export function recordReadingProgress(entry, storage = defaultStorage()) {
  const item = normalizeReadingEntry({ ...entry, updatedAt: entry?.updatedAt || Date.now() });
  if (!item) return loadReadingHistory(storage);
  const rest = loadReadingHistory(storage).filter((it) => it.docKey !== item.docKey);
  rest.push(item);
  return persist(rest, storage);
}

export function getReadingProgress(docKey, storage = defaultStorage()) {
  const key = String(docKey || '').trim();
  if (!key) return null;
  return loadReadingHistory(storage).find((it) => it.docKey === key) || null;
}

/** 最近阅读列表（最新在前），供 popup 渲染。 */
export function listRecentReadings({ limit = 8 } = {}, storage = defaultStorage()) {
  return loadReadingHistory(storage)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, limit));
}

/**
 * 是否值得提示「继续上次阅读」：有记录、读到第 2 页以后，
 * 且页码没超过当前文档页数（防止同名不同文档）。
 */
export function shouldOfferResume(entry, { pageCount = 0 } = {}) {
  if (!entry || !(entry.page >= 2)) return false;
  if (pageCount && entry.page > pageCount) return false;
  return true;
}

/** popup 列表一行的展示文案。 */
export function readingEntryLabel(entry) {
  if (!entry) return '';
  const title = entry.title || '(未命名文档)';
  const pages = entry.pageCount ? `第 ${entry.page}/${entry.pageCount} 页` : `第 ${entry.page} 页`;
  return `${title} · ${pages}`;
}
