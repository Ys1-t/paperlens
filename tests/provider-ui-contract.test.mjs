import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const viewerSource = readFileSync(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
const viewerHtml = readFileSync(new URL('../src/viewer/viewer.html', import.meta.url), 'utf8');
const popupSource = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
const popupHtml = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const serviceWorkerSource = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);
const providerUiUrl = new URL('../src/viewer/provider-ui.js', import.meta.url);
const providerUiSource = readFileSync(providerUiUrl, 'utf8');
const popupActionsUrl = new URL('../src/popup/popup-actions.js', import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeClassList {
  constructor() { this.names = new Set(); }
  toggle(name, force) {
    if (force) this.names.add(name);
    else this.names.delete(name);
  }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.classList = new FakeClassList();
    this.value = '';
    this.disabled = false;
    this.title = '';
    this.href = '';
    this._textContent = '';
  }
  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map((child) => (
      typeof child === 'string' ? child : child.textContent
    )).join('');
  }
  replaceChildren(...children) {
    this._textContent = '';
    this.children = [...children];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...children) {
    this.children.push(...children.map((child) => (
      typeof child === 'string' ? child : child
    )));
  }
  addEventListener() {}
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName, this); }
}

function makeProviderElements() {
  const document = new FakeDocument();
  return {
    profileSelect: document.createElement('select'),
    profileModelStatus: document.createElement('span'),
    configTip: document.createElement('p'),
  };
}

function publicConfig(id, overrides = {}) {
  const profile = {
    id,
    name: `Profile ${id}`,
    provider: 'openai',
    model: `model-${id}`,
    hasApiKey: true,
    ...overrides,
  };
  return {
    ...profile,
    activeProfileId: id,
    profiles: [profile],
  };
}

