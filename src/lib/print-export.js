// Print-to-PDF helpers: open a print-friendly HTML window (browser Save as PDF).
// Prefer already-rendered page HTML (KaTeX) so formulas match the reader.

export function escapePrintHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip scripts / inline handlers from cloned reader HTML before printing. */
export function sanitizeExportHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, ' $1=$2#$2');
}

/**
 * Resolve extension asset URLs for the print window (KaTeX CSS/fonts).
 * @param {(path: string) => string} [getUrl] defaults to chrome.runtime.getURL
 */
export function getPrintAssetUrls(getUrl = globalThis.chrome?.runtime?.getURL?.bind(globalThis.chrome?.runtime)) {
  if (typeof getUrl !== 'function') return { katexCss: '', katexBase: '' };
  try {
    return {
      katexCss: getUrl('src/vendor/katex/katex.min.css') || '',
      katexBase: getUrl('src/vendor/katex/') || '',
    };
  } catch {
    return { katexCss: '', katexBase: '' };
  }
}

/**
 * Load KaTeX CSS text and rewrite relative font URLs to absolute extension URLs.
 * Prefer inlining so blob: print windows do not depend on cross-origin CSS.
 */
export async function loadPrintAssets({
  getUrl = globalThis.chrome?.runtime?.getURL?.bind(globalThis.chrome?.runtime),
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  const urls = getPrintAssetUrls(getUrl);
  if (!urls.katexCss || typeof fetchImpl !== 'function') {
    return { ...urls, katexCssInline: '' };
  }
  try {
    const response = await fetchImpl(urls.katexCss);
    if (!response?.ok) return { ...urls, katexCssInline: '' };
    let cssText = await response.text();
    const base = urls.katexBase || urls.katexCss.replace(/katex\.min\.css$/i, '');
    // url(fonts/...) and url('fonts/...') → absolute extension path
    cssText = cssText.replace(
      /url\((['"]?)(\.?\.?\/)?fonts\//g,
      `url($1${base}fonts/`,
    );
    return { ...urls, katexCssInline: cssText };
  } catch {
    return { ...urls, katexCssInline: '' };
  }
}

export function buildPrintDocumentHtml({
  title = 'PaperLens 导出',
  subtitle = '',
  sections = [],
  footerNote = '由 PaperLens 导出 · 可在打印对话框中选择「另存为 PDF」',
  assets = {},
  /** Delay before window.print() so KaTeX fonts can load (ms). */
  printDelayMs = 420,
} = {}) {
  const safeTitle = escapePrintHtml(title);
  const safeSubtitle = escapePrintHtml(subtitle);
  const katexCssInline = String(assets?.katexCssInline || '').trim();
  const katexCss = String(assets?.katexCss || '').trim();
  // Prefer inlined CSS (blob windows); fall back to extension stylesheet link.
  const katexStyles = katexCssInline
    ? `<style id="katex-print-css">${katexCssInline.replace(/<\/style/gi, '<\\/style')}</style>`
    : (katexCss
      ? `<link rel="stylesheet" href="${escapePrintHtml(katexCss)}" />`
      : '');

  const body = (Array.isArray(sections) ? sections : []).map((section) => {
    const heading = escapePrintHtml(section?.heading || '');
    const html = String(section?.html || '').trim();
    const text = escapePrintHtml(section?.text || '').replace(/\n/g, '<br>');
    const content = html || (text ? `<p>${text}</p>` : '<p class="muted">（无内容）</p>');
    return `<section class="block"><h2>${heading}</h2>${content}</section>`;
  }).join('\n');

  const delay = Math.max(120, Math.min(5000, Number(printDelayMs) || 420));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  ${katexStyles}
  <style>
    @page { margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 20px 24px 36px;
      font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
      color: #1f2430; line-height: 1.7; font-size: 13.5px;
      background: #fff;
    }
    header { margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid #5a43c5; }
    h1 { margin: 0 0 6px; font-size: 20px; color: #3c2f8f; font-weight: 750; }
    .subtitle { margin: 0; color: #66707d; font-size: 12px; }
    .block {
      margin: 0 0 22px; padding-bottom: 10px;
      border-bottom: 1px solid #f0eef6;
      page-break-inside: auto;
      break-inside: auto;
    }
    .block:last-child { border-bottom: none; }
    h2 {
      margin: 0 0 10px; font-size: 14px; color: #3c2f8f; font-weight: 750;
      padding-bottom: 4px; border-bottom: 1px solid #e8e4f5;
      page-break-after: avoid;
    }
    p { margin: 0.5em 0; }
    .muted { color: #8892a0; }
    .bubble {
      margin: 4px 0 8px; padding: 12px 14px; border-radius: 10px;
      border: 1px solid #e8eaf0; background: #fafbfe;
      word-break: break-word;
    }
    .bubble.user { background: #f3f0ff; border-color: #ddd6f8; white-space: pre-wrap; }
    .bubble.plain { white-space: pre-wrap; }
    .evidence-print {
      margin: 8px 0 0; padding: 9px 11px; border: 1px solid #cfe0d5;
      border-radius: 9px; background: #f2f8f4; color: #40584b; font-size: 11.5px;
    }
    .evidence-print ol { margin: 7px 0 4px 20px; padding: 0; }
    .evidence-print li { margin: 5px 0; }
    .evidence-print blockquote { margin: 3px 0 0; padding-left: 8px; border-left: 2px solid #9abca8; }
    .evidence-print small { display: block; margin-top: 6px; color: #6f7e75; }
    /* Rendered markdown / KaTeX from the reader */
    .export-md, .md {
      white-space: normal;
      font-size: 13.5px;
      line-height: 1.7;
      color: #1f2430;
    }
    .export-md h1, .md h1 { font-size: 1.25em; margin: 0.8em 0 0.4em; color: #2a2458; }
    .export-md h2, .md h2 { font-size: 1.12em; margin: 0.75em 0 0.35em; color: #2a2458; border: none; padding: 0; }
    .export-md h3, .md h3, .export-md h4, .md h4 {
      font-size: 1.05em; margin: 0.7em 0 0.3em; color: #332c6a; border: none; padding: 0;
    }
    .export-md p, .md p { margin: 0.45em 0; }
    .export-md ul, .md ul, .export-md ol, .md ol { margin: 0.4em 0 0.4em 1.2em; padding: 0; }
    .export-md li, .md li { margin: 0.2em 0; }
    .export-md img, .md img { max-width: 100%; height: auto; }
    .export-md table, .md table {
      border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12.5px;
    }
    .export-md th, .md th, .export-md td, .md td {
      border: 1px solid #d8dce6; padding: 6px 8px; vertical-align: top;
    }
    .export-md pre, .md pre, .vision-algorithm {
      white-space: pre-wrap; background: #f6f6fa; border: 1px solid #e6e3f0;
      border-radius: 8px; padding: 10px 12px; overflow: auto; font-size: 12px;
      font-family: ui-monospace, Consolas, "Cascadia Code", monospace;
    }
    .export-md code, .md code {
      font-family: ui-monospace, Consolas, "Cascadia Code", monospace;
      font-size: 0.92em;
    }
    .export-md .katex, .md .katex { font-size: 1.05em; }
    .export-md .katex-display, .md .katex-display {
      margin: 0.65em 0; overflow-x: auto; overflow-y: hidden;
      page-break-inside: avoid;
    }
    .export-md .eq-row, .md .eq-row {
      display: grid; grid-template-columns: 1fr auto; align-items: center;
      column-gap: 12px; width: 100%; margin: 8px 0;
    }
    .export-md .eq-num, .md .eq-num, .export-md .formula-number, .md .formula-number {
      color: #445; font-size: 0.95em; white-space: nowrap;
    }
    .table-wrap { overflow-x: auto; max-width: 100%; }
    .fig-crop img, .eq-crop img { max-width: 100%; height: auto; }
    .source-ref, .math-incomplete-badge { color: #8892a0; font-size: 12px; }
    footer {
      margin-top: 24px; padding-top: 12px; border-top: 1px solid #e8eaf0;
      color: #8892a0; font-size: 11px;
    }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
      .export-md .katex-display, .md .katex-display { overflow: visible; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${safeTitle}</h1>
    ${safeSubtitle ? `<p class="subtitle">${safeSubtitle}</p>` : ''}
  </header>
  <main>${body || '<p class="muted">（无内容）</p>'}</main>
  <footer>${escapePrintHtml(footerNote)}</footer>
  <script>
    (function () {
      var delay = ${delay};
      function goPrint() {
        try { window.focus(); } catch (e) {}
        try { window.print(); } catch (e) {}
      }
      function afterFonts() {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(function () { setTimeout(goPrint, delay); }).catch(function () {
            setTimeout(goPrint, delay);
          });
        } else {
          setTimeout(goPrint, delay);
        }
      }
      if (document.readyState === 'complete') afterFonts();
      else window.addEventListener('load', afterFonts);
    })();
  </script>
</body>
</html>`;
}

/**
 * Build print sections from chat history [{role, content}].
 * @param {Array} history
 * @param {{ renderToHtml?: (text: string, role: string) => string }} [options]
 *        renderToHtml should return safe HTML (already sanitized) for rich content.
 */
export function buildChatPrintSections(history = [], options = {}) {
  const renderToHtml = typeof options.renderToHtml === 'function' ? options.renderToHtml : null;
  const sections = [];
  let index = 0;
  for (const entry of Array.isArray(history) ? history : []) {
    const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(entry.content || '').trim();
    if (!content && !entry.images?.length && !entry.hadImage) continue;
    index += 1;
    const label = role === 'user' ? '用户' : 'AI 助手';
    const pageNote = entry.pageNum != null
      ? `<p class="muted">附图：第 ${Number(entry.pageNum)} 页</p>`
      : (entry.hadImage ? '<p class="muted">附图：页面截图</p>' : '');

    let bodyHtml = '';
    if (renderToHtml) {
      try {
        bodyHtml = String(renderToHtml(content, role) || '').trim();
      } catch {
        bodyHtml = '';
      }
    }
    if (!bodyHtml) {
      const cls = role === 'user' ? 'bubble user' : 'bubble plain';
      bodyHtml = `<div class="${cls}">${escapePrintHtml(content).replace(/\n/g, '<br>')}</div>`;
    } else if (!/^<div\b/i.test(bodyHtml)) {
      bodyHtml = `<div class="bubble ${role === 'user' ? 'user' : ''}">${bodyHtml}</div>`;
    }
    const evidenceHtml = role === 'assistant' ? buildEvidencePrintHtml(entry?.evidence) : '';

    sections.push({
      heading: `${index}. ${label}`,
      html: `${pageNote}${bodyHtml}${evidenceHtml}`,
    });
  }
  return sections;
}

function buildEvidencePrintHtml(evidence) {
  if (!evidence || typeof evidence !== 'object') return '';
  const score = Number(evidence.support?.score);
  const pages = [...new Set((evidence.citedPages?.length ? evidence.citedPages : evidence.pages || [])
    .map(Number).filter((page) => Number.isFinite(page) && page >= 1))].slice(0, 24);
  const items = (Array.isArray(evidence.items) ? evidence.items : []).map((item) => ({
    page: Number(item?.page),
    sourceType: item?.sourceType === 'source' ? 'PDF 原文' : '译文',
    heading: String(item?.heading || '').replace(/\s+/gu, ' ').trim().slice(0, 120),
    snippet: String(item?.snippet || item?.text || '').replace(/\s+/gu, ' ').trim().slice(0, 520),
  })).filter((item) => Number.isFinite(item.page) && item.page >= 1 && item.snippet).slice(0, 8);
  if (!Number.isFinite(score) && !pages.length && !items.length) return '';
  const summary = [
    Number.isFinite(score) ? `证据支持度 ${Math.max(0, Math.min(100, Math.round(score)))}%` : '',
    pages.length ? `核对页：${pages.map((page) => `第 ${page} 页`).join('、')}` : '',
  ].filter(Boolean).map(escapePrintHtml).join(' · ');
  const details = items.map((item, index) => (
    `<li><strong>E${index + 1} · 第 ${item.page} 页 · ${item.sourceType}</strong>${item.heading ? ` · ${escapePrintHtml(item.heading)}` : ''}`
    + `<blockquote>${escapePrintHtml(item.snippet)}</blockquote></li>`
  )).join('');
  return `<aside class="evidence-print"><div>${summary}</div>${details ? `<ol>${details}</ol>` : ''}`
    + '<small>支持度只表示可追溯性，不代表结论必然正确。</small></aside>';
}

/**
 * Build print sections from document pages.
 * Prefer page.html (rendered reader DOM with KaTeX); fall back to plain text.
 */
export function buildDocumentPrintSections(pages = []) {
  return (Array.isArray(pages) ? pages : []).map((page) => {
    const num = Number(page?.num) || '?';
    const rendered = sanitizeExportHtml(page?.html || '').trim();
    const body = String(page?.translationText || page?.domText || '').trim();
    const error = String(page?.error || '').trim();
    let html = '';
    if (rendered) {
      html = `<div class="export-md md">${rendered}</div>`;
    } else if (body) {
      // Plain fallback — formulas stay as $...$ if never rendered in the reader.
      html = `<div class="bubble plain">${escapePrintHtml(body).replace(/\n/g, '<br>')}</div>`;
    } else if (error) {
      html = `<p class="muted">（本页未完成：${escapePrintHtml(error)}）</p>`;
    } else {
      html = '<p class="muted">（本页暂无译文）</p>';
    }
    return { heading: `第 ${num} 页`, html };
  });
}

/**
 * Open a blob URL print window. Returns { ok, reason }.
 * Callers should revoke the URL after a delay.
 */
export function openPrintHtmlWindow(html, {
  windowOpen = globalThis.open?.bind(globalThis),
  scheduleRevoke = globalThis.setTimeout?.bind(globalThis),
  revokeAfterMs = 60_000,
} = {}) {
  if (typeof windowOpen !== 'function') {
    return { ok: false, reason: '当前环境无法打开打印窗口' };
  }
  const blob = new Blob([String(html || '')], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = windowOpen(url, '_blank', 'noopener,noreferrer');
  if (!win) {
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
    return { ok: false, reason: '弹窗被拦截，请允许本扩展打开新窗口后重试' };
  }
  // Revoke later so the print document can still load.
  if (typeof scheduleRevoke === 'function' && revokeAfterMs > 0) {
    const timer = scheduleRevoke(() => {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }, revokeAfterMs);
    // Avoid keeping Node's event loop alive in unit tests.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return { ok: true, reason: '', url };
}
