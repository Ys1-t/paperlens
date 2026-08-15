import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPaperNoteMarkdown,
  buildPaperNotePath,
  buildThoughtAppendMarkdown,
  encodeVaultPath,
  normalizeObsidianSettings,
  pickObsidianConfigFields,
  sanitizeObsidianPathSegment,
  upsertPaperNote,
  vaultUrl,
} from '../src/lib/obsidian-bridge.js';

test('sanitizes path segments and builds vault note path', () => {
  assert.equal(sanitizeObsidianPathSegment('A/B:C*?.md'), 'A B C .md');
  assert.equal(
    buildPaperNotePath({ folder: 'PaperLens', docTitle: 'Neuro-PLS: A Paper' }),
    'PaperLens/Neuro-PLS A Paper.md',
  );
  assert.equal(
    encodeVaultPath('PaperLens/Hello World.md'),
    'PaperLens/Hello%20World.md',
  );
  assert.equal(
    vaultUrl('http://127.0.0.1:27123', 'PaperLens/x.md'),
    'http://127.0.0.1:27123/vault/PaperLens/x.md',
  );
});

test('note markdown has frontmatter, assistant notes, and thoughts', () => {
  const md = buildPaperNoteMarkdown({
    docTitle: 'Demo Paper',
    notesMarkdown: '## 1. 导读\n\n要点',
    thoughts: '我想验证复杂度是否可降。',
    now: new Date('2026-07-25T12:00:00Z'),
  });
  assert.match(md, /title: "Demo Paper"/);
  assert.match(md, /tags: \[paperlens, paper-notes\]/);
  assert.match(md, /## 助手笔记/);
  assert.match(md, /要点/);
  assert.match(md, /## 我的思考/);
  assert.match(md, /复杂度是否可降/);
  assert.match(buildThoughtAppendMarkdown({ title: '我的思考', content: '追记' }), /### 我的思考/);
});

test('upsert creates then appends without overwriting existing body', async () => {
  const store = new Map();
  const fetchImpl = async (url, init = {}) => {
    const path = decodeURIComponent(String(url).split('/vault/')[1] || '');
    if (init.method === 'GET' || !init.method) {
      if (!store.has(path)) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => store.get(path) };
    }
    if (init.method === 'PUT') {
      store.set(path, String(init.body || ''));
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: false, status: 500, text: async () => 'bad' };
  };

  const settings = {
    obsidianEnabled: true,
    obsidianBaseUrl: 'http://127.0.0.1:27123',
    obsidianApiKey: 'test-key',
    obsidianFolder: 'PaperLens',
  };

  const first = await upsertPaperNote(settings, {
    docTitle: 'Demo',
    notesMarkdown: '初稿笔记',
    thoughts: '第一想法',
    fetchImpl,
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.match(store.get(first.path), /初稿笔记/);
  assert.match(store.get(first.path), /第一想法/);

  const second = await upsertPaperNote(settings, {
    docTitle: 'Demo',
    thoughts: '第二想法：对照实验要补。',
    fetchImpl,
  });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  const body = store.get(second.path);
  assert.match(body, /初稿笔记/);
  assert.match(body, /第一想法/);
  assert.match(body, /第二想法/);
});

test('normalizeObsidianSettings trims folder and defaults HTTP port', () => {
  const n = normalizeObsidianSettings({
    obsidianEnabled: 1,
    obsidianBaseUrl: 'http://127.0.0.1:27123/',
    obsidianFolder: '/Papers/',
    obsidianApiKey: ' abc ',
  });
  assert.equal(n.enabled, true);
  assert.equal(n.baseUrl, 'http://127.0.0.1:27123');
  assert.equal(n.folder, 'Papers');
  assert.equal(n.apiKey, 'abc');
});

test('normalizeObsidianSettings is idempotent (already-normalized objects stay enabled)', () => {
  // Regression: SW normalize once, then upsert normalize again — must keep enabled.
  const once = normalizeObsidianSettings({
    obsidianEnabled: true,
    obsidianBaseUrl: 'http://127.0.0.1:27123',
    obsidianApiKey: 'k',
    obsidianFolder: 'PaperLens',
  });
  const twice = normalizeObsidianSettings(once);
  assert.equal(once.enabled, true);
  assert.equal(twice.enabled, true);
  assert.equal(twice.apiKey, 'k');
  assert.equal(twice.folder, 'PaperLens');
});

test('normalize never picks translation profile baseUrl/apiKey (cliproxy regression)', () => {
  // Full runtime config mixed with Obsidian fields — LLM proxy must be ignored.
  const n = normalizeObsidianSettings({
    baseUrl: 'https://cliproxy.300318.xyz/v1',
    apiKey: 'llm-secret',
    model: 'gpt-x',
    provider: 'openai',
    obsidianEnabled: true,
    obsidianBaseUrl: 'http://127.0.0.1:27123',
    obsidianApiKey: 'obsidian-key',
    obsidianFolder: 'PaperLens',
  });
  assert.equal(n.baseUrl, 'http://127.0.0.1:27123');
  assert.equal(n.apiKey, 'obsidian-key');
  assert.doesNotMatch(n.baseUrl, /cliproxy/);

  const picked = pickObsidianConfigFields({
    baseUrl: 'https://cliproxy.300318.xyz/v1',
    apiKey: 'llm-secret',
    obsidianEnabled: true,
    obsidianBaseUrl: 'http://127.0.0.1:27123',
    obsidianApiKey: 'obs-key',
    obsidianFolder: 'Notes',
  });
  assert.equal(picked.obsidianBaseUrl, 'http://127.0.0.1:27123');
  assert.equal(picked.obsidianApiKey, 'obs-key');
  assert.equal(picked.obsidianFolder, 'Notes');
  assert.equal(Object.hasOwn(picked, 'baseUrl'), false);
});
