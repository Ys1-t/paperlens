// PaperLens 自有科研 Skills：可复用的任务包（不是外部产品嵌入）。
// 设计借鉴优秀开源 agent harness 的 skill 模式，内容与人格完全属于 PaperLens。

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   short: string,
 *   title: string,
 *   keywords: string[],
 *   maxRounds?: number,
 *   prompt: string,
 * }} ResearchSkill
 */

/** @type {ResearchSkill[]} */
export const RESEARCH_SKILLS = Object.freeze([
  {
    id: 'deep-read',
    label: '一键深读',
    short: '深读',
    title: '结构化全文深读：问题 / 方法 / 实验 / 局限（带页码证据）',
    keywords: ['深读', '导读', '精读', 'briefing', 'overview', '这篇讲什么'],
    maxRounds: 18,
    prompt: [
      '请对【当前打开的论文】做完整深读。必须先 get_paper_overview，再 search_paper_text / read_paper_page 取证关键页（摘要、引言、方法、实验、结论）。',
      '用中文输出，严格按以下结构；每条重要结论标注「第 N 页」：',
      '## 一句话 coreset',
      '## 要解决的问题与动机',
      '## 核心贡献（3 点内）',
      '## 方法概要（输入 → 关键步骤 → 输出）',
      '## 实验与主结果（只写文中有的数字/设定）',
      '## 局限与开放问题',
      '## 建议阅读顺序（页码）',
      '未读到的部分写「文中未找到」，禁止编造实验数字或外部论文结论。',
      '若用户之后可能收藏，结构保持清晰，便于 save_research_note。',
    ].join('\n'),
  },
  {
    id: 'paper-qa',
    label: '本篇问答',
    short: '问答',
    title: '针对当前论文的精确问答（先取证再答）',
    keywords: ['这页', '公式', '表', '算法', '什么意思', '在哪'],
    maxRounds: 12,
    prompt: [
      '用户在问【当前论文】内的具体问题。',
      '流程：必要时 get_paper_overview → search_paper_text 定位 → read_paper_page 精读相关页 → 作答。',
      '回答必须：',
      '- 先给直接答案，再给简短依据',
      '- 每个事实主张尽量带「第 N 页」',
      '- 区分「原文」与「推断」',
      '- 找不到就说找不到，不要用 related work 转述冒充外部文献本身',
    ].join('\n'),
  },
  {
    id: 'method',
    label: '方法拆解',
    short: '方法',
    title: '拆解方法、模块与算法流程',
    keywords: ['方法', '算法', '模型', 'method', 'algorithm', '架构'],
    maxRounds: 14,
    prompt: [
      '请拆解本文方法（只基于当前 PDF 取证）：',
      '1. 问题形式化（输入/输出/目标）',
      '2. 关键模块或步骤（有序列表）',
      '3. 与文中 baseline 的差异（仅文中写明的）',
      '4. 关键公式/伪代码白话解释（可保留必要 $LaTeX$）',
      '先 search_paper_text 检索 method/algorithm/proposed/framework，再 read_paper_page。全部要点标页码。',
    ].join('\n'),
  },
  {
    id: 'experiment',
    label: '读实验',
    short: '实验',
    title: '实验设置、指标与主结果',
    keywords: ['实验', '结果', '数据集', '消融', 'experiment', 'ablation'],
    maxRounds: 14,
    prompt: [
      '请解读实验部分：',
      '- 数据集 / 任务 / 指标',
      '- 对比方法',
      '- 主结果主张什么（引用页码；数字必须来自原文）',
      '- 消融或分析（若有）',
      '- 对实验公平性的简要质疑（明确标「推断」）',
      '先 search_paper_text「experiment|dataset|ablation|results|表|实验」，再读页。',
    ].join('\n'),
  },
  {
    id: 'critique',
    label: '批判阅读',
    short: '批判',
    title: '假设、局限与可跟进点',
    keywords: ['批判', '局限', '漏洞', '审稿', 'limitation'],
    maxRounds: 12,
    prompt: [
      '请做批判性阅读笔记：',
      '1. 文中显式假设',
      '2. 局限性（优先作者自述，标页码）',
      '3. 潜在漏洞或未验证点（标「推断」）',
      '4. 若跟进，最值得做的 2 个验证',
      '取证：search_paper_text limitation|future|assumption|threat + read_paper_page。',
    ].join('\n'),
  },
  {
    id: 'lit-survey',
    label: '文献调研',
    short: '调研',
    title: '主题检索 → 筛选 → 简述（可联网）',
    keywords: ['调研', '文献调研', '相关工作', '最新论文', 'survey', 'related work', '找论文', '文献'],
    maxRounds: 16,
    prompt: [
      '用户要做文献调研。流程：',
      '1. 若已打开论文：先读其 related work / 引言，提炼关键词与已有引用（标页码）',
      '2. 用 search_arxiv 检索（英文关键词），必要时 lookup_citation 核实',
      '3. 输出：',
      '## 检索策略',
      '## 推荐阅读（3–8 篇，含为何值得读、链接）',
      '## 与当前论文的关系（若有打开论文）',
      '## 仍待查的缺口',
      '禁止编造不存在的论文标题或链接；查不到就写查不到。',
    ].join('\n'),
  },
  {
    id: 'meeting',
    label: '组会讲稿',
    short: '组会',
    title: '一页组会：背景-方法-结果-问题',
    keywords: ['组会', '汇报', 'slides', '讲稿', 'presentation'],
    maxRounds: 14,
    prompt: [
      '请基于当前论文生成「组会 5–8 分钟」讲稿大纲（中文）：',
      '## 开场（1 句问题）',
      '## 背景与缺口（2–3 点，标页码）',
      '## 方法一张图能讲清的步骤',
      '## 主结果（只保留最硬的 1–2 个，带页码）',
      '## 可能被问到的 3 个问题 + 你建议的答法',
      '## 你自己还没读透的地方',
      '必须先工具取证；不要空泛套话。',
    ].join('\n'),
  },
  {
    id: 'tldr',
    label: 'TL;DR',
    short: 'TL;DR',
    title: '三句话速览',
    keywords: ['tldr', '速览', '摘要一下', '一句话'],
    maxRounds: 8,
    prompt: [
      '请用恰好三段、每段 1–2 句做 TL;DR：',
      '1) 问题与动机 2) 方法一句话 3) 最硬结果或主张。',
      '先 get_paper_overview / read_paper_page 取证；每段尽量标页码。禁止空话。',
    ].join('\n'),
  },
  {
    id: 'export-report',
    label: '导出报告',
    short: '导出',
    title: '生成并导出 Markdown 科研报告',
    keywords: ['导出', '保存报告', 'markdown', '写到文件', 'export'],
    maxRounds: 14,
    prompt: [
      '请先对当前论文（或用户指定主题）取证并整理成完整 Markdown 报告，结构自洽。',
      '然后调用 export_markdown_report 保存到本地（用户会确认）。',
      '报告内关键结论必须带「第 N 页」。',
      '若用户只要预览，先输出正文，再询问是否导出。',
    ].join('\n'),
  },
  {
    id: 'overleaf',
    label: 'Overleaf 草稿',
    short: 'TeX',
    title: '生成 Overleaf/LaTeX section 并复制',
    keywords: ['overleaf', 'latex', 'tex', 'related work 写作', '写 section'],
    maxRounds: 14,
    prompt: [
      '请基于已打开论文与必要时的联网检索，生成一段可编译的 LaTeX section 草稿（如 Related Work 或 Method summary）。',
      '要求：',
      '- 使用 \\cite{} 占位或注释标明待补引用',
      '- 不编造文献；不确定处用 % TODO',
      '- 正文结论对应处用 % p.N 注释页码',
      '完成后调用 prepare_overleaf_section（用户确认后复制到剪贴板并尝试打开 Overleaf 项目）。',
    ].join('\n'),
  },
  {
    id: 'frontier-digest',
    label: '前沿日报',
    short: '前沿',
    title: '抓取兴趣方向最新论文并做一页可执行速报',
    keywords: ['前沿', '最新论文', '今天有什么', '新进展', 'arxiv 今天', '日报', '雷达'],
    maxRounds: 14,
    prompt: [
      '你是研究生的「文献侦察兵」。用户要今日可执行的前沿情报，不是论文列表复读。',
      '流程：',
      '1. list_project_memory + 研究档案上下文；fetch_frontier_papers 拉最新排序结果',
      '2. 若相关度普遍偏低或 needsKeywords，先警告用户去雷达页补「任务/方法」级关键词',
      '3. 只精选 tier=must 与 top skim，最多 6 篇；每篇输出：',
      '   - 一句话贡献（中文）',
      '   - 与你方向的具体关联（可写「弱相关，可跳过」）',
      '   - 建议动作：精读 / 扫摘要 / 忽略 + 理由',
      '4. 若打开了论文，点名 1–2 篇「可能改进/对照你当前方法」',
      '5. 值得跟的 1–2 篇调用 add_to_reading_list（需用户确认的写操作按规则）',
      '输出：## 今日判断（3 句）→ ## 必看 → ## 可扫 → ## 可跳过的模式 → ## 建议待办',
      '禁止编摘要；分数与 reasons 来自工具。',
    ].join('\n'),
  },
  {
    id: 'claim-map',
    label: '主张地图',
    short: '主张',
    title: '抽出论文可检验主张与证据链（组会/写 related work 用）',
    keywords: ['主张', 'claim', '贡献点', '证据链', '他们声称'],
    maxRounds: 16,
    prompt: [
      '把当前论文拆成「可检验主张地图」——研究生写 related work / 做组会最需要的东西。',
      '必须取证：get_paper_overview → search/read 摘要、引言贡献段、实验主表。',
      '输出表格或分点：',
      '| # | 主张（一句话） | 证据类型（定理/实验/消融/案例） | 页码 | 可被打脸的点 |',
      '再给：## 若你要 follow 的可复现缺口 ## 写 related work 时可引用的一句（中英各一）',
      '禁止把宣传话术当主张；每个主张必须有页码。',
    ].join('\n'),
  },
  {
    id: 'paper-compare',
    label: '论文对照',
    short: '对照',
    title: '对照当前论文与另一篇（或雷达候选）的方法/设定/结果',
    keywords: ['对比', '对照', '和这篇比', '区别', 'compare', 'versus'],
    maxRounds: 16,
    prompt: [
      '用户要两篇论文的硬对照（方法/数据/指标/结论），服务「我要不要 cite / follow」。',
      '1. 当前打开论文：read 关键页取证',
      '2. 另一篇：若用户给了 arXiv/标题，lookup_citation + fetch 摘要；若在雷达结果里，用工具返回的摘要',
      '3. 输出对照表：问题设定 / 方法核心 / 数据与指标 / 主结果 / 局限 / 与你工作的可组合点',
      '4. 明确「不可比」之处（设定不同就不要硬比 SOTA）',
      '数字与设定必须来自证据；缺失标「未知」。',
    ].join('\n'),
  },
  {
    id: 'reading-coach',
    label: '带读教练',
    short: '带读',
    title: '按页带读：告诉我下一页看什么、跳过什么',
    keywords: ['带读', '下一页', '怎么读', '阅读计划', 'coach', '带我看'],
    maxRounds: 12,
    prompt: [
      '你是精读教练。用户打开了长论文，需要「接下来 20 分钟怎么读」而不是全文摘要。',
      '1. get_paper_overview + 当前页（若可知）',
      '2. 给出 3 段阅读路径：快速路径（15min）/ 标准（45min）/ 深挖（2h+）',
      '3. 对「现在这一页」：看什么、可跳过的噪声、下一个应跳到的页码（可用 show_page_to_user）',
      '4. 列出本页 1–3 个检查问题，用户应能在原文找到答案',
      '输出短、可执行；每条建议带页码。',
    ].join('\n'),
  },
  {
    id: 'venue-advisor',
    label: '选会建议',
    short: '选会',
    title: '基于工作内容推荐投稿去处并对照 DDL',
    keywords: ['投哪', '选会', '投稿建议', 'venue', '会议推荐', 'deadline', '截稿'],
    maxRounds: 12,
    prompt: [
      '用户在考虑把工作投到哪里。流程：',
      '1. list_submission_deadlines 查看用户已设置的目标与倒计时',
      '2. 若打开了论文（用户自己的稿子或同方向论文），读摘要/贡献，判断工作类型与体量',
      '3. 结合研究档案，给出 2–4 个候选去处：各自适配理由、竞争强度常识、与用户 DDL 的时间可行性',
      '4. 明确区分「事实（DDL 数据、官网链接）」与「建议（适配判断，标注推断）」',
      '截稿日期只使用 list_submission_deadlines 返回的数据；没有数据就直说，并建议用户在「投稿」页添加目标而不是编日期。',
    ].join('\n'),
  },
  {
    id: 'rebuttal',
    label: 'Rebuttal 助手',
    short: 'Rebuttal',
    title: '逐条拆审稿意见并起草回复',
    keywords: ['rebuttal', '审稿意见', '回复审稿', 'reviewer', '意见回复'],
    maxRounds: 14,
    prompt: [
      '用户要写 rebuttal / 审稿意见回复。用户会贴出审稿意见（或已在上文）。流程：',
      '1. 把意见拆成编号的关切点，逐条分类：误解 / 实验诉求 / 写作问题 / 根本分歧',
      '2. 若打开了论文原稿，用 search_paper_text / read_paper_page 找出可直接引用的原文证据（标页码）',
      '3. 每条给出：礼貌回应草稿（英文）+ 应对策略（中文批注）+ 需要补的实验或修改（若有）',
      '4. 语气专业谦逊但立场清晰；对误解类意见指出原文对应位置',
      '输出：## 意见拆解表 → 逐条「Reviewer 关切 / 建议回复（EN）/ 策略（中文）」→ ## 需要补做的事（可 add_research_todo）。',
    ].join('\n'),
  },
  {
    id: 'kb-weave',
    label: '知识库串联',
    short: '串联',
    title: '把当前论文与你的知识库/历史笔记联系起来',
    keywords: ['知识库', '我的笔记', '以前记过', '关联', '串联', 'obsidian'],
    maxRounds: 14,
    prompt: [
      '把当前论文与用户的个人知识库串联。流程：',
      '1. get_paper_overview 抓住本文核心概念（3–6 个关键词，中英都试）',
      '2. search_knowledge_base 逐个检索这些概念；命中的笔记用 read_knowledge_note 精读最相关的 1–3 篇',
      '3. 输出：',
      '## 本文核心概念',
      '## 你的知识库里已有的相关积累（逐条：笔记名 + 相关内容摘录）',
      '## 本文与已有笔记的互补/冲突点',
      '## 建议新增的连接（可 save_research_note 写一条带 [[双链]] 的桥接笔记）',
      '知识库没命中就如实说，并建议值得新建的笔记主题。',
    ].join('\n'),
  },
  {
    id: 'proposal-survey',
    label: '开题调研',
    short: '开题',
    title: '围绕一个研究问题做体系化开题调研',
    keywords: ['开题', '调研报告', '综述', '研究现状', 'proposal'],
    maxRounds: 20,
    prompt: [
      '用户在做开题/立项调研。围绕用户给定的研究问题：',
      '1. 拆解 2–4 个子方向关键词（英文），逐个 search_arxiv 检索',
      '2. 重要文献 lookup_citation 核实（年份、venue、被引）',
      '3. 若配置了知识库，search_knowledge_base 检查用户已有积累',
      '4. 输出结构：',
      '## 问题定义与边界',
      '## 研究现状分梳（按子方向，逐篇一句话 + 链接）',
      '## 尚未解决的缺口（每条标注证据来源）',
      '## 可能的切入点（2–3 个，标「推断」，含风险评估）',
      '## 建议阅读清单（可询问是否批量 add_to_reading_list）',
      '文献信息必须来自工具返回；查不到的方向如实说明。',
    ].join('\n'),
  },
  {
    id: 'repro-plan',
    label: '复现计划',
    short: '复现',
    title: '把论文拆成可执行的复现清单',
    keywords: ['复现', '实现', '代码', 'reproduce', '怎么跑'],
    maxRounds: 14,
    prompt: [
      '用户想复现当前论文。流程：先读方法与实验设置页（search_paper_text: implementation|hyperparameter|training|dataset|code），再输出：',
      '## 复现难度评估（数据/算力/代码可得性，标页码或「文中未说明」）',
      '## 环境与数据准备清单',
      '## 分阶段实现计划（每阶段有可验证的中间产物）',
      '## 文中关键超参数表（只列原文写明的，标页码）',
      '## 风险点（文中含糊之处，逐条标「文中未说明」）',
      '可将阶段任务 add_research_todo 写入课题待办（询问用户）。',
      '若文中给了代码链接，用 fetch_url 看 README 补充信息。',
    ].join('\n'),
  },
]);

export function listResearchSkills() {
  return RESEARCH_SKILLS.map(({ id, label, short, title }) => ({ id, label, short, title }));
}

export function getResearchSkill(id) {
  const key = String(id || '').trim();
  return RESEARCH_SKILLS.find((s) => s.id === key) || null;
}

/** 按用户话术粗匹配技能；无强信号则 null（走通用科研助手）。 */
export function matchResearchSkill(question) {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return null;
  let best = null;
  let bestScore = 0;
  for (const skill of RESEARCH_SKILLS) {
    let score = 0;
    for (const kw of skill.keywords || []) {
      const k = String(kw).toLowerCase();
      if (k && q.includes(k)) score += k.length >= 4 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }
  return bestScore >= 2 ? best : null;
}

export function formatSkillPromptBlock(skill) {
  if (!skill?.prompt) return '';
  return [
    `【已激活科研技能：${skill.label || skill.id}】`,
    skill.title ? `目标：${skill.title}` : '',
    skill.prompt,
  ].filter(Boolean).join('\n');
}
