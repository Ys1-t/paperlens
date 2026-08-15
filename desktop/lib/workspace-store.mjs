// 工作空间数据层（纯函数，Node 可测）：最近阅读、阅读进度、科研笔记、
// 文库标签、兴趣、投稿 DDL、待读清单、研究档案、统计、UI 偏好。
// 持久化由 main.cjs 负责（userData/workspace.json）；这里只管结构与规则。

export const WORKSPACE_VERSION = 3;
export const RECENT_MAX = 200; // v3 起 recent 兼作文库，容量放大
export const NOTES_MAX = 500;
export const TODOS_MAX = 100;
export const MEMORY_MAX = 80;
export const VENUES_MAX = 40;
export const READING_LIST_MAX = 200;
export const TAGS_MAX_PER_PAPER = 8;

export function emptyWorkspace() {
  return {
    version: WORKSPACE_VERSION,
    recent: [],
    notes: [],
    obsidian: null,
    glossary: [],
    // 课题记忆：跨会话待办 + 短事实（按论文 path 分桶，空 path = 全局）
    todos: [],
    memory: [],
    // 副驾驶：写操作默认需确认；自动驾驶可关
    agentMode: 'copilot', // 'copilot' | 'autopilot'
    overleaf: null, // { projectUrl, enabled }
    // v3：科研工作台
    interests: { categories: [], keywords: [] }, // arXiv 前沿雷达兴趣
    venues: [], // 投稿目标 { id, abbr, name, deadline, url, note }
    readingList: [], // 待读清单 { id, title, url, arxivId, summary, done, addedAt }
    profile: { field: '', direction: '', goal: '' }, // 研究方向档案（注入 Agent）
    stats: null, // 阅读/翻译/token 统计（reading-stats.mjs 规则）
    ui: defaultUiPrefs(),
    // P2：持久高亮（按 paper path）、写作草稿
    highlights: {},
    drafts: [],
  };
}

export function defaultUiPrefs() {
  return {
    theme: 'light', // 'light' | 'dark'
    scrollLink: true, // 双栏滚动联动
    autoTranslate: false, // 滚到即译
    bilingual: false, // 每页原文对照
    chatWidth: 0, // Agent 面板宽度 px（0 = 默认 clamp）
  };
}

export function normalizeUiPrefs(raw) {
  const ui = defaultUiPrefs();
  if (!raw || typeof raw !== 'object') return ui;
  if (raw.theme === 'dark') ui.theme = 'dark';
  if (raw.scrollLink === false) ui.scrollLink = false;
  if (raw.autoTranslate === true) ui.autoTranslate = true;
  if (raw.bilingual === true) ui.bilingual = true;
  const cw = Math.round(Number(raw.chatWidth) || 0);
  if (cw >= 300 && cw <= 1200) ui.chatWidth = cw;
  return ui;
}

export function setUiPrefs(workspace, patch = {}) {
  const ws = normalizeWorkspace(workspace);
  ws.ui = normalizeUiPrefs({ ...ws.ui, ...patch });
  return ws;
}

/** Gen19: 从文库/最近移除条目（不动磁盘文件）。 */
export function removeRecentEntry(workspace, path) {
  const ws = normalizeWorkspace(workspace);
  const p = String(path || '');
  ws.recent = ws.recent.filter((e) => e.path !== p);
  return ws;
}

