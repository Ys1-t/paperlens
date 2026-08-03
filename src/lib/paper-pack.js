// 论文包（paper pack）：桌面扩展导出「PDF 原文件 + 已译页 Markdown」为单个
// JSON 文件，手机 PWA / App 打开后已译页直接显示，不再花一分钱重译。
// 纯 JS 共享库：扩展 viewer 与 app/ 双端复用；Node 可测。
//
// 设计要点：
// - PDF 原始字节内嵌（base64）：手机端单文件打开即完整可读（含“看原版”），
//   不需要再单独传一份 PDF。体积 ≈ PDF × 1.34 + 译文，微信/网盘均可传。
// - 译文按页号存 Markdown 纯文本，与渲染管线解耦；导入端直接走现有渲染。
// - 版本字段严格校验：未来格式演进时旧端能给出可读错误而不是静默坏页。

export const PAPER_PACK_FORMAT = 'paperlens-pack-v1';
/** 解析入口的字符串上限（512MB），防止误选超大文件把页面撑爆。 */
export const PAPER_PACK_MAX_JSON_CHARS = 512 * 1024 * 1024;

const BASE64_CHUNK = 0x8000;

/** Uint8Array -> base64（分块避免 String.fromCharCode 栈溢出）。 */
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  let binary = '';
  for (let i = 0; i < view.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/** base64 -> Uint8Array；非法输入抛错。 */
export function base64ToBytes(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 导出文件名：<标题>.paperlens.json（去掉 .pdf 后缀与非法字符）。 */
export function paperPackFilename(title) {
  const base = String(title || 'paper')
    .replace(/\.pdf$/iu, '')
    .replace(/[\\/:*?"<>|]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60) || 'paper';
  return `${base}.paperlens.json`;
}

/** 文件名是否像论文包（手机端文件选择分流用；内容仍以 parse 校验为准）。 */
export function isPaperPackFilename(name) {
  return /\.paperlens\.json$/iu.test(String(name || ''))
    || /\.json$/iu.test(String(name || ''));
}

/**
 * 组装论文包 JSON 字符串。
 * pages: [{page:number, markdown:string}]；空译文页自动跳过。
 * pdfBytes: Uint8Array（PDF 原始字节）。
 */
export function buildPaperPack({
  title = '',
  targetLang = '',
  totalPages = 0,
  pages = [],
  pdfBytes = null,
  glossary = [],
} = {}) {
  if (!(pdfBytes instanceof Uint8Array) || !pdfBytes.length) {
    throw new Error('论文包需要 PDF 原始字节');
  }
  const total = Math.max(1, Math.round(Number(totalPages) || 0));
  const translations = {};
  let translatedCount = 0;
  for (const item of Array.isArray(pages) ? pages : []) {
    const page = Math.round(Number(item?.page));
    const markdown = String(item?.markdown || '').trim();
    if (!Number.isFinite(page) || page < 1 || page > total || !markdown) continue;
    translations[String(page)] = markdown;
    translatedCount += 1;
  }
  if (!translatedCount) throw new Error('还没有已完成的译文页可导出');
  // 术语表随包携带：手机端按同一术语表翻译未译页，保证双端译法一致。
  const packGlossary = (Array.isArray(glossary) ? glossary : [])
    .map((it) => ({ term: String(it?.term || '').trim(), translation: String(it?.translation || '').trim() }))
    .filter((it) => it.term && it.translation)
    .slice(0, 200);
  return JSON.stringify({
    format: PAPER_PACK_FORMAT,
    title: String(title || '').slice(0, 200),
    targetLang: String(targetLang || '').slice(0, 40),
    totalPages: total,
    translatedCount,
    translations,
    ...(packGlossary.length ? { glossary: packGlossary } : {}),
    pdf: bytesToBase64(pdfBytes),
  });
}

/**
 * 解析并校验论文包。返回 { title, targetLang, totalPages, translatedCount,
 * translations: {页号字符串: markdown}, pdfBytes: Uint8Array }。
 * 任何不符合格式的输入都抛出带中文说明的 Error。
 */
export function parsePaperPack(jsonText) {
  const text = String(jsonText || '');
  if (!text.trim()) throw new Error('论文包内容为空');
  if (text.length > PAPER_PACK_MAX_JSON_CHARS) throw new Error('论文包过大，无法解析');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是有效的论文包文件（JSON 解析失败）');
  }
  if (data?.format !== PAPER_PACK_FORMAT) {
    throw new Error('不是 PaperLens 论文包，或包版本不受支持');
  }
  const totalPages = Math.max(1, Math.round(Number(data.totalPages) || 0));
  const translations = {};
  let translatedCount = 0;
  const rawTranslations = data.translations && typeof data.translations === 'object' ? data.translations : {};
  for (const [key, value] of Object.entries(rawTranslations)) {
    const page = Math.round(Number(key));
    const markdown = String(value || '').trim();
    if (!Number.isFinite(page) || page < 1 || page > totalPages || !markdown) continue;
    translations[String(page)] = markdown;
    translatedCount += 1;
  }
  let pdfBytes;
  try {
    pdfBytes = base64ToBytes(data.pdf);
  } catch {
    throw new Error('论文包内的 PDF 数据损坏');
  }
  if (!pdfBytes.length) throw new Error('论文包缺少 PDF 数据');
  // %PDF- 魔数校验：拦住内容被改坏/截断的包。
  if (!(pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50 && pdfBytes[2] === 0x44 && pdfBytes[3] === 0x46)) {
    throw new Error('论文包内的 PDF 数据无效');
  }
  const glossary = (Array.isArray(data.glossary) ? data.glossary : [])
    .map((it) => ({ term: String(it?.term || '').trim(), translation: String(it?.translation || '').trim() }))
    .filter((it) => it.term && it.translation)
    .slice(0, 200);
  return {
    title: String(data.title || '').slice(0, 200),
    targetLang: String(data.targetLang || '').slice(0, 40),
    totalPages,
    translatedCount,
    translations,
    glossary,
    pdfBytes,
  };
}
