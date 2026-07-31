// src/options/options.js
import {
  DEFAULT_CONFIG,
  PROVIDER_PRESETS,
  activateProviderProfile,
  createProviderProfile,
  deleteProviderProfile,
  duplicateProviderProfile,
  loadProviderState,
  renameProviderProfile,
  saveConfig,
  saveProviderProfile,
} from '../lib/config.js';
import {
  clearSavedVaultFolder,
  getSavedVaultMeta,
  pickObsidianVaultFolder,
} from '../lib/obsidian-vault-fs.js';
import { validateProfile } from '../lib/provider-profiles.js';
import { maskApiKey, redactSecrets } from '../lib/secrets.js';
import {
  loadGlossary,
  removeGlossaryTerm,
  saveGlossary,
  upsertGlossaryTerm,
} from '../lib/glossary.js';
import {
  estimateCost,
  formatTokenCount,
  loadUsageStats,
  resetUsageStats,
} from '../lib/usage-stats.js';

const $ = (id) => document.getElementById(id);
const PROFILE_FIELDS = ['provider', 'protocol', 'baseUrl', 'apiKey', 'model'];
const GLOBAL_FIELDS = [
  'targetLang', 'temperature', 'concurrency', 'systemPrompt', 'chatProfileId',
  'obsidianBaseUrl', 'obsidianApiKey', 'obsidianFolder',
];
const GLOBAL_CHECKS = [
  'stream', 'bilingual', 'selectionTranslate', 'chatAssistant', 'obsidianEnabled',
];
const NEW_PROFILE_VALUE = '__new_profile__';
const SAMPLE_TEXT = 'Heuristics are widely used for optimization.';

let providerState;
let editingProfileId;
let editingProfileName = '';
let savedSnapshot = '';
let draftIsUnsaved = false;
let saveGeneration = 0;
let testGeneration = 0;
let selfTestGeneration = 0;
let selfTestController;

init().catch((error) => showResult('save-result', error, true));

async function init() {
  populateProviderPresets();
  bindEvents();
  providerState = await loadProviderState();
  editingProfileId = providerState.activeProfileId;
  showSelectedProfile();
  refreshCacheCount();
  void refreshObsidianVaultStatus();
  void renderGlossary();
  void renderUsageStats();
}

// ---------------------------------------------------------------------------
// 用量统计（估算）：展示累计 token、按单价折算花费；单价记在 localStorage
// ---------------------------------------------------------------------------

const USAGE_PRICE_KEY = 'paperlens.usagePrices.v1';

function loadUsagePrices() {
  try { return JSON.parse(localStorage.getItem(USAGE_PRICE_KEY) || '{}') || {}; } catch { return {}; }
}

function saveUsagePrices(prices) {
  try { localStorage.setItem(USAGE_PRICE_KEY, JSON.stringify(prices)); } catch { /* noop */ }
}

async function renderUsageStats() {
  const reqEl = $('usage-requests');
  if (!reqEl) return;
  const stats = await loadUsageStats();
  reqEl.textContent = String(stats.requests);
  $('usage-in').textContent = formatTokenCount(stats.promptTokens);
  $('usage-out').textContent = formatTokenCount(stats.completionTokens);
  const today = stats.days[new Date().toISOString().slice(0, 10)];
  $('usage-today').textContent = String(today?.requests || 0);

  const prices = loadUsagePrices();
  if ($('usage-price-in') && prices.inPricePerM != null) $('usage-price-in').value = prices.inPricePerM;
  if ($('usage-price-out') && prices.outPricePerM != null) $('usage-price-out').value = prices.outPricePerM;
  renderUsageCost(stats);
}

