import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROFILE_KEYS,
  activateProviderProfile,
  createProviderProfile,
  deleteProviderProfile,
  duplicateProviderProfile,
  migrateLegacyState,
  renameProviderProfile,
  repairProviderState,
  saveProviderProfile,
  toPublicProfile,
  validateProfile,
} from '../src/lib/provider-profiles.js';

const validProfile = {
  id: 'p1',
  name: 'OpenAI 主账号',
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'secret-key',
  model: 'gpt-4o',
};

const optionsSource = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');
const optionsHtml = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');

function stateWith(...profiles) {
  return {
    config: { targetLang: '简体中文' },
    providerProfiles: profiles,
    activeProfileId: profiles[0]?.id,
  };
}

test('defines exactly the provider fields removed from global config', () => {
  assert.deepEqual(PROFILE_KEYS, ['provider', 'protocol', 'baseUrl', 'apiKey', 'model']);
});

test('migrates a legacy flat config without losing credentials', () => {
  const state = migrateLegacyState({
    config: {
      provider: 'openai',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'secret',
      model: 'gpt-4o',
      targetLang: '简体中文',
    },
  }, () => 'p1');

  assert.deepEqual(state.providerProfiles, [{
    id: 'p1',
    name: '默认配置',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret',
    model: 'gpt-4o',
  }]);
  assert.equal(state.activeProfileId, 'p1');
  assert.equal(state.config.targetLang, '简体中文');
  for (const key of PROFILE_KEYS) assert.equal(key in state.config, false);
});

test('legacy migration is idempotent once profiles exist', () => {
  const existing = stateWith(validProfile);
  const state = migrateLegacyState(existing, () => {
    throw new Error('must not generate another ID');
  });

  assert.deepEqual(state, existing);
  assert.notEqual(state, existing);
});

test('repairs an existing empty profile list without reviving legacy credentials', () => {
  const state = migrateLegacyState({
    config: {
      provider: 'gemini',
      protocol: 'gemini',
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'legacy-secret',
      model: 'legacy-model',
      targetLang: '简体中文',
    },
    providerProfiles: [],
    activeProfileId: 'missing',
  }, () => 'fresh');

  assert.deepEqual(state.providerProfiles, [{
    id: 'fresh',
    name: '默认配置',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
  }]);
  assert.equal(state.activeProfileId, 'fresh');
  assert.equal(state.config.targetLang, '简体中文');
  for (const key of PROFILE_KEYS) assert.equal(key in state.config, false);
});

test('repairs an invalid active ID by selecting the first profile', () => {
  const repaired = repairProviderState({
    ...stateWith(validProfile, { ...validProfile, id: 'p2', name: 'Gemini' }),
    activeProfileId: 'missing',
  }, validProfile, () => 'unused');

  assert.equal(repaired.activeProfileId, 'p1');
});

test('repairs an empty profile list from the fallback profile', () => {
  const fallback = { ...validProfile, id: undefined, apiKey: '' };
  const repaired = repairProviderState({
    config: { targetLang: '简体中文' },
    providerProfiles: [],
    activeProfileId: 'missing',
  }, fallback, () => 'generated');

  assert.deepEqual(repaired.providerProfiles, [{ ...fallback, id: 'generated', name: '默认配置' }]);
  assert.equal(repaired.activeProfileId, 'generated');
});

test('creates a validated profile with an injected stable ID', () => {
  const next = createProviderProfile(stateWith(validProfile), {
    ...validProfile,
    id: 'caller-controlled',
    name: '  Gemini  ',
    provider: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta///',
    model: 'gemini-2.5-flash',
  }, () => 'p2');

  assert.equal(next.providerProfiles.length, 2);
  assert.deepEqual(next.providerProfiles[1], {
    ...validProfile,
    id: 'p2',
    name: 'Gemini',
    provider: 'gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
  });
  assert.equal(next.activeProfileId, 'p1');
});

test('updates an existing profile without changing its ID or siblings', () => {
  const sibling = { ...validProfile, id: 'p2', name: '备用' };
  const original = stateWith(validProfile, sibling);
  const next = saveProviderProfile(original, { ...validProfile, name: '  新名称  ', model: 'gpt-4o-mini' });

  assert.equal(next.providerProfiles[0].id, 'p1');
  assert.equal(next.providerProfiles[0].name, '新名称');
  assert.equal(next.providerProfiles[0].model, 'gpt-4o-mini');
  assert.deepEqual(next.providerProfiles[1], sibling);
  assert.deepEqual(original.providerProfiles[0], validProfile);
});

