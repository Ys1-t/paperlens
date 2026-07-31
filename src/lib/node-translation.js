import { isLikelyUntranslated } from './translation-quality.js';
import { extractMathTokens, validateMathTokens } from './structured-translation.js';

export const NODE_TRANSLATION_PROTOCOL = 'page-node-ndjson-v2';
export const NODE_TRANSLATION_BATCH_CONCURRENCY = 2;
export const NODE_TRANSLATION_FIRST_BATCH_MAX_ITEMS = 2;
export const NODE_TRANSLATION_FIRST_BATCH_MAX_COST = 900;
export const NODE_TRANSLATION_BATCH_MAX_ITEMS = 5;
export const NODE_TRANSLATION_BATCH_MAX_COST = 1800;
const COMMON_TRANSLATABLE_SINGLE_WORDS = new Set([
  'abstract', 'algorithm', 'appendix', 'average', 'background', 'best',
  'conclusion', 'conclusions', 'dataset', 'definition', 'discussion',
  'experiment', 'experiments', 'figure', 'introduction', 'mean', 'method',
  'methodology', 'model', 'objective', 'preliminaries', 'preliminary',
  'problem', 'proof', 'proposed', 'rank', 'references', 'remark', 'result',
  'results', 'subject', 'table', 'testing', 'theorem', 'time', 'training',
  'value', 'where', 'worst',
]);

export function nodeRecoveryFailureText(count) {
  const total = Math.max(0, Number(count) || 0);
  return total > 0 ? `局部修复未完成：${total} 个文本节点仍需重试。其他译文已保留。` : '';
}