/** 载入并规范化（坏数据自动丢弃，永不抛错）。 */
export function normalizeWorkspace(raw) {
  const ws = emptyWorkspace();
  if (!raw || typeof raw !== 'object') return ws;
  for (const item of Array.isArray(raw.recent) ? raw.recent : []) {
    const entry = normalizeRecentEntry(item);
    if (entry) ws.recent.push(entry);
  }
  for (const item of Array.isArray(raw.notes) ? raw.notes : []) {
    const note = normalizeNote(item);
    if (note) ws.notes.push(note);
  }
  ws.recent = ws.recent.slice(0, RECENT_MAX);
  ws.notes = ws.notes.slice(0, NOTES_MAX);
  ws.obsidian = normalizeObsidian(raw.obsidian);
  ws.glossary = normalizeGlossaryList(raw.glossary);
  ws.todos = normalizeTodoList(raw.todos);
  ws.memory = normalizeMemoryList(raw.memory);
  ws.agentMode = raw.agentMode === 'autopilot' ? 'autopilot' : 'copilot';
  ws.overleaf = normalizeOverleaf(raw.overleaf);
  ws.interests = normalizeInterests(raw.interests);
  ws.venues = normalizeVenueList(raw.venues);
  ws.readingList = normalizeReadingList(raw.readingList);
  ws.profile = normalizeProfile(raw.profile);
  ws.stats = (raw.stats && typeof raw.stats === 'object') ? raw.stats : null;
  ws.ui = normalizeUiPrefs(raw.ui);
  // 延迟 import 避免循环；结构在此内联规范化
  ws.highlights = normalizeHighlightsField(raw.highlights);
  ws.drafts = normalizeDraftsField(raw.drafts);
  return ws;
}

function normalizeHighlightsField(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [path, list] of Object.entries(raw)) {
    const key = String(path || '').trim();
    if (!key || !Array.isArray(list)) continue;
    const items = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (text.length < 2) continue;
      items.push({
        id: String(item.id || '').slice(0, 64),
        page: Math.max(1, Math.round(Number(item.page) || 1)),
        text,
        color: ['yellow', 'green', 'blue', 'pink'].includes(item.color) ? item.color : 'yellow',
        note: String(item.note || '').slice(0, 300),
        createdAt: Number(item.createdAt) || 0,
      });
    }
    if (items.length) out[key] = items.slice(0, 200);
  }
  return out;
}

function normalizeDraftsField(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const body = String(item.body || '').slice(0, 100000);
    const title = String(item.title || '').trim().slice(0, 120) || '未命名草稿';
    if (!body.trim() && !item.id) continue;
    out.push({
      id: String(item.id || '').slice(0, 64),
      title,
      body,
      kind: String(item.kind || 'general').slice(0, 32),
      paperPath: String(item.paperPath || '').slice(0, 500),
      paperTitle: String(item.paperTitle || '').slice(0, 160),
      updatedAt: Number(item.updatedAt) || 0,
      createdAt: Number(item.createdAt) || 0,
    });
  }
  return out.slice(0, 40);
}

export function setHighlightsMap(workspace, highlightsMap) {
  const ws = normalizeWorkspace(workspace);
  ws.highlights = normalizeHighlightsField(highlightsMap);
  return ws;
}

export function setDraftsList(workspace, drafts) {
  const ws = normalizeWorkspace(workspace);
  ws.drafts = normalizeDraftsField(drafts);
  return ws;
}

// ---------------------------------------------------------------------------
// 兴趣（前沿雷达）
// ---------------------------------------------------------------------------
export function normalizeInterests(raw) {
  const out = { categories: [], keywords: [] };
  if (!raw || typeof raw !== 'object') return out;
  const seenCat = new Set();
  for (const cat of Array.isArray(raw.categories) ? raw.categories : []) {
    const c = String(cat || '').trim().slice(0, 20);
    if (!/^[a-z-]+(\.[A-Za-z-]+)?$/.test(c) || seenCat.has(c)) continue;
    seenCat.add(c);
    out.categories.push(c);
  }
  const seenKw = new Set();
  for (const kw of Array.isArray(raw.keywords) ? raw.keywords : []) {
    const k = String(kw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!k || seenKw.has(k.toLowerCase())) continue;
    seenKw.add(k.toLowerCase());
    out.keywords.push(k);
  }
  out.categories = out.categories.slice(0, 8);
  out.keywords = out.keywords.slice(0, 12);
  return out;
}

export function setInterests(workspace, { categories, keywords } = {}) {
  const ws = normalizeWorkspace(workspace);
  ws.interests = normalizeInterests({
    categories: categories != null ? categories : ws.interests.categories,
    keywords: keywords != null ? keywords : ws.interests.keywords,
  });
  return ws;
}