test('duplicates a profile with a new ID and copy suffix', () => {
  const next = duplicateProviderProfile(stateWith(validProfile), 'p1', () => 'p2');

  assert.deepEqual(next.providerProfiles[1], { ...validProfile, id: 'p2', name: 'OpenAI 主账号 副本' });
  assert.equal(next.activeProfileId, 'p1');
});

test('renames a profile after trimming the new name', () => {
  const next = renameProviderProfile(stateWith(validProfile), 'p1', '  工作配置  ');
  assert.equal(next.providerProfiles[0].name, '工作配置');
});

test('activates only an existing profile', () => {
  const state = stateWith(validProfile, { ...validProfile, id: 'p2', name: '备用' });
  assert.equal(activateProviderProfile(state, 'p2').activeProfileId, 'p2');
  assert.throws(() => activateProviderProfile(state, 'missing'), /不存在/);
  assert.equal(state.activeProfileId, 'p1');
});

test('deleting the active profile deterministically activates the first remaining profile', () => {
  const state = {
    ...stateWith(
      { ...validProfile, id: 'p1' },
      { ...validProfile, id: 'p2', name: '第二个' },
      { ...validProfile, id: 'p3', name: '第三个' },
    ),
    activeProfileId: 'p2',
  };
  const next = deleteProviderProfile(state, 'p2');

  assert.deepEqual(next.providerProfiles.map((profile) => profile.id), ['p1', 'p3']);
  assert.equal(next.activeProfileId, 'p1');
});

test('deleting an inactive profile preserves the active profile', () => {
  const next = deleteProviderProfile(
    stateWith(validProfile, { ...validProfile, id: 'p2', name: '备用' }),
    'p2',
  );
  assert.equal(next.activeProfileId, 'p1');
});

test('protects the last profile and rejects unknown profile IDs', () => {
  assert.throws(() => deleteProviderProfile(stateWith(validProfile), 'p1'), /至少保留一个/);
  assert.throws(() => deleteProviderProfile(
    stateWith(validProfile, { ...validProfile, id: 'p2', name: '备用' }),
    'missing',
  ), /不存在/);
  assert.throws(() => duplicateProviderProfile(stateWith(validProfile), 'missing', () => 'p2'), /不存在/);
  assert.throws(() => renameProviderProfile(stateWith(validProfile), 'missing', '名称'), /不存在/);
});

test('validates required profile fields and protocol', () => {
  assert.throws(() => validateProfile({ ...validProfile, name: ' ' }), /名称.*API Key.*模型/);
  assert.throws(() => validateProfile({ ...validProfile, apiKey: ' ' }), /名称.*API Key.*模型/);
  assert.throws(() => validateProfile({ ...validProfile, model: ' ' }), /名称.*API Key.*模型/);
  assert.throws(() => validateProfile({ ...validProfile, protocol: 'other' }), /协议/);
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: '' }), /Base URL/);
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'not a URL' }), /Base URL/);
});

test('allows HTTPS and local HTTP but rejects public HTTP', () => {
  assert.equal(validateProfile(validProfile).baseUrl, validProfile.baseUrl);
  for (const baseUrl of [
    'http://localhost:11434/v1/',
    'http://127.0.0.1:11434/v1/',
    'http://[::1]:11434/v1/',
  ]) {
    assert.equal(validateProfile({ ...validProfile, baseUrl }).baseUrl, baseUrl.replace(/\/+$/, ''));
  }
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'http://example.com/v1' }), /HTTPS/);
});

test('normalizes only trailing pathname slashes without mutating query values', () => {
  const baseUrl = 'https://example.com/v1/?redirect=https://other.test/';
  assert.equal(
    validateProfile({ ...validProfile, baseUrl }).baseUrl,
    'https://example.com/v1?redirect=https://other.test/',
  );
});

test('rejects credentials embedded in a Base URL', () => {
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'https://user:pass@example.com/v1' }), /凭据/);
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'https://example.com/v1?token=x' }), /敏感参数/);
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'https://example.com/v1#key' }), /fragment/);
  assert.throws(() => validateProfile({ ...validProfile, baseUrl: 'https://example.com/v1#' }), /fragment/);
});