test('viewer exposes a compact Profile switcher backed only by public config', () => {
  const configImport = viewerSource.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/lib\/config\.js['"]/s,
  );

  assert.ok(configImport, 'viewer should import the public Provider APIs from config.js');
  assert.match(configImport[1], /\bloadPublicConfig\b/);
  assert.match(configImport[1], /\bactivateProviderProfile\b/);
  assert.doesNotMatch(configImport[1], /\bloadConfig\b/);
  assert.match(viewerHtml, /id=["']viewer-profile-select["']/);
  assert.match(viewerHtml, /id=["']viewer-model-status["']/);
  assert.match(viewerHtml, /id=["']app-version["']/);
  assert.match(viewerSource, /chrome\.runtime\.getManifest\(\)\.version/);
});

test('viewer switches Profiles for new requests without consuming raw API keys', () => {
  assert.doesNotMatch(viewerSource, /state\.config\.apiKey\b/);
  assert.match(viewerSource, /state\.config\.hasApiKey\b/);
  assert.match(viewerSource, /function\s+refreshPublicProviderState\s*\(/);
  assert.match(viewerSource, /activateProviderProfile\s*\(/);
  assert.match(`${viewerSource}\n${providerUiSource}`, /新请求将使用该供应商/);
});

test('viewer refreshes public Provider state when any persisted Provider setting changes', () => {
  assert.match(viewerSource, /chrome\.storage\.onChanged\.addListener\s*\(/);
  for (const key of ['config', 'providerProfiles', 'activeProfileId']) {
    assert.match(viewerSource, new RegExp(`\\b${key}\\b`));
  }
  assert.match(viewerSource, /areaName\s*!==\s*['"]local['"]/);
  assert.match(viewerSource, /refreshPublicProviderState\s*\(/);
});

test('manifest opens the popup and the service worker has no obsolete toolbar click handler', () => {
  assert.equal(manifest.action?.default_popup, 'src/popup/popup.html');
  // 版本号随每次前端改动递增；这里只锁格式，避免每次 bump 都要改测试。
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(serviceWorkerSource, /chrome\.action\.onClicked\.addListener\s*\(/);
});

test('popup exposes a public-only Profile switcher with safe async recovery helpers', () => {
  const configImport = popupSource.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/lib\/config\.js['"]/s,
  );
  const helperImport = popupSource.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/viewer\/provider-ui\.js['"]/s,
  );

  assert.ok(configImport, 'popup should import the public Provider APIs from config.js');
  assert.match(configImport[1], /\bloadPublicConfig\b/);
  assert.match(configImport[1], /\bactivateProviderProfile\b/);
  assert.doesNotMatch(configImport[1], /\bloadConfig\b/);
  assert.ok(helperImport, 'popup should reuse the tested Provider UI helpers');
  for (const name of [
    'createLatestConfigRefresher',
    'renderPublicProviderState',
    'switchProviderProfileForNewRequests',
  ]) {
    assert.match(helperImport[1], new RegExp(`\\b${name}\\b`));
    assert.match(popupSource, new RegExp(`\\b${name}\\s*\\(`));
  }
  assert.match(popupHtml, /id=["']popup-profile-select["']/);
  assert.match(popupHtml, /id=["']popup-model-status["']/);
  assert.doesNotMatch(popupSource, /\.innerHTML\s*=/);
});

test('popup keeps all open actions and synchronizes persisted Provider changes', () => {
  for (const id of ['translate-current', 'open-local', 'url', 'url-go']) {
    assert.match(popupHtml, new RegExp(`id=["']${id}["']`));
  }
  assert.match(popupSource, /chrome\.storage\.onChanged\.addListener\s*\(/);
  assert.match(popupSource, /areaName\s*!==\s*['"]local['"]/);
  for (const key of ['config', 'providerProfiles', 'activeProfileId']) {
    assert.match(popupSource, new RegExp(`\\b${key}\\b`));
  }
  assert.match(popupSource, /refreshStatus\s*\(/);
  assert.match(popupHtml, /id=["']switch-message["'][^>]*aria-live=["']polite["']/);
  assert.match(popupSource, /import\s*\{\s*handleOpenViewerResponse\s*\}\s*from\s*['"]\.\/popup-actions\.js['"]/);
  assert.match(popupSource, /chrome\.runtime\.lastError/);
  assert.match(popupSource, /handleOpenViewerResponse\s*\(/);
});

test('reading resume and recent-library are wired through viewer and popup', () => {
  // viewer：节流记录进度 + 重开时「继续上次阅读」横幅
  assert.match(viewerSource, /from '\.\.\/lib\/reading-history\.js'/);
  assert.match(viewerSource, /scheduleReadingProgressSave\(/);
  assert.match(viewerSource, /recordReadingProgress\(/);
  assert.match(viewerSource, /maybeOfferResume\(/);
  assert.match(viewerSource, /resume-banner/);
  assert.match(viewerSource, /state\.currentSourceUrl/);
  // popup：最近阅读列表（URL 可一键重开）
  assert.match(popupHtml, /id=["']recent-list["']/);
  assert.match(popupSource, /listRecentReadings\(/);
  assert.match(popupSource, /readingEntryLabel\(/);
});

test('outline sidebar is wired: toolbar button, panel builder, page jump', () => {
  // 工具栏按钮（文档打开后解除 hidden）
  assert.match(viewerHtml, /id=["']btn-outline["']/);
  assert.match(viewerSource, /btnOutline: \$\('btn-outline'\)/);
  assert.match(viewerSource, /toggleOutlinePanel\(/);
  assert.match(viewerSource, /refreshOutlinePanel\(/);
  assert.match(viewerSource, /updateOutlineActive\(/);
  // 目录项点击跳页复用 goToPage；数据来自 paperTools.getOutline()
  assert.match(viewerSource, /paperTools\.getOutline\(\)/);
  assert.match(viewerSource, /outline-panel/);
  // 框选提问按钮与目录按钮一样随文档打开出现
  assert.match(viewerHtml, /id=["']btn-snip["']/);
});

test('first-run onboarding and popup demo paper are wired', () => {
  // viewer：首次打开文档弹 3 步引导卡，「知道了」写 localStorage 后不再出现
  assert.match(viewerSource, /maybeShowOnboarding\(/);
  assert.match(viewerSource, /paperlens\.onboarding\.v1/);
  assert.match(viewerSource, /onboarding-close/);
  // popup：一键试读 arXiv 经典论文
  assert.match(popupHtml, /id=["']demo-link["']/);
  assert.match(popupSource, /arxiv\.org\/pdf\/1706\.03762/);
});

test('open-source packaging files exist and stay consistent', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../LICENSE'), /MIT License/);
  assert.match(read('../CHANGELOG.md'), /^# Changelog/m);
  assert.match(read('../.github/workflows/test.yml'), /npm test/);
  assert.match(read('../README.en.md'), /README\.md/);
  assert.match(read('../README.md'), /README\.en\.md/);
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.scripts.pack, 'node scripts/pack.mjs');
  assert.match(read('../scripts/pack.mjs'), /manifest\.json/);
});

test('reader hotkeys j/k/o/a/s are bound and documented in the help dialog', () => {
  assert.match(viewerSource, /key === 'j'/);
  assert.match(viewerSource, /key === 'k'/);
  assert.match(viewerSource, /key === 'o'/);
  assert.match(viewerSource, /key === 'a'/);
  assert.match(viewerSource, /key === 's'/);
  // 帮助浮层同步列出新键位
  assert.match(viewerHtml, /<kbd>J<\/kbd> \/ <kbd>K<\/kbd>/);
  assert.match(viewerHtml, /<kbd>O<\/kbd>/);
  assert.match(viewerHtml, /<kbd>A<\/kbd>/);
  assert.match(viewerHtml, /<kbd>S<\/kbd>/);
});

test('popup keeps open and reports runtime messaging failures', async () => {
  const { handleOpenViewerResponse } = await import(popupActionsUrl);
  let closes = 0;
  const errors = [];

  const ok = handleOpenViewerResponse({
    response: undefined,
    lastError: { message: 'service worker unavailable' },
    close: () => { closes += 1; },
    showError: (message) => errors.push(message),
  });

  assert.equal(ok, false);
  assert.equal(closes, 0);
  assert.match(errors.at(-1), /service worker unavailable/);
  assert.match(errors.at(-1), /重试/);
});

test('popup keeps open when the service worker rejects opening the viewer', async () => {
  const { handleOpenViewerResponse } = await import(popupActionsUrl);
  let closes = 0;
  const errors = [];

  const ok = handleOpenViewerResponse({
    response: { ok: false, error: 'viewer creation failed' },
    close: () => { closes += 1; },
    showError: (message) => errors.push(message),
  });

  assert.equal(ok, false);
  assert.equal(closes, 0);
  assert.match(errors.at(-1), /viewer creation failed/);
  assert.match(errors.at(-1), /重试/);
});

test('popup closes only after the viewer opens successfully', async () => {
  const { handleOpenViewerResponse } = await import(popupActionsUrl);
  let closes = 0;
  const errors = [];

  const ok = handleOpenViewerResponse({
    response: { ok: true, tabId: 42 },
    close: () => { closes += 1; },
    showError: (message) => errors.push(message),
  });

  assert.equal(ok, true);
  assert.equal(closes, 1);
  assert.deepEqual(errors, []);
});

test('latest public-config refresh wins when loads resolve out of order', async () => {
  const { createLatestConfigRefresher } = await import(providerUiUrl);
  const first = deferred();
  const second = deferred();
  const loads = [first.promise, second.promise];
  const committed = [];
  const refresh = createLatestConfigRefresher(
    () => loads.shift(),
    (config) => committed.push(config.activeProfileId),
  );

  const olderRefresh = refresh();
  const newerRefresh = refresh();
  second.resolve(publicConfig('new'));
  assert.equal(await newerRefresh, true);
  first.resolve(publicConfig('old'));
  assert.equal(await olderRefresh, false);

  assert.deepEqual(committed, ['new']);
});

test('provider UI renders editable fields as inert text', async () => {
  const { renderPublicProviderState } = await import(providerUiUrl);
  const elements = makeProviderElements();
  const injection = '<img src=x onerror=globalThis.pwned=true>';
  const config = publicConfig('p1', {
    name: injection,
    provider: injection,
    model: injection,
  });

  renderPublicProviderState(elements, config, () => {});

  assert.equal(elements.profileSelect.children[0].textContent, injection);
  assert.match(elements.profileModelStatus.textContent, new RegExp(injection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(elements.configTip.textContent, new RegExp(injection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const renderedTags = [
    ...elements.profileSelect.children,
    ...elements.configTip.children.filter((child) => typeof child !== 'string'),
  ].map((child) => child.tagName);
  assert.equal(renderedTags.includes('IMG'), false);
  assert.doesNotMatch(viewerSource, /els\.dzTip\.innerHTML\s*=/);
});

test('activation failure restores the previous selector value and disabled state', async () => {
  const { switchProviderProfileForNewRequests } = await import(providerUiUrl);
  const elements = makeProviderElements();
  elements.profileSelect.value = 'attempted';
  elements.profileSelect.disabled = false;
  const toasts = [];

  const switched = await switchProviderProfileForNewRequests({
    id: 'attempted',
    activeProfileId: 'previous',
    select: elements.profileSelect,
    activate: async () => { throw new Error('activation failed'); },
    refresh: async () => { throw new Error('refresh failed'); },
    showToast: (...args) => toasts.push(args),
  });

  assert.equal(switched, false);
  assert.equal(elements.profileSelect.value, 'previous');
  assert.equal(elements.profileSelect.disabled, false);
  assert.equal(toasts.at(-1)[1], true);
});

test('successful activation restores disabled state when its refresh is superseded', async () => {
  const { switchProviderProfileForNewRequests } = await import(providerUiUrl);
  const elements = makeProviderElements();
  elements.profileSelect.value = 'next';
  elements.profileSelect.disabled = false;
  const toasts = [];

  const switched = await switchProviderProfileForNewRequests({
    id: 'next',
    activeProfileId: 'previous',
    select: elements.profileSelect,
    activate: async () => {},
    refresh: async () => false,
    showToast: (...args) => toasts.push(args),
  });

  assert.equal(switched, true);
  assert.equal(elements.profileSelect.value, 'next');
  assert.equal(elements.profileSelect.disabled, false);
  assert.match(toasts.at(-1)[0], /新请求将使用该供应商/);
  assert.notEqual(toasts.at(-1)[1], true);
});

test('refresh selects the repaired active Profile after the previous active Profile is deleted', async () => {
  const { createLatestConfigRefresher, renderPublicProviderState } = await import(providerUiUrl);
  const elements = makeProviderElements();
  const before = publicConfig('p1');
  const after = publicConfig('p2');
  const loads = [before, after];
  const refresh = createLatestConfigRefresher(
    async () => loads.shift(),
    (config) => renderPublicProviderState(elements, config, () => {}),
  );

  await refresh();
  assert.equal(elements.profileSelect.value, 'p1');
  await refresh();

  assert.equal(elements.profileSelect.value, 'p2');
  assert.deepEqual(elements.profileSelect.children.map((option) => option.value), ['p2']);
  assert.equal(elements.profileSelect.disabled, false);
});
