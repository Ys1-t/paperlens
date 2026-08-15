// PaperLens PWA（手机自用版）：复用扩展的核心库（translator / cache / reading-mode），
// 只重写壳与布局。不改动扩展任何文件；扩展打包（scripts/pack.mjs 只收 src/）不受影响。
//
// 对照策略（v1）：译文卡片流为主；「对照」开关在每页译文下方展开原版页位图；
// 每页页头「看原版」单独展开。译文缓存身份与扩展完全一致（同一页同配置不再花钱）。

import { translate } from '../src/lib/translator.js';
import { cacheGet, cacheSet, hashKey, hashKeyStrong } from '../src/lib/cache.js';
import { buildTranslationCacheIdentity, isCacheableTranslation } from '../src/lib/translation-cache.js';
import {
  assessVisionTranslationQuality,
  buildVisionTranslationContext,
  finalizeReadingTranslation,
  selectVisionRenderWidth,
} from '../src/lib/reading-mode.js';
import { parsePaperPack } from '../src/lib/paper-pack.js';
import { glossaryFingerprintForText, normalizeGlossary } from '../src/lib/glossary.js';
import { renderMarkdownWithMath } from '../src/lib/markdown-math.js';
import { chat } from '../src/lib/translator.js';
import {
  RESEARCH_AGENT_MAX_ROUNDS,
  researchAgentSystemPrompt,
  parseAgentResponse,
  dedupeResearchToolCalls,
  formatToolResultsForModel,
  executeResearchTool,
  buildAgentBootstrap,
} from '../src/lib/research-agent.js';
import {
  isStandaloneDisplay,
  shouldShowIosInstallHint,
  installBannerCopy,
  shouldUseSplitCompare,
  swipeFromDelta,
  nextUntranslatedPage,
  untranslatedCount,
  cycleFontLevel,
  fontSizePx,
  nextTheme,
  dockPageLabel,
  clampPage,
  readingProgressRatio,
  parseGotoPage,
  searchTranslationHits,
  selectionPopoverActions,
  clipSelection,
  mobileAgentStarters,
  askPagePrompt,
  extractCitedPages,
  readingAgentFollowUps,
  buildMobilePaperProvider,
  extractBootstrapBrief,
  parseArxivId,
  arxivPdfUrl,
  arxivAbsUrl,
  parseArxivAtomXml,
  upsertLibraryEntry,
  upsertDraft,
  toggleLibraryStar,
  removeLibraryEntry,
  scoreMobileRadarPaper,
  sortRadarByScore,
  parseKeywordList,
  extractCopyableLatex,
} from './mobile-ux.js';

const CONFIG_KEY = 'paperlens.app.config.v1';
const RESUME_KEY = 'paperlens.app.resume.v1';
const GLOSSARY_KEY = 'paperlens.app.glossary.v1';
const UI_KEY = 'paperlens.app.ui.v1';
const PRESETS = {
  deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai: { protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  proxy: { protocol: 'openai', baseUrl: '', model: 'gemini-2.5-flash' },
  gemini: { protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
};

const els = {
  empty: document.getElementById('empty'),
  pages: document.getElementById('pages'),
  fileInput: document.getElementById('file-input'),
  docTitle: document.getElementById('doc-title'),
  dock: document.getElementById('dock'),
  dockSrc: document.getElementById('dock-src'),
  dockPage: document.getElementById('dock-page'),
  dockPageLabel: document.getElementById('dock-page-label'),
  dockPrev: document.getElementById('dock-prev'),
  dockNext: document.getElementById('dock-next'),
  settings: document.getElementById('settings'),
  toast: document.getElementById('toast'),
  agentDrawer: document.getElementById('agent-drawer'),
  agentLog: document.getElementById('agent-log'),
  agentInput: document.getElementById('agent-input'),
  agentForm: document.getElementById('agent-form'),
  agentQuick: document.getElementById('agent-quick'),
  dockAgent: document.getElementById('dock-agent'),
  dockTranslate: document.getElementById('dock-translate'),
};

const state = {
  pdf: null,
  docName: '',
  generation: 0,
  pages: [], // {num, card, body, statusEl, shotWrap, translated, started, sourceText}
  observer: null,
  compareMode: false,
  concurrent: 0,
};
const MAX_CONCURRENT = 2;

// ---------------------------------------------------------------------------
// 基础 UI
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(message, isError = false) {
  els.toast.textContent = String(message || '');
  els.toast.style.background = isError ? 'rgba(153,27,27,.95)' : 'rgba(31,41,55,.94)';
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

function loadAppConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { return {}; }
}
function saveAppConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// 术语表：论文包导入时并入（后写覆盖先写），翻译请求随 config.glossary 注入,
// 缓存身份带页面级术语指纹——与扩展端行为完全一致。
function loadAppGlossary() {
  try { return normalizeGlossary(JSON.parse(localStorage.getItem(GLOSSARY_KEY)) || []); } catch { return []; }
}
function mergeAppGlossary(items) {
  const merged = normalizeGlossary([...loadAppGlossary(), ...(Array.isArray(items) ? items : [])]);
  try { localStorage.setItem(GLOSSARY_KEY, JSON.stringify(merged)); } catch { /* 隐私模式 */ }
  return merged;
}

// ---------------------------------------------------------------------------
// 设置抽屉
// ---------------------------------------------------------------------------
function bindSettings() {
  const $ = (id) => document.getElementById(id);
  const open = () => {
    const cfg = loadAppConfig();
    $('cfg-protocol').value = cfg.protocol || 'openai';
    $('cfg-baseurl').value = cfg.baseUrl || '';
    $('cfg-apikey').value = cfg.apiKey || '';
    $('cfg-model').value = cfg.model || '';
    $('cfg-lang').value = cfg.targetLang || '简体中文';
    els.settings.hidden = false;
  };
  document.getElementById('btn-settings').addEventListener('click', open);
  document.getElementById('settings-close').addEventListener('click', () => { els.settings.hidden = true; });
  els.settings.addEventListener('click', (e) => { if (e.target === els.settings) els.settings.hidden = true; });
  for (const btn of els.settings.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      $('cfg-protocol').value = preset.protocol;
      if (preset.baseUrl) $('cfg-baseurl').value = preset.baseUrl;
      if (!$('cfg-model').value) $('cfg-model').value = preset.model;
      for (const b of els.settings.querySelectorAll('[data-preset]')) b.classList.toggle('on', b === btn);
    });
  }
  document.getElementById('settings-save').addEventListener('click', () => {
    const cfg = {
      protocol: $('cfg-protocol').value || 'openai',
      baseUrl: $('cfg-baseurl').value.trim().replace(/\/+$/u, ''),
      apiKey: $('cfg-apikey').value.trim(),
      model: $('cfg-model').value.trim(),
      targetLang: $('cfg-lang').value.trim() || '简体中文',
    };
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) { showToast('Base URL / API Key / 模型都需要填写', true); return; }
    saveAppConfig(cfg);
    els.settings.hidden = true;
    showToast('已保存设置');
  });
}

