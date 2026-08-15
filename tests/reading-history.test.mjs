import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READING_HISTORY_KEY,
  READING_HISTORY_MAX,
  getReadingProgress,
  listRecentReadings,
  loadReadingHistory,
  normalizeReadingEntry,
  readingEntryLabel,
  recordReadingProgress,
  shouldOfferResume,
} from '../src/lib/reading-history.js';

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
  };
}

test('normalizeReadingEntry validates docKey/page and clamps to pageCount', () => {
  assert.equal(normalizeReadingEntry(null), null);
  assert.equal(normalizeReadingEntry({ docKey: '', page: 3 }), null);
  assert.equal(normalizeReadingEntry({ docKey: 'unknown', page: 3 }), null);
  assert.equal(normalizeReadingEntry({ docKey: 'k', page: 0 }), null);
  const entry = normalizeReadingEntry({
    docKey: 'k', title: '  A   Paper ', page: 99, pageCount: 12,
    sourceUrl: 'https://arxiv.org/pdf/1234.pdf', updatedAt: 5,
  });
  assert.equal(entry.title, 'A Paper');
  assert.equal(entry.page, 12); // clamped
  assert.equal(entry.sourceUrl, 'https://arxiv.org/pdf/1234.pdf');
  assert.equal(entry.updatedAt, 5);
  // 非 http(s) 来源（本地文件）不保留 URL
  assert.equal(normalizeReadingEntry({ docKey: 'k', page: 1, sourceUrl: 'file:///x.pdf' }).sourceUrl, '');
});

test('recordReadingProgress upserts by docKey and caps the list', () => {
  const storage = fakeStorage();
  recordReadingProgress({ docKey: 'a', title: 'A', page: 2, pageCount: 10, updatedAt: 1 }, storage);
  recordReadingProgress({ docKey: 'b', title: 'B', page: 5, pageCount: 20, updatedAt: 2 }, storage);
  recordReadingProgress({ docKey: 'a', title: 'A', page: 7, pageCount: 10, updatedAt: 3 }, storage);
  const list = loadReadingHistory(storage);
  assert.equal(list.length, 2);
  assert.equal(getReadingProgress('a', storage).page, 7);

  for (let i = 0; i < READING_HISTORY_MAX + 5; i += 1) {
    recordReadingProgress({ docKey: `doc-${i}`, page: 2, updatedAt: 100 + i }, storage);
  }
  const capped = loadReadingHistory(storage);
  assert.equal(capped.length, READING_HISTORY_MAX);
  // 最旧的被淘汰，最新的保留
  assert.equal(getReadingProgress('a', storage), null);
  assert.ok(getReadingProgress(`doc-${READING_HISTORY_MAX + 4}`, storage));
});

test('listRecentReadings sorts newest first and honors limit', () => {
  const storage = fakeStorage();
  recordReadingProgress({ docKey: 'old', page: 2, updatedAt: 1 }, storage);
  recordReadingProgress({ docKey: 'mid', page: 3, updatedAt: 2 }, storage);
  recordReadingProgress({ docKey: 'new', page: 4, updatedAt: 3 }, storage);
  const recents = listRecentReadings({ limit: 2 }, storage);
  assert.deepEqual(recents.map((it) => it.docKey), ['new', 'mid']);
});

test('loadReadingHistory degrades to [] on corrupt or missing storage', () => {
  assert.deepEqual(loadReadingHistory(null), []);
  assert.deepEqual(loadReadingHistory(fakeStorage({ [READING_HISTORY_KEY]: '{not json' })), []);
  assert.deepEqual(loadReadingHistory(fakeStorage({ [READING_HISTORY_KEY]: '{"a":1}' })), []);
});

test('shouldOfferResume requires page>=2 within the current document', () => {
  assert.equal(shouldOfferResume(null), false);
  assert.equal(shouldOfferResume({ page: 1 }), false);
  assert.equal(shouldOfferResume({ page: 2 }), true);
  assert.equal(shouldOfferResume({ page: 30 }, { pageCount: 12 }), false);
  assert.equal(shouldOfferResume({ page: 12 }, { pageCount: 12 }), true);
});

test('readingEntryLabel renders title and page position', () => {
  assert.equal(
    readingEntryLabel({ title: 'Attention Is All You Need', page: 3, pageCount: 15 }),
    'Attention Is All You Need · 第 3/15 页',
  );
  assert.equal(readingEntryLabel({ title: '', page: 2, pageCount: 0 }), '(未命名文档) · 第 2 页');
  assert.equal(readingEntryLabel(null), '');
});

// 一键重开链路契约：popup 本地条目 → ?reopen=<docKey> → viewer 用句柄库打开。
test('recent local files reopen through the handle store instead of re-picking', async () => {
  const { readFileSync } = await import('node:fs');
  const viewer = readFileSync(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  // popup：本地条目走 reopen 消息，不再退回「重新选择文件」。
  assert.match(popup, /openViewerReopen\(entry\.docKey\)/);
  assert.match(popup, /type:\s*'openViewer',\s*reopen:\s*docKey/);
  // SW：reopen 参数进 viewer URL。
  assert.match(sw, /reopen=\$\{encodeURIComponent\(reopen\)\}/);
  // viewer：启动读 ?reopen=，句柄→权限→getFile→打开；打开成功后保存句柄。
  assert.match(viewer, /getReopenParam/);
  assert.match(viewer, /reopenRecentLocalFile\(reopenKey\)/);
  assert.match(viewer, /getRecentFileHandle/);
  assert.match(viewer, /saveRecentFileHandle\(chatDocKey\(\), handle\)/);
  // 权限需用户手势时的兜底按钮。
  assert.match(viewer, /dz-reopen-btn/);
  // 文件选择与拖拽都尽量捕获句柄。
  assert.match(viewer, /showOpenFilePicker/);
  assert.match(viewer, /getAsFileSystemHandle/);
});
