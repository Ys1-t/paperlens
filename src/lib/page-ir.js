const BLOCK_KINDS = new Set([
  'heading',
  'paragraph',
  'display_math',
  'table',
  'figure',
  'caption',
  'plain_text',
]);

export const PAGE_IR_LIMITS = Object.freeze({
  blocks: 4096,
  segmentsPerBlock: 4096,
  tableRows: 2048,
  tableColumns: 256,
  tableCells: 20000,
  totalTableCells: 20000,
  totalNodes: 50000,
  textChars: 5 * 1024 * 1024,
});

export class PageIrLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageIrLimitError';
  }
}

function assertWithinLimit(label, count, limit) {
  if (count > limit) throw new PageIrLimitError(`${label} exceeds limit ${limit}`);
}

function addBudget(budget, key, amount, limit, label) {
  budget[key] += amount;
  assertWithinLimit(label, budget[key], limit);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) => !Number.isFinite(part))) {
    return [0, 0, 0, 0];
  }
  return value.map(Number);
}

function normalizeBboxes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeBbox)
    .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
}

function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function addId(id, fallback, seen) {
  const normalized = typeof id === 'string' && id ? id : fallback;
  if (seen.has(normalized)) throw new Error(`Duplicate IR id: ${normalized}`);
  seen.add(normalized);
  return normalized;
}

function normalizeSegment(segment, blockId, segmentIndex, seen) {
  const source = isObject(segment) ? segment : {};
  const kind = source.kind === 'inline_math' ? 'inline_math' : 'text';
  const suffix = kind === 'inline_math' ? `m${segmentIndex}` : `s${segmentIndex}`;
  const normalized = {
    ...source,
    id: addId(source.id, `${blockId}-${suffix}`, seen),
    kind,
  };
  if (kind === 'inline_math') {
    normalized.latex = stringValue(source.latex, stringValue(source.text));
    normalized.bbox = normalizeBbox(source.bbox);
  } else {
    normalized.text = stringValue(source.text);
    if (source.bbox !== undefined) normalized.bbox = normalizeBbox(source.bbox);
  }
  if (source.bboxes !== undefined) normalized.bboxes = normalizeBboxes(source.bboxes);
  return normalized;
}

function normalizeCaption(caption, fallbackId, seen) {
  if (!isObject(caption)) return null;
  return {
    ...caption,
    id: addId(caption.id, fallbackId, seen),
    text: stringValue(caption.text),
    position: caption.position === 'below' ? 'below' : 'above',
    alignment: caption.alignment === 'center' ? 'center' : 'left',
    ...(caption.bbox === undefined ? {} : { bbox: normalizeBbox(caption.bbox) }),
  };
}

function normalizeCell(cell, tableId, rowIndex, columnIndex, seen) {
  const source = isObject(cell) ? cell : { text: cell == null ? '' : String(cell) };
  return {
    ...source,
    id: addId(source.id, `${tableId}-r${rowIndex}-c${columnIndex}`, seen),
    text: stringValue(source.text, source.text == null ? '' : String(source.text)),
    role: source.role === 'row_header'
      ? 'row_header'
      : (source.role === 'header' ? 'header' : 'data'),
  };
}

function normalizeTableRows(rows, columns, tableId, seen) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, rowIndex) => {
    return Array.from(
      { length: columns },
      (_, columnIndex) => normalizeCell(row[columnIndex], tableId, rowIndex, columnIndex, seen),
    );
  });
}

function tableShape(source) {
  const rawRows = Array.isArray(source.rows) ? source.rows : [];
  assertWithinLimit('table rows', rawRows.length, PAGE_IR_LIMITS.tableRows);
  const denseRows = rawRows.filter(Array.isArray);
  const inferredColumns = denseRows.reduce(
    (largest, row) => Math.max(largest, row.length),
    0,
  );
  const explicitColumns = Number.isInteger(source.columns) && source.columns >= 0
    ? source.columns
    : 0;
  const columns = Math.max(explicitColumns, inferredColumns);
  assertWithinLimit('table columns', columns, PAGE_IR_LIMITS.tableColumns);
  assertWithinLimit('table cells', denseRows.length * columns, PAGE_IR_LIMITS.tableCells);
  return { denseRows, columns };
}

function sourceTextLength(value) {
  return typeof value === 'string' ? value.length : 0;
}

