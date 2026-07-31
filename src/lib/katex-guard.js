import {
  normalizeMathForKatex,
  softNormalizeMathForKatex,
} from './math-normalization.js';

export const KATEX_GUARD_VERSION = '2';

const PUBLIC_PARSE_METHODS = [
  ['render', 1],
  ['renderToString', 0],
  ['__parse', 0],
  ['__renderToDomTree', 0],
  ['__renderToHTMLTree', 0],
];

function guardedExpression(value, options = {}) {
  const source = String(value ?? '');
  const normalized = normalizeMathForKatex(source);
  if (normalized || !source.trim()) return normalized;

  // Auto-render (vision Markdown) uses throwOnError:false. Soft-strip unknown
  // Unicode so one bad formula cannot abort the whole page or spam Edge's
  // extension-error log via console.warn.
  if (options.throwOnError === false) {
    return softNormalizeMathForKatex(source);
  }

  const error = new SyntaxError('公式包含无法安全渲染的 Unicode 字符');
  error.code = 'PAPERLENS_UNSAFE_MATH';
  throw error;
}

function guardedOptions(value) {
  const options = value && typeof value === 'object' ? value : {};
  // This is deliberately an override, not a default. A forgotten caller that
  // explicitly asks for "warn" must still be unable to pollute Edge's
  // extension-error log.
  return { ...options, strict: 'ignore' };
}

export function installKatexGuard(katex) {
  if (!katex || (typeof katex !== 'object' && typeof katex !== 'function')) return false;
  if (katex.__paperLensMathGuard === KATEX_GUARD_VERSION) return true;

  // Re-wrap if an older guard version is present.
  let wrapped = 0;
  for (const [methodName, optionsIndex] of PUBLIC_PARSE_METHODS) {
    const original = katex[methodName];
    if (typeof original !== 'function') continue;
    // Prefer the pre-guard implementation if we re-install after a version bump.
    const base = typeof original.__paperLensKatexOriginal === 'function'
      ? original.__paperLensKatexOriginal
      : original;
    const guarded = function guardedKatexMethod(expression, ...args) {
      const options = guardedOptions(args[optionsIndex]);
      args[optionsIndex] = options;
      return base.call(this, guardedExpression(expression, options), ...args);
    };
    guarded.__paperLensKatexOriginal = base;
    katex[methodName] = guarded;
    wrapped += 1;
  }

  if (!wrapped) return false;
  Object.defineProperty(katex, '__paperLensMathGuard', {
    value: KATEX_GUARD_VERSION,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return true;
}
