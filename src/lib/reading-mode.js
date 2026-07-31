// Pure helpers for the default Moonlight-style reading mode.
// This module intentionally has no DOM or Chrome dependencies so it can be
// covered by Node's built-in test runner.
import {
  assessFormulaLatex,
  canonicalizeFormulaLatex,
  normalizeFormulaHints,
} from './formula-quality.js';
import { normalizeBibliographyMarkdown } from './bibliography-format.js';

function stripCodeFence(value) {
  return value
    .replace(/^```(?:json|latex|tex)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function stripDisplayDelimiters(value) {
  const dollar = /^\$\$([\s\S]*)\$\$$/.exec(value);
  if (dollar) return dollar[1].trim();
  const bracket = /^\\\[([\s\S]*)\\\]$/.exec(value);
  if (bracket) return bracket[1].trim();
  return value.trim();
}

function hasBalancedBraces(value) {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '{' && value[i - 1] !== '\\') depth++;
    if (value[i] === '}' && value[i - 1] !== '\\') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function looksLikePlainProse(value) {
  if (/\\[A-Za-z]+|[_^{}=+\-*/<>]|[∑∫√≤≥≠≈]/.test(value)) return false;
  const words = value.match(/[A-Za-z]{2,}/g) || [];
  return words.length >= 4;
}

export function parseFormulaTranscription(raw, { sourceText = '' } = {}) {
  let text = stripCodeFence(String(raw || '').trim());
  if (!text) return null;

  let latex = '';
  let number = '';
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      latex = String(data?.latex || '').trim();
      number = String(data?.number || '').trim();
    } catch {
      return null;
    }
  } else {
    latex = text;
  }

  latex = canonicalizeFormulaLatex(stripDisplayDelimiters(latex));
  if (!latex || looksLikePlainProse(latex) || !hasBalancedBraces(latex)) return null;
  if (!assessFormulaLatex(latex, { sourceText }).ok) return null;
  return { latex, number };
}

/** Parse one page-level formula sprite response without trusting array order. */
export function parseFormulaBatchTranscription(raw, expectedFormulas = []) {
  const text = stripCodeFence(String(raw || '').trim());
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const rawItems = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(rawItems)) return null;

  const formulaHints = normalizeFormulaHints(expectedFormulas);
  const hintsById = new Map(formulaHints.map((formula) => [formula.id, formula]));
  const expected = new Set(hintsById.keys());
  const seen = new Set();
  const items = [];
  const unknownIds = [];
  const rejectedIds = [];
  for (const item of rawItems) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (expected.size && !expected.has(id)) {
      unknownIds.push(id);
      continue;
    }
    const parsed = parseFormulaTranscription(JSON.stringify({
      latex: item?.latex,
      number: item?.number,
    }), { sourceText: hintsById.get(id)?.source_text || '' });
    if (parsed) items.push({ id, ...parsed });
    else rejectedIds.push(id);
  }
  const returned = new Set(items.map((item) => item.id));
  return {
    items,
    missingIds: [...expected].filter((id) => !returned.has(id)),
    unknownIds,
    rejectedIds,
  };
}

export function getReadingMediaPresentation(block, { formulaState, imageUrl } = {}) {
  if (block?.kind === 'image') {
    return { type: 'source-ref', label: '查看左侧原图' };
  }
  if (block?.kind !== 'formula') return null;

  if (String(block.latex || '').trim()) {
    return {
      type: 'latex',
      latex: String(block.latex).trim(),
      number: String(block.number || '').trim(),
    };
  }
  if (formulaState?.status === 'done' && formulaState.latex) {
    return {
      type: 'latex',
      latex: formulaState.latex,
      number: formulaState.number || '',
    };
  }
  if ((formulaState?.status === 'failed' || formulaState?.status === 'done') && imageUrl) {
    return { type: 'formula-image', imageUrl };
  }
  if (formulaState?.status === 'failed' || formulaState?.status === 'done') {
    return { type: 'source-ref', label: '查看左侧公式' };
  }
  return { type: 'pending', label: '公式识别中…' };
}

export function finalizeReadingTranslation(raw, full) {
  const text = String(full || raw || '');
  // Prefer the longer stream when both exist, then drop obvious CoT tails.
  // Also strip vision junk like "695: [16]" on reference pages.
  return normalizeBibliographyMarkdown(stripTrailingModelSelfTalk(text));
}

const VISION_SOURCE_HINT_MAX_CHARS = 5200;

function unescapedDollarCount(value) {
  let count = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '$') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

function stripVisionProtectedText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/\$\$[\s\S]*?\$\$/gu, ' ')
    .replace(/\\\[[\s\S]*?\\\]/gu, ' ')
    .replace(/\\\([\s\S]*?\\\)/gu, ' ')
    .replace(/\$[^$\n]*\$/gu, ' ')
    .replace(/https?:\/\/\S+|doi:\s*\S+/giu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ');
}

function isBibliographyLike(value) {
  const lines = String(value || '').split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const refs = lines.filter((line) => (
    /^\[?\d{1,4}[\].)]\s+/u.test(line)
    || /\bdoi\b|\barxiv\b|\bvol\.?\s*\d|\bpp?\.\s*\d/iu.test(line)
  )).length;
  return refs / lines.length >= 0.45;
}

/**
 * Language quality checks must ignore a bibliography tail even when the page
 * also contains ordinary body text. A whole-page bibliography ratio is not
 * enough for final pages such as "Conclusion + References".
 */
function stripBibliographyTailForLanguageCheck(value) {
  const text = String(value || '');
  const heading = /(?:^|\n)\s{0,3}(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?\s*(?:参考文献|参考资料|References|Bibliography)\s*(?:\*{1,2}|_{1,2})?\s*[:：]?\s*(?=\n|$)/gimu;
  let match;
  while ((match = heading.exec(text))) {
    const tailStart = Number(match.index || 0) + String(match[0] || '').length;
    const tail = text.slice(tailStart);
    const entries = tail.match(/(?:^|\n)\s*(?:\[\s*\d{1,4}\s*\]|\d{1,3}\.)\s+\S/gmu) || [];
    const citationSignals = tail.match(/\b(?:19|20)\d{2}\b|\b(?:doi|arxiv|journal|conference|proceedings|vol\.?|pp?\.)\b/giu) || [];
    if (entries.length >= 1 && (entries.length >= 2 || citationSignals.length >= 1)) {
      return {
        prose: text.slice(0, Number(match.index || 0)),
        ignoredChars: tail.length,
      };
    }
  }
  return { prose: text, ignoredChars: 0 };
}

function repeatedVisionLineCount(value) {
  const counts = new Map();
  let repeated = 0;
  for (const line of String(value || '').split(/\r?\n/gu)) {
    const clean = line.replace(/^[#>*\-\d.\s]+/gu, '').replace(/\s+/gu, ' ').trim();
    if (clean.length < 14) continue;
    const key = clean.toLocaleLowerCase('en-US');
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count === 3) repeated += 1;
  }
  return repeated;
}

function uniqueMatches(value, pattern, normalize = (item) => item) {
  const out = [];
  const seen = new Set();
  for (const match of String(value || '').matchAll(pattern)) {
    const raw = match[1] ?? match[0];
    const clean = String(normalize(raw) || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function normalizedAnchorText(value) {
  let text = String(value || '');
  try { text = text.normalize('NFKC'); } catch { /* older browser */ }
  return text.replace(/[\u00a0\s]+/gu, ' ').trim();
}

function anchorCoverage(sourceItems, outputItems) {
  const expected = [...new Set(sourceItems || [])];
  const found = new Set(outputItems || []);
  const missing = expected.filter((item) => !found.has(item));
  return {
    expected,
    missing,
    coverage: expected.length ? (expected.length - missing.length) / expected.length : 1,
  };
}

function extractCitationAnchors(value) {
  return uniqueMatches(normalizedAnchorText(value), /\[(\d{1,3}(?:\s*[-–—,]\s*\d{1,3})*)\]/gu,
    (item) => `[${String(item).replace(/\s+/gu, '')}]`);
}

function extractEquationNumberAnchors(value) {
  const text = normalizedAnchorText(value);
  const anchors = new Set(uniqueMatches(text, /\\tag\s*\{\s*(\d{1,3})\s*\}/gu,
    (item) => `(${item})`));
  const candidatePattern = /(?:^|\s)\((\d{1,3})\)(?=\s|[.,;:]|$)/gu;
  for (const match of text.matchAll(candidatePattern)) {
    const full = String(match[0] || '');
    const openOffset = full.indexOf('(');
    const openIndex = Number(match.index || 0) + Math.max(0, openOffset);
    const before = text.slice(Math.max(0, openIndex - 120), openIndex);
    // PDF.js flattens line breaks, so a bare “(1)” is ambiguous. Only trust it
    // when an Eq./Equation cue is nearby or the local context is visibly math.
    // This prevents abstract contribution lists (1)/(2)/(3) from triggering a
    // pointless full-page quality retry.
    const explicitEquation = /\b(?:eq(?:uation)?s?)\.?\s*[^.!?]{0,90}$/iu.test(before)
      || /(?:方程|公式)\s*[^。！？]{0,70}$/u.test(before);
    const mathSignals = before.match(/[=≈≃≠≤≥<>∑∫∂√±×÷→←↔]|\\(?:frac|sum|prod|int|partial|nabla|left|right|mathbf|mathbb)\b/gu) || [];
    if (explicitEquation || mathSignals.length >= 1) anchors.add(`(${match[1]})`);
  }
  return [...anchors];
}

function extractPercentageAnchors(value) {
  return uniqueMatches(normalizedAnchorText(value), /\b(\d+(?:\.\d+)?\s*%)/gu,
    (item) => String(item).replace(/\s+/gu, ''));
}

const ACRONYM_ANCHOR_STOP = new Set([
  'A', 'AN', 'AND', 'AS', 'AT', 'BY', 'FOR', 'FROM', 'IF', 'IN', 'INTO', 'IS', 'IT',
  'OF', 'ON', 'OR', 'THE', 'THIS', 'TO', 'US', 'WE', 'WITH', 'WITHOUT', 'FIG',
  'FIGURE', 'TABLE', 'ALGORITHM', 'SECTION', 'APPENDIX', 'PDF', 'IEEE',
]);

function extractTermAnchors(value) {
  const text = normalizedAnchorText(value);
  const acronyms = uniqueMatches(text, /\b([A-Z][A-Z0-9-]{1,11})\b/gu,
    (item) => String(item).toUpperCase()).filter((item) => !ACRONYM_ANCHOR_STOP.has(item));
  const datasetNames = uniqueMatches(text, /\b([A-Z][A-Za-z0-9]*(?:Net|Set)|ImageNet|[A-Z]{2,}-\d+)\b/gu);
  return [...new Set([...acronyms, ...datasetNames])];
}

function extractKeyNumericAnchors(value) {
  const text = normalizedAnchorText(value);
  const decimals = uniqueMatches(text, /\b(\d+\.\d+)\b/gu);
  const scientific = uniqueMatches(text, /\b(\d+(?:\.\d+)?\s*[×x]\s*10\s*[-−^]?\s*\d+)\b/giu,
    (item) => String(item).replace(/\s+/gu, '').replace('−', '-'));
  return [...new Set([...decimals, ...scientific])];
}

function hasCaptionLikeSource(value, kind) {
  const text = normalizedAnchorText(value);
  const lineText = String(value || '').replace(/\r\n?/gu, '\n');
  if (kind === 'figure') {
    return /\bFig(?:ure)?\.?\s+\d+[A-Za-z]?\s*:\s*\S/iu.test(text)
      || /^\s*Fig(?:ure)?\.?\s+\d+[A-Za-z]?\s*[.:]\s*\S/imu.test(lineText);
  }
  return /\bTable\s+(?:\d+|[IVXLC]+)[A-Za-z]?\s*:\s*\S/iu.test(text)
    || /^\s*Table\s+(?:\d+|[IVXLC]+)[A-Za-z]?\s*[.:]\s*\S/imu.test(lineText);
}

function sourceLooksLikeAlgorithm(value) {
  const text = normalizedAnchorText(value);
  if (!/\bAlgorithm\s+\d+\b/iu.test(text)) return false;
  const keywords = text.match(/\b(?:Input|Output|Require|Ensure|Initialize|for|while|repeat|until|return|end\s+(?:if|for|while))\b/giu) || [];
  return new Set(keywords.map((item) => item.toLowerCase())).size >= 3;
}

function algorithmOutputHealth(value) {
  const match = /```algorithm\s*\n([\s\S]*?)```/iu.exec(String(value || ''));
  if (!match) return { hasFence: false, numberedLines: 0, indentedLines: 0 };
  const body = match[1];
  return {
    hasFence: true,
    numberedLines: (body.match(/^\s*\d+\s*:/gmu) || []).length,
    indentedLines: (body.match(/^\s*\d+\s*:\s{2,}\S/gmu) || []).length,
  };
}

function hasUnbalancedMathBraces(value) {
  const text = String(value || '');
  const segments = [
    ...text.matchAll(/\$\$([\s\S]*?)\$\$/gu),
    ...text.replace(/\$\$[\s\S]*?\$\$/gu, ' ').matchAll(/\$([^$\n]*?)\$/gu),
    ...text.matchAll(/\\\(([\s\S]*?)\\\)/gu),
    ...text.matchAll(/\\\[([\s\S]*?)\\\]/gu),
  ];
  return segments.some((match) => !hasBalancedBraces(String(match[1] || '')));
}

function looksLikeModelRefusal(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const beginning = text.slice(0, 420);
  return /^(?:#{1,3}\s*)?(?:sorry\b|I(?:'m| am) sorry\b|I (?:cannot|can't|am unable to)\b|as an AI\b|抱歉|对不起|我(?:无法|不能)(?:完成|提供|处理|翻译|协助))/iu.test(beginning)
    || (/\b(?:I cannot comply|I can'?t assist with that|unable to fulfill this request)\b/iu.test(beginning) && text.length < 1600);
}

/** Rendering budget: ordinary pages stay fast; dense/failed pages gain pixels. */
export function selectVisionRenderWidth({ sourceChars = 0, qualityRetry = false } = {}) {
  if (qualityRetry) return 2050;
  const chars = Math.max(0, Number(sourceChars) || 0);
  if (chars >= 4300) return 1780;
  if (chars >= 2800) return 1640;
  return 1500;
}

function visionQualityMessage(reason) {
  const messages = {
    empty: '模型未返回译文',
    'model-self-talk': '模型输出了推理过程而非译文，将按失败原因自动重试本页',
    'repetition-loop': '模型输出陷入重复循环，将自动重试本页',
    'duplicate-blocks': '本地检查提示译文可能出现重复段落',
    'target-language-missing': '本地检查提示目标语言译文可能不足',
    'english-residual': '本地检查提示正文可能残留成段英文（参考文献不参与判断）',
    'math-delimiter-damaged': '本地检查提示公式 LaTeX 定界符可能不完整',
    'bare-latex': '本地检查提示部分公式可能未包在 LaTeX 定界符中',
    'source-coverage-low': '本地检查提示译文可能漏段',
    'source-coverage-abnormal': '本地检查提示译文长度可能异常',
    'embedded-media': '本地检查提示译文可能错误复制了图片',
    'model-refusal': '视觉模型拒绝了页面翻译，将以论文内容隔离规则自动重试',
    'code-fence-damaged': '本地检查提示算法或代码围栏可能未闭合',
    'math-brace-damaged': '本地检查提示公式花括号可能不完整',
    'algorithm-structure-damaged': '本地检查提示算法分行、行号或缩进可能丢失',
    'figure-structure-missing': '本地检查提示图形定位标记或图注可能缺失',
    'table-structure-missing': '本地检查提示表格定位标记或表注可能缺失',
    'citation-anchor-loss': '本地检查提示引用标记可能缺失',
    'equation-number-loss': '本地检查提示方程编号可能缺失',
    'numeric-anchor-loss': '本地检查提示关键数值或百分比可能缺失',
    'term-anchor-loss': '本地检查提示数据集、缩写或专名可能缺失',
  };
  return messages[reason] || '本地检查提示本页可能存在结构或翻译偏差';
}

const VISION_AUTO_REFINE_REASONS = new Set([
  'model-refusal',
  'model-self-talk',
  'repetition-loop',
]);

/**
 * Heuristic quality findings are advisory. Automatic refinement is reserved
 * for outputs that are not usable as a translation at all; ordinary fidelity
 * warnings must never make every readable page enter a retry loop.
 */
export function shouldAutoRefineVisionQuality(quality) {
  const reasons = [...new Set((quality?.reasons || [quality?.reason]).map(String).filter(Boolean))];
  return reasons.some((reason) => VISION_AUTO_REFINE_REASONS.has(reason));
}

function shortAnchorList(values, max = 5) {
  const items = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
  if (!items.length) return '';
  const visible = items.slice(0, max);
  return `${visible.join('、')}${items.length > max ? ` 等 ${items.length} 项` : ''}`;
}

/** Explain what the quality pass is checking, without claiming the heuristic is certain. */
export function describeVisionQualityIssue(quality) {
  const reason = String(quality?.reason || quality?.reasons?.[0] || '');
  const missing = quality?.metrics?.missingAnchors || {};
  const details = {
    'equation-number-loss': ['疑似缺少方程编号', shortAnchorList(missing.equationNumbers)],
    'citation-anchor-loss': ['疑似缺少引用标记', shortAnchorList(missing.citations)],
    'numeric-anchor-loss': ['疑似缺少关键数值', shortAnchorList([...(missing.percentages || []), ...(missing.keyNumbers || [])])],
    'term-anchor-loss': ['疑似缺少数据集、缩写或专名', shortAnchorList(missing.terms)],
    'algorithm-structure-damaged': ['算法的分行、行号或缩进可能不完整', ''],
    'figure-structure-missing': ['图形定位标记或图注可能缺失', ''],
    'table-structure-missing': ['表格定位标记或表注可能缺失', ''],
    'math-delimiter-damaged': ['LaTeX 公式定界符可能不完整', ''],
    'math-brace-damaged': ['LaTeX 公式花括号可能不平衡', ''],
    'english-residual': ['正文译文中可能仍有成段英文（参考文献不参与检查）', ''],
    'source-coverage-low': ['译文可能存在漏段', ''],
    'source-coverage-abnormal': ['译文长度异常，可能重复或错序', ''],
    'duplicate-blocks': ['译文可能出现重复段落', ''],
    'model-refusal': ['模型可能拒绝了本页翻译', ''],
    'model-self-talk': ['模型可能输出了推理过程', ''],
  };
  const [label, anchors] = details[reason] || [];
  if (label) return anchors ? `${label}：${anchors}` : label;
  const message = String(quality?.message || '').trim();
  return message.split(/，(?:将|可能)/u)[0].trim() || '本地检查发现这页可能存在漏译或结构偏差';
}

/**
 * Multi-dimensional gate for full-page vision translation. It remains
 * conservative around bibliography pages and protected code/math segments.
 */
export function assessVisionTranslationQuality(text, {
  targetLang = '简体中文',
  sourceText = '',
} = {}) {
  const t = String(text || '').trim();
  if (!t) {
    return { ok: false, reason: 'empty', reasons: ['empty'], message: visionQualityMessage('empty'), metrics: {} };
  }

  const reasons = [];
  if (looksLikeModelRefusal(t)) reasons.push('model-refusal');
  const codeFenceCount = (t.match(/```/gu) || []).length;
  if (codeFenceCount % 2 !== 0) reasons.push('code-fence-damaged');
  const waitCount = (t.match(/\bWait\b/giu) || []).length;
  const letMeCount = (t.match(/\bLet me\b/giu) || []).length;
  const noIts = (t.match(/\bNo,?\s+it'?s\b/giu) || []).length;
  if (waitCount >= 3 || letMeCount >= 3 || noIts >= 4 || (t.match(/\bit'?s\s*O\s*\(/giu) || []).length >= 5) {
    reasons.push('model-self-talk');
  }
  if (hasPathologicalRepetition(t)) reasons.push('repetition-loop');
  if (repeatedVisionLineCount(t) >= 1) reasons.push('duplicate-blocks');

  const dollars = unescapedDollarCount(t);
  const displayPairsRemoved = t.replace(/\$\$[\s\S]*?\$\$/gu, '');
  const singleDollars = unescapedDollarCount(displayPairsRemoved);
  const bracketOpen = (t.match(/\\\[/gu) || []).length;
  const bracketClose = (t.match(/\\\]/gu) || []).length;
  const parenOpen = (t.match(/\\\(/gu) || []).length;
  const parenClose = (t.match(/\\\)/gu) || []).length;
  if (dollars % 2 !== 0 || singleDollars % 2 !== 0 || bracketOpen !== bracketClose || parenOpen !== parenClose) {
    reasons.push('math-delimiter-damaged');
  }
  if (hasUnbalancedMathBraces(t)) reasons.push('math-brace-damaged');

  const prose = stripVisionProtectedText(t);
  const bareLatexCount = (prose.match(/\\(?:frac|dfrac|tfrac|sum|prod|int|partial|nabla|mathbb|mathbf|boldsymbol|theta|lambda|alpha|beta|gamma|mathrm|operatorname)\b|[_^]\s*\{/gu) || []).length;
  if (bareLatexCount >= 2) reasons.push('bare-latex');
  if (/!\[[^\]]*\]\([^)]*\)|<img\b/iu.test(t)) reasons.push('embedded-media');

  const expectsAlgorithm = sourceLooksLikeAlgorithm(sourceText);
  const expectsFigure = hasCaptionLikeSource(sourceText, 'figure');
  const expectsTable = hasCaptionLikeSource(sourceText, 'table');
  const algorithmHealth = algorithmOutputHealth(t);
  if (expectsAlgorithm && (
    !algorithmHealth.hasFence
    || algorithmHealth.numberedLines < 2
    || algorithmHealth.indentedLines < 1
  )) reasons.push('algorithm-structure-damaged');
  if (expectsFigure && !/^@@FIGURE@@\s*$/mu.test(t)) reasons.push('figure-structure-missing');
  if (expectsTable && !/^@@TABLE@@\s*$/mu.test(t)) reasons.push('table-structure-missing');

  const bibliography = isBibliographyLike(t);
  const languageRegion = stripBibliographyTailForLanguageCheck(prose);
  const languageProse = languageRegion.prose;
  const cjk = (languageProse.match(/[\u3400-\u9fff]/gu) || []).length;
  const asciiLetters = (languageProse.match(/[A-Za-z]/gu) || []).length;
  const englishWords = (languageProse.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/gu) || []).length;
  const longEnglishRuns = languageProse.match(/(?:\b[A-Za-z][A-Za-z'’-]{1,}\b[\s,;:()\[\]-]+){10,}\b[A-Za-z][A-Za-z'’-]{1,}\b/gu) || [];
  const wantsChinese = /中文|汉语|简体|繁体|Chinese/iu.test(String(targetLang || ''));
  if (wantsChinese && !bibliography) {
    if (prose.length > 320 && cjk < 12 && englishWords > 55) reasons.push('target-language-missing');
    if ((cjk > 0 && longEnglishRuns.length >= 2) || (cjk >= 12 && englishWords > 90 && asciiLetters > cjk * 4.5)) {
      reasons.push('english-residual');
    }
  }

  const sourceCompact = String(sourceText || '').replace(/\s+/gu, ' ').trim();
  const sourceChars = sourceCompact.replace(/\s/gu, '').length;
  const outputChars = prose.replace(/[#>*_\-\s]/gu, '').length;

  const citationAnchors = anchorCoverage(extractCitationAnchors(sourceText), extractCitationAnchors(t));
  const equationAnchors = anchorCoverage(extractEquationNumberAnchors(sourceText), extractEquationNumberAnchors(t));
  const percentageAnchors = anchorCoverage(extractPercentageAnchors(sourceText), extractPercentageAnchors(t));
  const numericAnchors = anchorCoverage(extractKeyNumericAnchors(sourceText), extractKeyNumericAnchors(t));
  const termAnchors = anchorCoverage(extractTermAnchors(sourceText), extractTermAnchors(t));
  if (citationAnchors.expected.length >= 2 && citationAnchors.coverage < 0.6) {
    reasons.push('citation-anchor-loss');
  }
  if (equationAnchors.expected.length >= 2 && equationAnchors.coverage < 0.6) {
    reasons.push('equation-number-loss');
  }
  if (!expectsTable && sourceChars >= 300 && (
    (percentageAnchors.expected.length >= 1 && percentageAnchors.coverage < 0.5)
    || (numericAnchors.expected.length >= 3 && numericAnchors.coverage < 0.5)
  )) reasons.push('numeric-anchor-loss');
  if (termAnchors.expected.length >= 3 && termAnchors.coverage < 0.5) {
    reasons.push('term-anchor-loss');
  }
  if (!bibliography && sourceChars >= 450) {
    if (outputChars < Math.max(100, sourceChars * 0.14)) reasons.push('source-coverage-low');
    if (outputChars > sourceChars * 4.8) reasons.push('source-coverage-abnormal');
  }

  // Extremely long ASCII output with explicit meta talk is always unusable,
  // including on reference pages.
  if (t.length > 800 && cjk < 20 && asciiLetters > 400 && /Wait|Let me|Actually/iu.test(t)) {
    reasons.push('model-self-talk');
  }

  const uniqueReasons = [...new Set(reasons)];
  const metrics = {
    sourceChars,
    outputChars,
    cjk,
    englishWords,
    longEnglishRuns: longEnglishRuns.length,
    bareLatexCount,
    bibliography,
    ignoredBibliographyChars: languageRegion.ignoredChars,
    codeFenceCount,
    structure: {
      expectsAlgorithm,
      expectsFigure,
      expectsTable,
      ...algorithmHealth,
    },
    anchorCoverage: {
      citations: Number(citationAnchors.coverage.toFixed(3)),
      equationNumbers: Number(equationAnchors.coverage.toFixed(3)),
      percentages: Number(percentageAnchors.coverage.toFixed(3)),
      keyNumbers: Number(numericAnchors.coverage.toFixed(3)),
      terms: Number(termAnchors.coverage.toFixed(3)),
    },
    missingAnchors: {
      citations: citationAnchors.missing.slice(0, 12),
      equationNumbers: equationAnchors.missing.slice(0, 12),
      percentages: percentageAnchors.missing.slice(0, 12),
      keyNumbers: numericAnchors.missing.slice(0, 12),
      terms: termAnchors.missing.slice(0, 12),
    },
  };
  if (!uniqueReasons.length) return { ok: true, reason: '', reasons: [], message: '', metrics };
  return {
    ok: false,
    reason: uniqueReasons[0],
    reasons: uniqueReasons,
    message: visionQualityMessage(uniqueReasons[0]),
    metrics,
  };
}

/** Build the compact text-side hint that accompanies the authoritative page image. */
export function buildVisionTranslationContext({ sourceText = '', quality = null } = {}) {
  const source = String(sourceText || '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, VISION_SOURCE_HINT_MAX_CHARS);
  const reasons = quality?.ok === false
    ? [...new Set((quality.reasons || [quality.reason]).map(String).filter(Boolean))]
    : [];
  const lines = ['PAPERLENS_VISION_CONTEXT_V3'];
  if (reasons.length) {
    lines.push('VISION_QUALITY_RETRY');
    lines.push(`VISION_FAILURE_REASONS: ${reasons.join(',')}`);
    if (quality?.message) lines.push(`VISION_FAILURE_MESSAGE: ${String(quality.message).slice(0, 240)}`);
    const structure = quality?.metrics?.structure || {};
    const expected = [
      structure.expectsAlgorithm ? 'algorithm' : '',
      structure.expectsFigure ? 'figure' : '',
      structure.expectsTable ? 'table' : '',
    ].filter(Boolean);
    if (expected.length) lines.push(`VISION_EXPECTED_STRUCTURES: ${expected.join(',')}`);
    const missingGroups = quality?.metrics?.missingAnchors || {};
    const missing = Object.values(missingGroups).flatMap((items) => Array.isArray(items) ? items : [])
      .map((item) => String(item || '').replace(/\s+/gu, ' ').trim())
      .filter(Boolean)
      .slice(0, 24);
    if (missing.length) lines.push(`VISION_MISSING_ANCHORS: ${missing.join(' | ').slice(0, 360)}`);
  }
  if (source) {
    lines.push('SOURCE_TEXT_HINT_BEGIN', source, 'SOURCE_TEXT_HINT_END');
  }
  return lines.join('\n');
}

function hasPathologicalRepetition(text) {
  const t = String(text || '');
  if (t.length < 120) return false;
  // Immediate run: same 16–100 char chunk repeated 5+ times back-to-back.
  if (/([\s\S]{16,100})\1{4,}/.test(t)) return true;
  // High frequency of a medium window (e.g. "Wait, it's O(M...") across the page.
  for (const size of [24, 36, 48]) {
    if (t.length < size * 6) continue;
    const sample = t.slice(Math.floor(t.length * 0.3), Math.floor(t.length * 0.3) + size);
    if (sample.trim().length < size * 0.8) continue;
    let hits = 0;
    for (let i = 0; i + size <= t.length; i += Math.max(4, Math.floor(size / 3))) {
      if (t.slice(i, i + size) === sample) hits += 1;
      if (hits >= 6) return true;
    }
  }
  return false;
}

/** Drop a trailing self-talk appendix if a usable translation prefix exists. */
export function stripTrailingModelSelfTalk(text) {
  const source = String(text || '');
  if (!source.trim()) return source;
  const markers = [
    /\n(?:Wait[,.]?\s+let me|Let me (?:look|check|think|re-?read)|Actually[,.]?\s+wait)\b/i,
    /\n(?:Hmm[,.]?\s+|Okay[,.]?\s+so\b)/i,
  ];
  let cut = -1;
  for (const re of markers) {
    const match = re.exec(source);
    if (match && (cut < 0 || match.index < cut)) cut = match.index;
  }
  if (cut < 0) return source;
  const head = source.slice(0, cut).trim();
  // Only keep the head if it already looks like real content.
  if (head.length >= 80 || /[\u4e00-\u9fff]{8,}/.test(head) || /^#{1,3}\s/m.test(head)) {
    return head;
  }
  return source;
}

export function transitionPageOutcome(page, nextOutcome) {
  const previous = page.translationOutcome || '';
  if (previous === nextOutcome) return { doneDelta: 0, failedDelta: 0 };
  page.translationOutcome = nextOutcome;
  return {
    doneDelta: Number(nextOutcome === 'done') - Number(previous === 'done'),
    failedDelta: Number(nextOutcome === 'failed') - Number(previous === 'failed'),
  };
}

export function neutralizeRawHtml(markdown) {
  return String(markdown || '').replace(/<(?=\/?[A-Za-z]|!)/g, '&lt;');
}

export function escapeHtmlText(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function sanitizeMarkedHtml(html) {
  return String(html || '').replace(
    /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (match, attribute, doubleQuoted, singleQuoted, unquoted) => {
      const quote = doubleQuoted != null ? '"' : singleQuoted != null ? "'" : '"';
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
      const url = String(value || '').trim();
      const safe = attribute.toLowerCase() === 'href'
        ? /^(?:https?:|mailto:|#)/i.test(url)
        : /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(url);
      return safe ? ` ${attribute.toLowerCase()}=${quote}${url}${quote}` : '';
    },
  );
}

export function createFormulaRequest(id, image, sourceText = '') {
  return {
    type: 'translate',
    id,
    image,
    text: String(sourceText || ''),
    formula: true,
    priority: false,
  };
}

export function createFormulaBatchRequest(id, image, formulas) {
  const hints = normalizeFormulaHints(formulas);
  return {
    type: 'translate',
    id,
    image,
    text: JSON.stringify({ formulas: hints }),
    formulaBatch: true,
    priority: false,
  };
}
