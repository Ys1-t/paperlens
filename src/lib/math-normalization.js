// Canonicalize PDF/OCR math Unicode before it reaches KaTeX.
//
// PDF font encodings and vision models often emit compatibility glyphs such as
// the Ohm sign, mathematical italic Greek, or a script capital L. KaTeX can
// sometimes display these but logs missing-metric/strict warnings, which Edge
// records as extension errors. Known symbols become ASCII LaTeX commands;
// unknown non-ASCII input is rejected so the viewer can use its source crop.

const UNICODE_MATH_TO_LATEX = new Map([
  ['\u00a0', ' '], ['\u200b', ''], ['\u2061', ''], ['\u2062', ''], ['\u2063', ''], ['\u2064', ''],
  ['−', '-'], ['×', '\\times{}'], ['÷', '\\div{}'], ['±', '\\pm{}'], ['∓', '\\mp{}'],
  ['∼', '\\sim{}'], ['˜', '\\sim{}'], ['≃', '\\simeq{}'], ['≅', '\\cong{}'],
  ['≤', '\\le{}'], ['≥', '\\ge{}'], ['≠', '\\ne{}'], ['≈', '\\approx{}'], ['≡', '\\equiv{}'],
  ['∈', '\\in{}'], ['∉', '\\notin{}'], ['∋', '\\ni{}'], ['⊂', '\\subset{}'],
  ['⊆', '\\subseteq{}'], ['⊃', '\\supset{}'], ['⊇', '\\supseteq{}'],
  ['∪', '\\cup{}'], ['∩', '\\cap{}'], ['∑', '\\sum{}'], ['∏', '\\prod{}'],
  ['∫', '\\int{}'], ['∮', '\\oint{}'], ['√', '\\sqrt{}'], ['∞', '\\infty{}'],
  ['∂', '\\partial{}'], ['∇', '\\nabla{}'], ['∆', '\\Delta{}'],
  ['→', '\\to{}'], ['←', '\\leftarrow{}'], ['↔', '\\leftrightarrow{}'], ['↦', '\\mapsto{}'],
  ['⇒', '\\Rightarrow{}'], ['⇐', '\\Leftarrow{}'], ['⇔', '\\Leftrightarrow{}'],
  ['∥', '\\Vert{}'], ['‖', '\\Vert{}'], ['∣', '\\mid{}'], ['⊥', '\\perp{}'],
  ['∝', '\\propto{}'], ['∀', '\\forall{}'], ['∃', '\\exists{}'], ['¬', '\\neg{}'],
  ['∧', '\\land{}'], ['∨', '\\lor{}'], ['⊕', '\\oplus{}'], ['⊗', '\\otimes{}'],
  ['∘', '\\circ{}'], ['·', '\\cdot{}'], ['⋅', '\\cdot{}'], ['•', '\\bullet{}'],
  ['…', '\\ldots{}'], ['′', '^{\\prime}'], ['″', '^{\\prime\\prime}'], ['°', '^{\\circ}'],
  ['¹', '^{1}'], ['²', '^{2}'], ['³', '^{3}'], ['⁴', '^{4}'], ['⁵', '^{5}'],
  ['⁶', '^{6}'], ['⁷', '^{7}'], ['⁸', '^{8}'], ['⁹', '^{9}'], ['⁰', '^{0}'],
  ['₁', '_{1}'], ['₂', '_{2}'], ['₃', '_{3}'], ['₄', '_{4}'], ['₅', '_{5}'],
  ['₆', '_{6}'], ['₇', '_{7}'], ['₈', '_{8}'], ['₉', '_{9}'], ['₀', '_{0}'],
  ['ℓ', '\\ell{}'], ['ℝ', '\\mathbb{R}'], ['ℕ', '\\mathbb{N}'], ['ℤ', '\\mathbb{Z}'],
  ['ℚ', '\\mathbb{Q}'], ['ℂ', '\\mathbb{C}'], ['𝓛', '\\mathcal{L}'],
  ['µ', '\\mu{}'], ['Ω', '\\Omega{}'],
  ['𝜽', '\\boldsymbol{\\theta}'], ['𝝀', '\\boldsymbol{\\lambda}'],
  ['α', '\\alpha{}'], ['β', '\\beta{}'], ['γ', '\\gamma{}'], ['δ', '\\delta{}'],
  ['ε', '\\epsilon{}'], ['ϵ', '\\varepsilon{}'], ['ζ', '\\zeta{}'], ['η', '\\eta{}'],
  ['θ', '\\theta{}'], ['ϑ', '\\vartheta{}'], ['ι', '\\iota{}'], ['κ', '\\kappa{}'],
  ['λ', '\\lambda{}'], ['μ', '\\mu{}'], ['ν', '\\nu{}'], ['ξ', '\\xi{}'],
  ['ο', 'o'], ['π', '\\pi{}'], ['ϖ', '\\varpi{}'], ['ρ', '\\rho{}'],
  ['ϱ', '\\varrho{}'], ['ς', '\\sigma{}'], ['σ', '\\sigma{}'], ['τ', '\\tau{}'],
  ['υ', '\\upsilon{}'], ['φ', '\\phi{}'], ['ϕ', '\\varphi{}'], ['χ', '\\chi{}'],
  ['ψ', '\\psi{}'], ['ω', '\\omega{}'],
  ['Γ', '\\Gamma{}'], ['Δ', '\\Delta{}'], ['Θ', '\\Theta{}'], ['Λ', '\\Lambda{}'],
  ['Ξ', '\\Xi{}'], ['Π', '\\Pi{}'], ['Σ', '\\Sigma{}'], ['Υ', '\\Upsilon{}'],
  ['Φ', '\\Phi{}'], ['Ψ', '\\Psi{}'], ['Ω', '\\Omega{}'],
  ['Α', 'A'], ['Β', 'B'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'H'], ['Ι', 'I'],
  ['Κ', 'K'], ['Μ', 'M'], ['Ν', 'N'], ['Ο', 'O'], ['Ρ', 'P'], ['Τ', 'T'], ['Χ', 'X'],
]);

