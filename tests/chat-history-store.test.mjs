import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatDocKey,
  buildChatSessionRecord,
  deriveChatSessionTitle,
  formatChatSessionTime,
  serializeChatMessagesForStorage,
  serializeEvidenceForStorage,
  toChatSessionListItem,
} from '../src/lib/chat-history-store.js';

test('deriveChatSessionTitle uses the first user question', () => {
  assert.equal(
    deriveChatSessionTitle([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '  什么是 Pareto front？  ' },
    ]),
    '什么是 Pareto front？',
  );
  assert.equal(
    deriveChatSessionTitle([{ role: 'user', content: '', hadImage: true, pageNum: 3 }]),
    '页图提问 · 第 3 页',
  );
  assert.equal(deriveChatSessionTitle([]), '新对话');
});

test('serializeChatMessagesForStorage strips base64 images but keeps page markers', () => {
  const rows = serializeChatMessagesForStorage([
    {
      role: 'user',
      content: '解释这页',
      images: ['data:image/jpeg;base64,AAAA'],
      pageNum: 5,
    },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '   ' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hadImage, true);
  assert.equal(rows[0].pageNum, 5);
  assert.equal(rows[0].images, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /base64/);
});

test('research sessions retain bounded tool trail, skill and evidence provenance', () => {
  const [row] = serializeChatMessagesForStorage([{
    role: 'assistant',
    content: '方法见第 3 页。',
    skillId: 'method',
    toolSteps: [
      { name: 'retrieve_evidence', label: '自动检索证据', ok: true },
      { name: 'get_page', label: '阅读第 3 页', ok: true, page: 3 },
    ],
    evidence: {
      pages: [3, 4, 3],
      citedPages: [3],
      invalidPages: [99],
      unsupportedPages: [],
      sourceTypes: ['translation', 'source', 'unknown'],
      coverage: 0.75,
      ok: false,
      items: [{
        page: 3,
        sourceType: 'source',
        heading: 'Method',
        snippet: 'A grounded source fragment about the proposed method.',
        score: 4.2,
        termCoverage: 0.8,
      }],
      support: {
        score: 82,
        level: 'strong',
        label: '证据支持强',
        reasons: ['引用页均已查阅'],
        evidenceCount: 1,
        uniquePages: 1,
      },
    },
  }]);
  assert.equal(row.skillId, 'method');
  assert.equal(row.toolSteps.length, 2);
  assert.equal(row.toolSteps[1].page, 3);
  assert.deepEqual(row.evidence.pages, [3, 4]);
  assert.deepEqual(row.evidence.sourceTypes, ['translation', 'source']);
  assert.equal(row.evidence.coverage, 0.75);
  assert.equal(row.evidence.items[0].snippet, 'A grounded source fragment about the proposed method.');
  assert.equal(row.evidence.support.score, 82);
  assert.equal(row.evidence.support.level, 'strong');
});

test('evidence storage normalization rejects noise and clamps coverage', () => {
  assert.equal(serializeEvidenceForStorage(null), null);
  const value = serializeEvidenceForStorage({
    evidencePages: [2, '2', -1, 'bad'],
    citedPages: [2],
    sourceTypes: ['source', 'bad'],
    coverage: 4,
  });
  assert.deepEqual(value.pages, [2]);
  assert.deepEqual(value.sourceTypes, ['source']);
  assert.equal(value.coverage, 1);
});

test('evidence history bounds snippets, deduplicates items and sanitizes support', () => {
  const value = serializeEvidenceForStorage({
    items: [
      { page: 7, sourceType: 'source', snippet: `  ${'evidence '.repeat(100)}  `, score: -2, termCoverage: 8 },
      { page: 7, sourceType: 'source', snippet: `  ${'evidence '.repeat(100)}  ` },
      { page: 0, snippet: 'invalid' },
    ],
    support: { score: 170, level: 'unknown', reasons: [' reason '.repeat(30)] },
  });
  assert.equal(value.items.length, 1);
  assert.ok(value.items[0].snippet.length <= 520);
  assert.equal(value.items[0].score, 0);
  assert.equal(value.items[0].termCoverage, 1);
  assert.deepEqual(value.pages, [7]);
  assert.equal(value.support.score, 100);
  assert.equal(value.support.level, 'strong');
  assert.ok(value.support.reasons[0].length <= 120);
});

test('buildChatSessionRecord fills title and skips empty sessions', () => {
  const record = buildChatSessionRecord({
    id: 's1',
    docKey: 't:Demo|p:10',
    docTitle: 'Demo.pdf',
    messages: [{ role: 'user', content: '你好' }],
    createdAt: 100,
    updatedAt: 200,
  });
  assert.equal(record.id, 's1');
  assert.equal(record.title, '你好');
  assert.equal(record.messageCount, 1);
  assert.equal(toChatSessionListItem(record).docTitle, 'Demo.pdf');
});

test('buildChatDocKey is stable for title and page count', () => {
  assert.equal(buildChatDocKey({ title: '  A  B  ', totalPages: 12 }), 't:A B|p:12');
  assert.equal(buildChatDocKey({}), 'unknown');
});

test('formatChatSessionTime uses relative labels for recent times', () => {
  const now = 1_000_000;
  assert.equal(formatChatSessionTime(now - 10_000, now), '刚刚');
  assert.equal(formatChatSessionTime(now - 120_000, now), '2 分钟前');
});