async function renderUsageCost(stats = null) {
  const costEl = $('usage-cost');
  if (!costEl) return;
  const s = stats || await loadUsageStats();
  const inPricePerM = parseFloat($('usage-price-in')?.value);
  const outPricePerM = parseFloat($('usage-price-out')?.value);
  saveUsagePrices({
    inPricePerM: Number.isFinite(inPricePerM) ? inPricePerM : null,
    outPricePerM: Number.isFinite(outPricePerM) ? outPricePerM : null,
  });
  const cost = estimateCost(s, { inPricePerM, outPricePerM });
  costEl.textContent = cost == null ? '—' : `≈ ¥${cost.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// 术语表管理（锁定译法）
// ---------------------------------------------------------------------------

async function renderGlossary() {
  const listEl = $('glossary-list');
  const countEl = $('glossary-count');
  if (!listEl) return;
  const items = await loadGlossary();
  listEl.replaceChildren();
  // 最新锁定的排最前，方便刚锁完确认。
  for (const item of [...items].reverse()) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'glossary-item-label';
    label.textContent = `${item.term} → ${item.translation}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost glossary-del';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await removeGlossaryTerm(item.term);
      void renderGlossary();
    });
    li.append(label, del);
    listEl.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'glossary-empty';
    li.textContent = '（还没有锁定的术语。阅读器里划词翻译后点「锁定术语」即可收录。）';
    listEl.appendChild(li);
  }
  if (countEl) countEl.textContent = String(items.length);
}

async function addGlossaryFromForm() {
  const termEl = $('glossary-term');
  const translationEl = $('glossary-translation');
  const term = String(termEl?.value || '').trim();
  const translation = String(translationEl?.value || '').trim();
  if (!term || !translation) {
    showResult('save-result', new Error('术语与译法都要填'), true);
    return;
  }
  await upsertGlossaryTerm({ term, translation });
  if (termEl) termEl.value = '';
  if (translationEl) translationEl.value = '';
  void renderGlossary();
}

async function clearGlossary() {
  await saveGlossary([]);
  void renderGlossary();
}

