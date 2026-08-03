import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GLOSSARY_MAX_TERMS,
  GLOSSARY_STORAGE_KEY,
  appendGlossaryPrompt,
  formatGlossaryPrompt,
  glossaryFingerprintForText,
  glossaryTermsInText,
  loadGlossary,
  normalizeGlossary,
  removeGlossaryTerm,
  saveGlossary,
  upsertGlossaryTerm,
} from '../src/lib/glossary.js';

function fakeArea() {
  const store = {};
  return {
    store,
    async get(key) { return { [key]: store[key] }; },
    async set(obj) { Object.assign(store, obj); },
  };
}

test('normalizeGlossary trims, dedupes case-insensitively (later wins) and caps size', () => {
  const normalized = normalizeGlossary([
    { term: '  attention   head ', translation: ' 注意力头 ' },
    { term: 'Attention Head', translation: '注意头' },
    { term: '', translation: '空的' },
    { term: 'no translation', translation: '' },
    null,
    'garbage',
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].term, 'Attention Head');
  assert.equal(normalized[0].translation, '注意头');

  const overflow = normalizeGlossary(
    Array.from({ length: GLOSSARY_MAX_TERMS + 20 }, (_, i) => ({
      term: `term-${i}`,
      translation: `译-${i}`,
    })),
  );
  assert.equal(overflow.length, GLOSSARY_MAX_TERMS);
  assert.equal(overflow.at(-1).term, `term-${GLOSSARY_MAX_TERMS + 19}`);
});

test('upsert / remove roundtrip persists through the storage area', async () => {
  const area = fakeArea();
  await upsertGlossaryTerm({ term: 'diffusion model', translation: '扩散模型' }, area);
  await upsertGlossaryTerm({ term: 'ablation', translation: '消融' }, area);
  // 同名更新（大小写不敏感）
  await upsertGlossaryTerm({ term: 'Diffusion Model', translation: '扩散模型（更新）' }, area);

  let items = await loadGlossary(area);
  assert.equal(items.length, 2);
  assert.equal(items.find((it) => it.term === 'Diffusion Model').translation, '扩散模型（更新）');
  assert.ok(Array.isArray(area.store[GLOSSARY_STORAGE_KEY]));

  await removeGlossaryTerm('  diffusion   MODEL ', area);
  items = await loadGlossary(area);
  assert.equal(items.length, 1);
  assert.equal(items[0].term, 'ablation');

  // 无效条目不落库
  await upsertGlossaryTerm({ term: '   ', translation: 'x' }, area);
  assert.equal((await loadGlossary(area)).length, 1);

  await saveGlossary([], area);
  assert.deepEqual(await loadGlossary(area), []);
});

test('loadGlossary degrades to [] on broken storage', async () => {
  assert.deepEqual(await loadGlossary(null), []);
  assert.deepEqual(await loadGlossary({ get: async () => { throw new Error('boom'); } }), []);
});

test('glossaryTermsInText keeps only case-insensitive hits', () => {
  const items = [
    { term: 'attention head', translation: '注意力头' },
    { term: 'KV cache', translation: 'KV 缓存' },
  ];
  const hits = glossaryTermsInText(items, 'Each Attention Head attends separately.');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].term, 'attention head');
  assert.deepEqual(glossaryTermsInText(items, ''), []);
  assert.deepEqual(glossaryTermsInText(undefined, 'text'), []);
});

test('formatGlossaryPrompt emits MUST-follow block, respects limit, empty -> empty string', () => {
  assert.equal(formatGlossaryPrompt([]), '');
  assert.equal(formatGlossaryPrompt(undefined), '');

  const block = formatGlossaryPrompt([
    { term: 'attention head', translation: '注意力头' },
  ]);
  assert.match(block, /## User-locked terminology \(MUST follow\)/);
  assert.match(block, /- attention head => 注意力头/);

  const limited = formatGlossaryPrompt(
    [
      { term: 'old', translation: '旧' },
      { term: 'new', translation: '新' },
    ],
    { limit: 1 },
  );
  assert.doesNotMatch(limited, /- old => 旧/);
  assert.match(limited, /- new => 新/);
});

test('appendGlossaryPrompt appends block or returns base untouched', () => {
  const base = 'You are a translator.';
  assert.equal(appendGlossaryPrompt(base, []), base);
  assert.equal(appendGlossaryPrompt(base, undefined), base);
  const appended = appendGlossaryPrompt(base, [{ term: 'BLEU', translation: 'BLEU 分数' }]);
  assert.ok(appended.startsWith(`${base}\n\n## User-locked terminology`));
  assert.match(appended, /- BLEU => BLEU 分数/);
});

// 回归：锁定术语后已缓存页「永远不按术语翻译」。指纹参与缓存身份，
// 锁定/修改命中术语 → 命中页身份变化重译；未命中页与存量缓存不受影响。
test('glossaryFingerprintForText hits only, order-independent, empty when unmatched', () => {
  const items = [
    { term: 'learning to optimize', translation: '学习优化' },
    { term: 'BLEU', translation: 'BLEU 分数' },
  ];
  const page = 'We study Learning to Optimize (L2O) in this work.';
  const hit = glossaryFingerprintForText(items, page);
  assert.match(hit, /learning to optimize=>学习优化/);
  assert.doesNotMatch(hit, /bleu/);
  // 无命中 / 空表 / 空文本 → ''（与从未用过术语表的历史缓存身份一致）。
  assert.equal(glossaryFingerprintForText(items, 'unrelated text'), '');
  assert.equal(glossaryFingerprintForText([], page), '');
  assert.equal(glossaryFingerprintForText(items, ''), '');
  // 顺序无关；createdAt 无关（重复锁定同译法不作废缓存）。
  const reversed = glossaryFingerprintForText([...items].reverse(), 'learning to optimize BLEU');
  assert.equal(reversed, glossaryFingerprintForText(items, 'learning to optimize BLEU'));
  const restamped = items.map((it) => ({ ...it, createdAt: 999 }));
  assert.equal(
    glossaryFingerprintForText(restamped, page),
    glossaryFingerprintForText(items, page),
  );
  // 改译法 → 指纹变化（这才是需要重译的时刻）。
  const retranslated = [{ term: 'learning to optimize', translation: '优化学习' }];
  assert.notEqual(glossaryFingerprintForText(retranslated, page), hit);
});
