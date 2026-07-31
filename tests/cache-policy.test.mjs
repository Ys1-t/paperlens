import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranslationCacheIdentity,
  isCacheableTranslation,
} from '../src/lib/translation-cache.js';
import { TRANSLATION_PIPELINE_VERSION } from '../src/lib/build-info.js';

test('translation cache identity is namespaced by the reading pipeline build', () => {
  assert.match(
    buildTranslationCacheIdentity({}, 'hello'),
    new RegExp(`^${TRANSLATION_PIPELINE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|`),
  );
});

test('translation cache identity includes the selected Base URL', () => {
  const config = {
    protocol: 'openai',
    baseUrl: 'https://api-a.example/v1',
    model: 'model-x',
    targetLang: '简体中文',
    systemPrompt: '',
  };
  assert.notEqual(
    buildTranslationCacheIdentity(config, 'MD:hello'),
    buildTranslationCacheIdentity({ ...config, baseUrl: 'https://api-b.example/v1' }, 'MD:hello'),
  );
});

test('translation cache identity ignores credentials and Profile metadata', () => {
  const config = {
    protocol: 'openai',
    baseUrl: 'https://api.example/v1',
    model: 'model-x',
    targetLang: '简体中文',
    systemPrompt: '',
    apiKey: 'secret-one',
    profileName: 'Primary',
    activeProfileId: 'p1',
  };

  assert.equal(
    buildTranslationCacheIdentity(config, 'MD:hello'),
    buildTranslationCacheIdentity({
      ...config,
      apiKey: 'secret-two',
      profileName: 'Renamed',
      activeProfileId: 'p2',
    }, 'MD:hello'),
  );
});

test('empty model responses are never cacheable', () => {
  assert.equal(isCacheableTranslation(''), false);
  assert.equal(isCacheableTranslation('   \n'), false);
  assert.equal(isCacheableTranslation('有效译文'), true);
});
