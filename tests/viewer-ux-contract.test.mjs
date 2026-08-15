import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, viewer] = await Promise.all([
  readFile(new URL('../src/viewer/viewer.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewer/viewer.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8'),
]);

test('reader exposes user-facing progress, accessible feedback, and hidden technical detail', () => {
  assert.match(html, /id="reader-progress"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /class="progress-track"[^>]*role="progressbar"/);
  assert.match(html, /id="hud" class="hud collapsed"/);
  assert.match(html, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /class="skip-link"/);
  assert.doesNotMatch(html, /📖|⚙/u);
  // Progress must not ellipsis-truncate long copy in the toolbar.
  assert.doesNotMatch(css, /\.reader-progress\s*\{[^}]*max-width:\s*140px/);
  assert.doesNotMatch(css, /\.progress\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(viewer, /summary\.detail/);
  assert.match(viewer, /readerProgress\.title/);
});

test('every translation page has a visible state, skeleton, guidance, and contextual retry', () => {
  assert.match(viewer, /pageStatus\.textContent = '等待翻译'/);
  assert.match(viewer, /page-skeleton/);
  assert.match(viewer, /双击内容可定位原文/);
  assert.match(viewer, /retryButton\.textContent = '重试本页'/);
  assert.match(viewer, /retryButton\.hidden = true/);
  assert.match(viewer, /buildPagePresentation/);
  assert.match(viewer, /friendlyReaderError/);
});

test('reader CSS reserves comfortable controls and respects reduced motion', () => {
  assert.match(css, /\.icon-btn\s*\{[\s\S]*?width:\s*40px;\s*height:\s*40px/);
  assert.match(css, /\.primary-btn\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(css, /\.page-skeleton/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /button:focus-visible/);
});

test('toolbar exposes a scroll-link toggle so long translations can leave the PDF parked', () => {
  assert.match(html, /id="btn-scroll-link"/);
  assert.match(html, /滚动联动/);
  assert.match(viewer, /setScrollLinkEnabled/);
  assert.match(viewer, /scrollLinkHoldOff/);
  assert.match(viewer, /isScrollLinkActive/);
  assert.match(viewer, /readScrollLinkPreference/);
});

test('each translation page can copy finished text and dropzone explains multi-doc tips', () => {
  assert.match(viewer, /copy-page/);
  assert.match(viewer, /pageCopyBtn/);
  assert.match(html, /dz-tips/);
  assert.match(html, /独立|联动|滚动联动/);
  assert.match(css, /\.copy-page/);
});

test('reader exposes page jump, full-document export, smart retry, and incomplete-math badges', () => {
  assert.match(html, /id="page-jump-input"/);
  assert.match(html, /id="page-prev"/);
  assert.match(html, /id="btn-export-doc"/);
  assert.match(html, /导出全文译文为 PDF|>导出</);
  assert.match(viewer, /goToPage/);
  assert.match(viewer, /exportDocumentTranslation/);
  assert.match(viewer, /openPrintHtmlWindow/);
  assert.match(viewer, /buildDocumentPrintSections/);
  assert.match(viewer, /pageExportRenderedHtml/);
  assert.match(viewer, /loadPrintAssets/);
  assert.match(viewer, /scheduleSmartPageRetry/);
  assert.match(viewer, /markIncompleteMath/);
  assert.match(viewer, /prepareDelimitedMathForRender/);
  assert.match(css, /\.math-incomplete-badge/);
  assert.match(css, /\.page-jump/);
  // Rapid next/prev must step nav cursor, not laggy viewport page.
  assert.match(viewer, /navPageNumber/);
  assert.match(viewer, /delta:\s*true/);
  assert.match(viewer, /currentNavPageNumber/);
  // Algorithm fences hydrate to vision-algorithm with KaTeX math.
  assert.match(viewer, /hydrateAlgorithmBlocks/);
  assert.match(viewer, /appendTextWithInlineMath/);
  assert.match(viewer, /prepareAlgorithmBodyForDisplay/);
  assert.match(viewer, /localizeAlgorithmTitle/);
  assert.match(viewer, /assessVisionTranslationQuality/);
  assert.match(css, /\.vision-algorithm/);
});

test('reader toolbar keeps settings/chat visible and supports active-page + shortcuts', () => {
  assert.doesNotMatch(html, /panel-font-down|panel-font-up|A−|A＋/);
  assert.match(html, /id="btn-shortcuts"/);
  assert.match(html, /id="btn-settings"/);
  assert.match(html, /id="btn-chat"/);
  assert.match(html, /class="tb-actions"/);
  assert.match(html, /id="shortcuts-dialog"/);
  assert.match(html, /PageUp/);
  assert.match(viewer, /highlightActivePages/);
  assert.match(viewer, /setupShortcutsHelp/);
  assert.match(viewer, /pageNumber\.type = 'button'/);
  assert.doesNotMatch(viewer, /applyPanelFontSize|setupPanelFontControls/);
  assert.match(css, /\.panel-page\.is-active/);
  assert.match(css, /\.shortcuts-dialog/);
  assert.match(css, /\.tb-actions/);
  assert.match(css, /#panel-pages[\s\S]*?max-width:\s*none/);
  assert.match(css, /\.md[\s\S]*?max-width:\s*none/);
});

test('panel page header and body share one horizontal gutter (no negative-margin sep drift)', () => {
  // Top bar ("第 N 页 · 复制") and body text must share --page-gutter.
  assert.match(css, /\.panel-page\s*\{[^}]*--page-gutter:/);
  assert.match(css, /\.panel-page-sep\s*\{[^}]*padding:\s*0\s+var\(--page-gutter\)/);
  assert.match(css, /\.panel-page\s*>\s*\.md\s*\{[^}]*padding:\s*0\s+var\(--page-gutter\)/);
  // Negative margin on sep was the old misalignment source.
  assert.doesNotMatch(css, /\.panel-page-sep\s*\{[^}]*margin:\s*0\s+-\d+px/);
});
