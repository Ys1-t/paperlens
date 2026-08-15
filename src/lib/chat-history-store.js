// src/lib/chat-history-store.js
// AI 助手聊天记录：IndexedDB 持久化会话列表，供面板「记录」抽屉读写。
// 纯逻辑（标题、序列化）可单测；IndexedDB 适配层在浏览器扩展环境运行。
// 页图 base64 过大，落盘时只保留 pageNum / hadImage 标记。

const DB_NAME = 'paperlens-chat';
const STORE = 'sessions';
const VERSION = 1;

export const CHAT_HISTORY_MAX_SESSIONS = 80;
export const CHAT_HISTORY_MAX_MESSAGES = 80;
export const CHAT_HISTORY_TITLE_MAX = 48;
export const CHAT_HISTORY_MAX_TOOL_STEPS = 24;
export const CHAT_HISTORY_MAX_EVIDENCE_PAGES = 24;
export const CHAT_HISTORY_MAX_EVIDENCE_ITEMS = 8;
export const CHAT_HISTORY_MAX_EVIDENCE_SNIPPET_CHARS = 520;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  const open = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('docKey', 'docKey', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('聊天记录库打开超时')), 5000);
  });
  dbPromise = Promise.race([open, timeout]).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** 稳定会话 id（优先 crypto.randomUUID）。 */
export function makeChatSessionId(now = Date.now()) {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* noop */ }
  return `chat_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 从消息列表生成列表标题（首条用户问题摘要）。 */
export function deriveChatSessionTitle(messages, { maxChars = CHAT_HISTORY_TITLE_MAX } = {}) {
  for (const entry of Array.isArray(messages) ? messages : []) {
    if (entry?.role !== 'user') continue;
    const text = String(entry.content || '').replace(/\s+/gu, ' ').trim();
    if (!text) {
      if (entry.hadImage || entry.pageNum != null || entry.images?.length) {
        const page = entry.pageNum != null ? `第 ${entry.pageNum} 页` : '页面';
        return `页图提问 · ${page}`;
      }
      continue;
    }
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(8, maxChars - 1))}…`;
  }
  return '新对话';
}

/** 落盘前去掉 base64 图，避免撑爆存储。 */
export function serializeChatMessagesForStorage(messages, {
  maxMessages = CHAT_HISTORY_MAX_MESSAGES,
} = {}) {
  const list = [];
  for (const entry of Array.isArray(messages) ? messages : []) {
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(entry.content || '').trim();
    const hadImage = Boolean(
      entry.hadImage
      || (Array.isArray(entry.images) && entry.images.length > 0),
    );
    if (!content && !hadImage) continue;
    const row = { role, content };
    if (entry.pageNum != null && Number.isFinite(Number(entry.pageNum))) {
      row.pageNum = Number(entry.pageNum);
    }
    if (hadImage) row.hadImage = true;
    if (entry.skillId) row.skillId = String(entry.skillId).slice(0, 80);
    if (Array.isArray(entry.toolSteps) && entry.toolSteps.length) {
      row.toolSteps = entry.toolSteps.slice(-CHAT_HISTORY_MAX_TOOL_STEPS).map((step) => {
        const clean = {
          name: String(step?.name || 'tool').slice(0, 80),
          label: String(step?.label || step?.name || 'tool').slice(0, 160),
          ok: step?.ok !== false,
        };
        const page = Number(step?.page);
        if (Number.isFinite(page) && page >= 1) clean.page = page;
        return clean;
      });
    }
    const evidence = serializeEvidenceForStorage(entry.evidence || entry.citationAudit);
    if (evidence) row.evidence = evidence;
    list.push(row);
  }
  if (maxMessages > 0 && list.length > maxMessages) {
    return list.slice(list.length - maxMessages);
  }
  return list;
}

function cleanPageList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(Number)
    .filter((page) => Number.isFinite(page) && page >= 1))]
    .slice(0, CHAT_HISTORY_MAX_EVIDENCE_PAGES);
}

