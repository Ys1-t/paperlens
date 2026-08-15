// 科研工作台工具：知识库（Obsidian vault）检索、前沿雷达、待读清单、投稿 DDL。
// 由 main.cjs 注入 workspace 读写与 vault 路径；注册进 agent-core registry。

import { searchVault, vaultOverview, readVaultNote } from './knowledge-base.mjs';
import { fetchRadarPapers, rankRadarPapers } from './arxiv-radar.mjs';
import { venueBoardModel } from './submission-helper.mjs';

/**
 * @param {{
 *   getVaultFolder: () => string,          // Obsidian vault 绝对路径（未配置返回 ''）
 *   readWorkspace: () => object | Promise<object>,
 *   writeWorkspace: (ws: object) => void | Promise<void>,
 *   store: object,                          // workspace-store exports
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createWorkbenchToolDefs(deps = {}) {
  const { getVaultFolder, readWorkspace, writeWorkspace, store, fetchImpl = fetch } = deps;
  const load = async () => store.normalizeWorkspace(await readWorkspace());

  const requireVault = () => {
    const folder = getVaultFolder?.() || '';
    if (!folder) {
      throw new Error('尚未配置 Obsidian vault。请提示用户在设置里选择 vault 文件夹（知识库与笔记同步共用）。');
    }
    return folder;
  };

  return [
    {
      name: 'search_knowledge_base',
      description: '在用户的 Obsidian 知识库（本地 .md 笔记）里全文检索。回答「我以前记过什么」「我的知识库里有没有 X」、写作时找自己积累的素材，用这个。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（可多词，空格分隔）' },
          maxResults: { type: 'number', description: '最多返回条数 1-20，默认 8' },
        },
        required: ['query'],
      },
      run: ({ query, maxResults }) => {
        const folder = requireVault();
        const hits = searchVault(folder, query, { maxResults });
        return hits.length
          ? { hits: hits.map(({ relPath, name, score, snippets }) => ({ note: name, relPath, score, snippets })) }
          : { hits: [], note: `知识库中未找到「${query}」，可换关键词` };
      },
    },
    {
      name: 'read_knowledge_note',
      description: '读取知识库中某篇笔记的完整内容（用 search_knowledge_base 返回的 relPath）。',
      parameters: {
        type: 'object',
        properties: {
          relPath: { type: 'string', description: '笔记相对路径，如 "papers/DRL-MOA.md"' },
        },
        required: ['relPath'],
      },
      run: ({ relPath }) => {
        const folder = requireVault();
        const rel = String(relPath || '').replace(/\\/g, '/');
        if (!rel || rel.includes('..')) throw new Error('非法路径');
        const note = readVaultNote(`${folder}/${rel}`);
        if (!note) throw new Error(`读不到笔记：${rel}`);
        return { name: note.name, text: note.text.slice(0, 16000), truncated: note.text.length > 16000 };
      },
    },
    {
      name: 'get_knowledge_base_overview',
      description: '查看知识库概况：笔记总数与最近编辑的笔记列表。首次进入知识库相关任务时可先看一眼。',
      parameters: { type: 'object', properties: {}, required: [] },
      run: () => vaultOverview(requireVault()),
    },
    {
      name: 'fetch_frontier_papers',
      description: '按用户设置的兴趣（arXiv 分类 + 关键词）抓取最新提交的论文并按相关度排序。用户问「最近有什么新论文 / 前沿进展」用这个，不要用 search_arxiv（那是按主题检索全库）。',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: '抓取条数 10-80，默认 40' },
        },
        required: [],
      },
      run: async ({ maxResults } = {}) => {
        const ws = await load();
        const interests = ws.interests || { categories: [], keywords: [] };
        if (!interests.categories.length && !interests.keywords.length) {
          return { papers: [], note: '用户尚未设置兴趣。请提示在「雷达」页配置 arXiv 分类与关键词。' };
        }
        const papers = await fetchRadarPapers(interests, { maxResults, fetchImpl });
        const ranked = rankRadarPapers(papers, interests);
        return {
          interests,
          papers: ranked.slice(0, 20).map(({ arxivId, title, authors, published, score, matchedKeywords, summary, pdfUrl }) => ({
            arxivId, title, authors: authors.slice(0, 6), published, score, matchedKeywords,
            summary: String(summary || '').slice(0, 400), pdfUrl,
          })),
        };
      },
    },
    {
      name: 'add_to_reading_list',
      description: '把一篇论文加入用户的待读清单（标题必填；尽量带 arXiv id / URL / 一句话摘要）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          arxivId: { type: 'string' },
          url: { type: 'string' },
          summary: { type: 'string', description: '为什么值得读（一句话）' },
        },
        required: ['title'],
      },
      run: async ({ title, arxivId, url, summary }) => {
        const ws = await load();
        const { workspace, added, item } = store.addReadingItem(ws, { title, arxivId, url, summary });
        if (added) await writeWorkspace(workspace);
        return { added, item };
      },
    },
    {
      name: 'list_reading_list',
      description: '查看用户的待读清单（未读在前）。',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async () => {
        const ws = await load();
        const items = [...ws.readingList].sort((a, b) => a.done - b.done);
        return { count: items.length, items: items.slice(0, 30) };
      },
    },
    {
      name: 'list_submission_deadlines',
      description: '查看用户设置的投稿目标与截稿倒计时（AoE）。规划投稿、问「还有多久截稿」用这个。',
      parameters: { type: 'object', properties: {}, required: [] },
      run: async () => {
        const ws = await load();
        const board = venueBoardModel(ws.venues);
        return board.length
          ? { venues: board.map(({ abbr, name, deadline, countdown, note }) => ({ abbr, name, deadline, countdown: countdown?.label || '未设日期', urgency: countdown?.urgency || 'none', note })) }
          : { venues: [], note: '用户尚未添加投稿目标。可提示在「投稿」页添加。' };
      },
    },
  ];
}