function preflightPage(blocks) {
  const budget = { nodes: 0, tableCells: 0, textChars: 0 };

  for (const source of blocks) {
    if (!isObject(source)) continue;
    addBudget(budget, 'nodes', 1, PAGE_IR_LIMITS.totalNodes, 'page nodes');
    addBudget(
      budget,
      'textChars',
      sourceTextLength(source.text) + sourceTextLength(source.latex) + sourceTextLength(source.number),
      PAGE_IR_LIMITS.textChars,
      'page text characters',
    );

    const kind = BLOCK_KINDS.has(source.kind) ? source.kind : 'plain_text';
    if (kind === 'paragraph') {
      const rawSegments = Array.isArray(source.segments) ? source.segments : [];
      assertWithinLimit('paragraph segments', rawSegments.length, PAGE_IR_LIMITS.segmentsPerBlock);
      const denseSegments = rawSegments.filter(isObject);
      const segmentCount = denseSegments.length || (sourceTextLength(source.text) > 0 ? 1 : 0);
      addBudget(budget, 'nodes', segmentCount, PAGE_IR_LIMITS.totalNodes, 'page nodes');
      for (const segment of denseSegments) {
        addBudget(
          budget,
          'textChars',
          sourceTextLength(segment.text) + sourceTextLength(segment.latex),
          PAGE_IR_LIMITS.textChars,
          'page text characters',
        );
      }
      if (denseSegments.length === 0 && segmentCount) {
        addBudget(
          budget,
          'textChars',
          sourceTextLength(source.text),
          PAGE_IR_LIMITS.textChars,
          'page text characters',
        );
      }
    }

    if (kind === 'figure' && isObject(source.caption)) {
      addBudget(budget, 'nodes', 1, PAGE_IR_LIMITS.totalNodes, 'page nodes');
      addBudget(
        budget,
        'textChars',
        sourceTextLength(source.caption.text),
        PAGE_IR_LIMITS.textChars,
        'page text characters',
      );
    }

    if (kind === 'table') {
      const { denseRows, columns } = tableShape(source);
      const cellCount = denseRows.length * columns;
      addBudget(
        budget,
        'tableCells',
        cellCount,
        PAGE_IR_LIMITS.totalTableCells,
        'page table cells',
      );
      addBudget(budget, 'nodes', cellCount, PAGE_IR_LIMITS.totalNodes, 'page nodes');
      if (isObject(source.caption)) {
        addBudget(budget, 'nodes', 1, PAGE_IR_LIMITS.totalNodes, 'page nodes');
        addBudget(
          budget,
          'textChars',
          sourceTextLength(source.caption.text),
          PAGE_IR_LIMITS.textChars,
          'page text characters',
        );
      }
      for (const row of denseRows) {
        for (const cell of row) {
          const value = isObject(cell) ? cell.text : cell;
          addBudget(
            budget,
            'textChars',
            sourceTextLength(value),
            PAGE_IR_LIMITS.textChars,
            'page text characters',
          );
        }
      }
    }
  }
}

function normalizeBlock(block, blockIndex, pageIndex, seen) {
  const source = isObject(block) ? block : {};
  const kind = BLOCK_KINDS.has(source.kind) ? source.kind : 'plain_text';
  const id = addId(source.id, `p${pageIndex}-b${blockIndex}`, seen);
  const normalized = {
    ...source,
    id,
    kind,
    bbox: normalizeBbox(source.bbox),
  };

  if (kind === 'paragraph') {
    const rawSegments = Array.isArray(source.segments) ? source.segments : [];
    assertWithinLimit('paragraph segments', rawSegments.length, PAGE_IR_LIMITS.segmentsPerBlock);
    const denseSegments = rawSegments.filter(isObject);
    if (denseSegments.length === 0 && stringValue(source.text).trim()) {
      denseSegments.push({ kind: 'text', text: source.text });
    }
    normalized.segments = denseSegments.map(
      (segment, segmentIndex) => normalizeSegment(segment, id, segmentIndex, seen),
    );
  }

  if (kind === 'heading' || kind === 'paragraph' || kind === 'caption' || kind === 'plain_text') {
    normalized.text = stringValue(source.text);
  }

  // Preserve author / chrome roles from the extractor so the reading plan can
  // skip LLM translation while still mounting the source text in the panel.
  if (typeof source.role === 'string' && source.role.trim()) {
    normalized.role = source.role.trim();
  }
  if (typeof source.content_role === 'string' && source.content_role.trim()) {
    normalized.content_role = source.content_role.trim();
  }
  if (source.translatable === false) {
    normalized.translatable = false;
  }

  if (kind === 'display_math') {
    normalized.latex = stringValue(source.latex);
    normalized.number = stringValue(source.number);
  }

  if (kind === 'figure') {
    normalized.caption = normalizeCaption(source.caption, `${id}-caption`, seen);
  }

  if (kind === 'table') {
    const { denseRows, columns } = tableShape(source);
    normalized.columns = columns;
    normalized.header_rows = Number.isInteger(source.header_rows) && source.header_rows >= 0
      ? Math.min(source.header_rows, denseRows.length)
      : 0;
    normalized.caption = normalizeCaption(source.caption, `${id}-caption`, seen);
    normalized.rows = normalizeTableRows(denseRows, columns, id, seen);
  }

  return normalized;
}

