// 本页洞察（本地、即时、零 API）：从原文/译文抽符号、数值、章节线索与疑似主张。
// 研究生读页时钉在侧栏；Agent 可再精炼，但侧栏默认不依赖网络。

const CLAIM_CUES = [
  /we propose/i, /we present/i, /we introduce/i, /we show/i, /we prove/i,
  /our contribution/i, /this paper/i, /in this work/i,
  /本文提出/, /本文证明/, /我们提出/, /主要贡献/, /实验表明/, /结果表明/,
];

const SKIP_ACRONYMS = new Set([
  'THE', 'AND', 'FOR', 'WITH', 'FROM', 'THIS', 'THAT', 'ARE', 'WAS', 'WERE',
  'PDF', 'HTTP', 'HTTPS', 'DOI', 'URL', 'IEEE', 'ACM', 'VOL', 'NO',
]);

/**
 * 抽符号 / 缩写：拉丁大写缩写、带下标风格的标识、简单希腊名。
 */
export function extractSymbols(text, { max = 16 } = {}) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (raw, kind) => {
    const t = String(raw || '').trim();
    if (t.length < 2 || t.length > 24) return;
    const key = t.toLowerCase();
    if (seen.has(key) || SKIP_ACRONYMS.has(t.toUpperCase())) return;
    seen.add(key);
    out.push({ token: t, kind });
  };
  for (const m of s.matchAll(/\b[A-Z]{2,6}\b/g)) push(m[0], 'acronym');
  for (const m of s.matchAll(/\b[A-Za-z][A-Za-z0-9]{0,6}_[A-Za-z0-9]{1,6}\b/g)) push(m[0], 'symbol');
  for (const m of s.matchAll(/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|omega|phi|psi)\b/gi)) {
    push(`\\${m[1].toLowerCase()}`, 'greek');
  }
  // 中文里夹的方法名式 CapWord
  for (const m of s.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+){1,3}\b/g)) push(m[0], 'term');
  return out.slice(0, max);
}