// ---------------------------------------------------------------------------
// PDF 打开与页卡片
// ---------------------------------------------------------------------------
// 入口分流：.json 按论文包解析（PDF + 已译页），.pdf 走普通打开。
async function openPickedFile(file) {
  const name = String(file?.name || '');
  if (/\.json$/iu.test(name)) {
    let pack;
    try {
      pack = parsePaperPack(await file.text());
    } catch (e) {
      showToast(String(e?.message || e || '论文包无法解析'), true);
      return;
    }
    const pdfFile = new File([pack.pdfBytes], `${pack.title || 'paper'}.pdf`, { type: 'application/pdf' });
    if (pack.glossary?.length) {
      const merged = mergeAppGlossary(pack.glossary);
      showToast(`已并入 ${pack.glossary.length} 条锁定术语（本机共 ${merged.length} 条）`);
    }
    await openPdfFile(pdfFile, { pack });
    showToast(`论文包已打开：${pack.translatedCount} 页译文直接可读，其余页滚动到时在线翻译。`);
    return;
  }
  await openPdfFile(file);
}

async function openPdfFile(file, { pack = null } = {}) {
  if (!window.pdfjsLib) { showToast('PDF.js 未能加载', true); return; }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../src/vendor/pdf.worker.min.js', import.meta.url).href;
  const generation = ++state.generation;
  state.docName = file.name || 'paper.pdf';
  els.docTitle.textContent = state.docName;
  els.empty.hidden = true;
  els.pages.hidden = false;
  els.dock.hidden = false;
  document.body.classList.add('doc-open');
  els.pages.textContent = '';
  state.pages = [];
  state.observer?.disconnect();
  closePageGrid(); // 换文档时关闭网格并使在途缩略图失效

  let pdf;
  try {
    const data = await file.arrayBuffer();
    if (generation !== state.generation) return;
    pdf = await window.pdfjsLib.getDocument({ data }).promise;
  } catch (e) {
    showToast('无法打开 PDF：' + (e?.message || e), true);
    return;
  }
  if (generation !== state.generation) { pdf.destroy?.(); return; }
  state.pdf = pdf;

  for (let num = 1; num <= pdf.numPages; num += 1) {
    const card = document.createElement('article');
    card.className = 'page-card';
    card.dataset.page = String(num);
    const head = document.createElement('div');
    head.className = 'page-head';
    const label = document.createElement('span');
    label.textContent = `第 ${num} 页`;
    const shotBtn = document.createElement('button');
    shotBtn.type = 'button';
    shotBtn.className = 'shot-toggle';
    shotBtn.textContent = '看原版';
  const askBtn = document.createElement('button');
  askBtn.type = 'button';
  askBtn.className = 'ask-page-btn';
  askBtn.textContent = '问此页';
  askBtn.addEventListener('click', () => {
    setAgentOpen(true);
    void runMobileAgent(askPagePrompt(num));
  });
  head.append(label, shotBtn, askBtn, status);
    const body = document.createElement('div');
    body.className = 'page-body loading';
    body.textContent = '滚动到本页时自动翻译…';
    const shotWrap = document.createElement('div');
    shotWrap.className = 'page-shot-wrap';
    shotWrap.hidden = true;
    // 原版图放在页头正下方（译文上方）：点「看原版」立即可见——
    // 曾放卡片底部，长译文页时图在视口外，看起来像按钮没反应。
    card.append(head, shotWrap, body);
    els.pages.appendChild(card);
    const page = {
      num, card, body, statusEl: status, shotWrap, translated: '', started: false, sourceText: '',
    };
    shotBtn.addEventListener('click', () => togglePageShot(page));
    state.pages.push(page);
    // 论文包预填：已译页立即渲染并标记完成，懒加载翻译不再触发（零成本）。
    const packed = pack?.translations?.[String(num)];
    if (packed) {
      page.translated = packed;
      page.started = true;
      renderTranslation(page, packed);
      status.textContent = '已导入';
    }
  }
  updateDockPage();
  setupLazyTranslate(generation);
  restoreResume(file);
  applyIpadSplit();
  rememberOpenedPaper();
  updateReadProgress();
}

// 宽屏（iPad 横屏 / 桌面）双栏对照：左原版右译文。CSS 负责布局，
// JS 负责懒渲染左列原版位图（滚到哪页渲到哪页，避免整本一次性渲染）。
function isWideMode() {
  return window.matchMedia('(min-width: 1000px)').matches;
}

function setupLazyTranslate(generation) {
  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const num = Number(entry.target.dataset.page);
      const page = state.pages[num - 1];
      if (page && !page.started) queueTranslate(page, generation);
      if ((state.compareMode || isWideMode()) && page && !page.shotWrap.firstChild) {
        renderPageShot(page).catch(() => {});
      }
    }
  }, { rootMargin: '600px 0px' });
  for (const page of state.pages) state.observer.observe(page.card);
}

