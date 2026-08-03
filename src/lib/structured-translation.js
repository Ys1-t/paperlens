import { collectTranslatableItems, normalizePageIr } from './page-ir.js';
import { looksLikeBibliographyEntry } from './bibliography-format.js';

export const STRUCTURED_TABLE_CONFIDENCE = 0.80;
export const READING_TABLE_CONFIDENCE = 0.90;
export const MAX_READING_TABLE_CELLS = 512;
export const MAX_READING_TABLE_TEXT_CELLS = 96;
export const MAX_READING_UNIT_MATH_TOKENS = 7;

const MATH_PLACEHOLDER_PREFIX = '[[PLM:';
const MATH_PLACEHOLDER_SUFFIX = ']]';
const MATH_PLACEHOLDER_CANDIDATE_PATTERN = /(?:\[\s*\[|［\s*［|【)\s*[PＰ]\s*[LＬ]\s*[MＭ]\s*[:：]\s*[^\r\n\[\]［］【】]+?\s*(?:\]\s*\]|］\s*］|】)/giu;

export class MathPlaceholderValidationError extends Error {
  constructor(message, { expected = [], actual = [], recoveryChanges = [] } = {}) {
    super(message);
    this.name = 'MathPlaceholderValidationError';
    this.expected = [...expected];
    this.actual = [...actual];
    this.recoveryChanges = [...recoveryChanges];
  }
}

export function buildMathPlaceholder(id) {
  if (typeof id !== 'string' || !id || /[\r\n]/u.test(id) || id.includes('@@@BLK@@@')) {
    throw new TypeError('Inline math ID cannot be represented as a stable placeholder');
  }
  let encodedId;
  try {
    encodedId = encodeURIComponent(id);
  } catch {
    throw new TypeError('Inline math ID cannot be represented as a stable placeholder');
  }
  return `${MATH_PLACEHOLDER_PREFIX}${encodedId}${MATH_PLACEHOLDER_SUFFIX}`;
}

function compactPlaceholderSyntax(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^【/u, '[[')
    .replace(/】$/u, ']]')
    .replace(/\s+/gu, '');
}

function canonicalMathToken(value) {
  const compact = compactPlaceholderSyntax(value);
  const match = /^\[\[PLM:([^\[\]\r\n]+)\]\]$/iu.exec(compact);
  return match ? `${MATH_PLACEHOLDER_PREFIX}${match[1]}${MATH_PLACEHOLDER_SUFFIX}` : null;
}

function mathPlaceholderMatches(value) {
  const text = String(value ?? '');
  const matches = [];
  MATH_PLACEHOLDER_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MATH_PLACEHOLDER_CANDIDATE_PATTERN)) {
    matches.push({
      raw: match[0],
      token: canonicalMathToken(match[0]) || match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

export function extractMathTokens(value) {
  return mathPlaceholderMatches(value).map((match) => match.token);
}

function normalizedExpectedTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : []).map((token) => (
    canonicalMathToken(String(token)) || String(token)
  ));
}

function potentialPlaceholderStart(value) {
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '[' && character !== '［' && character !== '【') continue;
    const compact = compactPlaceholderSyntax(text.slice(index));
    if (MATH_PLACEHOLDER_PREFIX.startsWith(compact)
      || compact.startsWith(MATH_PLACEHOLDER_PREFIX)) return index;
  }
  return -1;
}

export function validateMathTokens(expectedTokens, translatedTextOrTokens) {
  const expected = normalizedExpectedTokens(expectedTokens);
  const isTokenArray = Array.isArray(translatedTextOrTokens);
  const translatedText = isTokenArray ? '' : String(translatedTextOrTokens ?? '');
  const actual = isTokenArray
    ? normalizedExpectedTokens(translatedTextOrTokens)
    : extractMathTokens(translatedText);
  const residual = isTokenArray
    ? ''
    : translatedText.replace(MATH_PLACEHOLDER_CANDIDATE_PATTERN, '');
  const hasTokenFragment = !isTokenArray
    && (potentialPlaceholderStart(residual) >= 0 || /P\s*L\s*M\s*[:：]/iu.test(residual));
  const valid = actual.length === expected.length
    && actual.every((token, index) => token === expected[index])
    && !hasTokenFragment;
  if (!valid) {
    throw new MathPlaceholderValidationError(
      '行内公式占位符被更改、增删、重复或调换了顺序。',
      { expected, actual },
    );
  }
  return actual;
}

