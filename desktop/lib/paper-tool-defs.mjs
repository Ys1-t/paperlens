// 论文与工作台工具：当前 PDF 取证 + 笔记落盘。
// getPaper() → { title, pages: string[] } | null
// saveNote?.(note) → { ok, id? } 由主进程注入。

export function createPaperToolDefs(getPaper, { saveNote } = {}) {
  const requirePaper = () => {
    const paper = getPaper?.();
    if (!paper?.pages?.length) {
      throw new Error('当前没有打开论文。请提示用户先在左侧打开 PDF。');
    }
    return paper;
  };

  return [
    {
      name: 'get_paper_overview',
      description: '获取当前打开论文的标题、总页数和每页开头摘要。回答「本论文」问题前先用它了解结构。',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => {
        const paper = requirePaper();
        return {
          title: paper.title,
          totalPages: paper.pages.length,
          pagePreviews: paper.pages.map((text, index) => ({
            page: index + 1,
            preview: String(text || '').slice(0, 160),
            chars: String(text || '').length,
          })),
        };
      },
    },
    {
      name: 'read_paper_page',
      description: '读取当前论文指定页的完整文本。方法/公式/实验/引用细节必须先读相关页。',
      parameters: {
        type: 'object',
        properties: { page: { type: 'number', description: '页码，从 1 开始' } },
        required: ['page'],
      },
      run: ({ page }) => {
        const paper = requirePaper();
        const index = Math.round(Number(page)) - 1;
        if (index < 0 || index >= paper.pages.length) {
          throw new Error(`页码超出范围（1-${paper.pages.length}）`);
        }
        const text = String(paper.pages[index] || '');
        return {
          page: index + 1,
          text: text.slice(0, 12000) || '（本页无可提取文本，可能是扫描页；可请用户查看左侧原文或先译此页）',
          truncated: text.length > 12000,
        };
      },
    },
    {
      name: 'read_paper_pages',
      description: '连续读取多页文本（含端点，最多 5 页）。适合扫引言或方法连续页。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'number', description: '起始页（含），从 1 开始' },
          to: { type: 'number', description: '结束页（含）' },
        },
        required: ['from', 'to'],
      },
      run: ({ from, to }) => {
        const paper = requirePaper();
        let a = Math.round(Number(from));
        let b = Math.round(Number(to));
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('from/to 必须是数字');
        if (a > b) [a, b] = [b, a];
        a = Math.max(1, a);
        b = Math.min(paper.pages.length, b);
        if (b - a + 1 > 5) b = a + 4;
        const pages = [];
        for (let p = a; p <= b; p += 1) {
          const text = String(paper.pages[p - 1] || '');
          pages.push({
            page: p,
            text: text.slice(0, 8000) || '（无可提取文本）',
            truncated: text.length > 8000,
          });
        }
        return { from: a, to: b, pages };
      },
    },
    {
      name: 'search_paper_text',
      description: '在当前论文全文检索关键词（不区分大小写），返回命中页与上下文。找章节、符号、文献 [N] 条目用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词' },
          maxHits: { type: 'number', description: '最多命中条数 1-15，默认 8' },
        },
        required: ['query'],
      },
      run: ({ query, maxHits }) => {
        const paper = requirePaper();
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) throw new Error('query 不能为空');
        const limit = Math.min(15, Math.max(1, Number(maxHits) || 8));
        const hits = [];
        paper.pages.forEach((text, index) => {
          const hay = String(text || '');
          const lower = hay.toLowerCase();
          let from = 0;
          while (hits.length < limit) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            hits.push({
              page: index + 1,
              snippet: hay.slice(Math.max(0, at - 120), at + needle.length + 240).trim(),
            });
            from = at + needle.length;
            // 每页最多记 2 处，避免同一页刷屏
            if (hits.filter((h) => h.page === index + 1).length >= 2) break;
          }
        });
        return hits.length
          ? { hits: hits.slice(0, limit), query }
          : { hits: [], query, note: `全文未找到「${query}」，可换英文词根、缩写或更短关键词` };
      },
    },
    {
      name: 'save_research_note',
      description: '将成熟的研究笔记写入 PaperLens 工作台（可日后导出 / 同步 Obsidian）。仅在结论已取证后使用。副驾驶模式下需用户确认。',
      requiresConfirmation: true,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '短标题' },
          content: { type: 'string', description: '笔记正文（Markdown，建议含页码）' },
        },
        required: ['title', 'content'],
      },
      run: async ({ title, content }) => {
        if (typeof saveNote !== 'function') {
          throw new Error('当前环境未启用笔记写入');
        }
        const paper = getPaper?.();
        const result = await saveNote({
          title: String(title || '').slice(0, 80),
          content: String(content || '').slice(0, 20000),
          paperTitle: paper?.title || '',
          source: 'agent',
        });
        if (!result?.ok && result?.added === false) {
          return { saved: false, reason: 'duplicate_or_empty', ...result };
        }
        return { saved: true, ...result };
      },
    },
  ];
}
