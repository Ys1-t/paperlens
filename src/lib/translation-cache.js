import { TRANSLATION_PIPELINE_VERSION } from './build-info.js';

export function buildTranslationCacheIdentity(config, payload) {
  const base = [
    TRANSLATION_PIPELINE_VERSION,
    config.protocol || '',
    config.baseUrl || '',
    config.model || '',
    config.targetLang || '',
    config.systemPrompt || '',
    payload || '',
  ].join('|');
  // 术语指纹（见 glossary.js glossaryFingerprintForText）：只有命中本页原文的
  // 术语参与身份。空指纹保持与历史身份逐字节一致——存量缓存不作废；
  // 锁定/修改命中术语 → 该页身份变化 → 自然绕过旧缓存重译。
  const glossary = String(config.glossaryFingerprint || '');
  return glossary ? `${base}|G:${glossary}` : base;
}

export function isCacheableTranslation(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