// 旋转/分屏切换进入宽屏时，补渲染视口附近的原版页。
window.matchMedia('(min-width: 1000px)').addEventListener?.('change', (e) => {
  if (!e.matches || !state.pages.length) return;
  for (const page of state.pages) {
    const rect = page.card.getBoundingClientRect();
    if (rect.bottom > -600 && rect.top < window.innerHeight + 600 && !page.shotWrap.firstChild) {
      renderPageShot(page).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// 翻译（复用扩展核心：同缓存身份 → 同一页同配置不再花钱）
// ---------------------------------------------------------------------------
const queue = [];
function queueTranslate(page, generation) {
  page.started = true;
  queue.push({ page, generation });
  pumpQueue();
}
function pumpQueue() {
  while (state.concurrent < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.generation !== state.generation) continue;
    state.concurrent += 1;
    translateOnePage(job.page, job.generation)
      .catch(() => {})
      .finally(() => { state.concurrent -= 1; pumpQueue(); });
  }
}

async function renderPageBitmap(page, width) {
  const pdfPage = await state.pdf.getPage(page.num);
  const base = pdfPage.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.9);
  canvas.width = 0; canvas.height = 0;
  return { url, pdfPage };
}

async function translateOnePage(page, generation) {
  const cfg = loadAppConfig();
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    page.statusEl.textContent = '未配置';
    page.body.textContent = '请先点右上角 ⚙ 配置模型 API，再下拉刷新本页（滚动离开再回来即可重试）。';
    page.started = false;
    return;
  }
  // 术语表注入 + 页面级指纹（与扩展 service-worker 相同的两步）。
  const glossary = loadAppGlossary();
  page.statusEl.textContent = '渲染中';
  try {
    // 原文文本提示（两信号翻译；扫描页可为空）
    const pdfPage = await state.pdf.getPage(page.num);
    try {
      const tc = await pdfPage.getTextContent();
      page.sourceText = (tc.items || []).map((it) => String(it.str || '')).join(' ')
        .replace(/\s+/gu, ' ').trim();
    } catch { page.sourceText = ''; }
  } catch (e) {
    if (generation !== state.generation) return;
    failPageUi(page, '页面渲染失败：' + (e?.message || e));
    return;
  }
  if (generation !== state.generation) return;
  cfg.glossary = glossary;
  cfg.glossaryFingerprint = glossaryFingerprintForText(glossary, page.sourceText);
  const sourceChars = page.sourceText.replace(/\s+/gu, '').length;

  // 质量门失败自动升清重试一次（与扩展策略同源：低温 + 更高分辨率 + 绕过缓存）。
  const attempts = [
    { width: selectVisionRenderWidth({ sourceChars }), qualityRetry: false },
    { width: selectVisionRenderWidth({ sourceChars, qualityRetry: true }), qualityRetry: true },
  ];
  let lastQuality = null;
  for (const attempt of attempts) {
    const outcome = await translatePageAttempt(page, generation, cfg, attempt, lastQuality);
    if (generation !== state.generation || outcome === 'stale') return;
    if (outcome === 'ok' || outcome === 'error') return;
    lastQuality = outcome; // 质量对象 → 带失败原因进入高清重试
    page.statusEl.textContent = '精修中';
  }
  // 两次都未过质量门：保留最后一稿（可读优先），标注建议对照原文。
  page.statusEl.textContent = '完成·建议对照';
}

// 单次翻译尝试。返回 'ok' | 'error' | 'stale' | quality 对象（质量门未过，可重试）。
async function translatePageAttempt(page, generation, cfg, { width, qualityRetry }, lastQuality) {
  let bitmap;
  try {
    bitmap = await renderPageBitmap(page, width);
  } catch (e) {
    if (generation !== state.generation) return 'stale';
    failPageUi(page, '页面渲染失败：' + (e?.message || e));
    return 'error';
  }
  if (generation !== state.generation) return 'stale';

  const requestText = buildVisionTranslationContext({
    sourceText: page.sourceText,
    quality: qualityRetry ? lastQuality : null,
  });
  // 与扩展 service-worker 完全一致的缓存身份：IMG 载荷 + 配置身份（含术语指纹）。
  const payload = 'IMG:' + hashKey(bitmap.url);
  const cacheKey = hashKeyStrong(buildTranslationCacheIdentity(cfg, payload));
  if (!qualityRetry) {
    try {
      const cached = await cacheGet(cacheKey);
      if (cached != null) {
        page.translated = cached;
        renderTranslation(page, cached);
        page.statusEl.textContent = '缓存';
        return 'ok';
      }
    } catch { /* 缓存不可用继续在线翻译 */ }
  }

  page.statusEl.textContent = qualityRetry ? '高清重译中' : '翻译中';
  if (!page.translated) {
    page.body.classList.add('loading');
    page.body.textContent = '模型思考中…';
  }
  let raw = '';
  let renderPending = false;
  const renderDelta = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (generation !== state.generation) return;
      renderTranslation(page, raw, { streaming: true });
    });
  };
  try {
    const full = await translate({
      config: cfg,
      text: requestText,
      image: bitmap.url,
      onDelta: (delta) => { raw += String(delta || ''); renderDelta(); },
      onStatus: (phase) => { if (phase === 'thinking') page.statusEl.textContent = '思考中'; },
    });
    if (generation !== state.generation) return 'stale';
    const finalText = finalizeReadingTranslation(raw, full);
    const quality = assessVisionTranslationQuality(finalText, {
      targetLang: cfg.targetLang || '简体中文',
      sourceText: page.sourceText,
    });
    // 可读优先：新稿只要非空就先显示，质量门决定是否再精修一轮。
    if (String(finalText || '').trim()) {
      page.translated = finalText;
      renderTranslation(page, finalText);
    }
    if (!quality.ok && !qualityRetry) return quality; // 触发高清重试
    if (quality.ok) {
      page.statusEl.textContent = '完成';
      page.statusEl.classList.remove('err');
      if (isCacheableTranslation(finalText)) {
        try { await cacheSet(cacheKey, finalText); } catch { /* 配额满可忽略 */ }
      }
      return 'ok';
    }
    return quality; // 第二次仍未过：外层收尾为「完成·建议对照」
  } catch (e) {
    if (generation !== state.generation) return 'stale';
    const message = String(e?.message || e || '');
    const cors = /failed to fetch|networkerror|load failed/i.test(message)
      ? '（若反复失败，可能是该服务不允许网页跨域调用 CORS，请换官方 API 或支持 CORS 的中转站）' : '';
    // 已有可读旧稿（高清重试失败）时保留旧稿，只提示。
    if (page.translated) {
      page.statusEl.textContent = '完成·精修失败';
      showToast(`第 ${page.num} 页精修失败：${message}`, true);
      return 'error';
    }
    failPageUi(page, `翻译失败：${message} ${cors}\n滚动离开本页再回来即自动重试。`);
    return 'error';
  }
}

