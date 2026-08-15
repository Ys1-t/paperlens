// 全局术语表：用户「锁定」的 术语 → 译法，注入整页视觉翻译与划词翻译提示，
// 保证同一论文乃至跨论文的术语一致性（研究生刚需：method 名、专有名词不乱翻）。
// 存 chrome.storage.local（viewer / options / background 三端共享）。
// 锁定的术语只影响**新发起**的翻译；已缓存页面重新翻译后生效（缓存键不含术语表，
// 避免每次改术语导致整本重译花钱）。

export const GLOSSARY_STORAGE_KEY = 'paperlens.glossary.v1';
export const GLOSSARY_MAX_TERMS = 200;
/** 每次注入提示词的术语上限（防止 system prompt 膨胀）。 */
export const GLOSSARY_PROMPT_LIMIT = 60;

function defaultArea() {
  return globalThis.chrome?.storage?.local || null;
}

/** 规范化一条术语；无效返回 null。 */
export function normalizeGlossaryItem(item) {
  if (!item || typeof item !== 'object') return null;
  const term = String(item.term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const translation = String(item.translation || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!term || !translation) return null;
  return {
    term,
    translation,
    createdAt: Number(item.createdAt) || Date.now(),
  };
}

/** 规范化整表：去重（按 term 小写），后写覆盖先写，容量截断。 */
export function normalizeGlossary(list) {
  const byKey = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeGlossaryItem(raw);
    if (!item) continue;
    byKey.set(item.term.toLowerCase(), item);
  }
  return [...byKey.values()].slice(-GLOSSARY_MAX_TERMS);
}

export async function loadGlossary(area = defaultArea()) {
  try {
    const stored = await area?.get?.(GLOSSARY_STORAGE_KEY);
    return normalizeGlossary(stored?.[GLOSSARY_STORAGE_KEY]);
  } catch {
    return [];
  }
}

export async function saveGlossary(items, area = defaultArea()) {
  const normalized = normalizeGlossary(items);
  try {
    await area?.set?.({ [GLOSSARY_STORAGE_KEY]: normalized });
  } catch { /* quota / detached */ }
  return normalized;
}

/** 新增或更新一条术语（term 大小写不敏感去重）。 */
export async function upsertGlossaryTerm({ term, translation } = {}, area = defaultArea()) {
  const item = normalizeGlossaryItem({ term, translation });
  if (!item) return loadGlossary(area);
  const current = await loadGlossary(area);
  const rest = current.filter((it) => it.term.toLowerCase() !== item.term.toLowerCase());
  rest.push(item);
  return saveGlossary(rest, area);
}

export async function removeGlossaryTerm(term, area = defaultArea()) {
  const key = String(term || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const current = await loadGlossary(area);
  return saveGlossary(current.filter((it) => it.term.toLowerCase() !== key), area);
}

/** 只保留出现在给定文本中的术语（划词翻译用，避免整表注入）。 */
export function glossaryTermsInText(items, text) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return [];
  return (Array.isArray(items) ? items : []).filter(
    (it) => it?.term && hay.includes(String(it.term).toLowerCase()),
  );
}

/**
 * 页面级术语指纹：只由「命中该页原文」的术语构成，参与译文缓存身份。
 * - 锁定/修改某术语 → 只有原文含该词的页缓存失效重译，其余页零成本保留。
 * - 无命中 → 返回 ''，与「从未用过术语表」的历史缓存键完全一致（存量缓存不作废）。
 * - 指纹与顺序无关（排序后拼接），与 createdAt 无关（改译法才失效，重复锁定同译法不失效）。
 */
export function glossaryFingerprintForText(items, text) {
  const hits = glossaryTermsInText(items, text);
  if (!hits.length) return '';
  return hits
    .map((it) => `${String(it.term).toLowerCase()}=>${it.translation}`)
    .sort()
    .join('');
}

/**
 * 生成注入 system prompt 的术语表块；空表返回 ''。
 * 最新锁定的术语优先保留。
 */
export function formatGlossaryPrompt(items, { limit = GLOSSARY_PROMPT_LIMIT } = {}) {
  const list = normalizeGlossary(items).slice(-Math.max(1, limit));
  if (!list.length) return '';
  const lines = list.map((it) => `- ${it.term} => ${it.translation}`);
  return [
    '## User-locked terminology (MUST follow)',
    'Whenever a source term below (case-insensitive, including plural/inflected forms) appears, translate it EXACTLY as the given target text. Never invent an alternative translation for these terms:',
    ...lines,
  ].join('\n');
}

/** 附加到任意 system prompt 末尾；无术语时原样返回。 */
export function appendGlossaryPrompt(basePrompt, items, opts) {
  const block = formatGlossaryPrompt(items, opts);
  if (!block) return basePrompt;
  return `${basePrompt}\n\n${block}`;
}
