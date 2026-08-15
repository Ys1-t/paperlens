// Build downloadable full-document translation exports (Markdown / plain text).

export function sanitizeExportBasename(title = '') {
  const base = String(title || 'paper')
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60);
  return base || 'paper';
}

export function documentExportFilename({
  title = '',
  ext = 'md',
  now = new Date(),
} = {}) {
  const stamp = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
    : 'export';
  const safeExt = String(ext || 'md').replace(/^\./, '') || 'md';
  return `paperlens-${sanitizeExportBasename(title)}-${stamp}.${safeExt}`;
}

function pageExportText(page = {}) {
  const raw = String(page.translationText || page.text || '').trim();
  if (raw) return raw;
  // Fallback: strip common status chrome if only DOM text is available.
  return String(page.domText || '')
    .replace(/^(正在|排队|翻译|识别|连接|思考|公式|查看左侧).*$/gmu, '')
    .trim();
}

/**
 * @param {{ title?: string, pages?: Array<{ num: number, translationText?: string, text?: string, outcome?: string, error?: string }> }} input
 */
export function buildDocumentTranslationMarkdown({
  title = '',
  pages = [],
  exportedAt = new Date(),
} = {}) {
  const docTitle = String(title || '').trim() || '未命名 PDF';
  const when = exportedAt instanceof Date && !Number.isNaN(exportedAt.getTime())
    ? exportedAt.toISOString().replace('T', ' ').slice(0, 19)
    : String(exportedAt || '');
  const list = Array.isArray(pages) ? pages : [];
  const lines = [
    `# ${docTitle}`,
    '',
    `> 由 PaperLens 导出 · ${when}`,
    '',
  ];

  let exported = 0;
  for (const page of list) {
    const num = Number(page?.num) || 0;
    const body = pageExportText(page);
    const outcome = page?.outcome || '';
    const error = String(page?.error || '').trim();
    lines.push(`## 第 ${num || '?'} 页`);
    lines.push('');
    if (body) {
      lines.push(body, '');
      exported += 1;
    } else if (error) {
      lines.push(`_（本页未完成：${error}）_`, '');
    } else if (outcome === 'failed') {
      lines.push('_（本页翻译失败）_', '');
    } else {
      lines.push('_（本页暂无译文）_', '');
    }
  }

  if (!list.length) {
    lines.push('_（文档为空）_', '');
  }

  return {
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n'),
    pageCount: list.length,
    exportedPageCount: exported,
  };
}

export function buildDocumentTranslationPlainText(input = {}) {
  const { markdown, pageCount, exportedPageCount } = buildDocumentTranslationMarkdown(input);
  // Markdown headings stay readable as plain text for notes apps.
  return {
    text: markdown
      .replace(/^#\s+/gm, '')
      .replace(/^##\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^_(.*)_$/gm, '$1'),
    pageCount,
    exportedPageCount,
  };
}
