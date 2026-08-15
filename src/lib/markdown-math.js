// 共享 Markdown+数学渲染管线（扩展 viewer 的成熟做法提炼为三端共用）：
//   1) 先把 $..$ / $$..$$ / \(..\) / \[..\] 挖出占位保护 —— 否则 marked 会把
//      $x_i$ 与 $x_j$ 之间的下划线当斜体配对，公式定界被拆散，KaTeX 永远渲染不出；
//   2) marked 解析 + sanitize；
//   3) 还原公式文本（转义后回填，模型内容不进 HTML）；
//   4) ```algorithm 围栏从 <pre><code> 提升为普通块 —— KaTeX auto-render 默认
//      跳过 pre/code，这是「算法里公式不渲染」的直接原因；
//   5) KaTeX auto-render（与扩展相同的定界符与容错配置）。
// 纯字符串部分（1-3）可在 Node 测试；DOM 部分（4-5）由浏览器端调用。
import { prepareDelimitedMathForRender } from './math-normalization.js';
import { escapeHtmlText, neutralizeRawHtml, sanitizeMarkedHtml } from './reading-mode.js';

/** 挖出公式段占位（顺序：块级优先，避免 $ 抢先吃掉 $$）。 */
export function protectMathSegments(src) {
  const math = [];
  const stash = (raw) => {
    const token = `@@MATH${math.length}@@`;
    math.push(prepareDelimitedMathForRender(raw));
    return token;
  };
  let s = String(src || '');
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m) => stash(m));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m) => stash(m));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m) => stash(m));
  // (^|[^$]) instead of lookbehind: iOS Safari < 16.4 can't parse (?<!…).
  s = s.replace(/(^|[^$])\$(?!\$)([^\n$]+?)\$(?!\$)/g, (m, pre, body) => pre + stash(`$${body}$`));
  return { masked: s, math };
}

/** 占位符还原为转义文本；被 katex-guard 判定不完整的公式加标记包裹。 */
export function restoreMathSegments(html, math) {
  return String(html || '').replace(/@@MATH(\d+)@@/g, (_, n) => {
    const item = math[Number(n)];
    if (item == null) return '';
    const body = escapeHtmlText(item.text || '');
    if (!item.incomplete) return body;
    return `<span class="math-incomplete" title="公式可能不完整：模型混入了非 LaTeX 字符">${body}</span>`;
  });
}

/**
 * markdown → 安全 HTML（公式已保护还原，未经 KaTeX）。纯函数可测。
 * parse: marked.parse 或兼容函数。
 */
export function renderMarkdownHtml(markdown, parse) {
  let src = String(markdown || '').trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const { masked, math } = protectMathSegments(src);
  // 模型输出中的原始 HTML 一律当文本（与扩展 renderMarkdown 相同的防线）。
  const safeMasked = neutralizeRawHtml(masked);
  let html = '';
  try { html = typeof parse === 'function' ? parse(safeMasked) : ''; } catch { html = ''; }
  return restoreMathSegments(sanitizeMarkedHtml(html), math);
}

const ALGO_CODE_SELECTOR = [
  'pre > code.language-algorithm',
  'pre > code.language-pseudo',
  'pre > code.language-pseudocode',
  'pre > code.language-algo',
  'pre > code[class*="algorithm"]',
].join(', ');

/** <pre><code class="language-algorithm"> → 普通块（KaTeX 可进入）。 */
export function hydrateAlgorithmFences(root, doc = globalThis.document) {
  if (!root?.querySelectorAll || !doc) return;
  const codes = [
    ...root.querySelectorAll(ALGO_CODE_SELECTOR),
    // 无语言标注但明显是编号步骤伪代码的围栏。
    ...[...root.querySelectorAll('pre > code:not([class])')].filter((code) => (
      ((code.textContent || '').match(/^\s*\d{1,3}\s*[:：]/gm) || []).length >= 3
    )),
  ];
  const seen = new Set();
  for (const code of codes) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== 'PRE' || seen.has(pre)) continue;
    seen.add(pre);
    const host = doc.createElement('div');
    host.className = 'mm-algorithm';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', '伪代码');
    for (const line of String(code.textContent || '').replace(/\r\n?/g, '\n').split('\n')) {
      const row = doc.createElement('div');
      row.className = 'mm-algorithm-line';
      row.textContent = line || ' ';
      host.appendChild(row);
    }
    pre.replaceWith(host);
  }
}

/** KaTeX auto-render（与扩展一致的定界符与容错；坏公式不阻塞整页）。 */
export function renderMathInElementSafe(el, autoRender) {
  if (typeof autoRender !== 'function') return;
  try {
    autoRender(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      strict: 'ignore',
      errorCallback: () => { /* 吞掉解析噪音 */ },
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch { /* auto-render 不应抛；防御 */ }
}

/**
 * 一站式：markdown 渲染进元素（含算法块提升 + KaTeX）。
 * opts: { parse, autoRender, transformHtml }（transformHtml 用于媒体 token 等后处理）。
 */
export function renderMarkdownWithMath(el, markdown, { parse, autoRender, transformHtml } = {}) {
  let html = renderMarkdownHtml(markdown, parse);
  if (typeof transformHtml === 'function') html = transformHtml(html);
  el.innerHTML = html;
  hydrateAlgorithmFences(el, el.ownerDocument);
  renderMathInElementSafe(el, autoRender);
}
