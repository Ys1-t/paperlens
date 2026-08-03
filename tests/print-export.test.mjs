import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatPrintSections,
  buildDocumentPrintSections,
  buildPrintDocumentHtml,
  escapePrintHtml,
  getPrintAssetUrls,
  loadPrintAssets,
  openPrintHtmlWindow,
  sanitizeExportHtml,
} from '../src/lib/print-export.js';

test('escapePrintHtml escapes markup-sensitive characters', () => {
  assert.equal(escapePrintHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('sanitizeExportHtml strips scripts and inline handlers', () => {
  const clean = sanitizeExportHtml(
    '<p onclick="alert(1)">ok</p><script>evil()</script><span class="katex">x</span>',
  );
  assert.match(clean, /ok/);
  assert.match(clean, /katex/);
  assert.doesNotMatch(clean, /script|onclick|evil/i);
});

test('buildChatPrintSections skips empty system noise and notes page images', () => {
  const sections = buildChatPrintSections([
    { role: 'system', content: 'ignore' },
    { role: 'user', content: '你好', pageNum: 3, hadImage: true },
    { role: 'assistant', content: '回答正文' },
    { role: 'user', content: '   ' },
  ]);
  assert.equal(sections.length, 2);
  assert.match(sections[0].heading, /用户/);
  assert.match(sections[0].html, /第 3 页/);
  assert.match(sections[0].html, /你好/);
  assert.match(sections[1].heading, /AI/);
  assert.match(sections[1].html, /回答正文/);
});

test('buildChatPrintSections uses renderToHtml for assistant math', () => {
  const sections = buildChatPrintSections(
    [{ role: 'assistant', content: '$$x=1$$' }],
    {
      renderToHtml: (text, role) => {
        assert.equal(role, 'assistant');
        assert.match(text, /x=1/);
        return '<div class="bubble"><div class="export-md"><span class="katex">x</span></div></div>';
      },
    },
  );
  assert.match(sections[0].html, /katex/);
  assert.doesNotMatch(sections[0].html, /\$\$x=1\$\$/);
});

test('buildChatPrintSections appends bounded evidence provenance', () => {
  const [section] = buildChatPrintSections([{
    role: 'assistant',
    content: '回答',
    evidence: {
      pages: [4],
      support: { score: 76 },
      items: [{ page: 4, sourceType: 'source', heading: '<Method>', snippet: '<unsafe> evidence' }],
    },
  }]);
  assert.match(section.html, /证据支持度 76%/);
  assert.match(section.html, /第 4 页/);
  assert.match(section.html, /PDF 原文/);
  assert.doesNotMatch(section.html, /<unsafe>/);
  assert.match(section.html, /&lt;unsafe&gt;/);
});

test('buildDocumentPrintSections prefers rendered HTML with KaTeX', () => {
  const sections = buildDocumentPrintSections([
    {
      num: 1,
      html: '<p>第一页</p><span class="katex">E=mc^2</span>',
      translationText: 'raw $E=mc^2$ fallback',
    },
    { num: 2, error: '连接中断' },
    { num: 3 },
  ]);
  assert.equal(sections.length, 3);
  assert.match(sections[0].html, /export-md/);
  assert.match(sections[0].html, /katex/);
  assert.match(sections[0].html, /第一页/);
  assert.doesNotMatch(sections[0].html, /raw \$E/);
  assert.match(sections[1].html, /连接中断/);
  assert.match(sections[2].html, /暂无译文/);
});

test('buildPrintDocumentHtml embeds title, KaTeX CSS, and delayed print', () => {
  const html = buildPrintDocumentHtml({
    title: 'Demo <paper>',
    subtitle: '2 pages',
    sections: [{ heading: '第 1 页', html: '<div class="export-md"><span class="katex">x</span></div>' }],
    assets: {
      katexCss: 'chrome-extension://abc/src/vendor/katex/katex.min.css',
      katexCssInline: '@font-face{font-family:KaTeX_Main;src:url(chrome-extension://abc/src/vendor/katex/fonts/x.woff2)}',
    },
    printDelayMs: 300,
  });
  assert.match(html, /Demo &lt;paper&gt;/);
  assert.match(html, /2 pages/);
  assert.match(html, /export-md/);
  assert.match(html, /katex-print-css/);
  assert.match(html, /KaTeX_Main/);
  assert.match(html, /window\.print\(\)/);
  assert.match(html, /document\.fonts/);
  assert.match(html, /另存为 PDF/);
});

test('getPrintAssetUrls uses runtime getURL', () => {
  const urls = getPrintAssetUrls((path) => `ext://${path}`);
  assert.equal(urls.katexCss, 'ext://src/vendor/katex/katex.min.css');
  assert.equal(urls.katexBase, 'ext://src/vendor/katex/');
});

test('loadPrintAssets inlines CSS and rewrites font urls', async () => {
  const assets = await loadPrintAssets({
    getUrl: (path) => `ext://${path}`,
    fetchImpl: async () => ({
      ok: true,
      text: async () => '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2)}',
    }),
  });
  assert.match(assets.katexCssInline, /ext:\/\/src\/vendor\/katex\/fonts\/KaTeX_Main-Regular\.woff2/);
});

test('openPrintHtmlWindow returns blocked reason when popup is denied', () => {
  const result = openPrintHtmlWindow('<html></html>', {
    windowOpen: () => null,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /弹窗/);
});

test('openPrintHtmlWindow opens blob window when allowed', () => {
  const opened = [];
  const result = openPrintHtmlWindow('<html><body>ok</body></html>', {
    windowOpen: (url, target) => {
      opened.push({ url, target });
      return { focus() {} };
    },
    scheduleRevoke: () => 0,
  });
  assert.equal(result.ok, true);
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /^blob:/);
  assert.equal(opened[0].target, '_blank');
});
