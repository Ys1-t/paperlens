// src/lib/config.js
// 配置存储、默认值与服务商预设（Provider presets）。
// 在 service worker、options、popup、viewer 中共享。
import {
  PROFILE_KEYS,
  activateProviderProfile as activateProviderProfileState,
  createProviderProfile as createProviderProfileState,
  deleteProviderProfile as deleteProviderProfileState,
  duplicateProviderProfile as duplicateProviderProfileState,
  migrateLegacyState,
  renameProviderProfile as renameProviderProfileState,
  saveProviderProfile as saveProviderProfileState,
  toPublicProfile,
} from './provider-profiles.js';

/**
 * 服务商预设。protocol 决定请求协议：
 *  - "openai": OpenAI Chat Completions 兼容（DeepSeek 官方、OpenAI、绝大多数中转站均属此类）
 *  - "gemini": Google Gemini 原生 generateContent 协议
 */
export const PROVIDER_PRESETS = {
  openai: {
    label: 'OpenAI（官方，支持视觉）',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5.5'],
    hint: '视觉翻译需能看图的模型。gpt-4o 视觉能力强、性价比高；gpt-4o-mini 更便宜。',
  },
  gemini: {
    label: 'Gemini（官方，支持视觉）',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash',
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview'],
    hint: '使用 Google AI Studio 的 API Key。Gemini 系列原生支持看图，适合整页翻译。',
  },
  relay: {
    label: '中转站 / 代理（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: '',
    model: 'gpt-4o',
    models: [],
    hint: '填中转站给你的 Base URL（通常以 /v1 结尾）。视觉翻译必须选支持看图的模型，例如 gpt-4o、gemini-2.5-flash、claude-3-5-sonnet、qwen-vl 等。',
  },
  deepseek: {
    label: 'DeepSeek（官方）',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-vl2',
    models: ['deepseek-vl2', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    hint: '⚠ 视觉翻译需要能看图的模型（如 deepseek-vl 系列）；deepseek-v4-flash / v4-pro 是纯文本，看不了图。若官方无视觉模型，请改用 OpenAI / Gemini / 中转站。',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: '',
    model: '',
    models: [],
    hint: '视觉翻译必须使用支持图像输入的模型。',
  },
};

export const DEFAULT_CONFIG = {
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  targetLang: '简体中文',
  temperature: 0.2,
  concurrency: 4,        // 分块文本翻译较轻，可适当提高并发（划词仍走优先通道）
  stream: true,          // 是否流式输出（打字机效果）
  bilingual: false,      // 译文面板是否默认同时显示原文（结构化阅读模式的原文对照行）
  selectionTranslate: true, // 左栏 PDF 划词即时翻译浮层（关闭后完全不监听划词事件）
  chatAssistant: true,   // 右侧「AI 助手」聊天面板（关闭则不挂载入口）
  // AI 助手专用 Provider Profile id；空字符串 = 与翻译「当前 Profile」相同。
  // 可指向任意已保存 Profile，从而为对话接入更强模型 / 另一套 API。
  chatProfileId: '',
  systemPrompt: '',      // 留空则使用内置学术翻译提示词

  // Obsidian Local REST API（科研笔记写入本地库；扩展侧走 HTTP，与常见 Obsidian MCP 同源）。
  obsidianEnabled: false,
  obsidianBaseUrl: 'http://127.0.0.1:27123',
  obsidianApiKey: '',
  obsidianFolder: 'PaperLens',
};

const NUMERIC_KEYS = new Set(['temperature', 'concurrency']);
const BOOL_KEYS = new Set([
  'stream', 'bilingual', 'selectionTranslate', 'chatAssistant', 'obsidianEnabled',
]);
const STORAGE_KEYS = ['config', 'providerProfiles', 'activeProfileId'];
const PROVIDER_STATE_LOCK = 'paperlens-provider-state-v1';
const RUNTIME_ONLY_KEYS = new Set([
  'id',
  'name',
  'profileName',
  'activeProfileId',
  'profiles',
  'hasApiKey',
  'keySuffix',
]);
let mutationQueue = Promise.resolve();

/** 读取并修复 Provider 存储状态；旧版扁平配置会一次性原子迁移。 */
export async function loadProviderState() {
  const { stored, state } = await readProviderState();
  if (sameState(stored, state)) return state;
  return enqueueMutation(async () => {
    const latest = await readProviderState();
    if (!sameState(latest.stored, latest.state)) await persistProviderState(latest.state);
    return latest.state;
  });
}

/** 读取配置（与默认值合并），继续返回旧调用方需要的扁平运行时配置。 */
export async function loadConfig() {
  return runtimeConfig(await loadProviderState());
}

/**
 * 解析 AI 助手实际使用的 Profile。
 * chatProfileId 为空、失效或不存在时回退到翻译用的 activeProfile。
 */
export function resolveChatProfile(state) {
  const active = activeProfile(state);
  const requested = String(state?.config?.chatProfileId ?? '').trim();
  if (!requested) {
    return { profile: active, chatProfileId: '', usesTranslationProfile: true };
  }
  const found = (state.providerProfiles || []).find((profile) => profile.id === requested);
  if (!found) {
    return { profile: active, chatProfileId: '', usesTranslationProfile: true };
  }
  return {
    profile: found,
    chatProfileId: found.id,
    usesTranslationProfile: found.id === active.id,
  };
}

/**
 * AI 助手专用运行时配置（可与翻译 Profile 不同的 baseUrl/apiKey/model）。
 * temperature/stream 等全局项仍来自 config。
 */
export async function loadChatConfig() {
  const state = await loadProviderState();
  return runtimeChatConfig(state);
}

function runtimeChatConfig(state) {
  const active = activeProfile(state);
  const { profile, chatProfileId, usesTranslationProfile } = resolveChatProfile(state);
  return normalize({
    ...DEFAULT_CONFIG,
    ...state.config,
    ...profile,
    profileName: profile.name,
    activeProfileId: active.id,
    chatProfileId: chatProfileId || '',
    chatUsesTranslationProfile: usesTranslationProfile,
  });
}

/** 返回不含 API Key 的公开配置及全部 Profile 摘要。 */
export async function loadPublicConfig() {
  const state = await loadProviderState();
  const active = activeProfile(state);
  const chat = resolveChatProfile(state);
  const publicBase = withoutProfileKeys(normalize({ ...DEFAULT_CONFIG, ...state.config }));
  // Never ship Obsidian REST API key to the viewer page.
  const hasObsidianKey = Boolean(String(publicBase.obsidianApiKey || '').trim());
  delete publicBase.obsidianApiKey;
  return {
    ...publicBase,
    ...toPublicProfile(active),
    activeProfileId: active.id,
    profiles: state.providerProfiles.map(toPublicProfile),
    chatProfileId: chat.chatProfileId,
    chatUsesTranslationProfile: chat.usesTranslationProfile,
    chatProfile: toPublicProfile(chat.profile),
    hasObsidianKey,
  };
}

/** 局部更新并保存配置，返回合并后的完整扁平配置。 */
export async function saveConfig(patch = {}) {
  return enqueueMutation(async () => {
    const { state } = await readProviderState();
    const active = activeProfile(state);
    const profilePatch = pickProfileFields(patch);
    const globalPatch = pickGlobalFields(patch);

    let next = {
      ...state,
      config: withoutProfileKeys(normalize({ ...DEFAULT_CONFIG, ...state.config, ...globalPatch })),
    };
    if (Object.keys(profilePatch).length > 0) {
      next = saveProviderProfileState(next, { ...active, ...profilePatch });
    }

    await persistProviderState(next);
    return runtimeConfig(next);
  });
}

export async function createProviderProfile(profile) {
  return transitionProviderState((state) => createProviderProfileState(state, profile));
}

export async function saveProviderProfile(profile) {
  return transitionProviderState((state) => (
    profile?.id
      ? saveProviderProfileState(state, profile)
      : createProviderProfileState(state, profile)
  ));
}

export async function duplicateProviderProfile(id) {
  return transitionProviderState((state) => duplicateProviderProfileState(state, id));
}

export async function renameProviderProfile(id, name) {
  return transitionProviderState((state) => renameProviderProfileState(state, id, name));
}

export async function deleteProviderProfile(id) {
  return transitionProviderState((state) => deleteProviderProfileState(state, id));
}

export async function activateProviderProfile(id) {
  return enqueueMutation(async () => {
    const { stored, state } = await readProviderState();
    const next = activateProviderProfileState(state, id);
    if (sameState(stored, state)) {
      await chrome.storage.local.set({ activeProfileId: next.activeProfileId });
    } else {
      await persistProviderState(next);
    }
    return next;
  });
}

function transitionProviderState(update) {
  return enqueueMutation(async () => {
    const { state } = await readProviderState();
    const next = update(state);
    await persistProviderState(next);
    return next;
  });
}

function enqueueMutation(task) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === 'function') {
    return locks.request(PROVIDER_STATE_LOCK, task);
  }
  return enqueueLocalMutation(task);
}

