// src/lib/blocks.js
// 把 PDF.js 的 textContent.items 归并为「按阅读顺序排列的段落/标题块」。
// 关键难点：双栏论文中，左右两栏同一高度的文字共享同一基线 Y，若只按基线聚行，
// 会把左栏行尾和右栏行首拼成一坨（例如 "promis- corresponding"）。因此必须：
//   1) 先从字形的 x 分布探测中缝（gutter）；
//   2) 把「跨中缝且中缝处有空隙」的行拆成左右两半；
//   3) 阅读顺序为：整宽行为界，段内先出左栏、再出右栏。
//
// 坐标：PDF 原点在左下角，transform=[a,b,c,d,e,f]，e=x（左），f=y（基线，从底部量起）。
// 统一转成从页顶量起的 baselineTop 便于排序。

export function extractBlocks(items, pageHeight, pageWidth, pageNum) {
  try {
    if (!items || !items.length) return [];
    const ph = Number.isFinite(pageHeight) ? pageHeight : (Number(pageHeight) || 0);

    const glyphs = normalizeGlyphs(items, ph);
    if (!glyphs.length) return [];

    const nonBlank = glyphs.filter((g) => !g.blank);
    if (!nonBlank.length) return [];
    const contentLeft = Math.min(...nonBlank.map((g) => g.x));
    const contentRight = Math.max(...nonBlank.map((g) => g.end));
    const contentWidth = Math.max(1, contentRight - contentLeft);

    const gutterX = detectGutter(glyphs, contentLeft, contentRight);

    const rawRows = groupRawRows(glyphs);
    const bodyFontSize = median(rawRows.map((r) => r.fontSize)) || 10;

    const lines = buildLines(rawRows, gutterX, contentWidth);
    if (!lines.length) return [];

    const ordered = orderLines(lines, gutterX != null);
    return mergeBlocks(ordered, { bodyFontSize, pageNum });
  } catch (e) {
    console.warn('[PL-BLOCKS] extract failed on page', pageNum, e);
    return [];
  }
}

// --- 1) 字形规范化 --------------------------------------------------------
function normalizeGlyphs(items, ph) {
  const glyphs = [];
  for (const it of items) {
    if (!it) continue;
    const s = it.str;
    if (s == null || s === '') continue;
    const t = it.transform;
    if (!t || t.length < 6) continue;
    const fontSize = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
    const x = t[4];
    if (!Number.isFinite(x)) continue;
    const baselineTop = ph - t[5];
    if (!Number.isFinite(baselineTop)) continue;
    const w = Number.isFinite(it.width) ? it.width : 0;
    glyphs.push({ str: s, x, end: x + w, baselineTop, fontSize, blank: s.trim() === '' });
  }
  return glyphs;
}

// --- 2) 中缝检测（基于字形 x 覆盖直方图）---------------------------------
// 在页面中部寻找一条竖直空白带：两侧都有大量文字、带内几乎无文字。
function detectGutter(glyphs, contentLeft, contentRight) {
  const width = contentRight - contentLeft;
  if (width <= 1) return null;
  const nonBlank = glyphs.filter((g) => !g.blank);
  if (nonBlank.length < 30) return null; // 文字太少，不像双栏正文页

  const BINS = 120;
  const binW = width / BINS;
  const cover = new Array(BINS).fill(0);
  for (const g of nonBlank) {
    let a = Math.floor((g.x - contentLeft) / binW);
    let b = Math.floor((g.end - contentLeft) / binW);
    a = Math.max(0, Math.min(BINS - 1, a));
    b = Math.max(0, Math.min(BINS - 1, b));
    for (let i = a; i <= b; i++) cover[i]++;
  }

  const positive = cover.filter((c) => c > 0).sort((x, y) => x - y);
  const medianCov = positive.length ? positive[positive.length >> 1] : 0;
  const thresh = Math.max(1, medianCov * 0.12);

  // 只在中部 [33%,67%] 找最宽的低覆盖连续带
  const lo = Math.floor(BINS * 0.33), hi = Math.ceil(BINS * 0.67);
  let bestCenter = null, bestRun = 0, runStart = -1;
  const closeRun = (endExclusive) => {
    if (runStart < 0) return;
    const run = endExclusive - runStart;
    if (run > bestRun) { bestRun = run; bestCenter = (runStart + endExclusive - 1) / 2; }
    runStart = -1;
  };
  for (let i = lo; i <= hi; i++) {
    if (cover[i] <= thresh) { if (runStart < 0) runStart = i; }
    else closeRun(i);
  }
  closeRun(hi + 1);

  if (bestCenter == null || bestRun < 1) return null;
  const gutterX = contentLeft + (bestCenter + 0.5) * binW;

  // 两侧都要有足够文字，才认定为双栏
  let left = 0, right = 0;
  for (const g of nonBlank) {
    if (g.end <= gutterX) left++;
    else if (g.x >= gutterX) right++;
  }
  const total = nonBlank.length;
  if (left < total * 0.25 || right < total * 0.25) return null;
  return gutterX;
}