function populateProviderPresets() {
  const select = $('provider');
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function bindEvents() {
  $('profile-select').addEventListener('change', selectProfile);
  $('profile-set-active').addEventListener('click', activateProfile);
  $('profile-new').addEventListener('click', createProfile);
  $('profile-copy').addEventListener('click', duplicateProfile);
  $('profile-rename').addEventListener('click', renameProfile);
  $('profile-delete').addEventListener('click', deleteProfile);
  $('provider').addEventListener('change', onProviderChange);
  $('toggle-key').addEventListener('click', toggleKey);
  $('test').addEventListener('click', testConnection);
  $('selftest').addEventListener('click', rawSelfTest);
  $('copy-diag').addEventListener('click', copyDiag);
  $('save').addEventListener('click', save);
  $('clear-cache').addEventListener('click', clearCache);
  $('glossary-add-btn')?.addEventListener('click', () => { void addGlossaryFromForm(); });
  $('glossary-clear')?.addEventListener('click', () => { void clearGlossary(); });
  $('usage-reset')?.addEventListener('click', async () => { await resetUsageStats(); void renderUsageStats(); });
  $('usage-price-in')?.addEventListener('input', () => { void renderUsageCost(); });
  $('usage-price-out')?.addEventListener('input', () => { void renderUsageCost(); });
  $('probe-obsidian')?.addEventListener('click', probeObsidian);
  $('pick-obsidian-vault')?.addEventListener('click', pickObsidianVault);
  $('clear-obsidian-vault')?.addEventListener('click', clearObsidianVault);
  for (const id of [...PROFILE_FIELDS, ...GLOBAL_FIELDS, ...GLOBAL_CHECKS]) {
    $(id)?.addEventListener('input', invalidateConnectionTests);
    $(id)?.addEventListener('change', invalidateConnectionTests);
  }
  window.addEventListener('beforeunload', warnBeforeUnload);
}

function currentProfile() {
  return providerState?.providerProfiles.find((profile) => profile.id === editingProfileId);
}

function showSelectedProfile() {
  invalidateConnectionTests();
  const profile = currentProfile();
  if (!profile) throw new Error('正在编辑的 Profile 不存在');
  editingProfileName = profile.name;
  applyToForm({ ...DEFAULT_CONFIG, ...providerState.config, ...profile });
  renderProfileControls();
  markSaved();
  clearDiagnostics();
}

function showNewProfileDraft(name) {
  invalidateConnectionTests();
  editingProfileId = null;
  editingProfileName = name;
  applyToForm({
    ...DEFAULT_CONFIG,
    ...providerState.config,
    provider: DEFAULT_CONFIG.provider,
    protocol: DEFAULT_CONFIG.protocol,
    baseUrl: DEFAULT_CONFIG.baseUrl,
    apiKey: '',
    model: DEFAULT_CONFIG.model,
  });
  renderProfileControls();
  markSaved();
  draftIsUnsaved = true;
  clearDiagnostics();
}

function renderProfileControls() {
  const select = $('profile-select');
  select.innerHTML = '';
  for (const profile of providerState.providerProfiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = profile.id === providerState.activeProfileId
      ? `${profile.name}（当前）`
      : profile.name;
    select.appendChild(option);
  }
  if (!editingProfileId) {
    const option = document.createElement('option');
    option.value = NEW_PROFILE_VALUE;
    option.textContent = `${editingProfileName}（未保存）`;
    select.appendChild(option);
  }
  select.value = editingProfileId || NEW_PROFILE_VALUE;

  const activeProfile = providerState.providerProfiles.find((profile) => profile.id === providerState.activeProfileId);
  const badge = $('profile-active');
  badge.className = 'profile-badge';
  if (!editingProfileId) {
    badge.classList.add('draft');
    badge.textContent = '未保存';
  } else if (editingProfileId === providerState.activeProfileId) {
    badge.classList.add('active');
    badge.textContent = '当前启用';
  } else {
    badge.textContent = `当前：${activeProfile?.name || '未知'}`;
  }

  $('profile-set-active').disabled = !editingProfileId || editingProfileId === providerState.activeProfileId;
  $('profile-copy').disabled = !editingProfileId;
  $('profile-rename').disabled = !editingProfileId;
  $('profile-delete').disabled = !editingProfileId || providerState.providerProfiles.length <= 1;
  renderChatProfileSelect(providerState.config?.chatProfileId || '');
}

/** AI 助手 Profile 下拉：可选「与翻译相同」或任意已保存 Profile。 */
function renderChatProfileSelect(selectedId = '') {
  const select = $('chatProfileId');
  if (!select) return;
  const previous = selectedId || select.value || '';
  select.innerHTML = '';
  const same = document.createElement('option');
  same.value = '';
  same.textContent = '与翻译当前 Profile 相同';
  select.appendChild(same);
  for (const profile of providerState.providerProfiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    const model = profile.model ? ` · ${profile.model}` : '';
    option.textContent = profile.id === providerState.activeProfileId
      ? `${profile.name}（翻译当前）${model}`
      : `${profile.name}${model}`;
    select.appendChild(option);
  }
  const valid = previous === ''
    || providerState.providerProfiles.some((profile) => profile.id === previous);
  select.value = valid ? previous : '';
}

function applyToForm(config) {
  renderChatProfileSelect(config.chatProfileId || '');
  for (const field of [...PROFILE_FIELDS, ...GLOBAL_FIELDS]) {
    if ($(field) != null) $(field).value = config[field] ?? '';
  }
  for (const check of GLOBAL_CHECKS) {
    if ($(check) != null) $(check).checked = Boolean(config[check]);
  }
  updateProviderHint();
  updateModelList();
  resetApiKeyVisibility();
}

function resetApiKeyVisibility() {
  $('apiKey').type = 'password';
  $('toggle-key').textContent = '显示';
}

function invalidateConnectionTests() {
  testGeneration += 1;
  selfTestGeneration += 1;
  selfTestController?.abort();
  selfTestController = undefined;
  clearConnectionTestState();
}

function clearConnectionTestState() {
  $('test-result').className = 'test-result';
  $('test-result').textContent = '';
  $('copy-diag-result').className = 'test-result';
  $('copy-diag-result').textContent = '';
  clearDiagnostics();
}

function readProfileForm() {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, $(field).value]));
}

