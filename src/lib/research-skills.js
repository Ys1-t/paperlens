// Research-assistant skills, routing heuristics, notes, and page-citation helpers.
// UI lives in chat-panel.js; paper tools live in research-agent.js + viewer.

/** @typedef {{ id: string, label: string, short: string, title: string, forceAgent: boolean, prompt: string }} ResearchSkill */

/** One-click research skills (A deep-read + B notes templates + C briefing). */
export const RESEARCH_SKILLS = Object.freeze([
  {
    id: 'briefing',
    label: '一键导读',
    short: '导读',
    title: '结构化全文导读：问题 / 方法 / 实验 / 局限（带页码）',
    forceAgent: true,
    prompt: [
      '请对当前打开的论文做「一键导读」。必须先 list_pages 了解已译页，再 get_page 阅读摘要/引言/方法/实验中有内容的关键页（优先第 1–3 页及含 method/experiment 的页）。',
      '用中文输出，严格按以下结构（每条尽量标注页码，如「第 3 页」）：',
      '## 一句话',
      '## 要解决的问题',
      '## 核心贡献（3 点）',
      '## 方法概要（输入→关键步骤→输出）',
      '## 实验与结论（最重要的 1–2 个结果）',
      '## 局限与开放问题',
      '## 建议阅读顺序',
      '未读到的部分请写「文中未找到 / 该页未译」，不要编造数字或结论。',
    ].join('\n'),
  },
  {
    id: 'tldr',
    label: 'TL;DR',
    short: 'TL;DR',
    title: '三句话速览',
    forceAgent: true,
    prompt: [
      '请用恰好三段、每段 1–2 句做 TL;DR：',
      '1) 问题与动机 2) 方法一句话 3) 最关键结果或主张。',
      '先 list_pages / get_page 取证；每段尽量标页码。不要空话。',
    ].join('\n'),
  },
  {
    id: 'method',
    label: '方法拆解',
    short: '方法',
    title: '拆解方法与算法流程',
    forceAgent: true,
    prompt: [
      '请拆解本文方法：',
      '- 输入 / 输出是什么',
      '- 关键模块或算法步骤（可用有序列表）',
      '- 与常见 baseline 的差异（文中写了的）',
      '- 关键公式或伪代码在说什么（白话 + 必要 $LaTeX$）',
      '先 search_paper 检索「方法 / algorithm / model / 提出」，再 get_page 精读；所有要点标页码。',
    ].join('\n'),
  },
  {
    id: 'experiment',
    label: '读实验',
    short: '实验',
    title: '读实验设置、指标与主结果',
    forceAgent: true,
    prompt: [
      '请解读实验部分：',
      '- 数据集 / 任务 / 指标',
      '- 对比方法',
      '- 主结果表/图在主张什么（引用页码）',
      '- 消融或分析（若有）',
      '- 你对实验公平性的简要质疑（标注「推断」）',
      '先 search_paper「实验 / experiment / dataset / ablation / results」，再 get_page。',
    ].join('\n'),
  },
  {
    id: 'critique',
    label: '批判阅读',
    short: '批判',
    title: '假设、局限与可改进点',
    forceAgent: true,
    prompt: [
      '请做批判性阅读笔记：',
      '1. 文中显式假设',
      '2. 局限性（优先引用作者自述）',
      '3. 潜在漏洞或未验证点（标「推断」）',
      '4. 若要跟进，最值得做的 2 个验证实验',
      '取证：search_paper「局限 / limitation / future / assumption」+ get_page。',
    ].join('\n'),
  },
  {
    id: 'glossary',
    label: '术语表',
    short: '术语',
    title: '本篇关键术语 / 缩写中英对照',
    forceAgent: true,
    prompt: [
      '请整理本篇「术语与缩写表」（8–15 条）：',
      '| 术语/缩写 | 含义（中文） | 首次/定义页 |',
      '优先方法名、任务名、关键符号旁的词。先 list_pages 与 get_page 前几页摘要/引言。',
    ].join('\n'),
  },
  {
    id: 'symbols',
    label: '符号',
    short: '符号',
    title: '关键数学符号含义',
    forceAgent: true,
    prompt: [
      '请整理文中关键数学符号（6–12 个）：符号、含义、出现页。',
      '用 $...$ 写符号。先 get_page 当前页与方法页；search_paper 若需要。',
      '不确定的标「文中未明确定义」。',
    ].join('\n'),
  },
  {
    id: 'current_page',
    label: '本页精讲',
    short: '本页',
    title: '精讲用户当前正在阅读的页',
    forceAgent: true,
    prompt: [
      '请 get_current_page，对本页做精讲：',
      '1) 本页在全文中的作用 2) 分段要点 3) 公式/算法白话 4) 读下一页前应记住的 2 点。',
      '若无译文，说明状态并建议用户先翻译。',
    ].join('\n'),
  },
  {
    id: 'review',
    label: '审稿视角',
    short: '审稿',
    title: '像审稿人一样评估：贡献、优缺点、给作者的问题',
    forceAgent: true,
    prompt: [
      '请以顶会/期刊审稿人的视角评估本文。先 get_outline 或 list_pages 把握结构，再 get_page 精读贡献、方法与实验页。',
      '按审稿报告结构输出（要点尽量标页码）：',
      '## Summary（客观转述本文，2–3 句）',
      '## Strengths（3–4 条，说明为什么算优点）',
      '## Weaknesses（3–4 条，指向具体章节或实验；文中未写的判断标「推断」）',
      '## Questions to Authors（2–3 个具体、可回答的问题）',
      '## 初步倾向（接收 / 边缘 / 拒绝之一 + 一句理由，注明仅基于译文的参考意见）',
      '不要编造实验数字；未读到的部分写「文中未找到」。',
    ].join('\n'),
  },
  {
    id: 'reproduce',
    label: '复现清单',
    short: '复现',
    title: '整理复现所需：数据、代码、超参、硬件与缺失信息',
    forceAgent: true,
    prompt: [
      '请整理一份「复现清单」。先 search_paper「code / github / dataset / 超参 / learning rate / GPU」，再 get_page 精读实验设置页。',
      '输出（逐条标页码）：',
      '## 代码与数据可得性（是否声明开源、文中是否给出链接）',
      '## 数据集与预处理',
      '## 模型结构与关键超参数',
      '## 训练细节与硬件（时长 / GPU / 显存，文中写了的）',
      '## 评测协议（指标、数据划分、随机种子）',
      '## 复现风险点（文中缺失或含糊、需要问作者的信息）',
      '文中未写的项目明确标「未提供」，不要猜测数值。',
    ].join('\n'),
  },
  {
    id: 'related',
    label: '相关工作',
    short: '相关',
    title: '梳理相关工作脉络与本文定位',
    forceAgent: true,
    prompt: [
      '请梳理本文的相关工作与定位。先 get_outline 定位引言 / Related Work 章节，或 search_paper「相关工作 / related / prior / baseline」，再 get_page 精读。',
      '输出（标页码）：',
      '## 研究脉络分组（按文中归类的技术路线，各 1–2 句）',
      '## 与本文最接近的 2–3 个工作及差异（作者如何声明区别）',
      '## 实验中实际对比的 baseline 列表',
      '## 本文定位一句话（作者声称填补了什么空白）',
      '只依据文中表述；方法名与引用标记保留原文。',
    ].join('\n'),
  },
  {
    id: 'citation',
    label: '引用本文',
    short: '引用',
    title: '生成本文的 BibTeX / GB/T 7714 / APA 引用条目',
    forceAgent: true,
    prompt: [
      '请为「本篇论文」生成引用条目。先 CALL get_page {"page":1} 读首页，提取：标题、完整作者列表、年份、发表载体（会议 / 期刊 / arXiv 编号）。',
      '输出三种格式，信息缺失处标 TODO 并说明依据（如「第 1 页未见期刊名」）：',
      '### BibTeX（放在 ```bibtex 代码块中，key 用 第一作者姓氏+年份+标题首词）',
      '### GB/T 7714',
      '### APA',
      '不要虚构卷、期、页码与 DOI；arXiv 论文按 arXiv 惯例写（编号、年份）。',
    ].join('\n'),
  },
  {
    id: 'presentation',
    label: '组会讲稿',
    short: '组会',
    title: '生成组会汇报材料：幻灯片大纲 + 逐张讲稿 + 预设提问',
    forceAgent: true,
    prompt: [
      '请帮我准备本文的组会汇报。先 get_outline / list_pages 把握结构，再 get_page 精读方法与实验页。',
      '输出（标页码）：',
      '## 幻灯片大纲（6–8 张，每张一行标题 + 2–3 个要点）',
      '## 逐张讲稿（每张 60–90 秒的口语化中文讲稿，别念论文腔）',
      '## 一张图讲清方法（用文字描述这张示意图该画什么：输入→模块→输出）',
      '## 预设提问（听众最可能问的 3 个问题 + 基于文中证据的参考回答，标页码）',
      '实验数字只用文中出现的；文中没有的写「文中未报告」。',
    ].join('\n'),
  },
  {
    id: 'writing',
    label: '写作引用',
    short: '写作',
    title: '为论文写作生成转述素材：概括句 + 引用语境模板',
    forceAgent: true,
    prompt: [
      '我要在自己的论文里引用本文，请生成写作素材。先读首页与方法/实验页确认贡献与结论。',
      '输出：',
      '## 一句话概括（中文 + 英文各一句，可直接放 Related Work）',
      '## 简短段落（中文 80–120 字 + 英文 2–3 句，概括方法与关键结果，标结果来源页码）',
      '## 三种引用语境的英文模板句（各 1–2 句，空出引用标记位 [X]）：',
      '- 作为 baseline 被比较时',
      '- 作为研究动机/问题来源时',
      '- 作为方法组件来源时',
      '所有英文必须是转述（paraphrase），不得抄论文原句；数字与结论须与文中一致。',
    ].join('\n'),
  },
  {
    id: 'ideas',
    label: '找思路',
    short: '思路',
    title: '从本文出发找研究空白与后续可做的 idea',
    forceAgent: true,
    prompt: [
      '请基于本文帮我找后续研究思路。先读局限 / 讨论 / 实验页，再 CALL search_my_notes 检索我的历史笔记，看是否能与我读过的论文交叉。',
      '输出（标页码；用到我的笔记时注明「你的笔记」）：',
      '## 研究空白（3 条：作者自己承认的标「作者自述」，你推断的标「推断」）',
      '## 可做的 idea（3 个，每个含：一句话描述 / 技术路线 / 需要的数据与算力 / 主要风险）',
      '## 最推荐哪个（考虑研究生单人可完成度：数据可得、算力适中、周期可控，给一句理由）',
      '区分文中事实与你的推断；不要编造不存在的数据集或结果。',
    ].join('\n'),
  },
]);

