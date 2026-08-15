// 块级双击定位（vision 主路径无节点级 IR 几何时的文本锚点方案）。
// 思路：中文译文块里存活的「翻译不变量」——拉丁词、数字、引用号 [12]、公式号 (3)——
// 在原文 textLayer 的 span 序列里滑窗打分，找覆盖这些锚点最好的窗口。
// 全部纯函数，Node 可测；DOM 接线在 app.js。

/** 归一化：小写、去多余空白（保留字符位置无关的比较用途）。 */
export function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 从译文块提取锚 token：
 * - 拉丁词 ≥3 字符（方法名/数据集/变量名在译文中保留原文）
 * - 数字（含小数/百分数，实验数值最稳定）
 * - 引用号 [12] / [3,5] 与公式号 (12)
 * 返回去重列表（保持出现顺序），限量防超长块拖慢滑窗。
 */
export function extractAnchors(text, { maxAnchors = 24 } = {}) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const token = raw.toLowerCase();
    if (token.length < 2 || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  // 引用/公式号整体保留（比裸数字可信）
  for (const m of s.matchAll(/\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/g)) push(`[${m[1].replace(/\s+/g, '')}]`);
  for (const m of s.matchAll(/\((\d{1,3})\)/g)) push(`(${m[1]})`);
  // 拉丁词（≥3 字符；跳过纯大写罗马数字节标题这类噪声风险低，保留）
  for (const m of s.matchAll(/[A-Za-z][A-Za-z-]{2,}/g)) push(m[0]);
  // 数字：小数最可信，其次多位整数（1-2 位裸数字噪声大，跳过）
  for (const m of s.matchAll(/\d+\.\d+%?/g)) push(m[0]);
  for (const m of s.matchAll(/(?<![\d.])\d{3,}(?![\d.])/g)) push(m[0]);
  return out.slice(0, maxAnchors);
}

/** 单个 span 文本对锚点集的命中得分：长 token 权重高（≥6 字符 ×2）。 */
function spanHitScore(spanLower, anchors) {
  let score = 0;
  const hits = [];
  for (const anchor of anchors) {
    if (spanLower.includes(anchor)) {
      score += anchor.length >= 6 ? 2 : 1;
      hits.push(anchor);
    }
  }
  return { score, hits };
}

/**
 * 在 span 字符串数组里找覆盖锚点最好的连续窗口。
 * 返回 { start, end, score, matched } 或 null（分数不足视为没找到，避免乱跳）。
 * windowSize 自适应：锚点越多允许窗口越大（段落通常横跨多行 span）。
 */
export function findBestSpanWindow(spans, anchors, { minScore = 2, maxWindow = 8 } = {}) {
  const list = Array.isArray(spans) ? spans.map((s) => normalizeForMatch(s)) : [];
  const anchorList = (anchors || []).map((a) => String(a).toLowerCase()).filter(Boolean);
  if (!list.length || !anchorList.length) return null;

  // 每个 span 先算单独命中，滑窗时集合去重合并
  const perSpan = list.map((s) => spanHitScore(s, anchorList));
  const windowSize = Math.min(maxWindow, Math.max(2, Math.ceil(anchorList.length / 3)));

  let best = null;
  for (let start = 0; start < list.length; start += 1) {
    const matched = new Set();
    let end = start;
    for (; end < Math.min(list.length, start + windowSize); end += 1) {
      for (const hit of perSpan[end].hits) matched.add(hit);
    }
    let score = 0;
    for (const hit of matched) score += hit.length >= 6 ? 2 : 1;
    // 窗口内命中密度：稀疏大窗不如紧凑小窗
    if (score > 0) {
      const density = score / (end - start);
      if (!best || score > best.score || (score === best.score && density > best.density)) {
        best = { start, end: end - 1, score, density, matched: [...matched] };
      }
    }
  }
  if (!best || best.score < minScore) return null;
  // 收缩窗口：去掉首尾无命中的 span
  while (best.start < best.end && perSpan[best.start].score === 0) best.start += 1;
  while (best.end > best.start && perSpan[best.end].score === 0) best.end -= 1;
  return { start: best.start, end: best.end, score: best.score, matched: best.matched };
}

/**
 * 反向：PDF 双击选中的词 → 译文块索引。
 * blocks 是译文页各块的 textContent 数组；返回 { index, exact } 或 null。
 * 拉丁词/数字直接子串命中；命中多个块时选「块内出现位置最靠前」的。
 */
export function findBlockForWord(blocks, word) {
  const target = normalizeForMatch(word);
  if (!target || target.length < 2) return null;
  const list = Array.isArray(blocks) ? blocks.map((b) => normalizeForMatch(b)) : [];
  let best = null;
  for (let i = 0; i < list.length; i += 1) {
    const at = list[i].indexOf(target);
    if (at < 0) continue;
    if (!best || at < best.at) best = { index: i, at, exact: true };
  }
  return best ? { index: best.index, exact: true } : null;
}

/**
 * 位置比例回退：块在译文页里的垂直中心比例 → 原文页对应比例（无锚点可用时）。
 * 输入均为 DOMRect 形状 {top,height}（纯数据，便于测试）。
 */
export function positionRatioFallback(blockRect, transPageRect) {
  const pageH = Number(transPageRect?.height) || 0;
  if (pageH <= 0) return 0.5;
  const center = (Number(blockRect?.top) || 0) + (Number(blockRect?.height) || 0) / 2 - (Number(transPageRect?.top) || 0);
  return Math.min(1, Math.max(0, center / pageH));
}