// ---------------------------------------------------------------------------
// 投稿目标（DDL）
// ---------------------------------------------------------------------------
export function normalizeVenueEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const abbr = String(item.abbr || item.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!abbr) return null;
  const deadline = String(item.deadline || '').trim();
  return {
    id: String(item.id || '').trim() || `v${Math.abs(hashString(`${abbr}|${deadline}`)).toString(36)}`,
    abbr,
    name: String(item.name || '').replace(/\s+/g, ' ').trim().slice(0, 120) || abbr,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : '',
    url: String(item.url || '').trim().slice(0, 300),
    note: String(item.note || '').replace(/\s+/g, ' ').trim().slice(0, 200),
  };
}

export function normalizeVenueList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const venue = normalizeVenueEntry(raw);
    if (!venue || seen.has(venue.id)) continue;
    seen.add(venue.id);
    out.push(venue);
  }
  return out.slice(0, VENUES_MAX);
}

export function addVenue(workspace, entry) {
  const ws = normalizeWorkspace(workspace);
  const venue = normalizeVenueEntry(entry);
  if (!venue) return { workspace: ws, added: false, venue: null };
  ws.venues = normalizeVenueList([venue, ...ws.venues.filter((v) => v.id !== venue.id)]);
  return { workspace: ws, added: true, venue };
}

export function removeVenue(workspace, id) {
  const ws = normalizeWorkspace(workspace);
  ws.venues = ws.venues.filter((v) => v.id !== String(id || ''));
  return ws;
}

// ---------------------------------------------------------------------------
// 待读清单（前沿雷达 → 稍后读）
// ---------------------------------------------------------------------------
export function normalizeReadingItem(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!title) return null;
  const arxivId = String(item.arxivId || '').trim().slice(0, 40);
  const url = String(item.url || '').trim().slice(0, 400);
  return {
    id: String(item.id || '').trim() || `r${Math.abs(hashString(arxivId || url || title)).toString(36)}`,
    title,
    url,
    arxivId,
    summary: String(item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    done: Boolean(item.done),
    addedAt: Number(item.addedAt) || 0,
  };
}

export function normalizeReadingList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeReadingItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.slice(0, READING_LIST_MAX);
}

export function addReadingItem(workspace, entry, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const item = normalizeReadingItem({ ...entry, addedAt: now });
  if (!item) return { workspace: ws, added: false, item: null };
  if (ws.readingList.some((r) => r.id === item.id)) {
    return { workspace: ws, added: false, item: ws.readingList.find((r) => r.id === item.id) };
  }
  ws.readingList = [item, ...ws.readingList].slice(0, READING_LIST_MAX);
  return { workspace: ws, added: true, item };
}

export function setReadingItemDone(workspace, id, done = true) {
  const ws = normalizeWorkspace(workspace);
  ws.readingList = ws.readingList.map((r) => (r.id === String(id || '') ? { ...r, done: Boolean(done) } : r));
  return ws;
}

export function removeReadingItem(workspace, id) {
  const ws = normalizeWorkspace(workspace);
  ws.readingList = ws.readingList.filter((r) => r.id !== String(id || ''));
  return ws;
}