export function serializeParagraph(block) {
  if (!block || block.kind !== 'paragraph' || !Array.isArray(block.segments)) {
    throw new TypeError('serializeParagraph expects a paragraph with ordered segments');
  }

  const mathTokens = [];
  const textSlots = [[]];
  const serialized = [];
  for (const segment of block.segments) {
    if (segment.kind === 'inline_math') {
      const token = buildMathPlaceholder(segment.id);
      mathTokens.push(token);
      serialized.push(token);
      textSlots.push([]);
      continue;
    }
    const text = typeof segment.text === 'string' ? segment.text : '';
    serialized.push(text);
    textSlots[textSlots.length - 1].push({ id: segment.id, text });
  }

  return {
    id: block.id,
    kind: 'math_paragraph',
    text: serialized.join(''),
    mathTokens,
    textSlots,
  };
}

function safeVisibleSlot(value) {
  const text = String(value ?? '');
  const tokenStart = potentialPlaceholderStart(text);
  return tokenStart >= 0 ? text.slice(0, tokenStart) : text;
}

function visibleMathParts(expectedTokens, rawText) {
  const raw = String(rawText ?? '');
  const expected = normalizedExpectedTokens(expectedTokens);
  const matches = mathPlaceholderMatches(raw);
  const parts = [];
  let cursor = 0;
  let matchIndex = 0;
  for (const token of expected) {
    const match = matches[matchIndex];
    if (!match || match.token !== token) {
      const end = match ? match.start : raw.length;
      parts.push(safeVisibleSlot(raw.slice(cursor, end)));
      return parts;
    }
    parts.push(safeVisibleSlot(raw.slice(cursor, match.start)));
    cursor = match.end;
    matchIndex += 1;
  }
  const extra = matches[matchIndex];
  parts.push(safeVisibleSlot(raw.slice(cursor, extra ? extra.start : raw.length)));
  return parts;
}

function splitValidatedMathParts(expectedTokens, rawText) {
  const raw = String(rawText ?? '');
  validateMathTokens(expectedTokens, raw);
  const matches = mathPlaceholderMatches(raw);
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(raw.slice(cursor, match.start));
    cursor = match.end;
  }
  parts.push(raw.slice(cursor));
  return parts;
}

export function createPlaceholderStreamParser(expectedTokens) {
  const expected = Array.isArray(expectedTokens) ? expectedTokens.map(String) : [];
  const chunks = [];
  let lastVisible = [];
  return {
    push(delta) {
      chunks.push(String(delta ?? ''));
      const visible = visibleMathParts(expected, chunks.join(''));
      if (visible.length === lastVisible.length
        && visible.every((part, index) => part === lastVisible[index])) return [];
      lastVisible = visible;
      return [...visible];
    },
    finish(text = chunks.join('')) {
      const raw = String(text ?? '');
      const tokens = validateMathTokens(expected, raw);
      return { parts: splitValidatedMathParts(expected, raw), tokens };
    },
    get raw() {
      return chunks.join('');
    },
  };
}

const NUMBER_CORE = '[+\\-−]?(?:\\d+(?:[.,]\\d+)?|\\.\\d+)(?:e[+\\-−]?\\d+)?';
const NUMERIC_VALUE = new RegExp(
  `^\\s*${NUMBER_CORE}(?:(?:\\s*(?:±|\\+\\/\\-)\\s*${NUMBER_CORE})|(?:\\s*\\(\\s*${NUMBER_CORE}\\s*\\)))?\\s*(?:%|[+\\-−≈])?(?:\\s*[a-zµμ]+(?:\\s*[\\/·]\\s*[a-zµμ]+)*)?\\s*$`,
  'i',
);

function numericCell(text) {
  const value = String(text || '').trim();
  return value !== '' && NUMERIC_VALUE.test(value);
}

