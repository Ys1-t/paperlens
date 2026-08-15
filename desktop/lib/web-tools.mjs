// 联网研究工具：arXiv 检索、Semantic Scholar 引用查询、网页正文抓取。
// 跑在 Electron 主进程 / Node（无 CORS 限制）。fetch 可注入便于测试。
// 这是扩展内 agent 做不到的能力面：查「文献 [5] 在讲什么」直接命中原论文。

const UA = 'PaperLens-Desktop/0.1 (research reading assistant)';

function textBetween(source, open, close) {
  const out = [];
  let index = 0;
  for (;;) {
    const start = source.indexOf(open, index);
    if (start < 0) break;
    const end = source.indexOf(close, start + open.length);
    if (end < 0) break;
    out.push(source.slice(start + open.length, end));
    index = end + close.length;
  }
  return out;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 arXiv Atom feed（纯函数，可测）。 */
export function parseArxivAtom(xml) {
  return textBetween(String(xml || ''), '<entry>', '</entry>').map((entry) => {
    const id = decodeXml(textBetween(entry, '<id>', '</id>')[0] || '');
    const title = decodeXml(textBetween(entry, '<title>', '</title>')[0] || '');
    const summary = decodeXml(textBetween(entry, '<summary>', '</summary>')[0] || '').slice(0, 1200);
    const published = decodeXml(textBetween(entry, '<published>', '</published>')[0] || '').slice(0, 10);
    const authors = textBetween(entry, '<name>', '</name>').map(decodeXml).slice(0, 12);
    const arxivId = (id.match(/abs\/([^v]+(?:v\d+)?)/) || [])[1] || '';
    // category term="cs.LG" …
    const categories = [...entry.matchAll(/term="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    const primaryCategory = categories[0] || '';
    return {
      arxivId,
      title,
      authors,
      published,
      summary,
      categories,
      primaryCategory,
      pdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}` : '',
    };
  }).filter((item) => item.title);
}

/** arXiv 全文库检索（标题/摘要/作者）。 */
export async function searchArxiv(query, { maxResults = 5, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 不能为空');
  const url = 'https://export.arxiv.org/api/query?search_query='
    + encodeURIComponent(`all:${q}`)
    + `&max_results=${Math.min(10, Math.max(1, maxResults))}&sortBy=relevance`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`arXiv 检索失败：HTTP ${response.status}`);
  return parseArxivAtom(await response.text());
}

/** 规整 Semantic Scholar 论文响应（纯函数，可测）。 */
export function shapeSemanticScholarPaper(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    title: String(data.title || ''),
    year: Number(data.year) || null,
    authors: (data.authors || []).map((a) => String(a?.name || '')).filter(Boolean).slice(0, 12),
    venue: String(data.venue || data.publicationVenue?.name || ''),
    abstract: String(data.abstract || '').slice(0, 1600),
    citationCount: Number(data.citationCount) || 0,
    tldr: String(data.tldr?.text || '').slice(0, 500),
    openAccessPdf: String(data.openAccessPdf?.url || ''),
    url: String(data.url || ''),
  };
}

const S2_FIELDS = 'title,year,authors,venue,publicationVenue,abstract,citationCount,tldr,openAccessPdf,url';

/**
 * 按标题（或 arXiv id / DOI）查一篇具体文献的权威信息。
 * 用途：论文里的引用条目 [5] → 原文标题 → 这篇文献本身在讲什么。
 */
export async function lookupCitation(reference, { fetchImpl = fetch } = {}) {
  const ref = String(reference || '').trim();
  if (!ref) throw new Error('reference 不能为空');
  const direct = ref.match(/(?:arxiv[:/]|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})/i)?.[1]
    || ref.match(/\b(10\.\d{4,9}\/\S+)\b/)?.[1];
  const url = direct
    ? `https://api.semanticscholar.org/graph/v1/paper/${direct.startsWith('10.') ? `DOI:${direct}` : `arXiv:${direct}`}?fields=${S2_FIELDS}`
    : `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(ref)}&fields=${S2_FIELDS}`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Semantic Scholar 查询失败：HTTP ${response.status}`);
  const data = await response.json();
  return shapeSemanticScholarPaper(direct ? data : (data?.data?.[0] || null));
}

/** 粗排 HTML → 可读正文（纯函数，可测）。 */
export function htmlToReadableText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside)[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ')
    .replace(/<br\s*\/?>(?=\S)/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 抓取网页正文（限长；仅 http/https）。 */
export async function fetchUrlText(url, { maxChars = 8000, fetchImpl = fetch } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 链接');
  const response = await fetchImpl(target, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`);
  const type = String(response.headers.get?.('content-type') || '');
  if (/pdf/i.test(type)) return `（这是 PDF 链接，请用 arXiv/S2 工具取摘要，或提示用户在阅读器打开）${target}`;
  const text = htmlToReadableText(await response.text());
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(已截断)` : text;
}
