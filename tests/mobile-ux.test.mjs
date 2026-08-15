import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isIosSafari,
  isIpadUserAgent,
  shouldShowIosInstallHint,
  installBannerCopy,
  isIpadLayout,
  shouldUseSplitCompare,
  swipeFromDelta,
  nextUntranslatedPage,
  untranslatedCount,
  cycleFontLevel,
  fontSizePx,
  nextTheme,
  dockPageLabel,
  clampPage,
  readingProgressRatio,
  parseGotoPage,
  searchTranslationHits,
  selectionPopoverActions,
  clipSelection,
  mobileAgentStarters,
  buildMobilePaperProvider,
  parseArxivId,
  arxivPdfUrl,
  parseArxivAtomXml,
  upsertLibraryEntry,
  upsertDraft,
  toggleLibraryStar,
  removeLibraryEntry,
  scoreMobileRadarPaper,
  sortRadarByScore,
  parseKeywordList,
  extractCopyableLatex,
} from '../app/mobile-ux.js';
import { executeResearchTool } from '../src/lib/research-agent.js';

test('iOS / iPad install hint', () => {
  assert.equal(isIosSafari('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(isIosSafari('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'), false);
  assert.equal(isIpadUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), true);
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.equal(shouldShowIosInstallHint({ ua: safari, standalone: false }), true);
  assert.equal(shouldShowIosInstallHint({ ua: safari, standalone: true }), false);
  assert.equal(shouldShowIosInstallHint({ ua: safari, dismissed: true }), false);
  assert.match(installBannerCopy('iPad'), /主屏幕/);
});

test('iPad split layout and swipe', () => {
  assert.equal(isIpadLayout(1024), true);
  assert.equal(isIpadLayout(390), false);
  assert.equal(shouldUseSplitCompare(1024), true);
  assert.equal(swipeFromDelta(-80, 10), 'next');
  assert.equal(swipeFromDelta(90, 8), 'prev');
  assert.equal(swipeFromDelta(-20, 4), null);
  assert.equal(swipeFromDelta(-80, 90), null);
});

test('page helpers and search', () => {
  const pages = [
    { num: 1, translated: '摘要 hello' },
    { num: 2, started: true },
    { num: 3 },
  ];
  assert.equal(nextUntranslatedPage(pages, 1), 3);
  assert.equal(untranslatedCount(pages), 2);
  assert.equal(dockPageLabel(2, 10), '2 / 10');
  assert.equal(clampPage(0, 12), 1);
  assert.equal(clampPage(99, 12), 12);
  assert.equal(readingProgressRatio(3, 12), 0.25);
  assert.equal(parseGotoPage('7', 12), 7);
  assert.equal(parseGotoPage('99', 12), 0);
  const hits = searchTranslationHits(pages, 'hello');
  assert.equal(hits[0].page, 1);
});

test('font / theme / selection / starters', () => {
  assert.equal(cycleFontLevel('md'), 'lg');
  assert.equal(fontSizePx('lg'), 18);
  assert.equal(nextTheme('light'), 'dark');
  assert.deepEqual(selectionPopoverActions({ hasSelection: true, hasPaper: true }).map((a) => a.id), ['copy', 'translate', 'ask']);
  assert.equal(selectionPopoverActions({ hasSelection: false }).length, 0);
  assert.ok(clipSelection('a'.repeat(20), 8).endsWith('…'));
  assert.ok(mobileAgentStarters().length >= 3);
});

test('mobile paper provider matches research-agent tools', () => {
  const provider = buildMobilePaperProvider({
    title: 'Demo.pdf',
    currentPage: 1,
    pages: [
      { num: 1, translated: '本文提出方法 A' },
      { num: 2, sourceText: 'Method B is proposed.' },
    ],
  });
  const meta = executeResearchTool({ name: 'get_paper_meta', args: {} }, provider);
  assert.match(meta.text, /Demo/);
  assert.match(meta.text, /已译页数：1/);
  const list = executeResearchTool({ name: 'list_pages', args: {} }, provider);
  assert.match(list.text, /第 2 页/);
  const search = executeResearchTool({ name: 'search_paper', args: { query: '方法' } }, provider);
  assert.match(search.text, /第 1 页/);
  const cur = executeResearchTool({ name: 'get_current_page', args: {} }, provider);
  assert.match(cur.text, /方法 A/);
});

test('arxiv parse and library/draft upsert', () => {
  assert.equal(parseArxivId('https://arxiv.org/abs/2401.02051'), '2401.02051');
  assert.equal(parseArxivId('arXiv:2401.02051v2'), '2401.02051v2');
  assert.match(arxivPdfUrl('2401.02051'), /export\.arxiv\.org/);
  const papers = parseArxivAtomXml('<feed><entry><id>http://arxiv.org/abs/2401.02051</id><title>Hello</title><summary>s</summary><published>2024-01-01</published></entry></feed>');
  assert.equal(papers[0].arxivId, '2401.02051');
  const lib = upsertLibraryEntry([], { title: 'A.pdf', lastPage: 3, totalPages: 10 });
  assert.equal(lib[0].title, 'A.pdf');
  const drafts = upsertDraft([], { title: 'RW', body: 'text' });
  assert.equal(drafts[0].kind, 'general');
});

test('radar score, library star, latex extract', () => {
  assert.deepEqual(parseKeywordList('agent, 优化；RL'), ['agent', '优化', 'RL']);
  const scored = scoreMobileRadarPaper({ title: 'An Agent paper', summary: 'foo' }, ['agent']);
  assert.ok(scored.score > 8);
  const sorted = sortRadarByScore([{ score: 1 }, { score: 9 }]);
  assert.equal(sorted[0].score, 9);
  let lib = upsertLibraryEntry([], { id: 'a', title: 'A' });
  lib = toggleLibraryStar(lib, 'a');
  assert.equal(lib[0].starred, true);
  lib = removeLibraryEntry(lib, 'a');
  assert.equal(lib.length, 0);
  assert.match(extractCopyableLatex('x\n```latex\n\\section{RW}\n```'), /\\section/);
});