export function createStructuredTranslationPlan(page) {
  const normalized = normalizePageIr(page);
  const hiddenCellIds = new Set();
  for (const block of normalized.blocks) {
    if (block.kind !== 'table'
      || typeof block.confidence !== 'number'
      || block.confidence >= STRUCTURED_TABLE_CONFIDENCE) continue;
    for (const row of block.rows) {
      for (const cell of row) hiddenCellIds.add(cell.id);
    }
  }
  const contextualParagraphs = new Map();
  const segmentOwners = new Map();
  for (const block of normalized.blocks) {
    if (block.kind !== 'paragraph'
      || !block.segments.some((segment) => segment.kind === 'inline_math')) continue;
    const item = serializeParagraph(block);
    if (!item.textSlots.some((slot) => slot.length > 0)) continue;
    contextualParagraphs.set(block.id, item);
    for (const slot of item.textSlots) {
      for (const segment of slot) segmentOwners.set(segment.id, block.id);
    }
  }

  const emittedParagraphs = new Set();
  const items = [];
  for (const item of collectTranslatableItems(normalized)) {
    if (hiddenCellIds.has(item.id)) continue;
    const ownerId = segmentOwners.get(item.id);
    if (!ownerId) {
      items.push(item);
      continue;
    }
    if (!emittedParagraphs.has(ownerId)) {
      items.push(contextualParagraphs.get(ownerId));
      emittedParagraphs.add(ownerId);
    }
  }

  return { page: normalized, items };
}

/**
 * Translation plan for the Typed Page IR path. Only source text nodes are sent
 * to the model; inline/display math remains in the local Page IR and is never
 * represented by a model-visible placeholder.
 */
export function createTextNodeTranslationPlan(page) {
  const normalized = normalizePageIr(page);
  const hiddenCellIds = new Set();
  for (const block of normalized.blocks) {
    if (block.kind !== 'table'
      || typeof block.confidence !== 'number'
      || block.confidence >= STRUCTURED_TABLE_CONFIDENCE) continue;
    for (const row of block.rows) {
      for (const cell of row) hiddenCellIds.add(cell.id);
    }
  }

  const items = collectTranslatableItems(normalized)
    .filter((item) => !hiddenCellIds.has(item.id))
    .map((item) => ({ id: item.id, text: item.text }));
  return { page: normalized, items };
}

function readingParagraphUnit(block, sourceSegments = block.segments, id = block.id) {
  const mathTokens = [];
  const textSlots = [[]];
  const serialized = [];
  const segments = Array.isArray(sourceSegments) ? sourceSegments : [];

  for (const segment of segments) {
    if (segment.kind === 'inline_math') {
      const token = buildMathPlaceholder(segment.id);
      mathTokens.push(token);
      serialized.push(token);
      textSlots.push([]);
      continue;
    }
    if (segment.kind !== 'text') continue;
    const text = String(segment.text ?? '');
    serialized.push(text);
    textSlots[textSlots.length - 1].push({ id: segment.id, text });
  }

  if (!serialized.length && String(block.text || '').trim()) {
    serialized.push(String(block.text));
    textSlots[0].push({ id: block.id, text: String(block.text) });
  }

  return {
    id,
    kind: 'reading_unit',
    text: serialized.join(''),
    mathTokens,
    textSlots,
  };
}

function translationBearingSegment(segment) {
  if (segment?.kind !== 'text') return false;
  return /[A-Za-z\p{Script=Han}]/u.test(String(segment.text || ''));
}

const PREFERRED_READING_UNIT_MATH_TOKENS = 3;

function semanticReadingUnitBoundary(segment, mathCount) {
  if (!translationBearingSegment(segment)
    || mathCount < PREFERRED_READING_UNIT_MATH_TOKENS) return false;
  const text = String(segment.text || '');
  return /^\s*(?:(?:[.!?]\s+)(?=[A-Z\p{Script=Han}])|[;:]\s+|(?:if\s+and\s+only\s+if|such\s+that|provided\s+that|where(?:as)?|although|because|however|therefore|hence|then)\b)/iu.test(text);
}

