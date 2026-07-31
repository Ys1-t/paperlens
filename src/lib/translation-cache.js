import { TRANSLATION_PIPELINE_VERSION } from './build-info.js';

export function buildTranslationCacheIdentity(config, payload) {
  return [
    TRANSLATION_PIPELINE_VERSION,
    config.protocol || '',
    config.baseUrl || '',
    config.model || '',
    config.targetLang || '',
    config.systemPrompt || '',
    payload || '',
  ].join('|');
}

export function isCacheableTranslation(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