/** 抽显著数值（指标、百分比、年份以外的实验数字）。 */
export function extractKeyNumbers(text, { max = 12 } = {}) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (raw, ctx) => {
    const t = String(raw).trim();
    if (seen.has(t)) return;
    // 跳过纯年份 19xx/20xx 单独出现
    if (/^(19|20)\d{2}$/.test(t)) return;
    seen.add(t);
    out.push({ value: t, context: String(ctx || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
  };
  for (const m of s.matchAll(/(\d+\.\d+\s*%|\d+\s*%|\d+\.\d{2,})/g)) {
    const i = m.index || 0;
    push(m[1], s.slice(Math.max(0, i - 30), i + m[1].length + 30));
  }
  return out.slice(0, max);
}

/** 从译文/原文抽疑似主张句（规则启发，标 confidence）。 */
export function extractClaimCandidates(text, { max = 8 } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  // 按句号/分号/换行粗切
  const parts = s.split(/(?<=[。．.!?；;])\s+|\n+/).map((p) => p.trim()).filter((p) => p.length > 12);
  const out = [];
  for (const sent of parts) {
    let score = 0;
    for (const re of CLAIM_CUES) if (re.test(sent)) score += 2;
    if (/\b(outperform|state-of-the-art|SOTA|significantly|ablation)\b/i.test(sent)) score += 1;
    if (/(优于|显著|证明了|验证了|首次)/.test(sent)) score += 1;
    if (score <= 0) continue;
    out.push({
      text: sent.slice(0, 220),
      score,
      confidence: score >= 3 ? 'high' : 'medium',
    });
    if (out.length >= max) break;
  }
  // 若没有 cue，退回前 2 个长句作「待核实」
  if (!out.length) {
    for (const sent of parts.slice(0, 2)) {
      if (sent.length < 20) continue;
      out.push({ text: sent.slice(0, 220), score: 0, confidence: 'low' });
    }
  }
  return out;
}

/** 章节/结构线索 */
export function extractSectionCues(text) {
  const s = String(text || '');
  const cues = [];
  const patterns = [
    [/\bAbstract\b/i, '摘要'],
    [/\bIntroduction\b/i, '引言'],
    [/\bRelated Work\b/i, '相关工作'],
    [/\bMethod/i, '方法'],
    [/\bExperiment/i, '实验'],
    [/\bConclusion\b/i, '结论'],
    [/\bAlgorithm\s+\d+/i, '算法'],
    [/\bTable\s+\d+/i, '表格'],
    [/\bFigure\s+\d+/i, '图'],
    [/摘要/, '摘要'],
    [/引言|介绍/, '引言'],
    [/相关工作/, '相关工作'],
    [/实验/, '实验'],
    [/结论/, '结论'],
  ];
  for (const [re, label] of patterns) {
    if (re.test(s) && !cues.includes(label)) cues.push(label);
  }
  return cues;
}

/**
 * 汇总一页洞察。
 * @param {{ sourceText?: string, translationText?: string, page?: number }} input
 */
export function buildPageInsight(input = {}) {
  const page = Math.max(1, Math.round(Number(input.page) || 1));
  const source = String(input.sourceText || '');
  const trans = String(input.translationText || '');
  const blob = trans || source;
  return {
    page,
    sectionCues: extractSectionCues(blob + '\n' + source),
    symbols: extractSymbols(source + '\n' + trans),
    numbers: extractKeyNumbers(blob),
    claims: extractClaimCandidates(trans || source),
    hasTranslation: Boolean(trans.trim()),
    charCount: source.replace(/\s+/g, '').length,
  };
}

/** 生成「投稿 contribution bullets」草稿（纯本地，可再交 Agent 润色）。 */
export function contributionBulletsFromClaims(claims, { max = 4 } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const bullets = [];
  for (const c of list) {
    const t = String(c?.text || c || '').replace(/\s+/g, ' ').trim();
    if (t.length < 16) continue;
    // 压成 contribution 口吻
    let b = t;
    b = b.replace(/^(In this paper,?\s*|本文中?，?|我们|We\s+)/i, '');
    if (!/^(propose|present|show|introduce|提出|证明|设计)/i.test(b)) {
      b = `提出/验证：${b}`;
    }
    bullets.push(b.slice(0, 180));
    if (bullets.length >= max) break;
  }
  return bullets;
}

/** 对照队列条目规范化 */
export function normalizeCompareItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim().slice(0, 300);
  if (!title) return null;
  return {
    id: String(raw.id || raw.arxivId || '').slice(0, 64) || `c${Math.abs(hash(title)).toString(36)}`,
    title,
    arxivId: String(raw.arxivId || '').slice(0, 40),
    summary: String(raw.summary || '').slice(0, 800),
    score: Number(raw.score) || 0,
    addedAt: Number(raw.addedAt) || 0,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function normalizeCompareQueue(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeCompareItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.slice(0, 20);
}

export function addToCompareQueue(list, paper, now = Date.now()) {
  const q = normalizeCompareQueue(list);
  const item = normalizeCompareItem({ ...paper, addedAt: now });
  if (!item) return { queue: q, added: false };
  if (q.some((x) => x.id === item.id || (item.arxivId && x.arxivId === item.arxivId))) {
    return { queue: q, added: false };
  }
  return { queue: [item, ...q].slice(0, 20), added: true };
}

export function removeFromCompareQueue(list, id) {
  return normalizeCompareQueue(list).filter((x) => x.id !== String(id || ''));
}

/** 生成批量对照的 Agent 提示 */
export function buildBatchComparePrompt(openPaperTitle, queue) {
  const items = normalizeCompareQueue(queue);
  const lines = [
    `请将【当前打开的论文】《${openPaperTitle || '（未命名）'}》与下列雷达候选做硬对照。`,
    '对每篇输出：关联强度(强/中/弱) · 可组合点 · 是否值得精读 · 一句话理由。',
    '最后给「建议精读排序」。设定不同不要硬比 SOTA 数字。',
    '',
  ];
  items.forEach((it, i) => {
    lines.push(`### 候选 ${i + 1}: ${it.title}`);
    if (it.arxivId) lines.push(`arXiv: ${it.arxivId}`);
    if (it.summary) lines.push(`摘要: ${it.summary.slice(0, 400)}`);
    lines.push('');
  });
  return lines.join('\n');
}
