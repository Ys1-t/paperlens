import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateProviderProfile,
  createProviderProfile,
  deleteProviderProfile,
  duplicateProviderProfile,
  loadConfig,
  loadProviderState,
  loadPublicConfig,
  renameProviderProfile,
  saveConfig,
  saveProviderProfile,
} from '../src/lib/config.js';

const legacyConfig = {
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'legacy-secret',
  model: 'gpt-4o',
  targetLang: '简体中文',
  concurrency: '6',
};

const primaryProfile = {
  id: 'p1',
  name: 'OpenAI 主账号',
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'secret-one',
  model: 'gpt-4o',
};

const secondaryProfile = {
  id: 'p2',
  name: 'Gemini 备用',
  provider: 'gemini',
  protocol: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: 'secret-two',
  model: 'gemini-2.5-flash',
};

let storageData;
let storageWrites;
let delayedGet;

function installChromeStorage(initialState) {
  storageData = structuredClone(initialState);
  storageWrites = [];
  delayedGet = null;
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const snapshot = structuredClone(storageData);
          const gate = delayedGet;
          delayedGet = null;
          if (gate) await gate.promise;
          if (keys == null) return snapshot;
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested
            .filter((key) => Object.hasOwn(snapshot, key))
            .map((key) => [key, structuredClone(snapshot[key])]));
        },
        async set(patch) {
          const cloned = structuredClone(patch);
          storageWrites.push(cloned);
          Object.assign(storageData, cloned);
        },
      },
    },
  };
}

function delayNextStorageGet() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  delayedGet = { promise };
  return release;
}

function installFakeWebLocks() {
  const tails = new Map();
  const locks = {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const result = previous.then(() => callback({ name }));
      tails.set(name, result.catch(() => undefined));
      return result;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks },
  });
}

