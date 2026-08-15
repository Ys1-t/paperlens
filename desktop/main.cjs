// PaperLens Desktop 主进程：窗口 + agent IPC。
// agent 循环跑在主进程（Node 环境，联网无 CORS）；渲染进程只做 UI。
// CommonJS 入口（Electron 主进程 ESM 加载在部分版本有兼容问题）；
// agent 核心库是 ESM，用动态 import 加载。
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');
const { randomUUID } = require('node:crypto');

const configPath = () => join(app.getPath('userData'), 'agent.config.json');
const workspacePath = () => join(app.getPath('userData'), 'workspace.json');
const sessionsPath = () => join(app.getPath('userData'), 'sessions.json');

// ---------------------------------------------------------------------------
// Agent 对话会话持久化（结构规则在 lib/chat-session-store.mjs）
// ---------------------------------------------------------------------------
let sessionStorePromise = null;
function loadSessionStore() {
  sessionStorePromise ||= import('./lib/chat-session-store.mjs');
  return sessionStorePromise;
}
async function readSessions() {
  const store = await loadSessionStore();
  try { return store.normalizeSessions(JSON.parse(readFileSync(sessionsPath(), 'utf8'))); }
  catch { return store.emptySessions(); }
}
function writeSessions(container) {
  if (!existsSync(dirname(sessionsPath()))) mkdirSync(dirname(sessionsPath()), { recursive: true });
  writeFileSync(sessionsPath(), JSON.stringify(container));
}

// ---------------------------------------------------------------------------
// 工作空间（最近阅读 / 笔记）：结构规则在 lib/workspace-store.mjs（纯函数可测）。
// ---------------------------------------------------------------------------
let workspaceStorePromise = null;
function loadWorkspaceStore() {
  workspaceStorePromise ||= import('./lib/workspace-store.mjs');
  return workspaceStorePromise;
}
async function readWorkspace() {
  const store = await loadWorkspaceStore();
  try { return store.normalizeWorkspace(JSON.parse(readFileSync(workspacePath(), 'utf8'))); }
  catch { return store.emptyWorkspace(); }
}
function writeWorkspace(workspace) {
  if (!existsSync(dirname(workspacePath()))) mkdirSync(dirname(workspacePath()), { recursive: true });
  writeFileSync(workspacePath(), JSON.stringify(workspace));
}