// --- 3) 按基线聚成原始行 --------------------------------------------------
function groupRawRows(glyphs) {
  const sorted = glyphs.slice().sort((a, b) => a.baselineTop - b.baselineTop || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const g of sorted) {
    if (cur && Math.abs(g.baselineTop - cur.baselineTop) <= Math.max(2, g.fontSize * 0.5)) {
      cur.glyphs.push(g);
      cur.baselineTop = (cur.baselineTop * (cur.glyphs.length - 1) + g.baselineTop) / cur.glyphs.length;
    } else {
      cur = { glyphs: [g], baselineTop: g.baselineTop };
      rows.push(cur);
    }
  }
  for (const r of rows) {
    r.glyphs.sort((a, b) => a.x - b.x);
    const nb = r.glyphs.filter((g) => !g.blank);
    r.fontSize = median(nb.map((g) => g.fontSize)) || (r.glyphs[0] ? r.glyphs[0].fontSize : 10);
  }
  return rows;
}

// --- 4) 行构建：在中缝处拆分「真正的双栏行」---------------------------------
// 判据：一行若横跨中缝两侧，只有当中缝附近存在「明显空隙」（远大于普通词间距）
// 才判定为双栏行并拆分；否则视为整宽行（标题/摘要连续横排）。
function buildLines(rawRows, gutterX, contentWidth) {
  const lines = [];
  for (const row of rawRows) {
    const gs = row.glyphs.filter((g) => !g.blank);
    if (!gs.length) continue;

    if (gutterX != null) {
      const leftPart = gs.filter((g) => g.end <= gutterX);
      const rightPart = gs.filter((g) => g.x >= gutterX);
      const spansBoth = leftPart.length && rightPart.length
        && Math.min(...gs.map((g) => g.x)) < gutterX
        && Math.max(...gs.map((g) => g.end)) > gutterX;

      if (spansBoth) {
        // 找中缝两侧最靠近的字形，看它们之间的空隙有多大
        const leftEdge = Math.max(...leftPart.map((g) => g.end));   // 左侧最右
        const rightEdge = Math.min(...rightPart.map((g) => g.x));   // 右侧最左
        const gap = rightEdge - leftEdge;
        const bigGap = gap > row.fontSize * 2.2;                    // 远大于普通词距 -> 双栏
        const gapStraddles = leftEdge <= gutterX && rightEdge >= gutterX;
        if (bigGap && gapStraddles) {
          lines.push(makeLine(leftPart, row.baselineTop, row.fontSize, 0, false));
          lines.push(makeLine(rightPart, row.baselineTop, row.fontSize, 1, false));
          continue;
        }
        // 否则：连续横排 -> 整宽行
        const line = makeLine(gs, row.baselineTop, row.fontSize, null, true);
        lines.push(line);
        continue;
      }
    }

    const line = makeLine(gs, row.baselineTop, row.fontSize, null, false);
    if (gutterX == null) {
      line.col = 0; line.full = false;
    } else {
      const spansWide = line.width > contentWidth * 0.6;
      if (spansWide) { line.full = true; line.col = null; }
      else { line.full = false; line.col = line.center < gutterX ? 0 : 1; }
    }
    lines.push(line);
  }
  return lines.filter((l) => l.text.trim() !== '');
}

function makeLine(glyphs, baselineTop, fontSize, col, full) {
  const left = Math.min(...glyphs.map((g) => g.x));
  const right = Math.max(...glyphs.map((g) => g.end));
  return {
    glyphs, baselineTop,
    left, right, center: (left + right) / 2, width: right - left,
    fontSize, col, full,
    text: joinGlyphs(glyphs, fontSize),
  };
}