function cleanEvidenceItems(value) {
  const rows = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const page = Number(item?.page);
    const snippet = String(item?.snippet || item?.text || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, CHAT_HISTORY_MAX_EVIDENCE_SNIPPET_CHARS);
    if (!Number.isFinite(page) || page < 1 || !snippet) continue;
    const key = `${page}:${snippet.slice(0, 80).toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = Number(item?.score);
    const termCoverage = Number(item?.termCoverage);
    const neighborOf = Number(item?.neighborOf);
    rows.push({
      page,
      sourceType: item?.sourceType === 'source' ? 'source' : 'translation',
      snippet,
      heading: String(item?.heading || '').replace(/\s+/gu, ' ').trim().slice(0, 120),
      score: Number.isFinite(score) ? Number(Math.max(0, score).toFixed(3)) : 0,
      termCoverage: Number.isFinite(termCoverage)
        ? Number(Math.max(0, Math.min(1, termCoverage)).toFixed(3))
        : 0,
      neighborOf: Number.isFinite(neighborOf) && neighborOf >= 1 ? neighborOf : null,
    });
    if (rows.length >= CHAT_HISTORY_MAX_EVIDENCE_ITEMS) break;
  }
  return rows;
}

function cleanEvidenceSupport(value) {
  if (!value || typeof value !== 'object') return null;
  const rawScore = Number(value.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.round(Math.max(0, Math.min(100, rawScore)));
  const level = ['strong', 'moderate', 'weak'].includes(value.level)
    ? value.level
    : score >= 78 ? 'strong' : score >= 48 ? 'moderate' : 'weak';
  const defaultLabel = level === 'strong' ? '证据支持强' : level === 'moderate' ? '证据支持中等' : '证据支持较弱';
  return {
    score,
    level,
    label: String(value.label || defaultLabel).replace(/\s+/gu, ' ').trim().slice(0, 80),
    reasons: (Array.isArray(value.reasons) ? value.reasons : [])
      .map((reason) => String(reason || '').replace(/\s+/gu, ' ').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 5),
    evidenceCount: Math.max(0, Math.min(CHAT_HISTORY_MAX_EVIDENCE_ITEMS, Math.round(Number(value.evidenceCount) || 0))),
    uniquePages: Math.max(0, Math.min(CHAT_HISTORY_MAX_EVIDENCE_PAGES, Math.round(Number(value.uniquePages) || 0))),
  };
}

/** Keep research provenance small, typed and safe to render from history. */
export function serializeEvidenceForStorage(value) {
  if (!value || typeof value !== 'object') return null;
  const items = cleanEvidenceItems(value.items);
  const pages = cleanPageList([
    ...(Array.isArray(value.pages || value.evidencePages) ? (value.pages || value.evidencePages) : []),
    ...items.map((item) => item.page),
  ]);
  const citedPages = cleanPageList(value.citedPages);
  const invalidPages = cleanPageList(value.invalidPages);
  const unsupportedPages = cleanPageList(value.unsupportedPages);
  const sourceTypes = [...new Set((Array.isArray(value.sourceTypes) ? value.sourceTypes : [])
    .map((item) => item === 'source' ? 'source' : item === 'translation' ? 'translation' : '')
    .filter(Boolean))];
  const coverageRaw = Number(value.coverage);
  const coverage = Number.isFinite(coverageRaw) ? Math.max(0, Math.min(1, coverageRaw)) : 0;
  const support = cleanEvidenceSupport(value.support);
  if (!pages.length && !citedPages.length && !invalidPages.length && !unsupportedPages.length
      && !sourceTypes.length && !items.length && !support) {
    return null;
  }
  return {
    pages,
    citedPages,
    invalidPages,
    unsupportedPages,
    sourceTypes,
    coverage,
    ok: value.ok === true,
    items,
    support,
  };
}

/** 组装一条可写入 IDB 的会话记录。 */
export function buildChatSessionRecord({
  id,
  docKey = '',
  docTitle = '',
  messages = [],
  createdAt,
  updatedAt,
  now = Date.now(),
} = {}) {
  const sessionId = String(id || makeChatSessionId(now));
  const storedMessages = serializeChatMessagesForStorage(messages);
  const created = Number.isFinite(Number(createdAt)) ? Number(createdAt) : now;
  const updated = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : now;
  return {
    id: sessionId,
    docKey: String(docKey || '').trim() || 'unknown',
    docTitle: String(docTitle || '').trim() || '未命名 PDF',
    title: deriveChatSessionTitle(storedMessages),
    createdAt: created,
    updatedAt: Math.max(created, updated),
    messageCount: storedMessages.length,
    messages: storedMessages,
  };
}

/** 列表项预览（不含完整 messages）。 */
export function toChatSessionListItem(session) {
  if (!session?.id) return null;
  return {
    id: session.id,
    docKey: session.docKey || 'unknown',
    docTitle: session.docTitle || '未命名 PDF',
    title: session.title || '新对话',
    createdAt: Number(session.createdAt) || 0,
    updatedAt: Number(session.updatedAt) || 0,
    messageCount: Number(session.messageCount) || (session.messages?.length || 0),
  };
}

export function formatChatSessionTime(timestamp, now = Date.now()) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 86_400_000 * 7) return `${Math.floor(diff / 86_400_000)} 天前`;
  try {
    return new Date(t).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** 文档维度的稳定 key（标题 + 页数；无 PDF 时用 unknown）。 */
export function buildChatDocKey({ title = '', totalPages = 0 } = {}) {
  const clean = String(title || '').trim().replace(/\s+/gu, ' ').slice(0, 200);
  const pages = Number.isFinite(Number(totalPages)) ? Math.max(0, Number(totalPages)) : 0;
  if (!clean && !pages) return 'unknown';
  return `t:${clean}|p:${pages}`;
}

// ---------------------------------------------------------------------------
// IndexedDB API
// ---------------------------------------------------------------------------

export async function listChatSessions({
  docKey = '',
  limit = CHAT_HISTORY_MAX_SESSIONS,
} = {}) {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
  const key = String(docKey || '').trim();
  let rows = all.map(toChatSessionListItem).filter(Boolean);
  if (key) rows = rows.filter((row) => row.docKey === key);
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (limit > 0 && rows.length > limit) rows = rows.slice(0, limit);
  return rows;
}

export async function getChatSession(id) {
  const sessionId = String(id || '').trim();
  if (!sessionId) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putChatSession(session) {
  const record = buildChatSessionRecord(session);
  if (!record.messages.length) {
    // 空会话不落盘。
    return null;
  }
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await pruneChatSessions({ keep: CHAT_HISTORY_MAX_SESSIONS });
  return record;
}

export async function deleteChatSession(id) {
  const sessionId = String(id || '').trim();
  if (!sessionId) return false;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return true;
}

/** 只保留最近 keep 条，按 updatedAt。 */
export async function pruneChatSessions({ keep = CHAT_HISTORY_MAX_SESSIONS } = {}) {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= keep) return 0;
  all.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const drop = all.slice(keep);
  if (!drop.length) return 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of drop) store.delete(row.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return drop.length;
}