ipcMain.handle('workspace:get', async () => readWorkspace());
ipcMain.handle('workspace:set-ui-prefs', async (_event, patch) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setUiPrefs(await readWorkspace(), patch || {});
  writeWorkspace(workspace);
  return { ok: true, ui: workspace.ui };
});
ipcMain.handle('workspace:set-profile', async (_event, patch) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setProfile(await readWorkspace(), patch || {});
  writeWorkspace(workspace);
  return { ok: true, profile: workspace.profile };
});
ipcMain.handle('workspace:set-interests', async (_event, payload) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setInterests(await readWorkspace(), payload || {});
  writeWorkspace(workspace);
  return { ok: true, interests: workspace.interests };
});
ipcMain.handle('workspace:update-library-entry', async (_event, { path, patch } = {}) => {
  const store = await loadWorkspaceStore();
  const workspace = store.updateLibraryEntry(await readWorkspace(), path, patch || {});
  writeWorkspace(workspace);
  return { ok: true, entry: workspace.recent.find((e) => e.path === String(path || '')) || null };
});
ipcMain.handle('workspace:remove-library-entry', async (_event, { path } = {}) => {
  const store = await loadWorkspaceStore();
  const workspace = store.removeRecentEntry(await readWorkspace(), path);
  writeWorkspace(workspace);
  return { ok: true };
});
ipcMain.handle('workspace:library', async (_event, opts) => {
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  return {
    entries: store.searchLibrary(ws, opts || {}),
    tags: store.collectLibraryTags(ws),
  };
});
// 投稿目标
ipcMain.handle('workspace:venues', async () => {
  const [store, submission] = await Promise.all([loadWorkspaceStore(), import('./lib/submission-helper.mjs')]);
  const ws = await readWorkspace();
  return {
    board: submission.venueBoardModel(ws.venues),
    presets: submission.VENUE_PRESETS,
    checklist: submission.SUBMISSION_CHECKLIST,
  };
});
ipcMain.handle('workspace:add-venue', async (_event, entry) => {
  const store = await loadWorkspaceStore();
  const { workspace, added, venue } = store.addVenue(await readWorkspace(), entry || {});
  if (added) writeWorkspace(workspace);
  return { ok: true, added, venue };
});
ipcMain.handle('workspace:remove-venue', async (_event, id) => {
  const store = await loadWorkspaceStore();
  const workspace = store.removeVenue(await readWorkspace(), id);
  writeWorkspace(workspace);
  return { ok: true };
});
// 待读清单
ipcMain.handle('workspace:reading-list', async () => {
  const ws = await readWorkspace();
  return { items: ws.readingList || [] };
});
ipcMain.handle('workspace:add-reading-item', async (_event, entry) => {
  const store = await loadWorkspaceStore();
  const { workspace, added, item } = store.addReadingItem(await readWorkspace(), entry || {});
  if (added) writeWorkspace(workspace);
  return { ok: true, added, item };
});
ipcMain.handle('workspace:set-reading-item', async (_event, { id, done, remove } = {}) => {
  const store = await loadWorkspaceStore();
  let workspace = await readWorkspace();
  workspace = remove
    ? store.removeReadingItem(workspace, id)
    : store.setReadingItemDone(workspace, id, done !== false);
  writeWorkspace(workspace);
  return { ok: true };
});
// 阅读统计
let statsPromise = null;
function loadStats() {
  statsPromise ||= import('./lib/reading-stats.mjs');
  return statsPromise;
}
ipcMain.handle('stats:record', async (_event, { kind, amount } = {}) => {
  const statsLib = await loadStats();
  const workspace = await readWorkspace();
  workspace.stats = statsLib.recordActivity(workspace.stats, kind, amount);
  writeWorkspace(workspace);
  return { ok: true };
});
ipcMain.handle('stats:summary', async () => {
  const statsLib = await loadStats();
  const workspace = await readWorkspace();
  const now = Date.now();
  // 上周 = 第 8–14 天窗口：用 14 天汇总减去近 7 天
  const twoWeeks = statsLib.summarizeStats(workspace.stats, { days: 14, now });
  const week = statsLib.summarizeStats(workspace.stats, { days: 7, now });
  const prevWeek = {
    readMinutes: Math.max(0, twoWeeks.readMinutes - week.readMinutes),
    pagesTranslated: Math.max(0, twoWeeks.pagesTranslated - week.pagesTranslated),
    tokens: Math.max(0, twoWeeks.tokens - week.tokens),
    papersOpened: Math.max(0, twoWeeks.papersOpened - week.papersOpened),
    agentAsks: Math.max(0, twoWeeks.agentAsks - week.agentAsks),
    activeDays: Math.max(0, twoWeeks.activeDays - week.activeDays),
  };
  const heatmap = statsLib.heatmapModel(workspace.stats, { weeks: 12, now });
  // 给热力图格子补 pages 字段（UI tooltip）
  const s = statsLib.normalizeStats(workspace.stats);
  for (const col of heatmap.grid || []) {
    for (const cell of col || []) {
      if (!cell?.key) continue;
      cell.pages = s.days[cell.key]?.pagesTranslated || 0;
    }
  }
  return {
    week,
    prevWeek,
    month: statsLib.summarizeStats(workspace.stats, { days: 30, now }),
    total: statsLib.summarizeStats(workspace.stats, { days: statsLib.STATS_MAX_DAYS, now }),
    heatmap,
  };
});
// 前沿雷达
ipcMain.handle('radar:fetch', async () => {
  const [radar, store] = await Promise.all([import('./lib/arxiv-radar.mjs'), loadWorkspaceStore()]);
  const ws = store.normalizeWorkspace(await readWorkspace());
  let interests = {
    categories: [...(ws.interests?.categories || [])],
    keywords: [...(ws.interests?.keywords || [])],
  };
  // 无关键词时，从研究档案自动建议（不强制写入，只用于本轮打分 + 返回 UI）
  const suggested = radar.suggestKeywordsFromProfile(ws.profile || {});
  const autoSeeded = !interests.keywords.length && suggested.length > 0;
  if (autoSeeded) interests = { ...interests, keywords: suggested.slice(0, 6) };
  if (!interests.categories.length && !interests.keywords.length) {
    return {
      needsSetup: true,
      presets: radar.ARXIV_CATEGORY_PRESETS,
      suggestedKeywords: suggested,
    };
  }
  try {
    const papers = await radar.fetchRadarPapers(interests, { maxResults: 50 });
    const seenIds = (ws.readingList || []).map((r) => r.arxivId).filter(Boolean);
    return {
      interests: ws.interests || { categories: [], keywords: [] },
      scoringInterests: interests,
      autoSeeded,
      suggestedKeywords: suggested,
      papers: radar.rankRadarPapers(papers, interests, { seenIds }),
      presets: radar.ARXIV_CATEGORY_PRESETS,
    };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
});
ipcMain.handle('radar:digest-to-vault', async (_event, { ranked } = {}) => {
  const [radar, store] = await Promise.all([import('./lib/arxiv-radar.mjs'), loadWorkspaceStore()]);
  const workspace = await readWorkspace();
  if (!workspace.obsidian?.enabled || !workspace.obsidian.folder) {
    return { ok: false, reason: 'not-configured' };
  }
  const date = new Date().toISOString().slice(0, 10);
  const md = radar.radarDigestMarkdown(ranked || [], { date, interests: workspace.interests });
  const filePath = join(workspace.obsidian.folder, `前沿雷达 ${date}.md`);
  try {
    writeFileSync(filePath, md, 'utf8');
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
});
// 用 PaperLens 打开 arXiv PDF：下载到临时目录再走正常打开流程
ipcMain.handle('radar:open-arxiv-pdf', async (_event, { arxivId, title } = {}) => {
  const id = String(arxivId || '').trim();
  if (!/^[\w.\-/]+$/.test(id)) return { error: '无效的 arXiv id' };
  try {
    const response = await fetch(`https://arxiv.org/pdf/${id}`, {
      headers: { 'User-Agent': 'PaperLens-Desktop/0.2' }, redirect: 'follow',
    });
    if (!response.ok) return { error: `下载失败 HTTP ${response.status}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) return { error: 'arXiv 返回的不是 PDF（可能被限流）' };
    const safe = String(title || id).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    const dir = join(app.getPath('userData'), 'arxiv-cache');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${safe || id}.pdf`);
    writeFileSync(filePath, bytes);
    return { ok: true, path: filePath, name: basename(filePath), data: bytes.toString('base64') };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
});
// 知识库（复用 Obsidian vault 配置）
ipcMain.handle('kb:overview', async () => {
  const workspace = await readWorkspace();
  const folder = workspace.obsidian?.folder || '';
  if (!folder) return { configured: false };
  const kb = await import('./lib/knowledge-base.mjs');
  try {
    return { configured: true, folder, ...kb.vaultOverview(folder) };
  } catch (error) {
    return { configured: true, folder, error: String(error?.message || error) };
  }
});
ipcMain.handle('kb:search', async (_event, { query, maxResults } = {}) => {
  const workspace = await readWorkspace();
  const folder = workspace.obsidian?.folder || '';
  if (!folder) return { configured: false, hits: [] };
  const kb = await import('./lib/knowledge-base.mjs');
  try {
    return { configured: true, hits: kb.searchVault(folder, String(query || ''), { maxResults }) };
  } catch (error) {
    return { configured: true, hits: [], error: String(error?.message || error) };
  }
});
ipcMain.handle('workspace:set-agent-mode', async (_event, mode) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setAgentMode(await readWorkspace(), mode);
  writeWorkspace(workspace);
  // 重建 registry 无必要；mode 每次 ask 时读取
  return { ok: true, agentMode: workspace.agentMode };
});
ipcMain.handle('workspace:set-overleaf', async (_event, payload) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setOverleafConfig(await readWorkspace(), payload || {});
  writeWorkspace(workspace);
  return { ok: true, overleaf: workspace.overleaf };
});
ipcMain.handle('workspace:todos', async (_event, opts) => {
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  return {
    todos: store.listTodos(ws, opts || {}),
    memory: store.listMemory(ws, { paperPath: opts?.paperPath }),
    agentMode: ws.agentMode,
  };
});
ipcMain.handle('workspace:add-todo', async (_event, payload) => {
  const store = await loadWorkspaceStore();
  const { workspace, added, todo } = store.addTodo(await readWorkspace(), payload || {});
  if (added) writeWorkspace(workspace);
  return { ok: true, added, todo };
});
ipcMain.handle('workspace:set-todo-done', async (_event, { id, done } = {}) => {
  const store = await loadWorkspaceStore();
  const workspace = store.setTodoDone(await readWorkspace(), id, done !== false);
  writeWorkspace(workspace);
  return { ok: true };
});
ipcMain.handle('workspace:lock-term', async (_event, payload) => {
  const store = await loadWorkspaceStore();
  const workspace = store.upsertGlossaryTerm(await readWorkspace(), payload);
  writeWorkspace(workspace);
  return { ok: true, count: workspace.glossary.length };
});
ipcMain.handle('workspace:list-glossary', async () => {
  const ws = await readWorkspace();
  return { glossary: ws.glossary || [] };
});
ipcMain.handle('workspace:remove-term', async (_event, { term } = {}) => {
  const store = await loadWorkspaceStore();
  const workspace = store.removeGlossaryTerm(await readWorkspace(), term);
  writeWorkspace(workspace);
  return { ok: true, count: workspace.glossary.length };
});

// P2：高亮 / 写作草稿
ipcMain.handle('highlights:list', async (_event, { path } = {}) => {
  const hl = await import('./lib/highlights-store.mjs');
  const ws = await readWorkspace();
  return { highlights: hl.listHighlights(ws.highlights, path) };
});
ipcMain.handle('highlights:add', async (_event, payload = {}) => {
  const hl = await import('./lib/highlights-store.mjs');
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  const { map, added, highlight } = hl.addHighlight(ws.highlights, payload.path, payload);
  writeWorkspace(store.setHighlightsMap(ws, map));
  return { ok: true, added, highlight };
});
ipcMain.handle('highlights:remove', async (_event, { path, id } = {}) => {
  const hl = await import('./lib/highlights-store.mjs');
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  const map = hl.removeHighlight(ws.highlights, path, id);
  writeWorkspace(store.setHighlightsMap(ws, map));
  return { ok: true };
});
ipcMain.handle('drafts:list', async () => {
  const wd = await import('./lib/writing-draft.mjs');
  const ws = await readWorkspace();
  return { drafts: wd.normalizeDrafts(ws.drafts) };
});
ipcMain.handle('drafts:save', async (_event, draft) => {
  const wd = await import('./lib/writing-draft.mjs');
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  const { drafts, draft: saved } = wd.upsertDraft(ws.drafts, draft);
  writeWorkspace(store.setDraftsList(ws, drafts));
  return { ok: true, draft: saved };
});
ipcMain.handle('drafts:remove', async (_event, { id } = {}) => {
  const wd = await import('./lib/writing-draft.mjs');
  const store = await loadWorkspaceStore();
  const ws = await readWorkspace();
  writeWorkspace(store.setDraftsList(ws, wd.removeDraft(ws.drafts, id)));
  return { ok: true };
});
ipcMain.handle('drafts:get', async (_event, { id } = {}) => {
  const wd = await import('./lib/writing-draft.mjs');
  const ws = await readWorkspace();
  return { draft: wd.getDraft(ws.drafts, id) };
});
ipcMain.handle('workspace:touch-recent', async (_event, entry) => {
  const store = await loadWorkspaceStore();
  const workspace = store.upsertRecent(await readWorkspace(), entry);
  writeWorkspace(workspace);
  return { ok: true };
});
ipcMain.handle('workspace:add-note', async (_event, note) => {
  const store = await loadWorkspaceStore();
  const { workspace, added } = store.addNote(await readWorkspace(), note);
  if (added) writeWorkspace(workspace);
  return { ok: true, added, count: workspace.notes.length };
});
ipcMain.handle('workspace:remove-note', async (_event, id) => {
  const store = await loadWorkspaceStore();
  const workspace = store.removeNote(await readWorkspace(), id);
  writeWorkspace(workspace);
  return { ok: true, count: workspace.notes.length };
});
ipcMain.handle('workspace:export-notes', async () => {
  const store = await loadWorkspaceStore();
  const workspace = await readWorkspace();
  if (!workspace.notes.length) return { error: '还没有已保存的笔记' };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出科研笔记',
    defaultPath: join(app.getPath('documents'), 'paperlens-notes.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { ok: false };
  writeFileSync(filePath, store.notesToMarkdown(workspace), 'utf8');
  return { ok: true, filePath };
});

// Obsidian vault 同步：选一次文件夹，之后收藏笔记时自动写一份 .md 进去。
// 与扩展 phone-drop 同模式（主进程有 Node fs，无 File System Access 限制）。
ipcMain.handle('obsidian:pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 Obsidian vault 文件夹',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths?.[0]) return { ok: false };
  const folder = filePaths[0];
  const store = await loadWorkspaceStore();
  const workspace = await readWorkspace();
  workspace.obsidian = { folder, enabled: true };
  writeWorkspace(workspace);
  return { ok: true, folder };
});
ipcMain.handle('obsidian:status', async () => {
  const workspace = await readWorkspace();
  return workspace.obsidian || null;
});
ipcMain.handle('obsidian:set-enabled', async (_event, enabled) => {
  const workspace = await readWorkspace();
  if (!workspace.obsidian) return { ok: false };
  workspace.obsidian.enabled = Boolean(enabled);
  writeWorkspace(workspace);
  return { ok: true };
});
// 收藏笔记时由渲染进程调用：把笔记写进 vault（noteToVaultMarkdown + 文件名）。
ipcMain.handle('obsidian:write-note', async (_event, note) => {
  const workspace = await readWorkspace();
  if (!workspace.obsidian?.enabled || !workspace.obsidian.folder) {
    return { ok: false, reason: 'not-configured' };
  }
  const store = await loadWorkspaceStore();
  const normalized = store.normalizeNote(note);
  if (!normalized) return { ok: false, reason: 'invalid-note' };
  const filename = store.noteToVaultFilename(normalized);
  const filePath = join(workspace.obsidian.folder, filename);
  try {
    writeFileSync(filePath, store.noteToVaultMarkdown(normalized), 'utf8');
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
});

// 原生打开 PDF：文件对话框 / 最近列表按路径重开。桌面软件的优势——
// 记住绝对路径，一键重开无需再选文件（扩展端做不到的体验在这里补齐）。
ipcMain.handle('paper:pick-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '打开论文 PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePaths?.[0]) return { ok: false };
  return readPdfByPath(filePaths[0]);
});
ipcMain.handle('paper:open-path', async (_event, path) => readPdfByPath(String(path || '')));

