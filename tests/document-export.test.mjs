import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDocumentTranslationMarkdown,
  buildDocumentTranslationPlainText,
  documentExportFilename,
  sanitizeExportBasename,
} from '../src/lib/document-export.js';

test('buildDocumentTranslationMarkdown includes only pages with content', () => {
  const { markdown, exportedPageCount, pageCount } = buildDocumentTranslationMarkdown({
    title: 'Demo.pdf',
    pages: [
      { num: 1, translationText: '第一页译文', outcome: 'done' },
      { num: 2, outcome: 'failed', error: '连接中断' },
      { num: 3, translationText: '第三页', outcome: 'done' },
    ],
    exportedAt: new Date('2026-07-21T12:00:00Z'),
  });
  assert.equal(pageCount, 3);
  assert.equal(exportedPageCount, 2);
  assert.match(markdown, /# Demo\.pdf/);
  assert.match(markdown, /## 第 1 页/);
  assert.match(markdown, /第一页译文/);
  assert.match(markdown, /本页未完成：连接中断/);
  assert.match(markdown, /第三页/);
});

test('plain export strips markdown heading markers', () => {
  const { text, exportedPageCount } = buildDocumentTranslationPlainText({
    title: 'X',
    pages: [{ num: 1, translationText: '你好' }],
  });
  assert.equal(exportedPageCount, 1);
  assert.match(text, /你好/);
  assert.doesNotMatch(text, /^# /m);
});

test('export filename is filesystem-safe', () => {
  assert.equal(sanitizeExportBasename('a/b:c.pdf'), 'a b c');
  assert.match(
    documentExportFilename({ title: 'Paper.pdf', ext: 'md', now: new Date('2026-07-21T12:00:00Z') }),
    /^paperlens-Paper-.*\.md$/,
  );
});
