export function handleOpenViewerResponse({ response, lastError, close, showError }) {
  const error = lastError?.message || (!response?.ok && response?.error);
  if (error || !response?.ok) {
    showError(`打开阅读器失败：${error || '后台未返回成功结果'}。请重试。`);
    return false;
  }

  close();
  return true;
}
