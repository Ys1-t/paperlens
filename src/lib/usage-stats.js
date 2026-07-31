// Token 用量统计（估算）：按字符启发式估算每次翻译/对话的输入输出 token，
// 累计到 chrome.storage.local，设置页展示并可按单价折算花费。
// 定位是**预算参考**——不请求 stream usage 字段（部分中转站不支持），
// 也不阻塞翻译主流程：所有写入失败静默。

export const USAGE_STORAGE_KEY = 'paperlens.usageStats.v1';
/** 整页视觉翻译的图片 token 开销粗估（高清页位图，随模型不同 500–2000 不等）。 */
export const IMAGE_TOKEN_ESTIMATE = 1100;
/** system prompt + 消息包装的固定开销粗估。 */
export const PROMPT_OVERHEAD_TOKENS = 600;
const MAX_DAYS = 45;

function defaultArea() {
  return globalThis.chrome?.storage?.local || null;
}

/**
 * 字符启发式：CJK 每字 ≈ 1 token，其余每 4 字符 ≈ 1 token。
 * 对学术英文原文/中文译文的混排足够做数量级估算。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    if (/[　-鿿豈-﫿＀-￯]/.test(ch)) cjk += 1;
  }
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

/** 估算一次翻译/对话请求的输入输出 token。 */
export function estimateRequestTokens({ text = '', full = '', image = false, extraPrompt = '' } = {}) {
  const promptTokens = estimateTokens(text) + estimateTokens(extraPrompt)
    + PROMPT_OVERHEAD_TOKENS + (image ? IMAGE_TOKEN_ESTIMATE : 0);
  return { promptTokens, completionTokens: estimateTokens(full) };
}

export function emptyUsageStats() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, days: {} };
}

function normalizeUsageStats(raw) {
  const base = emptyUsageStats();
  if (!raw || typeof raw !== 'object') return base;
  base.requests = Math.max(0, Math.round(Number(raw.requests) || 0));
  base.promptTokens = Math.max(0, Math.round(Number(raw.promptTokens) || 0));
  base.completionTokens = Math.max(0, Math.round(Number(raw.completionTokens) || 0));
  if (raw.days && typeof raw.days === 'object') {
    for (const [day, val] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !val) continue;
      base.days[day] = {
        requests: Math.max(0, Math.round(Number(val.requests) || 0)),
        promptTokens: Math.max(0, Math.round(Number(val.promptTokens) || 0)),
        completionTokens: Math.max(0, Math.round(Number(val.completionTokens) || 0)),
      };
    }
  }
  return base;
}

/** 纯 reducer：累加一次采样（含当日分桶），并裁剪过老的天。 */
export function accumulateUsage(stats, { promptTokens = 0, completionTokens = 0, day } = {}) {
  const next = normalizeUsageStats(stats);
  const p = Math.max(0, Math.round(Number(promptTokens) || 0));
  const c = Math.max(0, Math.round(Number(completionTokens) || 0));
  const d = day || new Date().toISOString().slice(0, 10);
  next.requests += 1;
  next.promptTokens += p;
  next.completionTokens += c;
  const bucket = next.days[d] || { requests: 0, promptTokens: 0, completionTokens: 0 };
  bucket.requests += 1;
  bucket.promptTokens += p;
  bucket.completionTokens += c;
  next.days[d] = bucket;
  const days = Object.keys(next.days).sort();
  for (const stale of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete next.days[stale];
  return next;
}

export async function loadUsageStats(area = defaultArea()) {
  try {
    const stored = await area?.get?.(USAGE_STORAGE_KEY);
    return normalizeUsageStats(stored?.[USAGE_STORAGE_KEY]);
  } catch {
    return emptyUsageStats();
  }
}

/** 读改写累计一次采样；任何失败静默（统计绝不影响翻译）。 */
export async function addUsageSample(sample, area = defaultArea()) {
  try {
    const next = accumulateUsage(await loadUsageStats(area), sample);
    await area?.set?.({ [USAGE_STORAGE_KEY]: next });
    return next;
  } catch {
    return null;
  }
}

export async function resetUsageStats(area = defaultArea()) {
  try { await area?.set?.({ [USAGE_STORAGE_KEY]: emptyUsageStats() }); } catch { /* noop */ }
}

/** 1234567 → "123.5万"；小数值原样。中文界面用「万」直观。 */
export function formatTokenCount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/** 按 ¥/百万 token 单价折算成本；单价缺失返回 null。 */
export function estimateCost(stats, { inPricePerM, outPricePerM } = {}) {
  const pin = Number(inPricePerM);
  const pout = Number(outPricePerM);
  if (!Number.isFinite(pin) && !Number.isFinite(pout)) return null;
  const s = normalizeUsageStats(stats);
  return (s.promptTokens / 1e6) * (Number.isFinite(pin) ? pin : 0)
    + (s.completionTokens / 1e6) * (Number.isFinite(pout) ? pout : 0);
}
