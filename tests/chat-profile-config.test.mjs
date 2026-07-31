import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_CONFIG, resolveChatProfile } from '../src/lib/config.js';

function sampleState(overrides = {}) {
  const translate = {
    id: 'p-translate',
    name: '翻译用',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-translate',
    model: 'gpt-4o-mini',
  };
  const chat = {
    id: 'p-chat',
    name: '对话强模型',
    provider: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-chat',
    model: 'gpt-4o',
  };
  return {
    config: { ...DEFAULT_CONFIG, chatProfileId: '', ...overrides.config },
    providerProfiles: [translate, chat],
    activeProfileId: 'p-translate',
    ...overrides,
  };
}

test('chatProfileId defaults to empty (same as translation profile)', () => {
  assert.equal(DEFAULT_CONFIG.chatProfileId, '');
});

test('resolveChatProfile falls back to translation active profile when unset', () => {
  const resolved = resolveChatProfile(sampleState());
  assert.equal(resolved.profile.id, 'p-translate');
  assert.equal(resolved.usesTranslationProfile, true);
  assert.equal(resolved.chatProfileId, '');
});

test('resolveChatProfile selects a dedicated chat profile when configured', () => {
  const resolved = resolveChatProfile(sampleState({
    config: { chatProfileId: 'p-chat' },
  }));
  assert.equal(resolved.profile.id, 'p-chat');
  assert.equal(resolved.profile.model, 'gpt-4o');
  assert.equal(resolved.usesTranslationProfile, false);
  assert.equal(resolved.chatProfileId, 'p-chat');
});

test('resolveChatProfile ignores missing chatProfileId and falls back', () => {
  const resolved = resolveChatProfile(sampleState({
    config: { chatProfileId: 'does-not-exist' },
  }));
  assert.equal(resolved.profile.id, 'p-translate');
  assert.equal(resolved.usesTranslationProfile, true);
});

test('options and service worker wire chatProfileId / loadChatConfig', () => {
  const optionsHtml = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
  const optionsJs = readFileSync(new URL('../src/options/options.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../src/lib/config.js', import.meta.url), 'utf8');
  const chatPanel = readFileSync(new URL('../src/viewer/chat-panel.js', import.meta.url), 'utf8');

  assert.match(optionsHtml, /id="chatProfileId"/);
  assert.match(optionsJs, /chatProfileId/);
  assert.match(optionsJs, /renderChatProfileSelect/);
  assert.match(config, /export async function loadChatConfig/);
  assert.match(config, /export function resolveChatProfile/);
  assert.match(sw, /loadChatConfig/);
  assert.match(chatPanel, /refreshModelLabel/);
  assert.match(chatPanel, /chatProfile/);
});