function readGlobalForm() {
  const config = Object.fromEntries(GLOBAL_FIELDS.map((field) => [field, $(field).value]));
  for (const check of GLOBAL_CHECKS) config[check] = $(check).checked;
  config.temperature = Number.parseFloat(config.temperature);
  config.concurrency = Number.parseInt(config.concurrency, 10);
  return config;
}

function readForm() {
  return { ...readProfileForm(), ...readGlobalForm() };
}

function markSaved() {
  savedSnapshot = JSON.stringify(readForm());
  draftIsUnsaved = false;
}

function isDirty() {
  return draftIsUnsaved || (Boolean(savedSnapshot) && JSON.stringify(readForm()) !== savedSnapshot);
}

function confirmDiscard() {
  return !isDirty() || window.confirm('当前配置尚未保存，是否放弃修改？');
}

function warnBeforeUnload(event) {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
}

function selectProfile(event) {
  const nextId = event.target.value;
  if (nextId === editingProfileId || nextId === NEW_PROFILE_VALUE) return;
  if (!confirmDiscard()) {
    event.target.value = editingProfileId || NEW_PROFILE_VALUE;
    return;
  }
  editingProfileId = nextId;
  showSelectedProfile();
}

async function createProfile() {
  if (!confirmDiscard()) return;
  const proposed = window.prompt('新 Profile 名称', '新配置');
  if (proposed == null) return;
  const name = proposed.trim();
  if (!name) {
    showResult('profile-result', 'Profile 名称不能为空', true);
    return;
  }
  showNewProfileDraft(name);
  showResult('profile-result', '请填写连接信息并点击“保存设置”完成新建');
}

async function duplicateProfile() {
  if (!editingProfileId || !confirmDiscard()) return;
  try {
    providerState = await duplicateProviderProfile(editingProfileId);
    editingProfileId = providerState.providerProfiles.at(-1).id;
    showSelectedProfile();
    showResult('profile-result', '✓ 已复制 Profile');
  } catch (error) {
    showResult('profile-result', error, true);
  }
}

async function renameProfile() {
  const profile = currentProfile();
  if (!profile) return;
  const proposed = window.prompt('重命名 Profile', profile.name);
  if (proposed == null) return;
  try {
    providerState = await renameProviderProfile(profile.id, proposed);
    editingProfileName = providerState.providerProfiles.find((item) => item.id === profile.id)?.name || profile.name;
    resetApiKeyVisibility();
    renderProfileControls();
    showResult('profile-result', '✓ 已重命名');
  } catch (error) {
    showResult('profile-result', error, true);
  }
}

async function deleteProfile() {
  const profile = currentProfile();
  if (!profile || !confirmDiscard()) return;
  if (!window.confirm(`确定删除 Profile“${profile.name}”吗？`)) return;
  try {
    // 若 AI 助手正指向被删 Profile，回退为「与翻译相同」。
    if ((providerState.config?.chatProfileId || '') === profile.id) {
      providerState = {
        ...providerState,
        config: { ...providerState.config, chatProfileId: '' },
      };
      await saveConfig({ chatProfileId: '' });
    }
    providerState = await deleteProviderProfile(profile.id);
    editingProfileId = providerState.activeProfileId;
    showSelectedProfile();
    showResult('profile-result', '✓ 已删除 Profile');
  } catch (error) {
    showResult('profile-result', error, true);
  }
}