// ---------------------------------------------------------------------------
// 研究方向档案（注入 Agent system prompt）
// ---------------------------------------------------------------------------
export function normalizeProfile(raw) {
  const out = { field: '', direction: '', goal: '' };
  if (!raw || typeof raw !== 'object') return out;
  out.field = String(raw.field || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  out.direction = String(raw.direction || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  out.goal = String(raw.goal || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return out;
}

export function setProfile(workspace, patch = {}) {
  const ws = normalizeWorkspace(workspace);
  ws.profile = normalizeProfile({ ...ws.profile, ...patch });
  return ws;
}

/** 研究档案注入块：让 Agent 知道用户是谁、在做什么方向。 */
export function formatProfileBlock(workspace) {
  const ws = normalizeWorkspace(workspace);
  const { field, direction, goal } = ws.profile;
  if (!field && !direction && !goal) return '';
  const lines = ['【用户研究档案】'];
  if (field) lines.push(`领域：${field}`);
  if (direction) lines.push(`方向：${direction}`);
  if (goal) lines.push(`当前目标：${goal}`);
  lines.push('调研、选会、写作建议尽量贴合该方向。');
  return lines.join('\n');
}

export function normalizeOverleaf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const projectUrl = String(raw.projectUrl || '').trim();
  if (!projectUrl) return null;
  return { projectUrl: projectUrl.slice(0, 500), enabled: raw.enabled !== false };
}

export function setOverleafConfig(workspace, { projectUrl, enabled } = {}) {
  const ws = normalizeWorkspace(workspace);
  if (projectUrl != null) {
    const url = String(projectUrl || '').trim();
    ws.overleaf = url ? { projectUrl: url.slice(0, 500), enabled: enabled !== false } : null;
  } else if (ws.overleaf && enabled != null) {
    ws.overleaf.enabled = Boolean(enabled);
  }
  return ws;
}

export function setAgentMode(workspace, mode) {
  const ws = normalizeWorkspace(workspace);
  ws.agentMode = mode === 'autopilot' ? 'autopilot' : 'copilot';
  return ws;
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

export function normalizeTodo(item) {
  if (!item || typeof item !== 'object') return null;
  const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return null;
  return {
    id: String(item.id || '').trim() || `t${Math.abs(hashString(`${text}|${item.createdAt || 0}`)).toString(36)}`,
    text,
    done: Boolean(item.done),
    paperPath: String(item.paperPath || '').trim().slice(0, 500),
    paperTitle: String(item.paperTitle || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    createdAt: Number(item.createdAt) || 0,
    doneAt: Number(item.doneAt) || 0,
  };
}

export function normalizeTodoList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const todo = normalizeTodo(raw);
    if (!todo || seen.has(todo.id)) continue;
    seen.add(todo.id);
    out.push(todo);
  }
  return out.slice(0, TODOS_MAX);
}

export function addTodo(workspace, { text, paperPath, paperTitle } = {}, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const todo = normalizeTodo({ text, paperPath, paperTitle, createdAt: now, done: false });
  if (!todo) return { workspace: ws, added: false, todo: null };
  const dup = ws.todos.some((t) => !t.done && t.text === todo.text && t.paperPath === todo.paperPath);
  if (dup) return { workspace: ws, added: false, todo: ws.todos.find((t) => t.text === todo.text) };
  ws.todos = [todo, ...ws.todos].slice(0, TODOS_MAX);
  return { workspace: ws, added: true, todo };
}

export function setTodoDone(workspace, id, done = true, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const key = String(id || '');
  ws.todos = ws.todos.map((t) => (
    t.id === key ? { ...t, done: Boolean(done), doneAt: done ? now : 0 } : t
  ));
  return ws;
}

export function removeTodo(workspace, id) {
  const ws = normalizeWorkspace(workspace);
  ws.todos = ws.todos.filter((t) => t.id !== String(id || ''));
  return ws;
}

export function listTodos(workspace, { paperPath, includeDone = true } = {}) {
  const ws = normalizeWorkspace(workspace);
  let items = ws.todos;
  if (paperPath != null && paperPath !== '') {
    const p = String(paperPath);
    items = items.filter((t) => t.paperPath === p || t.paperPath === '');
  }
  if (!includeDone) items = items.filter((t) => !t.done);
  return items;
}

export function normalizeMemoryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const fact = String(item.fact || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!fact) return null;
  return {
    id: String(item.id || '').trim() || `m${Math.abs(hashString(fact)).toString(36)}`,
    fact,
    paperPath: String(item.paperPath || '').trim().slice(0, 500),
    paperTitle: String(item.paperTitle || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    createdAt: Number(item.createdAt) || 0,
  };
}

export function normalizeMemoryList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeMemoryItem(raw);
    if (!item || seen.has(item.fact.toLowerCase())) continue;
    seen.add(item.fact.toLowerCase());
    out.push(item);
  }
  return out.slice(0, MEMORY_MAX);
}