function failPageUi(page, message) {
  page.statusEl.textContent = '失败';
  page.statusEl.classList.add('err');
  page.body.classList.remove('loading');
  page.body.textContent = message;
  page.started = false;
}

// ---------------------------------------------------------------------------
// 渲染：Markdown + KaTeX + 媒体 token 占位
// ---------------------------------------------------------------------------
function renderTranslation(page, markdown, { streaming = false } = {}) {
  const marked = window.marked?.parse ? window.marked : (typeof window.marked === 'function' ? { parse: window.marked } : null);
  // 共享渲染管线（src/lib/markdown-math.js）：公式先占位保护再过 marked
  // （防止 $..$ 里的 * _ [ ] 被当 Markdown 语法拆散），```algorithm 围栏
  // 提升为普通块（KaTeX auto-render 默认跳过 pre/code），最后 KaTeX。
  renderMarkdownWithMath(page.body, markdown, {
    parse: (s) => (marked ? marked.parse(s) : ''),
    autoRender: window.renderMathInElement,
    transformHtml: (html) => html
      .replaceAll('@@FIGURE@@', '<span class="media-token">🖼 图 · 点本页「看原版」查看</span>')
      .replaceAll('@@TABLE@@', '<span class="media-token">▤ 表 · 点本页「看原版」查看</span>'),
  });
  page.body.classList.remove('loading');
  void streaming; // 流式与最终渲染共用同一管线；KaTeX 只处理成对定界符，不闪烁
}

// ---------------------------------------------------------------------------
// 原版页对照
// ---------------------------------------------------------------------------
async function renderPageShot(page) {
  if (page.shotWrap.firstChild) { page.shotWrap.hidden = false; return; }
  const width = Math.min(1400, Math.round((window.innerWidth || 390) * (window.devicePixelRatio || 2)));
  const { url } = await renderPageBitmap(page, width);
  const img = document.createElement('img');
  img.className = 'page-shot';
  img.alt = `第 ${page.num} 页原版`;
  img.loading = 'lazy';
  img.src = url;
  page.shotWrap.appendChild(img);
  page.shotWrap.hidden = false;
}
function togglePageShot(page) {
  const btn = page.card.querySelector('.shot-toggle');
  if (!page.shotWrap.hidden && page.shotWrap.firstChild) {
    page.shotWrap.hidden = true;
    if (btn) btn.textContent = '看原版';
    return;
  }
  if (btn) btn.textContent = '加载原版…';
  renderPageShot(page).then(() => {
    if (btn) btn.textContent = '收起原版';
    // 原版图滚入视野：用户点了按钮，必须立刻看到结果。
    page.shotWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }).catch((e) => {
    if (btn) btn.textContent = '看原版';
    showToast('原版页渲染失败：' + (e?.message || e), true);
  });
}

// ---------------------------------------------------------------------------
// 底部工具条：对照开关 / 页码 / 回顶部
// ---------------------------------------------------------------------------
function currentVisiblePage() {
  let best = 1; let bestDist = Infinity;
  for (const page of state.pages) {
    const rect = page.card.getBoundingClientRect();
    const dist = Math.abs(rect.top - 80);
    if (dist < bestDist) { bestDist = dist; best = page.num; }
  }
  return best;
}
function updateDockPage() {
  els.dockPageLabel.textContent = dockPageLabel(
    state.pages.length ? currentVisiblePage() : 0,
    state.pages.length,
  );
}
function setCompareMode(on) {
  state.compareMode = Boolean(on);
  els.dockSrc?.classList.toggle('on', state.compareMode);
  document.body.classList.toggle('show-src', state.compareMode);
  if (state.compareMode) {
  if (state.compareMode || isWideMode()) {
    for (const page of state.pages) {
      const rect = page.card.getBoundingClientRect();
      if (rect.bottom > -600 && rect.top < window.innerHeight + 600) {
        renderPageShot(page).catch(() => {});
      }
    }
  } else if (!shouldUseSplitCompare(window.innerWidth)) {
    for (const page of state.pages) { page.shotWrap.hidden = true; }
  }
  } else if (!shouldUseSplitCompare(window.innerWidth)) {
    for (const page of state.pages) { page.shotWrap.hidden = true; }
  }
}
function applyIpadSplit() {
  const split = shouldUseSplitCompare(window.innerWidth);
  document.body.classList.toggle('ipad-split', split);
  if (split && state.pages.length) setCompareMode(true);
}
function jumpToReaderPage(n) {
  const page = state.pages[clampPage(n, state.pages.length) - 1];
  if (!page?.card) return;
  const last = page.num === state.pages.length;
  page.card.scrollIntoView({ block: last ? 'end' : 'start' });
  updateDockPage();
  updateReadProgress();
}

function updateReadProgress() {
  const bar = document.getElementById('read-progress');
  if (!bar) return;
  if (!state.pages.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const ratio = readingProgressRatio(currentVisiblePage(), state.pages.length);
  const fill = bar.querySelector('i');
  if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
}

function bindDock() {
  els.dockPrev?.addEventListener('click', () => jumpToReaderPage(currentVisiblePage() - 1));
  els.dockNext?.addEventListener('click', () => jumpToReaderPage(currentVisiblePage() + 1));
  els.dockSrc.addEventListener('click', () => {
    setCompareMode(!state.compareMode);
    showToast(state.compareMode ? '对照：每页附原版图' : '已关对照');
  });
  els.dockPage.addEventListener('click', () => openPageGrid());
  els.dockAgent?.addEventListener('click', () => setAgentOpen(true));
  els.dockTranslate?.addEventListener('click', () => {
    const n = untranslatedCount(state.pages);
    if (!n) { showToast('没有未译页'); return; }
    const from = currentVisiblePage();
    for (const page of state.pages) {
      if (!page.translated && !page.started) queueTranslate(page, state.generation);
    }
    const next = nextUntranslatedPage(state.pages, from);
    if (next) state.pages[next - 1]?.card.scrollIntoView({ block: 'start' });
    showToast(`开始补译 ${n} 页`);
  });
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      updateDockPage();
      updateReadProgress();
      saveResume();
    }, 200);
  }, { passive: true });
  window.addEventListener('resize', () => applyIpadSplit(), { passive: true });
}