function enqueueLocalMutation(task) {
  const result = mutationQueue.then(task);
  mutationQueue = result.catch(() => undefined);
  return result;
}

async function readProviderState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  return { stored, state: migrateLegacyState(stored) };
}

async function persistProviderState(state) {
  await chrome.storage.local.set({
    config: state.config,
    providerProfiles: state.providerProfiles,
    activeProfileId: state.activeProfileId,
  });
}

function runtimeConfig(state) {
  const active = activeProfile(state);
  return normalize({
    ...DEFAULT_CONFIG,
    ...state.config,
    ...active,
    profileName: active.name,
    activeProfileId: active.id,
  });
}

function activeProfile(state) {
  const active = state.providerProfiles.find((profile) => profile.id === state.activeProfileId);
  if (!active) throw new Error('当前 Profile 不存在');
  return active;
}

function pickProfileFields(patch) {
  return Object.fromEntries(PROFILE_KEYS
    .filter((key) => Object.hasOwn(patch, key))
    .map((key) => [key, patch[key]]));
}

function pickGlobalFields(patch) {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => (
    !PROFILE_KEYS.includes(key) && !RUNTIME_ONLY_KEYS.has(key)
  )));
}

function withoutProfileKeys(config) {
  const result = { ...config };
  for (const key of PROFILE_KEYS) delete result[key];
  return result;
}

