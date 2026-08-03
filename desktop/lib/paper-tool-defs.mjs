// 论文本地工具：对当前打开的 PDF（渲染进程抽取的分页文本）提供
// 概览 / 读页 / 全文检索。getPaper() 返回 { title, pages: string[] } 或 null。
// 简单包含匹配即可起步；后续可换 src/lib/paper-retrieval.js 的 BM25。

export function createPaperToolDefs(getPaper) {
  const requirePaper = () => {
    const paper = getPaper?.();
    if (!paper?.pages?.length) throw new Error('当前没有打开论文。请提示用户先在左侧打开 PDF。');
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
            preview: String(text || '').slice(0, 120),
          })),
        };
      },
    },
    {
      name: 'read_paper_page',
      description: '读取当前论文指定页的完整文本。回答论文细节（方法/公式/实验/引用条目）必须先读相关页。',
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
        return { page: index + 1, text: String(paper.pages[index] || '').slice(0, 12000) || '（本页无可提取文本，可能是扫描页）' };
      },
    },
    {
      name: 'search_paper_text',
      description: '在当前论文全文中检索关键词（不区分大小写），返回命中页与上下文片段。找「文献 [N] 的条目」「某方法在哪页」用它。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索词' } },
        required: ['query'],
      },
      run: ({ query }) => {
        const paper = requirePaper();
        const needle = String(query || '').trim().toLowerCase();
        if (!needle) throw new Error('query 不能为空');
        const hits = [];
        paper.pages.forEach((text, index) => {
          const hay = String(text || '');
          const at = hay.toLowerCase().indexOf(needle);
          if (at < 0) return;
          hits.push({
            page: index + 1,
            snippet: hay.slice(Math.max(0, at - 120), at + needle.length + 240).trim(),
          });
        });
        return hits.length ? { hits: hits.slice(0, 8) } : { hits: [], note: `全文未找到「${query}」，可换英文或更短的关键词` };
      },
    },
  ];
}