async function importConfigContext(label) {
  const url = new URL('../src/lib/config.js', import.meta.url);
  url.searchParams.set('context', `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function allowInterleaving() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installProfileState(overrides = {}) {
  installChromeStorage({
    config: { targetLang: '简体中文', concurrency: 4 },
    providerProfiles: [primaryProfile, secondaryProfile],
    activeProfileId: 'p1',
    ...overrides,
  });
}

test('loadConfig atomically migrates legacy state and returns a flat runtime config', async () => {
  installChromeStorage({ config: legacyConfig });

  const cfg = await loadConfig();

  assert.equal(cfg.apiKey, legacyConfig.apiKey);
  assert.equal(cfg.model, legacyConfig.model);
  assert.equal(cfg.targetLang, legacyConfig.targetLang);
  assert.equal(cfg.concurrency, 6);
  assert.equal(cfg.profileName, '默认配置');
  assert.equal(storageWrites.length, 1);
  assert.equal(storageWrites[0].providerProfiles.length, 1);
  assert.equal(storageWrites[0].activeProfileId, storageWrites[0].providerProfiles[0].id);
  assert.equal(storageWrites[0].providerProfiles[0].apiKey, legacyConfig.apiKey);
  assert.equal('apiKey' in storageWrites[0].config, false);
  assert.deepEqual(Object.keys(storageWrites[0]).sort(), [
    'activeProfileId',
    'config',
    'providerProfiles',
  ]);
});

test('loadProviderState repairs invalid stored state with one atomic write', async () => {
  installProfileState({
    config: { ...legacyConfig, targetLang: 'English' },
    activeProfileId: 'missing',
  });

  const state = await loadProviderState();

  assert.equal(state.activeProfileId, 'p1');
  assert.equal(state.config.targetLang, 'English');
  assert.equal('apiKey' in state.config, false);
  assert.equal(storageWrites.length, 1);
  assert.deepEqual(storageWrites[0], state);
});

test('loadProviderState does not rewrite an already canonical state', async () => {
  installProfileState();

  const state = await loadProviderState();

  assert.equal(state.activeProfileId, 'p1');
  assert.equal(state.providerProfiles.length, 2);
  assert.equal(storageWrites.length, 0);
});

test('loadPublicConfig never returns apiKey and redacts every profile', async () => {
  installProfileState();

  const cfg = await loadPublicConfig();

  assert.equal('apiKey' in cfg, false);
  assert.equal(cfg.hasApiKey, true);
  assert.equal(cfg.keySuffix, 'ne');
  assert.equal(cfg.activeProfileId, 'p1');
  assert.equal(cfg.profiles.length, 2);
  assert.equal(cfg.profiles.every((profile) => !('apiKey' in profile)), true);
  assert.deepEqual(cfg.profiles.map((profile) => profile.keySuffix), ['ne', 'wo']);
});

test('saveConfig routes provider fields to the active profile and global fields to config', async () => {
  installProfileState();

  const cfg = await saveConfig({
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1/',
    targetLang: 'English',
    concurrency: '7',
    profileName: 'must not persist globally',
    activeProfileId: 'p2',
  });

  assert.equal(cfg.model, 'gpt-4o-mini');
  assert.equal(cfg.baseUrl, 'https://api.openai.com/v1');
  assert.equal(cfg.targetLang, 'English');
  assert.equal(cfg.concurrency, 7);
  assert.equal(cfg.activeProfileId, 'p1');
  assert.equal(storageWrites.length, 1);
  assert.equal(storageWrites[0].providerProfiles[0].model, 'gpt-4o-mini');
  assert.equal(storageWrites[0].providerProfiles[1].model, secondaryProfile.model);
  assert.equal(storageWrites[0].config.targetLang, 'English');
  assert.equal(storageWrites[0].config.concurrency, 7);
  assert.equal('model' in storageWrites[0].config, false);
  assert.equal('profileName' in storageWrites[0].config, false);
  assert.equal('activeProfileId' in storageWrites[0].config, false);
});

test('saveConfig combines legacy migration and the requested update in one atomic write', async () => {
  installChromeStorage({ config: legacyConfig });

  const cfg = await saveConfig({ model: 'gpt-4o-mini', targetLang: 'English' });

  assert.equal(cfg.model, 'gpt-4o-mini');
  assert.equal(cfg.apiKey, legacyConfig.apiKey);
  assert.equal(cfg.targetLang, 'English');
  assert.equal(storageWrites.length, 1);
  assert.equal(storageWrites[0].providerProfiles[0].model, 'gpt-4o-mini');
  assert.equal(storageWrites[0].providerProfiles[0].apiKey, legacyConfig.apiKey);
  assert.equal(storageWrites[0].config.targetLang, 'English');
});

test('legacy automatic PDF interception cannot be restored through config', async () => {
  installProfileState({
    config: { targetLang: '简体中文', concurrency: 4, autoIntercept: true },
  });

  const loaded = await loadConfig();
  assert.equal(Object.hasOwn(loaded, 'autoIntercept'), false);

  const saved = await saveConfig({ autoIntercept: true });
  assert.equal(Object.hasOwn(saved, 'autoIntercept'), false);
  assert.equal(Object.hasOwn(storageData.config, 'autoIntercept'), false);
});

test('CRUD combines state repair and the requested transition in one atomic write', async () => {
  installProfileState({ activeProfileId: 'missing' });

  const state = await activateProviderProfile('p2');

  assert.equal(state.activeProfileId, 'p2');
  assert.equal(storageWrites.length, 1);
  assert.deepEqual(storageWrites[0], state);
});

test('saveProviderProfile creates a validated profile when no ID is supplied', async () => {
  installProfileState({ providerProfiles: [primaryProfile], activeProfileId: 'p1' });
  const { id: _ignored, ...profileWithoutId } = secondaryProfile;

  const state = await saveProviderProfile(profileWithoutId);

  assert.equal(state.providerProfiles.length, 2);
  assert.equal(state.providerProfiles[1].name, secondaryProfile.name);
  assert.equal(state.providerProfiles[1].model, secondaryProfile.model);
  assert.equal(typeof state.providerProfiles[1].id, 'string');
  assert.notEqual(state.providerProfiles[1].id, '');
  assert.equal(storageWrites.length, 1);
  assert.deepEqual(storageWrites[0], state);
});

test('activateProviderProfile writes only activeProfileId for canonical state', async () => {
  installProfileState();

  const state = await activateProviderProfile('p2');

  assert.equal(state.activeProfileId, 'p2');
  assert.equal(storageWrites.length, 1);
  assert.deepEqual(storageWrites[0], { activeProfileId: 'p2' });
});

test('concurrent saveConfig patches are serialized so both updates survive', async () => {
  installProfileState();
  const releaseFirstRead = delayNextStorageGet();

  const languageSave = saveConfig({ targetLang: 'English' });
  const concurrencySave = saveConfig({ concurrency: 9 });
  await allowInterleaving();
  releaseFirstRead();
  await Promise.all([languageSave, concurrencySave]);

  assert.equal(storageData.config.targetLang, 'English');
  assert.equal(storageData.config.concurrency, 9);
});

test('concurrent saveConfig and activation preserve the selected profile', async () => {
  installProfileState();
  const releaseFirstRead = delayNextStorageGet();

  const configSave = saveConfig({ targetLang: 'English' });
  const activation = activateProviderProfile('p2');
  await allowInterleaving();
  releaseFirstRead();
  await Promise.all([configSave, activation]);

  assert.equal(storageData.config.targetLang, 'English');
  assert.equal(storageData.activeProfileId, 'p2');
});

test('Web Lock serializes concurrent saves from separate module contexts', async () => {
  installProfileState();
  installFakeWebLocks();
  const [contextA, contextB] = await Promise.all([
    importConfigContext('save-a'),
    importConfigContext('save-b'),
  ]);
  const releaseFirstRead = delayNextStorageGet();

  const languageSave = contextA.saveConfig({ targetLang: 'English' });
  const concurrencySave = contextB.saveConfig({ concurrency: 9 });
  await allowInterleaving();
  releaseFirstRead();
  await Promise.all([languageSave, concurrencySave]);

  assert.equal(storageData.config.targetLang, 'English');
  assert.equal(storageData.config.concurrency, 9);
});

test('Web Lock preserves activation across save from separate module contexts', async () => {
  installProfileState();
  installFakeWebLocks();
  const [contextA, contextB] = await Promise.all([
    importConfigContext('config-a'),
    importConfigContext('activate-b'),
  ]);
  const releaseFirstRead = delayNextStorageGet();

  const configSave = contextA.saveConfig({ targetLang: 'English' });
  const activation = contextB.activateProviderProfile('p2');
  await allowInterleaving();
  releaseFirstRead();
  await Promise.all([configSave, activation]);

  assert.equal(storageData.config.targetLang, 'English');
  assert.equal(storageData.activeProfileId, 'p2');
});

test('mutation queue recovers after a rejected transition', async () => {
  installProfileState();

  await assert.rejects(
    saveProviderProfile({ ...primaryProfile, id: 'missing' }),
    /不存在/,
  );
  const state = await activateProviderProfile('p2');

  assert.equal(state.activeProfileId, 'p2');
  assert.deepEqual(storageWrites, [{ activeProfileId: 'p2' }]);
});

test('profile CRUD wrappers persist each transition with one storage write', async () => {
  installProfileState({ providerProfiles: [primaryProfile], activeProfileId: 'p1' });

  const createdState = await createProviderProfile({
    ...secondaryProfile,
    id: 'caller-id-is-ignored',
  });
  const created = createdState.providerProfiles[1];
  assert.notEqual(created.id, 'caller-id-is-ignored');
  assert.equal(storageWrites.length, 1);

  const savedState = await saveProviderProfile({ ...created, model: 'gemini-2.5-pro' });
  assert.equal(savedState.providerProfiles[1].model, 'gemini-2.5-pro');
  assert.equal(storageWrites.length, 2);

  const duplicatedState = await duplicateProviderProfile(created.id);
  const duplicate = duplicatedState.providerProfiles[2];
  assert.equal(duplicate.name, `${created.name} 副本`);
  assert.equal(storageWrites.length, 3);

  const renamedState = await renameProviderProfile(duplicate.id, '  第三配置  ');
  assert.equal(renamedState.providerProfiles[2].name, '第三配置');
  assert.equal(storageWrites.length, 4);

  const activatedState = await activateProviderProfile(created.id);
  assert.equal(activatedState.activeProfileId, created.id);
  assert.equal(storageWrites.length, 5);

  const deletedState = await deleteProviderProfile(created.id);
  assert.equal(deletedState.providerProfiles.some((profile) => profile.id === created.id), false);
  assert.equal(deletedState.activeProfileId, 'p1');
  assert.equal(storageWrites.length, 6);
  assert.deepEqual(storageWrites.at(-1), deletedState);
});