function normalizeCharacter(character, depth = 0) {
  if (UNICODE_MATH_TO_LATEX.has(character)) return UNICODE_MATH_TO_LATEX.get(character);
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0x7f) return character;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
  if (character === '\ufffd') return null;

  if (depth < 2) {
    const compatible = character.normalize('NFKC');
    if (compatible !== character) {
      let output = '';
      for (const compatibleCharacter of compatible) {
        const normalized = normalizeCharacter(compatibleCharacter, depth + 1);
        if (normalized == null) return null;
        output += normalized;
      }
      return output;
    }
  }
  return null;
}

export function normalizeMathForKatex(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  let output = '';
  for (const character of source) {
    const normalized = normalizeCharacter(character);
    if (normalized == null) return '';
    output += normalized;
  }
  return output.trim();
}

/**
 * Lenient path for auto-render / vision Markdown: drop unknown non-ASCII
 * characters instead of rejecting the whole expression. Prefer this when the
 * formula is mixed with CJK prose accidentally left inside $...$ by the model.
 * Returns empty string if nothing renderable remains.
 */
export function softNormalizeMathForKatex(value) {
  return softNormalizeMathForKatexWithMeta(value).latex;
}

/** Soft normalize with metadata for incomplete-formula UI. */
export function softNormalizeMathForKatexWithMeta(value) {
  const source = String(value || '').trim();
  if (!source) return { latex: '', dropped: false, droppedCount: 0 };
  let output = '';
  let droppedCount = 0;
  for (const character of source) {
    const normalized = normalizeCharacter(character);
    if (normalized == null) {
      droppedCount += 1;
      continue;
    }
    output += normalized;
  }
  const trimmed = output.trim();
  if (!trimmed) return { latex: '', dropped: droppedCount > 0, droppedCount };
  if (droppedCount > 0 && !/[A-Za-z0-9\\]/.test(trimmed)) {
    return { latex: '', dropped: true, droppedCount };
  }
  return { latex: trimmed, dropped: droppedCount > 0, droppedCount };
}

export function normalizeDelimitedMath(value) {
  return prepareDelimitedMathForRender(value).text;
}

