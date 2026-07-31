// src/popup/popup.js
import { activateProviderProfile, loadPublicConfig } from '../lib/config.js';
import {
  createLatestConfigRefresher,
  renderPublicProviderState,
  switchProviderProfileForNewRequests,
} from '../viewer/provider-ui.js';
import { handleOpenViewerResponse } from './popup-actions.js';
import { listRecentReadings, readingEntryLabel } from '../lib/reading-history.js';

const $ = (id) => document.getElementById(id);
const state = { config: null };
const els = {
  profileSelect: $('popup-profile-select'),
  profileModelStatus: $('popup-model-status'),
  configTip: $('status'),
  switchMessage: $('switch-message'),
};
const refreshLatestStatus = createLatestConfigRefresher(loadPublicConfig, commitStatus);

init().catch((error) => showMessage(`初始化失败：${error.message || String(error)}`, true));

async function init() {
  $('settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
  $('translate-current').addEventListener('click', translateCurrent);
  $('open-local').addEventListener('click', () => openViewer(null));
  $('open-diagnostics').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/diagnostics/diagnostics.html') });
    window.close();
  });
  $('url-go').addEventListener('click', () => { const url = $('url').value.trim(); if (url) openViewer(url); });
  // 新手示例：一键打开经典论文体验完整流程
  $('demo-link')?.addEventListener('click', () => openViewer('https://arxiv.org/pdf/1706.03762'));
  $('url').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('url-go').click(); });
  els.profileSelect.addEventListener('change', switchProfile);
  bindProviderStorageSync();

  const tab = await currentTab();
  const url = tab?.url || '';
  if (looksLikePdf(url)) {
    $('current-info').textContent = shorten(url);
  } else {
    $('current-info').textContent = '当前页面不是 PDF —— 可粘贴链接或打开本地文件。';
    $('translate-current').textContent = '打开双语阅读器';
  }

  renderRecentReadings();
  await refreshStatus();
}

// 最近阅读：viewer 与 popup 同源共享 localStorage，直接读取阅读进度。
// 有 URL 的可一键重开；本地文件浏览器不允许直接重开，转到文件选择。
function renderRecentReadings() {
  const section = $('recent-section');
  const list = $('recent-list');
  if (!section || !list) return;
  const items = listRecentReadings({ limit: 6 });
  if (!items.length) return; // 无记录时整块隐藏，不占空间
  list.replaceChildren();
  for (const entry of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-item';
    btn.textContent = readingEntryLabel(entry);
    btn.title = entry.sourceUrl
      ? `重新打开：${entry.sourceUrl}`
      : '本地文件：将打开阅读器，请重新选择该 PDF';
    btn.addEventListener('click', () => openViewer(entry.sourceUrl || null));
    if (!entry.sourceUrl) {
      const tag = document.createElement('span');
      tag.className = 'recent-local-tag';
      tag.textContent = '本地';
      btn.appendChild(tag);
    }
    li.appendChild(btn);
    list.appendChild(li);
  }
  section.hidden = false;
}

async function refreshStatus() {
  return refreshLatestStatus();
}

function commitStatus(config) {
  state.config = config;
  renderPublicProviderState(els, config, () => chrome.runtime.openOptionsPage());
}

async function switchProfile(event) {
  return switchProviderProfileForNewRequests({
    id: event.currentTarget.value,
    activeProfileId: state.config?.activeProfileId,
    select: event.currentTarget,
    activate: (id) => activateProviderProfile(id),
    refresh: refreshStatus,
    showToast: showMessage,
  });
}

function bindProviderStorageSync() {
  const providerKeys = new Set(['config', 'providerProfiles', 'activeProfileId']);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!Object.keys(changes).some((key) => providerKeys.has(key))) return;
    refreshStatus().catch((error) => {
      showMessage(`刷新 Profile 失败：${error.message || String(error)}`, true);
    });
  });
}

function showMessage(message, isError = false) {
  els.switchMessage.textContent = String(message ?? '');
  els.switchMessage.classList.toggle('error', isError);
}

async function translateCurrent() {
  const tab = await currentTab();
  const url = tab?.url || '';
  openViewer(looksLikePdf(url) ? url : null);
}

function openViewer(file) {
  chrome.runtime.sendMessage({ type: 'openViewer', file }, (response) => {
    handleOpenViewerResponse({
      response,
      lastError: chrome.runtime.lastError,
      close: () => window.close(),
      showError: (message) => showMessage(message, true),
    });
  });
}

async function currentTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function looksLikePdf(url) {
  return /^https?:\/\//i.test(url) && (/\.pdf(\?|#|$)/i.test(url) || /arxiv\.org\/pdf\//i.test(url));
}

function shorten(url) {
  return url.length > 46 ? `${url.slice(0, 44)}…` : url;
}
