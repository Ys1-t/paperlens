// 前沿论文雷达：按兴趣抓取 arXiv 最新提交，可解释打分 + 分层推荐。
// 抓取在主进程；打分/排序纯函数可测。

import { parseArxivAtom } from './web-tools.mjs';

const UA = 'PaperLens-Desktop/0.2 (research radar)';

/** 组装 arXiv 查询 URL */
export function buildRadarQueryUrl({ categories = [], keywords = [], maxResults = 40 } = {}) {
  const cats = categories.filter(Boolean).map((c) => `cat:${c}`);
  let query = cats.join('+OR+');
  if (!query) {
    const kw = keywords.filter(Boolean).slice(0, 4).join(' ');
    query = encodeURIComponent(`all:${kw || 'machine learning'}`);
  }
  const n = Math.min(80, Math.max(10, Number(maxResults) || 40));
  return 'https://export.arxiv.org/api/query?search_query='
    + query
    + `&sortBy=submittedDate&sortOrder=descending&max_results=${n}`;
}

/**
 * 可解释打分（0–100）+ 原因列表。
 * - 关键词：标题 +5 / 摘要 +2 / 短语额外 +3（每词）
 * - 分类命中：+8
 * - 新鲜度：≤1天 +12，≤3天 +8，≤7天 +4
 * - 无关键词时用分类+新鲜度，避免「全员 16 分」假象；并标 needsKeywords
 */
export function scoreRadarPaper(paper, interests = {}, now = Date.now()) {
  const keywords = Array.isArray(interests.keywords) ? interests.keywords : [];
  const categories = Array.isArray(interests.categories) ? interests.categories : [];
  const title = String(paper?.title || '').toLowerCase();
  const summary = String(paper?.summary || '').toLowerCase();
  const primaryCat = String(paper?.primaryCategory || paper?.category || '').toLowerCase();
  const cats = [
    primaryCat,
    ...(Array.isArray(paper?.categories) ? paper.categories : []).map((c) => String(c).toLowerCase()),
  ].filter(Boolean);

  let raw = 0;
  const reasons = [];
  const matchedKeywords = [];

  for (const rawKw of keywords) {
    const kw = String(rawKw || '').trim().toLowerCase();
    if (!kw) continue;
    let local = 0;
    if (title.includes(kw)) {
      local += 5;
      reasons.push(`标题含「${rawKw}」`);
    }
    if (summary.includes(kw)) {
      local += 2;
      if (!title.includes(kw)) reasons.push(`摘要含「${rawKw}」`);
    }
    if (local && kw.includes(' ')) {
      local += 3;
      reasons.push(`短语命中「${rawKw}」`);
    }
    if (local) {
      matchedKeywords.push(rawKw);
      raw += local;
    }
  }

  // 分类命中
  let catHit = false;
  for (const want of categories) {
    const w = String(want || '').toLowerCase();
    if (w && cats.some((c) => c === w || c.startsWith(`${w}.`) || w.startsWith(c))) {
      catHit = true;
      raw += 8;
      reasons.push(`分类 ${want}`);
      break;
    }
  }

  // 新鲜度
  const published = Date.parse(String(paper?.published || ''));
  let freshness = 0;
  if (Number.isFinite(published)) {
    const days = (now - published) / 86400000;
    if (days <= 1) { freshness = 12; reasons.push('今日新提交'); }
    else if (days <= 3) { freshness = 8; reasons.push('近 3 日'); }
    else if (days <= 7) { freshness = 4; reasons.push('近一周'); }
    raw += freshness;
  }

  const needsKeywords = keywords.length === 0;
  // 无关键词时：只靠分类+新鲜度，映射到 20–55 的「浏览分」，避免全员同分
  let score;
  if (needsKeywords) {
    score = Math.min(55, 15 + raw * 2 + (catHit ? 5 : 0) + Math.min(10, (paper?.authors?.length || 0)));
  } else {
    // 有关键词：raw 通常 0–40，映射到 0–100
    score = Math.min(100, Math.round(raw * 4.2));
    if (matchedKeywords.length === 0 && raw > 0) {
      // 只有新鲜度/分类
      score = Math.min(45, score);
    }
  }

  // 展示用星级 0–5
  const stars = score >= 80 ? 5 : score >= 65 ? 4 : score >= 45 ? 3 : score >= 25 ? 2 : score > 0 ? 1 : 0;

  return {
    score,
    stars,
    matchedKeywords,
    reasons: reasons.slice(0, 6),
    needsKeywords,
    freshnessDays: Number.isFinite(published) ? Math.max(0, (now - published) / 86400000) : null,
  };
}

/** 相对排序：同批内用百分位拉开差距，避免「全是 16」 */
export function calibrateScores(scoredList) {
  const list = Array.isArray(scoredList) ? [...scoredList] : [];
  if (list.length < 2) return list;
  const raws = list.map((p) => Number(p.score) || 0);
  const min = Math.min(...raws);
  const max = Math.max(...raws);
  if (max <= min) {
    // 完全同分：按时间微扰
    return list.map((p, i) => ({
      ...p,
      score: Math.max(1, 40 - i),
      rankNote: '同分，按新近排序',
    }));
  }
  return list.map((p) => {
    const t = (Number(p.score) - min) / (max - min);
    const calibrated = Math.round(12 + t * 88);
    return { ...p, score: calibrated, scoreRaw: p.score };
  });
}