// 批量导入：选文件夹 → 递归扫 PDF（≤500，跳过隐藏/依赖目录）→ 入文库（recent），不复制文件。
ipcMain.handle('library:import-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择包含论文 PDF 的文件夹',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths?.[0]) return { cancelled: true };
  const root = filePaths[0];
  const found = [];
  const skip = new Set(['node_modules', '.git', '.obsidian', '.trash', '$RECYCLE.BIN', 'System Volume Information']);
  const { readdirSync } = require('node:fs');
  const walk = (dir, depth) => {
    if (found.length >= 500 || depth > 6) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= 500) return;
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.pdf$/i.test(entry.name)) found.push(full);
    }
  };
  walk(root, 0);
  if (!found.length) return { imported: 0, note: '文件夹里没找到 PDF' };
  const store = await loadWorkspaceStore();
  let workspace = await readWorkspace();
  let imported = 0;
  const now = Date.now();
  for (const file of found) {
    // 已在文库的不重复导入（保留其进度）
    if (workspace.recent.some((r) => r.path === file)) continue;
    workspace = store.upsertRecent(workspace, {
      path: file,
      title: basename(file),
    // 递增时间戳保持文件夹内顺序稳定
    }, now - imported);
    imported += 1;
  }
  writeWorkspace(workspace);
  return { imported, total: found.length };
});

