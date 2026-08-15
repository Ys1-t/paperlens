// PaperLens PWA 移动端纯函数：iPhone / iPad 布局、安装提示、划词、翻页、Agent 起步。
// 无 DOM / 无 Node API，便于单测。壳层（app.js）只负责接线。

export const FONT_LEVELS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export function isStandaloneDisplay(win = globalThis) {
  try {
    if (win?.navigator?.standalone === true) return true;
    if (typeof win?.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
  } catch { /* 无 matchMedia */ }
  return false;
}

export function isIosSafari(ua = '') {
  const s = String(ua || '');
  const ios = /iPhone|iPad|iPod/i.test(s) || (/Macintosh/i.test(s) && /Mobile/i.test(s));
  const webkit = /WebKit/i.test(s);
  const notOther = !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(s);
  return Boolean(ios && webkit && notOther);
}

export function isIpadUserAgent(ua = '') {
  const s = String(ua || '');
  return /iPad/i.test(s) || (/Macintosh/i.test(s) && /Mobile/i.test(s));
}

export function shouldShowIosInstallHint({ ua = '', standalone = false, dismissed = false } = {}) {
  if (standalone || dismissed) return false;
  return isIosSafari(ua);
}

export function installBannerCopy(ua = '') {
  if (isIpadUserAgent(ua)) {
    return '点分享 →「添加到主屏幕」，像 App 一样全屏读论文。';
  }
  return '点底部分享 →「添加到主屏幕」，从桌面一键打开。';
}

export function isIpadLayout(width = 0) {
  return Number(width) >= 900;
}

export function shouldUseSplitCompare(width = 0) {
  return isIpadLayout(width);
}

export function swipeFromDelta(dx = 0, dy = 0, { threshold = 56 } = {}) {
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  if (Math.abs(x) < threshold || Math.abs(x) < Math.abs(y) * 1.2) return null;
  return x < 0 ? 'next' : 'prev';
}

export function nextUntranslatedPage(pages = [], fromPage = 1) {
  const list = Array.isArray(pages) ? pages : [];
  const start = Math.max(1, Math.round(Number(fromPage) || 1));
  const ordered = [
    ...list.filter((p) => Number(p.num) >= start),
    ...list.filter((p) => Number(p.num) < start),
  ];
  const hit = ordered.find((p) => !p.translated && !p.started);
  return hit ? Number(hit.num) : 0;
}

export function untranslatedCount(pages = []) {
  return (Array.isArray(pages) ? pages : []).filter((p) => !p.translated).length;
}

export function cycleFontLevel(level = 'md') {
  const i = FONT_LEVELS.indexOf(level);
  return FONT_LEVELS[(i < 0 ? 1 : i + 1) % FONT_LEVELS.length];
}

export function fontSizePx(level = 'md') {
  return { sm: 15, md: 16, lg: 18, xl: 20 }[level] || 16;
}

export function nextTheme(theme = 'light') {
  return theme === 'dark' ? 'light' : 'dark';
}

export function clampPage(n, total) {
  const max = Math.max(1, Number(total) || 1);
  const v = Math.round(Number(n) || 1);
  return Math.min(max, Math.max(1, v));
}

export function readingProgressRatio(current = 0, total = 0) {
  const t = Math.max(0, Number(total) || 0);
  if (!t) return 0;
  return Math.min(1, Math.max(0, (Number(current) || 0) / t));
}

export function dockPageLabel(current = 0, total = 0) {
  return `${Math.max(0, Number(current) || 0)} / ${Math.max(0, Number(total) || 0)}`;
}

export function parseGotoPage(raw, maxPages = 1) {
  const n = Math.round(Number(String(raw || '').replace(/[^\d.-]/g, '')));
  if (!Number.isFinite(n) || n < 1 || n > Math.max(1, Number(maxPages) || 1)) return 0;
  return n;
}

export function searchTranslationHits(pages = [], query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const text = String(page.translated || '');
    const idx = text.toLowerCase().indexOf(q);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 18);
    hits.push({
      page: Number(page.num) || 0,
      snippet: `${start > 0 ? '…' : ''}${text.slice(start, start + 72).replace(/\s+/g, ' ')}…`,
    });
    if (hits.length >= 20) break;
  }
  return hits;
}

export function selectionPopoverActions({ hasSelection = false, hasPaper = false } = {}) {
  const actions = [];
  if (hasSelection) {
    actions.push({ id: 'copy', label: '复制' });
    actions.push({ id: 'translate', label: '译这段' });
    if (hasPaper) actions.push({ id: 'ask', label: '问 Agent' });
  }
  return actions;
}

