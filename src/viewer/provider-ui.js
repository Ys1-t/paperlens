export function createLatestConfigRefresher(loadConfig, commitConfig) {
  let generation = 0;

  return async function refreshLatestConfig() {
    const currentGeneration = ++generation;
    const config = await loadConfig();
    if (currentGeneration !== generation) return false;
    commitConfig(config);
    return true;
  };
}

export function renderPublicProviderState(elements, config, openOptions = () => {}) {
  const { profileSelect, profileModelStatus, configTip } = elements;
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const documentRef = profileSelect.ownerDocument;

  profileSelect.replaceChildren();
  for (const profile of profiles) {
    const option = documentRef.createElement('option');
    option.value = String(profile.id ?? '');
    option.textContent = String(profile.name ?? '');
    profileSelect.appendChild(option);
  }

  const active = profiles.find((profile) => profile.id === config?.activeProfileId) || null;
  profileSelect.value = active ? String(active.id) : '';
  profileSelect.disabled = profiles.length === 0;

  const model = String(active?.model || '未配置模型');
  profileModelStatus.textContent = active?.hasApiKey ? model : `${model} · 缺少 Key`;
  profileModelStatus.classList.toggle('missing-key', Boolean(active && !active.hasApiKey));
  profileModelStatus.title = active
    ? `${String(active.name ?? '')} · ${String(active.provider ?? '')} · ${model} · API Key ${active.hasApiKey ? '已配置' : '未配置'}`
    : '没有可用的模型 Profile';

  configTip.replaceChildren();
  if (!config?.hasApiKey) {
    configTip.append('⚠ 尚未配置 API Key。');
    const link = documentRef.createElement('a');
    link.href = '#';
    link.textContent = '点此打开设置';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openOptions();
    });
    configTip.appendChild(link);
    return;
  }

  const modelName = documentRef.createElement('b');
  modelName.textContent = String(config.model ?? '');
  configTip.append(
    '当前模型：',
    modelName,
    `（${String(config.provider ?? '')}）— 视觉翻译需支持看图的模型（如 GPT-4o / Gemini / DeepSeek-VL）`,
  );
}

export async function switchProviderProfileForNewRequests({
  id,
  activeProfileId,
  select,
  activate,
  refresh,
  showToast,
}) {
  if (!id || id === activeProfileId) return false;

  const previousValue = activeProfileId || select.value;
  const previousDisabled = select.disabled;
  select.disabled = true;

  try {
    await activate(id);
    await refresh();
    showToast('已切换 Profile；新请求将使用该供应商。');
    return true;
  } catch (error) {
    let restoredByRefresh = false;
    try { restoredByRefresh = await refresh(); } catch { /* 使用本地快照恢复 */ }
    if (!restoredByRefresh) select.value = previousValue;
    showToast(`切换 Profile 失败：${error.message || String(error)}`, true);
    return false;
  } finally {
    select.disabled = previousDisabled;
  }
}