// 元数据提取（打开论文时渲染进程带首页文本调用；启发式，不调模型）
ipcMain.handle('library:extract-metadata', async (_event, { path, firstPageText, fallbackName } = {}) => {
  if (!path) return { error: 'path 必填' };
  const meta = await import('./lib/paper-metadata.mjs');
  const extracted = meta.extractPaperMetadata({
    firstPageText: String(firstPageText || ''),
    fallbackName: String(fallbackName || ''),
  });
  const store = await loadWorkspaceStore();
  let workspace = await readWorkspace();
  const entry = workspace.recent.find((r) => r.path === String(path));
  // 已有手动元数据不覆盖；标题只在现值是文件名时替换
  if (entry) {
    const patch = {};
    if (extracted.arxivId && !entry.arxivId) patch.arxivId = extracted.arxivId;
    if (extracted.year && !entry.year) patch.year = extracted.year;
    if (extracted.title && /\.pdf$/i.test(entry.title)) patch.title = extracted.title;
    if (Object.keys(patch).length) {
      workspace = store.updateLibraryEntry(workspace, String(path), patch);
      writeWorkspace(workspace);
    }
  }
  return { ok: true, extracted };
});
function readPdfByPath(path) {
  try {
    const bytes = readFileSync(path);
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) return { error: '不是有效的 PDF 文件' };
    return { ok: true, path, name: basename(path), data: bytes.toString('base64') };
  } catch (error) {
    return { error: `无法打开文件（可能已移动或删除）：${String(error?.message || error).slice(0, 120)}` };
  }
}

