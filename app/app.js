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

const CONFIG_KEY = 'paperlens.app.config.v1';
const RESUME_KEY = 'paperlens.app.resume.v1';
const GLOSSARY_KEY = 'paperlens.app.glossary.v1';
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
  dockTop: document.getElementById('dock-top'),
  settings: document.getElementById('settings'),
  toast: document.getElementById('toast'),
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
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = '待翻译';
    head.append(label, shotBtn, status);
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
  els.dockPageLabel.textContent = `${state.pages.length ? currentVisiblePage() : 0} / ${state.pages.length}`;
}
function bindDock() {
  els.dockSrc.addEventListener('click', () => {
    state.compareMode = !state.compareMode;
    els.dockSrc.classList.toggle('on', state.compareMode);
    document.body.classList.toggle('show-src', state.compareMode);
    if (state.compareMode) {
      showToast('对照模式：每页译文下方显示原版页');
      for (const page of state.pages) {
        const rect = page.card.getBoundingClientRect();
        if (rect.bottom > -600 && rect.top < window.innerHeight + 600) {
          renderPageShot(page).catch(() => {});
        }
      }
    } else {
      for (const page of state.pages) { page.shotWrap.hidden = true; }
    }
  });
  els.dockPage.addEventListener('click', () => openPageGrid());
  els.dockTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      updateDockPage();
      saveResume();
    }, 200);
  }, { passive: true });
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

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
bindSettings();
bindPageGrid();
bindDock();
showResumeHintOnEmpty();
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) openPickedFile(file).catch((e) => showToast(String(e?.message || e), true));
  els.fileInput.value = '';
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* 离线壳是增强，不是必需 */ });
}