export function normalizePageIr(page) {
  if (!isObject(page)) throw new TypeError('Page IR must be an object');
  if (!Number.isInteger(page.index) || page.index < 0) {
    throw new TypeError('Page IR index must be a non-negative integer');
  }
  if (!Array.isArray(page.blocks)) throw new TypeError('Page IR blocks must be an array');
  assertWithinLimit('page blocks', page.blocks.length, PAGE_IR_LIMITS.blocks);
  preflightPage(page.blocks);

  const seen = new Set();
  const denseBlocks = page.blocks.filter(isObject);
  return {
    ...page,
    index: page.index,
    width: finiteNumber(page.width),
    height: finiteNumber(page.height),
    images: isObject(page.images) ? { ...page.images } : {},
    blocks: denseBlocks.map((block, blockIndex) => normalizeBlock(block, blockIndex, page.index, seen)),
  };
}

const STANDALONE_SYMBOLIC_IDENTIFIER = /^(?:[A-Za-z\p{Script=Greek}\u{1D400}-\u{1D7FF}])(?:[₀-₉⁰-⁹¹²³⁴⁵⁶⁷⁸⁹]+|[_^](?:[A-Za-z\p{Script=Greek}\u{1D400}-\u{1D7FF}]|\d)+)*$/u;

function isNumericOrSymbolicCell(text) {
  const value = text.trim();
  if (!value) return true;
  const compact = value.replace(/\s+/g, '');
  if (/^[+\-−]?\d+(?:[.,]\d+)?(?:e[+\-]?\d+)?%?$/i.test(compact)) return true;
  if (/^[+\-−]?\d+(?:[.,]\d+)?(?:±|\+\/\-)[+\-−]?\d+(?:[.,]\d+)?%?$/i.test(compact)) return true;
  if (/^[+\-−]?\d+(?:[.,]\d+)?\s*[a-zµμΩ]+(?:\s*[/·]\s*[a-zµμΩ]+)*$/i.test(value)) return true;
  if (STANDALONE_SYMBOLIC_IDENTIFIER.test(value)) return true;
  if (!/[\p{L}\p{Script=Han}]/u.test(value)) return true;
  const mathWords = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'min', 'max', 'arg']);
  const hasProseWord = (value.match(/\p{L}+/gu) ?? []).some(
    (word) => word.length >= 2
      && !/^\p{Lu}+$/u.test(word)
      && !mathWords.has(word.toLowerCase()),
  );
  const hasMathOperator = /[+\-−*/\^_=<>≤≥±×÷∑∫√]/u.test(value);
  return hasMathOperator && !hasProseWord;
}

function pushText(items, id, text) {
  if (typeof id === 'string' && typeof text === 'string' && text.trim()) {
    items.push({ id, text });
  }
}

export function collectTranslatableItems(page) {
  const normalized = normalizePageIr(page);
  const items = [];

  for (const block of normalized.blocks) {
    if (block.kind === 'paragraph' && Array.isArray(block.segments)) {
      for (const segment of block.segments) {
        if (segment.kind === 'text') pushText(items, segment.id, segment.text);
      }
      continue;
    }

    if (block.kind === 'heading' || block.kind === 'paragraph'
      || block.kind === 'caption' || block.kind === 'plain_text') {
      pushText(items, block.id, block.text);
      continue;
    }

    if (block.kind === 'figure') {
      if (block.caption) pushText(items, block.caption.id, block.caption.text);
      continue;
    }

    if (block.kind !== 'table') continue;
    if (block.caption) pushText(items, block.caption.id, block.caption.text);
    for (const row of block.rows) {
      for (const cell of row) {
        if (cell.kind === 'formula' || cell.kind === 'inline_math' || cell.kind === 'display_math') continue;
        if (!isNumericOrSymbolicCell(cell.text)) pushText(items, cell.id, cell.text);
      }
    }
  }

  return items;
}