/** 默认直接展示的技能；其余折叠在「更多」里。 */
export const PRIMARY_SKILL_IDS = Object.freeze([
  'briefing', 'current_page', 'method', 'experiment', 'presentation', 'ideas',
]);

export function getResearchSkill(id) {
  return RESEARCH_SKILLS.find((s) => s.id === id) || null;
}

/** Local command-palette search; deterministic and free of model requests. */
export function searchResearchSkills(query = '', skills = RESEARCH_SKILLS) {
  const clean = String(query || '').trim().toLocaleLowerCase('zh-CN');
  const list = Array.isArray(skills) ? skills : [];
  if (!clean) return list.slice();
  const terms = clean.split(/\s+/gu).filter(Boolean);
  return list.map((skill, index) => {
    const id = String(skill?.id || '').toLocaleLowerCase('en-US');
    const label = String(skill?.label || '').toLocaleLowerCase('zh-CN');
    const short = String(skill?.short || '').toLocaleLowerCase('zh-CN');
    const title = String(skill?.title || '').toLocaleLowerCase('zh-CN');
    const prompt = String(skill?.prompt || '').toLocaleLowerCase('zh-CN');
    let score = 0;
    for (const term of terms) {
      if (id === term || label === term || short === term) score += 12;
      if (id.startsWith(term) || label.startsWith(term) || short.startsWith(term)) score += 7;
      if (label.includes(term) || short.includes(term)) score += 5;
      if (title.includes(term)) score += 3;
      if (prompt.includes(term)) score += 1;
    }
    return { skill, score, index };
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.skill);
}

export function buildSkillUserMessage(skill, { docTitle = '', extra = '' } = {}) {
  const s = typeof skill === 'string' ? getResearchSkill(skill) : skill;
  if (!s) return String(extra || '').trim();
  const title = String(docTitle || '').trim();
  const bits = [
    `【科研技能：${s.label}】`,
    title ? `论文：${title}` : '',
    s.prompt,
    String(extra || '').trim(),
  ].filter(Boolean);
  return bits.join('\n\n');
}

/** Heuristic: free-form questions that need multi-page evidence. */
export function shouldUseResearchAgent(text = '') {
  const q = String(text || '').trim();
  if (!q) return false;
  if (q.length >= 80) return true;
  const patterns = [
    /导读|briefing|总结全文|整篇|这篇论文|贡献|方法|算法|实验|消融|复杂度|时间开销|伪代码|局限|相关工作|对比|符号|术语|公式|表\s*\d|图\s*\d|第\s*\d+\s*页/i,
    /审稿|复现|超参|基线|数据集|新颖性|大纲|章节结构|引用格式|参考文献/,
    /组会|讲稿|汇报|思路|选题|idea|我的笔记|读过的论文|记过/i,
    /method|algorithm|experiment|ablation|complexity|limitation|contribution|overview|survey|review|reproduc|baseline|dataset|outline|bibtex|citation|novelty/i,
    /为什么|怎么做|如何|区别|相比|证明|推导/,
  ];
  return patterns.some((re) => re.test(q));
}

export function formatToolCallLabel(call) {
  const name = call?.name || 'tool';
  const args = call?.args || {};
  if (name === 'get_page') return `阅读第 ${args.page ?? '?'} 页`;
  if (name === 'get_page_range') return `阅读第 ${args.start ?? '?'}–${args.end ?? '?'} 页`;
  if (name === 'get_current_page') return '阅读当前页';
  if (name === 'search_paper') return `检索「${String(args.query || '').slice(0, 24)}」`;
  if (name === 'retrieve_evidence') return `证据检索「${String(args.query || '').slice(0, 24)}」`;
  if (name === 'list_pages') return '浏览各页概览';
  if (name === 'goto_page') return `跳到第 ${args.page ?? '?'} 页`;
  if (name === 'get_paper_meta') return '读取论文元信息';
  if (name === 'get_outline') return '提取全文大纲';
  if (name === 'get_my_notes') return '查看本篇笔记';
  if (name === 'search_my_notes') return `检索我的全部笔记「${String(args.query || '').slice(0, 24)}」`;
  return name;
}

/** Extract a page number from a tool call for clickable trails. */
export function pageFromToolCall(call) {
  const name = call?.name;
  const args = call?.args || {};
  if (name === 'get_page' || name === 'goto_page') {
    const n = Number(args.page);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  if (name === 'get_page_range') {
    const n = Number(args.start);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  return null;
}

export function formatToolTrailMarkdown(steps = []) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const lines = steps.map((s, i) => {
    const label = s.label || s.name || 'step';
    const ok = s.ok === false ? '失败' : '完成';
    return `${i + 1}. ${label} · ${ok}`;
  });
  return ['> **查阅过程**', ...lines.map((l) => `> ${l}`), ''].join('\n');
}

/**
 * Follow-up chips after an assistant answer (research workflow shortcuts).
 * @returns {Array<{ id: string, label: string, kind: string, page?: number, skillId?: string, prompt?: string }>}
 */
export function buildFollowUpActions(answer = '', { skillId = '', maxPages = 3 } = {}) {
  const actions = [];
  const pages = extractPageCitations(answer).slice(0, maxPages);
  for (const page of pages) {
    actions.push({
      id: `goto-${page}`,
      kind: 'goto',
      label: `第 ${page} 页`,
      page,
    });
  }
  actions.push({ id: 'note', kind: 'note', label: '收入笔记' });
  if (skillId !== 'method') {
    actions.push({
      id: 'skill-method',
      kind: 'skill',
      label: '拆方法',
      skillId: 'method',
    });
  }
  if (skillId !== 'experiment') {
    actions.push({
      id: 'skill-experiment',
      kind: 'skill',
      label: '读实验',
      skillId: 'experiment',
    });
  }
  if (skillId !== 'critique') {
    actions.push({
      id: 'skill-critique',
      kind: 'skill',
      label: '批判读',
      skillId: 'critique',
    });
  }
  // 批判读之后自然升级为完整审稿报告。
  if (skillId === 'critique') {
    actions.push({
      id: 'skill-review',
      kind: 'skill',
      label: '审稿视角',
      skillId: 'review',
    });
  }
  actions.push({
    id: 'ask-more',
    kind: 'prompt',
    label: '继续深挖',
    prompt: '基于上文，还有哪些关键点我应该追问？请列 3 个具体问题并给出你的简要回答（带页码）。',
  });
  // Dedupe by id, cap length
  const seen = new Set();
  return actions.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  }).slice(0, 8);
}