async function activateProfile() {
  if (isDirty()) {
    showResult('profile-result', '请先保存当前修改，再将该 Profile 设为当前', true);
    return;
  }
  if (!editingProfileId) return;
  try {
    providerState = await activateProviderProfile(editingProfileId);
    renderProfileControls();
    showResult('profile-result', '✓ 已设为当前 Profile');
  } catch (error) {
    showResult('profile-result', error, true);
  }
}

function onProviderChange() {
  const key = $('provider').value;
  const preset = PROVIDER_PRESETS[key];
  if (!preset) return;
  $('protocol').value = preset.protocol;
  if (preset.baseUrl) $('baseUrl').value = preset.baseUrl;
  if (preset.model) $('model').value = preset.model;
  updateProviderHint();
  updateModelList();
}

function updateProviderHint() {
  const preset = PROVIDER_PRESETS[$('provider').value];
  $('provider-hint').textContent = preset?.hint || '';
}

function updateModelList() {
  const preset = PROVIDER_PRESETS[$('provider').value];
  const datalist = $('model-list');
  datalist.innerHTML = '';
  for (const model of (preset?.models || [])) {
    const option = document.createElement('option');
    option.value = model;
    datalist.appendChild(option);
  }
}

function toggleKey() {
  const input = $('apiKey');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('toggle-key').textContent = showing ? '显示' : '隐藏';
}

async function testConnection() {
  const result = $('test-result');
  const override = readForm();
  const profileName = editingProfileName;
  const generation = ++testGeneration;
  result.className = 'test-result busy';
  result.textContent = '正在测试（不会保存）…';
  chrome.runtime.sendMessage({ type: 'testConnection', override }, (response) => {
    if (generation !== testGeneration) return;
    const apiKey = override.apiKey;
    if (chrome.runtime.lastError) {
      result.className = 'test-result err';
      result.textContent = redactSecrets(chrome.runtime.lastError.message, [apiKey]);
      return;
    }
    if (response?.ok) {
      result.className = 'test-result ok';
      result.textContent = `✓ ${profileName} 连接成功：` + redactSecrets(response.sample || '', [apiKey]).slice(0, 40);
    } else {
      result.className = 'test-result err';
      result.textContent = '✗ ' + redactSecrets(response?.error || '未知错误', [apiKey]);
    }
  });
}