// ---------------------------------------------------------------------------
// 全部页面预览：缩略图网格，点击跳页。缩略图 150px 懒渲染并缓存在 page 上，
// 打开网格只渲染滚入视口的格子，整本几百页也不卡。
// ---------------------------------------------------------------------------
const grid = {
  root: document.getElementById('grid'),
  list: document.getElementById('grid-list'),
  title: document.getElementById('grid-title'),
  observer: null,
  generation: 0,
};

async function renderPageThumb(page) {
  if (page.thumbUrl) return page.thumbUrl;
  const { url } = await renderPageBitmap(page, 150);
  page.thumbUrl = url;
  return url;
}

function gridStateClass(page) {
  if (page.statusEl?.classList?.contains('err')) return 'err';
  if (page.translated) return 'done';
  return '';
}

function openPageGrid() {
  if (!state.pages.length) return;
  const generation = ++grid.generation;
  const current = currentVisiblePage();
  grid.title.textContent = `全部页面 · ${state.pages.length} 页`;
  grid.list.replaceChildren();
  grid.observer?.disconnect();

  // 懒渲染缩略图：格子滚入网格视口才渲染。
  grid.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      grid.observer.unobserve(entry.target);
      const num = Number(entry.target.dataset.page);
      const page = state.pages[num - 1];
      const img = entry.target.querySelector('img');
      if (!page || !img || img.src) continue;
      void renderPageThumb(page).then((url) => {
        if (grid.generation === generation) img.src = url;
      }).catch(() => { /* 渲染失败格子留白，仍可点击跳页 */ });
    }
  }, { root: grid.list.closest('.sheet-panel'), rootMargin: '300px 0px' });

  for (const page of state.pages) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'grid-cell' + (page.num === current ? ' current' : '');
    cell.dataset.page = String(page.num);
    cell.setAttribute('aria-label', `跳到第 ${page.num} 页`);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    if (page.thumbUrl) img.src = page.thumbUrl;
    const num = document.createElement('span');
    num.className = 'grid-num';
    num.textContent = String(page.num);
    const dot = document.createElement('span');
    dot.className = `grid-state ${gridStateClass(page)}`.trim();
    cell.append(img, num, dot);
    cell.addEventListener('click', () => {
      closePageGrid();
      page.card.scrollIntoView({ block: 'start' });
      updateDockPage();
    });
    grid.list.appendChild(cell);
    if (!page.thumbUrl) grid.observer.observe(cell);
  }
  grid.root.hidden = false;
  // 当前页滚入视野居中，扫一眼就知道自己读到哪。
  grid.list.querySelector('.grid-cell.current')?.scrollIntoView({ block: 'center' });
}

function closePageGrid() {
  grid.generation += 1; // 使在途缩略图回填失效
  grid.observer?.disconnect();
  grid.root.hidden = true;
}

function bindPageGrid() {
  document.getElementById('grid-close').addEventListener('click', closePageGrid);
  grid.root.addEventListener('click', (e) => { if (e.target === grid.root) closePageGrid(); });
}

// ---------------------------------------------------------------------------
// 续读（同名同大小文件恢复滚动位置）
// ---------------------------------------------------------------------------
let resumeFileSig = '';
function saveResume() {
  if (!resumeFileSig || !state.pages.length) return;
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      sig: resumeFileSig, name: state.docName, page: currentVisiblePage(), at: Date.now(),
    }));
  } catch { /* 隐私模式可忽略 */ }
}
function restoreResume(file) {
  resumeFileSig = `${file.name}:${file.size}`;
  try {
    const saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (saved?.sig === resumeFileSig && saved.page > 1) {
      const page = state.pages[saved.page - 1];
      if (page) {
        setTimeout(() => {
          page.card.scrollIntoView({ block: 'start' });
          showToast(`已回到上次阅读的第 ${saved.page} 页`);
        }, 120);
      }
    }
  } catch { /* noop */ }
}
function showResumeHintOnEmpty() {
  try {
    const saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (saved?.name) {
      const hint = document.getElementById('resume-hint');
      hint.textContent = `上次读到《${saved.name}》第 ${saved.page} 页 — 重新选择该文件即可继续（译文走本地缓存，不再花钱）。`;
      hint.hidden = false;
    }
  } catch { /* noop */ }
}

function loadUiPrefs() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return {}; }
}
function saveUiPrefs(patch) {
  const next = { ...loadUiPrefs(), ...patch };
  try { localStorage.setItem(UI_KEY, JSON.stringify(next)); } catch { /* 隐私模式 */ }
  return next;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '◑' : '◐';
}
function applyFont(level) {
  document.documentElement.style.setProperty('--reader-font', `${fontSizePx(level)}px`);
}

function bindChromeExtras() {
  const prefs = loadUiPrefs();
  applyTheme(prefs.theme || 'light');
  applyFont(prefs.font || 'md');
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const theme = nextTheme(loadUiPrefs().theme || 'light');
    saveUiPrefs({ theme });
    applyTheme(theme);
  });
  document.getElementById('btn-font')?.addEventListener('click', () => {
    const font = cycleFontLevel(loadUiPrefs().font || 'md');
    saveUiPrefs({ font });
    applyFont(font);
    showToast(`字号 ${font}`);
  });
  document.getElementById('btn-search')?.addEventListener('click', () => setSearchOpen(true));
  document.getElementById('search-close')?.addEventListener('click', () => setSearchOpen(false));
  document.getElementById('search-input')?.addEventListener('input', () => renderSearchHits());
}

function setSearchOpen(open) {
  const bar = document.getElementById('search-bar');
  if (!bar) return;
  bar.hidden = !open;
  if (open) {
    renderSearchHits();
    setTimeout(() => document.getElementById('search-input')?.focus(), 40);
  }
}
function renderSearchHits() {
  const q = document.getElementById('search-input')?.value || '';
  const hits = searchTranslationHits(state.pages, q);
  const box = document.getElementById('search-hits');
  const count = document.getElementById('search-count');
  if (count) count.textContent = q.trim() ? `${hits.length} 处` : '';
  if (!box) return;
  box.replaceChildren();
  for (const hit of hits) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-hit';
    btn.textContent = `第 ${hit.page} 页 · ${hit.snippet}`;
    btn.addEventListener('click', () => {
      setSearchOpen(false);
      state.pages[hit.page - 1]?.card.scrollIntoView({ block: 'start' });
    });
    box.appendChild(btn);
  }
}