/** 打分 + 校准 + 排序 + 去重 */
export function rankRadarPapers(papers, interests, { seenIds = [], now = Date.now() } = {}) {
  const seen = new Set((seenIds || []).map(String));
  const out = [];
  const dedup = new Set();
  for (const paper of Array.isArray(papers) ? papers : []) {
    const id = String(paper?.arxivId || paper?.title || '');
    if (!id || dedup.has(id)) continue;
    dedup.add(id);
    const scored = scoreRadarPaper(paper, interests, now);
    out.push({
      ...paper,
      ...scored,
      isNew: !seen.has(paper?.arxivId ? String(paper.arxivId) : id),
    });
  }
  const calibrated = calibrateScores(out);
  calibrated.sort((a, b) => (
    (b.isNew - a.isNew)
    || (b.score - a.score)
    || String(b.published || '').localeCompare(String(a.published || ''))
  ));
  // 分层：必读 / 值得扫 / 仅浏览
  return calibrated.map((p, i) => ({
    ...p,
    tier: p.score >= 70 ? 'must' : p.score >= 45 ? 'skim' : 'browse',
    rank: i + 1,
  }));
}

export async function fetchRadarPapers(interests, { maxResults = 40, fetchImpl = fetch } = {}) {
  const url = buildRadarQueryUrl({ ...interests, maxResults });
  const response = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error(`arXiv 雷达抓取失败：HTTP ${response.status}`);
  return parseArxivAtom(await response.text());
}

export function radarDigestMarkdown(ranked, { date = '', interests = {} } = {}) {
  const lines = [
    `# 前沿雷达日报${date ? ` · ${date}` : ''}`,
    '',
    interests?.keywords?.length ? `关键词：${interests.keywords.join('、')}` : '_未设关键词 — 相关度仅供浏览，建议补关键词_',
    interests?.categories?.length ? `分类：${interests.categories.join(', ')}` : '',
    '',
  ];
  const list = Array.isArray(ranked) ? ranked : [];
  const must = list.filter((p) => p.tier === 'must').slice(0, 5);
  const skim = list.filter((p) => p.tier === 'skim').slice(0, 8);
  // 若分层为空，仍输出分数最高的若干篇（避免日报空白）
  const fallback = (!must.length && !skim.length) ? list.slice(0, 8) : [];
  const section = (title, picks) => {
    if (!picks.length) return;
    lines.push(`## ${title}`, '');
    for (const paper of picks) {
      lines.push(`### ${paper.title}`);
      lines.push(`- 相关度 **${paper.score ?? 0}**${paper.reasons?.length ? ` · ${paper.reasons.join('；')}` : ''}`);
      lines.push(`- ${(paper.authors || []).slice(0, 5).join(', ')} · ${paper.published || '?'}`);
      if (paper.pdfUrl) lines.push(`- ${paper.pdfUrl}`);
      if (paper.summary) lines.push('', `> ${String(paper.summary).slice(0, 360)}`, '');
      lines.push('');
    }
  };
  section('今日必读候选', must);
  section('值得扫摘要', skim);
  section('本批排序靠前', fallback);
  if (!must.length && !skim.length && !fallback.length) {
    lines.push('_没有命中 — 请收紧分类或补充方向关键词（方法名/任务名比 “deep learning” 更有效）。_');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 从研究档案自动建议关键词（给 UI「一键填入」） */
export function suggestKeywordsFromProfile(profile = {}) {
  const blob = [profile.field, profile.direction, profile.goal].filter(Boolean).join(' ');
  if (!blob.trim()) return [];
  // 抽英文词与中文 2+ 字片段的简单启发
  const en = [...blob.matchAll(/[A-Za-z][A-Za-z0-9+_-]{2,}/g)].map((m) => m[0]);
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'using', 'based']);
  const out = [];
  const seen = new Set();
  for (const w of en) {
    const k = w.toLowerCase();
    if (stop.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

export const ARXIV_CATEGORY_PRESETS = Object.freeze([
  { id: 'cs.LG', label: '机器学习 cs.LG' },
  { id: 'cs.CL', label: 'NLP cs.CL' },
  { id: 'cs.CV', label: '视觉 cs.CV' },
  { id: 'cs.AI', label: 'AI cs.AI' },
  { id: 'cs.NE', label: '神经进化 cs.NE' },
  { id: 'cs.RO', label: '机器人 cs.RO' },
  { id: 'cs.IR', label: '信息检索 cs.IR' },
  { id: 'cs.SE', label: '软件工程 cs.SE' },
  { id: 'cs.CR', label: '安全 cs.CR' },
  { id: 'cs.MA', label: '多智能体 cs.MA' },
  { id: 'stat.ML', label: '统计 ML' },
  { id: 'math.OC', label: '优化 math.OC' },
  { id: 'eess.AS', label: '语音 eess.AS' },
  { id: 'eess.IV', label: '图像 eess.IV' },
  { id: 'q-bio.QM', label: '定量生物' },
]);