export function rememberFact(workspace, { fact, paperPath, paperTitle } = {}, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const item = normalizeMemoryItem({ fact, paperPath, paperTitle, createdAt: now });
  if (!item) return { workspace: ws, added: false, item: null };
  ws.memory = normalizeMemoryList([item, ...ws.memory]);
  return { workspace: ws, added: true, item };
}

export function listMemory(workspace, { paperPath } = {}) {
  const ws = normalizeWorkspace(workspace);
  if (paperPath == null || paperPath === '') return ws.memory;
  const p = String(paperPath);
  return ws.memory.filter((m) => m.paperPath === p || m.paperPath === '');
}

/** 注入 system 的课题记忆摘要（短）。 */
export function formatProjectMemoryBlock(workspace, { paperPath, paperTitle } = {}) {
  const todos = listTodos(workspace, { paperPath, includeDone: false }).slice(0, 8);
  const mem = listMemory(workspace, { paperPath }).slice(0, 8);
  if (!todos.length && !mem.length) return '';
  const lines = ['【课题记忆 · 跨会话】'];
  if (paperTitle) lines.push(`关联论文：${paperTitle}`);
  if (todos.length) {
    lines.push('未完成待办：');
    for (const t of todos) lines.push(`- [${t.id}] ${t.text}`);
  }
  if (mem.length) {
    lines.push('已记要点：');
    for (const m of mem) lines.push(`- ${m.fact}`);
  }
  return lines.join('\n');
}

export const GLOSSARY_MAX = 200;

/** 术语表：{term, translation}[]，term 小写去重（后写覆盖），容量截断。 */
export function normalizeGlossaryList(list) {
  const byKey = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const term = String(raw?.term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const translation = String(raw?.translation || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!term || !translation) continue;
    byKey.set(term.toLowerCase(), { term, translation });
  }
  return [...byKey.values()].slice(-GLOSSARY_MAX);
}

/** 锁定/更新一条术语。 */
export function upsertGlossaryTerm(workspace, { term, translation } = {}) {
  const ws = normalizeWorkspace(workspace);
  ws.glossary = normalizeGlossaryList([...ws.glossary, { term, translation }]);
  return ws;
}

/** 按 term（大小写不敏感）删除术语。 */
export function removeGlossaryTerm(workspace, term) {
  const ws = normalizeWorkspace(workspace);
  const key = String(term || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!key) return ws;
  ws.glossary = ws.glossary.filter((g) => g.term.toLowerCase() !== key);
  return ws;
}

/** Obsidian 同步配置：{ folder, enabled }。folder 是绝对路径。 */
export function normalizeObsidian(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const folder = String(raw.folder || '').trim();
  if (!folder) return null;
  return { folder, enabled: raw.enabled !== false };
}

/** 把一条笔记格式化成 vault 里的 .md 文件内容（含 frontmatter + 双链建议）。 */
export function noteToVaultMarkdown(note) {
  const normalized = normalizeNote(note);
  if (!normalized) return '';
  const when = normalized.createdAt
    ? new Date(normalized.createdAt).toISOString().slice(0, 19).replace('T', ' ')
    : '';
  const paper = normalized.paperTitle || '';
  const lines = [
    '---',
    `source: ${normalized.source === 'manual' ? 'manual' : 'ai'}`,
    ...(paper ? [`paper: "${paper.replace(/"/g, '\\"')}"`] : []),
    ...(when ? [`saved: ${when}`] : []),
    '---',
    '',
    `# ${normalized.title}`,
    '',
    normalized.content,
  ];
  if (paper) {
    lines.push('', `> 收录自《${paper}》的阅读。`, `[[${paper.replace(/\.pdf$/i, '')}]]`);
  }
  return lines.join('\n');
}

/** vault 文件名：<标题>.md，非法字符替换（Windows/macOS/Linux 通用）。 */
export function noteToVaultFilename(note) {
  const normalized = normalizeNote(note);
  const base = (normalized?.title || 'note')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'note';
  return `${base}.md`;
}

