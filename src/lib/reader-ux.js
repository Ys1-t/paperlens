function stringValue(value) {
  return typeof value === 'string' ? value : String(value?.message || value || '');
}

/** 后台 Port 断开 / 扩展重载 / SW 被回收导致的连接类错误（可重试）。 */
export function isBackgroundConnectionError(error) {
  const raw = stringValue(error);
  return /与后台的连接|连接已断开|后台.*断开|后台.*重载|扩展.*更新|extension context invalidated|receiving end does not exist|could not establish connection|message port closed|disconnected port|ping 超时|Translation port disconnected/i
    .test(raw);
}

export function friendlyReaderError(error) {
  const raw = stringValue(error).trim();
  if (!raw) return '本页暂时未完成，请重试。';
  if (/api\s*key|missing.?key|尚未配置/i.test(raw)) {
    return '尚未配置可用的模型，请先打开设置。';
  }
  if (/401|403|unauthori[sz]ed|forbidden|鉴权|认证/i.test(raw)) {
    return '模型授权失败，请检查当前供应商的 API Key。';
  }
  if (/429|rate.?limit|quota|额度|频率/i.test(raw)) {
    return '模型服务繁忙或额度不足，请稍后重试。';
  }
  // 排队等待超时（并发槽位被占满）与模型响应超时是不同的故障，保持可区分。
  if (/translation_queue_timeout|排队(?:等待)?超时/i.test(raw)) {
    return '排队等待超时：前方任务较多（多篇并行时更常见），请稍后重试本页。';
  }
  if (/timed?\s*out|timeout|超时|无响应/i.test(raw)) {
    return '模型响应较慢，本页可以稍后重试。';
  }
  // 后台 Port 断开优先于泛化的「网络中断」匹配。
  if (isBackgroundConnectionError(raw)) {
    return '与后台连接中断（同时翻译多篇、扩展重载或浏览器回收后台时较常见）。请点「重试本页」或顶部「重试」；仍不行请刷新阅读器标签页。';
  }
  if (/failed to fetch|network|fetch failed|load failed|连接.*中断/i.test(raw)) {
    return '网络连接中断，请检查模型服务后重试。';
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|模型.*空|empty response/i.test(raw)) {
    return '模型服务暂时不可用，请稍后重试。';
  }
  if (/placeholder|占位符|公式.*校验/i.test(raw)) {
    return '公式保护校验未通过，原公式已保留，请重试本页。';
  }
  if (/extension context invalidated|扩展.*更新|后台.*重载/i.test(raw)) {
    return '扩展已经更新，请刷新当前阅读器页面。';
  }
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
}

/**
 * Toolbar progress copy must stay short enough to never ellipsis-truncate.
 * Full sentence goes in `detail` (title / screen-reader hint).
 */
export function buildReaderProgress({ total = 0, done = 0, inProgress = 0, issues = 0 } = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.min(safeTotal, Math.max(0, Number(done) || 0));
  const safeProgress = Math.max(0, Number(inProgress) || 0);
  const safeIssues = Math.max(0, Number(issues) || 0);
  const percent = safeTotal ? Math.round((safeDone / safeTotal) * 100) : 0;
  const pages = `${safeDone}/${safeTotal}`;

  if (!safeTotal) return { label: '', detail: '', tone: 'idle', percent: 0 };
  if (safeDone >= safeTotal) {
    return {
      label: `${safeTotal}/${safeTotal} 页`,
      detail: `全文翻译完成 · ${safeTotal} 页`,
      tone: 'success',
      percent: 100,
    };
  }
  if (safeIssues > 0) {
    return {
      label: `${pages} · ${safeIssues}待处理`,
      detail: `${safeDone}/${safeTotal} 页完成 · ${safeIssues} 页待处理`,
      tone: 'warning',
      percent,
    };
  }
  if (safeProgress > 0) {
    return {
      label: `${pages} 页`,
      detail: `正在翻译 · ${safeDone}/${safeTotal} 页完成`,
      tone: 'busy',
      percent,
    };
  }
  return {
    label: `0/${safeTotal} 页`,
    detail: `准备翻译 · 共 ${safeTotal} 页`,
    tone: 'idle',
    percent,
  };
}

export function buildPagePresentation(page = {}) {
  const unresolved = Math.max(0, Number(page.unresolvedCount) || 0);
  if (page.active && page.qualityWarning) {
    return { label: '精修中 · 译文可读', tone: 'warning', retry: false };
  }
  if (page.active) return { label: page.phase === 'waiting-layout' ? '正在识别版面' : '正在翻译', tone: 'busy', retry: false };
  if (page.qualityWarning) {
    return { label: '译文可读 · 待精修', tone: 'warning', retry: true };
  }
  if (page.outcome === 'failed' || page.error) return { label: '需要重试', tone: 'error', retry: true };
  if (page.outcome === 'done') return { label: '已完成', tone: 'success', retry: false };
  if (page.outcome === 'partial') {
    return { label: unresolved ? `${unresolved} 处待补全` : '部分待补全', tone: 'warning', retry: true };
  }
  return { label: '等待翻译', tone: 'idle', retry: false };
}