test('rejects canonical API key query parameter variants', () => {
  for (const key of ['apikey', 'api-key', 'x-api-key']) {
    assert.throws(
      () => validateProfile({ ...validProfile, baseUrl: `https://example.com/v1?${key}=secret` }),
      /敏感参数/,
    );
  }
});

test('public profile summaries redact credentials and expose only a suffix', () => {
  const summary = toPublicProfile(validProfile);
  assert.deepEqual(summary, {
    id: 'p1',
    name: 'OpenAI 主账号',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    hasApiKey: true,
    keySuffix: 'ey',
  });
  assert.equal('apiKey' in summary, false);
  assert.deepEqual(toPublicProfile({ ...validProfile, apiKey: '' }), {
    ...summary,
    hasApiKey: false,
    keySuffix: '',
  });
});

test('settings page exposes the complete Profile management contract', () => {
  assert.match(optionsSource, /import\s*\{[^}]*loadProviderState[^}]*\}\s*from\s*['"]\.\.\/lib\/config\.js['"]/s);
  for (const api of [
    'createProviderProfile',
    'saveProviderProfile',
    'duplicateProviderProfile',
    'renameProviderProfile',
    'deleteProviderProfile',
    'activateProviderProfile',
  ]) {
    assert.match(optionsSource, new RegExp(`\\b${api}\\b`));
  }
  for (const handler of [
    'createProfile',
    'duplicateProfile',
    'renameProfile',
    'deleteProfile',
    'activateProfile',
  ]) {
    assert.match(optionsSource, new RegExp(`function\\s+${handler}\\s*\\(`));
  }
  assert.match(optionsSource, /function\s+isDirty\s*\(/);
  assert.match(optionsSource, /function\s+confirmDiscard\s*\(/);
  assert.match(optionsSource, /function\s+showNewProfileDraft\s*\([^)]*\)[\s\S]*?draftIsUnsaved\s*=\s*true/);
  assert.match(optionsSource, /async\s+function\s+activateProfile\s*\(\)\s*\{\s*if\s*\(isDirty\(\)\)/);
  assert.match(optionsSource, /beforeunload/);
  assert.match(optionsSource, /function\s+setSaveLocked\s*\(/);
  assert.match(optionsSource, /saveGeneration/);
  assert.match(optionsSource, /testGeneration/);
  assert.match(optionsSource, /selfTestGeneration/);
  assert.match(optionsSource, /new\s+AbortController\s*\(/);
  assert.match(optionsSource, /function\s+validateSelfTestForm\s*\(/);
  assert.match(optionsSource, /function\s+resetApiKeyVisibility\s*\(/);
  assert.match(optionsSource, /function\s+clearConnectionTestState\s*\(/);
  assert.match(optionsSource, /function\s+invalidateConnectionTests\s*\([^)]*\)[\s\S]*?clearConnectionTestState\s*\(\)/);
  assert.match(optionsHtml, /id=["']profile-select["']/);
  assert.match(optionsHtml, /id=["']profile-active["']/);
  assert.match(optionsHtml, /id=["']api-key-local-warning["']/);
  assert.match(optionsHtml, /id=["']selftest-out["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/);
  for (const id of ['profile-result', 'test-result', 'copy-diag-result', 'save-result', 'probe-obsidian-result']) {
    assert.match(optionsHtml, new RegExp(`id=["']${id}["'][^>]*(?:role=["']status["'][^>]*aria-live=["']polite["']|aria-live=["']polite["'][^>]*role=["']status["'])`));
  }
});

test('settings diagnostics keep overrides unsaved and use shared secret redaction', () => {
  assert.match(optionsSource, /import\s*\{[^}]*maskApiKey[^}]*redactSecrets[^}]*\}\s*from\s*['"]\.\.\/lib\/secrets\.js['"]/s);
  assert.match(optionsSource, /sendMessage\(\{\s*type:\s*['"]testConnection['"],\s*override\s*\}/);
  assert.match(optionsSource, /['"]x-goog-api-key['"]\s*:/);
  assert.doesNotMatch(optionsSource, /generateContent\?key=/);
  assert.match(optionsSource, /redactSecrets\s*\(/);
  assert.match(optionsSource, /maskApiKey\s*\(/);
});