export function normalizeRecentEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const path = String(item.path || '').trim();
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!path || !title) return null;
  const tags = [];
  const seenTags = new Set();
  for (const raw of Array.isArray(item.tags) ? item.tags : []) {
    const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!tag || seenTags.has(tag.toLowerCase())) continue;
    seenTags.add(tag.toLowerCase());
    tags.push(tag);
  }
  return {
    path,
    title,
    totalPages: Math.max(0, Math.round(Number(item.totalPages) || 0)),
    lastPage: Math.max(1, Math.round(Number(item.lastPage) || 1)),
    translatedCount: Math.max(0, Math.round(Number(item.translatedCount) || 0)),
    updatedAt: Number(item.updatedAt) || 0,
    // v3 文库字段
    starred: Boolean(item.starred),
    tags: tags.slice(0, TAGS_MAX_PER_PAPER),
    oneLiner: String(item.oneLiner || '').replace(/\s+/g, ' ').trim().slice(0, 200), // AI 一句话摘要
    // 元数据（启发式提取或用户改）
    arxivId: String(item.arxivId || '').trim().slice(0, 24),
    year: Number(item.year) >= 1990 && Number(item.year) < 2100 ? Math.round(Number(item.year)) : null,
  };
}

/** 星标 / 标签 / 一句话摘要：文库层操作（按 path 定位）。 */
export function updateLibraryEntry(workspace, path, patch = {}) {
  const ws = normalizeWorkspace(workspace);
  const key = String(path || '').trim();
  ws.recent = ws.recent.map((entry) => {
    if (entry.path !== key) return entry;
    const next = { ...entry };
    if (patch.starred != null) next.starred = Boolean(patch.starred);
    if (patch.oneLiner != null) next.oneLiner = String(patch.oneLiner).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (patch.title) next.title = String(patch.title).replace(/\s+/g, ' ').trim().slice(0, 160) || next.title;
    if (patch.arxivId != null) next.arxivId = String(patch.arxivId).trim().slice(0, 24);
    if (patch.year != null) next.year = Number(patch.year) >= 1990 && Number(patch.year) < 2100 ? Math.round(Number(patch.year)) : null;
    if (Array.isArray(patch.tags)) next.tags = normalizeRecentEntry({ ...next, tags: patch.tags })?.tags || [];
    if (patch.addTag) {
      const merged = [...(next.tags || []), String(patch.addTag)];
      next.tags = normalizeRecentEntry({ ...next, tags: merged })?.tags || next.tags;
    }
    if (patch.removeTag) {
      next.tags = (next.tags || []).filter((t) => t.toLowerCase() !== String(patch.removeTag).toLowerCase());
    }
    return next;
  });
  return ws;
}

