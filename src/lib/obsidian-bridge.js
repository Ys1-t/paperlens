// Obsidian bridge for PaperLens research notes.
// Browser extensions cannot speak MCP STDIO; we use Obsidian's Local REST API
// (same backend many Obsidian MCP servers wrap). Optional MCP clients
// (Claude / Cursor / Grok) can still use a separate Obsidian MCP server against
// the same vault.

export const OBSIDIAN_DEFAULT_BASE_URL = 'http://127.0.0.1:27123';
export const OBSIDIAN_DEFAULT_FOLDER = 'PaperLens';

/**
 * Normalize Obsidian settings.
 *
 * IMPORTANT: never read translation profile fields (`baseUrl` / `apiKey` from
 * the full runtime config). Those point at the LLM proxy (e.g. cliproxy) and
 * caused "无法连接 https://cliproxy…/v1" on the Obsidian probe.
 *
 * Accept either:
 * - flat config: { obsidianEnabled, obsidianBaseUrl, obsidianApiKey, obsidianFolder }
 * - already-normalized bag: { enabled, baseUrl, apiKey, folder, __obsidianNormalized }
 */
export function normalizeObsidianSettings(config = {}) {
  const already = config?.__obsidianNormalized === true
    || (
      Object.prototype.hasOwnProperty.call(config, 'enabled')
      && Object.prototype.hasOwnProperty.call(config, 'folder')
      && !Object.prototype.hasOwnProperty.call(config, 'obsidianBaseUrl')
      && !Object.prototype.hasOwnProperty.call(config, 'model')
      && !Object.prototype.hasOwnProperty.call(config, 'provider')
    );

  if (already) {
    let baseUrl = String(config.baseUrl || OBSIDIAN_DEFAULT_BASE_URL).trim().replace(/\/+$/u, '');
    if (!baseUrl) baseUrl = OBSIDIAN_DEFAULT_BASE_URL;
    let folder = String(config.folder || OBSIDIAN_DEFAULT_FOLDER).trim().replace(/^\/+|\/+$/gu, '');
    if (!folder) folder = OBSIDIAN_DEFAULT_FOLDER;
    return {
      enabled: Boolean(config.enabled),
      baseUrl,
      apiKey: String(config.apiKey || '').trim(),
      folder,
      __obsidianNormalized: true,
    };
  }

  let baseUrl = String(config.obsidianBaseUrl || OBSIDIAN_DEFAULT_BASE_URL).trim().replace(/\/+$/u, '');
  if (!baseUrl) baseUrl = OBSIDIAN_DEFAULT_BASE_URL;
  let folder = String(config.obsidianFolder || OBSIDIAN_DEFAULT_FOLDER).trim().replace(/^\/+|\/+$/gu, '');
  if (!folder) folder = OBSIDIAN_DEFAULT_FOLDER;
  return {
    enabled: Boolean(config.obsidianEnabled),
    baseUrl,
    apiKey: String(config.obsidianApiKey || '').trim(),
    folder,
    __obsidianNormalized: true,
  };
}

/** Pick only Obsidian fields from a full runtime config (+ optional form override). */
export function pickObsidianConfigFields(config = {}, override = {}) {
  const src = { ...config, ...(override && typeof override === 'object' ? override : {}) };
  return {
    obsidianEnabled: src.obsidianEnabled,
    obsidianBaseUrl: src.obsidianBaseUrl,
    obsidianApiKey: src.obsidianApiKey,
    obsidianFolder: src.obsidianFolder,
  };
}

/** Safe vault-relative path segment from paper title / free text. */
export function sanitizeObsidianPathSegment(value, fallback = 'untitled-paper') {
  let s = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^[\]]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  if (!s) s = fallback;
  return s;
}