function loadConfig() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* 首次运行 */ }
  // 兼容 CLI 的 desktop/agent.config.json（开发期共用一份配置）。
  try { return JSON.parse(readFileSync(join(__dirname, 'agent.config.json'), 'utf8')); } catch { return {}; }
}
function saveConfig(config) {
  if (!existsSync(dirname(configPath()))) mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// PaperLens Research Agent：自有 runtime + 科研 skills + 论文/联网/记忆/导出/工作台工具。
let corePromise = null;
function loadCore() {
  corePromise ||= Promise.all([
    import('./lib/agent-core.mjs'),
    import('./lib/web-tool-defs.mjs'),
    import('./lib/paper-tool-defs.mjs'),
    import('./lib/research-skills.mjs'),
    import('./lib/memory-tools.mjs'),
    import('./lib/export-tools.mjs'),
    import('./lib/evidence.mjs'),
    import('./lib/workbench-tool-defs.mjs'),
    loadWorkspaceStore(),
  ]).then(([core, webDefs, paperDefs, skills, memoryTools, exportTools, evidence, workbenchDefs, store]) => {
    const saveNote = async (note) => {
      const { workspace, added } = store.addNote(await readWorkspace(), note);
      if (added) writeWorkspace(workspace);
      return { ok: true, added, count: workspace.notes.length };
    };
    const getPaper = () => (paper ? {
      title: paper.title,
      path: paper.path || '',
      pages: paper.pages,
    } : null);
    const registry = core.createToolRegistry([
      // Gen6: Agent 可驱动阅读器——讲解时直接把用户视野带到对应页
      {
        name: 'show_page_to_user',
        description: '把用户的阅读器滚动到指定页并高亮（讲解某页内容时同步用户视野）。不产生数据，仅 UI 动作。',
        parameters: {
          type: 'object',
          properties: { page: { type: 'number', description: '要展示的页码（从 1 开始）' } },
          required: ['page'],
        },
        run: async ({ page } = {}) => {
          const n = Math.max(1, Math.round(Number(page) || 1));
          for (const win of BrowserWindow.getAllWindows()) {
            try { win.webContents.send('ui:show-page', { page: n }); } catch { /* noop */ }
          }
          return { ok: true, page: n };
        },
      },
      // Gen7: Agent 可读用户在当前论文上的持久高亮（用户觉得重要的段落）
      {
        name: 'list_user_highlights',
        description: '列出用户在当前论文上做的高亮标注（页码 + 原文片段）。回答「我标注过什么 / 结合我划的重点」类问题用。',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          const path = paper?.path || '';
          if (!path) return { highlights: [], note: '当前没有打开论文' };
          const hl = await import('./lib/highlights-store.mjs');
          const ws = await readWorkspace();
          const highlights = hl.listHighlights(ws.highlights, path)
            .map((h) => ({ page: h.page, text: String(h.text || '').slice(0, 300), note: h.note || '' }));
          return { count: highlights.length, highlights };
        },
      },
      ...webDefs.createWebToolDefs(),
      ...paperDefs.createPaperToolDefs(getPaper, { saveNote }),
      ...memoryTools.createMemoryToolDefs({
        getContext: () => ({
          paperPath: paper?.path || '',
          paperTitle: paper?.title || '',
        }),
        readWorkspace,
        writeWorkspace,
        store,
      }),
      ...workbenchDefs.createWorkbenchToolDefs({
        getVaultFolder: () => {
          try {
            const ws = JSON.parse(readFileSync(workspacePath(), 'utf8'));
            return ws?.obsidian?.folder || '';
          } catch { return ''; }
        },
        readWorkspace,
        writeWorkspace,
        store,
      }),
      ...exportTools.createExportToolDefs({
        getPaper,
        getWorkspace: () => {
          try { return JSON.parse(readFileSync(workspacePath(), 'utf8')); }
          catch { return {}; }
        },
        saveMarkdownFile: async ({ defaultName, content }) => {
          const { canceled, filePath } = await dialog.showSaveDialog({
            title: '导出科研报告',
            defaultPath: join(app.getPath('documents'), defaultName || 'paperlens-report.md'),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
          });
          if (canceled || !filePath) return { ok: false, canceled: true };
          try {
            writeFileSync(filePath, content, 'utf8');
            return { ok: true, filePath };
          } catch (error) {
            return { ok: false, error: String(error?.message || error) };
          }
        },
        openExternal: (url) => shell.openExternal(String(url || '')),
        writeClipboard: (text) => { clipboard.writeText(String(text || '')); },
      }),
    ]);
    return { ...core, skills, evidence, store, registry };
  });
  return corePromise;
}

