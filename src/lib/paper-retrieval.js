// PaperLens local evidence retrieval.
//
// The browser already owns both the translated Markdown and PDF.js source text,
// so evidence retrieval must be local, deterministic and free of extra API
// round-trips.  The index deliberately supports Chinese character n-grams,
// English word variants, acronyms, numbers and common mathematical identifiers.

export const PAPER_RETRIEVAL_VERSION = 'bm25-evidence-v1';
export const PAPER_CHUNK_MAX_CHARS = 1200;
export const PAPER_CHUNK_OVERLAP_CHARS = 180;
export const PAPER_EVIDENCE_MAX_PAGES = 6;

const LATIN_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'our',
  'that', 'the', 'their', 'these', 'this', 'those', 'to', 'using', 'was',
  'we', 'were', 'with', 'without', 'which', 'can', 'may', 'than', 'then',
]);

const CJK_STOP_WORDS = new Set([
  '一个', '一种', '以及', '对于', '本文', '我们', '这个', '这些', '其中',
  '通过', '可以', '进行', '使用', '提出', '基于', '方法', '结果', '为了',
]);

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v\u00a0]+/gu, ' ')
    .replace(/[ ]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function normalizePaperSearchText(value) {
  let text = normalizeWhitespace(value);
  try { text = text.normalize('NFKC'); } catch { /* older browser */ }
  return text.toLocaleLowerCase('en-US');
}

function latinStem(token) {
  const value = String(token || '').toLowerCase();
  if (value.length <= 4) return value;
  if (/ies$/u.test(value) && value.length > 5) return `${value.slice(0, -3)}y`;
  if (/ing$/u.test(value) && value.length > 6) return value.slice(0, -3);
  if (/ed$/u.test(value) && value.length > 5) return value.slice(0, -2);
  if (/es$/u.test(value) && value.length > 5) return value.slice(0, -2);
  if (/s$/u.test(value) && !/ss$/u.test(value) && value.length > 4) return value.slice(0, -1);
  return value;
}

/** Tokenize Chinese, English and formula-adjacent identifiers for local search. */
export function tokenizePaperText(value, { query = false } = {}) {
  const text = normalizePaperSearchText(value);
  const tokens = [];

  for (const match of text.matchAll(/[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*|\d+(?:\.\d+)?/gu)) {
    const token = match[0];
    if (token.length === 1 && !/\d/u.test(token)) continue;
    if (!LATIN_STOP_WORDS.has(token)) tokens.push(token);
    const stem = latinStem(token);
    if (stem && stem !== token && !LATIN_STOP_WORDS.has(stem)) tokens.push(stem);
  }

  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const run = match[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    // Full query phrases give exact Chinese terms extra weight without making
    // every long document sentence a unique token.
    if ((query || run.length <= 6) && run.length <= 12 && !CJK_STOP_WORDS.has(run)) {
      tokens.push(run);
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_STOP_WORDS.has(bigram)) tokens.push(bigram);
    }
    if (query && run.length >= 3) {
      for (let i = 0; i < run.length - 2; i += 1) tokens.push(run.slice(i, i + 3));
    }
  }

  return tokens;
}

function sourceTypeOf(page = {}) {
  const explicit = String(page.sourceType || page.source || '').toLowerCase();
  if (explicit === 'translation' || explicit === 'translated') return 'translation';
  if (explicit === 'source' || explicit === 'original') return 'source';
  return /^\s*\[未译[·・]原文\]/u.test(String(page.text || '')) ? 'source' : 'translation';
}

function pageTextOf(page = {}) {
  return normalizeWhitespace(page.text || page.content || page.preview || '');
}

function splitLongParagraph(paragraph, maxChars, overlapChars) {
  const parts = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(paragraph.length, start + maxChars);
    if (end < paragraph.length) {
      const floor = Math.max(start + Math.floor(maxChars * 0.62), end - 220);
      const boundary = Math.max(
        paragraph.lastIndexOf('。', end),
        paragraph.lastIndexOf('！', end),
        paragraph.lastIndexOf('？', end),
        paragraph.lastIndexOf('. ', end),
        paragraph.lastIndexOf('; ', end),
      );
      if (boundary >= floor) end = boundary + 1;
    }
    parts.push(paragraph.slice(start, end).trim());
    if (end >= paragraph.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return parts.filter(Boolean);
}

/** Split page text into stable, page-addressable retrieval chunks. */
export function chunkPaperPages(pages = [], {
  maxChars = PAPER_CHUNK_MAX_CHARS,
  overlapChars = PAPER_CHUNK_OVERLAP_CHARS,
} = {}) {
  const chunks = [];
  const safeMax = Math.max(240, Number(maxChars) || PAPER_CHUNK_MAX_CHARS);
  const safeOverlap = Math.max(0, Math.min(safeMax - 80, Number(overlapChars) || 0));

  for (const rawPage of Array.isArray(pages) ? pages : []) {
    const page = Number(rawPage?.page ?? rawPage?.num);
    const text = pageTextOf(rawPage);
    if (!Number.isFinite(page) || page < 1 || !text) continue;
    const sourceType = sourceTypeOf(rawPage);
    const heading = normalizeWhitespace(rawPage.heading || rawPage.title || '');
    const paragraphs = text.split(/\n\s*\n|(?=^#{1,4}\s+)/gmu).map((item) => item.trim()).filter(Boolean);
    let buffer = '';
    let index = 0;
    const emit = (value) => {
      const clean = normalizeWhitespace(value);
      if (!clean) return;
      chunks.push({
        id: `p${page}-c${index}`,
        page,
        chunk: index,
        text: clean,
        heading: /^#{1,4}\s+(.+)/mu.exec(clean)?.[1]?.trim() || heading,
        sourceType,
        status: String(rawPage.status || ''),
      });
      index += 1;
    };

    for (const paragraph of paragraphs.length ? paragraphs : [text]) {
      if (paragraph.length > safeMax) {
        if (buffer) { emit(buffer); buffer = ''; }
        for (const part of splitLongParagraph(paragraph, safeMax, safeOverlap)) emit(part);
        continue;
      }
      const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (next.length <= safeMax) {
        buffer = next;
      } else {
        emit(buffer);
        const tail = safeOverlap > 0 ? buffer.slice(-safeOverlap) : '';
        buffer = tail ? `${tail}\n\n${paragraph}` : paragraph;
        if (buffer.length > safeMax) {
          for (const part of splitLongParagraph(buffer, safeMax, safeOverlap)) emit(part);
          buffer = '';
        }
      }
    }
    if (buffer) emit(buffer);
  }
  return chunks;
}

function termFrequency(tokens) {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return frequencies;
}

/** Build a compact BM25 index. Rebuilds are cheap for ordinary papers. */
export function createPaperSearchIndex(pages = [], options = {}) {
  const chunks = chunkPaperPages(pages, options).map((chunk) => {
    const tokens = tokenizePaperText(chunk.text);
    return { ...chunk, tokens, termFrequency: termFrequency(tokens), length: Math.max(1, tokens.length) };
  });
  const documentFrequency = new Map();
  for (const chunk of chunks) {
    for (const token of new Set(chunk.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    version: PAPER_RETRIEVAL_VERSION,
    chunks,
    documentFrequency,
    averageLength: chunks.length ? totalLength / chunks.length : 1,
    totalPages: Math.max(0, ...chunks.map((chunk) => chunk.page)),
  };
}

function bm25Score(index, chunk, queryTokens, { k1 = 1.35, b = 0.72 } = {}) {
  const n = Math.max(1, index.chunks.length);
  const avg = Math.max(1, index.averageLength || 1);
  let score = 0;
  for (const token of queryTokens) {
    const tf = chunk.termFrequency.get(token) || 0;
    if (!tf) continue;
    const df = index.documentFrequency.get(token) || 0;
    const idf = Math.log(1 + ((n - df + 0.5) / (df + 0.5)));
    const denominator = tf + k1 * (1 - b + b * (chunk.length / avg));
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

function snippetForResult(text, query, queryTokens, maxChars = 520) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean;
  const lower = normalizePaperSearchText(clean);
  const phrase = normalizePaperSearchText(query).trim();
  let index = phrase.length >= 2 ? lower.indexOf(phrase) : -1;
  if (index < 0) {
    for (const token of queryTokens.sort((a, b) => b.length - a.length)) {
      index = lower.indexOf(token);
      if (index >= 0) break;
    }
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - Math.floor(maxChars * 0.28));
  const end = Math.min(clean.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}

/** Retrieve page-deduplicated, provenance-labelled evidence. */
export function retrievePaperEvidence(indexOrPages, query, {
  currentPage = null,
  maxPages = PAPER_EVIDENCE_MAX_PAGES,
  minScore = 0.05,
} = {}) {
  const index = indexOrPages?.chunks && indexOrPages?.documentFrequency
    ? indexOrPages
    : createPaperSearchIndex(indexOrPages);
  const cleanQuery = normalizeWhitespace(query);
  const queryTokens = [...new Set(tokenizePaperText(cleanQuery, { query: true }))];
  if (!cleanQuery || !queryTokens.length || !index.chunks.length) return [];
  const queryNorm = normalizePaperSearchText(cleanQuery);
  const page = Number(currentPage);

  const ranked = index.chunks.map((chunk) => {
    let score = bm25Score(index, chunk, queryTokens);
    const textNorm = normalizePaperSearchText(chunk.text);
    const headingNorm = normalizePaperSearchText(chunk.heading);
    if (queryNorm.length >= 2 && textNorm.includes(queryNorm)) score += 4.5;
    if (queryNorm.length >= 2 && headingNorm.includes(queryNorm)) score += 2.5;
    if (Number.isFinite(page) && chunk.page === page) score += 0.85;
    if (chunk.sourceType === 'translation') score += 0.12;
    const matchedTokens = queryTokens.filter((token) => chunk.termFrequency.has(token));
    const termCoverage = matchedTokens.length / Math.max(1, queryTokens.length);
    score += termCoverage * 1.4;
    return { ...chunk, score, termCoverage, matchedTokens };
  }).filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score || b.termCoverage - a.termCoverage || a.page - b.page);

  const results = [];
  const seenPages = new Set();
  for (const item of ranked) {
    if (seenPages.has(item.page)) continue;
    seenPages.add(item.page);
    results.push({
      page: item.page,
      score: Number(item.score.toFixed(4)),
      termCoverage: Number(item.termCoverage.toFixed(3)),
      sourceType: item.sourceType,
      status: item.status,
      heading: item.heading,
      snippet: snippetForResult(item.text, cleanQuery, item.matchedTokens),
      chunkId: item.id,
    });
    if (results.length >= Math.max(1, Number(maxPages) || PAPER_EVIDENCE_MAX_PAGES)) break;
  }
  return results;
}

/** Add immediately adjacent pages only when they contain usable text. */
export function expandEvidenceWithNeighbors(results = [], pages = [], { radius = 1, maxPages = 8 } = {}) {
  const pageMap = new Map((Array.isArray(pages) ? pages : []).map((page) => [
    Number(page?.page ?? page?.num), page,
  ]));
  const merged = [];
  const seen = new Set();
  const push = (item) => {
    const page = Number(item?.page);
    if (!Number.isFinite(page) || page < 1 || seen.has(page)) return;
    seen.add(page);
    merged.push(item);
  };
  for (const result of Array.isArray(results) ? results : []) {
    push(result);
    for (let delta = 1; delta <= Math.max(0, Number(radius) || 0); delta += 1) {
      for (const neighborPage of [Number(result.page) - delta, Number(result.page) + delta]) {
        const raw = pageMap.get(neighborPage);
        const text = pageTextOf(raw);
        if (!text) continue;
        push({
          page: neighborPage,
          score: Math.max(0, Number(result.score || 0) * 0.34),
          termCoverage: 0,
          sourceType: sourceTypeOf(raw),
          status: String(raw?.status || ''),
          heading: normalizeWhitespace(raw?.heading || raw?.title || ''),
          snippet: snippetForResult(text, '', [], 420),
          chunkId: `p${neighborPage}-neighbor`,
          neighborOf: Number(result.page),
        });
      }
    }
  }
  return merged.slice(0, Math.max(1, Number(maxPages) || 8));
}

export function buildEvidencePack(results = [], { query = '', maxChars = 7200 } = {}) {
  const safe = (Array.isArray(results) ? results : []).filter((item) => Number(item?.page) >= 1);
  const pages = [...new Set(safe.map((item) => Number(item.page)))];
  const sourceTypes = [...new Set(safe.map((item) => item.sourceType === 'source' ? 'source' : 'translation'))];
  const lines = [
    '### 与问题最相关的本地证据（已在发送前检索，不消耗额外模型请求）',
    query ? `检索问题：${normalizeWhitespace(query).slice(0, 500)}` : '',
    '只允许把下列页或后续工具实际返回的页作为论文证据；不要把猜测写成论文结论。',
    '',
  ].filter((line, index) => line || index > 2);
  safe.forEach((item, index) => {
    const provenance = item.sourceType === 'source' ? 'PDF 原文' : '译文';
    const related = Number.isFinite(Number(item.score)) ? ` · 相关度 ${Number(item.score).toFixed(2)}` : '';
    lines.push(`#### E${index + 1} · 第 ${item.page} 页 · ${provenance}${related}`);
    if (item.heading) lines.push(`章节线索：${item.heading}`);
    lines.push(String(item.snippet || '').trim() || '（无可用片段）', '');
  });
  const full = lines.join('\n').trim();
  return {
    text: full.length <= maxChars ? full : `${full.slice(0, Math.max(200, maxChars))}\n…（证据包已截断）`,
    pages,
    sourceTypes,
    evidenceCount: safe.length,
  };
}

export function extractPageCitations(text) {
  const pages = [];
  const source = String(text || '');
  for (const match of source.matchAll(/第\s*(\d{1,5})\s*页/gu)) {
    const page = Number(match[1]);
    if (Number.isFinite(page)) pages.push(page);
  }
  return [...new Set(pages)];
}

/** Validate answer page references against the open document and consulted evidence. */
export function auditAnswerCitations(answer, {
  totalPages = 0,
  evidencePages = [],
  consultedPages = [],
} = {}) {
  const citedPages = extractPageCitations(answer);
  const total = Math.max(0, Number(totalPages) || 0);
  const allowed = new Set([...evidencePages, ...consultedPages].map(Number).filter((page) => page >= 1));
  const invalidPages = citedPages.filter((page) => page < 1 || (total > 0 && page > total));
  const unsupportedPages = citedPages.filter((page) => !invalidPages.includes(page) && allowed.size > 0 && !allowed.has(page));
  const supportedPages = citedPages.filter((page) => !invalidPages.includes(page) && !unsupportedPages.includes(page));
  const coverage = citedPages.length ? supportedPages.length / citedPages.length : 0;
  return {
    ok: invalidPages.length === 0 && unsupportedPages.length === 0 && citedPages.length > 0,
    citedPages,
    supportedPages,
    invalidPages,
    unsupportedPages,
    evidencePages: [...allowed].sort((a, b) => a - b),
    coverage: Number(coverage.toFixed(3)),
    hasCitations: citedPages.length > 0,
  };
}

/** Keep evidence snippets small and safe for UI/history/system-context reuse. */
export function normalizeEvidenceItems(items = [], { maxItems = 8, snippetChars = 520 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const page = Number(raw?.page);
    const snippet = normalizeWhitespace(raw?.snippet || raw?.text || '');
    if (!Number.isFinite(page) || page < 1 || !snippet) continue;
    const key = `${page}:${snippet.slice(0, 80).toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = Number(raw?.score);
    const termCoverage = Number(raw?.termCoverage);
    out.push({
      page,
      sourceType: raw?.sourceType === 'source' ? 'source' : 'translation',
      snippet: snippet.slice(0, Math.max(120, Number(snippetChars) || 520)),
      heading: normalizeWhitespace(raw?.heading || '').slice(0, 120),
      score: Number.isFinite(score) ? Number(Math.max(0, score).toFixed(3)) : 0,
      termCoverage: Number.isFinite(termCoverage)
        ? Number(Math.max(0, Math.min(1, termCoverage)).toFixed(3))
        : 0,
      neighborOf: Number.isFinite(Number(raw?.neighborOf)) ? Number(raw.neighborOf) : null,
    });
    if (out.length >= Math.max(1, Number(maxItems) || 8)) break;
  }
  return out;
}

/**
 * Deterministic evidence-support indicator. This is deliberately named
 * "support" rather than "truth confidence": it measures traceability only.
 */
export function scoreEvidenceSupport({ audit = {}, items = [] } = {}) {
  const normalized = normalizeEvidenceItems(items);
  const uniquePages = new Set(normalized.map((item) => item.page)).size;
  const coverage = Math.max(0, Math.min(1, Number(audit?.coverage) || 0));
  const cited = Array.isArray(audit?.citedPages) ? audit.citedPages.length : 0;
  const invalid = Array.isArray(audit?.invalidPages) ? audit.invalidPages.length : 0;
  const unsupported = Array.isArray(audit?.unsupportedPages) ? audit.unsupportedPages.length : 0;
  const averageTermCoverage = normalized.length
    ? normalized.reduce((sum, item) => sum + item.termCoverage, 0) / normalized.length
    : 0;
  const averageScore = normalized.length
    ? normalized.reduce((sum, item) => sum + item.score, 0) / normalized.length
    : 0;
  const relevance = Math.min(1, (averageTermCoverage * 0.65) + ((1 - Math.exp(-averageScore / 4)) * 0.35));
  const diversity = Math.min(1, uniquePages / 4);
  const citationPresence = cited > 0 ? 1 : 0;
  const penalty = Math.min(0.85, (invalid * 0.35) + (unsupported * 0.2));
  const raw = (coverage * 0.48) + (citationPresence * 0.16) + (relevance * 0.22) + (diversity * 0.14) - penalty;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);
  const level = score >= 78 ? 'strong' : score >= 48 ? 'moderate' : 'weak';
  const label = level === 'strong' ? '证据支持强' : level === 'moderate' ? '证据支持中等' : '证据支持较弱';
  const reasons = [];
  if (!cited) reasons.push('回答未标注页码');
  if (invalid) reasons.push(`${invalid} 个页码超出文档`);
  if (unsupported) reasons.push(`${unsupported} 个页码未在证据中查阅`);
  if (uniquePages < 2) reasons.push('证据页较少');
  if (coverage === 1 && cited > 0) reasons.push('引用页均已查阅');
  return {
    score,
    level,
    label,
    reasons,
    evidenceCount: normalized.length,
    uniquePages,
  };
}

/** Rehydrate prior evidence snippets for follow-ups without treating old prose as fact. */
export function buildPriorEvidenceBrief(history = [], { maxItems = 5, maxChars = 3200 } = {}) {
  const candidates = [];
  const entries = (Array.isArray(history) ? history : []).slice().reverse();
  for (const entry of entries) {
    if (entry?.role !== 'assistant' || !entry?.evidence) continue;
    candidates.push(...normalizeEvidenceItems(entry.evidence.items || [], { maxItems }));
    if (candidates.length >= maxItems) break;
  }
  const items = normalizeEvidenceItems(candidates, { maxItems });
  if (!items.length) return { text: '', pages: [], items: [] };
  const lines = [
    '### 上轮已查阅证据（用于理解追问；必要时重新调用工具核对）',
    '这些是此前实际检索到的论文片段，不要把助手此前的结论本身当作论文证据。',
  ];
  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. 第 ${item.page} 页 · ${item.sourceType === 'source' ? 'PDF 原文' : '译文'}${item.heading ? ` · ${item.heading}` : ''}`,
      item.snippet,
    );
  });
  const text = lines.join('\n').slice(0, Math.max(400, Number(maxChars) || 3200));
  return { text, pages: [...new Set(items.map((item) => item.page))], items };
}

/**
 * Deterministically compact older research turns while preserving page refs and
 * the recent verbatim dialogue. This avoids asking the model to summarize its
 * own history (and therefore adds no latency or cost).
 */
export function compactResearchDialogue(turns = [], {
  maxTurns = 28,
  recentTurns = 14,
  digestEntryChars = 260,
} = {}) {
  const list = (Array.isArray(turns) ? turns : []).filter((turn) => (
    (turn?.role === 'user' || turn?.role === 'assistant') && String(turn?.content || '').trim()
  ));
  if (list.length <= maxTurns) return list.map((turn) => ({ ...turn }));
  const keep = Math.max(4, Math.min(Number(recentTurns) || 14, maxTurns - 1));
  const older = list.slice(0, -keep);
  const recent = list.slice(-keep).map((turn) => ({ ...turn }));
  const digest = older.map((turn, index) => {
    const clean = normalizeWhitespace(turn.content);
    const refs = extractPageCitations(clean);
    const suffix = refs.length ? ` [涉及页：${refs.join('、')}]` : '';
    return `${index + 1}. ${turn.role === 'user' ? '用户' : '助手'}：${clean.slice(0, digestEntryChars)}${clean.length > digestEntryChars ? '…' : ''}${suffix}`;
  }).join('\n');
  return [{
    role: 'user',
    content: `【较早对话的本地压缩记录；不要把它当作论文证据】\n${digest}`,
  }, ...recent];
}
