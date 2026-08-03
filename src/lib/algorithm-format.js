// Recover / preserve algorithm (pseudocode) structure for vision Markdown.
// Models often collapse "1: Begin 2: // init 3: ..." into one paragraph,
// or "highlight" keywords with **While** / **If** that must be stripped for display.

import {
  looksLikeBibliographyList,
  normalizeBibliographyMarkdown,
} from './bibliography-format.js';

/**
 * Step marker for algorithm lines.
 * - Colon form "1:" / "1：" may omit space ("1:Begin", "3:g←0", "2:// init").
 * - MUST NOT match math range subscripts x_{0:i-1} / \varphi_{0:i-1}:
 *   negative lookahead rejects "N:" + letter + optional "-digits" ending at
 *   math punctuation (user regression: formulas → "0: i-1" garbage).
 * - Dot form "1." MUST have whitespace after the dot so decimals like 0.05
 *   are NEVER treated as step markers.
 */
// After "N:", reject pure index ranges: i / i-1 / n-1 / T-1 before _ } , ) ] space/end.
const MATH_RANGE_AFTER_COLON = String.raw`[a-zA-Z](?:-\d+)?(?:[_\s,}.\\)\]]|$)`;
// The left boundary is essential: without it, publication year "2023."
// matched the trailing "023." and became a fake pseudocode step.
const STEP_MARK = String.raw`(?<!\d)(\d{1,3})\s*(?:[:：](?!${MATH_RANGE_AFTER_COLON})\s*|[.．]\s+)`;
const STEP_MARK_RE = new RegExp(STEP_MARK, 'g');
const STEP_AT_LINE_RE = new RegExp(String.raw`^\s*${STEP_MARK}`);
const ALGO_KEYWORD_RE = /Begin|End\s*(If|For|While)?|While|For\b|If\b|Else|Return|Input|Output|算法|开始|结束|初始化|循环|伪代码|Algorithm\s*\d/i;

/**
 * Dense LaTeX / formula dumps (often from vision OCR of equations).
 * These must never be reflowed as numbered pseudocode.
 */
export function looksLikeLatexHeavy(text) {
  const t = String(text || '');
  if (!t || t.length < 12) return false;
  const cmds = t.match(/\\[A-Za-z]+/g) || [];
  if (cmds.length >= 4) return true;
  const mathCmds = t.match(/\\(?:frac|partial|sum|int|prod|boldsymbol|mathbf|mathrm|mathit|mathcal|mathbb|mathfrak|mathsf|left|right|nabla|cdot|times|infty|quad|qquad|overline|underline|hat|tilde|bar|vec|dot|ddot|varphi|vartheta|varepsilon|varphi|theta|alpha|beta|gamma|lambda|phi|psi|omega|sigma|mu|nu|xi|pi|rho|tau|eta|delta|kappa|chi|zeta)\b/g) || [];
  if (mathCmds.length >= 2) return true;
  const subs = (t.match(/_\{/g) || []).length;
  if (subs >= 3 && cmds.length >= 2) return true;
  // Many math-range subscripts 0:i-1 without real algorithm vocabulary.
  const ranges = t.match(/\d{1,3}\s*[:：]\s*[a-z]\b/g) || [];
  if (ranges.length >= 2 && cmds.length >= 1 && !ALGO_KEYWORD_RE.test(t)) return true;
  return false;
}

/** Mask $...$ / $$...$$ / \\(...\\) / \\[...\\] so algorithm reflow cannot split inside math. */
function withMathRegionsMasked(markdown, mapFn) {
  const slots = [];
  const stash = (raw) => {
    const token = `@@ALGO_MATH_${slots.length}@@`;
    slots.push(raw);
    return token;
  };
  let s = String(markdown || '');
  s = s.replace(/\$\$[\s\S]+?\$\$/g, stash);
  s = s.replace(/\\\[[\s\S]+?\\\]/g, stash);
  s = s.replace(/\\\([\s\S]+?\\\)/g, stash);
  s = s.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, stash);
  s = mapFn(s);
  s = s.replace(/@@ALGO_MATH_(\d+)@@/g, (_, i) => slots[Number(i)] ?? '');
  return s;
}

/**
 * Strip Markdown emphasis / wrapper noise models inject into pseudocode.
 * Keeps LaTeX $...$ untouched. Safe to run on already-reflowed lines.
 */