// 当前打开的论文（渲染进程抽取文本后注入）。
let paper = null;
ipcMain.handle('paper:set', (_event, next) => {
  const pages = (Array.isArray(next?.pages) ? next.pages : []).map((p) => String(p || ''));
  paper = pages.length
    ? {
      title: String(next?.title || '').slice(0, 200),
      pages,
      path: String(next?.path || '').slice(0, 500),
    }
    : null;
  return { ok: true, pages: pages.length };
});

// 整页视觉翻译：复用扩展的 translator（提示词/协议/流式全套成熟逻辑）。
// 渲染进程发页位图 dataURL，流式增量经 translate:delta 事件回传。
let translatorPromise = null;
function loadTranslator() {
  translatorPromise ||= Promise.all([
    import('../src/lib/translator.js'),
    import('../src/lib/reading-mode.js'),
  ]).then(([translator, readingMode]) => ({ translator, readingMode }));
  return translatorPromise;
}

ipcMain.handle('paper:translate-page', async (event, { page, image, sourceText, qualityRetry } = {}) => {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { error: '请先在设置里配置模型（需支持图片输入的视觉模型）' };
  }
  try {
    const { translator, readingMode } = await loadTranslator();
    const requestText = readingMode.buildVisionTranslationContext({
      sourceText: String(sourceText || ''),
      // 渲染进程带 qualityRetry（首次失败原因）时注入重试上下文，与扩展同款
      quality: qualityRetry || null,
    });
    // 术语表注入（视觉整页翻译走全表，与扩展 service-worker 一致）。
    let glossary = [];
    try { glossary = (await readWorkspace()).glossary || []; } catch { /* noop */ }
    let raw = '';
    const full = await translator.translate({
      config: {
        protocol: config.protocol || 'openai',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        targetLang: config.targetLang || '简体中文',
        glossary,
        stream: true,
        // 质量重试用 temperature 0（确定性精修），首译保持默认
        ...(qualityRetry ? { temperature: 0 } : {}),
      },
      text: requestText,
      image: String(image || ''),
      onDelta: (delta) => {
        raw += String(delta || '');
        try { event.sender.send('translate:delta', { page, delta: String(delta || '') }); } catch { /* 窗口已关 */ }
      },
    });
    const markdown = readingMode.finalizeReadingTranslation(raw, full);
    // 质量门（扩展同款）：只把灾难性失败标记为可重试，普通告警不阻断阅读
    const quality = readingMode.assessVisionTranslationQuality(markdown, {
      targetLang: config.targetLang || '简体中文',
      sourceText: String(sourceText || ''),
    });
    return { page, markdown, quality: quality.ok ? null : {
      ok: false,
      reason: quality.reason,
      reasons: quality.reasons,
      message: quality.message,
      metrics: { structure: quality.metrics?.structure || {}, missingAnchors: quality.metrics?.missingAnchors || {} },
    } };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
});

// 划词翻译：短文本走非流式文本接口（不用图片，便宜快）。术语表注入。
ipcMain.handle('translate:selection', async (_event, { text, glossary = [] } = {}) => {
  const config = loadConfig();
  const source = String(text || '').trim();
  if (!source) return { error: '没有选中文本' };
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { error: '请先在设置里配置模型' };
  }
  try {
    const { translator } = await loadTranslator();
    const { glossaryTermsInText, appendGlossaryPrompt } = await import('../src/lib/glossary.js');
    // 主进程未传 glossary 时回落到工作区术语表
    let terms = Array.isArray(glossary) ? glossary : [];
    if (!terms.length) {
      try { terms = (await readWorkspace()).glossary || []; } catch { /* noop */ }
    }
    const hits = glossaryTermsInText(terms, source);
    const result = await translator.translate({
      config: {
        protocol: config.protocol || 'openai',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        targetLang: config.targetLang || '简体中文',
        systemPrompt: appendGlossaryPrompt(
          translator.defaultSystemPrompt(config.targetLang || '简体中文'),
          hits,
        ),
        stream: false,
      },
      text: source,
      onDelta: () => {},
    });
    return { translation: String(result || '').trim() };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
});