/** 全文库标签汇总（用于筛选栏）。 */
export function collectLibraryTags(workspace) {
  const ws = normalizeWorkspace(workspace);
  const counts = new Map();
  for (const entry of ws.recent) {
    for (const tag of entry.tags || []) {
      const key = tag.toLowerCase();
      counts.set(key, { tag, count: (counts.get(key)?.count || 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** 文库检索：标题 / 标签 / 一句话摘要 模糊匹配 + star/tag 过滤。 */
export function searchLibrary(workspace, { query = '', tag = '', starredOnly = false } = {}) {
  const ws = normalizeWorkspace(workspace);
  const q = String(query || '').trim().toLowerCase();
  const t = String(tag || '').trim().toLowerCase();
  return ws.recent.filter((entry) => {
    if (starredOnly && !entry.starred) return false;
    if (t && !(entry.tags || []).some((x) => x.toLowerCase() === t)) return false;
    if (!q) return true;
    return entry.title.toLowerCase().includes(q)
      || (entry.oneLiner || '').toLowerCase().includes(q)
      || (entry.tags || []).some((x) => x.toLowerCase().includes(q));
  });
}

/** 记录一次打开/进度更新（按 path 去重，最新在前）。 */
export function upsertRecent(workspace, entry, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const next = normalizeRecentEntry({ ...entry, updatedAt: now });
  if (!next) return ws;
  const prior = ws.recent.find((it) => it.path === next.path);
  if (prior) {
    // 保留旧值里更完整的字段（例如只更新页码时不丢 translatedCount / 文库字段）。
    next.totalPages = next.totalPages || prior.totalPages;
    next.translatedCount = Math.max(next.translatedCount, prior.translatedCount);
    next.starred = next.starred || prior.starred;
    if (!next.tags.length) next.tags = prior.tags;
    if (!next.oneLiner) next.oneLiner = prior.oneLiner;
    if (!next.arxivId) next.arxivId = prior.arxivId;
    if (!next.year) next.year = prior.year;
  }
  ws.recent = [next, ...ws.recent.filter((it) => it.path !== next.path)].slice(0, RECENT_MAX);
  return ws;
}

export function normalizeNote(item) {
  if (!item || typeof item !== 'object') return null;
  const content = String(item.content || '').trim();
  if (!content) return null;
  const paperTitle = String(item.paperTitle || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const createdAt = Number(item.createdAt) || 0;
  return {
    // id 含论文名与时间：同内容出现在不同论文/不同时刻不共享 id（删除互不误伤）。
    id: String(item.id || '').trim()
      || `n${Math.abs(hashString(`${paperTitle}|${createdAt}|${content}`)).toString(36)}`,
    title: String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名笔记',
    content: content.slice(0, 20000),
    paperTitle,
    source: item.source === 'manual' ? 'manual' : 'ai',
    createdAt,
  };
}

/** 收藏一条笔记（内容级去重：同论文同内容不重复收）。 */
export function addNote(workspace, note, now = Date.now()) {
  const ws = normalizeWorkspace(workspace);
  const next = normalizeNote({ ...note, createdAt: now });
  if (!next) return { workspace: ws, added: false };
  const duplicate = ws.notes.some((it) => (
    it.paperTitle === next.paperTitle && it.content === next.content
  ));
  if (duplicate) return { workspace: ws, added: false };
  ws.notes = [next, ...ws.notes].slice(0, NOTES_MAX);
  return { workspace: ws, added: true };
}

export function removeNote(workspace, id) {
  const ws = normalizeWorkspace(workspace);
  ws.notes = ws.notes.filter((it) => it.id !== String(id || ''));
  return ws;
}

/** 笔记导出为 Markdown（按论文分组，含来源标注）。 */
export function notesToMarkdown(workspace, { title = 'PaperLens 科研笔记' } = {}) {
  const ws = normalizeWorkspace(workspace);
  const lines = [`# ${title}`, ''];
  if (!ws.notes.length) {
    lines.push('_（暂无笔记）_', '');
    return lines.join('\n');
  }
  const groups = new Map();
  for (const note of ws.notes) {
    const key = note.paperTitle || '（未关联论文）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(note);
  }
  for (const [paper, notes] of groups) {
    lines.push(`## ${paper}`, '');
    for (const note of notes) {
      const when = note.createdAt ? new Date(note.createdAt).toISOString().slice(0, 10) : '';
      lines.push(`### ${note.title}${when ? ` · ${when}` : ''}${note.source === 'ai' ? ' · AI 回答' : ''}`, '');
      lines.push(note.content, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 首页「继续阅读」卡片的展示数据。 */
export function recentCardModel(entry) {
  const normalized = normalizeRecentEntry(entry);
  if (!normalized) return null;
  const name = normalized.title.replace(/\.pdf$/iu, '');
  const progress = normalized.totalPages
    ? Math.min(100, Math.round((normalized.lastPage / normalized.totalPages) * 100))
    : 0;
  return {
    ...normalized,
    displayTitle: name.length > 60 ? `${name.slice(0, 57)}…` : name,
    progressPercent: progress,
    subtitle: normalized.totalPages
      ? `读到第 ${normalized.lastPage} / ${normalized.totalPages} 页${normalized.translatedCount ? ` · 已译 ${normalized.translatedCount} 页` : ''}`
      : '尚未开始',
  };
}
