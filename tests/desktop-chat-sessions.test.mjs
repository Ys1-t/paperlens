import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptySessions,
  normalizeSessions,
  upsertSession,
  removeSession,
  getSession,
  listSessionSummaries,
  sessionTitleFromQuestion,
  SESSIONS_MAX,
  SESSION_MESSAGES_MAX,
} from '../desktop/lib/chat-session-store.mjs';

test('session title derives from first question line, strips skill suffix', () => {
  assert.equal(sessionTitleFromQuestion('这篇论文的主要贡献是什么？\n\n（请严格执行已激活技能「深读」的流程与输出结构。）'), '这篇论文的主要贡献是什么？');
  assert.equal(sessionTitleFromQuestion(''), '未命名会话');
  const long = '一'.repeat(60);
  assert.equal(sessionTitleFromQuestion(long).length, 39); // 38 + …
});

test('upsertSession creates, updates and sorts by recency', () => {
  let box = emptySessions();
  box = upsertSession(box, { id: 'a', messages: [{ role: 'user', content: '问题 A' }] }, 1000);
  box = upsertSession(box, { id: 'b', messages: [{ role: 'user', content: '问题 B' }] }, 2000);
  assert.equal(box.sessions.length, 2);
  assert.equal(box.sessions[0].id, 'b');
  assert.equal(box.sessions[0].title, '问题 B');
  // 更新 a → a 浮到最前，消息替换为快照
  box = upsertSession(box, {
    id: 'a',
    messages: [
      { role: 'user', content: '问题 A' },
      { role: 'assistant', content: '回答 A' },
    ],
  }, 3000);
  assert.equal(box.sessions[0].id, 'a');
  assert.equal(box.sessions[0].messages.length, 2);
  assert.equal(box.sessions[0].createdAt, 1000, 'createdAt 不因更新改变');
});

test('empty-message upserts are ignored; junk input never crashes', () => {
  let box = upsertSession(emptySessions(), { id: 'x', messages: [] });
  assert.equal(box.sessions.length, 0);
  box = upsertSession(box, { id: '', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(box.sessions.length, 0);
  assert.deepEqual(normalizeSessions(null), emptySessions());
  assert.deepEqual(normalizeSessions({ sessions: [null, 42, { noid: true }] }).sessions, []);
});

test('multimodal content arrays are flattened to text for persistence', () => {
  const box = upsertSession(emptySessions(), {
    id: 'm',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图什么意思？' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xxxx' } },
      ],
    }],
  });
  const session = getSession(box, 'm');
  assert.equal(session.messages[0].content, '这张图什么意思？');
  assert.ok(!JSON.stringify(box).includes('base64'));
});

test('capacity limits: sessions and per-session messages are clamped', () => {
  let box = emptySessions();
  for (let i = 0; i < SESSIONS_MAX + 10; i += 1) {
    box = upsertSession(box, { id: `s${i}`, messages: [{ role: 'user', content: `q${i}` }] }, i);
  }
  assert.equal(box.sessions.length, SESSIONS_MAX);
  // 最老的被裁掉，最新的还在
  assert.equal(getSession(box, 's0'), null);
  assert.ok(getSession(box, `s${SESSIONS_MAX + 9}`));

  const many = Array.from({ length: SESSION_MESSAGES_MAX + 20 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const clamped = upsertSession(emptySessions(), { id: 'big', messages: many });
  assert.equal(getSession(clamped, 'big').messages.length, SESSION_MESSAGES_MAX);
  // 保尾不保头（最近的消息优先）
  assert.equal(getSession(clamped, 'big').messages.at(-1).content, `m${SESSION_MESSAGES_MAX + 19}`);
});

test('remove and summaries work end to end', () => {
  let box = emptySessions();
  box = upsertSession(box, {
    id: 'a', paperTitle: 'WRPN paper',
    messages: [
      { role: 'user', content: '贡献？' },
      { role: 'assistant', content: '三点。' },
      { role: 'user', content: '细节？' },
    ],
  }, 5000);
  const summaries = listSessionSummaries(box);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].turns, 2);
  assert.equal(summaries[0].paperTitle, 'WRPN paper');
  assert.equal(summaries[0].messages, undefined, '摘要不带消息体');
  box = removeSession(box, 'a');
  assert.equal(box.sessions.length, 0);
});