export function clipSelection(text, max = 800) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trim()}…`;
}

export function mobileAgentStarters() {
  return [
    { id: 'deep-read', label: '一键深读', q: '请对当前论文做一键深读：问题、方法、实验与局限，标明页码。' },
    { id: 'this-page', label: '讲本页', q: '请精讲当前页：在讲什么、关键公式/图表、与全文的联系。' },
    { id: 'method', label: '拆方法', q: '请拆解本文方法，标页码。' },
    { id: 'weakness', label: '找弱点', q: '以审稿人视角列出本文弱点与组会可能被问的问题，标页码。' },
  ];
}

export function askPagePrompt(page = 1) {
  const n = Math.max(1, Math.round(Number(page) || 1));
  return `请精讲第 ${n} 页：本页在讲什么、关键公式/图表、和下文的关系。先用 get_page 或 get_current_page 取证，结论标「第 ${n} 页」。`;
}

export function extractCitedPages(text = '') {
  const out = [];
  const re = /第\s*(\d{1,4})\s*页/g;
  let m;
  const src = String(text || '');
  while ((m = re.exec(src)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && !out.includes(n)) out.push(n);
    if (out.length >= 12) break;
  }
  return out;
}

export function readingAgentFollowUps(page = 1) {
  const n = Math.max(1, Math.round(Number(page) || 1));
  return [
    { label: '再讲细一点', q: `请把刚才关于第 ${n} 页的回答展开，补公式直觉和页码。` },
    { label: '下一页看什么', q: `我刚读完第 ${n} 页，接下来该跳到哪一页？给 3 条可执行建议。` },
    { label: '收入笔记', q: '请把刚才回答压成 5 条笔记要点（带页码）。' },
  ];
}

export function buildMobilePaperProvider(snapshot = {}) {
  const pages = Array.isArray(snapshot.pages) ? snapshot.pages : [];
  const title = snapshot.title || '（未打开论文）';
  const currentPage = Math.max(1, Number(snapshot.currentPage) || 1);
  const byNum = (n) => pages.find((p) => Number(p.num) === Number(n));
  const pageText = (p) => {
    if (!p) return '';
    if (p.translated) return p.translated;
    if (p.sourceText) return `[未译·原文]\n${p.sourceText}`;
    return '（本页尚无文本）';
  };
  return {
    getPaperMeta() {
      return {
        title,
        totalPages: pages.length,
        translatedCount: pages.filter((p) => p.translated).length,
        currentPage,
      };
    },
    getCurrentPage() {
      const p = byNum(currentPage);
      return {
        page: currentPage,
        text: pageText(p),
        status: p?.translated ? '已译' : '未译',
        sourceType: p?.translated ? 'translation' : 'source',
      };
    },
    getPage(n) {
      const p = byNum(n);
      return {
        page: Number(n) || 0,
        text: pageText(p),
        status: p?.translated ? '已译' : '未译',
        sourceType: p?.translated ? 'translation' : 'source',
      };
    },
    listPages() {
      return {
        pages: pages.map((p) => ({
          page: p.num,
          status: p.translated ? '已译' : (p.started ? '翻译中' : '未译'),
          preview: String(p.translated || p.sourceText || '').slice(0, 80),
        })),
      };
    },
    searchPaper(query) {
      return {
        matches: searchTranslationHits(pages, query).map((h) => ({
          page: h.page,
          snippet: h.snippet,
          sourceType: 'translation',
        })),
      };
    },
  };
}

export function parseArxivId(text = '') {
  const s = String(text || '').trim();
  const m = s.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)|arXiv:(\d{4}\.\d{4,5}(?:v\d+)?)|(?:^|\s)(\d{4}\.\d{4,5}(?:v\d+)?)(?:\s|$)/i);
  return (m && (m[1] || m[2] || m[3])) || '';
}

export function arxivPdfUrl(id = '') {
  const clean = String(id || '').replace(/v\d+$/i, '');
  return clean ? `https://export.arxiv.org/pdf/${clean}.pdf` : '';
}

export function arxivAbsUrl(id = '') {
  const clean = String(id || '').replace(/v\d+$/i, '');
  return clean ? `https://arxiv.org/abs/${clean}` : '';
}

