// 桌面 agent 的联网工具定义（注册进 agent-core 的 registry）。
// 论文本地工具（读页/检索译文）由 UI 层注入——参考扩展 paperTools 的实现。
import { searchArxiv, lookupCitation, fetchUrlText } from './web-tools.mjs';

export function createWebToolDefs({ fetchImpl = fetch } = {}) {
  return [
    {
      name: 'search_arxiv',
      description: '在 arXiv 全库按主题/标题/作者检索论文，返回标题、作者、摘要、PDF 链接。查相关工作、找某方向最新论文用这个。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词（英文效果最好）' },
          maxResults: { type: 'number', description: '返回条数 1-10，默认 5' },
        },
        required: ['query'],
      },
      run: ({ query, maxResults }) => searchArxiv(query, { maxResults, fetchImpl }),
    },
    {
      name: 'lookup_citation',
      description: '按论文标题 / arXiv id / DOI 查一篇具体文献的权威信息（作者、年份、venue、摘要、TLDR、引用数、开放获取 PDF）。用户问「文献 [N] 在讲什么」时，先从本论文参考文献里取出该条目的标题，再用这个工具查它本身。',
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: '文献标题（或 arXiv id / DOI）。给完整标题最准。' },
        },
        required: ['reference'],
      },
      run: ({ reference }) => lookupCitation(reference, { fetchImpl }),
    },
    {
      name: 'fetch_url',
      description: '抓取一个网页链接的可读正文（去导航/脚本，限长 8000 字）。查博客、文档、GitHub README 用这个；PDF 链接请改用 lookup_citation。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http/https 链接' },
        },
        required: ['url'],
      },
      run: ({ url }) => fetchUrlText(url, { fetchImpl }),
    },
  ];
}