function bindInstallBanner() {
  const banner = document.getElementById('install-banner');
  const copy = document.getElementById('install-copy');
  if (!banner || !copy) return;
  const ua = navigator.userAgent || '';
  const show = shouldShowIosInstallHint({
    ua,
    standalone: isStandaloneDisplay(window),
    dismissed: Boolean(loadUiPrefs().installDismissed),
  });
  if (!show) return;
  copy.textContent = installBannerCopy(ua);
  banner.hidden = false;
  document.getElementById('install-dismiss')?.addEventListener('click', () => {
    banner.hidden = true;
    saveUiPrefs({ installDismissed: true });
  });
}

function bindSwipePages() {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  document.addEventListener('touchstart', (e) => {
    if (!state.pages.length) return;
    if (e.target.closest?.('textarea, input, .sheet, #sel-pop, #search-bar')) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    startX = t.clientX;
    startY = t.clientY;
    tracking = true;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking || !state.pages.length) return;
    tracking = false;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dir = swipeFromDelta(t.clientX - startX, t.clientY - startY);
    if (!dir) return;
    const cur = currentVisiblePage();
    const next = dir === 'next' ? Math.min(state.pages.length, cur + 1) : Math.max(1, cur - 1);
    if (next !== cur) {
      state.pages[next - 1].card.scrollIntoView({ block: 'start' });
      updateDockPage();
    }
  }, { passive: true });
}

function bindSelectionPopover() {
  const pop = document.getElementById('sel-pop');
  if (!pop) return;
  const hide = () => { pop.hidden = true; pop.replaceChildren(); };
  const show = () => {
    const sel = String(window.getSelection?.()?.toString() || '');
    const text = clipSelection(sel, 800);
    const actions = selectionPopoverActions({
      hasSelection: Boolean(text),
      hasPaper: state.pages.length > 0,
    });
    if (!actions.length) { hide(); return; }
    pop.replaceChildren();
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      btn.addEventListener('click', async () => {
        hide();
        if (a.id === 'copy') {
          try { await navigator.clipboard.writeText(text); showToast('已复制'); } catch { showToast('复制失败', true); }
        } else if (a.id === 'translate') {
          setAgentOpen(true);
          void runMobileAgent(`请把这段译成中文，并解释术语：\n\n> ${text}`);
        } else if (a.id === 'ask') {
          setAgentOpen(true);
          void runMobileAgent(`请解释这段（结合当前论文，标页码）：\n\n> ${text}`);
        }
      });
      pop.appendChild(btn);
    }
    const range = window.getSelection()?.getRangeAt?.(0);
    const rect = range?.getBoundingClientRect?.();
    pop.hidden = false;
    const x = rect ? Math.min(window.innerWidth - 180, Math.max(8, rect.left)) : 16;
    const y = rect ? Math.min(window.innerHeight - 56, rect.bottom + 8) : 80;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  };
  document.addEventListener('selectionchange', () => {
    clearTimeout(show._t);
    show._t = setTimeout(show, 180);
  });
  document.addEventListener('scroll', hide, { passive: true });
}

let agentBusy = false;
function setAgentOpen(open) {
  if (!els.agentDrawer) return;
  els.agentDrawer.hidden = !open;
  if (open) {
    renderAgentStarters();
    setTimeout(() => els.agentInput?.focus(), 50);
  }
}
function renderAgentStarters() {
  if (!els.agentQuick) return;
  els.agentQuick.replaceChildren();
  const extra = [
    { id: 'overleaf', label: 'Overleaf', q: '请生成 Related Work 的 LaTeX section，完成后调用 prepare_overleaf_section 或直接给出可粘贴正文。' },
    { id: 'bullets', label: '贡献条', q: '请把本文主张改成 4 条英文 contribution bullets，标页码。' },
    { id: 'meeting', label: '组会稿', q: '请生成组会 5–8 分钟讲稿大纲（中文），并给一页 beamer 提纲。' },
  ];
  for (const s of [...mobileAgentStarters(), ...extra]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = s.label;
    btn.addEventListener('click', () => void runMobileAgent(s.q));
    els.agentQuick.appendChild(btn);
  }
}
function appendAgentBubble(role, text) {
  if (!els.agentLog) return null;
  const welcome = els.agentLog.querySelector('.agent-welcome');
  if (welcome) welcome.remove();
  const wrap = document.createElement('div');
  wrap.className = `agent-msg ${role}`;
  const body = document.createElement('div');
  body.className = 'agent-body';
  if (role === 'assistant') {
    renderMarkdownWithMath(body, text || '…', {
      parse: (s) => (window.marked?.parse ? window.marked.parse(s) : s),
      autoRender: window.renderMathInElement,
    });
  } else {
    body.textContent = text;
  }
  wrap.appendChild(body);
  els.agentLog.appendChild(wrap);
  els.agentLog.scrollTop = els.agentLog.scrollHeight;
  return body;
}
function livePaperProvider() {
  return buildMobilePaperProvider({
    title: state.docName,
    currentPage: currentVisiblePage(),
    pages: state.pages.map((p) => ({
      num: p.num,
      translated: p.translated,
      started: p.started,
      sourceText: p.sourceText,
    })),
  });
}
const LIBRARY_KEY = 'paperlens.app.library.v1';
const DRAFTS_KEY = 'paperlens.app.drafts.v1';
function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额 */ }
}
function rememberOpenedPaper() {
  if (!state.docName) return;
  const entries = upsertLibraryEntry(loadJson(LIBRARY_KEY, []), {
    id: `${state.docName}:${state.pages.length}`,
    title: state.docName,
    lastPage: currentVisiblePage(),
    totalPages: state.pages.length,
    translatedCount: state.pages.filter((p) => p.translated).length,
  });
  saveJson(LIBRARY_KEY, entries);
}

function setMoreOpen(open) {
  const sheet = document.getElementById('more-sheet');
  if (sheet) sheet.hidden = !open;
}
function moreBody() { return document.getElementById('more-body'); }