function sameState(stored, state) {
  return JSON.stringify({
    config: stored.config,
    providerProfiles: stored.providerProfiles,
    activeProfileId: stored.activeProfileId,
  }) === JSON.stringify(state);
}

function normalize(cfg) {
  const out = { ...cfg };
  // autoIntercept was removed: ordinary PDF navigation must remain untouched.
  // Drop legacy persisted values so they cannot silently re-enable removed UX.
  delete out.autoIntercept;
  // v0.9.6：本地版面分析服务已移除，清理旧存储残留。
  delete out.useLayoutService;
  delete out.layoutServiceUrl;
  for (const k of NUMERIC_KEYS) out[k] = Number(out[k]);
  for (const k of BOOL_KEYS) out[k] = Boolean(out[k]);
  if (!Number.isFinite(out.temperature)) out.temperature = DEFAULT_CONFIG.temperature;
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONFIG.concurrency;
  out.concurrency = Math.min(16, Math.max(1, Math.round(out.concurrency)));
  if (typeof out.baseUrl === 'string') out.baseUrl = out.baseUrl.trim();
  if (typeof out.chatProfileId !== 'string') out.chatProfileId = '';
  else out.chatProfileId = out.chatProfileId.trim();
  if (typeof out.obsidianBaseUrl === 'string') {
    out.obsidianBaseUrl = out.obsidianBaseUrl.trim().replace(/\/+$/u, '');
  }
  if (!out.obsidianBaseUrl) out.obsidianBaseUrl = DEFAULT_CONFIG.obsidianBaseUrl;
  if (typeof out.obsidianApiKey !== 'string') out.obsidianApiKey = '';
  if (typeof out.obsidianFolder === 'string') {
    out.obsidianFolder = out.obsidianFolder.trim().replace(/^\/+|\/+$/gu, '');
  }
  if (!out.obsidianFolder) out.obsidianFolder = DEFAULT_CONFIG.obsidianFolder;
  return out;
}