// 原始自检绕过 Service Worker，用于隔离 API、Key、URL 与扩展内部管线问题。
async function rawSelfTest() {
  const output = $('selftest-out');
  const form = readForm();
  const profileName = editingProfileName;
  const generation = ++selfTestGeneration;
  selfTestController?.abort();
  const controller = new AbortController();
  selfTestController = controller;
  output.hidden = false;
  output.textContent = '正在直连接口…';
  clearDiagnostics();
  output.hidden = false;

  const targetLang = form.targetLang || '简体中文';
  const systemPrompt = `You are a translator. Translate to ${targetLang}. Output only the translation.`;
  let url;
  let options;

  try {
    validateSelfTestForm(form, profileName);
    if (form.protocol === 'gemini') {
      const base = (form.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      url = `${base}/models/${encodeURIComponent(form.model)}:generateContent`;
      options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': form.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: SAMPLE_TEXT }] }],
          generationConfig: { temperature: Number(form.temperature ?? 0.2) },
        }),
      };
    } else {
      const base = (form.baseUrl || '').replace(/\/+$/, '');
      if (!base) {
        output.textContent = '✗ 未填写 Base URL。';
        return;
      }
      url = `${base}/chat/completions`;
      options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${form.apiKey}` },
        body: JSON.stringify({
          model: form.model,
          temperature: Number(form.temperature ?? 0.2),
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: SAMPLE_TEXT },
          ],
        }),
      };
    }
  } catch (error) {
    output.textContent = diagnosticText('✗ 构造请求失败：' + (error.message || error), form.apiKey);
    return;
  }

  const displayUrl = diagnosticText(url, form.apiKey);
  const startedAt = Date.now();
  let status = 'N/A';
  let ok = false;
  let bodySnippet = '';
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (generation !== selfTestGeneration) return;
    status = diagnosticText(`${response.status} ${response.statusText}`, form.apiKey);
    ok = response.ok;
    bodySnippet = diagnosticText((await response.text()).slice(0, 400), form.apiKey);
    if (generation !== selfTestGeneration) return;
    const elapsed = Date.now() - startedAt;
    output.textContent = diagnosticText(
      `请求：POST ${displayUrl}\n` +
      `耗时：${elapsed} ms\n` +
      `HTTP：${status}   ok=${ok}\n` +
      `响应体（前 400 字）：\n${bodySnippet}` +
      (ok
        ? '\n\n✓ 接口可直连。若扩展内翻译仍失败，则问题在扩展管线。'
        : '\n\n✗ 接口返回非 2xx。请检查 Key、模型名和 Base URL。'),
      form.apiKey,
    );
  } catch (error) {
    if (generation !== selfTestGeneration || error?.name === 'AbortError') return;
    bodySnippet = diagnosticText('NETWORK ERROR: ' + (error.message || error), form.apiKey);
    output.textContent = diagnosticText(
      `请求：POST ${displayUrl}\n` +
      `✗ 网络错误：${error.message || error}\n\n` +
      '常见原因：Base URL 拼写错误、域名无法访问、网络限制或目标站不允许浏览器直连（CORS）。',
      form.apiKey,
    );
  }

  const report = diagnosticText([
    'PaperLens 诊断报告',
    'Profile: ' + profileName,
    '服务商: ' + form.provider,
    '协议: ' + form.protocol,
    'Base URL: ' + (form.baseUrl || '(默认)'),
    '模型: ' + form.model,
    '目标语言: ' + targetLang,
    'API Key: ' + maskApiKey(form.apiKey),
    '请求 URL: ' + displayUrl,
    'HTTP: ' + status + '  ok=' + ok,
    '响应体(前400字): ' + bodySnippet,
  ].join('\n'), form.apiKey);
  $('diag-report').value = report;
  $('diag-report').hidden = false;
  $('diag-row').hidden = false;
}

function validateSelfTestForm(form, profileName) {
  validateProfile({ id: 'self-test', name: profileName || '当前 Profile', ...readProfileSnapshot(form) });
}

function readProfileSnapshot(form) {
  return Object.fromEntries(PROFILE_FIELDS.map((field) => [field, form[field]]));
}

function diagnosticText(value, apiKey) {
  return redactSecrets(value, [apiKey]);
}

function clearDiagnostics() {
  $('selftest-out').hidden = true;
  $('diag-row').hidden = true;
  $('diag-report').hidden = true;
  $('diag-report').value = '';
}

async function copyDiag() {
  const result = $('copy-diag-result');
  try {
    await navigator.clipboard.writeText($('diag-report').value);
    result.className = 'test-result ok';
    result.textContent = '✓ 已复制';
  } catch {
    $('diag-report').select();
    result.className = 'test-result err';
    result.textContent = '请手动复制（已选中）';
  }
  setTimeout(() => { result.textContent = ''; }, 2000);
}

async function save() {
  const result = $('save-result');
  const profilePatch = readProfileForm();
  const globalPatch = readGlobalForm();
  result.className = 'test-result busy';
  result.textContent = '正在保存…';
  const generation = ++saveGeneration;
  setSaveLocked(true);
  try {
    if (editingProfileId) {
      const profile = currentProfile();
      providerState = await saveProviderProfile({ ...profile, ...profilePatch });
    } else {
      providerState = await createProviderProfile({ name: editingProfileName, ...profilePatch });
      editingProfileId = providerState.providerProfiles.at(-1).id;
    }
    await saveConfig(globalPatch);
    if (generation !== saveGeneration) return;
    providerState = await loadProviderState();
    if (generation !== saveGeneration) return;
    showSelectedProfile();
    result.className = 'test-result ok';
    result.textContent = '✓ Profile 与全局偏好已保存';
  } catch (error) {
    result.className = 'test-result err';
    result.textContent = diagnosticText(error?.message || error, profilePatch.apiKey);
  } finally {
    if (generation === saveGeneration) setSaveLocked(false);
  }
  setTimeout(() => { result.textContent = ''; }, 2400);
}

function setSaveLocked(locked) {
  const ids = [
    'profile-select', 'profile-set-active', 'profile-new', 'profile-copy', 'profile-rename', 'profile-delete',
    ...PROFILE_FIELDS, ...GLOBAL_FIELDS, ...GLOBAL_CHECKS, 'toggle-key', 'save',
  ];
  for (const id of ids) if ($(id)) $(id).disabled = locked;
  if (!locked) renderProfileControls();
}

async function refreshObsidianVaultStatus() {
  const el = $('obsidian-vault-status');
  if (!el) return;
  try {
    const meta = await getSavedVaultMeta();
    if (meta?.name) {
      el.className = 'test-result ok';
      el.textContent = `✓ 已选择库：${meta.name}（笔记会写到 ${$('obsidianFolder')?.value?.trim() || 'PaperLens'}/）`;
    } else {
      el.className = 'test-result';
      el.textContent = '尚未选择库文件夹（推荐）';
    }
  } catch {
    el.className = 'test-result';
    el.textContent = '';
  }
}

async function pickObsidianVault() {
  const el = $('obsidian-vault-status');
  if (el) {
    el.className = 'test-result busy';
    el.textContent = '请在弹出对话框中选择 Obsidian 库根目录…';
  }
  const result = await pickObsidianVaultFolder();
  if (result.ok) {
    if (!$('obsidianEnabled').checked) $('obsidianEnabled').checked = true;
    if (el) {
      el.className = 'test-result ok';
      el.textContent = `✓ 已选择库：${result.name}。请点底部「保存」。`;
    }
  } else if (!result.cancelled && el) {
    el.className = 'test-result err';
    el.textContent = `✗ ${result.message || '选择失败'}`;
  } else {
    await refreshObsidianVaultStatus();
  }
}

async function clearObsidianVault() {
  await clearSavedVaultFolder();
  await refreshObsidianVaultStatus();
}

async function probeObsidian() {
  const result = $('probe-obsidian-result');
  if (!result) return;
  const baseUrl = $('obsidianBaseUrl')?.value?.trim() || 'http://127.0.0.1:27123';
  result.className = 'test-result busy';
  result.textContent = `正在连接 ${baseUrl} …`;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'obsidian',
      action: 'probe',
      override: {
        obsidianEnabled: true,
        obsidianBaseUrl: baseUrl,
        obsidianApiKey: $('obsidianApiKey')?.value?.trim() || '',
        obsidianFolder: $('obsidianFolder')?.value?.trim() || 'PaperLens',
      },
    });
    if (response?.ok) {
      result.className = 'test-result ok';
      result.textContent = `✓ ${response.message || '已连通'}（${baseUrl}）`;
    } else {
      result.className = 'test-result err';
      result.textContent = `✗ ${response?.message || response?.error || '连接失败'}`;
    }
  } catch (error) {
    result.className = 'test-result err';
    result.textContent = `✗ ${error?.message || error}`;
  }
}

function refreshCacheCount() {
  chrome.runtime.sendMessage({ type: 'cacheCount' }, (response) => {
    if (chrome.runtime.lastError) {
      $('cache-count').textContent = '—';
      return;
    }
    $('cache-count').textContent = response?.ok ? response.count : '—';
  });
}

function clearCache() {
  chrome.runtime.sendMessage({ type: 'clearCache' }, () => refreshCacheCount());
}

function showResult(id, value, error = false) {
  const result = $(id);
  if (!result) return;
  result.className = `test-result ${error ? 'err' : 'ok'}`;
  result.textContent = diagnosticText(value?.message || value || '', $('apiKey')?.value);
}
