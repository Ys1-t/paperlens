// 证据抽取与回答后处理：从 Agent 回答中识别页码引用，供 UI 生成可点击证据卡。

const PAGE_PATTERNS = [
  /第\s*(\d{1,4})\s*页/g,
  /\b[Pp]ages?\s*(\d{1,4})\b/g,
  /\bp\.\s*(\d{1,4})\b/g,
  /（\s*(\d{1,4})\s*页\s*）/g,
  /\(\s*p\.?\s*(\d{1,4})\s*\)/gi,
];

/**
 * 从文本中提取页码（1-based），去重排序。
 * @param {string} text
 * @param {{ maxPage?: number }} [opts]
 * @returns {number[]}
 */
export function extractPageCitations(text, { maxPage = 0 } = {}) {
  const raw = String(text || '');
  const found = new Set();
  for (const re of PAGE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 1) continue;
      if (maxPage > 0 && n > maxPage) continue;
      found.add(Math.round(n));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * 从工具 trace 收集读过的页。
 * @param {Array<{ name?: string, args?: object, ok?: boolean }>} trace
 */
export function pagesFromTrace(trace) {
  const pages = new Set();
  for (const step of Array.isArray(trace) ? trace : []) {
    if (!step?.ok) continue;
    if (step.name === 'read_paper_page' && step.args?.page) {
      pages.add(Math.round(Number(step.args.page)));
    }
    if (step.name === 'read_paper_pages') {
      const a = Math.round(Number(step.args?.from) || 0);
      const b = Math.round(Number(step.args?.to) || 0);
      if (a >= 1 && b >= a) {
        for (let p = a; p <= Math.min(b, a + 5); p += 1) pages.add(p);
      }
    }
    if (step.name === 'search_paper_text' && Array.isArray(step.resultPages)) {
      for (const p of step.resultPages) pages.add(Math.round(Number(p)));
    }
  }
  return [...pages].filter((n) => n >= 1).sort((a, b) => a - b);
}

/**
 * 合并回答页码 + trace 页码，生成证据卡模型。
 */
export function buildEvidenceModel({ answer = '', trace = [], maxPage = 0 } = {}) {
  const fromAnswer = extractPageCitations(answer, { maxPage });
  const fromTrace = pagesFromTrace(trace).filter((p) => !maxPage || p <= maxPage);
  const pages = [...new Set([...fromAnswer, ...fromTrace])].sort((a, b) => a - b);
  return {
    pages,
    fromAnswer,
    fromTrace,
    cards: pages.map((page) => ({
      page,
      label: `第 ${page} 页`,
      source: fromAnswer.includes(page) ? 'answer' : 'tool',
    })),
  };
}

/**
 * 把纯文本里的「第 N 页」换成可点击标记（HTML 安全：先 escape 再替换）。
 * 占位用 data-pl-page，由 UI 绑点击。
 */
export function linkifyPageCitationsInHtml(html, { maxPage = 0 } = {}) {
  let out = String(html || '');
  // 已渲染 HTML 中替换可见中文页码
  out = out.replace(/第\s*(\d{1,4})\s*页/g, (full, num) => {
    const n = Number(num);
    if (!Number.isFinite(n) || n < 1) return full;
    if (maxPage > 0 && n > maxPage) return full;
    return `<button type="button" class="ev-page-link" data-pl-page="${n}" title="跳转到原文第 ${n} 页">第 ${n} 页</button>`;
  });
  return out;
}
