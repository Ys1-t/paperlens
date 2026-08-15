import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_MAX,
  addNote,
  emptyWorkspace,
  normalizeObsidian,
  normalizeWorkspace,
  noteToVaultFilename,
  noteToVaultMarkdown,
  notesToMarkdown,
  recentCardModel,
  removeNote,
  upsertGlossaryTerm,
  upsertRecent,
} from '../desktop/lib/workspace-store.mjs';

test('normalizeWorkspace survives junk and clamps sizes', () => {
  assert.deepEqual(normalizeWorkspace(null), emptyWorkspace());
  assert.deepEqual(normalizeWorkspace('garbage'), emptyWorkspace());
  const ws = normalizeWorkspace({
    recent: [{ path: 'C:/a.pdf', title: 'A' }, { path: '', title: 'no-path' }, null],
    notes: [{ content: 'x' }, { content: '' }, 'junk'],
  });
  assert.equal(ws.recent.length, 1);
  assert.equal(ws.notes.length, 1);
});

test('upsertRecent dedupes by path, keeps richer fields, newest first', () => {
  let ws = emptyWorkspace();
  ws = upsertRecent(ws, { path: 'C:/a.pdf', title: 'A', totalPages: 20, translatedCount: 5 }, 100);
  ws = upsertRecent(ws, { path: 'C:/b.pdf', title: 'B', totalPages: 8 }, 200);
  // 只更新页码时不丢 totalPages/translatedCount
  ws = upsertRecent(ws, { path: 'C:/a.pdf', title: 'A', lastPage: 7 }, 300);
  assert.equal(ws.recent.length, 2);
  assert.equal(ws.recent[0].path, 'C:/a.pdf');
  assert.equal(ws.recent[0].lastPage, 7);
  assert.equal(ws.recent[0].totalPages, 20);
  assert.equal(ws.recent[0].translatedCount, 5);
  // 容量截断
  for (let i = 0; i < RECENT_MAX + 5; i += 1) {
    ws = upsertRecent(ws, { path: `C:/p${i}.pdf`, title: `P${i}` }, 400 + i);
  }
  assert.equal(ws.recent.length, RECENT_MAX);
});

test('addNote dedupes same paper+content; removeNote deletes by id', () => {
  let ws = emptyWorkspace();
  const first = addNote(ws, { title: 'T', content: '内容一', paperTitle: 'P' }, 10);
  assert.equal(first.added, true);
  const dup = addNote(first.workspace, { title: '换标题也算重复', content: '内容一', paperTitle: 'P' }, 20);
  assert.equal(dup.added, false);
  const other = addNote(dup.workspace, { title: 'T', content: '内容一', paperTitle: '别的论文' }, 30);
  assert.equal(other.added, true);
  const removed = removeNote(other.workspace, other.workspace.notes[0].id);
  assert.equal(removed.notes.length, 1);
});

test('notesToMarkdown groups by paper with source labels', () => {
  let ws = emptyWorkspace();
  ws = addNote(ws, { title: '方法拆解', content: 'MTPSL 用共享网络…', paperTitle: 'MTPSL', source: 'ai' }, 1000).workspace;
  ws = addNote(ws, { title: '我的想法', content: '可以试试用在扩散模型上', paperTitle: 'MTPSL', source: 'manual' }, 2000).workspace;
  const md = notesToMarkdown(ws);
  assert.match(md, /## MTPSL/);
  assert.match(md, /### 方法拆解.*AI 回答/);
  assert.match(md, /### 我的想法(?!.*AI 回答)/);
  assert.match(notesToMarkdown(emptyWorkspace()), /暂无笔记/);
});

test('recentCardModel computes progress and trims long titles', () => {
  const model = recentCardModel({
    path: 'C:/x.pdf', title: `${'超长标题'.repeat(20)}.pdf`, totalPages: 20, lastPage: 5, translatedCount: 3,
  });
  assert.equal(model.progressPercent, 25);
  assert.match(model.subtitle, /第 5 \/ 20 页 · 已译 3 页/);
  assert.ok(model.displayTitle.length <= 60);
  assert.equal(recentCardModel({ path: '', title: 'x' }), null);
});

// Obsidian vault 同步：配置规范化 + 笔记 → vault .md（frontmatter + 双链）+ 文件名净化。
test('normalizeObsidian requires a folder path', () => {
  assert.equal(normalizeObsidian(null), null);
  assert.equal(normalizeObsidian({ folder: '  ' }), null);
  assert.deepEqual(normalizeObsidian({ folder: 'D:/vault', enabled: false }), { folder: 'D:/vault', enabled: false });
  assert.equal(normalizeObsidian({ folder: 'D:/vault' }).enabled, true);
});

test('noteToVaultMarkdown emits frontmatter and a wiki-link to the paper', () => {
  const md = noteToVaultMarkdown({
    title: '方法拆解', content: 'MTPSL 用共享网络…',
    paperTitle: 'MTPSL.pdf', source: 'ai', createdAt: 1718000000000,
  });
  assert.match(md, /^---\nsource: ai\npaper: "MTPSL\.pdf"/);
  assert.match(md, /^# 方法拆解$/m);
  assert.match(md, /\[\[MTPSL\]\]/); // 双链建议（去 .pdf 后缀）
});

test('noteToVaultFilename strips path-illegal chars', () => {
  assert.equal(noteToVaultFilename({ title: 'A/B: method?.x', content: 'c' }), 'A B method .x.md');
  // 空 title 时 normalizeNote 回填「未命名笔记」。
  assert.equal(noteToVaultFilename({ title: '', content: 'c' }), '未命名笔记.md');
});

// 术语表：小写去重（后写覆盖）、容量截断、upsert。
test('glossary list dedupes case-insensitively and upserts', () => {
  const ws1 = upsertGlossaryTerm(emptyWorkspace(), { term: 'Pareto Front', translation: '帕累托前沿' });
  assert.equal(ws1.glossary.length, 1);
  const ws2 = upsertGlossaryTerm(ws1, { term: 'pareto front', translation: '帕雷托前沿' });
  assert.equal(ws2.glossary.length, 1);
  assert.equal(ws2.glossary[0].translation, '帕雷托前沿'); // 后写覆盖
  const ws3 = upsertGlossaryTerm(ws2, { term: '', translation: 'x' });
  assert.equal(ws3.glossary.length, 1); // 无效不入表
  // roundtrip 经 normalizeWorkspace 存活
  assert.equal(normalizeWorkspace(JSON.parse(JSON.stringify(ws2))).glossary.length, 1);
});