/**
 * Turn plain "第 N 页" mentions into placeholder markers for DOM linkification.
 * Safe for markdown source before render: uses HTML that marked may pass through
 * if we post-process DOM instead — prefer linkifyPageCitationsInElement after render.
 */
export function extractPageCitations(text = '') {
  const pages = new Set();
  const re = /第\s*(\d{1,4})\s*页/g;
  let m;
  const src = String(text || '');
  while ((m = re.exec(src)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1) pages.add(n);
  }
  return [...pages];
}

/** After markdown render: wrap "第 N 页" text nodes... simpler: walk element HTML. */
export function linkifyPageCitationsInElement(root, { onPageClick } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  // Avoid double-processing
  if (root.dataset?.plPageLinked === '1') return 0;
  const walker = (typeof root.ownerDocument !== 'undefined' ? root.ownerDocument : document)
    .createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !/第\s*\d+\s*页/.test(node.nodeValue)) continue;
    if (node.parentElement?.closest?.('a, button, code, pre, .katex')) continue;
    textNodes.push(node);
  }
  let count = 0;
  const re = /第\s*(\d{1,4})\s*页/g;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = (textNode.ownerDocument || document).createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild((textNode.ownerDocument || document).createTextNode(text.slice(last, m.index)));
      }
      const page = Number(m[1]);
      const a = (textNode.ownerDocument || document).createElement('button');
      a.type = 'button';
      a.className = 'chat-page-cite';
      a.dataset.page = String(page);
      a.textContent = m[0];
      a.title = `跳转到第 ${page} 页`;
      if (typeof onPageClick === 'function') {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onPageClick(page);
        });
      }
      frag.appendChild(a);
      count += 1;
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      frag.appendChild((textNode.ownerDocument || document).createTextNode(text.slice(last)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  if (root.dataset) root.dataset.plPageLinked = '1';
  return count;
}

// ---------------------------------------------------------------------------
// Research notes (per document, localStorage)
// ---------------------------------------------------------------------------

const NOTES_STORAGE_PREFIX = 'paperlens.researchNotes.v1:';

export function notesStorageKey(docKey = 'unknown') {
  return `${NOTES_STORAGE_PREFIX}${String(docKey || 'unknown').slice(0, 240)}`;
}

export function loadResearchNotes(docKey, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(notesStorageKey(docKey));
    if (!raw) return { items: [], updatedAt: 0 };
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      items: items.map(normalizeNoteItem).filter(Boolean),
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

export function saveResearchNotes(docKey, notes, storage = globalThis.localStorage) {
  const payload = {
    items: (Array.isArray(notes?.items) ? notes.items : []).map(normalizeNoteItem).filter(Boolean).slice(-40),
    updatedAt: Date.now(),
  };
  try {
    storage?.setItem?.(notesStorageKey(docKey), JSON.stringify(payload));
  } catch { /* quota */ }
  return payload;
}

function normalizeNoteItem(item) {
  if (!item || typeof item !== 'object') return null;
  const content = String(item.content || '').trim();
  if (!content) return null;
  return {
    id: String(item.id || `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    title: String(item.title || '笔记').trim().slice(0, 80) || '笔记',
    content: content.slice(0, 12000),
    source: String(item.source || 'manual').slice(0, 40),
    createdAt: Number(item.createdAt) || Date.now(),
  };
}

export function appendResearchNote(docKey, { title, content, source = 'ai' } = {}, storage = globalThis.localStorage) {
  const current = loadResearchNotes(docKey, storage);
  const item = normalizeNoteItem({
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: title || 'AI 摘录',
    content,
    source,
    createdAt: Date.now(),
  });
  if (!item) return current;
  current.items.push(item);
  return saveResearchNotes(docKey, current, storage);
}

export function clearResearchNotes(docKey, storage = globalThis.localStorage) {
  return saveResearchNotes(docKey, { items: [] }, storage);
}

/** 从 docKey（`t:标题|p:页数`）还原论文标题，用于跨论文笔记展示。 */
export function docTitleFromDocKey(docKey = '') {
  const m = /^t:([\s\S]*)\|p:\d+$/.exec(String(docKey || ''));
  const title = m ? m[1].trim() : '';
  return title || '未命名论文';
}

/** 枚举 localStorage 中所有论文的笔记（按最近更新排序），供跨论文检索。 */
export function listAllResearchNotes(storage = globalThis.localStorage) {
  const out = [];
  try {
    const len = Number(storage?.length) || 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(NOTES_STORAGE_PREFIX)) continue;
      const docKey = key.slice(NOTES_STORAGE_PREFIX.length);
      const notes = loadResearchNotes(docKey, storage);
      if (!notes.items.length) continue;
      out.push({ docKey, docTitle: docTitleFromDocKey(docKey), updatedAt: notes.updatedAt, items: notes.items });
    }
  } catch { /* storage 不可用时静默返回空 */ }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

/** 跨论文全文检索用户笔记；返回 [{docKey,docTitle,noteTitle,snippet}]。 */
export function searchResearchNotes(query, { storage = globalThis.localStorage, limit = 10 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const doc of listAllResearchNotes(storage)) {
    for (const item of doc.items) {
      const haystack = `${item.title}\n${item.content}`;
      const idx = haystack.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      const end = Math.min(haystack.length, idx + q.length + 160);
      const snippet = `${start > 0 ? '…' : ''}${haystack.slice(start, end).replace(/\s+/g, ' ').trim()}${end < haystack.length ? '…' : ''}`;
      hits.push({ docKey: doc.docKey, docTitle: doc.docTitle, noteTitle: item.title, snippet });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function formatResearchNotesMarkdown(notes, { docTitle = '' } = {}) {
  const title = String(docTitle || '').trim() || '未命名论文';
  const items = Array.isArray(notes?.items) ? notes.items : [];
  const lines = [
    `# ${title} · 科研笔记`,
    '',
    `_由 PaperLens 科研助手生成 · ${new Date().toLocaleString('zh-CN')}_`,
    '',
  ];
  if (!items.length) {
    lines.push('_（暂无笔记，可在回答下点「收入笔记」或运行一键导读）_', '');
    return lines.join('\n');
  }
  items.forEach((item, i) => {
    lines.push(`## ${i + 1}. ${item.title}`, '');
    lines.push(item.content, '', '---', '');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function noteTitleFromSkillOrText(skillId, text = '') {
  const skill = getResearchSkill(skillId);
  if (skill) return skill.label;
  const head = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 36);
  return head || '对话摘录';
}

/** Paper status strip helper. */
export function formatPaperContextLine(meta = {}) {
  const page = meta.currentPage != null ? `第 ${meta.currentPage} 页` : '未打开';
  const total = meta.totalPages ? ` / ${meta.totalPages}` : '';
  const translated = meta.translatedCount != null
    ? ` · 已译 ${meta.translatedCount}${meta.totalPages ? `/${meta.totalPages}` : ''} 页`
    : '';
  const title = String(meta.title || '').trim();
  const shortTitle = title ? (title.length > 28 ? `${title.slice(0, 28)}…` : title) : '';
  return {
    line: `${page}${total}${translated}`,
    title: shortTitle,
  };
}
