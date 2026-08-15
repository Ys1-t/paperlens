// Formula-OCR canonicalization and structural quality checks.
//
// KaTeX parseability alone is not a useful OCR quality signal: strings such
// as `//∇θk...//2` are technically renderable after Unicode normalization but
// have already lost norm delimiters and script structure.  These helpers run
// before KaTeX so questionable OCR falls back to the authoritative PDF crop.

import { normalizeMathForKatex } from './math-normalization.js';

const SUBSCRIPT_DIGITS = new Map([
  ['₀', '0'], ['₁', '1'], ['₂', '2'], ['₃', '3'], ['₄', '4'],
  ['₅', '5'], ['₆', '6'], ['₇', '7'], ['₈', '8'], ['₉', '9'],
]);

const GREEK_COMMAND = String.raw`(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)`;

function normOrderSuffix(order) {
  const digit = SUBSCRIPT_DIGITS.get(order) || order;
  return digit ? `_{${digit}}` : '';
}

function replaceNormPair(value, pattern) {
  return value.replace(pattern, (_match, body, order = '') => (
    `\\lVert ${String(body || '').trim()} \\rVert${normOrderSuffix(order)}`
  ));
}

function replaceUnescapedTildes(value) {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== '~') {
      result += character;
      continue;
    }
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) slashCount++;
    result += slashCount % 2 === 0 ? '\\sim{}' : character;
  }
  return result;
}

/**
 * Repair a small, unambiguous class of visual-OCR mistakes.
 *
 * This deliberately does not guess flattened subscripts.  When those remain,
 * the quality gate rejects the transcription and the UI uses the source crop.
 */
