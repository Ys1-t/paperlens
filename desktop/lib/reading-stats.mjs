// 阅读统计（纯函数）：按天累计阅读分钟、翻译页数、估算 token；
// 生成周/总览摘要与最近 12 周热力图模型。存进 workspace.stats。

export const STATS_VERSION = 1;
export const STATS_MAX_DAYS = 400;

/** CJK≈1 token/字，其余≈4 字符/token —— 与扩展 usage-stats 同一启发式。 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    if (/[　-鿿豈-﫿＀-￯]/.test(ch)) cjk += 1;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

export function emptyStats() {
  return { version: STATS_VERSION, days: {} };
}

export function normalizeStats(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.days !== 'object') return emptyStats();
  const stats = emptyStats();
  const keys = Object.keys(raw.days || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  for (const key of keys.slice(-STATS_MAX_DAYS)) {
    const day = raw.days[key];
    if (!day || typeof day !== 'object') continue;
    stats.days[key] = {
      readMinutes: Math.max(0, Math.round(Number(day.readMinutes) || 0)),
      pagesTranslated: Math.max(0, Math.round(Number(day.pagesTranslated) || 0)),
      tokens: Math.max(0, Math.round(Number(day.tokens) || 0)),
      papersOpened: Math.max(0, Math.round(Number(day.papersOpened) || 0)),
      agentAsks: Math.max(0, Math.round(Number(day.agentAsks) || 0)),
    };
  }
  return stats;
}

export function dayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 记一笔活动。kind: read-minutes | page-translated | tokens | paper-opened | agent-ask
 */
export function recordActivity(stats, kind, amount = 1, now = Date.now()) {
  const next = normalizeStats(stats);
  const key = dayKey(now);
  const day = next.days[key] || {
    readMinutes: 0, pagesTranslated: 0, tokens: 0, papersOpened: 0, agentAsks: 0,
  };
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (kind === 'read-minutes') day.readMinutes += n;
  else if (kind === 'page-translated') day.pagesTranslated += n;
  else if (kind === 'tokens') day.tokens += n;
  else if (kind === 'paper-opened') day.papersOpened += n;
  else if (kind === 'agent-ask') day.agentAsks += n;
  else return next;
  next.days[key] = day;
  // 容量控制：只留最近 STATS_MAX_DAYS 天
  const keys = Object.keys(next.days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - STATS_MAX_DAYS))) delete next.days[old];
  return next;
}

/** 汇总窗口（默认最近 7 天）。 */
export function summarizeStats(stats, { days = 7, now = Date.now() } = {}) {
  const s = normalizeStats(stats);
  const out = { readMinutes: 0, pagesTranslated: 0, tokens: 0, papersOpened: 0, agentAsks: 0, activeDays: 0 };
  for (let i = 0; i < days; i += 1) {
    const day = s.days[dayKey(now - i * 86400000)];
    if (!day) continue;
    out.readMinutes += day.readMinutes;
    out.pagesTranslated += day.pagesTranslated;
    out.tokens += day.tokens;
    out.papersOpened += day.papersOpened;
    out.agentAsks += day.agentAsks;
    if (day.readMinutes || day.pagesTranslated || day.agentAsks) out.activeDays += 1;
  }
  return out;
}

/**
 * 最近 N 周热力图模型：weeks[w][d] = { key, level 0-4, minutes }。
 * 列为周（旧→新）、行为周一→周日，GitHub 风格。
 */
export function heatmapModel(stats, { weeks = 12, now = Date.now() } = {}) {
  const s = normalizeStats(stats);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  // 定位本周周一
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const grid = [];
  let max = 0;
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const col = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(monday);
      date.setDate(monday.getDate() - w * 7 + d);
      if (date > today) { col.push(null); continue; }
      const key = dayKey(date.getTime());
      const day = s.days[key];
      const minutes = (day?.readMinutes || 0) + (day?.pagesTranslated || 0) * 2;
      max = Math.max(max, minutes);
      col.push({ key, minutes });
    }
    grid.push(col);
  }
  for (const col of grid) {
    for (const cell of col) {
      if (!cell) continue;
      cell.level = cell.minutes === 0 ? 0
        : cell.minutes >= max * 0.75 ? 4
          : cell.minutes >= max * 0.5 ? 3
            : cell.minutes >= max * 0.25 ? 2 : 1;
    }
  }
  return { grid, max };
}

/** 每百万 token 单价 → 累计估算花费（输入输出合并粗估）。 */
export function estimateCost(stats, pricePerMTokens = 0) {
  const total = summarizeStats(stats, { days: STATS_MAX_DAYS });
  const price = Number(pricePerMTokens) || 0;
  return { tokens: total.tokens, cost: price > 0 ? (total.tokens / 1e6) * price : 0 };
}
