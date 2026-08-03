export const PROFILE_KEYS = ['provider', 'protocol', 'baseUrl', 'apiKey', 'model'];

const DEFAULT_PROFILE = {
  name: '默认配置',
  provider: 'openai',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
};

export function toPublicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: Boolean(profile.apiKey),
    keySuffix: profile.apiKey ? profile.apiKey.slice(-2) : '',
  };
}

export function validateProfile(profile) {
  if (!profile.name?.trim() || !profile.apiKey?.trim() || !profile.model?.trim()) {
    throw new Error('名称、API Key 和模型不能为空');
  }
  if (!['openai', 'gemini'].includes(profile.protocol)) {
    throw new Error('协议必须是 openai 或 gemini');
  }
  if (!profile.baseUrl?.trim()) throw new Error('Base URL 不能为空');
  const rawBaseUrl = profile.baseUrl.trim();

  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error('Base URL 不是合法 URL');
  }

  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Base URL 必须使用 HTTPS，本机地址除外');
  }
  if (url.username || url.password) throw new Error('Base URL 不允许包含凭据');
  if (url.hash || rawBaseUrl.includes('#')) throw new Error('Base URL 不允许包含 fragment');
  for (const key of url.searchParams.keys()) {
    if (/^(key|api_key|apikey|api-key|x-api-key|token|access_token)$/i.test(key)) {
      throw new Error('Base URL 不允许包含敏感参数');
    }
  }

  const queryIndex = rawBaseUrl.indexOf('?');
  const pathPart = queryIndex < 0 ? rawBaseUrl : rawBaseUrl.slice(0, queryIndex);
  const queryPart = queryIndex < 0 ? '' : rawBaseUrl.slice(queryIndex);

  return {
    ...profile,
    name: profile.name.trim(),
    baseUrl: `${pathPart.replace(/\/+$/, '')}${queryPart}`,
    apiKey: profile.apiKey.trim(),
    model: profile.model.trim(),
  };
}

export function migrateLegacyState(state = {}, generateId = defaultIdGenerator) {
  if (Array.isArray(state.providerProfiles)) {
    return repairProviderState(state, DEFAULT_PROFILE, generateId);
  }

  const profile = {
    ...legacyProfileFromConfig(state.config),
    id: generateId(),
    name: '默认配置',
  };
  return {
    ...state,
    config: withoutProfileKeys(state.config),
    providerProfiles: [profile],
    activeProfileId: profile.id,
  };
}

export function repairProviderState(
  state = {},
  fallbackProfile = DEFAULT_PROFILE,
  generateId = defaultIdGenerator,
) {
  const seenIds = new Set();
  const profiles = [];
  for (const candidate of Array.isArray(state.providerProfiles) ? state.providerProfiles : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    let id = typeof candidate.id === 'string' && candidate.id ? candidate.id : generateUniqueId(generateId, seenIds);
    if (seenIds.has(id)) id = generateUniqueId(generateId, seenIds);
    seenIds.add(id);
    profiles.push({ ...candidate, id });
  }

  if (profiles.length === 0) {
    const id = generateUniqueId(generateId, seenIds);
    profiles.push({ ...DEFAULT_PROFILE, ...fallbackProfile, id, name: '默认配置' });
  }

  const activeProfileId = profiles.some((profile) => profile.id === state.activeProfileId)
    ? state.activeProfileId
    : profiles[0].id;

  return {
    ...state,
    config: withoutProfileKeys(state.config),
    providerProfiles: profiles,
    activeProfileId,
  };
}

export function createProviderProfile(state, profile, generateId = defaultIdGenerator) {
  const profiles = requireProfiles(state);
  const ids = new Set(profiles.map((item) => item.id));
  const id = generateUniqueId(generateId, ids);
  const created = validateProfile({ ...profile, id });
  return { ...state, providerProfiles: [...profiles, created] };
}

export function saveProviderProfile(state, profile) {
  const profiles = requireProfiles(state);
  const index = profiles.findIndex((item) => item.id === profile?.id);
  if (index < 0) throw new Error('Profile 不存在');
  const saved = validateProfile({ ...profile, id: profiles[index].id });
  const nextProfiles = profiles.slice();
  nextProfiles[index] = saved;
  return { ...state, providerProfiles: nextProfiles };
}

export function duplicateProviderProfile(state, id, generateId = defaultIdGenerator) {
  const profiles = requireProfiles(state);
  const source = findProfile(profiles, id);
  const ids = new Set(profiles.map((profile) => profile.id));
  const duplicate = {
    ...source,
    id: generateUniqueId(generateId, ids),
    name: `${source.name} 副本`,
  };
  return { ...state, providerProfiles: [...profiles, duplicate] };
}

export function renameProviderProfile(state, id, name) {
  const profiles = requireProfiles(state);
  const trimmedName = name?.trim();
  if (!trimmedName) throw new Error('Profile 名称不能为空');
  findProfile(profiles, id);
  return {
    ...state,
    providerProfiles: profiles.map((profile) => (
      profile.id === id ? { ...profile, name: trimmedName } : profile
    )),
  };
}

export function deleteProviderProfile(state, id) {
  const profiles = requireProfiles(state);
  findProfile(profiles, id);
  if (profiles.length === 1) throw new Error('至少保留一个 Profile');
  const remaining = profiles.filter((profile) => profile.id !== id);
  return {
    ...state,
    providerProfiles: remaining,
    activeProfileId: state.activeProfileId === id ? remaining[0].id : state.activeProfileId,
  };
}

export function activateProviderProfile(state, id) {
  const profiles = requireProfiles(state);
  findProfile(profiles, id);
  return { ...state, activeProfileId: id };
}

function legacyProfileFromConfig(config = {}) {
  return {
    ...DEFAULT_PROFILE,
    ...Object.fromEntries(PROFILE_KEYS.map((key) => [key, config?.[key]])),
    name: '默认配置',
    provider: config?.provider ?? DEFAULT_PROFILE.provider,
    protocol: config?.protocol ?? DEFAULT_PROFILE.protocol,
    baseUrl: config?.baseUrl ?? DEFAULT_PROFILE.baseUrl,
    apiKey: config?.apiKey ?? DEFAULT_PROFILE.apiKey,
    model: config?.model ?? DEFAULT_PROFILE.model,
  };
}

function withoutProfileKeys(config = {}) {
  const result = { ...(config || {}) };
  for (const key of PROFILE_KEYS) delete result[key];
  return result;
}

function requireProfiles(state) {
  if (!Array.isArray(state?.providerProfiles) || state.providerProfiles.length === 0) {
    throw new Error('至少保留一个 Profile');
  }
  return state.providerProfiles;
}

function findProfile(profiles, id) {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new Error('Profile 不存在');
  return profile;
}

function generateUniqueId(generateId, existingIds) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = generateId();
    if (typeof id === 'string' && id && !existingIds.has(id)) return id;
  }
  throw new Error('无法生成唯一的 Profile ID');
}

function defaultIdGenerator() {
  return crypto.randomUUID();
}