function splitMathDenseParagraphSegments(sourceSegments) {
  const segments = Array.isArray(sourceSegments) ? sourceSegments : [];
  const mathCount = segments.reduce(
    (total, segment) => total + (segment?.kind === 'inline_math' ? 1 : 0),
    0,
  );
  if (mathCount <= PREFERRED_READING_UNIT_MATH_TOKENS) return [segments];

  const groups = [];
  let current = [];
  let currentMathCount = 0;
  let boundaryPending = false;

  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
    currentMathCount = 0;
    boundaryPending = false;
  };

  for (const segment of segments) {
    const semanticBoundary = current.length
      && semanticReadingUnitBoundary(segment, currentMathCount);
    const hardBoundary = boundaryPending && current.length
      && (segment?.kind === 'inline_math' || translationBearingSegment(segment));
    if (semanticBoundary || hardBoundary) {
      flush();
    }
    current.push(segment);
    if (segment?.kind === 'inline_math') {
      currentMathCount += 1;
      boundaryPending = currentMathCount >= MAX_READING_UNIT_MATH_TOKENS;
    }
  }
  flush();
  return groups;
}

function readingParagraphUnits(block) {
  const segments = Array.isArray(block.segments) ? block.segments : [];
  if (block.layout === 'algorithm'
    && segments.some((segment) => Number.isInteger(segment?.algorithm_line))) {
    const lineGroups = new Map();
    for (const segment of segments) {
      const line = Number.isInteger(segment?.algorithm_line) ? segment.algorithm_line : 0;
      if (!lineGroups.has(line)) lineGroups.set(line, []);
      lineGroups.get(line).push(segment);
    }
    return [...lineGroups.entries()].map(([line, group]) => (
      readingParagraphUnit(block, group, `${block.id}-line${line}`)
    ));
  }
  const groups = splitMathDenseParagraphSegments(segments);
  if (groups.length <= 1) return [readingParagraphUnit(block, segments, block.id)];
  return groups.map((group, index) => (
    readingParagraphUnit(block, group, `${block.id}-unit${index}`)
  ));
}

function directReadingUnit(id, text) {
  const value = String(text ?? '');
  return {
    id,
    kind: 'reading_unit',
    text: value,
    mathTokens: [],
    textSlots: [[{ id, text: value }]],
  };
}

export function isTrustedReadingTable(block) {
  const trustedDetector = block?.detector === 'pymupdf-layout'
    || block?.detector === 'pymupdf-ruled-text';
  if (!block || block.kind !== 'table'
    || !trustedDetector
    || !Number.isFinite(block.confidence)
    || block.confidence < READING_TABLE_CONFIDENCE
    || !Array.isArray(block.rows)) return false;

  let inferredColumns = 0;
  for (const row of block.rows) {
    if (!Array.isArray(row)) return false;
    inferredColumns = Math.max(inferredColumns, row.length);
  }
  const declaredColumns = Number.isInteger(block.columns) && block.columns >= 0
    ? block.columns
    : 0;
  const columns = Math.max(declaredColumns, inferredColumns);
  if (!block.rows.length || !columns
    || block.rows.length > MAX_READING_TABLE_CELLS
    || columns > MAX_READING_TABLE_CELLS) return false;
  // Page IR normalization pads every row to the declared/inferred width. Use
  // that eventual dense DOM size here instead of summing sparse source rows.
  return block.rows.length * columns <= MAX_READING_TABLE_CELLS;
}

const COMMON_TABLE_LABEL = new Set([
  'accuracy', 'average', 'baseline', 'category', 'dataset', 'description',
  'domain', 'error', 'evaluation', 'experiment', 'input', 'loss', 'mean',
  'median', 'method', 'metric', 'model', 'ours', 'output', 'parameter', 'parameters', 'params',
  'precision', 'problem', 'proposed', 'rank', 'recall', 'result', 'results',
  'score', 'setting', 'source', 'target', 'task', 'test', 'testing', 'time',
  'train', 'training', 'type', 'value', 'variant',
]);

function abbreviatedTableIdentifier(text) {
  const value = String(text || '').trim();
  const compact = value.replace(/[.\s]/gu, '');
  if (!compact) return false;
  if (/^[A-Z][A-Z0-9]*(?:[-/+][A-Z0-9]+)*$/u.test(compact)) return true;
  if (/^[A-Za-z]*[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9-]*$/u.test(compact)) return true;
  return /\d/u.test(compact) && /^[A-Za-z0-9_.+/-]+$/u.test(compact);
}

/**
 * Keep scientific values and identifiers local. Only natural-language labels
 * are eligible for provider translation; the caller supplies row/column
 * context so prose-like data cells do not accidentally become translation
 * work.
 */