export function parseArxivAtomXml(xml = '') {
  const src = String(xml || '');
  const entries = [];
  const chunks = src.split(/<entry>/i).slice(1);
  for (const chunk of chunks) {
    const grab = (tag) => {
      const hit = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return hit ? hit[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    };
    const id = grab('id');
    const arxivId = (id.match(/abs\/([^<\s]+)/) || [])[1] || '';
    const title = grab('title');
    if (!title) continue;
    entries.push({
      arxivId,
      title,
      summary: grab('summary').slice(0, 400),
      published: grab('published').slice(0, 10),
      pdfUrl: arxivId ? arxivPdfUrl(arxivId) : '',
    });
  }
  return entries;
}

export function upsertLibraryEntry(entries = [], next = {}) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const id = String(next.id || next.title || Date.now());
  const item = {
    id,
    title: String(next.title || '未命名论文').slice(0, 160),
    lastPage: Number(next.lastPage) || 1,
    totalPages: Number(next.totalPages) || 0,
    translatedCount: Number(next.translatedCount) || 0,
    updatedAt: Number(next.updatedAt) || Date.now(),
  };
  const idx = list.findIndex((e) => e.id === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  return list.slice(0, 40);
}

export function toggleLibraryStar(entries = [], id = '') {
  return (Array.isArray(entries) ? entries : []).map((e) => (
    e.id === id ? { ...e, starred: !e.starred } : e
  ));
}

export function removeLibraryEntry(entries = [], id = '') {
  return (Array.isArray(entries) ? entries : []).filter((e) => e.id !== id);
}

export function scoreMobileRadarPaper(paper = {}, keywords = []) {
  const title = String(paper.title || '').toLowerCase();
  const summary = String(paper.summary || '').toLowerCase();
  let score = 8;
  const reasons = [];
  for (const raw of keywords) {
    const kw = String(raw || '').trim().toLowerCase();
    if (!kw) continue;
    if (title.includes(kw)) { score += 8; reasons.push(`标题含「${raw}」`); }
    else if (summary.includes(kw)) { score += 3; reasons.push(`摘要含「${raw}」`); }
  }
  return { ...paper, score, reasons };
}

export function sortRadarByScore(papers = []) {
  return [...(Array.isArray(papers) ? papers : [])].sort((a, b) => (b.score || 0) - (a.score || 0));
}

export function buildArxivQueryUrl(keywords = []) {
  const first = String(keywords[0] || '').trim();
  const q = first ? `all:${encodeURIComponent(first)}` : 'cat:cs.LG';
  return `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=16`;
}

export function radarProxyUrls(arxivUrl = '') {
  const raw = String(arxivUrl || '');
  if (!raw) return [];
  return [
    raw,
    `https://corsproxy.io/?${encodeURIComponent(raw)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(raw)}`,
  ];
}

export function parseOpenAlexWorks(data = {}) {
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((w) => {
    const loc = w.primary_location || {};
    const src = loc.source || {};
    const arxivId = String(w.ids?.arxiv || '').replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
      || String(loc.landing_page_url || '').match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i)?.[1]
      || '';
    return {
      arxivId,
      title: String(w.display_name || w.title || '').replace(/\s+/g, ' ').trim(),
      summary: String(w.abstract_inverted_index
        ? Object.entries(w.abstract_inverted_index)
          .flatMap(([word, idx]) => (idx || []).map((i) => ({ word, i })))
          .sort((a, b) => a.i - b.i)
          .map((x) => x.word)
          .join(' ')
        : (w.abstract || '')).slice(0, 400),
      published: String(w.publication_date || w.publication_year || '').slice(0, 10),
      pdfUrl: arxivId ? arxivPdfUrl(arxivId) : String(loc.pdf_url || ''),
      landingUrl: arxivId ? arxivAbsUrl(arxivId) : String(loc.landing_page_url || w.ids?.openalex || ''),
    };
  }).filter((p) => p.title);
}

export function parseKeywordList(raw = '') {
  return String(raw || '')
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function extractCopyableLatex(text = '') {
  const s = String(text || '');
  const fence = s.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const sec = s.match(/\\section\{[\s\S]{20,}/);
  return sec ? sec[0].trim() : s.trim();
}

export function upsertDraft(drafts = [], next = {}) {
  const list = Array.isArray(drafts) ? [...drafts] : [];
  const id = String(next.id || `d${Date.now()}`);
  const item = {
    id,
    title: String(next.title || '未命名草稿').slice(0, 120),
    kind: String(next.kind || 'general'),
    body: String(next.body || ''),
    updatedAt: Number(next.updatedAt) || Date.now(),
  };
  const idx = list.findIndex((d) => d.id === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  return list.slice(0, 30);
}

export function extractBootstrapBrief(provider = {}) {
  try {
    const meta = provider.getPaperMeta?.() || {};
    const cur = provider.getCurrentPage?.() || {};
    const listed = provider.listPages?.() || { pages: [] };
    const n = Array.isArray(listed.pages) ? listed.pages.length : 0;
    return [
      `标题：${meta.title || '（未知）'}`,
      `总页数：${meta.totalPages ?? n}`,
      `已译：${meta.translatedCount ?? 0}`,
      `当前页：${cur.page || meta.currentPage || 1}`,
    ].join('\n');
  } catch {
    return '当前打开的论文。';
  }
}
