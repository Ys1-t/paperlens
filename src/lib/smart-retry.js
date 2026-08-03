// Smart auto-retry for transient translation failures (disconnect, 429, 5xx, timeout).

export const SMART_RETRY_MAX_ATTEMPTS = 3;
export const SMART_RETRY_BASE_MS = 2000;
export const SMART_RETRY_MAX_MS = 30000;

/** Errors that are worth automatic retry with backoff. */
export function isRetriableTranslationError(error) {
  const raw = String(error?.message || error || '');
  if (!raw.trim()) return false;
  if (/cancelled|已取消|Document changed/i.test(raw)) return false;
  if (/api\s*key|尚未配置|401|403|unauthori[sz]ed|forbidden|鉴权/i.test(raw)) return false;
  if (/placeholder|占位符|公式.*校验/i.test(raw)) return false;
  return (
    /与后台|连接已断开|后台.*重载|extension context|receiving end|message port closed|disconnected port|ping 超时/i.test(raw)
    || /429|rate.?limit|quota|额度|频率|繁忙/i.test(raw)
    || /timed?\s*out|timeout|超时|无响应/i.test(raw)
    || /failed to fetch|network|fetch failed|load failed|连接.*中断/i.test(raw)
    || /\b5\d\d\b|bad gateway|service unavailable|模型服务暂时不可用/i.test(raw)
    || /translation_queue_timeout|排队(?:等待)?超时/i.test(raw)
    // Vision model dumped CoT / repetition instead of translation — worth another attempt.
    || /自言自语|推理过程|重复循环|重复段落|输出异常|未产出可读译文|目标语言|残留.*英文|LaTeX.*定界|公式.*定界|公式未包|花括号.*不完整|代码围栏|算法伪代码|图形区域定位|表格区域定位|引用标记.*漏译|方程编号.*漏译|关键数值.*漏译|数据集.*漏译|视觉模型拒绝|疑似漏段|译文长度异常|复制了图片|model-self-talk|model-refusal|repetition-loop|english-residual|source-coverage|bare-latex|code-fence-damaged|math-brace-damaged|algorithm-structure-damaged|figure-structure-missing|table-structure-missing|citation-anchor-loss|equation-number-loss|numeric-anchor-loss|term-anchor-loss/i.test(raw)
  );
}

/** Exponential backoff: attempt 0 → base, 1 → 2×base, … capped at maxMs. */
export function nextRetryDelayMs(attempt, {
  baseMs = SMART_RETRY_BASE_MS,
  maxMs = SMART_RETRY_MAX_MS,
} = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const base = Math.max(200, Number(baseMs) || SMART_RETRY_BASE_MS);
  const cap = Math.max(base, Number(maxMs) || SMART_RETRY_MAX_MS);
  return Math.min(cap, base * (2 ** n));
}

export function shouldScheduleAutoRetry({
  attempt = 0,
  maxAttempts = SMART_RETRY_MAX_ATTEMPTS,
  error,
} = {}) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const max = Math.max(1, Math.floor(Number(maxAttempts) || SMART_RETRY_MAX_ATTEMPTS));
  if (n >= max) return false;
  return isRetriableTranslationError(error);
}

export function formatAutoRetryLabel(attempt, delayMs) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const sec = Math.max(1, Math.ceil((Number(delayMs) || 0) / 1000));
  return `${sec}s 后自动重试（第 ${n} 次）`;
}