/** Build vault path: Folder/Paper Title.md */
export function buildPaperNotePath({ folder, docTitle, fileName } = {}) {
  const dir = sanitizeObsidianPathSegment(folder || OBSIDIAN_DEFAULT_FOLDER, OBSIDIAN_DEFAULT_FOLDER);
  const name = sanitizeObsidianPathSegment(
    fileName || docTitle || 'untitled-paper',
    'untitled-paper',
  );
  const withExt = /\.md$/iu.test(name) ? name : `${name}.md`;
  return `${dir}/${withExt}`.replace(/\/{2,}/gu, '/');
}

/** Encode each path segment for /vault/... URL. */
export function encodeVaultPath(path) {
  return String(path || '')
    .replace(/^\/+|\/+$/gu, '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export function vaultUrl(baseUrl, path) {
  const root = String(baseUrl || OBSIDIAN_DEFAULT_BASE_URL).replace(/\/+$/u, '');
  return `${root}/vault/${encodeVaultPath(path)}`;
}

export function buildAuthHeaders(apiKey, { contentType = 'text/markdown' } = {}) {
  const headers = {
    Accept: 'application/json, text/markdown, text/plain, */*',
  };
  if (contentType) headers['Content-Type'] = contentType;
  const key = String(apiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Full paper note body for first write.
 * sections: [{ title, content }]
 * thoughts: free-form researcher notes
 */
export function buildPaperNoteMarkdown({
  docTitle = '',
  sourceUrl = '',
  notesMarkdown = '',
  thoughts = '',
  now = new Date(),
} = {}) {
  const title = String(docTitle || '').trim() || '未命名论文';
  const stamp = now instanceof Date ? now.toLocaleString('zh-CN') : String(now || '');
  const lines = [
    `---`,
    `title: "${title.replace(/"/gu, "'")}"`,
    `source: PaperLens`,
    `created: ${now instanceof Date ? now.toISOString().slice(0, 10) : ''}`,
    `tags: [paperlens, paper-notes]`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    `> 由 PaperLens 科研助手写入 · ${stamp}`,
    ``,
  ];
  if (sourceUrl) {
    lines.push(`- 来源：${sourceUrl}`, '');
  }
  const body = String(notesMarkdown || '').trim();
  if (body) {
    lines.push(`## 助手笔记`, '', body, '');
  }
  const think = String(thoughts || '').trim();
  if (think) {
    lines.push(`## 我的思考`, '', think, '');
  }
  if (!body && !think) {
    lines.push(`## 我的思考`, '', '_（在此写下你对本篇的想法）_', '');
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`;
}

/** Append-only block for later thoughts / AI excerpts. */
export function buildThoughtAppendMarkdown({
  title = '思考',
  content = '',
  now = new Date(),
} = {}) {
  const stamp = now instanceof Date ? now.toLocaleString('zh-CN') : String(now || '');
  const body = String(content || '').trim();
  if (!body) return '';
  return [
    '',
    `---`,
    '',
    `### ${String(title || '思考').trim()} · ${stamp}`,
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Low-level REST helpers (inject fetch for tests).
 */
export async function probeObsidianRest(settings, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const { baseUrl, apiKey } = normalizeObsidianSettings(settings);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // / is documented as a health-ish root; some builds use empty vault list.
    const url = `${baseUrl.replace(/\/+$/u, '')}/`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: buildAuthHeaders(apiKey, { contentType: null }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: 'API Key 无效或未授权' };
    }
    // 200/404 both mean server is reachable (path may 404).
    if (res.status >= 500) {
      return { ok: false, status: res.status, message: `Obsidian 返回 ${res.status}` };
    }
    return { ok: true, status: res.status, message: '已连通 Local REST API' };
  } catch (error) {
    const msg = String(error?.message || error || '');
    if (/abort/i.test(msg)) {
      return { ok: false, status: 0, message: '连接超时：请确认 Obsidian 已打开且 Local REST API 已启用' };
    }
    return {
      ok: false,
      status: 0,
      message: `无法连接 ${baseUrl}。请启用 Local REST API 的 HTTP 端口（默认 27123），并允许扩展访问本机。`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function readVaultNote(settings, path, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  const { baseUrl, apiKey } = normalizeObsidianSettings(settings);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(vaultUrl(baseUrl, path), {
      method: 'GET',
      headers: buildAuthHeaders(apiKey, { contentType: null }),
      signal: ctrl.signal,
    });
    if (res.status === 404) return { ok: true, exists: false, content: '' };
    if (!res.ok) {
      const detail = await safeText(res);
      return { ok: false, exists: false, content: '', status: res.status, message: detail || `读取失败 HTTP ${res.status}` };
    }
    const content = await res.text();
    return { ok: true, exists: true, content, status: res.status };
  } catch (error) {
    return { ok: false, exists: false, content: '', message: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function writeVaultNote(settings, path, content, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  mode = 'overwrite', // overwrite | append
} = {}) {
  const { baseUrl, apiKey } = normalizeObsidianSettings(settings);
  let body = String(content ?? '');
  if (mode === 'append') {
    const existing = await readVaultNote({
      enabled: true,
      baseUrl,
      apiKey,
      folder: OBSIDIAN_DEFAULT_FOLDER,
      __obsidianNormalized: true,
    }, path, { fetchImpl, timeoutMs });
    if (!existing.ok) return existing;
    body = existing.exists
      ? `${existing.content.replace(/\s*$/u, '')}\n${body}`
      : body;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(vaultUrl(baseUrl, path), {
      method: 'PUT',
      headers: buildAuthHeaders(apiKey),
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await safeText(res);
      return {
        ok: false,
        status: res.status,
        path,
        message: detail || (res.status === 401 ? 'API Key 无效' : `写入失败 HTTP ${res.status}`),
      };
    }
    return { ok: true, status: res.status, path, bytes: body.length };
  } catch (error) {
    return { ok: false, path, message: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upsert a paper note: create full document if missing, else append a section.
 */
export async function upsertPaperNote(settings, {
  docTitle,
  notesMarkdown = '',
  thoughts = '',
  sourceUrl = '',
  appendOnly = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cfg = normalizeObsidianSettings(settings);
  if (!cfg.enabled) {
    return { ok: false, message: '未启用 Obsidian 同步（请在设置中打开）' };
  }
  if (!cfg.apiKey) {
    return { ok: false, message: '未配置 Obsidian API Key' };
  }
  const path = buildPaperNotePath({ folder: cfg.folder, docTitle });
  const existing = await readVaultNote(cfg, path, { fetchImpl });
  if (!existing.ok) return { ...existing, path };

  // Never clobber an existing vault note (user may have edited it in Obsidian).
  if (!existing.exists) {
    const md = buildPaperNoteMarkdown({
      docTitle,
      sourceUrl,
      notesMarkdown,
      thoughts,
    });
    const written = await writeVaultNote(cfg, path, md, { fetchImpl, mode: 'overwrite' });
    return { ...written, path, created: true };
  }

  // File exists: append dated sections only.
  const chunks = [];
  if (String(notesMarkdown || '').trim() && !appendOnly) {
    chunks.push(buildThoughtAppendMarkdown({
      title: '助手笔记同步',
      content: String(notesMarkdown).trim(),
    }));
  }
  if (String(thoughts || '').trim()) {
    chunks.push(buildThoughtAppendMarkdown({
      title: '我的思考',
      content: String(thoughts).trim(),
    }));
  }
  // appendOnly thought-only path already covered; if syncing notes only:
  if (appendOnly && String(notesMarkdown || '').trim() && !String(thoughts || '').trim()) {
    chunks.push(buildThoughtAppendMarkdown({
      title: '助手摘录',
      content: String(notesMarkdown).trim(),
    }));
  }
  if (!chunks.length) {
    return { ok: true, path, skipped: true, message: '没有新内容可写入' };
  }
  const written = await writeVaultNote(cfg, path, chunks.join('\n'), {
    fetchImpl,
    mode: 'append',
  });
  return { ...written, path, created: false };
}

async function safeText(res) {
  try {
    return String(await res.text() || '').slice(0, 240);
  } catch {
    return '';
  }
}