/**
 * Prepare a delimited math segment for Markdown restore + KaTeX auto-render.
 * incomplete=true when Unicode/CJK was stripped or the formula became plain text.
 */
export function prepareDelimitedMathForRender(value) {
  const source = String(value || '');
  const delimiters = [
    ['$$', '$$'],
    ['\\[', '\\]'],
    ['\\(', '\\)'],
    ['$', '$'],
  ];
  for (const [open, close] of delimiters) {
    if (!source.startsWith(open) || !source.endsWith(close)
      || source.length < open.length + close.length) continue;
    const inner = source.slice(open.length, source.length - close.length);
    const strict = normalizeMathForKatex(inner);
    if (strict) {
      return { text: `${open}${strict}${close}`, incomplete: false, plain: false };
    }
    const soft = softNormalizeMathForKatexWithMeta(inner);
    if (soft.latex) {
      return {
        text: `${open}${soft.latex}${close}`,
        incomplete: soft.dropped,
        plain: false,
      };
    }
    // Unrecognized expression: leave as plain prose so auto-render skips it.
    return { text: inner.trim(), incomplete: true, plain: true };
  }
  return { text: source, incomplete: false, plain: false };
}

/** Bare equation labels such as (3) / （12） from vision Markdown. */
const TRAILING_EQ_NUMBER = String.raw`([（(]\s*\d{1,4}\s*[)）])`;

/**
 * Vision models are instructed to put display-equation numbers outside $$...$$.
 * That becomes a separate paragraph under the formula. Fold trailing numbers
 * into KaTeX \\tag{N} so they sit on the right, matching paper layout.
 */
export function mergeTrailingEquationNumbers(markdown) {
  const source = String(markdown || '');
  if (!source) return source;

  const fold = (open, body, close, numberToken) => {
    // Already tagged: leave the trailing label alone (do not double-tag).
    if (/\\tag\b/.test(body)) return `${open}${body}${close}\n${numberToken}`;
    const bare = String(numberToken || '').replace(/[（()\s）]/g, '');
    if (!bare) return `${open}${body}${close}`;
    const trimmed = body.replace(/\s+$/u, '');
    const gap = trimmed && !trimmed.endsWith('\n') ? '\n' : '';
    return `${open}${trimmed}${gap}\\tag{${bare}}\n${close}`;
  };

  // $$...$$\n(3)  or  \[...\]\n(3)
  let output = source.replace(
    /(\$\$)([\s\S]+?)(\$\$)[ \t]*\r?\n[ \t]*([（(]\s*\d{1,4}\s*[)）])(?=\s*(?:\r?\n|$))/g,
    (_, open, body, close, numberToken) => fold(open, body, close, numberToken),
  );
  output = output.replace(
    /(\\\[)([\s\S]+?)(\\\])[ \t]*\r?\n[ \t]*([（(]\s*\d{1,4}\s*[)）])(?=\s*(?:\r?\n|$))/g,
    (_, open, body, close, numberToken) => fold(open, body, close, numberToken),
  );
  // Same-line: $$...$$ (3)
  output = output.replace(
    /(\$\$)([\s\S]+?)(\$\$)[ \t]+([（(]\s*\d{1,4}\s*[)）])(?=\s*(?:\r?\n|$))/g,
    (_, open, body, close, numberToken) => fold(open, body, close, numberToken),
  );
  output = output.replace(
    /(\\\[)([\s\S]+?)(\\\])[ \t]+([（(]\s*\d{1,4}\s*[)）])(?=\s*(?:\r?\n|$))/g,
    (_, open, body, close, numberToken) => fold(open, body, close, numberToken),
  );
  return output;
}

/** True when a DOM text node is only an equation number like (3). */
export function isStandaloneEquationNumber(text) {
  return new RegExp(`^\\s*${TRAILING_EQ_NUMBER}\\s*$`, 'u').test(String(text || ''));
}

export function extractBareEquationNumber(text) {
  const match = new RegExp(`^\\s*${TRAILING_EQ_NUMBER}\\s*$`, 'u').exec(String(text || ''));
  if (!match) return '';
  return match[1].replace(/[（()\s）]/g, '');
}
