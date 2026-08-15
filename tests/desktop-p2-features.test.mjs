import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyTabState, openTab, closeTab, setActiveTab, updateTabProgress,
  activeTab, tabLabel, normalizeTabState, READER_TABS_MAX,
} from '../desktop/lib/reader-tabs.mjs';
import {
  addHighlight, removeHighlight, listHighlights, listHighlightsForPage,
  findHighlightSpanRange, normalizeHighlightsMap,
} from '../desktop/lib/highlights-store.mjs';
import {
  upsertDraft, removeDraft, getDraft, lineDiff, draftPromptForKind, normalizeDrafts,
} from '../desktop/lib/writing-draft.mjs';
import { normalizeWorkspace, setHighlightsMap, setDraftsList } from '../desktop/lib/workspace-store.mjs';

test('reader tabs open/focus by path and cap capacity', () => {
  let s = emptyTabState();
  s = openTab(s, { path: '/a.pdf', name: 'A.pdf', totalPages: 10 });
  s = openTab(s, { path: '/b.pdf', name: 'B.pdf', totalPages: 5 });
  assert.equal(s.tabs.length, 2);
  assert.equal(activeTab(s).path, '/b.pdf');
  s = openTab(s, { path: '/a.pdf', lastPage: 3 });
  assert.equal(s.tabs.length, 2);
  assert.equal(activeTab(s).lastPage, 3);
  assert.equal(activeTab(s).path, '/a.pdf');
  for (let i = 0; i < 12; i += 1) {
    s = openTab(s, { path: `/p${i}.pdf`, name: `P${i}.pdf` });
  }
  assert.ok(s.tabs.length <= READER_TABS_MAX);
});

test('close tab activates neighbor', () => {
  let s = openTab(emptyTabState(), { path: '/a.pdf', name: 'A' });
  s = openTab(s, { path: '/b.pdf', name: 'B' });
  s = openTab(s, { path: '/c.pdf', name: 'C' });
  const active = s.activeId;
  s = closeTab(s, active);
  assert.equal(s.tabs.length, 2);
  assert.ok(s.activeId);
  assert.ok(s.tabs.some((t) => t.id === s.activeId));
});

test('tabLabel truncates long names', () => {
  assert.equal(tabLabel({ name: 'short.pdf' }), 'short');
  assert.ok(tabLabel({ name: 'a'.repeat(40) + '.pdf' }).endsWith('…'));
});

test('updateTabProgress and setActiveTab', () => {
  let s = openTab(emptyTabState(), { path: '/x.pdf', name: 'X', totalPages: 20 });
  const id = s.activeId;
  s = openTab(s, { path: '/y.pdf', name: 'Y' });
  s = setActiveTab(s, id);
  s = updateTabProgress(s, { id, lastPage: 7 });
  assert.equal(activeTab(s).lastPage, 7);
  assert.deepEqual(normalizeTabState(null).tabs, []);
});

test('highlights add/list/remove and span range finder', () => {
  let map = {};
  const r1 = addHighlight(map, '/p.pdf', { page: 2, text: 'Pareto front', color: 'yellow' });
  assert.equal(r1.added, true);
  map = r1.map;
  const r2 = addHighlight(map, '/p.pdf', { page: 2, text: 'Pareto front', color: 'green' });
  assert.equal(r2.added, false); // 去重
  assert.equal(listHighlightsForPage(map, '/p.pdf', 2).length, 1);
  map = removeHighlight(map, '/p.pdf', r1.highlight.id);
  assert.equal(listHighlights(map, '/p.pdf').length, 0);

  const spans = ['The ', 'Pareto ', 'front ', 'is ', 'shown.'];
  const range = findHighlightSpanRange(spans, 'Pareto front');
  assert.ok(range);
  assert.equal(range.start, 1);
  assert.equal(range.end, 2);
  assert.equal(findHighlightSpanRange(spans, 'zzzz'), null);
  assert.ok(Object.keys(normalizeHighlightsMap({ '/a': [{ text: 'ab', page: 1 }] })).length === 1);
});

test('writing drafts upsert/remove and lineDiff', () => {
  let list = [];
  const { drafts, draft } = upsertDraft(list, { title: 'RW', body: 'hello\nworld', kind: 'related-work' });
  list = drafts;
  assert.equal(list.length, 1);
  assert.equal(getDraft(list, draft.id).title, 'RW');
  const again = upsertDraft(list, { id: draft.id, title: 'RW2', body: 'hello\nworld\nnew' });
  assert.equal(again.drafts.length, 1);
  assert.equal(again.draft.title, 'RW2');
  list = removeDraft(again.drafts, draft.id);
  assert.equal(list.length, 0);

  const diff = lineDiff('a\nb\nc', 'a\nx\nc');
  assert.ok(diff.some((d) => d.type === 'del' && d.text === 'b'));
  assert.ok(diff.some((d) => d.type === 'add' && d.text === 'x'));
  assert.match(draftPromptForKind('polish', { body: '原文' }), /润色/);
  assert.equal(normalizeDrafts(null).length, 0);
});

test('workspace persists highlights and drafts fields', () => {
  let ws = normalizeWorkspace({});
  assert.deepEqual(ws.highlights, {});
  assert.deepEqual(ws.drafts, []);
  ws = setHighlightsMap(ws, {
    '/a.pdf': [{ id: 'h1', page: 1, text: 'method', color: 'yellow' }],
  });
  assert.equal(ws.highlights['/a.pdf'].length, 1);
  ws = setDraftsList(ws, [{ id: 'd1', title: 'T', body: 'body text here' }]);
  assert.equal(ws.drafts.length, 1);
  // round-trip
  ws = normalizeWorkspace(ws);
  assert.equal(ws.highlights['/a.pdf'][0].text, 'method');
  assert.equal(ws.drafts[0].title, 'T');
});