// 会话历史（主进程持有；渲染进程重启不丢当轮会话）。
let history = [];
// 当前会话 id（首问生成；chat:reset 后新会话）
let currentSessionId = '';
/** @type {AbortController | null} */
let chatAbort = null;
/** @type {Map<string, { resolve: (v: boolean) => void }>} */
const pendingConfirms = new Map();

// ---------------------------------------------------------------------------
// 会话列表 IPC：列表 / 打开（恢复 history）/ 删除
// ---------------------------------------------------------------------------
ipcMain.handle('sessions:list', async () => {
  const store = await loadSessionStore();
  return { sessions: store.listSessionSummaries(await readSessions()) };
});
ipcMain.handle('sessions:open', async (_event, { id } = {}) => {
  const store = await loadSessionStore();
  const session = store.getSession(await readSessions(), id);
  if (!session) return { error: '会话不存在（可能已被容量清理）' };
  chatAbort?.abort();
  chatAbort = null;
  history = session.messages.map(({ role, content }) => ({ role, content }));
  currentSessionId = session.id;
  return { ok: true, session };
});
ipcMain.handle('sessions:remove', async (_event, { id } = {}) => {
  const store = await loadSessionStore();
  writeSessions(store.removeSession(await readSessions(), id));
  if (currentSessionId === String(id || '')) currentSessionId = '';
  return { ok: true };
});

async function persistCurrentSession() {
  if (!history.length) return;
  const store = await loadSessionStore();
  if (!currentSessionId) currentSessionId = randomUUID();
  const container = store.upsertSession(await readSessions(), {
    id: currentSessionId,
    paperTitle: paper?.title || '',
    messages: history,
  });
  writeSessions(container);
}

ipcMain.handle('config:get', async () => {
  const config = loadConfig();
  const ws = await readWorkspace();
  return {
    baseUrl: config.baseUrl || '',
    model: config.model || '',
    targetLang: config.targetLang || '简体中文',
    hasKey: Boolean(config.apiKey),
    agentMode: ws.agentMode || 'copilot',
    overleaf: ws.overleaf || null,
  };
});
ipcMain.handle('config:set', async (_event, next) => {
  const current = loadConfig();
  saveConfig({
    baseUrl: String(next?.baseUrl || current.baseUrl || '').trim(),
    apiKey: String(next?.apiKey ?? current.apiKey ?? '').trim(),
    model: String(next?.model || current.model || '').trim(),
    targetLang: String(next?.targetLang || current.targetLang || '简体中文').slice(0, 40),
  });
  if (next?.agentMode) {
    const store = await loadWorkspaceStore();
    const workspace = store.setAgentMode(await readWorkspace(), next.agentMode);
    writeWorkspace(workspace);
  }
  if (next?.overleafProjectUrl != null || next?.overleafEnabled != null) {
    const store = await loadWorkspaceStore();
    let workspace = await readWorkspace();
    const url = next.overleafProjectUrl != null
      ? next.overleafProjectUrl
      : (workspace.overleaf?.projectUrl || '');
    if (url) {
      workspace = store.setOverleafConfig(workspace, {
        projectUrl: url,
        enabled: next.overleafEnabled != null ? next.overleafEnabled : true,
      });
      writeWorkspace(workspace);
    }
  }
  return { ok: true };
});
ipcMain.handle('chat:reset', async () => {
  chatAbort?.abort();
  chatAbort = null;
  for (const [, pending] of pendingConfirms) pending.resolve(false);
  pendingConfirms.clear();
  // 清空前保存当前会话（有内容才存）
  try { await persistCurrentSession(); } catch { /* noop */ }
  history = [];
  currentSessionId = '';
  return { ok: true };
});
ipcMain.handle('chat:cancel', () => {
  if (chatAbort) {
    chatAbort.abort();
    chatAbort = null;
  }
  for (const [, pending] of pendingConfirms) pending.resolve(false);
  pendingConfirms.clear();
  return { ok: true, cancelled: true };
});
ipcMain.handle('chat:skills', async () => {
  const core = await loadCore();
  return { skills: core.skills.listResearchSkills() };
});
/** 渲染进程回答写操作确认门 */
ipcMain.handle('chat:confirm-response', (_event, { id, allowed } = {}) => {
  const pending = pendingConfirms.get(String(id || ''));
  if (!pending) return { ok: false };
  pendingConfirms.delete(String(id || ''));
  pending.resolve(Boolean(allowed));
  return { ok: true };
});