/**
 * Product decision: scientific tables stay on the PDF side (like figures).
 * Never send table cells to the translator; only captions may be translated
 * via the caption text node elsewhere.
 */
export function shouldTranslateTableCell(cell, {
  rowIndex = -1,
  columnIndex = -1,
  headerRows = 0,
} = {}) {
  // Always false: rebuilt/translated grids look worse than the original crop.
  void cell; void rowIndex; void columnIndex; void headerRows;
  return false;
}

/** @deprecated internal helper kept for tests that probe label heuristics. */
export function wouldHaveTranslatedTableCell(cell, {
  rowIndex = -1,
  columnIndex = -1,
  headerRows = 0,
} = {}) {
  if (!cell || ['formula', 'inline_math', 'display_math'].includes(cell.kind)) return false;
  const text = String(cell.text || '').trim();
  if (!text || numericCell(text) || citationOnly(text)) return false;
  if (/\\[A-Za-z]+|[{}_^=<>]|[∑∏√∞≈≠≤≥∂∇∫]/u.test(text)) return false;
  if (/^(?:https?:\/\/|www\.|doi\s*:)/iu.test(text)) return false;

  const labelPosition = cell.role === 'header'
    || cell.role === 'row_header'
    || (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < headerRows)
    || columnIndex === 0;
  if (!labelPosition) return false;

  if (/\p{Script=Han}/u.test(text)) return true;
  const words = text.match(/[A-Za-z]+/gu) || [];
  if (!words.length || abbreviatedTableIdentifier(text)) return false;
  const normalizedWords = words.map((word) => word.toLowerCase());
  if (normalizedWords.some((word) => COMMON_TABLE_LABEL.has(word))) return true;
  if (words.length >= 2) return words.some((word) => /[a-z]{2,}/u.test(word));
  // An unknown title-cased singleton is more likely a method or dataset name
  // than prose (for example, Moonlight or ImageNet), so preserve it verbatim.
  return /^[a-z]{2,}$/u.test(words[0]);
}

function citationOnly(value) {
  const text = String(value || '').trim();
  return /^(?:\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]\s*[,.;:]?\s*)+$/u.test(text);
}

const AUTHOR_GLUE = new Set(['and', 'et', 'al', 'al.']);
const AFFILIATION_OR_ORG = /\b(university|department|institute|laboratory|school|college|center|centre|email|correspondence|inc\.|ltd\.|china|kong|usa|uk|germany|japan)\b/iu;

/**
 * Paper author lists (names + optional superscript markers). These should stay
 * as source text: the model usually returns English names unchanged, then the
 * quality gate rejects them as "untranslated" and leaves a purple skeleton.
 */
export function looksLikeAuthorLine(value) {
  const compact = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!compact || compact.length > 220) return false;
  if (/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+/u.test(compact)) return true;
  if (AFFILIATION_OR_ORG.test(compact)) return false;
  if (/^\s*(?:table|tab\.?|fig(?:ure)?\.?|表|图)\s*(?:[IVXLCDM]+|\d+)/iu.test(compact)) return false;
  if (/^\s*(?:algorithm|procedure)\s+\d+/iu.test(compact)) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ0-9\s,.\-–—*&†‡§¹²³⁴⁵⁶⁷⁸⁹⁰′'’]+$/u.test(compact)) return false;
  const words = compact.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/gu) || [];
  if (words.length < 2 || words.length > 20) return false;
  let glue = 0;
  let nameLike = 0;
  for (const word of words) {
    const lowered = word.toLowerCase().replace(/\.$/u, '');
    if (AUTHOR_GLUE.has(lowered) || lowered === 'al') {
      glue += 1;
      continue;
    }
    if (/^[A-Z][a-zà-öø-ÿ'\-]+$/u.test(word)
      || /^[A-Z]\.?$/u.test(word)
      || (/^[A-Z]{2,3}$/u.test(word))) {
      nameLike += 1;
      continue;
    }
    if (/^[a-zà-öø-ÿ]{2,}$/u.test(word)) return false;
    return false;
  }
  const content = words.length - glue;
  if (content < 2 || nameLike < Math.max(2, Math.ceil(content * 0.85))) return false;
  const hasMarker = /(?:\d|[¹²³⁴⁵⁶⁷⁸⁹⁰*†‡])/u.test(compact);
  if (!hasMarker && (content > 8 || compact.length > 90)) return false;
  return true;
}

function isAuthorBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.translatable === false) return true;
  const role = String(block.role || block.content_role || '').toLowerCase();
  return role === 'author';
}

function shouldTranslateReadingUnit(value) {
  const text = String(value || '').replace(MATH_PLACEHOLDER_CANDIDATE_PATTERN, '').trim();
  if (!text || /^\d{1,4}$/u.test(text) || citationOnly(text)) return false;
  if (looksLikeAuthorLine(text)) return false;
  // Keep bibliography entries in source form: [n] Author, Title, Venue, year.
  if (looksLikeBibliographyEntry(text)) return false;
  return /[A-Za-z\p{Script=Han}]/u.test(text);
}

function mergeCitationIntoPrevious(previous, citation) {
  if (!previous || previous.kind !== 'reading_unit' || !citation?.textSlots?.length) return false;
  const separator = previous.text && !/\s$/u.test(previous.text) ? ' ' : '';
  previous.text += separator + citation.text.trim();
  const targetSlot = previous.textSlots[previous.textSlots.length - 1];
  for (const slot of citation.textSlots) targetSlot.push(...slot);
  return true;
}

/**
 * Moonlight-style fast-reading plan: one coherent item per normal paragraph,
 * bounded streaming units for formula-dense paragraphs, stable page ordering,
 * and local formula placeholders that never enter the visible translation.
 * The viewer may send these units in small provider batches. Untrusted tables
 * contribute only their caption; a bounded learned grid may also contribute
 * natural-language headers and row labels while values remain local.
 */
export function createReadingTranslationPlan(page) {
  const normalized = normalizePageIr(page);
  const items = [];

  for (const block of normalized.blocks) {
    // Author lines and other non-translatable chrome stay visible via
    // settleStructuredSourceOnlyNodes, but must not occupy an LLM slot.
    if (isAuthorBlock(block) || looksLikeAuthorLine(block.text)) continue;
    let candidates = [];
    if (block.kind === 'paragraph') candidates = readingParagraphUnits(block);
    else if (['heading', 'caption', 'plain_text'].includes(block.kind)) {
      candidates = [directReadingUnit(block.id, block.text)];
    } else if ((block.kind === 'table' || block.kind === 'figure') && block.caption) {
      candidates = [directReadingUnit(block.caption.id, block.caption.text)];
    }
    if (block.kind === 'table' && isTrustedReadingTable(block)) {
      let tableTextCells = 0;
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex];
        for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
          const cell = row[columnIndex];
          if (tableTextCells >= MAX_READING_TABLE_TEXT_CELLS
            || !shouldTranslateTableCell(cell, {
              rowIndex,
              columnIndex,
              headerRows: block.header_rows,
            })) continue;
          candidates.push(directReadingUnit(cell.id, cell.text));
          tableTextCells += 1;
        }
      }
    }
    for (const item of candidates) {
      if (!item?.text.trim()) continue;
      if (citationOnly(item.text)
        && mergeCitationIntoPrevious(items[items.length - 1], item)) continue;
      if (shouldTranslateReadingUnit(item.text)) items.push(item);
    }
  }

  return { page: normalized, items };
}

export function expandReadingTranslationChange(item, translatedText) {
  if (!item || item.kind !== 'reading_unit') {
    return item?.id ? [{ id: item.id, text: String(translatedText ?? '') }] : [];
  }
  const mathTokens = Array.isArray(item.mathTokens) ? item.mathTokens : [];
  const parts = mathTokens.length
    ? splitValidatedMathParts(mathTokens, String(translatedText ?? ''))
    : [String(translatedText ?? '')];
  const slots = Array.isArray(item.textSlots) ? item.textSlots : [];
  if (parts.length !== slots.length) {
    throw new MathPlaceholderValidationError('公式两侧文本分段数不匹配。', {
      expected: mathTokens,
      actual: extractMathTokens(translatedText),
    });
  }

  const changes = [];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = Array.isArray(slots[index]) ? slots[index] : [];
    if (!slot.length) continue;
    changes.push({ id: slot[0].id, text: parts[index] });
    for (let target = 1; target < slot.length; target += 1) {
      changes.push({ id: slot[target].id, text: '' });
    }
  }
  return changes;
}

