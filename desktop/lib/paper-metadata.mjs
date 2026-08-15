// 论文元数据启发式提取（纯函数）：从 PDF 首页文本猜标题 / 作者 / 年份 / arXiv id。
// 不调模型 —— 打开即得、可测；猜错时用户可在文库里手动改。

/** 从文本抽 arXiv id（页眉水印 arXiv:2203.15386v2 或裸 id）。 */
export function extractArxivId(text) {
  const m = String(text || '').match(/arXiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?/i);
  return m ? m[1] + (m[2] || '') : '';
}

/** 从文本抽年份（1990-2039 的四位数，优先出现在前 600 字符的）。 */
export function extractYear(text) {
  const head = String(text || '').slice(0, 600);
  for (const source of [head, String(text || '')]) {
    const m = source.match(/\b(19[9]\d|20[0-3]\d)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * 从首页行序列猜标题：
 * 取 Abstract/Introduction 之前、长度 20–200、既非页眉（期刊名/DOI/arXiv 水印）
 * 又非作者行（含逗号分隔的多个大写开头词 + 上标数字模式弱）的**最长**候选行。
 * lines 传 PDF textLayer 行数组（或粗分段），纯函数。
 */
export function guessTitleFromLines(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((l) => String(l || '').replace(/\s+/g, ' ').trim());
  const stopAt = list.findIndex((l) => /^(abstract|摘要|index terms|1\.?\s+introduction)\b/i.test(l));
  const head = (stopAt > 0 ? list.slice(0, stopAt) : list.slice(0, 12)).filter(Boolean);
  const headerLike = /^(arxiv:|doi:|https?:|issn|isbn|vol\.|no\.|pp\.|proceedings of|journal of|transactions on|ieee|acm|springer|elsevier|preprint|submitted|accepted|published|received|copyright|©|\d+$)/i;
  const authorLike = (l) => {
    const commaParts = l.split(',').map((p) => p.trim()).filter(Boolean);
    if (commaParts.length >= 3 && commaParts.every((p) => /^[A-Z][A-Za-z.\- ]{1,30}$/.test(p))) return true;
    return /\b(university|institute|department|laborator|school of|@)\b/i.test(l);
  };
  let best = '';
  for (const line of head) {
    if (line.length < 20 || line.length > 200) continue;
    if (headerLike.test(line)) continue;
    if (authorLike(line)) continue;
    if (!/[a-zA-Z一-鿿]{4,}/.test(line)) continue;
    if (line.length > best.length) best = line;
  }
  return best;
}

/** 首页整段文本 → 行数组（按明显换行/句号密度粗分；给没有行结构的调用方兜底）。 */
export function linesFromPageText(text) {
  return String(text || '')
    .split(/\n+/)
    .flatMap((chunk) => (chunk.length > 240 ? chunk.split(/(?<=[.!?。])\s{2,}/) : [chunk]))
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 组合入口：{ title, arxivId, year }。lines 可选（有 textLayer 行时更准）。 */
export function extractPaperMetadata({ firstPageText = '', lines = null, fallbackName = '' } = {}) {
  const arxivId = extractArxivId(firstPageText);
  const year = extractYear(firstPageText);
  const title = guessTitleFromLines(lines || linesFromPageText(firstPageText))
    || String(fallbackName || '').replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  return { title, arxivId, year };
}