function joinGlyphs(glyphs, fontSize) {
  let out = '';
  let prevEnd = null;
  for (const g of glyphs) {
    if (g.blank) { if (!out.endsWith(' ')) out += ' '; prevEnd = g.end; continue; }
    if (prevEnd != null) {
      const gap = g.x - prevEnd;
      if (gap > fontSize * 0.25 && !out.endsWith(' ')) out += ' ';
    }
    out += g.str;
    prevEnd = g.end;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// --- 5) 阅读顺序 ----------------------------------------------------------
// 整宽行为分段界；段内先输出左栏（自上而下）再输出右栏。
function orderLines(lines, hasColumns) {
  const byTop = (a, b) => a.baselineTop - b.baselineTop;
  if (!hasColumns) return lines.slice().sort(byTop);

  const sorted = lines.slice().sort(byTop);
  const out = [];
  let seg = [];
  const flush = () => {
    if (!seg.length) return;
    const L = seg.filter((l) => l.col === 0).sort(byTop);
    const R = seg.filter((l) => l.col === 1).sort(byTop);
    out.push(...L, ...R);
    seg = [];
  };
  for (const ln of sorted) {
    if (ln.full) { flush(); out.push(ln); }
    else seg.push(ln);
  }
  flush();
  return out;
}

// --- 6) 行 -> 段落/标题块 -------------------------------------------------
function mergeBlocks(lines, { bodyFontSize, pageNum }) {
  const blocks = [];
  let cur = null;
  let prev = null;

  const finalize = (b) => {
    b.text = b.text.replace(/\s+/g, ' ').trim();
    b.type = classify(b, bodyFontSize, pageNum);
    b.kind = isGraphicText(b.text) ? 'graphic' : 'text';   // graphic：整行公式/符号密集 -> 裁原图
    b.translatable = b.kind === 'text' && isTranslatable(b.text);
    b.id = `p${pageNum}b${blocks.length}`;
    b.page = pageNum;
    blocks.push(b);
  };

  for (const ln of lines) {
    const startNew =
      !cur ||
      (ln.baselineTop - prev.baselineTop) > bodyFontSize * 1.55 ||
      Math.abs(ln.fontSize - prev.fontSize) > bodyFontSize * 0.25 ||
      (prev.col != null && ln.col != null && ln.col !== prev.col) ||
      (Boolean(prev.full) !== Boolean(ln.full)) ||
      (ln.baselineTop < prev.baselineTop - bodyFontSize); // 回到页面上方 -> 新块（换栏）

    if (startNew) {
      if (cur) finalize(cur);
      cur = {
        text: ln.text, fontSize: ln.fontSize,
        col: ln.col, full: ln.full,
        left: ln.left, right: ln.right,
        top: ln.baselineTop - ln.fontSize, bottom: ln.baselineTop,
      };
    } else {
      cur.text = appendLine(cur.text, ln.text);
      cur.right = Math.max(cur.right, ln.right);
      cur.left = Math.min(cur.left, ln.left);
      cur.bottom = ln.baselineTop;
      cur.fontSize = Math.max(cur.fontSize, ln.fontSize);
    }
    prev = ln;
  }
  if (cur) finalize(cur);

  for (const b of blocks) {
    b.bbox = { x: b.left, y: b.top, w: Math.max(0, b.right - b.left), h: Math.max(b.fontSize, b.bottom - b.top) };
    delete b.left; delete b.right; delete b.top; delete b.bottom; delete b.col; delete b.full;
  }
  return blocks;
}

function appendLine(acc, next) {
  if (/[A-Za-z]-$/.test(acc) && /^[a-z]/.test(next)) return acc.slice(0, -1) + next;
  return acc + ' ' + next;
}

function classify(block, bodyFontSize, pageNum) {
  const fs = block.fontSize;
  const short = block.text.length < 120;
  if (pageNum === 1 && fs > bodyFontSize * 1.8) return 'title';
  if (fs > bodyFontSize * 1.22 && short) return 'heading';
  if (short && /^(\d+(\.\d+)*)\s+[A-Z]/.test(block.text) && fs >= bodyFontSize * 1.05) return 'heading';
  return 'body';
}

function isTranslatable(text) {
  const s = text.trim();
  if (s.length < 3) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters === 0) return false;
  if (letters < s.length * 0.2) return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

// 判断一段文字是否是「整行公式 / 符号密集块」——这类从 PDF 抽取出来必然错乱，
// 应当裁剪原图而不是翻译。
function isGraphicText(s) {
  s = (s || '').trim();
  if (s.length < 2) return false;
  const total = s.length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const greek = (s.match(/[Ͱ-Ͽ]/g) || []).length;
  const mathSym = (s.match(/[=+\-*/^_{}\\<>|·⋅×÷±∓∑∏∫∇∈∉⊂⊆⊇⊕⊗∀∃∅∞≤≥≠≈≡∝√∂→←↦↔⟨⟩‖∘∗]/g) || []).length;
  const digits = (s.match(/[0-9]/g) || []).length;
  const letterRatio = letters / total;
  const mathRatio = (mathSym + greek) / total;
  if (/^\(?\d{1,3}\)?$/.test(s)) return false;             // 纯编号/页码不算
  if (mathRatio >= 0.16 && letterRatio < 0.6) return true; // 符号密集 + 词密度低 -> 公式
  const words = (s.match(/[A-Za-z]{3,}/g) || []).length;   // 3 字母以上的"词"
  if (words <= 1 && (mathSym + greek + digits) / total > 0.4 && total <= 90) return true;
  return false;
}

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