export function buildTableModel(block) {
  const page = normalizePageIr({
    index: 0,
    width: 0,
    height: 0,
    images: {},
    blocks: [{ ...block, kind: 'table' }],
  });
  const table = page.blocks[0];
  const rows = table.rows.map((row) => row.map((cell) => ({
    ...cell,
    numeric: numericCell(cell.text),
  })));
  const headerCount = Math.min(table.header_rows, rows.length);
  const lowConfidence = typeof table.confidence === 'number'
    && table.confidence < STRUCTURED_TABLE_CONFIDENCE;
  const trustedReading = isTrustedReadingTable(table);

  return {
    id: table.id,
    bbox: table.bbox,
    columns: table.columns,
    caption: table.caption,
    imageRef: table.image_ref || table.imageRef || '',
    trustedReading,
    cellCount: rows.reduce((total, row) => total + row.length, 0),
    headerRows: rows.slice(0, headerCount),
    bodyRows: rows.slice(headerCount),
    sourceReference: lowConfidence
      ? { label: '查看左侧原表', bbox: table.bbox }
      : null,
  };
}

export function updateStructuredTextNode(nodeMap, id, text) {
  const node = nodeMap instanceof Map ? nodeMap.get(id) : null;
  if (!node || !('textContent' in node)) return false;
  node.textContent = String(text ?? '');
  node.classList?.remove?.('structured-text-pending', 'structured-text-failed');
  node.removeAttribute?.('aria-label');
  return true;
}

export function chooseStructuredTranslation(source, translated) {
  const value = typeof translated === 'string' ? translated : '';
  return value.trim() ? value : String(source ?? '');
}