export function stripMarkdownNoiseFromAlgorithm(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  // Lone ** / * lines used as bold wrappers around the whole algorithm.
  s = s.replace(/^\s*\*{1,4}\s*$/gm, '');
  // **bold** / __bold__ (including mid-line keyword emphasis like **While**)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  // *italic* / _italic_ (avoid matching underscores inside identifiers like X_g:
  // only strip single * ... * pairs, not underscores in names)
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  // Leftover unpaired ** glued to words: **Begin / End**
  s = s.replace(/\*{1,2}(?=\w)/g, '');
  s = s.replace(/(?<=\w)\*{1,2}/g, '');
  // Inline `code` ticks around tokens
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // Collapse spaces from stripping — but NEVER collapse structural indent after "N:".
  s = s
    .split('\n')
    .map((line) => {
      const step = line.match(/^(\s*)(\d{1,3}\s*[:.：．]\s*)(\s*)(.*)$/);
      if (step) {
        // Keep indent spaces between label and body; only tidy the body.
        const body = step[4].replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/u, '');
        return `${step[1]}${step[2].replace(/\s+/g, ' ').replace(/[.：．]/, ':')}${step[3]}${body}`;
      }
      const m = line.match(/^(\s*)(.*)$/);
      if (!m) return line;
      return m[1] + m[2].replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/u, '');
    })
    .join('\n');
  return s.trim();
}

function algorithmTargetIsChinese(targetLang) {
  return /中文|汉语|简体|繁体|Chinese/iu.test(String(targetLang || ''));
}

/** Translate only fixed pseudocode control words; identifiers stay untouched. */
export function localizeAlgorithmKeywords(text, { targetLang = '简体中文' } = {}) {
  const source = String(text || '');
  if (!algorithmTargetIsChinese(targetLang)) return source;
  return withMathRegionsMasked(source, (plain) => {
    const replacements = [
      [/\bEnd\s+Function\b/giu, '结束函数'],
      [/\bEnd\s+Procedure\b/giu, '结束过程'],
      [/\bEnd\s+While\b/giu, '结束循环'],
      [/\bEnd\s+For\b/giu, '结束循环'],
      [/\bEnd\s+If\b/giu, '结束条件'],
      [/\bElse\s+If\b/giu, '否则如果'],
      [/\bFor\s+all\b/giu, '对每个'],
      [/\bFor\s+each\b/giu, '对每个'],
      [/\bRequire\b/giu, '输入'],
      [/\bEnsure\b/giu, '输出'],
      [/\bInput\b/giu, '输入'],
      [/\bOutput\b/giu, '输出'],
      [/\bBegin\b/giu, '开始'],
      [/\bWhile\b/giu, '当'],
      [/\bFor\b/giu, '对于'],
      [/\bIf\b/giu, '如果'],
      [/\bElse\b/giu, '否则'],
      [/\bThen\b/giu, '则'],
      [/\bDo\b/giu, '执行'],
      [/\bReturn\b/giu, '返回'],
      [/\bEnd\b/giu, '结束'],
    ];
    let out = plain;
    for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);
    return out.replace(/\b(输入|输出)\s*:/gu, '$1：').replace(/(输入|输出)\s*:/gu, '$1：');
  });
}

/** Translate a short algorithm heading without touching method/variable names. */
export function localizeAlgorithmTitle(text, { targetLang = '简体中文' } = {}) {
  const source = String(text || '');
  if (!algorithmTargetIsChinese(targetLang)) return source;
  let out = source.replace(/^\s*Algorithm\s*(\d+)/iu, '算法 $1');
  const knownTitles = [
    [/\bReproduction\b/giu, '繁殖'],
    [/\bInitialization\b/giu, '初始化'],
    [/\bSelection\b/giu, '选择'],
    [/\bCrossover\b/giu, '交叉'],
    [/\bMutation\b/giu, '变异'],
    [/\bTraining\b/giu, '训练'],
    [/\bInference\b/giu, '推理'],
    [/\bUpdate\b/giu, '更新'],
  ];
  for (const [pattern, replacement] of knownTitles) out = out.replace(pattern, replacement);
  return out;
}