ipcMain.handle('chat:ask', async (event, question, opts = {}) => {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { error: '请先在设置里填写中转站 Base URL / API Key / 模型' };
  }
  const q = String(question || '').trim();
  if (!q) return { error: '问题为空' };

  chatAbort?.abort();
  for (const [, pending] of pendingConfirms) pending.resolve(false);
  pendingConfirms.clear();
  chatAbort = new AbortController();
  const signal = chatAbort.signal;

  const core = await loadCore();
  const chatFn = core.createOpenAiStreamingChat(config);
  const ws = await readWorkspace();
  const agentMode = opts?.agentMode || ws.agentMode || 'copilot';

  let skill = null;
  if (opts?.skillId) skill = core.skills.getResearchSkill(opts.skillId);
  if (!skill && opts?.autoSkill !== false) skill = core.skills.matchResearchSkill(q);
  const skillBlock = skill ? core.skills.formatSkillPromptBlock(skill) : '';
  const memoryBlock = core.store.formatProjectMemoryBlock(ws, {
    paperPath: paper?.path || '',
    paperTitle: paper?.title || '',
  });
  const profileBlock = core.store.formatProfileBlock(ws);
  const maxRounds = skill?.maxRounds || 16;

  const userContent = skill && opts?.skillId
    ? `${q}\n\n（请严格执行已激活技能「${skill.label}」的流程与输出结构。）`
    : q;

  history.push({ role: 'user', content: userContent });
  const send = (type, data) => {
    try { event.sender.send('chat:event', { type, ...data }); } catch { /* 窗口已关 */ }
  };
  if (skill) send('skill', { id: skill.id, label: skill.label, title: skill.title });
  send('status', { phase: 'mode', agentMode });

  const confirmTool = async ({ name, args, preview }) => {
    const id = randomUUID();
    send('tool-confirm', { id, name, args, preview });
    return await new Promise((resolve) => {
      pendingConfirms.set(id, { resolve });
      const onAbort = () => {
        if (pendingConfirms.has(id)) {
          pendingConfirms.delete(id);
          resolve(false);
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  try {
    // 渲染进程带来的工作情境（当前视图 / 阅读页码 / 写作草稿）——让 Agent 知道用户正在哪里
    const ctx = opts?.context && typeof opts.context === 'object' ? opts.context : null;
    const ctxLines = [];
    if (ctx?.view === 'reader' && ctx.page) {
      ctxLines.push(`用户正在阅读器看第 ${Math.round(Number(ctx.page))} / ${Math.round(Number(ctx.totalPages) || 0)} 页（已译 ${Math.round(Number(ctx.translatedPages) || 0)} 页）。「这页 / 当前页」即指第 ${Math.round(Number(ctx.page))} 页。`);
    } else if (ctx?.view === 'write') {
      ctxLines.push(`用户正在写作工坊${ctx.draftTitle ? `，编辑草稿「${String(ctx.draftTitle).slice(0, 60)}」（类型 ${ctx.draftKind || 'general'}）` : ''}。`);
    } else if (ctx?.view && ctx.view !== 'reader') {
      const viewNames = { home: '首页', library: '文库', radar: '前沿雷达', submit: '投稿助手', kb: '知识库', stats: '统计' };
      if (viewNames[ctx.view]) ctxLines.push(`用户正在「${viewNames[ctx.view]}」视图。`);
    }
    const system = core.buildResearchSystemPrompt({
      paperTitle: paper?.title || '',
      paperPages: paper?.pages?.length || 0,
      skillBlock: [skillBlock, memoryBlock, profileBlock].filter(Boolean).join('\n\n'),
      targetLang: config.targetLang || '简体中文',
      extraRules: [
        ...ctxLines,
        agentMode === 'autopilot'
          ? '当前为自动驾驶：写操作无需逐步确认，但仍禁止编造。'
          : '当前为副驾驶：写盘/导出/Overleaf 工具会请求用户确认。',
      ].join('\n'),
    });
    // 框选图附图：走多模态 content 数组（图片 + 文字）。仅注入最近一轮，历史里存纯文本。
    const imageDataUrl = String(opts?.image || '').trim();
    const userMessage = imageDataUrl && /^data:image\//.test(imageDataUrl)
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userContent },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }
      : { role: 'user', content: userContent };
    const turns = [{ role: 'system', content: system }, ...history.slice(0, -1), userMessage];
    const { answer, trace, rounds, cancelled } = await core.runAgentTurn({
      chatFn,
      registry: core.registry,
      messages: turns,
      maxRounds,
      signal,
      agentMode,
      confirmTool,
      onEvent: (type, data) => send(type, data),
    });
    if (signal.aborted || cancelled) {
      history.pop();
      send('cancelled', {});
      return { error: '已取消', cancelled: true, trace };
    }
    history.push({ role: 'assistant', content: answer });
    if (history.length > 24) history = history.slice(-16);
    // 每轮完成即持久化会话（渲染进程/应用重启可恢复）
    try { await persistCurrentSession(); } catch { /* noop */ }
    const evidence = core.evidence.buildEvidenceModel({
      answer,
      trace,
      maxPage: paper?.pages?.length || 0,
    });
    send('evidence', evidence);
    return {
      answer,
      trace,
      rounds,
      skillId: skill?.id || null,
      evidence,
      agentMode,
    };
  } catch (error) {
    history.pop();
    if (error?.code === 'ABORTED' || signal.aborted) {
      send('cancelled', {});
      return { error: '已取消', cancelled: true };
    }
    return { error: String(error?.message || error) };
  } finally {
    if (chatAbort?.signal === signal) chatAbort = null;
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'PaperLens Desktop',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