export function canonicalizeFormulaLatex(value) {
  let latex = String(value || '').trim();
  if (!latex) return '';

  // Vision OCR commonly emits the standard TeX delimiter spelling
  // `\left\| ... \right\|`. It is semantically identical to
  // `\left\lVert ... \right\rVert`, but the quality gate deliberately
  // counts directional norm pairs. Canonicalize it before validation.
  latex = latex
    .replace(/\\left\s*\\(?:\||Vert)(?![A-Za-z])/g, String.raw`\left\lVert`)
    .replace(/\\right\s*\\(?:\||Vert)(?![A-Za-z])/g, String.raw`\right\rVert`);

  // OCR commonly mistakes two vertical norm strokes for paired slashes.
  latex = replaceNormPair(latex, /\/\/([\s\S]+?)\/\/([0-9₀-₉]?)/g);
  latex = replaceNormPair(latex, /\|\|([\s\S]+?)\|\|([0-9₀-₉]?)/g);
  latex = replaceNormPair(latex, /[∥‖]([\s\S]+?)[∥‖]([0-9₀-₉]?)/g);
  latex = replaceUnescapedTildes(latex);

  latex = normalizeMathForKatex(latex);
  if (!latex) return '';

  // Unicode normalization represents ∥ as \Vert{}. Give a paired norm an
  // explicit opening and closing direction and restore a trailing norm order.
  latex = replaceNormPair(latex, /\\Vert\{\}([\s\S]+?)\\Vert\{\}([0-9]?)/g);
  latex = replaceNormPair(latex, /\\Vert\s+([\s\S]+?)\\Vert\s*([0-9]?)/g);
  latex = latex.replace(
    /(\\rVert)(?:\s*)([0-9])(?=\s*(?:$|[<>=+\-]|\\(?:le|ge|ne|approx|equiv)\b))/g,
    '$1_{$2}',
  );
  return latex.trim();
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function normOrdersFromSource(sourceText) {
  const source = String(sourceText || '');
  return [...source.matchAll(/(?:[∥‖]|\|\||\/\/)\s*([0-9₀-₉])/g)]
    .map((match) => SUBSCRIPT_DIGITS.get(match[1]) || match[1]);
}

function sourceHasNorm(sourceText) {
  return /[∥‖]|\|\||\/\//.test(String(sourceText || ''));
}

function sourceNormPairCount(sourceText) {
  const source = String(sourceText || '');
  const unicodeBars = countMatches(source, /[∥‖]/g);
  const asciiPairs = countMatches(source, /\|\||\/\//g);
  return Math.floor(unicodeBars / 2) + Math.floor(asciiPairs / 2);
}

const SOURCE_FEATURES = [
  { source: /[∆Δ]/, latex: /\\Delta(?![A-Za-z])/, reason: 'lost-delta' },
  { source: /∇/, latex: /\\nabla(?![A-Za-z])/, reason: 'lost-nabla' },
  { source: /η/, latex: /\\eta(?![A-Za-z])/, reason: 'lost-eta' },
  { source: /θ/, latex: /\\theta(?![A-Za-z])/, reason: 'lost-theta' },
  { source: /λ/, latex: /\\lambda(?![A-Za-z])/, reason: 'lost-lambda' },
  { source: /Λ/, latex: /\\Lambda(?![A-Za-z])/, reason: 'lost-capital-lambda' },
  { source: /∑/, latex: /\\sum(?![A-Za-z])/, reason: 'lost-sum' },
  { source: /∏/, latex: /\\prod(?![A-Za-z])/, reason: 'lost-product' },
  { source: /∫/, latex: /\\int(?![A-Za-z])/, reason: 'lost-integral' },
  { source: /√/, latex: /\\sqrt(?:\b|\{)/, reason: 'lost-root' },
  { source: /≥/, latex: /(?:\\ge(?:q)?(?![A-Za-z])|>=)/, reason: 'lost-ge-relation' },
  { source: /≤/, latex: /(?:\\le(?:q)?(?![A-Za-z])|<=)/, reason: 'lost-le-relation' },
  { source: /≈/, latex: /\\approx(?![A-Za-z])/, reason: 'lost-approx-relation' },
];

function missingSourceFeature(sourceText, latex) {
  const source = String(sourceText || '');
  if (!source) return '';
  for (const feature of SOURCE_FEATURES) {
    if (feature.source.test(source) && !feature.latex.test(latex)) return feature.reason;
  }
  const sourceEquals = countMatches(source, /=/g);
  if (sourceEquals && countMatches(latex, /=/g) < sourceEquals) return 'lost-equality';
  if (/\+/.test(source) && !/(^|[^\\])\+/.test(latex)) return 'lost-plus';
  if (/[−-]/.test(source) && !/(^|[^\\])-/.test(latex)) return 'lost-minus';
  if (/(?:^|[^A-Za-z])O\s*\(/.test(source)
      && !/(?:\\mathcal\s*\{O\}|(?:^|[^A-Za-z\\])O)\s*(?:\\(?:!|,|:|;|quad|qquad|\s)\s*)*(?:\\left\s*)?\(/.test(latex)) {
    return 'lost-big-o';
  }
  return '';
}

/** Return a reasoned structural/semantic quality verdict for OCR LaTeX. */
export function assessFormulaLatex(value, { sourceText = '' } = {}) {
  const latex = String(value || '').trim();
  if (!latex) return { ok: false, reason: 'empty' };

  if (/\/\/|\|\||(^|[^\\])~/.test(latex)) {
    return { ok: false, reason: 'raw-ocr-delimiter' };
  }

  // Flattened PDF spans frequently become E_{lambda}_{k}_{sim}_{Lambda}_{k}
  // or theta^{(}^{t}^{+1)}.  They are neither valid TeX nor faithful math,
  // but a permissive preflight can otherwise let them reach a raw-text
  // fallback.  Reject repeated scripts before rendering or caching them.
  if (/(?:_\{[^{}]*\}|_[A-Za-z0-9])\s*(?:_\{|_[A-Za-z0-9])/.test(latex)) {
    return { ok: false, reason: 'double-subscript' };
  }
  if (/(?:\^\{[^{}]*\}|\^[A-Za-z0-9])\s*(?:\^\{|\^[A-Za-z0-9])/.test(latex)) {
    return { ok: false, reason: 'double-superscript' };
  }

  const leftNorms = countMatches(latex, /\\lVert(?![A-Za-z])/g);
  const rightNorms = countMatches(latex, /\\rVert(?![A-Za-z])/g);
  if (leftNorms !== rightNorms) return { ok: false, reason: 'unbalanced-norm' };
  if (sourceHasNorm(sourceText) && (!leftNorms || !rightNorms)) {
    return { ok: false, reason: 'lost-norm' };
  }
  const expectedNormPairs = sourceNormPairCount(sourceText);
  if (expectedNormPairs && leftNorms < expectedNormPairs) {
    return { ok: false, reason: 'lost-norm-count' };
  }

  const leftCommands = countMatches(latex, /\\left\b/g);
  const rightCommands = countMatches(latex, /\\right\b/g);
  if (leftCommands !== rightCommands) return { ok: false, reason: 'unbalanced-left-right' };

  if (/[∼~]/.test(String(sourceText || '')) && !/\\sim(?:\b|\{\})/.test(latex)) {
    return { ok: false, reason: 'lost-sim-relation' };
  }
  const expectedSimCount = countMatches(String(sourceText || ''), /[∼~]/g);
  if (expectedSimCount && countMatches(latex, /\\sim(?:\b|\{\})/g) < expectedSimCount) {
    return { ok: false, reason: 'lost-sim-count' };
  }

  const normOrders = normOrdersFromSource(sourceText);
  for (const normOrder of new Set(normOrders)) {
    // The PDF text layer retains a trailing digit but loses its vertical
    // position. Thus `∥x∥2` can represent either an L2 norm (`\rVert_2`) or a
    // squared norm (`\rVert^2`). D4L equation (17) is the latter. Trust the
    // visual OCR's recovered script direction and require either one.
    const orderPattern = new RegExp(
      String.raw`\\rVert\s*[_^]\s*(?:\{\s*${normOrder}\s*\}|${normOrder})`,
      'g',
    );
    const expectedOrderCount = normOrders.filter((order) => order === normOrder).length;
    if (countMatches(latex, orderPattern) < expectedOrderCount) {
      return { ok: false, reason: 'lost-norm-order' };
    }
  }

  // A cluster such as \theta{}k, \lambda{}k, \Lambda{}kg repeated through
  // one equation is the fingerprint of flattened PDF text being copied as
  // pseudo-LaTeX.  Real OCR should recover the visible subscripts/superscripts.
  const flattenedGreek = new RegExp(String.raw`\\${GREEK_COMMAND}\{\}[A-Za-z0-9]`, 'g');
  const flattenedCount = countMatches(latex, flattenedGreek);
  if (flattenedCount >= 2) {
    const scripts = countMatches(latex, /[_^]\s*(?:\{|[A-Za-z0-9\\])/g);
    if (scripts < Math.ceil(flattenedCount / 2)) {
      return { ok: false, reason: 'flattened-scripts' };
    }
  }

  const missingFeature = missingSourceFeature(sourceText, latex);
  if (missingFeature) return { ok: false, reason: missingFeature };

  return { ok: true, reason: '' };
}

export function normalizeFormulaHints(formulas) {
  const result = [];
  const seen = new Set();
  for (const formula of Array.isArray(formulas) ? formulas : []) {
    const id = typeof formula === 'string'
      ? formula.trim()
      : String(formula?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      source_text: typeof formula === 'object'
        ? String(formula?.source_text ?? formula?.sourceText ?? '').trim()
        : '',
    });
  }
  return result;
}