export function createStructuredTranslationAccumulator(items) {
  const sourceItems = Array.isArray(items) ? items : [];
  const values = new Map();
  for (const item of sourceItems) {
    if (item?.kind === 'math_paragraph') {
      for (const slot of item.textSlots || []) {
        for (const segment of slot || []) values.set(segment.id, segment.text);
      }
    } else if (item && typeof item.id === 'string') {
      values.set(item.id, item.text);
    }
  }
  const rawParts = [];
  let currentParts = [];
  let currentLength = 0;
  let itemIndex = 0;
  const marker = '@@@BLK@@@';
  let markerMatch = 0;
  let pendingNewlines = '';
  let discardLeadingNewlines = false;
  let emittedCurrent = false;
  let lastEmittedLength = 0;
  const EMIT_INTERVAL = 512;

  const setValue = (id, source, translated, final = false) => {
    if (typeof id !== 'string') return null;
    if (!String(translated || '').trim() && !final) return null;
    const text = chooseStructuredTranslation(source, translated);
    if (values.get(id) === text) return null;
    values.set(id, text);
    return { id, text };
  };

  const applyMathParts = (item, parts, changed, final = false) => {
    const slots = Array.isArray(item.textSlots) ? item.textSlots : [];
    for (let slotIndex = 0; slotIndex < parts.length && slotIndex < slots.length; slotIndex += 1) {
      const slot = Array.isArray(slots[slotIndex]) ? slots[slotIndex] : [];
      if (slot.length === 0) continue;
      const combinedSource = slot.map((segment) => String(segment.text ?? '')).join('');
      const first = setValue(slot[0].id, combinedSource, parts[slotIndex], final);
      if (first) changed.push(first);
      if (!final) continue;
      for (let segmentIndex = 1; segmentIndex < slot.length; segmentIndex += 1) {
        const cleared = setValue(slot[segmentIndex].id, '', '', true);
        if (cleared) changed.push(cleared);
      }
    }
  };

  const emitItem = (index, translated, changed, final = false) => {
    const item = sourceItems[index];
    if (!item) return;
    if (item.kind === 'math_paragraph') {
      const parts = final
        ? splitValidatedMathParts(item.mathTokens || [], translated)
        : visibleMathParts(item.mathTokens || [], translated);
      applyMathParts(item, parts, changed, final);
      return;
    }
    const update = setValue(item.id, item.text, translated, final);
    if (update) changed.push(update);
  };

  const appendCurrent = (value) => {
    if (!value) return;
    currentParts.push(value);
    currentLength += value.length;
  };

  const currentText = () => currentParts.join('');

  const emitCurrent = (changed, force = false) => {
    const item = sourceItems[itemIndex];
    if (!item) return;
    if (currentLength === 0) return;
    if (!force && item.kind !== 'math_paragraph'
      && emittedCurrent && currentLength - lastEmittedLength < EMIT_INTERVAL) return;
    emitItem(itemIndex, currentText(), changed, false);
    emittedCurrent = true;
    lastEmittedLength = currentLength;
  };

  const completeMarker = (changed) => {
    pendingNewlines = '';
    emitCurrent(changed, true);
    if (itemIndex < sourceItems.length - 1) {
      itemIndex += 1;
      currentParts = [];
      currentLength = 0;
      emittedCurrent = false;
      lastEmittedLength = 0;
    } else {
      // 模型偶尔会多输出分隔符。最后一项保留后续正文，但绝不显示 token。
      appendCurrent('\n\n');
    }
    markerMatch = 0;
    discardLeadingNewlines = true;
  };

  const feedCharacter = (character, changed) => {
    if (discardLeadingNewlines && (character === '\r' || character === '\n')) return;
    if (discardLeadingNewlines) discardLeadingNewlines = false;

    if (markerMatch > 0) {
      if (character === marker[markerMatch]) {
        markerMatch += 1;
        if (markerMatch === marker.length) completeMarker(changed);
        return;
      }
      appendCurrent(pendingNewlines);
      pendingNewlines = '';
      appendCurrent(marker.slice(0, markerMatch));
      markerMatch = 0;
      feedCharacter(character, changed);
      return;
    }

    if (character === '\r' || character === '\n') {
      pendingNewlines += character;
      return;
    }

    if (character === marker[0]) {
      markerMatch = 1;
      return;
    }

    appendCurrent(pendingNewlines);
    pendingNewlines = '';
    appendCurrent(character);
  };

  const consumeDelta = (delta) => {
    const chunk = String(delta ?? '');
    rawParts.push(chunk);
    const changed = [];
    for (const character of chunk) feedCharacter(character, changed);
    emitCurrent(changed, false);
    return changed;
  };

  const collectFinalChanges = (nextRaw) => {
    const finalRaw = String(nextRaw ?? '');
    const parts = finalRaw.split(/[\r\n]*@@@BLK@@@[\r\n]*/g);
    const changed = [];
    const successfulChanges = [];
    const recoveryChanges = [];
    const failedItems = [];

    sourceItems.forEach((item, index) => {
      const translated = index < sourceItems.length - 1
        ? (parts[index] || '')
        : parts.slice(index).join('\n\n');
      const itemChanges = [];
      try {
        emitItem(index, translated, itemChanges, true);
        changed.push(...itemChanges);
        successfulChanges.push(...itemChanges);
      } catch (error) {
        if (!(error instanceof MathPlaceholderValidationError)
          || item?.kind !== 'math_paragraph') throw error;
        const itemRecovery = [];
        for (const slot of item.textSlots || []) {
          for (const segment of slot || []) {
            const update = { id: segment.id, text: String(segment.text ?? '') };
            values.set(segment.id, update.text);
            itemRecovery.push(update);
          }
        }
        changed.push(...itemRecovery);
        recoveryChanges.push(...itemRecovery);
        failedItems.push({
          id: item.id,
          index,
          code: 'math_placeholder_validation',
          message: error.message,
          expected: [...error.expected],
          actual: [...error.actual],
          recovered: true,
          recoveryChanges: itemRecovery,
        });
      }
    });

    Object.defineProperties(changed, {
      changes: { value: changed },
      successfulChanges: { value: successfulChanges },
      failedItems: { value: failedItems },
      recoveryChanges: { value: recoveryChanges },
      diagnostics: { value: { failedItems, recoveryChanges } },
      ok: { value: failedItems.length === 0 },
    });
    return changed;
  };

  return {
    push(delta) {
      return consumeDelta(delta);
    },
    finish(text = rawParts.join('')) {
      return collectFinalChanges(text);
    },
    value(id) {
      return values.get(id);
    },
    get raw() {
      return rawParts.join('');
    },
  };
}
