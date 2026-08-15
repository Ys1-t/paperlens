import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAPER_PACK_FORMAT,
  base64ToBytes,
  buildPaperPack,
  bytesToBase64,
  isPaperPackFilename,
  paperPackFilename,
  parsePaperPack,
} from '../src/lib/paper-pack.js';

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3]);

test('base64 roundtrip preserves binary bytes including >0x7f', () => {
  const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff, 0x25, 0x50]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
});

test('paper pack roundtrip keeps translations, metadata and pdf bytes', () => {
  const json = buildPaperPack({
    title: 'Efficient Pareto Manifold Learning.pdf',
    targetLang: '简体中文',
    totalPages: 20,
    pages: [
      { page: 1, markdown: '# 摘要\n本文提出…' },
      { page: 5, markdown: '### 算法 1\n```algorithm\n1: Begin\n```' },
      { page: 99, markdown: '越界页应被丢弃' },
      { page: 3, markdown: '   ' }, // 空译文丢弃
    ],
    pdfBytes: PDF_BYTES,
  });
  const pack = parsePaperPack(json);
  assert.equal(pack.totalPages, 20);
  assert.equal(pack.translatedCount, 2);
  assert.equal(pack.translations['1'], '# 摘要\n本文提出…');
  assert.match(pack.translations['5'], /algorithm/);
  assert.equal(pack.translations['99'], undefined);
  assert.deepEqual([...pack.pdfBytes], [...PDF_BYTES]);
  assert.equal(pack.targetLang, '简体中文');
});

test('build rejects missing pdf bytes and zero translated pages', () => {
  assert.throws(() => buildPaperPack({ totalPages: 3, pages: [{ page: 1, markdown: 'x' }] }), /PDF 原始字节/);
  assert.throws(
    () => buildPaperPack({ totalPages: 3, pages: [], pdfBytes: PDF_BYTES }),
    /没有已完成的译文页/,
  );
});

test('parse rejects wrong format, corrupt json, bad pdf magic', () => {
  assert.throws(() => parsePaperPack(''), /为空/);
  assert.throws(() => parsePaperPack('{not json'), /JSON 解析失败/);
  assert.throws(() => parsePaperPack('{"format":"other-v9"}'), /不受支持|不是 PaperLens/);
  const noMagic = JSON.stringify({
    format: PAPER_PACK_FORMAT,
    totalPages: 2,
    translations: { 1: 'x' },
    pdf: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
  });
  assert.throws(() => parsePaperPack(noMagic), /PDF 数据无效/);
  const badB64 = JSON.stringify({
    format: PAPER_PACK_FORMAT, totalPages: 2, translations: {}, pdf: '@@@not-base64@@@',
  });
  assert.throws(() => parsePaperPack(badB64), /损坏/);
});

test('filenames: export name is sanitized, import filter accepts json', () => {
  assert.equal(paperPackFilename('A/B: paper?.pdf'), 'A B paper.paperlens.json');
  assert.equal(paperPackFilename(''), 'paper.paperlens.json');
  assert.equal(isPaperPackFilename('x.paperlens.json'), true);
  assert.equal(isPaperPackFilename('x.json'), true);
  assert.equal(isPaperPackFilename('x.pdf'), false);
});

// 一键传手机（phone-drop）：纯函数部分。
test('phone drop hint guides setup and shows the chosen folder', async () => {
  const { phoneDropHint, phoneDropSupported } = await import('../src/lib/phone-drop.js');
  assert.match(phoneDropHint(''), /iCloud|OneDrive|同步文件夹/);
  assert.match(phoneDropHint('PaperLens 手机'), /PaperLens 手机/);
  // Node 环境没有 showDirectoryPicker：支持检测应返回 false 而不是抛错。
  assert.equal(phoneDropSupported(), false);
});

// 术语表随包携带：手机端按同一术语表翻译未译页，双端译法一致。
test('paper pack carries the locked glossary and drops malformed entries', () => {
  const json = buildPaperPack({
    totalPages: 4,
    pages: [{ page: 1, markdown: '译文' }],
    pdfBytes: PDF_BYTES,
    glossary: [
      { term: 'learning to optimize', translation: '学习优化' },
      { term: '', translation: '空术语丢弃' },
      { term: '无译法丢弃', translation: '' },
      null,
    ],
  });
  const pack = parsePaperPack(json);
  assert.equal(pack.glossary.length, 1);
  assert.deepEqual(pack.glossary[0], { term: 'learning to optimize', translation: '学习优化' });
  // 不带术语表的旧包：glossary 解析为 []，不报错。
  const legacy = buildPaperPack({ totalPages: 2, pages: [{ page: 1, markdown: 'x' }], pdfBytes: PDF_BYTES });
  assert.deepEqual(parsePaperPack(legacy).glossary, []);
});