function stringValue(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function targetsChinese(targetLang) {
  return /(?:中文|简体|繁体|chinese|zh(?:-|_|$))/iu.test(stringValue(targetLang));
}

function normalizeNodes(items) {
  const nodes = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const text = stringValue(item?.text);
    if (!id || !text.trim() || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ ...item, id, text });
  }
  return nodes;
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nodeTranslationCost(item) {
  const text = stringValue(item?.text);
  const latinWords = text.match(/[A-Za-z]{2,}(?:[-'][A-Za-z]{2,})*/gu)?.length ?? 0;
  const mathTokens = expectedMathTokens(item).length;
  // Raw character count alone underestimates research prose containing many
  // identifiers and formula placeholders.  The small surcharges keep those
  // expensive units from sharing a request with several ordinary paragraphs.
  return Math.max(1, text.length + Math.min(900, latinWords * 4 + mathTokens * 48));
}

/**
 * Split a page's stable reading units into deterministic provider requests.
 * The first request is intentionally smaller so useful text can appear sooner;
 * later requests trade a little latency for lower request overhead.  A single
 * oversized unit is never split or rewritten, which keeps math placeholders
 * and source-ID mapping byte-for-byte intact.
 */
export function createNodeTranslationBatches(items, {
  firstMaxItems = NODE_TRANSLATION_FIRST_BATCH_MAX_ITEMS,
  firstMaxCost = NODE_TRANSLATION_FIRST_BATCH_MAX_COST,
  maxItems = NODE_TRANSLATION_BATCH_MAX_ITEMS,
  maxCost = NODE_TRANSLATION_BATCH_MAX_COST,
} = {}) {
  const nodes = normalizeNodes(items);
  if (!nodes.length) return [];

  const firstItemLimit = Math.max(1, Math.floor(positiveLimit(
    firstMaxItems,
    NODE_TRANSLATION_FIRST_BATCH_MAX_ITEMS,
  )));
  const firstCostLimit = positiveLimit(firstMaxCost, NODE_TRANSLATION_FIRST_BATCH_MAX_COST);
  const itemLimit = Math.max(1, Math.floor(positiveLimit(
    maxItems,
    NODE_TRANSLATION_BATCH_MAX_ITEMS,
  )));
  const costLimit = positiveLimit(maxCost, NODE_TRANSLATION_BATCH_MAX_COST);
  const batches = [];
  let cursor = 0;

  while (cursor < nodes.length) {
    const first = batches.length === 0;
    const batchItemLimit = first ? firstItemLimit : itemLimit;
    const batchCostLimit = first ? firstCostLimit : costLimit;
    const batch = [];
    let cost = 0;

    while (cursor < nodes.length) {
      const item = nodes[cursor];
      const itemCost = nodeTranslationCost(item);
      const wouldOverflow = batch.length > 0
        && (batch.length >= batchItemLimit || cost + itemCost > batchCostLimit);
      if (wouldOverflow) break;
      batch.push(item);
      cost += itemCost;
      cursor += 1;
      // Oversized units travel alone instead of making the following unit wait.
      if (itemCost >= batchCostLimit) break;
    }
    batches.push(batch);
  }

  return batches;
}

/**
 * Run node batches with bounded concurrency and all-settled semantics.  One
 * provider failure cannot prevent later batches from running, while the result
 * array remains in source-batch order for deterministic recovery.
 */
export async function mapNodeTranslationBatches(
  batches,
  worker,
  { concurrency = NODE_TRANSLATION_BATCH_CONCURRENCY, isCurrent = () => true } = {},
) {
  const sourceBatches = Array.isArray(batches) ? batches : [];
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  const results = new Array(sourceBatches.length);
  const limit = Math.min(
    sourceBatches.length,
    Math.max(1, Math.floor(positiveLimit(concurrency, NODE_TRANSLATION_BATCH_CONCURRENCY))),
  );
  let cursor = 0;

  const run = async () => {
    while (isCurrent()) {
      const index = cursor;
      cursor += 1;
      if (index >= sourceBatches.length) return;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(sourceBatches[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, run));
  return results;
}

export function serializeNodeTranslationRequest(items) {
  return normalizeNodes(items)
    .map(({ id, text }) => JSON.stringify({ id, text }))
    .join('\n');
}

function objectEntries(value) {
  if (Array.isArray(value)) return value.flatMap(objectEntries);
  if (!value || typeof value !== 'object') return [];
  if (typeof value.id === 'string' && typeof value.text === 'string') return [value];
  if (Array.isArray(value.nodes)) return value.nodes.flatMap(objectEntries);
  return [];
}

function parseJsonValue(value) {
  try {
    return objectEntries(JSON.parse(value));
  } catch {
    return [];
  }
}

function stripFenceLine(line) {
  const trimmed = stringValue(line).trim();
  return /^```(?:json|jsonl|ndjson)?$/iu.test(trimmed) ? '' : trimmed;
}

/**
 * Parse a completed node response. NDJSON is preferred for streaming, while a
 * compact JSON array/object is accepted for providers that insist on wrapping
 * structured output.
 */
export function parseNodeTranslationResponse(value) {
  const text = stringValue(value).trim();
  if (!text) return [];

  const unfenced = text
    .replace(/^```(?:json|jsonl|ndjson)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const whole = parseJsonValue(unfenced);
  if (whole.length) return whole;

  const entries = [];
  for (const line of unfenced.split(/\r?\n/gu)) {
    const candidate = stripFenceLine(line);
    if (!candidate) continue;
    entries.push(...parseJsonValue(candidate.replace(/^[-*]\s+/u, '')));
  }
  return entries;
}

function normalizedComparable(value) {
  return stringValue(value).normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function unchangedShortEnglish(source, translated, targetLang) {
  if (!targetsChinese(targetLang)) return false;
  const before = normalizedComparable(source);
  const after = normalizedComparable(translated);
  if (!before || before !== after || !/[A-Za-z]/u.test(before)) return false;
  // Acronyms, identifiers and model names are normally meant to stay intact.
  if (/^[A-Z0-9][A-Z0-9._/+\-]{0,24}$/u.test(before)) return false;
  const words = before.match(/[A-Za-z]{2,}(?:[-'][A-Za-z]{2,})*/gu) ?? [];
  if (words.length === 1 && COMMON_TRANSLATABLE_SINGLE_WORDS.has(words[0].toLowerCase())) return true;
  if (/^[A-Z][a-z]{2,24}$/u.test(before)) return false;
  if (words.length >= 2) return true;
  return /^(?:a|an|and|are|as|at|by|for|from|in|is|of|or|subject|that|the|then|to|where|with)$/iu.test(words[0] || '');
}

function expectedMathTokens(itemOrSource) {
  if (itemOrSource && typeof itemOrSource === 'object') {
    if (Array.isArray(itemOrSource.mathTokens)) return itemOrSource.mathTokens;
    return extractMathTokens(itemOrSource.text);
  }
  return extractMathTokens(itemOrSource);
}

function retrySlotSource(slot) {
  return (Array.isArray(slot) ? slot : [])
    .map((segment) => stringValue(segment?.text))
    .join('');
}

function translatableRetrySlot(value) {
  return /[A-Za-z\p{Script=Han}]/u.test(stringValue(value));
}

function uniqueRetrySlotId(item, slot, slotIndex, usedIds) {
  const preferred = typeof slot?.[0]?.id === 'string' ? slot[0].id.trim() : '';
  if (preferred && !usedIds.has(preferred)) {
    usedIds.add(preferred);
    return preferred;
  }
  const base = `${item.id}-text-slot-${slotIndex}`;
  let candidate = base;
  let suffix = 1;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function createRetryTranslationPlan(nodes) {
  const requestItems = [];
  const entries = [];
  const usedIds = new Set(nodes.map((item) => item.id));

  for (const item of nodes) {
    const mathTokens = expectedMathTokens(item);
    const textSlots = Array.isArray(item?.textSlots) ? item.textSlots : [];
    const canRecoverBySlot = item?.kind === 'reading_unit'
      && mathTokens.length > 0
      && textSlots.length === mathTokens.length + 1;
    if (!canRecoverBySlot) {
      requestItems.push(item);
      entries.push({ kind: 'direct', item, requestIds: [item.id] });
      continue;
    }

    const parts = textSlots.map(retrySlotSource);
    const requestIds = new Array(parts.length).fill('');
    for (let slotIndex = 0; slotIndex < parts.length; slotIndex += 1) {
      const source = parts[slotIndex];
      if (!translatableRetrySlot(source)) continue;
      const id = uniqueRetrySlotId(item, textSlots[slotIndex], slotIndex, usedIds);
      requestIds[slotIndex] = id;
      requestItems.push({ id, text: source });
    }

    // Formula-only units are not expected in the reading plan. Keeping the
    // original request as a defensive fallback avoids manufacturing a false
    // success if malformed Page IR ever produces one.
    if (!requestIds.some(Boolean)) {
      requestItems.push(item);
      entries.push({ kind: 'direct', item, requestIds: [item.id] });
      continue;
    }
    entries.push({
      kind: 'formula_slots',
      item,
      mathTokens,
      parts,
      requestIds,
    });
  }
  return { requestItems, entries };
}

function restoreRetrySlotWhitespace(source, translated) {
  const value = stringValue(source);
  const leading = /^\s*/u.exec(value)?.[0] || '';
  const trailing = /\s*$/u.exec(value)?.[0] || '';
  return `${leading}${stringValue(translated).trim()}${trailing}`;
}

function resolveRetryTranslationPlan(plan, inspection, targetLang) {
  const accepted = new Map(
    (inspection?.changes || []).map((change) => [change.id, change.text]),
  );
  const changes = [];
  const unresolvedItems = [];
  const diagnostics = [...(inspection?.diagnostics || [])];

  for (const entry of plan.entries) {
    if (entry.kind === 'direct') {
      if (accepted.has(entry.item.id)) {
        changes.push({ id: entry.item.id, text: accepted.get(entry.item.id) });
      } else {
        unresolvedItems.push(entry.item);
      }
      continue;
    }

    const translatedParts = [...entry.parts];
    const missingSlotIds = [];
    for (let slotIndex = 0; slotIndex < entry.requestIds.length; slotIndex += 1) {
      const requestId = entry.requestIds[slotIndex];
      if (!requestId) continue;
      if (!accepted.has(requestId)) {
        missingSlotIds.push(requestId);
        continue;
      }
      translatedParts[slotIndex] = restoreRetrySlotWhitespace(
        entry.parts[slotIndex],
        accepted.get(requestId),
      );
    }
    if (missingSlotIds.length) {
      unresolvedItems.push(entry.item);
      diagnostics.push({
        id: entry.item.id,
        code: 'formula_text_slot_unresolved',
        slotIds: missingSlotIds,
      });
      continue;
    }

    const rebuilt = translatedParts.reduce((text, part, slotIndex) => (
      text + part + (entry.mathTokens[slotIndex] || '')
    ), '');
    if (!isAcceptableNodeTranslation(entry.item.text, rebuilt, targetLang, entry.item)) {
      unresolvedItems.push(entry.item);
      diagnostics.push({ id: entry.item.id, code: 'rebuilt_formula_unit_unacceptable' });
      continue;
    }
    changes.push({ id: entry.item.id, text: rebuilt });
  }

  return {
    changes,
    diagnostics,
    unresolvedItems,
    unresolvedIds: unresolvedItems.map((item) => item.id),
    ok: unresolvedItems.length === 0,
  };
}

function hasIntactMathTokens(itemOrSource, translated) {
  try {
    validateMathTokens(expectedMathTokens(itemOrSource), translated);
    return true;
  } catch {
    return false;
  }
}

export function isAcceptableNodeTranslation(source, translated, targetLang, item = source) {
  const output = stringValue(translated).trim();
  if (!output) return false;
  if (!hasIntactMathTokens(item, output)) return false;
  if (unchangedShortEnglish(source, output, targetLang)) return false;
  return !isLikelyUntranslated(source, output, targetLang);
}

function responseMap(entries, expected) {
  const values = new Map();
  const diagnostics = [];
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (!id || !expected.has(id)) {
      diagnostics.push({ id, code: 'unknown_node_id' });
      continue;
    }
    if (values.has(id)) diagnostics.push({ id, code: 'duplicate_node_id' });
    values.set(id, text);
  }
  return { values, diagnostics };
}

export function inspectNodeTranslation({ items = [], translatedText = '', targetLang = '' } = {}) {
  const nodes = normalizeNodes(items);
  const expected = new Map(nodes.map((item) => [item.id, item]));
  const parsed = parseNodeTranslationResponse(translatedText);
  const { values, diagnostics } = responseMap(parsed, expected);
  const changes = [];
  const unresolvedItems = [];

  for (const item of nodes) {
    const translated = values.get(item.id);
    if (typeof translated !== 'string') {
      unresolvedItems.push(item);
      diagnostics.push({ id: item.id, code: 'missing_node' });
      continue;
    }
    if (!hasIntactMathTokens(item, translated)) {
      unresolvedItems.push(item);
      diagnostics.push({ id: item.id, code: 'math_placeholder_mismatch' });
      continue;
    }
    if (!isAcceptableNodeTranslation(item.text, translated, targetLang, item)) {
      unresolvedItems.push(item);
      diagnostics.push({ id: item.id, code: 'untranslated_or_empty_node' });
      continue;
    }
    changes.push({ id: item.id, text: translated });
  }

  return {
    changes,
    diagnostics,
    unresolvedItems,
    unresolvedIds: unresolvedItems.map((item) => item.id),
    ok: unresolvedItems.length === 0,
  };
}

/**
 * Stream complete NDJSON records as soon as they arrive. Formula nodes never
 * enter this accumulator: every change is keyed to a source text-node ID.
 */
export function createNodeTranslationAccumulator(items, { targetLang = '' } = {}) {
  const nodes = normalizeNodes(items);
  const expected = new Map(nodes.map((item) => [item.id, item]));
  const rawParts = [];
  const emitted = new Map();
  let pending = '';

  const consumeEntries = (entries) => {
    const changes = [];
    for (const entry of entries) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const item = expected.get(id);
      const translated = typeof entry?.text === 'string' ? entry.text : '';
      if (!item || !isAcceptableNodeTranslation(item.text, translated, targetLang, item)) continue;
      if (emitted.get(id) === translated) continue;
      emitted.set(id, translated);
      changes.push({ id, text: translated });
    }
    return changes;
  };

  return {
    push(delta) {
      const chunk = stringValue(delta);
      rawParts.push(chunk);
      pending += chunk;
      const lines = pending.split(/\r?\n/gu);
      pending = lines.pop() ?? '';
      const entries = [];
      for (const line of lines) {
        const candidate = stripFenceLine(line);
        if (candidate) entries.push(...parseJsonValue(candidate.replace(/^[-*]\s+/u, '')));
      }
      return consumeEntries(entries);
    },
    finish(text = rawParts.join('')) {
      const inspection = inspectNodeTranslation({ items: nodes, translatedText: text, targetLang });
      consumeEntries(inspection.changes);
      return inspection;
    },
    get raw() {
      return rawParts.join('');
    },
  };
}

export async function retryNodeItemsOnce({
  items = [],
  targetLang = '',
  request,
  isCurrent = () => true,
  onRequestId = () => {},
  onChanges = () => {},
  onPhase = () => {},
} = {}) {
  const nodes = normalizeNodes(items);
  if (!nodes.length) return { attempted: false, cancelled: false, unresolvedItems: [] };
  if (typeof request !== 'function') throw new TypeError('request must be a function');

  // A first-pass failure involving formula placeholders is recovered with a
  // prose-only request. The model never sees PLM tokens on this retry; local
  // code restores the immutable formulas in their original order afterwards.
  const retryPlan = createRetryTranslationPlan(nodes);
  // Any formula_slots entry means the request carries adjacent prose fragments
  // of a formula-split sentence, so the transport may select the dedicated
  // slot-retry system prompt for the whole request.
  const nodeSlotRetry = retryPlan.entries.some((entry) => entry.kind === 'formula_slots');
  const accumulator = createNodeTranslationAccumulator(retryPlan.requestItems, { targetLang });
  let handle;
  try {
    handle = request(
      serializeNodeTranslationRequest(retryPlan.requestItems),
      (delta) => {
        if (isCurrent()) accumulator.push(delta);
      },
      (phase) => {
        if (isCurrent()) onPhase(phase);
      },
      { nodeSlotRetry },
    );
    if (!handle || !('promise' in handle)) throw new TypeError('request must return { id, promise }');
    if (isCurrent()) onRequestId(handle.id);
    const { full } = await handle.promise;
    if (!isCurrent()) {
      return { attempted: true, cancelled: true, requestId: handle.id, unresolvedItems: [] };
    }
    const finalText = stringValue(full) || accumulator.raw;
    const slotInspection = accumulator.finish(finalText);
    const inspection = resolveRetryTranslationPlan(retryPlan, slotInspection, targetLang);
    onChanges(inspection.changes);
    return {
      attempted: true,
      cancelled: false,
      requestId: handle.id,
      finalText,
      ...inspection,
    };
  } catch (error) {
    if (!isCurrent()) {
      return { attempted: true, cancelled: true, requestId: handle?.id, unresolvedItems: [], error };
    }
    return {
      attempted: true,
      cancelled: Boolean(error?.cancelled),
      requestId: handle?.id,
      unresolvedItems: nodes,
      unresolvedIds: nodes.map((item) => item.id),
      error,
    };
  }
}

export function isCacheableNodeTranslation(source, translated, targetLang) {
  const items = parseNodeTranslationResponse(source);
  if (!items.length) return false;
  return inspectNodeTranslation({ items, translatedText: translated, targetLang }).ok;
}
