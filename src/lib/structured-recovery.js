import { createStructuredTranslationAccumulator } from './structured-translation.js';
import { isLikelyUntranslated, structuredWarningText } from './translation-quality.js';

export const STRUCTURED_BLOCK_DELIMITER = '\n\n@@@BLK@@@\n\n';

function stringValue(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function itemKey(item, index) {
  return typeof item?.id === 'string' && item.id ? item.id : `#${index}`;
}

function diagnosticKey(diagnostic) {
  if (typeof diagnostic?.id === 'string' && diagnostic.id) return diagnostic.id;
  return Number.isInteger(diagnostic?.index) ? `#${diagnostic.index}` : '';
}

function collectDiagnostics(result) {
  const diagnostics = [];
  const seen = new Set();
  for (const source of [result?.failedItems, result?.diagnostics]) {
    if (!Array.isArray(source)) continue;
    for (const diagnostic of source) {
      const key = diagnosticKey(diagnostic);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function proseForQualityCheck(value) {
  return stringValue(value)
    .normalize('NFKC')
    .replace(/\[\[\s*PLM\s*[:：][^\]\r\n]+?\s*\]\]/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function structuredItemsText(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => stringValue(item?.text))
    .join(STRUCTURED_BLOCK_DELIMITER);
}

export function splitStructuredTranslation(text, itemCount) {
  const count = Math.max(0, Number.isInteger(itemCount) ? itemCount : 0);
  if (count === 0) return [];
  const parts = stringValue(text).split(/[\r\n]*@@@BLK@@@[\r\n]*/gu);
  return Array.from({ length: count }, (_, index) => (
    index < count - 1 ? (parts[index] || '') : parts.slice(index).join('\n\n')
  ));
}

/**
 * Inspect one completed structured translation without mutating the page.
 * Placeholder failures come from the accumulator's non-enumerable diagnostics;
 * long English output is checked item-by-item so healthy translations stay put.
 */
export function inspectStructuredTranslation({
  items = [],
  translatedText = '',
  result = [],
  targetLang = '',
} = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const diagnostics = collectDiagnostics(result);
  const placeholderKeys = new Set(diagnostics.map(diagnosticKey).filter(Boolean));
  const translatedParts = splitStructuredTranslation(translatedText, sourceItems.length);
  const untranslatedKeys = new Set();

  sourceItems.forEach((item, index) => {
    const key = itemKey(item, index);
    if (placeholderKeys.has(key)) return;
    const source = proseForQualityCheck(item?.text);
    const translated = proseForQualityCheck(translatedParts[index]);
    if (isLikelyUntranslated(source, translated, targetLang)) untranslatedKeys.add(key);
  });

  const retryEntries = sourceItems.map((item, index) => ({
    item,
    key: itemKey(item, index),
  })).filter(({ key }) => {
    return placeholderKeys.has(key) || untranslatedKeys.has(key);
  });
  const retryItems = retryEntries.map(({ item }) => item);

  return {
    diagnostics,
    retryItems,
    retryItemIds: retryEntries.map(({ key }) => key),
    placeholderFailures: placeholderKeys.size,
    untranslatedItems: untranslatedKeys.size,
    statusText: structuredWarningText({
      placeholderFailures: placeholderKeys.size,
      untranslatedItems: untranslatedKeys.size,
    }),
  };
}

export function structuredRecoveryFailureText(count) {
  const total = Math.max(0, Number(count) || 0);
  return total > 0
    ? `局部修复未完成：${total} 个段落仍需重试。其他译文已保留。`
    : '';
}

/**
 * Perform exactly one local retry. The caller owns request cancellation; the
 * request ID is reported immediately so the active page generation can cancel
 * it through the same p.trId path as the initial request.
 */
export async function retryStructuredItemsOnce({
  items = [],
  targetLang = '',
  request,
  isCurrent = () => true,
  onRequestId = () => {},
  onChanges = () => {},
  onPhase = () => {},
} = {}) {
  const retryItems = Array.isArray(items) ? items : [];
  if (retryItems.length === 0) {
    return { attempted: false, cancelled: false, unresolvedItems: [] };
  }
  if (typeof request !== 'function') throw new TypeError('request must be a function');

  const accumulator = createStructuredTranslationAccumulator(retryItems);
  let handle;
  try {
    handle = request(
      structuredItemsText(retryItems),
      (delta) => {
        if (!isCurrent()) return;
        onChanges(accumulator.push(delta));
      },
      (phase) => {
        if (isCurrent()) onPhase(phase);
      },
    );
    if (!handle || !('promise' in handle)) throw new TypeError('request must return { id, promise }');
    if (isCurrent()) onRequestId(handle.id);
    const { full } = await handle.promise;
    if (!isCurrent()) {
      return { attempted: true, cancelled: true, requestId: handle.id, unresolvedItems: [] };
    }

    const finalText = stringValue(full) || accumulator.raw;
    const finalChanges = accumulator.finish(finalText);
    onChanges(finalChanges);
    const inspection = inspectStructuredTranslation({
      items: retryItems,
      translatedText: finalText,
      result: finalChanges,
      targetLang,
    });
    return {
      attempted: true,
      cancelled: false,
      requestId: handle.id,
      finalChanges,
      finalText,
      unresolvedItems: inspection.retryItems,
      inspection,
    };
  } catch (error) {
    if (!isCurrent()) {
      return {
        attempted: true,
        cancelled: true,
        requestId: handle?.id,
        unresolvedItems: [],
        error,
      };
    }
    if (error?.cancelled) {
      return {
        attempted: true,
        cancelled: true,
        requestId: handle?.id,
        unresolvedItems: retryItems,
        error,
      };
    }
    return {
      attempted: true,
      cancelled: false,
      requestId: handle?.id,
      unresolvedItems: retryItems,
      error,
    };
  }
}