function maskDelimitedAlgorithmMath(value) {
  const slots = [];
  const stash = (raw) => {
    const token = `\uE100ALGMATH${slots.length}\uE101`;
    slots.push(raw);
    return token;
  };
  let masked = String(value || '');
  masked = masked.replace(/\$\$[\s\S]+?\$\$/gu, stash);
  masked = masked.replace(/\\\[[\s\S]+?\\\]/gu, stash);
  masked = masked.replace(/\\\([\s\S]+?\\\)/gu, stash);
  masked = masked.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/gu, stash);
  return {
    masked,
    restore: (text) => String(text || '').replace(/\uE100ALGMATH(\d+)\uE101/gu,
      (_, index) => slots[Number(index)] ?? ''),
  };
}

function hasBareAlgorithmMathSignal(value) {
  const text = String(value || '');
  return /\\[A-Za-z]+|[_^]\s*(?:\{|[A-Za-z0-9])|[=<>≤≥≠≈∈∪∅←→]|[A-Za-z0-9]'/u.test(text);
}

function wrapBareAlgorithmMathRun(value) {
  const source = String(value || '');
  if (!hasBareAlgorithmMathSignal(source)) return source;

  const leadingMatch = source.match(/^[\s),;:]+/u);
  const trailingMatch = source.match(/[\s,;:.]+$/u);
  const leading = leadingMatch?.[0] || '';
  const trailing = trailingMatch?.[0] || '';
  let core = source.slice(leading.length, source.length - trailing.length);
  let suffix = trailing;

  // An annotation such as "(种群)" is split at the Han text. Keep its opening
  // parenthesis outside the math segment instead of handing KaTeX "... (".
  const open = (core.match(/\(/gu) || []).length;
  const close = (core.match(/\)/gu) || []).length;
  if (open > close) {
    const dangling = core.match(/\s*\(+\s*$/u)?.[0] || '';
    if (dangling) {
      core = core.slice(0, -dangling.length);
      suffix = `${dangling}${suffix}`;
    }
  }
  core = core.trim();
  if (!core || !hasBareAlgorithmMathSignal(core) || /\uE100ALGMATH\d+\uE101/u.test(core)) return source;
  // Bare model output often writes a mathematical set as "= {x_1,...}".
  // In TeX those braces are grouping syntax and disappear, so escape only this
  // high-confidence set-literal form (never subscript/superscript braces).
  core = core.replace(/([=∈]\s*)\{([^{}]+)\}/gu, '$1\\{$2\\}');
  return `${leading}\\(${core}\\)${suffix}`;
}

/**
 * Repair a model's bare LaTeX inside pseudocode locally. This is deterministic
 * and does not make another model request. Existing math delimiters are kept.
 */
export function prepareAlgorithmBodyForDisplay(text, { targetLang = '简体中文' } = {}) {
  const localized = localizeAlgorithmKeywords(text, { targetLang });
  const { masked, restore } = maskDelimitedAlgorithmMath(localized);
  const placeholder = /(\uE100ALGMATH\d+\uE101)/gu;
  const pieces = masked.split(placeholder).map((piece) => {
    if (!piece || placeholder.test(piece)) {
      placeholder.lastIndex = 0;
      return piece;
    }
    placeholder.lastIndex = 0;
    return piece
      .split(/([\p{Script=Han}，。；：！？（）【】“”‘’]+)/u)
      .map((part) => (/^[\p{Script=Han}，。；：！？（）【】“”‘’]+$/u.test(part)
        ? part
        : wrapBareAlgorithmMathRun(part)))
      .join('');
  });
  return restore(pieces.join(''));
}

/** True when a chunk looks like numbered pseudocode / algorithm text. */
export function looksLikeCompactAlgorithm(text) {
  const value = String(text || '');
  if (value.length < 24) return false;
  // Bibliography lists use "[n] Author…" and sometimes OCR junk "695: [16]".
  // Never promote them to algorithm fences.
  if (looksLikeBibliographyList(value)) return false;
  // Formula dumps with \frac / \partial / x_{0:i-1} are not algorithms.
  if (looksLikeLatexHeavy(value)) return false;
  const marks = value.match(new RegExp(STEP_MARK, 'g')) || [];
  if (marks.length < 3) return false;
  // Require control-flow / algorithm vocabulary so prose with many decimals
  // or "5, 10, 15" enumerations is not rewritten as fake step lists.
  if (ALGO_KEYWORD_RE.test(value)) return true;
  // Colon-heavy numbered steps (1: 2: 3:) without keywords still OK —
  // but only count true step markers, not math ranges 0:i-1.
  const colonSteps = value.match(new RegExp(STEP_MARK, 'g')) || [];
  return colonSteps.length >= 4;
}

/**
 * Split a single-line (or poorly wrapped) algorithm dump into one line per
 * numbered step: "1: Begin 2: init" → "1: Begin\n2: init".
 * Also handles "1:Begin" (no space) and fullwidth "1：".
 */
export function reflowCompactAlgorithmLines(text) {
  const source = stripMarkdownNoiseFromAlgorithm(String(text || '').replace(/\r\n?/g, '\n')).trim();
  if (!source) return source;

  // Already multi-line with enough numbered steps — only tidy trailing spaces.
  const existingLines = source.split('\n').map((line) => line.replace(/[ \t]+$/u, ''));
  const nonEmpty = existingLines.filter((line) => line.trim());
  const numberedLines = nonEmpty.filter((line) => STEP_AT_LINE_RE.test(line));
  if (numberedLines.length >= 3 && nonEmpty.length >= numberedLines.length) {
    // Still normalize "1." / fullwidth colon on each line (not decimals).
    return nonEmpty
      .map((line) => line
        .replace(/^\s*(\d{1,3})\s*[:：]\s*/, '$1: ')
        .replace(/^\s*(\d{1,3})\s*[.．]\s+/, '$1: '))
      .join('\n');
  }

  // Flatten soft wraps, then split on step markers.
  const flat = source.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const steps = [];
  STEP_MARK_RE.lastIndex = 0;
  const matches = [...flat.matchAll(new RegExp(STEP_MARK, 'g'))];
  if (matches.length < 2) {
    return source;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const num = m[1];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : flat.length;
    let body = flat.slice(start, end).trim();
    // Drop a leading title fragment glued before first step (handled by caller).
    steps.push(`${num}: ${body}`.replace(/[ \t]+/g, ' ').trim());
  }

  // If text before the first step is non-trivial and not just noise, keep it out
  // of step 1 (caller may use as title).
  return steps.join('\n');
}

/**
 * If "算法 1 … 1: Begin 2: …" is one blob, split title vs body.
 * Returns { title, body } where body starts at first step marker.
 */
export function splitAlgorithmTitleAndBody(text) {
  const source = String(text || '').trim();
  if (!source) return { title: '', body: '' };
  const stepRe = new RegExp(STEP_MARK);
  const m = stepRe.exec(source);
  if (!m || m.index <= 0) {
    return { title: '', body: source };
  }
  const before = source.slice(0, m.index).trim();
  const body = source.slice(m.index).trim();
  // Title-like prefix: contains 算法/Algorithm or short heading.
  if (
    /算法\s*\d|Algorithm\s*\d/i.test(before)
    || (before.length > 0 && before.length <= 80 && !new RegExp(STEP_MARK).test(before))
  ) {
    return { title: before.replace(/^#{1,3}\s*/, '').replace(/^\*+|\*+$/g, '').trim(), body };
  }
  return { title: '', body: source };
}

/**
 * Heuristic indentation for recovered algorithm lines so nested
 * If/For/While/For-all blocks match the paper's visual nesting.
 * Format: "N: " + (2 spaces × depth) + body
 */
export function indentAlgorithmLines(text) {
  const lines = String(text || '').split('\n');
  // Open a nest for control-flow headers (EN + common CN).
  const opensBlock = (body) => {
    const b = String(body || '').trim();
    if (!b) return false;
    if (/^(?:Else(?:\s*If)?|否则)\b/i.test(b)) return false;
    if (/^(?:End\b|结束)/i.test(b)) return false;
    if (/^(?:Begin|Function|Procedure|Require|Input|Output)\b/i.test(b)) return true;
    if (/^(?:If|While|当|如果)\b/i.test(b)) return true;
    // for / for all / for each / For m = 1 … do
    if (/^For(?:\s+all|\s+each)?\b/i.test(b)) return true;
    if (/^对于\b/.test(b)) return true;
    return false;
  };
  const closesBlock = (body) => {
    const b = String(body || '').trim();
    return /^(?:End(?:\s*(?:If|For|While|Function|Procedure))?|结束(?:如果|循环|对于)?)\b/i.test(b);
  };
  const isElse = (body) => /^(?:Else(?:\s*If)?|否则)\b/i.test(String(body || '').trim());

  let depth = 0;
  const out = [];

  for (const raw of lines) {
    const bodyMatch = raw.match(/^(\s*)(\d{1,3})\s*[:.：．]\s*(.*)$/);
    const num = bodyMatch ? bodyMatch[2] : '';
    // Drop any previous indent; we recompute from structure.
    const body = (bodyMatch ? bodyMatch[3] : raw).replace(/^\s+/, '').trimEnd();
    if (!body && !num) {
      out.push('');
      continue;
    }

    if (closesBlock(body) || isElse(body)) {
      depth = Math.max(0, depth - 1);
    }

    const indent = '  '.repeat(Math.min(8, depth));
    if (num) {
      out.push(`${num}: ${indent}${body}`.replace(/\s+$/u, ''));
    } else {
      out.push(`${indent}${body}`.replace(/\s+$/u, ''));
    }

    if (isElse(body)) {
      depth = Math.min(8, depth + 1);
    } else if (opensBlock(body)) {
      depth = Math.min(8, depth + 1);
    }
  }
  return out.join('\n');
}

/** Parse "N:   body" into { num, depth, body } for layout (depth = leading spaces/2). */
export function parseAlgorithmDisplayLine(line) {
  const raw = String(line ?? '');
  const m = raw.match(/^(\d{1,3}):(\s*)(.*)$/);
  if (!m) {
    const lead = (raw.match(/^\s*/) || [''])[0].length;
    return { num: '', depth: Math.min(8, Math.floor(lead / 2)), body: raw.trim() };
  }
  const spaces = m[2].replace(/\t/g, '  ').length;
  return {
    num: `${m[1]}:`,
    depth: Math.min(8, Math.floor(spaces / 2)),
    body: m[3],
  };
}

function fenceAlgorithm(body) {
  const cleaned = stripMarkdownNoiseFromAlgorithm(body);
  const reflowed = indentAlgorithmLines(reflowCompactAlgorithmLines(cleaned));
  return `\`\`\`algorithm\n${reflowed}\n\`\`\``;
}

/**
 * Scan Markdown and wrap / reflow algorithm-like regions into fenced
 * ```algorithm blocks so they render with pre-wrap monospace indentation.
 * Math regions are masked first so x_{0:i-1} never becomes algorithm step "0:".
 */
export function formatAlgorithmsInMarkdown(markdown) {
  const source = String(markdown || '');
  if (!source.trim()) return source;

  return withMathRegionsMasked(source, (unmasked) => {
    // Already fenced algorithm/pseudo blocks — reflow insides only when not latex.
    let text = unmasked.replace(
      /```(algorithm|pseudo|pseudocode|algo)?[ \t]*\n([\s\S]*?)```/gi,
      (full, language, body) => {
        // References can contain many "2023:" / "35:" fragments. They are
        // publication years and volume numbers, never pseudocode line labels.
        if (looksLikeBibliographyList(body)) {
          return normalizeBibliographyMarkdown(String(body).trim());
        }
        if (looksLikeLatexHeavy(body)) return full;
        // Preserve ordinary unlabeled code fences. Only explicit algorithm
        // fences or independently verified compact pseudocode are reformatted.
        if (!language && !looksLikeCompactAlgorithm(body)) return full;
        return fenceAlgorithm(body);
      },
    );

    // Title line "算法 1 ..." / "Algorithm 1 ..." (optional #/**) + body
    // Body may be on the same line or following lines.
    text = text.replace(
      /(^|\n)((?:#{1,3}\s*)?(?:\*{1,2})?(?:算法|Algorithm)\s*\d+[^\n`]*?)(?:\*{1,2})?[ \t]*\n+[ \t]*([^\n`][\s\S]*?)(?=\n{2,}(?:#{1,3}\s|\*{0,2}(?:算法|Algorithm)\s*\d)|\n{2,}(?![^\n]*\d{1,3}\s*[:.：．])|$)/gi,
      (full, lead, title, body) => {
        const chunk = `${title}\n${body}`;
        if (looksLikeLatexHeavy(body) || looksLikeLatexHeavy(chunk)) return full;
        if (!looksLikeCompactAlgorithm(body) && !looksLikeCompactAlgorithm(chunk)) {
          return full;
        }
        const cleanTitle = String(title).replace(/^#{1,3}\s*/, '').replace(/^\*+|\*+$/g, '').trim();
        return `${lead}${cleanTitle}\n\n${fenceAlgorithm(body)}`;
      },
    );

    // Same-line: "算法 1 xxx 1: Begin 2: ..."
    text = text.replace(
      /(^|\n)((?:#{1,3}\s*)?(?:\*{1,2})?(?:算法|Algorithm)\s*\d+[^\n`]*?)(?=\d{1,3}\s*[:.：．])([^\n`]+)(?=\n|$)/gi,
      (full, lead, titlePart, rest) => {
        const { title, body } = splitAlgorithmTitleAndBody(`${titlePart}${rest}`);
        const useBody = body || rest;
        if (looksLikeLatexHeavy(useBody)) return full;
        if (!looksLikeCompactAlgorithm(useBody)) return full;
        const head = (title || titlePart).replace(/^#{1,3}\s*/, '').replace(/^\*+|\*+$/g, '').trim();
        return `${lead}${head}\n\n${fenceAlgorithm(useBody)}`;
      },
    );

    // Standalone dense paragraph with many step markers (no Algorithm title).
    text = text.replace(
      /(^|\n\n)([^\n`]*(?:\d{1,3}\s*[:.：．]\s*\S+)(?:[^\n`]*\d{1,3}\s*[:.：．]\s*\S+){3,}[^\n`]*)(?=\n\n|$)/g,
      (full, lead, body) => {
        if (looksLikeLatexHeavy(body)) return full;
        if (!looksLikeCompactAlgorithm(body)) return full;
        if (/```/.test(body)) return full;
        const { title, body: splitBody } = splitAlgorithmTitleAndBody(body);
        const useBody = splitBody || body;
        if (title) {
          return `${lead}${title}\n\n${fenceAlgorithm(useBody)}`;
        }
        return `${lead}${fenceAlgorithm(useBody)}`;
      },
    );

    // Single-newline paragraphs (common in model output): treat like standalone.
    text = text.replace(
      /(^|\n)((?:[^\n`]*\d{1,3}\s*[:.：．]\s+){4,}[^\n`]*)(?=\n(?:[^\d\n]|$)|\n*$)/gm,
      (full, lead, body) => {
        if (looksLikeLatexHeavy(body)) return full;
        if (!looksLikeCompactAlgorithm(body)) return full;
        if (/```/.test(body) || /算法\s*\d|Algorithm\s*\d/i.test(lead)) return full;
        // Avoid double-wrapping already fenced regions.
        if (full.includes('```algorithm')) return full;
        return `${lead}${fenceAlgorithm(body)}`;
      },
    );

    return text;
  });
}

/**
 * Recover algorithm structure from a plain DOM text blob (post-render fallback
 * when the model never used fences and markdown path missed the paragraph).
 * Returns { title, lines } or null.
 */
export function recoverAlgorithmFromPlainText(text) {
  const raw = stripMarkdownNoiseFromAlgorithm(String(text || '').replace(/\r\n?/g, '\n')).trim();
  if (!raw || looksLikeLatexHeavy(raw) || !looksLikeCompactAlgorithm(raw)) return null;
  const { title, body } = splitAlgorithmTitleAndBody(raw);
  const useBody = body || raw;
  if (looksLikeLatexHeavy(useBody)) return null;
  if (!looksLikeCompactAlgorithm(useBody) && (useBody.match(new RegExp(STEP_MARK, 'g')) || []).length < 3) {
    return null;
  }
  const reflowed = indentAlgorithmLines(reflowCompactAlgorithmLines(useBody));
  const lines = reflowed.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return null;
  return {
    title: stripMarkdownNoiseFromAlgorithm(title || ''),
    lines,
  };
}

/**
 * Prepare a single algorithm line for display: strip MD noise, keep indent.
 */
export function prepareAlgorithmDisplayLine(line) {
  const raw = String(line ?? '');
  // Do not run full-string trim that would eat structural spaces after "N:".
  const cleaned = stripMarkdownNoiseFromAlgorithm(raw);
  if (!cleaned) return '';
  return cleaned;
}
