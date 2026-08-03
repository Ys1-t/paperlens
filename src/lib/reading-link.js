function normalizedBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [x0, y0, x1, y1] = value.map(Number);
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

/** Return validated fragment boxes, falling back to the legacy union bbox. */
export function readingTargetBoxes(entry) {
  const fragments = Array.isArray(entry?.bboxes)
    ? entry.bboxes.map(normalizedBbox).filter(Boolean)
    : [];
  if (fragments.length) return fragments;
  const bbox = normalizedBbox(entry?.bbox);
  return bbox ? [bbox] : [];
}

function normalizedRotation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return ((Math.round(numeric / 90) * 90) % 360 + 360) % 360;
}

/** Convert a point on the rotated PDF.js viewport back to unrotated Page IR space. */
export function displayPointToIr(point, rotation = 0) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  switch (normalizedRotation(rotation)) {
    case 90: return { x: y, y: 1 - x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}

/** Convert an unrotated Page IR box to the rotated PDF.js viewport space. */
export function irBoxToDisplay(value, rotation = 0) {
  const box = normalizedBbox(value);
  if (!box) return null;
  const [x0, y0, x1, y1] = box;
  switch (normalizedRotation(rotation)) {
    case 90: return [1 - y1, x0, 1 - y0, x1];
    case 180: return [1 - x1, 1 - y1, 1 - x0, 1 - y0];
    case 270: return [y0, 1 - x1, y1, 1 - x0];
    default: return box;
  }
}

function pointDistanceSquared(box, point) {
  const [x0, y0, x1, y1] = box;
  const dx = point.x < x0 ? x0 - point.x : (point.x > x1 ? point.x - x1 : 0);
  const dy = point.y < y0 ? y0 - point.y : (point.y > y1 ? point.y - y1 : 0);
  return dx * dx + dy * dy;
}

/** Pick the most precise IR node for a normalized point on the source PDF page. */
export function chooseClosestReadingTarget(entries, point, { maxDistance = 0.04 } = {}) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < 0 || x > 1 || y < 0 || y > 1) return null;

  let best = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const boxes = readingTargetBoxes(entry);
    if (!id || !boxes.length) continue;
    let boxBest = null;
    for (const bbox of boxes) {
      const [x0, y0, x1, y1] = bbox;
      const contains = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const area = (x1 - x0) * (y1 - y0);
      const distance = pointDistanceSquared(bbox, { x, y });
      const fragment = { contains, area, distance };
      if (!boxBest
        || (fragment.contains && !boxBest.contains)
        || (fragment.contains === boxBest.contains
          && (fragment.contains
            ? fragment.area < boxBest.area
            : fragment.distance < boxBest.distance
              || (fragment.distance === boxBest.distance && fragment.area < boxBest.area)))) {
        boxBest = fragment;
      }
    }
    const { contains, area, distance } = boxBest;
    const candidate = { id, contains, area, distance };
    if (!best
      || (candidate.contains && !best.contains)
      || (candidate.contains === best.contains
        && (candidate.contains
          ? candidate.area < best.area
          : candidate.distance < best.distance
            || (candidate.distance === best.distance && candidate.area < best.area)))) {
      best = candidate;
    }
  }
  if (!best) return null;
  const limit = Number(maxDistance);
  if (!best.contains && (!Number.isFinite(limit) || limit < 0 || best.distance > limit * limit)) {
    return null;
  }
  return best.id;
}

// ---------------------------------------------------------------------------
// 两栏滚动联动（原文 PDF ↔ 译文面板）的纯函数核心。
// 抽成纯函数便于单测：只吃「矩形数据 + 视口顶部坐标」，不碰 DOM，
// 由 viewer.js 负责把 getBoundingClientRect 结果喂进来。
// ---------------------------------------------------------------------------

/**
 * 找出某一栏当前的「阅读锚点」：第一个下缘越过视口顶部的元素（即当前可视首个
 * 页/段），并给出视口顶部落在该元素内部的比例，用于跨栏对应同一阅读位置。
 * rects 为按阅读顺序排列的 { top, bottom, height } 数组，坐标同 viewportTop。
 */
export function findColumnAnchor(rects, viewportTop) {
  const list = Array.isArray(rects) ? rects : [];
  const top = Number(viewportTop) || 0;
  for (let index = 0; index < list.length; index += 1) {
    const rect = list[index];
    if (!rect) continue;
    const bottom = Number.isFinite(rect.bottom)
      ? rect.bottom
      : Number(rect.top) + Number(rect.height || 0);
    if (bottom > top + 1) {
      const height = Math.max(
        1,
        Number.isFinite(rect.height) ? rect.height : bottom - Number(rect.top),
      );
      const ratio = Math.min(1, Math.max(0, (top - Number(rect.top)) / height));
      return { index, ratio };
    }
  }
  return { index: Math.max(0, list.length - 1), ratio: 0 };
}

/**
 * 已知目标栏中对应元素的矩形与锚点，算出需要叠加到 scrollTop 的位移，使目标元素
 * 的同一比例位置对齐到该栏视口顶部。返回值加到 col.scrollTop 即可。
 */
export function anchorScrollDelta(rect, anchor, viewportTop) {
  if (!rect) return 0;
  const height = Math.max(
    1,
    Number.isFinite(rect.height) ? rect.height : Number(rect.bottom) - Number(rect.top),
  );
  const ratio = Math.min(1, Math.max(0, Number(anchor?.ratio) || 0));
  return (Number(rect.top) + ratio * height) - (Number(viewportTop) || 0);
}

/**
 * 滚动联动防抖闸门：用「时间窗抑制」而非鼠标悬停来打断 A→B→B→A 回声死循环。
 * 当一栏因联动被程序化滚动时，先 suppress(该栏)，其 scroll 事件在窗口内被忽略，
 * 因此不会反向再驱动对侧。时间窗自动过期，永远不会「卡死」导致真实滚动被吞。
 * now 可注入以便单测；windowMs 覆盖一次程序化滚动触发的一到多个 scroll 回声。
 */
export function createScrollSyncGuard({ now = () => Date.now(), windowMs = 120 } = {}) {
  const suppressedUntil = new Map();
  return {
    suppress(side, ms = windowMs) { suppressedUntil.set(side, now() + ms); },
    isSuppressed(side) { return now() < (suppressedUntil.get(side) || 0); },
    clear() { suppressedUntil.clear(); },
  };
}
