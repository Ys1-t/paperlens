// Agent 对话会话持久化（纯函数）：会话列表规范化、更新、标题生成、容量控制。
// 存储文件由主进程管理（sessions.json）；这里不做 IO。

export const SESSIONS_VERSION = 1;
export const SESSIONS_MAX = 30;
export const SESSION_MESSAGES_MAX = 40;

export function emptySessions() {
  return { version: SESSIONS_VERSION, sessions: [] };
}

/** 从首个用户提问生成会话标题（去技能后缀，限长）。 */
export function sessionTitleFromQuestion(question) {
  const q = String(question || '')
    .replace(/\n[\s\S]*$/, '')
    .replace(/（请严格执行已激活技能.*?）/g, '')
    .trim();
  if (!q) return '未命名会话';
  return q.length > 40 ? `${q.slice(0, 38)}…` : q;
}

function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : '';
  if (!role) return null;
  // 多模态 content 数组存纯文本部分（图片 dataURL 太大，不进会话文件）
  let content = msg.content;
  if (Array.isArray(content)) {
    content = content.filter((c) => c?.type === 'text').map((c) => String(c.text || '')).join('\n');
  }
  content = String(content ?? '').slice(0, 20000);
  if (!content) return null;
  return { role, content };
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').slice(0, 64);
  if (!id) return null;
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map(normalizeMessage).filter(Boolean).slice(-SESSION_MESSAGES_MAX);
  return {
    id,
    title: String(raw.title || '未命名会话').slice(0, 80),
    paperTitle: String(raw.paperTitle || '').slice(0, 200),
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    messages,
  };
}

export function normalizeSessions(raw) {
  const out = emptySessions();
  if (!raw || typeof raw !== 'object') return out;
  const list = Array.isArray(raw.sessions) ? raw.sessions : [];
  out.sessions = list.map(normalizeSession).filter(Boolean).slice(0, SESSIONS_MAX * 2);
  // 按更新时间倒序 + 容量
  out.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  out.sessions = out.sessions.slice(0, SESSIONS_MAX);
  return out;
}

/**
 * 更新（或创建）一个会话：写入完整 messages 快照。
 * 空 messages 的会话不保存（无意义）。返回新的 sessions 容器。
 */
export function upsertSession(container, { id, title, paperTitle, messages } = {}, now = Date.now()) {
  const next = normalizeSessions(container);
  const sid = String(id || '').slice(0, 64);
  if (!sid) return next;
  const normMessages = (Array.isArray(messages) ? messages : [])
    .map(normalizeMessage).filter(Boolean).slice(-SESSION_MESSAGES_MAX);
  if (!normMessages.length) return next;
  const existing = next.sessions.find((s) => s.id === sid);
  if (existing) {
    existing.messages = normMessages;
    existing.updatedAt = now;
    if (title) existing.title = String(title).slice(0, 80);
    if (paperTitle) existing.paperTitle = String(paperTitle).slice(0, 200);
  } else {
    next.sessions.unshift({
      id: sid,
      title: String(title || sessionTitleFromQuestion(normMessages[0]?.content)).slice(0, 80),
      paperTitle: String(paperTitle || '').slice(0, 200),
      createdAt: now,
      updatedAt: now,
      messages: normMessages,
    });
  }
  next.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  next.sessions = next.sessions.slice(0, SESSIONS_MAX);
  return next;
}

export function removeSession(container, id) {
  const next = normalizeSessions(container);
  next.sessions = next.sessions.filter((s) => s.id !== String(id || ''));
  return next;
}

export function getSession(container, id) {
  return normalizeSessions(container).sessions.find((s) => s.id === String(id || '')) || null;
}

/** 会话列表展示模型（不带 messages，轻量）。 */
export function listSessionSummaries(container) {
  return normalizeSessions(container).sessions.map(({ id, title, paperTitle, updatedAt, messages }) => ({
    id, title, paperTitle, updatedAt, turns: messages.filter((m) => m.role === 'user').length,
  }));
}