async function fetchRadar() {
  setMoreOpen(true);
  const box = moreBody();
  if (!box) return;
  const prefs = loadUiPrefs();
  const kwText = prefs.radarKeywords || 'optimization, reinforcement, agent';
  const keywords = parseKeywordList(kwText);
  box.replaceChildren();
  const filter = document.createElement('div');
  filter.className = 'write-fields';
  filter.innerHTML = `
    <input id="radar-kw" placeholder="关键词，逗号分隔" />
    <button type="button" id="radar-go" class="primary">刷新雷达</button>
  `;
  box.appendChild(filter);
  filter.querySelector('#radar-kw').value = kwText;
  filter.querySelector('#radar-go').addEventListener('click', () => {
    saveUiPrefs({ radarKeywords: filter.querySelector('#radar-kw').value });
    void fetchRadar();
  });
  const status = document.createElement('p');
  status.className = 'mi-sub';
  status.textContent = '正在拉取 arXiv 最新…';
  box.appendChild(status);
  try {
    const q = keywords[0] ? `all:${encodeURIComponent(keywords[0])}` : 'cat:cs.LG';
    const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=16`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const papers = sortRadarByScore(
      parseArxivAtomXml(await res.text()).map((p) => scoreMobileRadarPaper(p, keywords)),
    );
    status.remove();
    if (!papers.length) { box.appendChild(document.createTextNode('没有结果')); return; }
    for (const p of papers) {
      const row = document.createElement('div');
      row.className = 'more-item';
      row.innerHTML = `<div class="mi-title">${p.title}</div><div class="mi-sub">${p.score || 0} 分 · ${p.published || ''} · ${p.arxivId || ''}${p.reasons?.length ? ` · ${p.reasons[0]}` : ''}</div>`;
      const actions = document.createElement('div');
      actions.style.marginTop = '8px';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '摘要';
      open.addEventListener('click', () => { if (p.arxivId) window.open(arxivAbsUrl(p.arxivId), '_blank', 'noopener'); });
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = '记入文库';
      add.addEventListener('click', () => {
        saveJson(LIBRARY_KEY, upsertLibraryEntry(loadJson(LIBRARY_KEY, []), {
          id: `arxiv:${p.arxivId}`,
          title: p.title,
          lastPage: 1,
          totalPages: 0,
        }));
        showToast('已记入文库');
      });
      actions.append(open, add);
      row.appendChild(actions);
      box.appendChild(row);
    }
    showToast(`雷达 ${papers.length} 篇`);
  } catch (e) {
    status.textContent = `雷达失败：${e?.message || e}`;
    showToast('雷达加载失败', true);
  }
}

function openLibrary() {
  setMoreOpen(true);
  const box = moreBody();
  if (!box) return;
  const entries = loadJson(LIBRARY_KEY, []);
  box.replaceChildren();
  if (!entries.length) {
    box.textContent = '还没有记录。打开 PDF 后会自动记入文库（元数据，不含整份 PDF）。';
    return;
  }
  for (const e of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'more-item';
    btn.innerHTML = `<div class="mi-title">${e.starred ? '★ ' : ''}${e.title}</div><div class="mi-sub">第 ${e.lastPage || 1}/${e.totalPages || '?'} 页 · 已译 ${e.translatedCount || 0}</div>`;
    btn.addEventListener('click', () => {
      showToast('请重新选择该 PDF，会按文件名续读上次页码');
      document.getElementById('file-input')?.click();
    });
    const tools = document.createElement('div');
    tools.style.marginTop = '6px';
    const star = document.createElement('button');
    star.type = 'button';
    star.textContent = e.starred ? '取消星标' : '星标';
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      saveJson(LIBRARY_KEY, toggleLibraryStar(loadJson(LIBRARY_KEY, []), e.id));
      openLibrary();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '删除';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      saveJson(LIBRARY_KEY, removeLibraryEntry(loadJson(LIBRARY_KEY, []), e.id));
      openLibrary();
    });
    tools.append(star, del);
    btn.appendChild(tools);
    box.appendChild(btn);
  }
}

function openWriting() {
  setMoreOpen(true);
  const box = moreBody();
  if (!box) return;
  const drafts = loadJson(DRAFTS_KEY, []);
  const current = drafts[0] || { id: '', title: '', kind: 'general', body: '' };
  box.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'write-fields';
  wrap.innerHTML = `
    <input id="mw-title" placeholder="草稿标题" value="" />
    <select id="mw-kind">
      <option value="general">通用</option>
      <option value="related-work">Related Work</option>
      <option value="meeting">组会讲稿</option>
    </select>
    <textarea id="mw-body" placeholder="在此写作… 或让 Agent 生成后粘贴"></textarea>
    <button type="button" id="mw-save" class="primary">保存草稿</button>
    <button type="button" id="mw-copy" class="primary" style="background:transparent;color:var(--brand);border:1px solid var(--brand)">复制正文 / LaTeX</button>
    <button type="button" id="mw-agent" class="primary" style="background:transparent;color:var(--brand);border:1px solid var(--brand)">✧ 让 Agent 生成 Related Work</button>
  `;
  box.appendChild(wrap);
  wrap.querySelector('#mw-title').value = current.title || '';
  wrap.querySelector('#mw-kind').value = current.kind || 'general';
  wrap.querySelector('#mw-body').value = current.body || '';
  wrap.querySelector('#mw-save').addEventListener('click', () => {
    const next = upsertDraft(drafts, {
      id: current.id || undefined,
      title: wrap.querySelector('#mw-title').value,
      kind: wrap.querySelector('#mw-kind').value,
      body: wrap.querySelector('#mw-body').value,
    });
    saveJson(DRAFTS_KEY, next);
    showToast('草稿已保存');
  });
  wrap.querySelector('#mw-copy').addEventListener('click', async () => {
    const raw = wrap.querySelector('#mw-body').value;
    const tex = extractCopyableLatex(raw);
    try {
      await navigator.clipboard.writeText(tex);
      showToast('已复制，可粘贴到 Overleaf');
    } catch { showToast('复制失败', true); }
  });
  wrap.querySelector('#mw-agent').addEventListener('click', () => {
    const body = wrap.querySelector('#mw-body').value.trim();
    const title = wrap.querySelector('#mw-title').value.trim() || 'Related Work';
    void runMobileAgent(body
      ? `请把下面草稿整理成 Related Work（中英提纲），方便粘贴：\n\n${body.slice(0, 4000)}`
      : `请基于当前论文生成 Related Work 提纲，标题：${title}`);
  });
}

function bindMoreSheet() {
  document.getElementById('home-library')?.addEventListener('click', openLibrary);
  document.getElementById('home-write')?.addEventListener('click', openWriting);
  document.getElementById('home-agent')?.addEventListener('click', () => setAgentOpen(true));
  document.getElementById('dock-more')?.addEventListener('click', () => {
    setMoreOpen(true);
    openLibrary();
  });
  document.getElementById('more-close')?.addEventListener('click', () => setMoreOpen(false));
  document.getElementById('more-sheet')?.addEventListener('click', (e) => {
    if (e.target?.id === 'more-sheet') setMoreOpen(false);
  });
  document.getElementById('more-library')?.addEventListener('click', openLibrary);
  document.getElementById('more-write')?.addEventListener('click', openWriting);
}

// ---------------------------------------------------------------------------
// Agent 完整 loop（已接线）
// ---------------------------------------------------------------------------
async function runMobileAgent(question) {
  const q = String(question || '').trim();
  if (!q) return;
  if (agentBusy) { showToast('Agent 正在回答，稍后再问', true); return; }
  const cfg = loadAppConfig();
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    showToast('先配置模型 API', true);
    document.getElementById('btn-settings')?.click();
    return;
  }
  setAgentOpen(true);
  if (els.agentInput) els.agentInput.value = '';
  appendAgentBubble('user', q);
  const body = appendAgentBubble('assistant', '取证中…');
  agentBusy = true;
  const provider = livePaperProvider();
  const bootstrap = buildAgentBootstrap(provider, { query: q });
  const system = researchAgentSystemPrompt(cfg.targetLang || '简体中文', {
    paperBrief: bootstrap.paperBrief || extractBootstrapBrief(provider),
    currentPageBrief: bootstrap.currentPageBrief || '',
    evidenceBrief: bootstrap.evidenceBrief || '',
  });
  const working = [
    { role: 'system', content: system },
    { role: 'user', content: q },
  ];
  let executed = new Set();
  try {
    for (let round = 0; round < RESEARCH_AGENT_MAX_ROUNDS; round += 1) {
      let streamed = '';
      const reply = await chat({
        config: cfg,
        messages: working,
        onDelta: (delta) => {
          streamed += String(delta || '');
          if (body) {
            renderMarkdownWithMath(body, streamed || '…', {
              parse: (s) => (window.marked?.parse ? window.marked.parse(s) : s),
              autoRender: window.renderMathInElement,
            });
          }
        },
      });
      const parsed = parseAgentResponse(reply || streamed);
      if (parsed.calls.length && round < RESEARCH_AGENT_MAX_ROUNDS - 1) {
        const deduped = dedupeResearchToolCalls(parsed.calls, executed);
        executed = deduped.signatures;
        const calls = deduped.calls;
        if (!calls.length) {
          working.push({ role: 'assistant', content: reply });
          working.push({ role: 'user', content: '请直接输出 FINAL，不要重复已执行过的工具。' });
          continue;
        }
        const results = calls.map((call) => executeResearchTool(call, provider));
        if (body) body.textContent = `查阅：${calls.map((c) => c.name).join(' · ')}`;
        working.push({ role: 'assistant', content: reply });
        working.push({ role: 'user', content: formatToolResultsForModel(results) });
        continue;
      }
      const answer = parsed.finalAnswer || reply || '（空回答）';
      if (body) {
        renderMarkdownWithMath(body, answer, {
          parse: (s) => (window.marked?.parse ? window.marked.parse(s) : s),
          autoRender: window.renderMathInElement,
        });
      }
      break;
    }
  } catch (e) {
    if (body) body.textContent = `⚠ ${e?.message || e}`;
  } finally {
    agentBusy = false;
    if (els.agentLog) els.agentLog.scrollTop = els.agentLog.scrollHeight;
  }
}

function bindAgent() {
  document.getElementById('agent-close')?.addEventListener('click', () => setAgentOpen(false));
  els.agentDrawer?.addEventListener('click', (e) => { if (e.target === els.agentDrawer) setAgentOpen(false); });
  els.agentForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    void runMobileAgent(els.agentInput?.value);
  });
  els.agentInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void runMobileAgent(els.agentInput.value);
    }
  });
  renderAgentStarters();
}

async function pasteArxivOrOpen(file) {
  if (file) {
    await openPickedFile(file).catch((e) => showToast(String(e?.message || e), true));
    return;
  }
  let text = '';
  try { text = String(await navigator.clipboard.readText()).trim(); } catch { /* 无剪贴板权限 */ }
  const idMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+(?:v\d+)?)|arXiv:([0-9]+\.[0-9]+)|(?:^|\s)([0-9]{4}\.[0-9]{4,5})(?:v\d+)?(?:\s|$)/i);
  const arxivId = (idMatch && (idMatch[1] || idMatch[2] || idMatch[3])) || '';
  if (!arxivId) return;
  showToast(`正在打开 arXiv ${arxivId}…`);
  const pdfUrl = `https://export.arxiv.org/pdf/${arxivId}.pdf`;
  try {
    const res = await fetch(pdfUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const pdfFile = new File([blob], `${arxivId}.pdf`, { type: 'application/pdf' });
    await openPickedFile(pdfFile);
    showToast('已打开 arXiv 论文');
  } catch {
    showToast('网页跨域无法直接下 PDF，已打开摘要页', true);
    window.open(`https://arxiv.org/abs/${arxivId}`, '_blank', 'noopener');
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
bindSettings();
bindPageGrid();
bindDock();
bindChromeExtras();
bindInstallBanner();
bindSwipePages();
bindSelectionPopover();
bindAgent();
bindMoreSheet();
applyIpadSplit();
showResumeHintOnEmpty();

els.fileInput?.addEventListener('change', (e) => {
  pasteArxivOrOpen(e.target.files?.[0]);
  els.fileInput.value = '';
});

document.addEventListener('paste', async (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  pasteArxivOrOpen(null);
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 离线壳是增强，不是必需 */ });
}
