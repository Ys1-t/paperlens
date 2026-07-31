import { validateMathTokens } from './structured-translation.js';

const STRUCTURED_DELIMITER = /[\r\n]*@@@BLK@@@[\r\n]*/gu;
const ASCII_MATH_TOKEN = /\[\[PLM:[^\]\r\n]+\]\]/gu;
const FLEXIBLE_MATH_TOKEN = /(?:\[\s*\[|［\s*［|【)\s*[PＰ]\s*[LＬ]\s*[MＭ]\s*[:：]\s*[^\r\n\[\]［］【】]+?\s*(?:\]\s*\]|］\s*］|】)/giu;
const ENGLISH_CLAUSE_GLUE = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
  'in', 'is', 'of', 'on', 'or', 'that', 'the', 'then', 'to', 'was', 'were',
  'where', 'which', 'with',
]);

function stringValue(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function targetsChinese(targetLang) {
  return /(?:中文|简体|繁体|chinese|zh(?:-|_|$))/i.test(stringValue(targetLang));
}

function latinWords(value) {
  return stringValue(value).match(/[A-Za-z]{2,}(?:[-'][A-Za-z]{2,})*/g) ?? [];
}

function cjkCharacters(value) {
  return stringValue(value).match(/[\p{Script=Han}\u3040-\u30ff\uac00-\ud7af]/gu) ?? [];
}

function qualityText(value) {
  return stringValue(value)
    .replace(FLEXIBLE_MATH_TOKEN, ' ')
    .replace(/https?:\/\/\S+|mailto:\S+/giu, ' ')
    .replace(/\[(?:\d+[\s,;\-–]*)+\]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function comparableLatinWords(value) {
  return latinWords(qualityText(value)).map((word) => word.toLowerCase());
}

function longestSharedWordRun(sourceWords, outputWords) {
  if (!sourceWords.length || !outputWords.length) return 0;
  let previous = new Uint16Array(outputWords.length + 1);
  let best = 0;
  for (let sourceIndex = 0; sourceIndex < sourceWords.length; sourceIndex += 1) {
    const current = new Uint16Array(outputWords.length + 1);
    for (let outputIndex = 0; outputIndex < outputWords.length; outputIndex += 1) {
      if (sourceWords[sourceIndex] !== outputWords[outputIndex]) continue;
      current[outputIndex + 1] = previous[outputIndex] + 1;
      if (current[outputIndex + 1] > best) best = current[outputIndex + 1];
    }
    previous = current;
  }
  return best;
}

function shortTitleLike(value) {
  const words = qualityText(value).match(/[A-Za-z]{2,}(?:[-'][A-Za-z]{2,})*/g) ?? [];
  return words.length > 0 && words.length <= 4
    && words.every((word) => /^[A-Z][A-Za-z'-]*$/u.test(word));
}

/**
 * Detect a long English source paragraph that came back essentially unchanged
 * while the configured target language is Chinese. Formula tokens, acronyms and
 * short headings are deliberately below the activation threshold.
 */
export function isLikelyUntranslated(source, translated, targetLang) {
  if (!targetsChinese(targetLang)) return false;
  if (shortTitleLike(source)) return false;
  const sourceWords = comparableLatinWords(source);
  if (sourceWords.length < 3) return false;

  const output = qualityText(translated);
  if (!output) return true;
  const outputWords = comparableLatinWords(output);
  const outputCjk = cjkCharacters(output).length;
  const sharedRun = longestSharedWordRun(sourceWords, outputWords);
  const sharedRunRatio = sharedRun / Math.max(1, sourceWords.length);

  // A Chinese prefix must not legitimize an unchanged English sentence in the
  // same record.  Long contiguous overlap is a stronger signal than the total
  // Han count and still permits isolated model names or acronyms.
  if (sharedRun >= 6 && sharedRunRatio >= 0.25) return true;
  if (sharedRun >= 4 && sharedRunRatio >= 0.55) return true;
  if (sourceWords.length <= 5 && sharedRun >= 3 && sharedRunRatio >= 0.8) return true;
  // Formula-heavy prose can leave a short English grammar clause behind even
  // after nearby words were translated.  Requiring a glue word avoids treating
  // a retained multi-word method or model name as an untranslated sentence.
  if (sharedRun >= 4
    && outputWords.some((word) => ENGLISH_CLAUSE_GLUE.has(word))
    && outputCjk <= sharedRun * 2) return true;

  const retainedEnglish = outputWords.length >= Math.max(4, Math.ceil(sourceWords.length * 0.5));
  if (!retainedEnglish) return false;

  const meaningfulChinese = outputCjk >= Math.max(6, Math.ceil(outputWords.length * 1.1));
  return !meaningfulChinese;
}

export function structuredWarningText({ placeholderFailures = 0, untranslatedItems = 0 } = {}) {
  const parts = [];
  if (placeholderFailures > 0) parts.push(`${placeholderFailures} 个含公式段落需要重试`);
  if (untranslatedItems > 0) parts.push(`${untranslatedItems} 个段落疑似未翻译`);
  return parts.length ? `${parts.join('，')}。正在局部修复…` : '';
}

function stripStructuredControls(value) {
  return stringValue(value)
    .replace(FLEXIBLE_MATH_TOKEN, ' ')
    .replace(/@@@BLK@@@/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Reject poisoned structured-cache entries before they can be replayed.
 * The viewer still owns recovery; this gate only decides whether a completed
 * response is safe to reuse on a later page load.
 */
export function isCacheableStructuredTranslation(source, translated, targetLang) {
  const sourceText = stringValue(source);
  const translatedText = stringValue(translated);
  if (!translatedText.trim()) return false;

  const sourceSeparators = sourceText.match(/@@@BLK@@@/gu)?.length ?? 0;
  const translatedSeparators = translatedText.match(/@@@BLK@@@/gu)?.length ?? 0;
  if (translatedSeparators !== sourceSeparators) return false;

  const expectedTokens = sourceText.match(ASCII_MATH_TOKEN) ?? [];
  try {
    validateMathTokens(expectedTokens, translatedText);
  } catch {
    return false;
  }

  const sourceParts = sourceText.split(STRUCTURED_DELIMITER);
  const translatedParts = translatedText.split(STRUCTURED_DELIMITER);
  if (sourceParts.length !== translatedParts.length) return false;
  return sourceParts.every((part, index) => !isLikelyUntranslated(
    stripStructuredControls(part),
    stripStructuredControls(translatedParts[index]),
    targetLang,
  ));
}
