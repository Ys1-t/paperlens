// src/viewer/viewer.js
// 双语 PDF 阅读器：整页视觉翻译为唯一主路径——左栏原版 PDF，右栏流式视觉译文，
// 公式由视觉 Markdown + KaTeX 呈现；图片和表格主体只留在左栏（本地版面服务已于 0.9.6 移除）。
import { activateProviderProfile, loadPublicConfig } from '../lib/config.js';
import { PAPERLENS_BUILD_ID, TRANSLATION_PORT_NAME } from '../lib/build-info.js';
import {
  anchorScrollDelta,
  chooseClosestReadingTarget,
  createScrollSyncGuard,
  displayPointToIr,
  findColumnAnchor,
  irBoxToDisplay,
  readingTargetBoxes,
} from '../lib/reading-link.js';
import {
  createReadOptimizedCanvasFactory,
  getReadOptimized2dContext,
} from '../lib/pdf-canvas-factory.js';
import { installKatexGuard, KATEX_GUARD_VERSION } from '../lib/katex-guard.js';
import { makeInactivityGuard } from '../lib/inactivity-guard.js';
import {
  extractBareEquationNumber,
  isStandaloneEquationNumber,
  mergeTrailingEquationNumbers,
  normalizeDelimitedMath,
  normalizeMathForKatex,
  prepareDelimitedMathForRender,
} from '../lib/math-normalization.js';
import {
  buildDocumentPrintSections,
  buildPrintDocumentHtml,
  loadPrintAssets,
  openPrintHtmlWindow,
  sanitizeExportHtml,
} from '../lib/print-export.js';
import {
  formatAutoRetryLabel,
  nextRetryDelayMs,
  shouldScheduleAutoRetry,
} from '../lib/smart-retry.js';
import {
  formatAlgorithmsInMarkdown,
  indentAlgorithmLines,
  localizeAlgorithmTitle,
  looksLikeCompactAlgorithm,
  looksLikeLatexHeavy,
  parseAlgorithmDisplayLine,
  prepareAlgorithmBodyForDisplay,
  prepareAlgorithmDisplayLine,
  recoverAlgorithmFromPlainText,
  stripMarkdownNoiseFromAlgorithm,
} from '../lib/algorithm-format.js';
import {
  looksLikeBibliographyList,
  normalizeBibliographyMarkdown,
} from '../lib/bibliography-format.js';
import { assessFormulaLatex, canonicalizeFormulaLatex } from '../lib/formula-quality.js';
import { buildPagePriorityOrder, createPageScheduler } from '../lib/page-priority.js';
import {
  buildSelectionTranslationRequestText,
  chooseSelectionPopoverPlacement,
  collectSelectionContext,
  isTranslatableSelectionText,
  normalizeSelectionText,
} from '../lib/selection-translate.js';
import {
  buildTableModel,
  createReadingTranslationPlan,
  expandReadingTranslationChange,
  isTrustedReadingTable,
  shouldTranslateTableCell,
  updateStructuredTextNode,
} from '../lib/structured-translation.js';
import {
  NODE_TRANSLATION_BATCH_CONCURRENCY,
  createNodeTranslationBatches,
  createNodeTranslationAccumulator,
  mapNodeTranslationBatches,
  retryNodeItemsOnce,
  serializeNodeTranslationRequest,
} from '../lib/node-translation.js';
import {
  createLatestDocumentLoader,
  createViewerSessionCleanup,
  isCurrentDocumentPage,
} from '../lib/viewer-session.js';
import {
  createLatestConfigRefresher,
  renderPublicProviderState,
  switchProviderProfileForNewRequests,
} from './provider-ui.js';
import {
  createFormulaBatchRequest,
  createFormulaRequest,
  escapeHtmlText,
  assessVisionTranslationQuality,
  buildVisionTranslationContext,
  describeVisionQualityIssue,
  finalizeReadingTranslation,
  getReadingMediaPresentation,
  neutralizeRawHtml,
  parseFormulaBatchTranscription,
  parseFormulaTranscription,
  sanitizeMarkedHtml,
  selectVisionRenderWidth,
  shouldAutoRefineVisionQuality,
  transitionPageOutcome,
} from '../lib/reading-mode.js';
import {
  createRenderFrameGate,
  rejectCancelledRequest,
  settlePageRequest,
  startPageRequest,
} from '../lib/request-handlers.js';
import {
  appendRuntimeDiagnostic,
  installRuntimeDiagnosticCapture,
} from '../lib/runtime-diagnostics.js';
import {
  buildPagePresentation,
  buildReaderProgress,
  friendlyReaderError,
  isBackgroundConnectionError,
} from '../lib/reader-ux.js';
import { createChatPanel } from './chat-panel.js';
import { loadResearchNotes, searchResearchNotes } from '../lib/research-skills.js';
import {
  buildEvidencePack,
  createPaperSearchIndex,
  expandEvidenceWithNeighbors,
  retrievePaperEvidence,
} from '../lib/paper-retrieval.js';
import {
  getReadingProgress,
  recordReadingProgress,
  shouldOfferResume,
} from '../lib/reading-history.js';

const pdfjsLib = window.pdfjsLib;
const recordViewerDiagnostic = (event) => appendRuntimeDiagnostic(
  chrome.storage.local,
  { component: 'viewer', ...event },
  { buildId: PAPERLENS_BUILD_ID },
);
installRuntimeDiagnosticCapture({
  target: window,
  consoleObject: console,
  component: 'viewer',
  record: recordViewerDiagnostic,
});
installKatexGuard(window.katex);

// Module-level prefs used during bindUi()/init() — must be declared before
// the bottom-of-file `init()` call runs (const TDZ would crash otherwise).
const SCROLL_LINK_STORAGE_KEY = 'paperlens.scrollLink.enabled';

// ---------------------------------------------------------------------------
// 与后台的流式翻译端口封装（协议见 docs/TECHNICAL.md）
// ---------------------------------------------------------------------------
function readRuntimeLastErrorMessage() {
  // Chrome/Edge requires extension pages to read runtime.lastError inside the
  // callback that receives it. Leaving it unread creates a persistent entry on
  // the extension Errors page even when the disconnect is an expected reload.
  try {
    return String(chrome.runtime.lastError?.message || '');
  } catch {
    return '';
  }
}

function extensionConnectionError(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || '');
  if (/extension context invalidated/i.test(message)) {
    return new Error('扩展已更新，请刷新当前阅读器页面。');
  }
  // "disconnected port"：标签页冻结期间 SW 被回收且 onDisconnect 事件丢失，
  // 死端口上的 postMessage 会同步抛 "Attempting to use a disconnected port object"。
  if (/receiving end does not exist|could not establish connection|message port closed|disconnected port/i.test(message)) {
    return new Error('扩展后台刚刚重载，请稍后自动重试或刷新当前阅读器页面。');
  }
  return new Error(message || '与后台的连接已断开，请重试。');
}

function isExpectedExtensionReloadError(error) {
  return /扩展已更新|扩展后台刚刚重载|与后台的连接|连接已断开|extension context invalidated|receiving end does not exist|could not establish connection|message port closed|disconnected port/i
    .test(String(error?.message || error || ''));
}

class TranslationClient {
  constructor() {
    this.seq = 0; this.handlers = new Map(); this.pings = new Map(); this.port = null;
    this.connectionError = null;
    this.onReconnect = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._disconnectEpoch = 0;
    try {
      this._connect();
    } catch (error) {
      // An already-open extension page cannot reconnect while its extension is
      // being reloaded. Keep the page alive so init/checkBackend can show a
      // useful refresh instruction instead of creating another browser error.
      this.connectionError = extensionConnectionError(error);
    }
  }
  _connect() {
    let raw;
    try {
      raw = chrome.runtime.connect({ name: TRANSLATION_PORT_NAME });
      this.connectionError = null;
    } catch (error) {
      this.port = null;
      this.connectionError = extensionConnectionError(error);
      throw this.connectionError;
    }
    // 守卫端口：标签页在后台被冻结期间 SW 被回收时，onDisconnect 事件可能
    // 永远不会送达——this.port 看似可用但已死，postMessage 会同步抛
    // "Attempting to use a disconnected port object"。这里把该同步抛错统一
    // 转成断开清理 + 自动重连，调用方拿到的是可自动重试的连接类错误，而
    // 不是一条不可识别、点「重试本页」也永远失败的原生英文错误。
    const guarded = {
      postMessage: (message) => {
        try {
          raw.postMessage(message);
        } catch (error) {
          throw this._dropPort(
            guarded,
            String(error?.message || error || 'disconnected port'),
            'TranslationClient.postMessage',
          );
        }
      },
      disconnect: () => { try { raw.disconnect(); } catch { /* 端口本就已死 */ } },
    };
    this.port = guarded;
    this._reconnectAttempts = 0;
    console.log('[PL-VIEW] connected to background port');
    raw.onMessage.addListener((m) => this._onMessage(m));
    raw.onDisconnect.addListener(() => {
      const runtimeErrorMessage = readRuntimeLastErrorMessage();
      // 迟到的旧端口断开事件（已被 postMessage 守卫清理、或已重连到新端口）：
      // 只消费 runtime.lastError（避免扩展错误页噪音），不清理新端口状态。
      if (this.port !== guarded) return;
      console.log('[PL-VIEW] port disconnected');
      this._dropPort(guarded, runtimeErrorMessage, 'TranslationClient._connect');
    });
  }
  // 统一断开清理：拒绝全部在途请求、置空端口并调度重连。onDisconnect 与
  // postMessage 同步抛错两条路径共用，保证行为一致。返回可识别的连接错误。
  _dropPort(portRef, rawMessage, source) {
    if (this.port !== portRef) {
      return this.connectionError || extensionConnectionError(rawMessage);
    }
    recordViewerDiagnostic({
      kind: 'port.disconnect',
      message: rawMessage || 'Translation port disconnected without runtime.lastError',
      source,
    });
    const err = extensionConnectionError(rawMessage);
    this.connectionError = err;
    this._disconnectEpoch += 1;
    this.port = null;
    for (const h of this.handlers.values()) h.reject(err);
    this.handlers.clear();
    for (const p of this.pings.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pings.clear();
    portRef.disconnect();
    // 多标签并行翻译时 SW 可能被回收：自动重连，便于后续请求与自动重试。
    this._scheduleReconnect();
    return err;
  }
  _scheduleReconnect() {
    if (this._reconnectTimer != null) return;
    const attempt = this._reconnectAttempts || 0;
    // 首试 450ms，指数退避封顶 5s；连续失败最多再排 8 次。期间用户操作仍会
    // 经 _ensure 随时触发即时重连，成功连接会把计数清零。
    const delay = Math.min(5000, 450 * (2 ** attempt));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.port) return;
      try {
        this._connect();
        console.log('[PL-VIEW] background port reconnected');
        if (typeof this.onReconnect === 'function') {
          try { this.onReconnect(); } catch (error) {
            console.warn('[PL-VIEW] onReconnect handler failed', error);
          }
        }
      } catch (error) {
        console.warn('[PL-VIEW] background reconnect failed', error);
        // 扩展整体重载（context invalidated）只能刷新页面恢复，不再空转。
        if (/extension context invalidated/i.test(String(error?.message || error || ''))) return;
        this._reconnectAttempts = attempt + 1;
        if (this._reconnectAttempts <= 8) this._scheduleReconnect();
      }
    }, delay);
  }
  _ensure() {
    if (!this.port) this._connect();
    if (!this.port) throw this.connectionError || extensionConnectionError('');
  }
  isConnected() {
    return Boolean(this.port);
  }
  _onMessage(m) {
    if (m.type === 'pong') {
      const p = this.pings.get(m.id);
      if (p) { clearTimeout(p.timer); this.pings.delete(m.id); p.resolve(m); }
      return;
    }
    const h = this.handlers.get(m.id);
    if (!h) return;
    if (m.type === 'chunk') h.onDelta?.(m.delta);
    else if (m.type === 'status') h.onStatus?.(m.phase);
    else if (m.type === 'done') { this.handlers.delete(m.id); h.resolve({ full: m.full, cached: m.cached }); }
    else if (m.type === 'error') { this.handlers.delete(m.id); h.reject(new Error(m.message)); }
    else if (m.type === 'cancelled') { this.handlers.delete(m.id); h.reject(Object.assign(new Error('已取消'), { cancelled: true })); }
  }
  ping() {
    this._ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pings.delete(id); reject(new Error('ping 超时')); }, 3000);
      this.pings.set(id, { resolve, reject, timer });
      try { this.port.postMessage({ type: 'ping', id }); }
      catch (e) { clearTimeout(timer); this.pings.delete(id); reject(e); }
    });
  }
  translateImage(image, onDelta, onStatus, { text = '', bypassCache = false } = {}) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage({
        type: 'translate',
        id,
        image,
        text: text || undefined,
        priority: false,
        bypassCache: Boolean(bypassCache),
      });
    });
    return { id, promise };
  }
  transcribeFormula(image, sourceText, onDelta, onStatus) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage(createFormulaRequest(id, image, sourceText));
    });
    return { id, promise };
  }
  transcribeFormulaBatch(image, formulas, onDelta, onStatus) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage(createFormulaBatchRequest(id, image, formulas));
    });
    return { id, promise };
  }
  // 翻译一段 Markdown 文本（来自本地版面分析服务），保留结构，只译文字。
  translateMarkdown(text, onDelta, onStatus, { bypassCache = false } = {}) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage({
        type: 'translate', id, text, markdown: true, priority: false, bypassCache,
      });
    });
    return { id, promise };
  }
  translateNodes(text, onDelta, onStatus, {
    bypassCache = false,
    queuePriority = 0,
    nodeSlotRetry = false,
  } = {}) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage({
        type: 'translate',
        id,
        text,
        nodeProtocol: true,
        priority: false,
        bypassCache,
        queuePriority,
        // 可选新增字段：仅公式 slot 局部重译请求携带，SW 据此选用专用 prompt。
        ...(nodeSlotRetry ? { nodeSlotRetry: true } : {}),
      });
    });
    return { id, promise };
  }
  // 划词即时翻译：既有协议形状 translate{id,text,priority:true}。
  // priority=true 走 SW 免排队通道（立即执行），并使用 defaultSystemPrompt
  // 普通文本路径；SW 端对 priority 请求不读也不写共享译文缓存。
  translateSelection(text, onDelta, onStatus) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage({ type: 'translate', id, text, priority: true });
    });
    return { id, promise };
  }
  // AI 助手多轮对话：新增 `chat` 消息类型（携带完整 messages 数组），流式回传。
  // 与 translate 独立；SW 直接 runTask，不经译文缓存（聊天不进缓存）。
  chat(messages, onDelta, onStatus) {
    this._ensure();
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onDelta, onStatus });
      this.port.postMessage({ type: 'chat', id, messages });
    });
    return { id, promise };
  }
  cancel(id, { settle = true } = {}) {
    try { this.port?.postMessage({ type: 'cancel', id }); } catch { /* noop */ }
    if (settle) rejectCancelledRequest(this.handlers, id);
    else this.handlers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
const state = {
  pdf: null, scale: 1.35, config: null,
  pages: [],
  totalPages: 0, doneCount: 0, inProgress: 0, failedCount: 0,
  scrollSyncSuspended: false,   // 显式长挂起：双击定位/高亮期间不做联动
  scrollSyncTimer: null,
  // 回声防抖闸门：一栏被联动程序化滚动后，短时窗内忽略它自身的 scroll 事件，
  // 阻断 A→B→B→A 死循环。见 createScrollSyncGuard。
  scrollSyncGuard: null,
  scrollSyncFrame: 0,
  // Layout reflow (window / divider / chat / translation height) → re-pair pages.
  scrollRealignTimer: null,
  scrollRealignFrame: 0,
  scrollLayoutObserver: null,
  // 左右滚动联动：译文往往更长，用户可关掉联动让原文「停住」单独读译文。
  // scrollLinkHoldOff = 按住 Alt 临时解除（松手恢复）。偏好写入 localStorage。
  scrollLinkEnabled: true,
  scrollLinkHoldOff: false,
  lastScrollSource: null,
  // Authoritative page for toolbar next/prev (viewport lag used to block rapid clicks).
  navPageNumber: 1,
  navScrollLockUntil: 0,
  loadingTask: null,
  documentGeneration: 0,
  closedGeneration: null,
  documentAbortController: null,
  documentUiController: null,
  renderObserver: null,
  translateObserver: null,
  recycleObserver: null,
  pageScheduler: createPageScheduler({ concurrency: 2 }),
  readerMode: 'reading', // 默认：原 PDF 是视觉底座，右栏显示译文 + LaTeX 公式
};
const client = new TranslationClient();
let formulaQueue = Promise.resolve();
let portKeepAliveTimer = null;
const PORT_KEEPALIVE_MS = 20000;

// 后台 Port 恢复后，自动重试本标签页里因断线失败的页（每文档 generation 最多一次）。
client.onReconnect = () => {
  setSwHealth('ok', '后台已恢复连接');
  autoRetryConnectionFailures();
};

function startPortKeepAlive() {
  stopPortKeepAlive();
  portKeepAliveTimer = setInterval(() => {
    try {
      client.ping().catch(() => {
        // 死端口 / SW 重启：postMessage 守卫与重连调度会自动处理。
      });
    } catch { /* 扩展已重载：只能等用户刷新页面 */ }
  }, PORT_KEEPALIVE_MS);
}

function stopPortKeepAlive() {
  if (portKeepAliveTimer != null) {
    clearInterval(portKeepAliveTimer);
    portKeepAliveTimer = null;
  }
}

// 从后台标签页返回 / 解冻时主动探活：冻结期间定时器停摆、SW 被回收且
// onDisconnect 丢失时，死端口只会在下一次 postMessage 时暴露。回到前台
// 立刻 ping 一次，死端口经 postMessage 守卫触发统一清理 + 重连 + 自动
// 重试，「过一会儿回来继续翻译」无需手动点重试或刷新。
function probeBackgroundPort() {
  try {
    client.ping().catch(() => {
      // 死端口：postMessage 守卫已触发清理与重连；超时则交给 keepalive。
    });
  } catch { /* 扩展重载（context invalidated）：等待用户刷新页面 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') probeBackgroundPort();
});
// Page Lifecycle API：标签页解冻（frozen → active）时恢复探活。
document.addEventListener('resume', () => probeBackgroundPort());

function autoRetryConnectionFailures() {
  if (!state.pages?.length || !client.isConnected()) return;
  let count = 0;
  for (const page of state.pages) {
    if (page.documentGeneration !== state.documentGeneration) continue;
    if (page.translationActive) continue;
    const failed = page.translationOutcome === 'failed'
      || page.translationError
      || page.mdEl?.classList?.contains('error');
    if (!failed) continue;
    if (!isBackgroundConnectionError(page.translationError || page.mdEl?.textContent || '')) continue;
    if (page.connectionAutoRetryGeneration === state.documentGeneration) continue;
    page.connectionAutoRetryGeneration = state.documentGeneration;
    page.translateStarted = false;
    page.translationError = null;
    page.translationOutcome = null;
    translatePage(page.num);
    count += 1;
  }
  if (count > 0) {
    showToast(`后台已恢复，正在自动重试 ${count} 页…`);
    updateProgress();
    updateHud();
  }
}

// AI 助手聊天面板：走新增的 `chat` Port 消息（多轮，不进缓存）。
// sendChat 暴露 cancel（复用既有 cancel 消息），AI 回复用译文 Markdown 渲染器渲染。
const sendChat = (messages, onDelta, onStatus) => client.chat(messages, onDelta, onStatus);
sendChat.cancel = (id) => client.cancel(id);

/** 取左栏当前阅读锚点页，渲染 JPEG 截图供 AI 页图问答。 */
async function captureVisiblePageImageForChat() {
  if (!state.pages?.length) throw new Error('请先打开 PDF');
  const fromTop = els.pdfColumn.getBoundingClientRect().top;
  const rects = state.pages.map((p) => p.pageEl.getBoundingClientRect());
  const anchor = findColumnAnchor(rects, fromTop);
  const pageIndex = Math.max(0, Math.min(anchor.index, state.pages.length - 1));
  const page = state.pages[pageIndex];
  if (!page) throw new Error('无法定位当前页');
  await ensurePdfPage(pageIndex, page.documentGeneration ?? state.documentGeneration);
  // 聊天附图略小于整页视觉翻译，控制请求体积。
  const dataUrl = await renderPageImage(page, 1280);
  if (!dataUrl) throw new Error('页面截图失败');
  return { dataUrl, pageNum: page.num };
}

// ---------------------------------------------------------------------------
// 框选提问：在左侧 PDF 上拖一个矩形，把该区域高清裁图附到 AI 助手
// ---------------------------------------------------------------------------
let snipCleanup = null;
function startSnipMode() {
  if (!state.pages?.length) { showToast('请先打开 PDF'); return; }
  if (snipCleanup) { snipCleanup(); return; } // 再点一次 = 取消
  const colRect = els.pdfColumn.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'snip-overlay';
  Object.assign(overlay.style, {
    left: `${colRect.left}px`, top: `${colRect.top}px`,
    width: `${colRect.width}px`, height: `${colRect.height}px`,
  });
  const hint = document.createElement('div');
  hint.className = 'snip-hint';
  hint.textContent = '按住左键框选要提问的图 / 公式 / 段落，Esc 取消';
  const rectEl = document.createElement('div');
  rectEl.className = 'snip-rect';
  rectEl.hidden = true;
  overlay.append(hint, rectEl);
  document.body.appendChild(overlay);
  els.btnSnip?.classList.add('is-active');

  let startX = 0; let startY = 0; let dragging = false;
  const drawRect = (e) => {
    const x = Math.min(startX, e.clientX); const y = Math.min(startY, e.clientY);
    Object.assign(rectEl.style, {
      left: `${x - colRect.left}px`, top: `${y - colRect.top}px`,
      width: `${Math.abs(e.clientX - startX)}px`, height: `${Math.abs(e.clientY - startY)}px`,
    });
  };
  const onKeyDown = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } };
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    dragging = true; startX = e.clientX; startY = e.clientY;
    rectEl.hidden = false;
    drawRect(e);
    e.preventDefault();
  };
  const onMouseMove = (e) => { if (dragging) drawRect(e); };
  const onMouseUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const box = {
      left: Math.min(startX, e.clientX), top: Math.min(startY, e.clientY),
      width: Math.abs(e.clientX - startX), height: Math.abs(e.clientY - startY),
    };
    cleanup();
    if (box.width < 12 || box.height < 12) { showToast('框选区域太小，已取消'); return; }
    void snipToChat(box);
  };
  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown, true);
  function cleanup() {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    els.btnSnip?.classList.remove('is-active');
    snipCleanup = null;
  }
  snipCleanup = cleanup;
}

/** 把视口框选矩形映射到相交面积最大的页，按归一化坐标高清重渲后裁剪。 */
async function snipToChat(box) {
  let best = null;
  for (const page of state.pages) {
    if (!page.pageEl) continue;
    const r = page.pageEl.getBoundingClientRect();
    const ix = Math.min(box.left + box.width, r.right) - Math.max(box.left, r.left);
    const iy = Math.min(box.top + box.height, r.bottom) - Math.max(box.top, r.top);
    const area = Math.max(0, ix) * Math.max(0, iy);
    if (area > 0 && (!best || area > best.area)) best = { page, rect: r, area };
  }
  if (!best) { showToast('请框选左侧 PDF 页面内的区域', true); return; }
  try {
    const { page, rect } = best;
    await ensurePdfPage(page.num - 1, page.documentGeneration ?? state.documentGeneration);
    // 页面内归一化坐标（越界部分裁掉），与缩放级别无关。
    const fx = Math.max(0, (box.left - rect.left) / rect.width);
    const fy = Math.max(0, (box.top - rect.top) / rect.height);
    const fx2 = Math.min(1, (box.left + box.width - rect.left) / rect.width);
    const fy2 = Math.min(1, (box.top + box.height - rect.top) / rect.height);
    const scale = Math.min(3, 1600 / page.viewport1.width);
    const viewport = page.pageObj.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = Math.floor(viewport.width);
    full.height = Math.floor(viewport.height);
    const ctx = getReadOptimized2dContext(full, { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, full.width, full.height);
    await page.pageObj.render({ canvasContext: ctx, viewport }).promise;
    const sx = Math.floor(fx * full.width);
    const sy = Math.floor(fy * full.height);
    const sw = Math.max(1, Math.floor((fx2 - fx) * full.width));
    const sh = Math.max(1, Math.floor((fy2 - fy) * full.height));
    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    getReadOptimized2dContext(crop).drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = crop.toDataURL('image/png');
    chatPanel.setOpen(true); // 先 mount 面板，附件缩略图才能立刻显示
    chatPanel.setPageImage({ dataUrl, pageNum: page.num });
    showToast(`已附上第 ${page.num} 页框选区域，输入问题即可发送`);
  } catch (error) {
    showToast(String(error?.message || error || '框选截图失败'), true);
  }
}

/** 把 PDF.js getTextContent 的 items 拼成一段可检索的纯文本。 */
function agentTextFromTextContent(textContent) {
  return (textContent?.items || [])
    .map((it) => (it && typeof it.str === 'string' ? it.str : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 打开 AI 助手时后台预取全部页的原文文本（每文档一次），让深读助手对
// 未翻译页也能检索/引用，而不是把它们当成不存在。逐页 + 让路，避免与
// 渲染/翻译争抢主线程；单页失败不影响其它页。
let agentSourcePrefetchGeneration = null;
let agentSourcePrefetchPromise = null;
function prefetchAgentSourceText() {
  const generation = state.documentGeneration;
  if (!state.pages?.length) return Promise.resolve();
  if (agentSourcePrefetchGeneration === generation && agentSourcePrefetchPromise) {
    return agentSourcePrefetchPromise;
  }
  agentSourcePrefetchGeneration = generation;
  agentSourcePrefetchPromise = (async () => {
    for (const page of state.pages) {
      if (!isCurrentDocument(generation)) return;
      if (page.agentSourceText) continue;
      try {
        await ensurePdfPage(page.num - 1, generation);
        if (!isCurrentDocument(generation) || !page.pageObj) continue;
        const textContent = await page.pageObj.getTextContent();
        page.agentSourceText = agentTextFromTextContent(textContent);
      } catch { /* 扫描页/损坏页跳过 */ }
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  })();
  return agentSourcePrefetchPromise;
}

function pageTextForAgent(page) {
  if (!page) return '';
  const primary = String(page.translationText || '').trim();
  if (primary) return primary;
  const rendered = String(page.mdEl?.innerText || '').trim();
  if (rendered) return rendered;
  // 未翻译页兜底：返回 PDF 原文（见 prefetchAgentSourceText），带标记让模型
  // 知道这是原文而非译文。
  const source = String(page.agentSourceText || '').trim();
  if (source) return `[未译·原文] ${source}`;
  return '';
}

function pageStatusForAgent(page) {
  if (!page) return '不存在';
  if (page.translationActive) return '翻译中';
  if (page.translationOutcome === 'done') return '已完成';
  if (page.translationOutcome === 'partial') return '部分完成';
  if (page.translationOutcome === 'failed' || page.translationError) return '失败';
  return '等待翻译';
}

let agentSearchIndexCache = null;

function paperEvidencePages() {
  return (state.pages || []).map((page) => {
    const translated = String(page.translationText || page.mdEl?.innerText || '').trim();
    const source = String(page.agentSourceText || '').trim();
    const text = translated || source;
    return {
      page: page.num,
      text,
      sourceType: translated ? 'translation' : 'source',
      status: pageStatusForAgent(page),
    };
  }).filter((page) => page.text);
}

function paperSearchIndex() {
  const pages = paperEvidencePages();
  const signature = `${state.documentGeneration}|${pages.map((page) => (
    `${page.page}:${page.sourceType}:${page.text.length}:${page.text.slice(0, 28)}`
  )).join('|')}`;
  if (agentSearchIndexCache?.signature === signature) return agentSearchIndexCache.index;
  const index = createPaperSearchIndex(pages);
  agentSearchIndexCache = { signature, index };
  return index;
}

const paperTools = {
  async prepareEvidence({ timeoutMs = 650 } = {}) {
    const task = prefetchAgentSourceText();
    let timer = null;
    await Promise.race([
      task,
      new Promise((resolve) => { timer = setTimeout(resolve, Math.max(50, Number(timeoutMs) || 650)); }),
    ]);
    if (timer != null) clearTimeout(timer);
    return {
      readyPages: paperEvidencePages().length,
      totalPages: Number(state.totalPages) || state.pages?.length || 0,
    };
  },
  getPaperMeta() {
    const translatedCount = (state.pages || []).filter((p) => String(p.translationText || p.mdEl?.innerText || '').trim()).length;
    return {
      title: String(els.docTitle?.textContent || '').trim(),
      totalPages: Number(state.totalPages) || (state.pages?.length || 0),
      translatedCount,
      currentPage: currentNavPageNumber?.() || currentVisiblePageNumber?.() || 1,
    };
  },
  getCurrentPage() {
    const pageNum = currentNavPageNumber?.() || currentVisiblePageNumber?.() || 1;
    const page = state.pages[pageNum - 1];
    return {
      page: pageNum,
      status: pageStatusForAgent(page),
      text: pageTextForAgent(page),
    };
  },
  getPage(n) {
    const pageNum = Math.max(1, Math.min(state.totalPages || 1, Math.round(Number(n) || 1)));
    const page = state.pages[pageNum - 1];
    return {
      page: pageNum,
      status: pageStatusForAgent(page),
      text: pageTextForAgent(page),
    };
  },
  getPageRange(start, end) {
    const total = Math.max(1, Number(state.totalPages) || 1);
    const from = Math.max(1, Math.min(total, Math.round(Number(start) || 1)));
    const to = Math.max(from, Math.min(total, Math.round(Number(end) || from)));
    return {
      start: from,
      end: to,
      pages: state.pages.slice(from - 1, to).map((page) => ({
        page: page.num,
        status: pageStatusForAgent(page),
        text: pageTextForAgent(page),
      })),
    };
  },
  gotoPage(n) {
    const pageNum = Math.max(1, Math.min(state.totalPages || 1, Math.round(Number(n) || 1)));
    try { goToPage(pageNum, { quiet: true }); } catch { /* nav may be mid-load */ }
    return paperTools.getPage(pageNum);
  },
  searchPaper(query) {
    const matches = retrievePaperEvidence(paperSearchIndex(), query, {
      currentPage: currentNavPageNumber?.() || currentVisiblePageNumber?.() || 1,
      maxPages: 12,
    });
    return { matches };
  },
  retrieveEvidence(query, { includeNeighbors = true, maxPages = 6 } = {}) {
    const pages = paperEvidencePages();
    const ranked = retrievePaperEvidence(paperSearchIndex(), query, {
      currentPage: currentNavPageNumber?.() || currentVisiblePageNumber?.() || 1,
      maxPages,
    });
    const evidence = includeNeighbors && ranked.length
      ? expandEvidenceWithNeighbors(ranked, pages, { radius: 1, maxPages: Math.min(8, maxPages + 2) })
      : ranked;
    return {
      ...buildEvidencePack(evidence, { query }),
      matches: evidence,
    };
  },
  listPages() {
    return {
      pages: state.pages.map((page) => {
        const text = pageTextForAgent(page).replace(/\s+/g, ' ').trim();
        return {
          page: page.num,
          status: pageStatusForAgent(page),
          preview: text.slice(0, 80),
        };
      }),
    };
  },
  getOutline() {
    // 从各页译文（Markdown）提取 1–3 级标题，形成「章节 → 页码」大纲。
    const items = [];
    const seen = new Set();
    for (const page of state.pages) {
      const text = String(page.translationText || page.mdEl?.innerText || '');
      if (!text.trim()) continue;
      for (const rawLine of text.split('\n')) {
        const m = /^(#{1,3})\s+(\S.{0,90})/.exec(rawLine.trim());
        if (!m) continue;
        const heading = m[2].replace(/[#*`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!heading) continue;
        const key = `${heading}@${page.num}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ page: page.num, level: m[1].length, text: heading });
        if (items.length >= 120) return { items };
      }
    }
    return { items };
  },
  getMyNotes() {
    // 用户在本篇论文保存的科研笔记（localStorage），供 Agent 回答「我记过什么」。
    return loadResearchNotes(chatDocKey());
  },
  searchMyNotes(query) {
    // 跨论文检索用户全部历史笔记，支撑「和我读过的论文对比」。
    return searchResearchNotes(query, { limit: 10 });
  },
};

/** 稳定文档标识：标题 + 总页数，笔记与 Agent 笔记工具共用。 */
function chatDocKey() {
  const title = String(els.docTitle?.textContent || '').trim().replace(/\s+/gu, ' ').slice(0, 200);
  const pages = Number(state.totalPages) || 0;
  if (!title && !pages) return 'unknown';
  return `t:${title}|p:${pages}`;
}

const chatPanel = createChatPanel({
  sendChat,
  renderMarkdown: (el, text) => renderMarkdown(el, text, true),
  getConfig: () => state.config || {},
  showToast,
  capturePageImage: captureVisiblePageImageForChat,
  getDocTitle: () => els.docTitle?.textContent || '',
  getDocKey: () => chatDocKey(),
  paperTools,
  goToPage: (n) => goToPage(n, { quiet: false }),
  // 面板打开即预取各页原文，深读工具对未译页立即可用。
  onOpen: () => { void prefetchAgentSourceText(); },
});

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), reader: $('reader'),
  pdfColumn: $('pdf-column'), panelColumn: $('panel-column'),
  pdfPages: $('pdf-pages'), panelPages: $('panel-pages'), divider: $('divider'),
  appVersion: $('app-version'), docTitle: $('doc-title'), progress: $('progress'),
  readerProgress: $('reader-progress'), progressBar: $('progress-bar'),
  zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoomLevel: $('zoom-level'),
  btnScrollLink: $('btn-scroll-link'),
  btnShortcuts: $('btn-shortcuts'),
  shortcutsDialog: $('shortcuts-dialog'), shortcutsClose: $('shortcuts-close'),
  pagePrev: $('page-prev'), pageNext: $('page-next'),
  pageJumpInput: $('page-jump-input'), pageJumpTotal: $('page-jump-total'),
  btnOutline: $('btn-outline'),
  btnSnip: $('btn-snip'),
  btnExportDoc: $('btn-export-doc'),
  btnRetry: $('btn-retry'), btnChat: $('btn-chat'), btnSettings: $('btn-settings'),
  profileSelect: $('viewer-profile-select'), profileModelStatus: $('viewer-model-status'),
  fileInput: $('file-input'), urlInput: $('url-input'), urlGo: $('url-go'), dzTip: $('dz-config-tip'),
  hud: $('hud'), hudSw: $('hud-sw'), hudToggle: $('hud-toggle'),
  hudInprog: $('hud-inprog'), hudDone: $('hud-done'), hudFailed: $('hud-failed'), hudLastErr: $('hud-lasterr'),
  toast: $('toast'),
};
const refreshLatestPublicProviderState = createLatestConfigRefresher(
  loadPublicConfig,
  commitPublicProviderState,
);
const latestDocumentLoader = createLatestDocumentLoader(async ({ arrayBuffer, title }) => {
  els.docTitle.textContent = title;
  await openPdf(arrayBuffer);
  // 文档已打开、docKey 可用：登记本地文件句柄，让「最近阅读」可一键重开。
  const handle = state.pendingFileHandle;
  state.pendingFileHandle = null;
  if (handle) {
    void import('../lib/recent-files.js')
      .then(({ saveRecentFileHandle }) => saveRecentFileHandle(chatDocKey(), handle))
      .catch(() => { /* 句柄库是加速器，失败不影响阅读 */ });
  }
});
const cleanupViewerSession = createViewerSessionCleanup({
  getSnapshot: () => ({
    generation: state.documentGeneration,
    controller: state.documentAbortController,
    scheduler: state.pageScheduler,
    pages: [...state.pages],
  }),
  cancelScheduler: ({ scheduler, generation }) => {
    scheduler.cancelGeneration(generation, 'Viewer closed');
    scheduler.cancelAll('Viewer closed');
  },
  cancelRequests: ({ pages }) => {
    for (const page of pages) {
      cancelPageTranslationRequests(page);
      for (const id of page.formulaRequestIds || []) client.cancel(id);
    }
  },
  abortDocument: ({ controller, generation }) => {
    if (state.documentGeneration !== generation) return;
    state.closedGeneration = generation;
    latestDocumentLoader.cancel();
    stopPortKeepAlive();
    controller?.abort(documentAbortError());
  },
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
init().catch((e) => {
  if (isExpectedExtensionReloadError(e)) {
    console.info('[PL-VIEW] extension reloaded; waiting for page refresh');
    showToast('扩展刚刚更新，请刷新当前阅读器页面。', true);
    return;
  }
  console.error(e);
  showToast('初始化失败：' + e.message, true);
});

async function init() {
  if (!pdfjsLib) { showToast('PDF.js 未能加载', true); return; }
  const buildLabel = PAPERLENS_BUILD_ID.replace(/^\d{4}\.\d{2}\.\d{2}-/u, '');
  const versionFull = `v${chrome.runtime.getManifest().version} · ${buildLabel} · KG${KATEX_GUARD_VERSION}`;
  // Keep the top bar clean: no truncated version chip; full string on brand hover.
  if (els.appVersion) {
    els.appVersion.textContent = '';
    els.appVersion.title = versionFull;
    els.appVersion.setAttribute('aria-label', versionFull);
  }
  const brand = document.querySelector('#toolbar .brand');
  if (brand) brand.title = `PaperLens ${versionFull}`;
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdf.worker.min.js');
  bindUi();
  window.addEventListener('pagehide', cleanupViewerSession);
  window.addEventListener('beforeunload', cleanupViewerSession);
  bindProviderStorageSync();
  await refreshPublicProviderState();
  checkBackend();
  const file = getFileParam();
  const reopenKey = getReopenParam();
  if (file) await loadFromUrl(file);
  else if (reopenKey) await reopenRecentLocalFile(reopenKey);
  else els.dropzone.hidden = false;
}

function getFileParam() {
  const s = location.search;
  const i = s.indexOf('file=');
  if (i < 0) return null;
  let v = s.slice(i + 5);
  try { v = decodeURIComponent(v); } catch { /* 原样 */ }
  return v || null;
}

/** popup「最近阅读」一键重开本地文件：?reopen=<docKey>。 */
function getReopenParam() {
  try {
    return new URLSearchParams(location.search).get('reopen') || null;
  } catch {
    return null;
  }
}

async function refreshPublicProviderState() {
  return refreshLatestPublicProviderState();
}

function commitPublicProviderState(config) {
  // 仅更新公开摘要；进行中的翻译请求继续使用后台在请求开始时取得的配置快照。
  state.config = config;
  applyReadingPreferences(config);
  renderPublicProviderState({
    profileSelect: els.profileSelect,
    profileModelStatus: els.profileModelStatus,
    configTip: els.dzTip,
  }, config, () => chrome.runtime.openOptionsPage());
}

// 阅读偏好热更新：options 保存配置 → storage 同步 → 本函数即时生效，
// 无需重新打开阅读器。bilingual 只切换 body class（原文行常驻 DOM，由
// CSS 控制显隐）；selectionTranslate 关闭时彻底移除划词监听。
function applyReadingPreferences(config) {
  document.body.classList.toggle('bilingual-src', config?.bilingual === true);
  syncSelectionTranslateListener(config?.selectionTranslate !== false);
  syncChatAssistant(config?.chatAssistant !== false);
}

// AI 助手开关热更新：关闭时隐藏工具栏入口并收起面板（不销毁历史，重开即恢复入口）。
function syncChatAssistant(enabled) {
  els.btnChat.hidden = !enabled;
  if (!enabled) {
    chatPanel.setOpen(false);
    syncPanelAskAiListener(false);
    closePanelAskMenu();
    return;
  }
  syncPanelAskAiListener(true);
  try { chatPanel.refreshModelLabel?.(); } catch { /* panel may not be mounted */ }
}

async function switchProviderProfile(event) {
  return switchProviderProfileForNewRequests({
    id: event.currentTarget.value,
    activeProfileId: state.config?.activeProfileId,
    select: event.currentTarget,
    activate: (id) => activateProviderProfile(id),
    refresh: refreshPublicProviderState,
    showToast,
  });
}

function bindProviderStorageSync() {
  const providerKeys = new Set(['config', 'providerProfiles', 'activeProfileId']);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!Object.keys(changes).some((key) => providerKeys.has(key))) return;
    refreshPublicProviderState().catch((error) => {
      console.error('[PL-VIEW] 刷新 Provider 状态失败', error);
      showToast(`刷新 Profile 失败：${error.message || String(error)}`, true);
    });
  });
}

// ---------------------------------------------------------------------------
// 健康检查 + HUD
// ---------------------------------------------------------------------------
function checkBackend() {
  setSwHealth('busy', '正在准备阅读器…');
  client.ping().then((message) => {
    if (message?.buildId !== PAPERLENS_BUILD_ID) {
      setSwHealth('bad', '扩展已更新，请刷新页面');
      showToast('扩展刚刚更新：请刷新这个阅读器页面后再继续翻译。', true);
      return;
    }
    setSwHealth('ok', '阅读器已就绪（可开多个标签并行翻译多篇）');
    startPortKeepAlive();
  })
    .catch(() => {
      setSwHealth('bad', '阅读器服务未连接，将自动重连…');
      try { client._scheduleReconnect(); } catch { /* noop */ }
    });
}
let healthHideTimer = null;
function setSwHealth(kind, text) {
  clearTimeout(healthHideTimer);
  els.hud.hidden = false;
  els.hudSw.className = 'hud-sw ' + kind;
  els.hudSw.textContent = text;
  if (kind === 'ok') {
    healthHideTimer = setTimeout(() => {
      if (els.hudSw.classList.contains('ok')) els.hud.hidden = true;
    }, 3200);
  }
}
function pageHasIssue(page) {
  const formulaFailed = Object.values(page?.formulaStates || {})
    .some((formulaState) => formulaState?.status === 'failed');
  return (
    page?.translationOutcome === 'partial'
    || page?.translationOutcome === 'failed'
    || Boolean(page?.translationError)
    || formulaFailed
  );
}
function pageIssueCount() {
  return state.pages.filter(pageHasIssue).length;
}
function updatePagePresentation(page, overrides = {}) {
  if (!page?.pageStatusEl) return;
  const presentation = buildPagePresentation({
    active: page.translationActive,
    phase: page.translationPhase,
    outcome: page.translationOutcome,
    unresolvedCount: page.unresolvedTranslationUnitIds?.length || 0,
    error: pageHasIssue(page),
    qualityWarning: Boolean(page.visionQualityFailure && String(page.translationText || '').trim()),
    ...overrides,
  });
  page.pageStatusEl.textContent = presentation.label;
  page.pageStatusEl.className = `page-status ${presentation.tone}`;
  page.pageStatusEl.setAttribute('aria-label', `本页状态：${presentation.label}`);
  if (page.pageRetryBtn) {
    page.pageRetryBtn.hidden = !presentation.retry;
    page.pageRetryBtn.disabled = Boolean(page.translationActive);
  }
  if (page.pageCopyBtn) {
    const canCopy = presentation.tone === 'success'
      || presentation.tone === 'warning'
      || (page.translationOutcome === 'done' || page.translationOutcome === 'partial');
    page.pageCopyBtn.hidden = !canCopy || Boolean(page.translationActive);
  }
  page.mdEl?.setAttribute('aria-busy', page.translationActive ? 'true' : 'false');
}
function updateHud() {
  els.hudInprog.textContent = state.inProgress;
  els.hudDone.textContent = state.doneCount;
  els.hudFailed.textContent = pageIssueCount();
  updateProgress();
}
function setLastError(msg) {
  if (!msg) { els.hudLastErr.hidden = true; return; }
  const friendly = friendlyReaderError(msg);
  els.hudLastErr.hidden = false;
  els.hudLastErr.textContent = friendly;
  els.hudLastErr.title = String(msg || '');
}
function updateProgress() {
  const summary = buildReaderProgress({
    total: state.totalPages,
    done: state.doneCount,
    inProgress: state.inProgress,
    issues: pageIssueCount(),
  });
  els.progress.textContent = summary.label;
  els.progress.title = summary.detail || summary.label || '';
  const progressHint = summary.detail || summary.label || '翻译进度';
  els.readerProgress.title = progressHint;
  els.readerProgress.setAttribute('aria-label', progressHint);
  els.readerProgress.className = `reader-progress ${summary.tone}`;
  els.progressBar.style.width = `${summary.percent}%`;
  els.progressBar.parentElement?.setAttribute('aria-valuenow', String(summary.percent));
  els.progressBar.parentElement?.setAttribute('aria-label', progressHint);
  const issues = pageIssueCount();
  els.btnRetry.hidden = issues === 0;
  els.btnRetry.textContent = issues > 1 ? `重试 ${issues} 页` : '重试未完成页';
  if (els.btnExportDoc) {
    const exportable = state.pages.some((p) => String(p.translationText || '').trim());
    els.btnExportDoc.hidden = !state.totalPages || !exportable;
  }
  if (els.btnOutline) els.btnOutline.hidden = !state.totalPages;
  if (els.btnSnip) els.btnSnip.hidden = !state.totalPages;
  refreshOutlinePanel();
  if (els.pageJumpTotal) {
    els.pageJumpTotal.textContent = `/ ${state.totalPages || 0}`;
  }
  if (els.pageJumpInput) {
    els.pageJumpInput.max = String(Math.max(1, state.totalPages || 1));
    if (!state.totalPages) els.pageJumpInput.value = '1';
  }
}

// ---------------------------------------------------------------------------
// 加载 PDF
// ---------------------------------------------------------------------------
async function loadFromUrl(url) {
  try {
    state.currentSourceUrl = url; // 记入最近阅读，popup 可一键重开
    showToast('正在下载 PDF…');
    await latestDocumentLoader.run(async ({ signal }) => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
      return {
        arrayBuffer: await response.arrayBuffer(),
        title: decodeURIComponent(url.split('/').pop() || ''),
      };
    });
  } catch (error) {
    showLoadError(errText(error));
  }
}

async function loadFromFile(file, { handle = null } = {}) {
  try {
    state.currentSourceUrl = null; // 本地文件无法通过 URL 重开
    state.pendingFileHandle = handle; // 打开成功后按 docKey 存句柄（一键重开）
    await latestDocumentLoader.run(async () => ({
      arrayBuffer: await file.arrayBuffer(),
      title: file.name,
    }));
  } catch (error) {
    showLoadError(errText(error));
  }
}

// 「最近阅读」一键重开本地文件：docKey → 已存句柄 → （必要时一次权限确认）→ 打开。
// 句柄失效（文件被移动/删除）时回退到文件选择并提示。
async function reopenRecentLocalFile(docKey) {
  els.dropzone.hidden = false;
  try {
    const { getRecentFileHandle, queryHandlePermission, requestHandlePermission } = await import('../lib/recent-files.js');
    const handle = await getRecentFileHandle(docKey);
    if (!handle) {
      showToast('该论文的文件授权已失效，请重新选择文件（选择后即可再次一键重开）', true);
      return;
    }
    let permission = await queryHandlePermission(handle);
    if (permission === 'prompt') {
      // 扩展页由 popup 打开属于用户手势链，可直接请求；被浏览器拒绝再走兜底。
      permission = await requestHandlePermission(handle);
    }
    if (permission !== 'granted') {
      bindReopenPermissionFallback(handle, docKey);
      return;
    }
    const file = await handle.getFile();
    await loadFromFile(file, { handle });
  } catch (error) {
    showToast(`一键重开失败：${friendlyReaderError(error)}。请重新选择文件。`, true);
  }
}

// 浏览器要求权限请求发生在用户手势内：在引导页显示一个「继续读上次的论文」
// 按钮，点击时请求权限并打开。
function bindReopenPermissionFallback(handle, docKey) {
  const actions = els.dropzone?.querySelector?.('.dz-actions');
  if (!actions || actions.querySelector('.dz-reopen-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary-btn dz-reopen-btn';
  btn.textContent = '继续读上次的论文';
  btn.addEventListener('click', async () => {
    try {
      const { requestHandlePermission } = await import('../lib/recent-files.js');
      if ((await requestHandlePermission(handle)) !== 'granted') {
        showToast('未获得文件读取权限，请重新选择文件', true);
        return;
      }
      btn.remove();
      await loadFromFile(await handle.getFile(), { handle });
    } catch (error) {
      showToast(`打开失败：${friendlyReaderError(error)}`, true);
    }
  });
  actions.prepend(btn);
  showToast('浏览器需要你点一下「继续读上次的论文」以确认文件访问权限');
}

function errText(e) {
  if (e && e.name === 'PasswordException') return '此 PDF 已加密、未提供正确密码。请换未加密的 PDF。';
  if (e && e.name === 'InvalidPDFException') return '文件不是有效的 PDF。';
  return friendlyReaderError(e);
}
function showLoadError(msg) { els.reader.hidden = true; els.dropzone.hidden = false; showToast(friendlyReaderError(msg), true); }


function isCurrentDocument(generation) {
  return state.documentGeneration === generation && state.closedGeneration !== generation;
}

function documentAbortError() {
  if (typeof DOMException === 'function') return new DOMException('Document changed', 'AbortError');
  return Object.assign(new Error('Document changed'), { name: 'AbortError' });
}

function resetDocumentState() {
  agentSearchIndexCache = null;
  agentSourcePrefetchPromise = null;
  const previousGeneration = state.documentGeneration;
  const previousPdf = state.pdf;
  const previousLoadingTask = state.loadingTask;

  closeSelectionPopover();
  state.documentGeneration += 1;
  state.closedGeneration = null;
  state.documentAbortController?.abort(documentAbortError());
  state.documentUiController?.abort();
  state.renderObserver?.disconnect();
  state.translateObserver?.disconnect();
  state.recycleObserver?.disconnect();
  state.pageScheduler.cancelGeneration(previousGeneration, 'Document changed');
  state.pageScheduler.cancelAll('Document changed');
  clearTimeout(state.scrollSyncTimer);
  state.scrollSyncTimer = null;
  state.scrollSyncSuspended = false;
  if (state.scrollSyncFrame) cancelAnimationFrame(state.scrollSyncFrame);
  state.scrollSyncFrame = 0;
  clearTimeout(state.scrollRealignTimer);
  state.scrollRealignTimer = null;
  if (state.scrollRealignFrame) cancelAnimationFrame(state.scrollRealignFrame);
  state.scrollRealignFrame = 0;
  state.scrollLayoutObserver?.disconnect();
  state.scrollLayoutObserver = null;
  state.scrollSyncGuard?.clear();

  for (const page of state.pages) {
    cancelPageTranslationRequests(page);
    for (const id of page.formulaRequestIds || []) client.cancel(id);
    clearTimeout(page._hlTimer);
    clearSmartPageRetry(page);
  }

  try { previousLoadingTask?.destroy(); } catch { /* noop */ }
  if (previousPdf && previousPdf !== previousLoadingTask) {
    try { void Promise.resolve(previousPdf.destroy()).catch(() => {}); } catch { /* noop */ }
  }

  state.pdf = null;
  state.loadingTask = null;
  state.pages = [];
  state.totalPages = 0;
  state.navPageNumber = 1;
  state.navScrollLockUntil = 0;
  state.doneCount = 0;
  state.inProgress = 0;
  state.failedCount = 0;
  state.renderObserver = null;
  state.translateObserver = null;
  state.recycleObserver = null;
  state.documentAbortController = new AbortController();
  state.documentUiController = new AbortController();
  state.pageScheduler = createPageScheduler({ concurrency: 2 });
  formulaQueue = Promise.resolve();
  els.pdfPages.replaceChildren();
  els.panelPages.replaceChildren();
  els.pdfColumn.scrollTop = 0;
  els.panelColumn.scrollTop = 0;
  setLastError('');
  updateProgress();
  updateHud();
  return state.documentGeneration;
}

// ---------------------------------------------------------------------------
// 左栏：原版 PDF
// ---------------------------------------------------------------------------

/** 非阻塞 PDF 密码对话框。返回输入的密码；取消 / Esc 返回 null。 */
function requestPdfPassword(promptText) {
  return new Promise((resolve) => {
    document.querySelector('.pdf-password-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pdf-password-overlay';
    const dialog = document.createElement('form');
    dialog.className = 'pdf-password-dialog';
    const label = document.createElement('div');
    label.className = 'pdf-password-label';
    label.textContent = String(promptText || '请输入 PDF 打开密码：');
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'pdf-password-input';
    input.autocomplete = 'current-password';
    input.placeholder = '打开密码';
    const actions = document.createElement('div');
    actions.className = 'pdf-password-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pdf-password-btn';
    cancelBtn.textContent = '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'submit';
    okBtn.className = 'pdf-password-btn primary';
    okBtn.textContent = '打开';
    actions.append(cancelBtn, okBtn);
    dialog.append(label, input, actions);
    overlay.appendChild(dialog);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      resolve(value);
    };
    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(null);
      }
    };
    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      close(input.value);
    });
    cancelBtn.addEventListener('click', () => close(null));
    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  });
}

async function openPdf(arrayBuffer) {
  const generation = resetDocumentState();
  els.dropzone.hidden = true;
  els.reader.hidden = false;
  showToast('正在解析 PDF…');
  // 文档打开期间保持后台 Service Worker 活跃，降低多标签并行时被回收的概率。
  startPortKeepAlive();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    canvasFactory: createReadOptimizedCanvasFactory(document),
  });
  state.loadingTask = loadingTask;
  loadingTask.onPassword = (updatePassword, reason) => {
    const promptText = reason === 2 ? 'PDF 密码错误，请重新输入：' : '此 PDF 已加密，请输入打开密码：';
    // 非阻塞对话框替代 window.prompt：不冻结主线程，且输入以密码形式遮掩。
    void requestPdfPassword(promptText).then((password) => {
      if (password === null) {
        try { loadingTask.destroy(); } catch { /* noop */ }
        return;
      }
      updatePassword(password);
    });
  };

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    if (!isCurrentDocument(generation)) return;
    throw error;
  }
  if (!isCurrentDocument(generation)) {
    try { await pdf.destroy(); } catch { /* noop */ }
    return;
  }
  state.pdf = pdf;
  state.totalPages = pdf.numPages;
  // 在任何滚动/导航覆盖记录之前，先取出上次的阅读进度。
  const savedReadingEntry = getReadingProgress(chatDocKey());

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const viewport1 = { width: 612, height: 792 };
    const pageEl = buildPagePlaceholder(pageNumber, viewport1);
    const panel = buildPanelSection(pageNumber, pdf.numPages);
    state.pages.push({
      num: pageNumber,
      documentGeneration: generation,
      pageObj: null,
      pagePromise: null,
      viewport1,
      pageEl,
      ...panel,
      translateStarted: false,
      trId: null,
      translationRequestIds: new Set(),
      unresolvedTranslationItems: [],
      unresolvedTranslationUnitIds: [],
    });
  }

  try {
    await ensurePdfPage(0, generation);
  } catch (error) {
    if (!isCurrentDocument(generation)) return;
    throw error;
  }
  if (!isCurrentDocument(generation)) return;
  setupLazyRender();
  setupCanvasRecycler();
  setupLazyTranslate();
  setupScrollSync();
  setupSelectionLink();
  hideToast();
  if (!state.config.hasApiKey) showToast('尚未配置 API Key，点击工具栏图标 → 设置', true);
  updateProgress();
  maybeOfferResume(savedReadingEntry);
  maybeShowOnboarding();
}

async function ensurePdfPage(pageIndex, generation = state.documentGeneration) {
  const pageState = state.pages[pageIndex];
  if (!pageState || !state.pdf) throw new RangeError(`PDF page ${pageIndex} is unavailable`);
  if (!isCurrentDocument(generation) || pageState.documentGeneration !== generation) {
    throw documentAbortError();
  }
  if (pageState.pageObj) return pageState.pageObj;
  if (pageState.pagePromise) return pageState.pagePromise;

  pageState.pagePromise = state.pdf.getPage(pageIndex + 1).then((page) => {
    if (!isCurrentDocument(generation) || pageState.documentGeneration !== generation) {
      try { page.cleanup?.(); } catch { /* noop */ }
      throw documentAbortError();
    }
    pageState.pageObj = page;
    pageState.viewport1 = page.getViewport({ scale: 1 });
    pageState.pageEl.style.width = `${pageState.viewport1.width * state.scale}px`;
    pageState.pageEl.style.height = `${pageState.viewport1.height * state.scale}px`;
    return page;
  }).finally(() => {
    pageState.pagePromise = null;
  });
  return pageState.pagePromise;
}

function buildPagePlaceholder(num, viewport1) {
  const div = document.createElement('div');
  div.className = 'pdf-page';
  div.dataset.page = String(num);
  div.style.width = `${viewport1.width * state.scale}px`;
  div.style.height = `${viewport1.height * state.scale}px`;
  els.pdfPages.appendChild(div);
  return div;
}

function setupLazyRender() {
  state.renderObserver?.disconnect();
  state.renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageIndex = Number(entry.target.dataset.page) - 1;
      renderPage(entry.target).catch((error) => {
        if (error?.name !== 'AbortError') console.warn('render', error);
      });
      schedulePagePriority(pageIndex);
    }
  }, { root: els.pdfColumn, rootMargin: '500px 0px' });
  for (const p of state.pages) state.renderObserver.observe(p.pageEl);
}

// 离屏 canvas 回收：页滚出宽窗口后释放位图与文字层（占位尺寸保留，滚回时由
// renderObserver 按需重渲）。长文档内存从「所有已渲染页常驻」降为「窗口内几页」。
const RECYCLE_MARGIN_PX = 3000;

function releasePageCanvas(p) {
  const pageEl = p?.pageEl;
  if (!pageEl || pageEl.dataset.renderedScale == null) return false;
  delete pageEl.dataset.renderedScale;
  pageEl.querySelectorAll('canvas, .textLayer').forEach((node) => {
    if (node instanceof HTMLCanvasElement) { node.width = 0; node.height = 0; }
    node.remove();
  });
  return true;
}

function setupCanvasRecycler() {
  state.recycleObserver?.disconnect();
  state.recycleObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const pageEl = entry.target;
      const num = Number(pageEl.dataset.page);
      const p = state.pages[num - 1];
      if (!p || p.pageEl !== pageEl) continue;
      // 回调是异步的：用新鲜 rect 复核，避免用户快速折返时误回收。
      const rect = pageEl.getBoundingClientRect();
      const rootRect = els.pdfColumn.getBoundingClientRect();
      if (rect.bottom > rootRect.top - RECYCLE_MARGIN_PX && rect.top < rootRect.bottom + RECYCLE_MARGIN_PX) continue;
      if (releasePageCanvas(p)) {
        // 重新 observe：若该页其实仍在渲染窗口内（竞态），renderObserver 会
        // 立即收到一次带当前交叉状态的回调并重渲，自愈而不是留白。
        state.renderObserver?.unobserve(pageEl);
        state.renderObserver?.observe(pageEl);
      }
    }
  }, { root: els.pdfColumn, rootMargin: `${RECYCLE_MARGIN_PX}px 0px` });
  for (const p of state.pages) state.recycleObserver.observe(p.pageEl);
}

async function renderPage(pageEl) {
  const num = Number(pageEl.dataset.page);
  const p = state.pages[num - 1];
  const generation = state.documentGeneration;
  await ensurePdfPage(num - 1, generation);
  if (!isCurrentDocument(generation) || !p?.pageObj) return;
  const wantScale = state.scale;
  if (pageEl.dataset.renderedScale === String(wantScale)) return;
  // 先打标防止 IntersectionObserver 重入触发重复渲染；失败时必须收回标记，
  // 否则渲染异常的页会被当成「已渲染」而永远空白。
  pageEl.dataset.renderedScale = String(wantScale);

  const viewport = p.pageObj.getViewport({ scale: wantScale });
  try {
    const dpr = window.devicePixelRatio || 1;
    pageEl.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageEl.insertBefore(canvas, pageEl.firstChild);
    const ctx = getReadOptimized2dContext(canvas, { alpha: false });
    await p.pageObj.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  } catch (error) {
    if (pageEl.dataset.renderedScale === String(wantScale)) delete pageEl.dataset.renderedScale;
    throw error;
  }

  try {
    const textContent = await p.pageObj.getTextContent();
    if (!p.agentSourceText) p.agentSourceText = agentTextFromTextContent(textContent);
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.width = `${viewport.width}px`;
    tl.style.height = `${viewport.height}px`;
    // PDF.js 3.x 的 textLayer span 用 calc(var(--scale-factor)*Npx) 定字号，且运行时
    // 会核对 --scale-factor 是否等于 viewport.scale。这里用同一个 wantScale 渲染
    // canvas 与 textLayer，两层严格同尺同缩放，选择热区才能贴合字形。
    tl.style.setProperty('--scale-factor', wantScale);
    pageEl.appendChild(tl);
    const task = pdfjsLib.renderTextLayer({ textContentSource: textContent, container: tl, viewport, textDivs: [] });
    await (task.promise || task);
    // 裸 renderTextLayer API 不会补 TextLayerBuilder 里的 endOfContent 承接层与
    // 选择手势处理；缺了它，跨行/行末/span 间隙拖选时浏览器会把选区跳到 DOM 顺序
    // 上相邻但视觉上很远的 span，导致“选不中/选偏/跳选”。下面补齐这套机制。
    enhanceTextLayerSelection(tl);
  } catch (e) { console.warn('text layer failed', e); }
}

// 复刻 PDF.js TextLayerBuilder 的选择连续性处理：追加一个 endOfContent 承接元素，
// 并在按下时给 textLayer 加 `selecting` class。CSS 里 `.selecting .endOfContent`
// 会把该承接层铺满整页文字区域，使拖选能顺滑跨越 span 间隙与行末，不再跳选。
// 指针可能在页外松开，故用一次性的全局 pointerup/cancel 统一清除 `selecting`，
// 避免每次重渲染都往 document 挂新监听造成泄漏。
let textLayerSelectionCleanupBound = false;
function enhanceTextLayerSelection(tl) {
  if (!tl || tl.querySelector(':scope > .endOfContent')) return;
  const endOfContent = document.createElement('div');
  endOfContent.className = 'endOfContent';
  tl.appendChild(endOfContent);
  tl.addEventListener('pointerdown', () => tl.classList.add('selecting'));
  if (textLayerSelectionCleanupBound) return;
  textLayerSelectionCleanupBound = true;
  const clearSelecting = () => {
    for (const layer of els.pdfPages.querySelectorAll('.textLayer.selecting')) {
      layer.classList.remove('selecting');
    }
  };
  document.addEventListener('pointerup', clearSelecting);
  document.addEventListener('pointercancel', clearSelecting);
}

// 把一页渲染成 JPEG data URL（发给视觉模型）。用固定尺寸控制清晰度与 token 成本。
async function renderPageImage(p, targetWidth = 1500) {
  const documentGeneration = p.documentGeneration;
  await ensurePdfPage(p.num - 1, p.documentGeneration);
  const base = p.viewport1;
  const safeTargetWidth = Math.max(1200, Math.min(2100, Number(targetWidth) || 1500));
  const scale = Math.min(3.5, safeTargetWidth / base.width);
  const viewport = p.pageObj.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = getReadOptimized2dContext(canvas, { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.pageObj.render({ canvasContext: ctx, viewport }).promise;
  if (!isCurrentDocument(documentGeneration)) throw documentAbortError();
  return canvas.toDataURL('image/jpeg', safeTargetWidth >= 1900 ? 0.9 : 0.86);
}

// 检测页面上的「图形区域」：有墨迹但几乎没有文字覆盖的矩形块，裁成图片。
// 用于把论文里的图/示意图/复杂公式原样搬到右栏。返回 [{dataUrl, yTop}]（按从上到下）。
async function detectFigures(p) {
  try {
    await ensurePdfPage(p.num - 1, p.documentGeneration);
    const s = 2;                                   // 检测用的渲染倍率
    const vp = p.pageObj.getViewport({ scale: s });
    const W = Math.floor(vp.width), H = Math.floor(vp.height);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = getReadOptimized2dContext(canvas, { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    await p.pageObj.render({ canvasContext: ctx, viewport: vp }).promise;

    // 文字覆盖掩码：把所有文本 item 的包围盒标记为「已占用」
    const tc = await p.pageObj.getTextContent();
    const textRows = new Uint8Array(H);            // 每一行(y)是否含文字
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = it.transform; if (!t) continue;
      const x = t[4] * s;
      const yBottom = (p.viewport1.height - t[5]) * s;
      const fh = (Math.hypot(t[2], t[3]) || 10) * s;
      const y0 = Math.max(0, Math.floor(yBottom - fh * 1.3));
      const y1 = Math.min(H - 1, Math.ceil(yBottom + fh * 0.4));
      for (let y = y0; y <= y1; y++) textRows[y] = 1;
    }

    // 每行的「墨迹量」：非白像素计数（抽样列以加速）
    const img = ctx.getImageData(0, 0, W, H).data;
    const inkRows = new Float32Array(H);
    const step = 3;
    for (let y = 0; y < H; y++) {
      let ink = 0;
      for (let x = 0; x < W; x += step) {
        const i = (y * W + x) * 4;
        if (img[i] < 245 || img[i + 1] < 245 || img[i + 2] < 245) ink++;
      }
      inkRows[y] = ink / (W / step);              // 0..1 该行非白比例
    }

    // 找「有墨迹但无文字」的连续纵向条带 -> 候选图形区
    const bands = [];
    let start = -1;
    for (let y = 0; y < H; y++) {
      const isGraphic = inkRows[y] > 0.02 && textRows[y] === 0;
      if (isGraphic) { if (start < 0) start = y; }
      else if (start >= 0) { pushBand(bands, start, y - 1); start = -1; }
    }
    if (start >= 0) pushBand(bands, start, H - 1);

    // 过滤：太矮的忽略（噪声/分隔线）；裁剪并输出
    const figs = [];
    const minH = H * 0.04;
    for (const b of bands) {
      if (b.y1 - b.y0 < minH) continue;
      const pad = 6;
      const y0 = Math.max(0, b.y0 - pad), y1 = Math.min(H - 1, b.y1 + pad);
      const bh = y1 - y0;
      const crop = document.createElement('canvas');
      crop.width = W; crop.height = bh;
      getReadOptimized2dContext(crop).drawImage(canvas, 0, y0, W, bh, 0, 0, W, bh);
      figs.push({ dataUrl: crop.toDataURL('image/png'), yTop: y0 / s });
    }
    console.log('[PL-VIEW] 第', p.num, '页检测到图形区', figs.length, '个');
    return figs;
  } catch (e) {
    console.warn('[PL-VIEW] detectFigures 失败', p.num, e);
    return [];
  }
}
function pushBand(bands, y0, y1) { bands.push({ y0, y1 }); }

// 把 Markdown 里渲染出的「@@FIGURE@@ / @@TABLE@@」占位替换成裁剪图或「查看左侧」提示。
function fillFigureSlots(el, figures) {
  replaceMediaPlaceholders(el, '@@FIGURE@@', {
    figures,
    readingLabel: getReadingMediaPresentation({ kind: 'image' })?.label || '查看左侧原图',
    cropClass: 'fig-crop',
    refClass: 'blk source-ref source-ref-image',
  });
  replaceMediaPlaceholders(el, '@@TABLE@@', {
    figures: [], // tables: never invent a grid; always point back to the PDF
    readingLabel: '查看左侧原表',
    cropClass: 'table-crop',
    refClass: 'blk source-ref table-source-ref',
    alwaysRef: true,
  });
}

function replaceMediaPlaceholders(el, token, {
  figures = [],
  readingLabel = '查看左侧',
  cropClass = 'fig-crop',
  refClass = 'blk source-ref',
  alwaysRef = false,
} = {}) {
  if (!el || !token) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes(token)) hits.push(node);
  }
  if (state.readerMode === 'reading' || alwaysRef) {
    for (const textNode of hits) {
      const pieces = textNode.nodeValue.split(token);
      const fragment = document.createDocumentFragment();
      pieces.forEach((piece, index) => {
        if (piece) fragment.appendChild(document.createTextNode(piece));
        if (index >= pieces.length - 1) return;
        const ref = document.createElement('span');
        ref.className = refClass;
        ref.dataset.blk = '-1';
        ref.textContent = readingLabel;
        fragment.appendChild(ref);
      });
      textNode.replaceWith(fragment);
    }
    return;
  }
  let idx = 0;
  for (const textNode of hits) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const fig = figures[idx];
    if (fig) {
      const wrap = document.createElement('div');
      wrap.className = cropClass;
      const im = document.createElement('img');
      im.src = fig.dataUrl;
      wrap.appendChild(im);
      parent.replaceChild(wrap, textNode);
      idx += 1;
    } else {
      textNode.nodeValue = textNode.nodeValue.replaceAll
        ? textNode.nodeValue.replaceAll(token, '')
        : textNode.nodeValue.split(token).join('');
    }
  }
  for (; idx < figures.length; idx += 1) {
    const wrap = document.createElement('div');
    wrap.className = cropClass;
    const im = document.createElement('img');
    im.src = figures[idx].dataUrl;
    wrap.appendChild(im);
    el.appendChild(wrap);
  }
}

/**
 * Models sometimes still emit GFM tables despite the prompt. Replace them with
 * @@TABLE@@ so fillFigureSlots can show "查看左侧原表" instead of ugly grids.
 */
export function stripMarkdownTablesToPlaceholders(markdown) {
  const src = String(markdown || '');
  if (!src.includes('|')) return src;
  // GFM table: header row + separator + body rows
  return src.replace(
    /(^|\n)((?:[ \t]*>?[ \t]*)?\|.+\|[ \t]*\n(?:[ \t]*>?[ \t]*)?\|[\s:\-|]+\|[ \t]*\n(?:(?:[ \t]*>?[ \t]*)?\|.+\|[ \t]*\n?)*)/gm,
    (full, lead) => `${lead}@@TABLE@@\n`,
  );
}

// ---------------------------------------------------------------------------
// 右栏：每页视觉翻译面板
// ---------------------------------------------------------------------------
function buildPanelSection(num, total) {
  const section = document.createElement('section');
  section.className = 'panel-page';
  section.dataset.page = String(num);

  const sep = document.createElement('div');
  sep.className = 'panel-page-sep';
  const heading = document.createElement('div');
  heading.className = 'page-heading';
  const pageNumber = document.createElement('button');
  pageNumber.type = 'button';
  pageNumber.className = 'page-number';
  pageNumber.textContent = `第 ${num} 页`;
  pageNumber.title = `跳到第 ${num} 页（左右栏同步）`;
  pageNumber.setAttribute('aria-label', `跳到第 ${num} 页`);
  pageNumber.addEventListener('click', () => {
    goToPage(num, { quiet: false });
  });
  const pageStatus = document.createElement('span');
  pageStatus.className = 'page-status idle';
  pageStatus.textContent = '等待翻译';
  pageStatus.setAttribute('aria-label', '本页状态：等待翻译');
  heading.append(pageNumber, pageStatus);

  const actions = document.createElement('div');
  actions.className = 'page-actions';
  const hint = document.createElement('span');
  hint.className = 'page-hint';
  hint.textContent = '双击内容可定位原文';
  const copyButton = document.createElement('button');
  copyButton.className = 'copy-page';
  copyButton.type = 'button';
  copyButton.title = '复制本页译文纯文本';
  copyButton.textContent = '复制';
  copyButton.hidden = true;
  const retryButton = document.createElement('button');
  retryButton.className = 'retry-page';
  retryButton.type = 'button';
  retryButton.title = '只重试本页未完成的内容';
  retryButton.textContent = '重试本页';
  retryButton.hidden = true;
  actions.append(hint, copyButton, retryButton);
  sep.append(heading, actions);

  copyButton.addEventListener('click', async () => {
    const p = state.pages[num - 1];
    if (!p?.mdEl) return;
    const text = String(p.mdEl.innerText || p.mdEl.textContent || '')
      .replace(/\u00a0/g, ' ')
      .trim();
    if (!text || p.mdEl.classList.contains('page-placeholder') || p.mdEl.classList.contains('error')) {
      showToast('本页还没有可复制的译文', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      copyButton.textContent = '已复制';
      setTimeout(() => { copyButton.textContent = '复制'; }, 1200);
    } catch {
      showToast('复制失败，请手动选择文本', true);
    }
  });

  retryButton.addEventListener('click', () => {
    const p = state.pages[num - 1];
    if (!p) return;
    retryButton.disabled = true;
    // 手动重试允许再次走自动断线重试配额。
    p.connectionAutoRetryGeneration = null;
    if (p.translationActive) {
      p.retryRequested = true;
      cancelPageTranslationRequests(p);
      return;
    }
    p.translateStarted = false;
    updatePagePresentation(p, { active: true });
    translatePage(num);
  });

  const md = document.createElement('div');
  md.className = 'md page-placeholder';
  md.setAttribute('aria-busy', 'false');
  md.innerHTML = '<div class="page-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div>';
  md.addEventListener('dblclick', (event) => {
    const p = state.pages[num - 1];
    if (!p) return;
    const blk = event.target.closest?.('.blk[data-blk]');
    const irTarget = event.target.closest?.('[data-ir-id]');
    const irGeometry = irTarget && md.contains(irTarget)
      ? readingGeometry(p, irTarget.dataset.irId)
      : null;
    const irBoxes = readingTargetBoxes(irGeometry);
    if (irBoxes.length) {
      flashElement(irTarget);
      highlightPdfRegions(p, irBoxes);
      return;
    }
    if (blk && md.contains(blk)) {
      const meta = p.blkMeta?.[Number(blk.dataset.blk)];
      flashElement(blk);
      if (meta?.bbox) highlightPdfRegion(p, meta.bbox);
      else linkTo('pdf', els.pdfColumn, p.pageEl);
      return;
    }
    // Vision path has no per-block IR: double-click still maps whole pages.
    flashElement(md);
    linkTo('pdf', els.pdfColumn, p.pageEl);
  });

  section.append(sep, md);
  els.panelPages.appendChild(section);
  return {
    sectionEl: section,
    mdEl: md,
    pageStatusEl: pageStatus,
    pageRetryBtn: retryButton,
    pageCopyBtn: copyButton,
  };
}

function pageIrText(block) {
  if (block.kind === 'paragraph' && Array.isArray(block.segments)) {
    return block.segments.map((segment) => (
      segment.kind === 'inline_math' ? `\\(${segment.latex || ''}\\)` : (segment.text || '')
    )).join('');
  }
  if (block.kind === 'heading') return `### ${block.text || ''}`;
  return block.text || '';
}

function pageIrToLegacyBlocks(pageIr) {
  const blocks = [];
  for (const block of pageIr.blocks) {
    if (block.kind === 'display_math') {
      blocks.push({
        kind: 'formula',
        latex: block.latex || '',
        number: block.number || '',
        name: block.image_ref || block.name || block.id,
        bbox: block.bbox,
      });
      continue;
    }
    if (block.kind === 'figure') {
      blocks.push({
        kind: 'image',
        name: block.image_ref || block.name || block.id,
        bbox: block.bbox,
      });
      continue;
    }
    if (block.kind === 'table') {
      const caption = block.caption?.text ? `${block.caption.text}\n` : '';
      const rows = block.rows.map((row) => row.map((cell) => cell.text || '').join('\t')).join('\n');
      blocks.push({ kind: 'text', md: `${caption}${rows}`.trim(), bbox: block.bbox });
      continue;
    }
    const text = pageIrText(block).trim();
    if (text) blocks.push({ kind: 'text', md: text, bbox: block.bbox });
  }
  return blocks;
}

function readingGeometry(p, id) {
  if (!p || !id) return null;
  return {
    id,
    bbox: p.irBboxes?.get(id),
    bboxes: p.irBboxFragments?.get(id),
  };
}

function rememberStructuredText(p, element, id, text, bbox, bboxes = []) {
  p.irBboxes ||= new Map();
  p.irBboxFragments ||= new Map();
  element.dataset.irId = id;
  element.textContent = '';
  element.classList.add('structured-text-pending');
  element.setAttribute('aria-label', '译文生成中');
  element.setAttribute('title', '双击定位左侧原文');
  p.sourceTextById ||= new Map();
  p.sourceTextById.set(id, String(text || ''));
  p.nodeEls.set(id, element);
  p.irBboxes.set(id, bbox);
  if (Array.isArray(bboxes) && bboxes.length) p.irBboxFragments.set(id, bboxes);
  return element;
}

function formulaSourceText(formula) {
  return String(formula?.source_text || formula?.sourceText || '').trim();
}

// PDF text layers often yield strings that KaTeX can parse but that have
// already lost their two-dimensional structure.  Parseability alone is not a
// trust signal: canonicalize the hint, compare it with the source glyphs, and
// require a clean KaTeX preflight before it is ever shown to the reader.
function trustedRenderableFormulaLatex(formula) {
  const latex = canonicalizeFormulaLatex(String(formula?.latex || ''));
  if (!latex) return '';
  if (!assessFormulaLatex(latex, { sourceText: formulaSourceText(formula) }).ok) return '';
  return isKatexRenderable(latex) ? latex : '';
}

function renderStructuredTableCell(element, cell) {
  const formulaCell = ['formula', 'inline_math', 'display_math'].includes(cell.kind);
  const latex = formulaCell ? trustedRenderableFormulaLatex(cell) : '';
  if (latex) {
    try {
      if (typeof window.katex?.render !== 'function') throw new Error('KaTeX unavailable');
      window.katex.render(latex, element, {
        displayMode: false,
        throwOnError: true,
        strict: 'ignore',
      });
      return;
    } catch {
      // Keep a readable source string when one cell cannot be rendered.
    }
  }
  element.textContent = cell.source_text || cell.text || cell.latex || '';
}

function createTableBlock(block, p) {
  p.irBboxes ||= new Map();
  p.irBboxFragments ||= new Map();
  const model = {
    id: block.id,
    bbox: block.bbox,
    caption: block.caption || null,
    imageRef: block.image_ref || block.imageRef || '',
  };
  const figure = document.createElement('figure');
  figure.className = 'structured-table';
  figure.dataset.irId = model.id;
  p.irBboxes.set(model.id, model.bbox);
  p.irBboxFragments.set(model.id, [model.bbox]);
  figure.setAttribute('title', '双击定位左侧原表');

  const caption = document.createElement('figcaption');
  if (model.caption) {
    // Reading mode follows the conventional academic table-caption treatment:
    // captions and footnotes stay centered against the authoritative crop.
    // PyMuPDF line boxes are frequently narrower than the table and otherwise
    // misclassify a visually centered multi-line caption as left aligned.
    caption.className = 'table-caption table-caption-center';
    rememberStructuredText(
      p,
      caption,
      model.caption.id,
      model.caption.text,
      model.caption.bbox || model.bbox,
      model.caption.bbox ? [model.caption.bbox] : [],
    );
    caption.setAttribute('id', `caption-${model.caption.id}`);
  }

  // Product rule: tables stay on the PDF side (like figures). Never rebuild a
  // translated HTML grid — it wraps numbers badly and often pulls body prose
  // into cells. Show the crop (or a jump-to-left hint) and translate caption only.
  const imageUrl = model.imageRef
    ? (p.layoutImages?.[model.imageRef] || findImageLoose(p.layoutImages || {}, model.imageRef))
    : '';
  let source;
  if (imageUrl) {
    source = document.createElement('img');
    source.className = 'table-source-image';
    source.src = imageUrl;
    source.alt = model.caption?.text || '原表';
  } else {
    source = document.createElement('button');
    source.setAttribute('type', 'button');
    source.className = 'source-ref table-source-ref';
    source.textContent = '查看左侧原表';
  }
  if (model.caption?.position === 'below') figure.append(source, caption);
  else if (model.caption) figure.append(caption, source);
  else figure.appendChild(source);
  return figure;
}

function normalizedFormulaBbox(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [x0, y0, x1, y1] = value;
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

function cropFormulaCanvas(canvas, bbox, { padScale = 1 } = {}) {
  const box = normalizedFormulaBbox(bbox);
  if (!canvas || !box || !canvas.width || !canvas.height) return '';
  const [x0, y0, x1, y1] = box;
  const padX = Math.max(4, Math.round(canvas.width * 0.003 * padScale));
  const padY = Math.max(3, Math.round(canvas.height * 0.0018 * padScale));
  const sx = Math.max(0, Math.floor(x0 * canvas.width) - padX);
  const sy = Math.max(0, Math.floor(y0 * canvas.height) - padY);
  const ex = Math.min(canvas.width, Math.ceil(x1 * canvas.width) + padX);
  const ey = Math.min(canvas.height, Math.ceil(y1 * canvas.height) + padY);
  const width = ex - sx;
  const height = ey - sy;
  if (width < 2 || height < 2) return '';

  const crop = document.createElement('canvas');
  crop.width = width;
  crop.height = height;
  const context = getReadOptimized2dContext(crop, { alpha: false });
  if (!context) return '';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(canvas, sx, sy, width, height, 0, 0, width, height);
  return crop.toDataURL('image/png');
}

function inlineFormulaPreview(p, segment) {
  p.inlineFormulaPreviews ||= new Map();
  if (p.inlineFormulaPreviews.has(segment.id)) return p.inlineFormulaPreviews.get(segment.id);
  const canvas = p.pageEl?.querySelector?.('canvas');
  const displayBbox = irBoxToDisplay(segment.bbox, p.pageObj?.rotate || 0);
  const image = cropFormulaCanvas(canvas, displayBbox);
  if (image) p.inlineFormulaPreviews.set(segment.id, image);
  return image;
}

function renderInlineMathHost(host, segment, imageUrl = '', status = '') {
  const latex = trustedRenderableFormulaLatex(segment);
  const boundaryClasses = ['inline-math-space-before', 'inline-math-space-after']
    .filter((className) => host.classList.contains(className));
  host.replaceChildren();
  host.className = ['structured-inline-math', ...boundaryClasses].join(' ');
  host.removeAttribute('role');
  host.removeAttribute('aria-label');
  try {
    if (!latex || typeof window.katex?.render !== 'function') {
      throw new Error('KaTeX unavailable');
    }
    window.katex.render(latex, host, {
      displayMode: false,
      throwOnError: true,
      strict: 'ignore',
    });
    return true;
  } catch {
    if (imageUrl) {
      const image = document.createElement('img');
      image.className = 'inline-formula-source';
      image.src = imageUrl;
      image.alt = formulaSourceText(segment) || '原公式';
      host.appendChild(image);
      host.classList.add('inline-math-source');
      host.setAttribute('aria-label', status === 'failed' ? '原公式' : '原公式，正在识别 LaTeX');
      return false;
    }
    host.textContent = status === 'failed' ? '查看公式' : '…';
    host.classList.add(status === 'failed' ? 'inline-math-failed' : 'inline-math-pending');
    if (status !== 'failed') host.setAttribute('role', 'status');
    return false;
  }
}

function renderStructuredInlineFormula(p, segment) {
  const entry = p.structuredInlineFormulaHosts?.get(segment.id);
  if (!entry) return;
  const formulaState = p.formulaStates?.[formulaStateKey(segment, p.num, 0)];
  const renderedSegment = formulaState?.status === 'done' && formulaState.latex
    ? { ...segment, latex: formulaState.latex }
    : segment;
  const imageUrl = formulaState?.crop || inlineFormulaPreview(p, segment);
  renderInlineMathHost(entry.host, renderedSegment, imageUrl, formulaState?.status || '');
}

function structuredSegmentBbox(segment, block) {
  const bbox = segment?.bbox;
  return Array.isArray(bbox) && bbox.length === 4
    && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1]
    ? bbox
    : block.bbox;
}

function structuredSegmentBboxes(segment) {
  if (Array.isArray(segment?.bboxes)) {
    const boxes = segment.bboxes.filter((bbox) => (
      Array.isArray(bbox) && bbox.length === 4
      && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1]
    ));
    if (boxes.length) return boxes;
  }
  const bbox = segment?.bbox;
  return Array.isArray(bbox) && bbox.length === 4
    && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1]
    ? [bbox]
    : [];
}

const MAX_ALGORITHM_RENDER_INDENT = 8;
const STRUCTURED_ALGORITHM_ROLES = new Set(['title', 'input', 'output', 'bullet', 'code']);

function normalizedAlgorithmIndent(value) {
  const indent = Number(value);
  if (!Number.isFinite(indent)) return 0;
  return Math.max(0, Math.min(MAX_ALGORITHM_RENDER_INDENT, Math.trunc(indent)));
}

function normalizedAlgorithmRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return STRUCTURED_ALGORITHM_ROLES.has(role) ? role : 'code';
}

function hasHanTextBoundary(text, edge = 'end') {
  const characters = Array.from(String(text ?? ''));
  if (!characters.length) return false;
  const character = edge === 'start' ? characters[0] : characters[characters.length - 1];
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(character);
}

// 行内公式的间距 class 取最近“可见”兄弟：挂载期的骨架 span 与翻译回填后
// 被置空的多 span slot 残留（expandReadingTranslationChange 把整段译文写进
// slot 首个 span、其余置空）都是零宽节点，不参与边界判定；否则算法行里
// 公式会紧贴汉字。算法行容器是 pre-wrap，字面空白全部渲染，因此仅在
// .algorithm-line-content 内把“标点开头内容”前的多余空白收缩掉（只改显示
// DOM，不改 IR / sourceTextById；标点前空隙多来自 algorithm2e 式 “ ;” 行尾）。
function syncInlineMathBoundarySpacing(container) {
  const children = Array.from(container?.children || []);
  const isInlineMath = (child) => !!child?.classList?.contains?.('structured-inline-math');
  const textOf = (child) => String(child?.textContent ?? '');
  const isZeroWidth = (child) => !isInlineMath(child) && !textOf(child);
  const nearestVisible = (index, step) => {
    for (let cursor = index + step; cursor >= 0 && cursor < children.length; cursor += step) {
      if (!isZeroWidth(children[cursor])) return children[cursor];
    }
    return null;
  };

  if (container?.classList?.contains?.('algorithm-line-content')) {
    // 注意：字符类不能含裸 “{ }”，契约测试用大括号计数提取本函数体。
    const punctuationStart = /^[;,.:!?)\]、，。；：！？）】》〉」』]/u;
    const startsWithPunctuation = (child) => !!child && !isInlineMath(child)
      && punctuationStart.test(textOf(child).replace(/^\s+/u, ''));
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (isInlineMath(child)) continue;
      const original = textOf(child);
      if (!original) continue;
      let text = original;
      if (/^\s/u.test(text)) {
        const trimmed = text.replace(/^\s+/u, '');
        if (punctuationStart.test(trimmed)) text = trimmed;
      }
      if (/\s$/u.test(text) && startsWithPunctuation(nearestVisible(index, 1))) {
        text = text.replace(/\s+$/u, '');
      }
      if (text !== original) child.textContent = text;
    }
  }

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!isInlineMath(child)) continue;
    child.classList.toggle(
      'inline-math-space-before',
      hasHanTextBoundary(textOf(nearestVisible(index, -1)), 'end'),
    );
    child.classList.toggle(
      'inline-math-space-after',
      hasHanTextBoundary(textOf(nearestVisible(index, 1)), 'start'),
    );
  }
}

function appendStructuredParagraphSegment(container, segment, block, p) {
  const span = document.createElement('span');
  if (segment.kind === 'inline_math') {
    span.className = 'structured-inline-math';
    span.dataset.irId = segment.id;
    p.structuredInlineFormulaHosts ||= new Map();
    p.structuredInlineFormulaHosts.set(segment.id, { host: span, segment });
    const preview = trustedRenderableFormulaLatex(segment)
      ? ''
      : inlineFormulaPreview(p, segment);
    renderInlineMathHost(span, segment, preview);
    p.irBboxes.set(segment.id, structuredSegmentBbox(segment, block));
    const bboxes = structuredSegmentBboxes(segment);
    if (bboxes.length) p.irBboxFragments.set(segment.id, bboxes);
  } else {
    rememberStructuredText(
      p,
      span,
      segment.id,
      segment.text,
      structuredSegmentBbox(segment, block),
      structuredSegmentBboxes(segment),
    );
  }
  container.appendChild(span);
  syncInlineMathBoundarySpacing(container);
}

function createStructuredAlgorithmBlock(block, p) {
  const algorithm = document.createElement('div');
  algorithm.className = 'structured-algorithm structured-algorithm-lines';
  algorithm.setAttribute('role', 'group');
  algorithm.setAttribute('aria-label', '伪代码');

  const lineGroups = new Map();
  let lastLine = 0;
  for (const segment of block.segments || []) {
    const line = Number.isInteger(segment?.algorithm_line) && segment.algorithm_line >= 0
      ? segment.algorithm_line
      : lastLine;
    lastLine = line;
    if (!lineGroups.has(line)) lineGroups.set(line, []);
    lineGroups.get(line).push(segment);
  }

  const orderedLines = [...lineGroups.entries()].sort(([left], [right]) => left - right);
  for (const [lineIndex, segments] of orderedLines) {
    const metadata = segments[0] || {};
    const indent = normalizedAlgorithmIndent(metadata.algorithm_indent);
    const role = normalizedAlgorithmRole(metadata.algorithm_role);
    const number = segments
      .map((segment) => String(segment?.algorithm_number || '').trim())
      .find(Boolean) || '';

    const line = document.createElement('div');
    line.className = `algorithm-line algorithm-role-${role}`;
    line.dataset.algorithmLine = String(lineIndex);
    line.dataset.algorithmIndent = String(indent);
    line.dataset.algorithmRole = role;
    line.style.setProperty('--algorithm-indent-offset', `${indent * 1.2}rem`);

    const numberHost = document.createElement('span');
    numberHost.className = 'algorithm-line-number';
    numberHost.textContent = number;
    if (!number) numberHost.setAttribute('aria-hidden', 'true');

    const content = document.createElement('div');
    content.className = 'algorithm-line-content';
    for (const segment of segments) {
      appendStructuredParagraphSegment(content, segment, block, p);
    }
    line.append(numberHost, content);
    algorithm.appendChild(line);
  }
  return algorithm;
}

function renderStructuredDisplayFormula(p, block) {
  const entry = p.structuredFormulaHosts?.get(block.id);
  if (!entry) return;
  const { host, number } = entry;
  const stateEntry = p.formulaStates?.[formulaStateKey(block, p.num, 0)];
  const sourceFormulaNumber = String(block.number || '').trim();
  const formulaNumber = sourceFormulaNumber || String(stateEntry?.number || '').trim();
  const stateStatus = stateEntry?.status || '';
  const rawLatex = stateEntry?.status === 'done' && stateEntry.latex
    ? stateEntry.latex
    : (block.latex || '');
  const latex = trustedRenderableFormulaLatex({
    ...block,
    latex: rawLatex,
  });
  host.replaceChildren();
  host.className = 'formula-display';
  host.removeAttribute('role');
  number.textContent = sourceFormulaNumber;

  try {
    if (!latex || typeof window.katex?.render !== 'function') throw new Error('KaTeX unavailable');
    window.katex.render(latex, host, {
      displayMode: true,
      throwOnError: true,
      strict: 'ignore',
    });
    number.textContent = formulaNumber;
    return;
  } catch {
    const imageRef = block.image_ref || block.imageRef || block.name || '';
    const imageUrl = stateEntry?.crop
      || p.layoutImages?.[imageRef]
      || findImageLoose(p.layoutImages || {}, imageRef);
    if (imageUrl) {
      const image = document.createElement('img');
      image.className = 'structured-formula-crop';
      image.src = imageUrl;
      image.alt = block.source_text || '原公式';
      host.appendChild(image);
    } else {
      const awaitingOcr = ['pending', 'running', 'retrying'].includes(stateStatus)
        || (!stateEntry && !String(block.latex || '').trim());
      host.textContent = awaitingOcr ? '公式识别中…' : '查看左侧公式';
      host.classList.add('formula-message', awaitingOcr ? 'formula-pending' : 'formula-failed');
      if (awaitingOcr) host.setAttribute('role', 'status');
    }
    if (stateEntry && ['pending', 'running', 'retrying'].includes(stateStatus)) {
      host.classList.add('formula-pending');
    }
  }
}

function createStructuredBlock(block, p) {
  p.irBboxes ||= new Map();
  p.irBboxFragments ||= new Map();
  if (block.kind === 'table') return createTableBlock(block, p);

  if (block.kind === 'display_math') {
    const wrapper = document.createElement('div');
    // Keep .blk so shared formula grid CSS (number on the right) always applies.
    wrapper.className = 'blk formula-latex structured-display-math';
    wrapper.dataset.irId = block.id;
    wrapper.setAttribute('title', '双击定位左侧公式');
    const host = document.createElement('div');
    host.className = 'formula-display';
    const number = document.createElement('span');
    number.className = 'formula-number';
    wrapper.append(host, number);
    p.structuredFormulaHosts ||= new Map();
    p.structuredFormulaHosts.set(block.id, { host, number, target: wrapper });
    p.irBboxes.set(block.id, block.bbox);
    p.irBboxFragments.set(block.id, [block.bbox]);
    renderStructuredDisplayFormula(p, block);
    return wrapper;
  }

  if (block.kind === 'figure') {
    const figure = document.createElement('figure');
    figure.className = 'structured-figure';
    figure.dataset.irId = block.id;
    figure.setAttribute('title', '双击定位左侧原图');
    p.irBboxes.set(block.id, block.bbox);
    p.irBboxFragments.set(block.id, [block.bbox]);
    let caption = null;
    if (block.caption) {
      caption = document.createElement('figcaption');
      caption.className = 'figure-caption figure-caption-center';
      rememberStructuredText(
        p,
        caption,
        block.caption.id,
        block.caption.text,
        block.caption.bbox || block.bbox,
        block.caption.bbox ? [block.caption.bbox] : [],
      );
    }
    // Reading mode keeps the original PDF as the visual authority. A compact
    // locator preserves reading order and figure-to-caption correspondence
    // without duplicating a large raster crop in the translation column.
    const reference = document.createElement('div');
    reference.className = 'source-ref source-ref-image figure-source-ref';
    reference.dataset.irId = block.id;
    reference.textContent = '原图见左栏 · 双击定位';
    if (caption && block.caption.position !== 'below') figure.append(caption, reference);
    else if (caption) figure.append(reference, caption);
    else figure.appendChild(reference);
    return figure;
  }

  if (block.kind === 'paragraph') {
    const segments = Array.isArray(block.segments) ? block.segments : [];
    const hasAlgorithmLines = block.layout === 'algorithm'
      && segments.some((segment) => Number.isInteger(segment?.algorithm_line));
    if (hasAlgorithmLines) return createStructuredAlgorithmBlock(block, p);

    const paragraph = document.createElement('p');
    if (block.layout === 'algorithm') {
      paragraph.className = 'structured-algorithm structured-algorithm-legacy';
    }
    for (const segment of segments) {
      appendStructuredParagraphSegment(paragraph, segment, block, p);
    }
    return paragraph;
  }

  const tag = block.kind === 'heading' ? 'h3' : 'div';
  const element = document.createElement(tag);
  if (block.kind === 'plain_text') element.className = 'structured-plain-text';
  if (block.kind === 'caption') element.className = 'structured-caption';
  return rememberStructuredText(p, element, block.id, block.text, block.bbox);
}

// ---------------------------------------------------------------------------
// 原文对照（config.bilingual）：结构化文本块下方保留一行灰色英文原文。
// 原文行在挂载时创建一次并常驻 DOM（textContent 永不随流式更新改写），
// 流式回填 / 局部重试只切换 `src-ready` class，因此不会闪烁或重复；
// 显隐总开关是 body.bilingual-src（配置热更新时由 applyReadingPreferences 切换）。
// 公式 / 表格 / 图片引用节点不加原文行。
// ---------------------------------------------------------------------------
function bilingualSourceForBlock(block) {
  if (block.kind === 'paragraph') {
    if (block.layout === 'algorithm') return null; // 伪代码行不加原文行
    const ids = [];
    const parts = [];
    for (const segment of block.segments || []) {
      if (segment?.kind === 'inline_math') {
        parts.push(formulaSourceText(segment));
        continue;
      }
      if (!segment?.id) continue;
      ids.push(segment.id);
      parts.push(String(segment.text ?? ''));
    }
    const text = parts.join('').replace(/\s+/gu, ' ').trim();
    return ids.length && text ? { ids, text } : null;
  }
  if (block.kind === 'heading' || block.kind === 'plain_text' || block.kind === 'caption') {
    const text = String(block.text ?? '').trim();
    return text ? { ids: [block.id], text } : null;
  }
  return null; // display_math / table / figure：不渲染原文行
}

function createStructuredSourceLine(p, block) {
  const source = bilingualSourceForBlock(block);
  if (!source) return null;
  const line = document.createElement('div');
  line.className = 'src-line';
  line.dataset.srcFor = block.id;
  line.setAttribute('lang', 'en');
  line.textContent = source.text;
  p.srcLineEntries ||= [];
  p.srcLineEntries.push({ el: line, ids: source.ids, text: source.text });
  return line;
}

// partial / failed 的节点仍以骨架或错误提示呈现，此时不显示原文行；
// 块内全部文本节点译文落地后才标记 `src-ready`。citation / 纯数字节点被
// 原样保留（译文=原文）时也不重复显示。
function refreshStructuredSourceLines(p) {
  for (const entry of p?.srcLineEntries || []) {
    const nodes = entry.ids.map((id) => p.nodeEls?.get(id));
    const ready = nodes.every((node) => node
      && !node.classList.contains('structured-text-pending')
      && !node.classList.contains('structured-text-failed'));
    const identical = ready && entry.ids.length === 1
      && nodes[0].textContent.trim() === entry.text;
    entry.el.classList.toggle('src-ready', ready && !identical);
  }
}

function mountStructuredPage(p, pageIr) {
  if (p.structuredMounted) return;
  const md = p.mdEl;
  p.nodeEls = new Map();
  p.sourceTextById = new Map();
  p.irBboxes = new Map();
  p.irBboxFragments = new Map();
  p.structuredFormulaHosts = new Map();
  p.structuredInlineFormulaHosts = new Map();
  p.inlineFormulaPreviews = new Map();
  p.srcLineEntries = [];
  p.blkMeta = [];
  p.blkEls = [];

  const status = document.createElement('div');
  status.className = 'translation-status';
  status.hidden = true;
  const fragment = document.createDocumentFragment();
  for (const block of pageIr.blocks) {
    const blockEl = createStructuredBlock(block, p);
    blockEl.classList.add('blk');
    blockEl.dataset.blk = String(p.blkMeta.length);
    blockEl.dataset.irId ||= block.id;
    p.blkMeta.push({ bbox: block.bbox, id: block.id });
    p.blkEls.push(blockEl);
    fragment.appendChild(blockEl);
    const sourceLine = createStructuredSourceLine(p, block);
    if (sourceLine) fragment.appendChild(sourceLine);
  }
  md.className = 'md structured-page';
  md.replaceChildren(status, fragment);
  md.setAttribute('aria-busy', p.translationActive ? 'true' : 'false');
  p.structuredStatusEl = status;
  p.structuredMounted = true;
}

function settleStructuredSourceOnlyNodes(p, readingItems) {
  const translatedIds = new Set();
  for (const item of readingItems || []) {
    if (item?.kind === 'reading_unit') {
      for (const slot of item.textSlots || []) {
        for (const segment of slot || []) {
          if (segment?.id) translatedIds.add(segment.id);
        }
      }
    } else if (item?.id) {
      translatedIds.add(item.id);
    }
  }
  for (const [id, sourceText] of p.sourceTextById || []) {
    if (!translatedIds.has(id) && updateStructuredTextNode(p.nodeEls, id, sourceText)) {
      syncInlineMathBoundarySpacing(p.nodeEls.get(id)?.parentElement);
    }
  }
  refreshStructuredSourceLines(p);
}

function setStructuredStatus(p, text, error = false) {
  const status = p.structuredStatusEl;
  if (!status) return;
  status.hidden = !text;
  status.className = `translation-status${error ? ' error' : ''}`;
  status.textContent = text || '';
  updatePagePresentation(p, error ? { error: text || true } : {});
}

function clearStructuredItemWarnings(p) {
  for (const warning of p.structuredItemWarningEls || []) warning.remove();
  p.structuredItemWarningEls = [];
}

function readingRecoveryFailureText(count) {
  const total = Math.max(0, Number(count) || 0);
  return total > 0
    ? `本页有 ${total} 处译文暂未完成；其余译文已保留。`
    : '';
}

async function runScheduledPage(context) {
  const {
    pageIndex, generation, signal, priority = 0,
  } = context;
  if (!isCurrentDocument(generation) || signal.aborted) return;
  const page = state.pages[pageIndex];
  if (!page || page.translateStarted) return;
  page.translateStarted = true;
  page.translationQueuePriority = Math.max(0, 100 - Number(priority || 0));

  // v0.9.6：本地版面分析服务已移除，页面翻译统一走整页视觉模型。
  await translatePageVision(page);
}

function schedulePagePriority(currentIndex) {
  const generation = state.documentGeneration;
  const signal = state.documentAbortController?.signal;
  if (!signal || signal.aborted || !Number.isInteger(currentIndex)) return;
  const order = buildPagePriorityOrder(currentIndex, state.totalPages);
  order.forEach((pageIndex, priority) => {
    state.pageScheduler.schedule(pageIndex, runScheduledPage, {
      priority,
      generation,
      signal,
    }).catch((error) => {
      if (error?.name !== 'AbortError') {
        const page = state.pages[pageIndex];
        if (page) page.translateStarted = false;
        console.warn(`[PL-VIEW] scheduled page ${pageIndex + 1} failed`, error);
      }
    }).finally(() => {
      const page = state.pages[pageIndex];
      if (!page?.retryRequested || page.documentGeneration !== generation
        || !isCurrentDocument(generation) || signal.aborted) return;
      page.retryRequested = false;
      page.translateStarted = false;
      schedulePagePriority(pageIndex);
    });
  });
}

function setupLazyTranslate() {
  state.translateObserver?.disconnect();
  state.translateObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) schedulePagePriority(Number(entry.target.dataset.page) - 1);
    }
  }, { root: els.panelColumn, rootMargin: '300px 0px' });
  for (const p of state.pages) state.translateObserver.observe(p.sectionEl);
}

function translatePage(num) {
  const p = state.pages[num - 1];
  if (!p) return;
  schedulePagePriority(num - 1);
}

function trackPageTranslationRequest(page, requestId) {
  if (!page || requestId == null) return;
  page.translationRequestIds ||= new Set();
  page.translationRequestIds.add(requestId);
  // Keep trId as a compatibility pointer for diagnostics and legacy callers.
  page.trId = requestId;
}

function forgetPageTranslationRequest(page, requestId) {
  if (!page || requestId == null) return;
  page.translationRequestIds?.delete(requestId);
  if (page.trId !== requestId) return;
  const remaining = [...(page.translationRequestIds || [])];
  page.trId = remaining.length ? remaining[remaining.length - 1] : null;
}

function cancelPageTranslationRequests(page) {
  if (!page) return;
  const ids = new Set(page.translationRequestIds || []);
  if (page.trId != null) ids.add(page.trId);
  for (const id of ids) client.cancel(id);
  page.translationRequestIds = new Set();
  page.trId = null;
}

function beginPageTranslation(p) {
  cancelPageTranslationRequests(p);
  clearSmartPageRetry(p);
  const started = startPageRequest(p);
  p.translationError = '';
  if (started.replacedActive) state.inProgress = Math.max(0, state.inProgress - 1);
  state.inProgress++;
  updatePagePresentation(p, { active: true });
  updateHud();
  return started.generation;
}

function clearSmartPageRetry(p) {
  if (!p) return;
  if (p.smartRetryTimer) {
    clearTimeout(p.smartRetryTimer);
    p.smartRetryTimer = null;
  }
}

function scheduleSmartPageRetry(p, error) {
  if (!p || p.documentGeneration !== state.documentGeneration) return;
  const attempt = Math.max(0, Number(p.smartRetryAttempt) || 0);
  if (!shouldScheduleAutoRetry({ attempt, error })) return;
  clearSmartPageRetry(p);
  const delay = nextRetryDelayMs(attempt);
  p.smartRetryAttempt = attempt + 1;
  const label = formatAutoRetryLabel(p.smartRetryAttempt, delay);
  if (p.pageStatusEl && !p.translationActive) {
    const readableDraft = Boolean(p.visionQualityFailure && String(p.translationText || '').trim());
    p.pageStatusEl.textContent = readableDraft ? `${label} · 译文可读` : label;
    p.pageStatusEl.className = 'page-status warning';
  }
  p.smartRetryTimer = setTimeout(() => {
    p.smartRetryTimer = null;
    if (p.documentGeneration !== state.documentGeneration) return;
    if (p.translationActive) return;
    p.translateStarted = false;
    p.connectionAutoRetryGeneration = null;
    p.translationError = '';
    showToast(`正在自动重试第 ${p.num} 页（第 ${p.smartRetryAttempt} 次）…`);
    translatePage(p.num);
  }, delay);
}

function rememberPageTranslationText(p, text) {
  if (!p) return;
  const value = String(text || '').trim();
  if (value) p.translationText = value;
  // Successful content resets auto-retry budget.
  p.smartRetryAttempt = 0;
  clearSmartPageRetry(p);
}

function finishPageTranslation(p, generation) {
  if (!settlePageRequest(p, generation)) return false;
  p.translationRequestIds?.clear();
  state.inProgress = Math.max(0, state.inProgress - 1);
  updatePagePresentation(p, { active: false });
  updateHud();
  return true;
}

function markPageOutcome(p, outcome) {
  const delta = transitionPageOutcome(p, outcome);
  state.doneCount = Math.max(0, state.doneCount + delta.doneDelta);
  state.failedCount = Math.max(0, state.failedCount + delta.failedDelta);
  updatePagePresentation(p, { active: false, outcome });
  updateProgress();
}

function enqueueFormulaTask(task) {
  const run = () => task();
  const queued = formulaQueue.then(run, run);
  formulaQueue = queued.catch(() => {});
  return queued;
}

function isKatexRenderable(latex) {
  const normalizedLatex = normalizeMathForKatex(latex);
  if (!normalizedLatex) return false;
  const katex = window.katex;
  if (!katex || typeof katex.renderToString !== 'function') return true;
  try {
    katex.renderToString(normalizedLatex, {
      displayMode: true,
      throwOnError: true,
      // KaTeX defaults strict mode to "warn". PDF math commonly contains
      // Unicode compatibility characters (for example the Ohm sign U+2126),
      // which are renderable but otherwise flood the extension error page.
      // Parse errors still throw because throwOnError remains enabled.
      strict: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function formulaStateKey(block, pageNum, blockIndex) {
  return block.name || block.image_ref || block.imageRef || block.id
    || `formula-${pageNum}-${blockIndex}`;
}

function startFormulaTranscriptions(p, generation, rerender) {
  const documentGeneration = p.documentGeneration;
  if (documentGeneration !== state.documentGeneration) return;
  if (state.readerMode !== 'reading' || !Array.isArray(p.blocks)) return;
  p.formulaStates ||= {};
  p.formulaRequestIds ||= new Set();
  const images = p.layoutImages || {};

  for (let blockIndex = 0; blockIndex < p.blocks.length; blockIndex++) {
    const block = p.blocks[blockIndex];
    if (block.kind !== 'formula' || block.latex) continue;
    const name = formulaStateKey(block, p.num, blockIndex);
    const previous = p.formulaStates[name];
    if (previous?.status === 'done' && previous.latex) continue;
    if (previous?.generation === generation
      && ['pending', 'running', 'done', 'failed'].includes(previous.status)) continue;

    const image = images[block.name] || findImageLoose(images, block.name || '');
    if (!image) {
      p.formulaStates[name] = { status: 'failed', error: '公式裁剪图不可用', generation };
      rerender();
      continue;
    }

    p.formulaStates[name] = { status: 'pending', generation };
    enqueueFormulaTask(async () => {
      if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
      const formulaState = p.formulaStates[name];
      if (!formulaState || formulaState.generation !== generation) return;
      formulaState.status = 'running';
      rerender();

      let streamed = '';
      const { id, promise } = client.transcribeFormula(
        image,
        block.source_text || block.sourceText || '',
        (delta) => { streamed += delta; },
        (phase) => {
          if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
          formulaState.phase = phase;
          rerender();
        },
      );
      formulaState.requestId = id;
      p.formulaRequestIds.add(id);

      try {
        const { full } = await promise;
        if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
        const parsed = parseFormulaTranscription(full || streamed, {
          sourceText: block.source_text || block.sourceText || '',
        });
        if (!parsed || !isKatexRenderable(parsed.latex)) throw new Error('模型返回的 LaTeX 无法渲染');
        p.formulaStates[name] = { status: 'done', ...parsed, generation };
      } catch (e) {
        if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation || e?.cancelled) return;
        p.formulaStates[name] = {
          status: 'failed',
          error: e?.message || String(e),
          generation,
        };
      } finally {
        p.formulaRequestIds.delete(id);
        if (documentGeneration === state.documentGeneration && p.renderGeneration === generation) rerender();
      }
    });
  }
}

function loadFormulaSpriteImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('公式裁剪图解码失败'));
    image.src = src;
  });
}

async function renderFormulaSourceCanvas(p, targetWidth = 1900) {
  const documentGeneration = p.documentGeneration;
  await ensurePdfPage(p.num - 1, documentGeneration);
  if (documentGeneration !== state.documentGeneration || !p.pageObj) throw documentAbortError();
  const base = p.viewport1;
  const scale = Math.min(3.2, Math.max(2, targetWidth / Math.max(1, base.width)));
  const viewport = p.pageObj.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = getReadOptimized2dContext(canvas, { alpha: false });
  if (!context) throw new Error('浏览器无法创建公式页面画布');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await p.pageObj.render({ canvasContext: context, viewport }).promise;
  if (documentGeneration !== state.documentGeneration) throw documentAbortError();
  return canvas;
}

function renderStructuredFormulaEntry(p, entry) {
  if (entry.inline) renderStructuredInlineFormula(p, entry.block);
  else renderStructuredDisplayFormula(p, entry.block);
  updatePagePresentation(p);
  updateProgress();
}

async function prepareStructuredFormulaImages(p, entries, generation, documentGeneration) {
  const missing = entries.filter((entry) => !entry.image);
  if (!missing.length) return entries;

  let canvas;
  try {
    canvas = await renderFormulaSourceCanvas(p);
  } catch (error) {
    if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return [];
    for (const entry of missing) {
      p.formulaStates[entry.name] = {
        status: 'failed', error: error?.message || String(error), generation,
      };
      renderStructuredFormulaEntry(p, entry);
    }
    return entries.filter((entry) => entry.image);
  }

  for (const entry of missing) {
    if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return [];
    const image = cropFormulaCanvas(canvas, entry.block.bbox, { padScale: 1.15 });
    if (!image) {
      p.formulaStates[entry.name] = {
        status: 'failed', error: '公式区域无法裁剪', generation,
      };
      renderStructuredFormulaEntry(p, entry);
      continue;
    }
    entry.image = image;
    const formulaState = p.formulaStates[entry.name];
    if (formulaState?.generation === generation) formulaState.crop = image;
    renderStructuredFormulaEntry(p, entry);
  }
  return entries.filter((entry) => entry.image);
}

async function createFormulaSpriteBatches(entries) {
  const labelHeight = 34;
  const gap = 18;
  const padding = 18;
  const maxItemWidth = 1400;
  const maxItemHeight = 520;
  const maxSpriteHeight = 12000;
  const loaded = await Promise.all(entries.map(async (entry) => {
    const image = await loadFormulaSpriteImage(entry.image);
    const scale = Math.min(1, maxItemWidth / Math.max(1, image.naturalWidth),
      maxItemHeight / Math.max(1, image.naturalHeight));
    return {
      ...entry,
      imageElement: image,
      width: Math.max(1, Math.round(image.naturalWidth * scale)),
      height: Math.max(1, Math.round(image.naturalHeight * scale)),
    };
  }));

  const groups = [];
  let current = [];
  let currentHeight = padding;
  for (const entry of loaded) {
    const itemHeight = labelHeight + entry.height + gap;
    if (current.length && currentHeight + itemHeight + padding > maxSpriteHeight) {
      groups.push(current);
      current = [];
      currentHeight = padding;
    }
    current.push(entry);
    currentHeight += itemHeight;
  }
  if (current.length) groups.push(current);

  return groups.map((group) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(320, ...group.map((entry) => entry.width)) + padding * 2;
    canvas.height = padding * 2 + group.reduce(
      (sum, entry) => sum + labelHeight + entry.height + gap,
      0,
    );
    const context = getReadOptimized2dContext(canvas, { alpha: false });
    if (!context) throw new Error('浏览器无法创建公式合并画布');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = 'bold 22px ui-monospace, SFMono-Regular, Consolas, monospace';
    context.textBaseline = 'middle';
    let y = padding;
    for (const entry of group) {
      context.fillStyle = '#111827';
      context.fillText(`FORMULA_ID ${entry.id}`, padding, y + labelHeight / 2);
      y += labelHeight;
      const x = Math.round((canvas.width - entry.width) / 2);
      context.drawImage(entry.imageElement, x, y, entry.width, entry.height);
      y += entry.height + gap;
      context.fillStyle = '#d1d5db';
      context.fillRect(padding, y - 1, canvas.width - padding * 2, 1);
    }
    return {
      image: canvas.toDataURL('image/png'),
      entries: group,
      ids: group.map((entry) => entry.id),
      formulas: group.map((entry) => ({
        id: entry.id,
        source_text: String(entry.block?.source_text || entry.block?.sourceText || ''),
      })),
    };
  });
}

// Batch OCR is the fast path. Only formulas rejected by the structural quality
// gate pay for a second, isolated crop request; body translation never waits on
// this lane. A second failure keeps the authoritative PDF crop visible.
async function retryStructuredFormulaTranscription(p, entry, generation, documentGeneration) {
  if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return false;
  const crop = p.formulaStates[entry.name]?.crop || entry.image || '';
  p.formulaStates[entry.name] = { status: 'retrying', generation, crop };
  renderStructuredFormulaEntry(p, entry);

  let received = '';
  const { id, promise } = client.transcribeFormula(
    entry.image,
    entry.block?.source_text || entry.block?.sourceText || '',
    (delta) => { received += delta; },
    (phase) => {
      if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
      const formulaState = p.formulaStates[entry.name];
      if (formulaState?.generation === generation) formulaState.phase = phase;
    },
  );
  p.formulaRequestIds.add(id);
  try {
    const { full } = await promise;
    if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return false;
    const sourceText = entry.block?.source_text || entry.block?.sourceText || '';
    const parsed = parseFormulaTranscription(full || received, { sourceText });
    if (!parsed || !isKatexRenderable(parsed.latex)) {
      throw new Error('单公式复核仍未得到可信 LaTeX');
    }
    entry.block.latex = parsed.latex;
    p.formulaStates[entry.name] = { status: 'done', ...parsed, generation };
    return true;
  } catch (error) {
    if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation
      || error?.cancelled) return false;
    p.formulaStates[entry.name] = {
      status: 'failed', error: error?.message || String(error), generation, crop,
    };
    return false;
  } finally {
    p.formulaRequestIds.delete(id);
    if (documentGeneration === state.documentGeneration && p.renderGeneration === generation) {
      renderStructuredFormulaEntry(p, entry);
    }
  }
}

function startStructuredFormulaTranscriptions(p, generation) {
  const documentGeneration = p.documentGeneration;
  if (documentGeneration !== state.documentGeneration || state.readerMode !== 'reading') return;
  const blocks = Array.isArray(p.pageIr?.blocks) ? p.pageIr.blocks : [];
  p.formulaStates ||= {};
  p.formulaRequestIds ||= new Set();
  const entries = [];

  const collectFormula = (block, blockIndex, { inline = false } = {}) => {
    const trustedLatex = trustedRenderableFormulaLatex(block);
    if (trustedLatex) {
      block.latex = trustedLatex;
      if (inline) renderStructuredInlineFormula(p, block);
      else renderStructuredDisplayFormula(p, block);
      return;
    }

    const name = formulaStateKey(block, p.num, blockIndex);
    const previous = p.formulaStates[name];
    const previousLatex = previous?.status === 'done' && previous.latex
      ? trustedRenderableFormulaLatex({ ...block, latex: previous.latex })
      : '';
    if (previousLatex) {
      block.latex = previousLatex;
      if (inline) renderStructuredInlineFormula(p, block);
      else renderStructuredDisplayFormula(p, block);
      return;
    }
    if (previous?.generation === generation
      && ['pending', 'running', 'retrying', 'done', 'failed'].includes(previous.status)) return;

    const imageRef = block.image_ref || block.imageRef || block.name || '';
    const layoutImage = inline
      ? ''
      : (p.layoutImages?.[imageRef] || findImageLoose(p.layoutImages || {}, imageRef));
    if (!inline && !layoutImage) {
      p.formulaStates[name] = { status: 'failed', error: '公式裁剪图不可用', generation };
      renderStructuredDisplayFormula(p, block);
      return;
    }

    const preview = inline ? inlineFormulaPreview(p, block) : layoutImage;
    p.formulaStates[name] = { status: 'pending', generation, crop: preview || '' };
    const entry = { id: name, name, block, image: layoutImage || '', inline };
    renderStructuredFormulaEntry(p, entry);
    entries.push(entry);
  };

  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'display_math') {
      collectFormula(block, blockIndex);
      return;
    }
    if (block.kind !== 'paragraph') return;
    for (const segment of block.segments || []) {
      if (segment.kind === 'inline_math') collectFormula(segment, blockIndex, { inline: true });
    }
  });

  if (!entries.length) return;
  enqueueFormulaTask(async () => {
    if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
    const readyEntries = await prepareStructuredFormulaImages(
      p,
      entries,
      generation,
      documentGeneration,
    );
    if (!readyEntries.length
      || documentGeneration !== state.documentGeneration
      || p.renderGeneration !== generation) return;
    for (const entry of readyEntries) {
      const formulaState = p.formulaStates[entry.name];
      if (!formulaState || formulaState.generation !== generation) continue;
      formulaState.status = 'running';
      renderStructuredFormulaEntry(p, entry);
    }

    let batches;
    try {
      batches = await createFormulaSpriteBatches(readyEntries);
    } catch (error) {
      for (const entry of readyEntries) {
        p.formulaStates[entry.name] = {
          status: 'failed', error: error?.message || String(error), generation,
          crop: p.formulaStates[entry.name]?.crop || entry.image || '',
        };
        renderStructuredFormulaEntry(p, entry);
      }
      return;
    }

    for (const batch of batches) {
      if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
      let received = '';
      const { id, promise } = client.transcribeFormulaBatch(
        batch.image,
        batch.formulas,
        (delta) => { received += delta; },
        (phase) => {
          if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
          for (const entry of batch.entries) {
            const formulaState = p.formulaStates[entry.name];
            if (formulaState?.generation === generation) formulaState.phase = phase;
          }
        },
      );
      p.formulaRequestIds.add(id);
      const retryEntries = [];
      try {
        const { full } = await promise;
        if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
        const parsed = parseFormulaBatchTranscription(full || received, batch.formulas);
        const parsedById = new Map((parsed?.items || []).map((item) => [item.id, item]));
        for (const entry of batch.entries) {
          const item = parsedById.get(entry.id);
          if (item && isKatexRenderable(item.latex)) {
            entry.block.latex = item.latex;
            p.formulaStates[entry.name] = { status: 'done', ...item, generation };
          } else {
            p.formulaStates[entry.name] = {
              status: 'retrying', error: '批量公式结果不可信，正在单公式复核', generation,
              crop: p.formulaStates[entry.name]?.crop || entry.image || '',
            };
            retryEntries.push(entry);
          }
          renderStructuredFormulaEntry(p, entry);
        }
      } catch (error) {
        if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation
          || error?.cancelled) return;
        for (const entry of batch.entries) {
          p.formulaStates[entry.name] = {
            status: 'retrying', error: error?.message || String(error), generation,
            crop: p.formulaStates[entry.name]?.crop || entry.image || '',
          };
          retryEntries.push(entry);
          renderStructuredFormulaEntry(p, entry);
        }
      } finally {
        p.formulaRequestIds.delete(id);
      }
      for (const entry of retryEntries) {
        if (documentGeneration !== state.documentGeneration || p.renderGeneration !== generation) return;
        await retryStructuredFormulaTranscription(p, entry, generation, documentGeneration);
      }
    }
  });
}

// Typed Page IR 阅读主路径：稳定阅读单元按小批次流式翻译，同页最多两个请求并行。
// 行内公式只以不可变占位符提供语境，译文按单元 ID 展开回原文本 span；公式 DOM 始终留在本地。
async function translatePageStructured(p) {
  const md = p.mdEl;
  const documentGeneration = p.documentGeneration;
  for (const id of p.formulaRequestIds || []) client.cancel(id);
  p.formulaRequestIds = new Set();
  const generation = beginPageTranslation(p);
  const targetLang = state.config?.targetLang || '简体中文';
  const isCurrentDocumentPageRequest = () => isCurrentDocumentPage(
    state.documentGeneration,
    state.closedGeneration,
    p,
    documentGeneration,
    generation,
  );
  const shouldContinueNodeBatches = () => (
    isCurrentDocumentPageRequest() && !p.retryRequested
  );
  const plan = createReadingTranslationPlan(p.pageIr);
  mountStructuredPage(p, plan.page);
  // Citation-only, numeric and punctuation-only spans never enter a provider
  // request. Keep their authoritative source text visible instead of leaving
  // a permanent loading skeleton beside translated prose and formulas.
  settleStructuredSourceOnlyNodes(p, plan.items);
  startStructuredFormulaTranscriptions(p, generation);
  const readingItemsById = new Map(plan.items.map((item) => [item.id, item]));
  const partialIds = p.translationOutcome === 'partial'
    ? new Set(p.unresolvedTranslationUnitIds || [])
    : null;
  const requestItems = partialIds?.size
    ? plan.items.filter((item) => partialIds.has(item.id))
    : plan.items;
  p.translationError = '';
  p.translationPhase = '';
  setStructuredStatus(p, '');
  clearStructuredItemWarnings(p);

  if (requestItems.length === 0) {
    if (!finishPageTranslation(p, generation)) return;
    md.className = 'md structured-page done';
    p.unresolvedTranslationItems = [];
    p.unresolvedTranslationUnitIds = [];
    // Structured pages: export uses rendered text (no single raw markdown stream).
    rememberPageTranslationText(p, md.innerText || '');
    markPageOutcome(p, 'done'); updateProgress(); updateHud();
    return;
  }

  const pendingChanges = new Map();
  const applyChanges = (changedItems) => {
    const rejectedUnitIds = new Set();
    const expandedChanges = [];
    for (const changed of changedItems || []) {
      const item = readingItemsById.get(changed.id);
      if (!item) continue;
      try {
        expandedChanges.push(...expandReadingTranslationChange(item, changed.text));
      } catch (error) {
        rejectedUnitIds.add(item.id);
        console.warn('[PL-VIEW] 阅读单元公式占位符校验失败', item.id, error);
      }
    }
    for (const changed of expandedChanges) {
      if (updateStructuredTextNode(p.nodeEls, changed.id, changed.text)) {
        syncInlineMathBoundarySpacing(p.nodeEls.get(changed.id)?.parentElement);
      }
    }
    // 原文对照：仅切换既有原文行的可见性 class，流式更新不重建原文 DOM。
    refreshStructuredSourceLines(p);
    return { expandedChanges, rejectedUnitIds };
  };
  const unresolvedReadingItems = (sourceItems, unresolvedItems, rejectedUnitIds = []) => {
    const unresolvedIds = new Set((unresolvedItems || []).map((item) => item.id));
    for (const id of rejectedUnitIds || []) unresolvedIds.add(id);
    return (sourceItems || []).filter((item) => unresolvedIds.has(item.id));
  };
  const combineUnresolvedItems = (sourceItems, batchResults) => {
    const unresolvedIds = new Set();
    for (const result of batchResults || []) {
      for (const item of result?.unresolvedItems || []) unresolvedIds.add(item.id);
    }
    return (sourceItems || []).filter((item) => unresolvedIds.has(item.id));
  };
  const flushPendingChanges = () => {
    if (!isCurrentDocumentPageRequest()) {
      pendingChanges.clear();
      return;
    }
    applyChanges(pendingChanges.values());
    pendingChanges.clear();
  };
  const renderGate = createRenderFrameGate(
    (callback) => requestAnimationFrame(callback),
    (frameId) => cancelAnimationFrame(frameId),
    flushPendingChanges,
  );
  const scheduleChanges = (changedItems) => {
    for (const changed of changedItems || []) pendingChanges.set(changed.id, changed);
    if (changedItems?.length) renderGate.schedule();
  };
  const completeStructuredPage = (unresolvedItems = []) => {
    if (!finishPageTranslation(p, generation)) return false;
    const warningText = readingRecoveryFailureText(unresolvedItems.length);
    p.translationError = '';
    p.translationPhase = '';
    p.trId = null;
    p.unresolvedTranslationItems = [...unresolvedItems];
    p.unresolvedTranslationUnitIds = unresolvedItems.map((item) => item.id);
    md.className = `md structured-page ${unresolvedItems.length ? 'partial' : 'done'}`;
    setStructuredStatus(p, warningText, false);
    markPageOutcome(p, unresolvedItems.length ? 'partial' : 'done');
    updateProgress(); updateHud();
    return true;
  };

  const requestBatches = createNodeTranslationBatches(requestItems);
  const firstPassSettled = await mapNodeTranslationBatches(
    requestBatches,
    async (batch, batchIndex) => {
      const accumulator = createNodeTranslationAccumulator(batch, { targetLang });
      let requestId = null;
      let requestTimedOut = false;
      const guard = makeInactivityGuard(() => {
        if (!isCurrentDocumentPageRequest() || requestId == null) return;
        requestTimedOut = true;
        client.cancel(requestId);
        renderGate.cancel();
        flushPendingChanges();
      });
      const onDelta = (delta) => {
        if (!isCurrentDocumentPageRequest()) return;
        p.translationPhase = '';
        setStructuredStatus(p, '');
        scheduleChanges(accumulator.push(delta));
        guard.output();
      };
      const onStatus = (phase) => {
        if (!isCurrentDocumentPageRequest()) return;
        p.translationPhase = phase;
        setStructuredStatus(p, translationPhaseText(phase));
        if (phase === 'queued') guard.hold();
        else if (phase === 'streaming') guard.output();
        else guard.bump(); // connecting / thinking 心跳：证明请求活着，只重置首字节窗口
      };

      try {
        const handle = client.translateNodes(
          serializeNodeTranslationRequest(batch),
          onDelta,
          onStatus,
          {
            // The first, deliberately small batch wins a global queue tie so
            // the top of the visible page is normally the first useful output.
            queuePriority: (p.translationQueuePriority || 0) + Math.max(0, 20 - batchIndex),
          },
        );
        requestId = handle.id;
        trackPageTranslationRequest(p, requestId);
        const { full } = await handle.promise;
        if (!isCurrentDocumentPageRequest()) return { cancelled: true, unresolvedItems: [] };
        renderGate.cancel();
        flushPendingChanges();
        const finalText = finalizeReadingTranslation(accumulator.raw, full);
        const inspection = accumulator.finish(finalText);
        const applied = applyChanges(inspection.changes);
        return {
          changes: inspection.changes,
          unresolvedItems: unresolvedReadingItems(
            batch,
            inspection.unresolvedItems,
            applied.rejectedUnitIds,
          ),
        };
      } catch (error) {
        if (!isCurrentDocumentPageRequest()) return { cancelled: true, unresolvedItems: [] };
        renderGate.cancel();
        flushPendingChanges();
        const partial = accumulator.finish(accumulator.raw);
        const applied = applyChanges(partial.changes);
        return {
          changes: partial.changes,
          unresolvedItems: unresolvedReadingItems(
            batch,
            partial.unresolvedItems,
            applied.rejectedUnitIds,
          ),
          error,
          cancelled: Boolean(error?.cancelled && !requestTimedOut),
          timedOut: requestTimedOut,
        };
      } finally {
        guard.done();
        forgetPageTranslationRequest(p, requestId);
      }
    },
    {
      concurrency: NODE_TRANSLATION_BATCH_CONCURRENCY,
      isCurrent: shouldContinueNodeBatches,
    },
  );

  renderGate.cancel();
  if (!isCurrentDocumentPageRequest()) { pendingChanges.clear(); return; }
  flushPendingChanges();
  if (p.retryRequested) {
    if (finishPageTranslation(p, generation)) updateHud();
    return;
  }

  const firstPassResults = firstPassSettled.map((settled, index) => (
    settled?.status === 'fulfilled'
      ? settled.value
      : { error: settled?.reason, unresolvedItems: requestBatches[index] }
  ));
  const firstUnresolvedItems = combineUnresolvedItems(requestItems, firstPassResults);
  if (firstUnresolvedItems.length === 0) {
    completeStructuredPage();
    return;
  }

  p.translationPhase = 'local-recovery';
  const recoveryStatus = `本页有 ${firstUnresolvedItems.length} 处译文需要重试，正在局部修复…`;
  setStructuredStatus(p, recoveryStatus, false);
  const recoveryBatches = createNodeTranslationBatches(firstUnresolvedItems, {
    firstMaxItems: 1,
    firstMaxCost: 700,
    maxItems: 3,
    maxCost: 1200,
  });
  const recoverySettled = await mapNodeTranslationBatches(
    recoveryBatches,
    async (batch, batchIndex) => {
      let retryRequestId = null;
      let retryTimedOut = false;
      const retryGuard = makeInactivityGuard(() => {
        if (!isCurrentDocumentPageRequest() || retryRequestId == null) return;
        retryTimedOut = true;
        client.cancel(retryRequestId);
      });
      try {
        const retry = await retryNodeItemsOnce({
          items: batch,
          targetLang,
          request: (text, retryDelta, retryStatus, retryMeta) => (
            client.translateNodes(text, retryDelta, retryStatus, {
              bypassCache: true,
              queuePriority: 1000 + Math.max(0, 20 - batchIndex),
              nodeSlotRetry: Boolean(retryMeta?.nodeSlotRetry),
            })
          ),
          isCurrent: isCurrentDocumentPageRequest,
          onRequestId: (retryId) => {
            retryRequestId = retryId;
            trackPageTranslationRequest(p, retryId);
          },
          onChanges: (changes) => {
            retryGuard.output();
            if (isCurrentDocumentPageRequest()) applyChanges(changes);
          },
          onPhase: (phase) => {
            if (!isCurrentDocumentPageRequest()) return;
            if (phase === 'queued') retryGuard.hold();
            else if (phase === 'streaming') retryGuard.output();
            else retryGuard.bump();
            p.translationPhase = 'local-recovery';
            setStructuredStatus(p, recoveryStatus, false);
          },
        });
        if (!isCurrentDocumentPageRequest()) return { cancelled: true, unresolvedItems: [] };
        const retryApplied = applyChanges(retry.changes || []);
        return {
          ...retry,
          unresolvedItems: retryTimedOut
            ? batch
            : unresolvedReadingItems(
              batch,
              retry.unresolvedItems || batch,
              retryApplied.rejectedUnitIds,
            ),
        };
      } finally {
        retryGuard.done();
        forgetPageTranslationRequest(p, retryRequestId);
      }
    },
    {
      concurrency: NODE_TRANSLATION_BATCH_CONCURRENCY,
      isCurrent: shouldContinueNodeBatches,
    },
  );

  if (!isCurrentDocumentPageRequest()) return;
  if (p.retryRequested) {
    if (finishPageTranslation(p, generation)) updateHud();
    return;
  }
  const recoveryResults = recoverySettled.map((settled, index) => (
    settled?.status === 'fulfilled'
      ? settled.value
      : { error: settled?.reason, unresolvedItems: recoveryBatches[index] }
  ));
  completeStructuredPage(combineUnresolvedItems(firstUnresolvedItems, recoveryResults));
}

// 注意：以下结构化/版面翻译管线自 0.9.6 起不可达（唯一数据源——本地版面服务已移除），
// 保留代码与对应单测以便日后整体摘除或复用；新功能请勿再依赖此路径。
async function translatePageLayout(p) {
  if (p.pageIr) return translatePageStructured(p);
  const md = p.mdEl;
  const documentGeneration = p.documentGeneration;
  const generation = beginPageTranslation(p);
  const isCurrentDocumentPageRequest = () => isCurrentDocumentPage(
    state.documentGeneration,
    state.closedGeneration,
    p,
    documentGeneration,
    generation,
  );
  for (const id of p.formulaRequestIds || []) client.cancel(id);
  p.formulaRequestIds = new Set();
  p.translationError = '';
  p.translationPhase = 'waiting-layout';
  md.className = 'md loading';
  md.textContent = '等待本地版面分析…';

  // 等整份分析完成（各页共享同一个 Promise）。
  try {
    await state.legacyLayoutPromise;
  } catch (e) {
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    failPage(p, '本地版面分析失败：' + (e.message || e));
    return;
  }
  if (!isCurrentDocumentPageRequest()) return;

  const blocks = Array.isArray(p.blocks) ? p.blocks : null;
  const textBlocks = blocks ? blocks.filter((b) => b.kind === 'text' && (b.md || '').trim()) : null;

  // 结构化纯媒体页：不把图片引用发给 LLM；直接显示原图引用和 LaTeX 公式链路。
  if (blocks && textBlocks.length === 0 && state.readerMode === 'reading') {
    p.translationPhase = '';
    const rerender = () => {
      if (isCurrentDocumentPageRequest()) renderLayoutBlocks(md, '', p, textBlocks, true);
    };
    rerender();
    startFormulaTranscriptions(p, generation, rerender);
    if (!isCurrentDocumentPageRequest() || !finishPageTranslation(p, generation)) return;
    markPageOutcome(p, 'done'); updateProgress(); updateHud();
    return;
  }

  // 没有结构化块（老服务/纯图页）：走「整页 Markdown」兜底路径。
  if (!textBlocks || textBlocks.length === 0) {
    const srcMd = (p.layoutMd || '').trim();
    if (!srcMd) {
      if (!isCurrentDocumentPageRequest() || !finishPageTranslation(p, generation)) return;
      renderLayoutMarkdown(md, '', p);
      markPageOutcome(p, 'done'); updateProgress(); updateHud();
      return;
    }
    return translatePageLayoutWhole(p, srcMd, generation);
  }

  // 分块翻译：把文本块用分隔符拼起来，图片不发给模型。
  const DELIM = '\n\n@@@BLK@@@\n\n';
  const sendMd = textBlocks.map((b) => b.md).join(DELIM);

  let raw = '';
  let final = false;
  let rafPending = false;
  const flushRender = () => {
    rafPending = false;
    if (isCurrentDocumentPageRequest()) renderLayoutBlocks(md, raw, p, textBlocks, final);
  };
  const scheduleRender = () => {
    if (!rafPending) { rafPending = true; requestAnimationFrame(flushRender); }
  };
  const onDelta = (d) => {
    if (!isCurrentDocumentPageRequest()) return;
    raw += d;
    p.translationPhase = '';
    guard.output();
    scheduleRender();
  };
  let lastRenderedPhase = null;
  const onStatus = (phase) => {
    if (!isCurrentDocumentPageRequest()) return;
    p.translationPhase = phase;
    if (phase === 'queued') guard.hold();
    else if (phase === 'streaming') guard.output();
    else guard.bump(); // connecting / thinking 心跳只重置首字节窗口
    // 重复的 thinking 心跳不重建整页 DOM，只有阶段变化才重绘。
    if (lastRenderedPhase !== phase) { lastRenderedPhase = phase; scheduleRender(); }
  };

  const { id, promise } = client.translateMarkdown(sendMd, onDelta, onStatus);
  p.trId = id;

  const guard = makeInactivityGuard(() => {
    if (!isCurrentDocumentPageRequest()) return;
    client.cancel(id, { settle: false });
    if (!finishPageTranslation(p, generation)) return;
    final = true;
    p.translationPhase = '';
    p.translationError = raw.trim()
      ? '翻译中断，已保留收到的部分译文。'
      : '模型响应较慢，本页可以稍后重试。';
    markPageOutcome(p, 'failed');
    setLastError(p.translationError);
    renderLayoutBlocks(md, raw, p, textBlocks, true);
    updateProgress(); updateHud();
  });

  // 正文请求已经进入队列后，再以全局单并发启动公式 OCR，避免公式占满正文并发槽位。
  renderLayoutBlocks(md, raw, p, textBlocks, false);
  startFormulaTranscriptions(p, generation, scheduleRender);

  promise.then(({ full }) => {
    guard.done();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    final = true;
    raw = finalizeReadingTranslation(raw, full);
    p.translationPhase = '';
    p.translationError = '';
    rememberPageTranslationText(p, raw);
    renderLayoutBlocks(md, raw, p, textBlocks, true);
    markPageOutcome(p, 'done'); updateProgress(); updateHud();
  }).catch((e) => {
    guard.done();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    if (e.cancelled) { updateHud(); return; }
    final = true;
    p.translationPhase = '';
    p.translationError = friendlyReaderError(e);
    markPageOutcome(p, 'failed');
    setLastError(p.translationError);
    renderLayoutBlocks(md, raw, p, textBlocks, true);
    updateProgress(); updateHud();
  });
}

// 兜底：整页 Markdown 翻译（无分块信息时）。仍做「图片本地回填」以防模型丢图。
async function translatePageLayoutWhole(p, srcMd, generation) {
  const md = p.mdEl;
  const documentGeneration = p.documentGeneration;
  const isCurrentDocumentPageRequest = () => isCurrentDocumentPage(
    state.documentGeneration,
    state.closedGeneration,
    p,
    documentGeneration,
    generation,
  );
  md.textContent = '';
  let raw = '';
  const renderGate = createRenderFrameGate(
    (callback) => requestAnimationFrame(callback),
    (id) => cancelAnimationFrame(id),
    () => {
    if (isCurrentDocumentPageRequest()) renderLayoutMarkdown(md, raw, p, false);
    },
  );
  const onDelta = (d) => {
    if (!isCurrentDocumentPageRequest()) return;
    raw += d;
    guard.output();
    renderGate.schedule();
  };
  const onStatus = (phase) => {
    if (!isCurrentDocumentPageRequest()) return;
    if (phase === 'queued') { guard.hold(); md.className = 'md loading'; md.textContent = '排队中…'; return; }
    if (phase === 'streaming') { guard.output(); return; }
    guard.bump(); // connecting / thinking 心跳只重置首字节窗口
    if (phase === 'thinking') { md.className = 'md thinking'; md.textContent = '正在组织译文…'; }
    else if (phase === 'connecting') { md.className = 'md loading'; md.textContent = '正在翻译…'; }
  };
  const { id, promise } = client.translateMarkdown(srcMd, onDelta, onStatus);
  p.trId = id;
  const guard = makeInactivityGuard(() => {
    if (!isCurrentDocumentPageRequest()) return;
    renderGate.cancel();
    client.cancel(id, { settle: false });
    if (!finishPageTranslation(p, generation)) return;
    if (raw.trim()) {
      recordPartialFailure(p, '翻译超时，以下为已收到的部分译文', () => renderLayoutMarkdown(md, raw, p, true));
    }
    else failPage(p, '模型响应较慢，本页可以稍后重试。');
  });
  promise.then(({ full }) => {
    guard.done();
    renderGate.cancel();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    raw = finalizeReadingTranslation(raw, full);
    rememberPageTranslationText(p, raw);
    renderLayoutMarkdown(md, raw, p, true);
    markPageOutcome(p, 'done'); updateProgress(); updateHud();
  }).catch((e) => {
    guard.done();
    renderGate.cancel();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    if (e.cancelled) { updateHud(); return; }
    if (raw.trim()) {
      rememberPageTranslationText(p, raw);
      recordPartialFailure(p, e.message || '翻译中断，以下为已收到的部分译文', () => renderLayoutMarkdown(md, raw, p, true));
    }
    else failPage(p, e.message || String(e));
  });
}

// 当前生产路径：整页图像作为版面真相，原生文本只提供覆盖与锚点提示。
async function translatePageVision(p) {
  const md = p.mdEl;
  const documentGeneration = p.documentGeneration;
  const generation = beginPageTranslation(p);
  const isCurrentDocumentPageRequest = () => isCurrentDocumentPage(
    state.documentGeneration,
    state.closedGeneration,
    p,
    documentGeneration,
    generation,
  );
  const qualityRetry = Boolean(p.visionQualityRetry || p.visionQualityFailure);
  // 术语重译：锁定新术语后命中页重译。旧译文全程保持可读（同精修流程），
  // 缓存由术语指纹身份自然绕过（见 translation-cache.js），无需 bypassCache。
  const glossaryRefresh = Boolean(p.glossaryRetranslate);
  p.glossaryRetranslate = false;
  const preservedDraft = (qualityRetry || glossaryRefresh) ? String(p.translationText || '').trim() : '';
  const preserveVisibleDraft = Boolean(preservedDraft);
  if (preserveVisibleDraft) {
    if (!md.textContent?.trim()) renderMarkdown(md, preservedDraft, true);
    showVisionQualityNotice(p, glossaryRefresh && !qualityRetry
      ? { mode: 'refining', detail: '已锁定新术语，正在按术语表统一本页译法。' }
      : { mode: 'refining' });
  } else {
    md.className = 'md loading';
    md.textContent = qualityRetry ? '正在准备高精度复核…' : '正在分析页面密度…';
  }
  let sourceTextHint = String(p.agentSourceText || '').trim();
  if (!sourceTextHint) {
    try {
      await ensurePdfPage(p.num - 1, p.documentGeneration);
      const textContent = await p.pageObj.getTextContent();
      sourceTextHint = agentTextFromTextContent(textContent);
      if (sourceTextHint) p.agentSourceText = sourceTextHint;
    } catch { /* scanned pages legitimately have no native text */ }
  }
  if (!isCurrentDocumentPageRequest()) return;

  const sourceChars = sourceTextHint.replace(/\s+/gu, '').length;
  const renderWidth = selectVisionRenderWidth({ sourceChars, qualityRetry });
  p.visionRenderWidth = renderWidth;
  if (preserveVisibleDraft) {
    showVisionQualityNotice(p, glossaryRefresh && !qualityRetry
      ? { mode: 'refining', detail: '已锁定新术语，正在按术语表统一本页译法。' }
      : { mode: 'refining' });
  } else md.textContent = qualityRetry ? '正在高精度渲染失败区域…' : '正在渲染页面…';
  let image;
  try {
    image = await renderPageImage(p, renderWidth);
  } catch (e) {
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    failPage(p, '页面渲染失败：' + (e.message || e)); return;
  }
  if (!isCurrentDocumentPageRequest()) return;

  if (!preserveVisibleDraft) md.textContent = '';
  let raw = '';
  // 流式期间就用 Markdown 增量渲染（节流），不再显示原始 ## / $ 源码
  const renderGate = createRenderFrameGate(
    (callback) => requestAnimationFrame(callback),
    (id) => cancelAnimationFrame(id),
    () => {
      if (isCurrentDocumentPageRequest() && !preserveVisibleDraft) renderMarkdown(md, raw, false);
    },
  );
  const onDelta = (d) => {
    if (!isCurrentDocumentPageRequest()) return;
    raw += d; guard.output();
    if (!preserveVisibleDraft) renderGate.schedule();
  };
  const onStatus = (phase) => {
    if (!isCurrentDocumentPageRequest()) return;
    if (phase === 'queued') {
      guard.hold();
      if (preserveVisibleDraft) showVisionQualityNotice(p, { mode: 'refining' });
      else { md.className = 'md loading'; md.textContent = '排队中…'; }
      return;
    }
    if (phase === 'streaming') { guard.output(); return; }
    guard.bump(); // connecting / thinking 心跳只重置首字节窗口
    if (preserveVisibleDraft) {
      showVisionQualityNotice(p, { mode: 'refining' });
    } else if (phase === 'thinking') {
      md.className = 'md thinking'; md.textContent = '正在识别页面结构…';
    } else if (phase === 'connecting') {
      md.className = 'md loading'; md.textContent = '正在请求视觉模型…';
    }
  };

  if (!isCurrentDocumentPageRequest()) return;
  // After a quality rejection, ask the model again with a stricter user instruction
  // and bypass cache so we do not replay the bad completion.
  const requestContext = buildVisionTranslationContext({
    sourceText: sourceTextHint,
    quality: p.visionQualityFailure || (qualityRetry
      ? { ok: false, reason: 'model-self-talk', reasons: ['model-self-talk'] }
      : null),
  });
  const { id, promise } = client.translateImage(image, onDelta, onStatus, {
    text: requestContext,
    bypassCache: qualityRetry,
  });
  p.trId = id;
  // 与翻译并行：检测并裁剪本页图形区
  const figuresPromise = state.readerMode === 'reading' ? Promise.resolve([]) : detectFigures(p);

  const finalRender = async (text) => {
    if (!isCurrentDocumentPageRequest()) return;
    renderMarkdown(md, text, true);
    let figs = [];
    try { figs = await figuresPromise; } catch { figs = []; }
    if (!isCurrentDocumentPageRequest()) return;
    try { fillFigureSlots(md, figs); } catch (e) { console.warn('[PL-VIEW] fillFigureSlots 失败', e); }
  };

  const guard = makeInactivityGuard(() => {
    if (!isCurrentDocumentPageRequest()) return;
    renderGate.cancel();
    client.cancel(id, { settle: false });
    if (!finishPageTranslation(p, generation)) return;
    if (preserveVisibleDraft) {
      retainVisionQualityDraftAfterRetry(p, '高精度精修超时，当前译文已保留');
      return;
    }
    if (raw.trim()) {
      recordPartialFailure(p, '翻译超时，以下为已收到的部分译文', () => finalRender(raw));
    }
    else failPage(p, '模型响应较慢，本页可以稍后重试。');
  });

  promise.then(({ full }) => {
    guard.done();
    renderGate.cancel();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    raw = finalizeReadingTranslation(raw, full);
    const quality = assessVisionTranslationQuality(raw, {
      targetLang: state.config?.targetLang || '简体中文',
      sourceText: sourceTextHint,
    });
    if (!quality.ok) {
      // Quality is advisory for non-empty output: keep a readable draft visible,
      // then retry behind it. A failed refinement must never blank the page.
      presentVisionQualityDraft(p, preserveVisibleDraft ? preservedDraft : raw, quality, {
        render: preserveVisibleDraft ? null : finalRender,
      });
      return;
    }
    p.visionQualityRetry = false;
    p.visionQualityFailure = null;
    p.visionQualityAdvisory = null;
    rememberPageTranslationText(p, raw);
    finalRender(raw);
    markPageOutcome(p, 'done'); updateProgress(); updateHud();
  }).catch((e) => {
    guard.done();
    renderGate.cancel();
    if (!isCurrentDocumentPageRequest()) return;
    if (!finishPageTranslation(p, generation)) return;
    if (e.cancelled) { updateHud(); return; }
    if (preserveVisibleDraft) {
      retainVisionQualityDraftAfterRetry(p, e.message || String(e));
      return;
    }
    if (raw.trim()) {
      const cleaned = finalizeReadingTranslation(raw, raw);
      const quality = assessVisionTranslationQuality(cleaned, {
        targetLang: state.config?.targetLang || '简体中文',
        sourceText: sourceTextHint,
      });
      if (!quality.ok) {
        presentVisionQualityDraft(p, cleaned, quality, { render: finalRender });
        return;
      }
      p.visionQualityRetry = false;
      p.visionQualityFailure = null;
      p.visionQualityAdvisory = null;
      rememberPageTranslationText(p, cleaned);
      recordPartialFailure(p, e.message || '翻译中断，以下为已收到的部分译文', () => finalRender(cleaned));
    }
    else failPage(p, e.message || String(e));
  });
}

function visionQualityNoticeDetail(quality, fallback = '') {
  const explicit = String(fallback || '').trim();
  if (explicit) return explicit;
  return describeVisionQualityIssue(quality);
}

/** Keep quality feedback compact and non-blocking above the readable draft. */
function showVisionQualityNotice(p, {
  mode = 'scheduled',
  detail = '',
} = {}) {
  const root = p?.mdEl;
  if (!root) return;
  let notice = root.querySelector?.('.vision-quality-notice');
  if (!notice) {
    notice = document.createElement('aside');
    notice.className = 'vision-quality-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const title = document.createElement('strong');
    title.className = 'vision-quality-title';
    const copy = document.createElement('span');
    copy.className = 'vision-quality-detail';
    notice.append(title, copy);
  }
  notice.dataset.state = mode;
  const title = notice.querySelector('.vision-quality-title');
  const copy = notice.querySelector('.vision-quality-detail');
  const titles = {
    refining: '正在后台精修，当前译文仍可阅读',
    scheduled: '当前译文已显示，后台将自动精修',
    review: '当前译文已保留，建议结合左侧原文核对',
  };
  if (title) title.textContent = titles[mode] || titles.review;
  if (copy) {
    const reason = visionQualityNoticeDetail(p.visionQualityFailure, detail);
    copy.textContent = `${reason} 精修过程不会清空当前译文。`;
  }
  if (root.firstElementChild !== notice) root.prepend(notice);
  root.classList.remove('loading', 'thinking', 'error');
  root.classList.add('done', 'vision-quality-draft');
}

function presentVisionQualityDraft(p, text, quality, options) {
  const render = options?.render || null;
  const draft = String(text || '').trim();
  if (!draft) {
    failPage(p, quality?.message || '模型未产出可读译文，请重试本页');
    return false;
  }
  p.translationText = draft;
  p.translationError = '';
  if (!shouldAutoRefineVisionQuality(quality)) {
    // Readable translations win over heuristic confidence scores. Keep the
    // diagnostics for debugging/manual retry, but do not show a warning banner,
    // mark the page partial, or spend another model request automatically.
    p.visionQualityAdvisory = quality;
    p.visionQualityRetry = false;
    p.visionQualityFailure = null;
    clearSmartPageRetry(p);
    p.smartRetryAttempt = 0;
    if (typeof render === 'function') render(draft);
    p.mdEl?.querySelector?.('.vision-quality-notice')?.remove?.();
    p.mdEl?.classList?.remove?.('vision-quality-draft', 'loading', 'thinking', 'error');
    p.mdEl?.classList?.add?.('done');
    markPageOutcome(p, 'done');
    updateHud();
    return true;
  }
  p.visionQualityAdvisory = null;
  p.visionQualityRetry = true;
  p.visionQualityFailure = quality;
  if (typeof render === 'function') render(draft);
  markPageOutcome(p, 'partial');
  const retryReason = quality?.message || quality?.reason || '模型输出异常';
  const willAuto = shouldScheduleAutoRetry({
    attempt: Math.max(0, Number(p.smartRetryAttempt) || 0),
    error: retryReason,
  });
  showVisionQualityNotice(p, { mode: willAuto ? 'scheduled' : 'review' });
  updateHud();
  if (willAuto) scheduleSmartPageRetry(p, retryReason);
  return true;
}

function retainVisionQualityDraftAfterRetry(p, error) {
  if (!String(p?.translationText || '').trim()) {
    failPage(p, error);
    return;
  }
  p.translationError = '';
  p.visionQualityRetry = true;
  markPageOutcome(p, 'partial');
  const retryReason = error || p.visionQualityFailure?.message || '高精度精修未完成';
  const willAuto = shouldScheduleAutoRetry({
    attempt: Math.max(0, Number(p.smartRetryAttempt) || 0),
    error: retryReason,
  });
  showVisionQualityNotice(p, {
    mode: willAuto ? 'scheduled' : 'review',
    detail: friendlyReaderError(retryReason),
  });
  updateHud();
  if (willAuto) scheduleSmartPageRetry(p, retryReason);
}

function failPage(p, msg) {
  const friendly = friendlyReaderError(msg);
  p.translationError = friendly;
  markPageOutcome(p, 'failed');
  p.mdEl.className = 'md error';
  const willAuto = shouldScheduleAutoRetry({
    attempt: Math.max(0, Number(p.smartRetryAttempt) || 0),
    error: msg,
  });
  p.mdEl.textContent = willAuto
    ? `${friendly} 将自动重试，也可点击“重试本页”。`
    : `${friendly} 请点击“重试本页”。`;
  p.mdEl.setAttribute('aria-busy', 'false');
  setLastError(msg); updateProgress(); updateHud();
  scheduleSmartPageRetry(p, msg);
}

function recordPartialFailure(p, msg, render) {
  p.translationError = friendlyReaderError(msg);
  markPageOutcome(p, 'failed');
  setLastError(msg);
  render();
  updateProgress();
  updateHud();
  // Partial text is still useful; only auto-retry when little/no content landed.
  if (!String(p.translationText || p.mdEl?.innerText || '').trim()) {
    scheduleSmartPageRetry(p, msg);
  }
}

// Markdown（含 LaTeX）渲染。final=true 时同时渲染数学公式（KaTeX）。
let mathReady = null;
function getMarked() {
  return window.marked || (window.marked && window.marked.marked) || null;
}
function renderMarkdown(el, text, final) {
  el.className = final ? 'md done' : 'md';
  let src = (text || '').trim();
  src = src.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '');
  // Tables stay on the PDF: collapse any residual GFM grids to @@TABLE@@.
  src = stripMarkdownTablesToPlaceholders(src);
  // Strip OCR junk like "695: [16]" and keep clean [n] bibliography form.
  src = normalizeBibliographyMarkdown(src);
  // Recover algorithm line breaks/indent when the model collapsed pseudocode.
  src = formatAlgorithmsInMarkdown(src);
  // Fold "(3)" after $$...$$ into \\tag{3} so numbers sit right of the display.
  src = mergeTrailingEquationNumbers(src);
  // 关键：先把公式段挖出来占位保护，避免 marked 把 $..$ 里的 _ * 等当成 markdown 语法破坏掉 LaTeX。
  const { masked, math } = protectMath(src);
  const safeMasked = neutralizeRawHtml(masked);
  const marked = getMarked();
  let html;
  try {
    if (marked && typeof marked.parse === 'function') html = marked.parse(safeMasked);
    else if (typeof marked === 'function') html = marked(safeMasked);
    else { el.textContent = src; if (mathReady === null) { mathReady = false; console.warn('[PL-VIEW] marked 不可用，降级为纯文本。window.marked=', window.marked); } return; }
  } catch (e) { console.warn('[PL-VIEW] marked 解析失败', e); el.textContent = src; return; }
  // 公式先转义为文本再还原；KaTeX 从 DOM 文本读取定界符，模型内容不会成为 HTML。
  html = sanitizeMarkedHtml(restoreMath(html, math));
  el.innerHTML = html;
  wrapTables(el);
  if (final) {
    // Algorithm fences are <pre><code>; KaTeX auto-render skips those tags.
    // Promote them to .vision-algorithm and render $...$ inside with KaTeX.
    hydrateAlgorithmBlocks(el);
    // Fallback: model dumped "1: … 2: …" as a normal paragraph — recover structure.
    recoverCollapsedAlgorithmParagraphs(el);
    // Residual HTML tables from marked → replace with left-PDF hint.
    replaceHtmlTablesWithSourceRefs(el);
    fillTablePlaceholders(el);
    renderMathIn(el);
    layoutDisplayEquationNumbers(el);
    markIncompleteMath(el);
  }
}

function fillTablePlaceholders(el) {
  replaceMediaPlaceholders(el, '@@TABLE@@', {
    figures: [],
    readingLabel: '查看左侧原表',
    cropClass: 'table-crop',
    refClass: 'blk source-ref table-source-ref',
    alwaysRef: true,
  });
}

/** After marked renders a GFM table, swap it for a "see left PDF" chip. */
function replaceHtmlTablesWithSourceRefs(root) {
  if (!root?.querySelectorAll) return;
  for (const table of [...root.querySelectorAll('table')]) {
    if (table.closest?.('.structured-table, .reading-table, .vision-algorithm')) continue;
    const ref = document.createElement('div');
    ref.className = 'table-source-ref-block';
    ref.innerHTML = '<span class="source-ref table-source-ref">查看左侧原表（表格保留在 PDF，不写入译文）</span>';
    const wrap = table.closest?.('.table-wrap') || table;
    wrap.replaceWith(ref);
  }
}

// 给每个 <table> 套一层可横向滚动的容器，避免宽表撑破右栏。
function wrapTables(el) {
  el.querySelectorAll('table').forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
}

// 无活动超时守卫已提取为可单测模块 src/lib/inactivity-guard.js：
// 首字节前 bump() 只重置完整 firstMs 窗口（connecting/thinking 心跳不缩窗）；
// 首字节（chunk/streaming）后由 output() 切换到 idleMs；queued 时 hold() 停表，
// 停表带兜底上限防止 Port 丢消息后页面永远「排队中…」。

// 分块渲染：把模型返回的（含 @@@BLK@@@ 分隔符的）译文切回每个文本块，
// 与源块 bbox 对应；再按原始阅读顺序重建整页（文本块 + 图片块），
// 每个渲染出的块打上 data-blk 索引，供段落级双向定位。
function renderLayoutBlocks(el, text, p, textBlocks, final = true) {
  const raw = (text || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '');
  const parts = raw.split(/\n*@@@BLK@@@\n*/g).map((s) => s.trim());
  // 模型偶尔多切/少切：以源块数为准对齐，多出的并入最后一块，缺的留空。
  const translated = textBlocks.map((_, i) => {
    if (i < textBlocks.length - 1) return parts[i] != null ? parts[i] : '';
    return parts.slice(i).join('\n\n');   // 最后一块吸收多余尾部
  });

  // 建立「源文本块 md -> 译文」映射（按顺序）；同时把图片块按原顺序插回。
  const images = (p && p.layoutImages) || {};
  const allBlocks = Array.isArray(p.blocks) ? p.blocks : textBlocks;
  let ti = 0;
  const htmlPieces = [];
  const blkMeta = [];   // 与渲染出的 .blk 一一对应：{ bbox }
  const formulaRenders = [];
  const formulaFallbacks = [];
  for (let sourceBlockIndex = 0; sourceBlockIndex < allBlocks.length; sourceBlockIndex++) {
    const b = allBlocks[sourceBlockIndex];
    if (b.kind === 'image' || b.kind === 'formula') {
      const blockIndex = blkMeta.length;
      const url = images[b.name] || findImageLoose(images, b.name || '');
      const formulaState = b.kind === 'formula'
        ? p.formulaStates?.[formulaStateKey(b, p.num, sourceBlockIndex)]
        : null;
      const presentation = getReadingMediaPresentation(b, { formulaState, imageUrl: url });

      if (presentation?.type === 'latex') {
        htmlPieces.push(`<div class="blk formula-latex" data-blk="${blockIndex}"><div class="formula-display"></div><span class="formula-number"></span></div>`);
        formulaRenders.push({ blockIndex, latex: presentation.latex, number: presentation.number, imageUrl: url });
      } else if (presentation?.type === 'formula-image') {
        htmlPieces.push(`<div class="blk formula-fallback" data-blk="${blockIndex}"><img alt=""><span class="source-ref">识别失败，查看左侧公式</span></div>`);
        formulaFallbacks.push({ blockIndex, imageUrl: presentation.imageUrl });
      } else {
        const pendingClass = presentation?.type === 'pending' ? ' formula-pending' : '';
        const imageClass = b.kind === 'image' ? ' source-ref-image' : '';
        htmlPieces.push(`<div class="blk source-ref${imageClass}${pendingClass}" data-blk="${blockIndex}">${escapeHtml(presentation?.label || '')}</div>`);
      }
      blkMeta.push({ bbox: b.bbox });
    } else {
      // 只有「非空文本块」参与了翻译（与 sendMd 的过滤一致），空块不消耗译文槽位，避免错位。
      if (!(b.md || '').trim()) continue;
      const zh = (translated[ti] || '').trim();
      ti++;
      const bodyHtml = mdToHtml(zh);
      htmlPieces.push(`<div class="blk" data-blk="${blkMeta.length}">${bodyHtml}</div>`);
      blkMeta.push({ bbox: b.bbox });
    }
  }
  el.className = final ? 'md done' : 'md';
  el.innerHTML = htmlPieces.join('\n');
  const statusText = p.translationError || translationPhaseText(p.translationPhase);
  if (statusText) {
    const status = document.createElement('div');
    status.className = `translation-status${p.translationError ? ' error' : ''}`;
    status.textContent = statusText;
    el.prepend(status);
  }
  wrapTables(el);
  p.blkMeta = blkMeta;
  p.blkEls = Array.from(el.children).filter((child) => child.classList.contains('blk'));
  for (const item of formulaFallbacks) {
    const img = p.blkEls[item.blockIndex]?.querySelector('img');
    if (img && item.imageUrl) img.src = item.imageUrl;
  }
  for (const item of formulaRenders) {
    const blockEl = p.blkEls[item.blockIndex];
    const host = blockEl?.querySelector('.formula-display');
    const number = blockEl?.querySelector('.formula-number');
    if (number) number.textContent = item.number || '';
    try {
      if (!host || typeof window.katex?.render !== 'function') throw new Error('KaTeX 不可用');
      const latex = normalizeMathForKatex(item.latex);
      if (!latex) throw new Error('公式包含无法安全渲染的字符');
      window.katex.render(latex, host, {
        displayMode: true,
        throwOnError: true,
        strict: 'ignore',
      });
    } catch (e) {
      console.warn('[PL-VIEW] 公式 KaTeX 渲染失败，回退原图', e);
      renderFormulaFallback(blockEl, item.imageUrl);
    }
  }
  if (final) renderMathIn(el);
}

function translationPhaseText(phase) {
  return ({
    'waiting-layout': '正在识别页面结构…',
    queued: '即将开始翻译…',
    thinking: '正在组织译文…',
    connecting: '正在连接模型…',
    'local-recovery': '正在补全少量未完成内容…',
  })[phase] || '';
}

function renderFormulaFallback(blockEl, imageUrl) {
  if (!blockEl) return;
  blockEl.replaceChildren();
  if (imageUrl) {
    blockEl.className = 'blk formula-fallback';
    const img = document.createElement('img');
    img.alt = '';
    img.src = imageUrl;
    const label = document.createElement('span');
    label.className = 'source-ref';
    label.textContent = '识别失败，查看左侧公式';
    blockEl.append(img, label);
  } else {
    blockEl.className = 'blk source-ref';
    blockEl.textContent = '查看左侧公式';
  }
}

// 把一小段 Markdown 转成 HTML（含公式保护/还原），不做 KaTeX（渲染在容器层统一做）。
function mdToHtml(src) {
  const { masked, math } = protectMath(src);
  const safeMasked = neutralizeRawHtml(masked);
  const marked = getMarked();
  let html;
  try {
    if (marked && typeof marked.parse === 'function') html = marked.parse(safeMasked);
    else if (typeof marked === 'function') html = marked(safeMasked);
    else return escapeHtml(src);
  } catch { return escapeHtml(src); }
  return sanitizeMarkedHtml(restoreMath(html, math));
}

// 方案 C 渲染：先把 Markdown 里的 ![](name) 图片引用替换为本地服务返回的内嵌 data URL，
// 再走与 renderMarkdown 相同的「公式保护 -> marked -> 还原 -> KaTeX」流程。
function renderLayoutMarkdown(el, text, p, final = true) {
  let src = (text || '').trim();
  const images = (p && p.layoutImages) || {};
  if (state.readerMode === 'reading') {
    src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '@@FIGURE@@');
    renderMarkdown(el, src, final);
    fillFigureSlots(el, []);
    return;
  }
  // ![alt](name) -> ![alt](dataURL)。marker 的图片名可能带路径/大小写差异，做宽松匹配。
  src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, ref) => {
    const key = ref.trim();
    const url = images[key] || images[key.replace(/^\.?\//, '')] || findImageLoose(images, key);
    return url ? `![${alt}](${url})` : m;
  });
  renderMarkdown(el, src, final);
}

// 宽松匹配图片名：marker 返回的键与 markdown 引用偶有前缀差异，按 basename 兜底。
function findImageLoose(images, key) {
  const base = key.split('/').pop();
  if (base && images[base]) return images[base];
  for (const k of Object.keys(images)) {
    if (k.split('/').pop() === base) return images[k];
  }
  return null;
}

// 把 $$..$$、\[..\]、$..$、\(..\) 段替换为不可被 marked 破坏的占位符；返回占位后的文本与公式表。
// math[] 项为 { text, incomplete, plain }，incomplete 用于「公式可能不完整」角标。
function protectMath(src) {
  const math = [];
  const stash = (raw) => {
    const token = `@@MATH${math.length}@@`;
    math.push(prepareDelimitedMathForRender(raw));
    return token;
  };
  let s = src;
  // 顺序很重要：先块级（$$、\[..\]），再行内（$、\(..\)），避免 $ 抢先吃掉 $$。
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m) => stash(m));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m) => stash(m));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m) => stash(m));
  // 行内 $..$：不跨行、不匹配空的 $$（已在上面处理），避免误吃货币符号时要求内部无换行。
  s = s.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (m) => stash(m));
  return { masked: s, math };
}

// 还原占位符。marked 可能把占位符包进 <p> 或转义，故用正则宽松匹配 token 数字。
function restoreMath(html, math) {
  return html.replace(/@@MATH(\d+)@@/g, (_, n) => {
    const item = math[Number(n)];
    if (item == null) return '';
    // Back-compat: plain string from older paths.
    if (typeof item === 'string') return escapeHtml(item);
    const body = escapeHtml(item.text || '');
    if (!item.incomplete) return body;
    return `<span class="math-incomplete-wrap" data-math-incomplete="1" title="公式可能不完整：模型混入了非 LaTeX 字符">${body}</span>`;
  });
}

/** After KaTeX auto-render, attach a visible badge on incomplete formulas. */
function markIncompleteMath(root) {
  if (!root?.querySelectorAll) return;
  for (const wrap of root.querySelectorAll('[data-math-incomplete="1"]')) {
    wrap.classList.add('math-incomplete');
    if (!wrap.querySelector('.katex')) wrap.classList.add('math-incomplete-plain');
    if (wrap.querySelector('.math-incomplete-badge')) continue;
    const badge = document.createElement('span');
    badge.className = 'math-incomplete-badge';
    badge.textContent = '公式可能不完整';
    badge.title = '模型把中文或其他非 LaTeX 字符写进了公式，已尽量渲染剩余部分';
    wrap.appendChild(badge);
  }
}
function renderMathIn(el) {
  const fn = window.renderMathInElement;
  if (!fn) return;
  try {
    fn(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      // Must stay false: katex-guard soft-strips unsafe Unicode instead of
      // throwing, so one mixed CJK/$ formula cannot abort the whole page.
      throwOnError: false,
      strict: 'ignore',
      errorCallback: () => {
        // Swallow KaTeX parse noise; do not console.warn (runtime-diagnostics
        // would promote it to an extension error entry).
      },
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch {
    // Defensive: auto-render should not throw with throwOnError:false.
  }
}

const ALGORITHM_CODE_SELECTOR = [
  'pre > code.language-algorithm',
  'pre > code.language-pseudo',
  'pre > code.language-pseudocode',
  'pre > code.language-algo',
  'pre > code[class*="algorithm"]',
  'pre > code[class*="pseudo"]',
].join(', ');

/**
 * Turn fenced algorithm code blocks into structured pre-wrap hosts and render
 * inline/display math with KaTeX (auto-render ignores <pre>/<code>).
 */
function hydrateAlgorithmBlocks(root) {
  if (!root?.querySelectorAll) return;
  const seen = new Set();
  const codes = [
    ...root.querySelectorAll(ALGORITHM_CODE_SELECTOR),
    // Any <pre><code> that is clearly a collapsed/numbered algorithm dump.
    ...[...root.querySelectorAll('pre > code')].filter((code) => {
      const text = code.textContent || '';
      if (looksLikeLatexHeavy(text)) return false;
      // Only true algorithm step markers (excludes math ranges 0:i-1).
      return looksLikeCompactAlgorithm(text);
    }),
  ];
  for (const code of codes) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== 'PRE' || seen.has(pre)) continue;
    seen.add(pre);
    const source = code.textContent || '';
    if (looksLikeBibliographyList(source)) continue;
    const previous = pre.previousElementSibling;
    if (previous && /^(?:H[1-6]|P)$/u.test(previous.tagName || '')
      && /(?:算法|Algorithm)\s*\d+/iu.test(previous.textContent || '')) {
      previous.textContent = localizeAlgorithmTitle(previous.textContent || '', {
        targetLang: state.config?.targetLang || '简体中文',
      });
    }
    const host = document.createElement('div');
    host.className = 'vision-algorithm';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', '伪代码');
    fillAlgorithmHost(host, source);
    pre.replaceWith(host);
  }
}

/**
 * When the model (or an older cache) left algorithms as plain <p> walls of
 * "1: … 2: …", convert them into .vision-algorithm blocks with line breaks.
 */
function recoverCollapsedAlgorithmParagraphs(root) {
  if (!root?.querySelectorAll) return;
  const candidates = [...root.querySelectorAll('p, li, div.md > div')].filter((el) => {
    if (el.closest?.('.vision-algorithm, pre, code, table, .katex')) return false;
    if (el.querySelector?.('.vision-algorithm, pre, table')) return false;
    const text = String(el.textContent || '').trim();
    if (text.length < 40) return false;
    if (looksLikeBibliographyList(text)) return false;
    // Multi-line already structured inside element — skip if many child blocks.
    if (el.children?.length > 3) return false;
    return looksLikeCompactAlgorithm(text)
      || (text.match(/\d{1,3}\s*[:.：．]\s*/g) || []).length >= 4;
  });
  for (const el of candidates) {
    const recovered = recoverAlgorithmFromPlainText(el.textContent || '');
    if (!recovered?.lines?.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'vision-algorithm-wrap';
    if (recovered.title) {
      // Keep title if this node was only the dump; if title already a previous sibling, skip.
      const prev = el.previousElementSibling;
      const prevText = String(prev?.textContent || '').trim();
      const titleAlreadyShown = prevText && (
        prevText === recovered.title
        || prevText.includes(recovered.title)
        || recovered.title.includes(prevText)
      );
      if (!titleAlreadyShown) {
        const heading = document.createElement('p');
        heading.className = 'vision-algorithm-title';
        heading.textContent = localizeAlgorithmTitle(recovered.title, {
          targetLang: state.config?.targetLang || '简体中文',
        });
        wrap.appendChild(heading);
      }
    }
    const host = document.createElement('div');
    host.className = 'vision-algorithm';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', '伪代码');
    fillAlgorithmHost(host, recovered.lines.join('\n'));
    wrap.appendChild(host);
    el.replaceWith(wrap);
  }
}

function fillAlgorithmHost(host, source) {
  // Always re-split + re-indent so nested For/If match the paper structure.
  let text = stripMarkdownNoiseFromAlgorithm(String(source || '').replace(/\r\n?/g, '\n'));
  const nonEmptyCount = text.split('\n').filter((l) => l.trim()).length;
  if (looksLikeCompactAlgorithm(text) || nonEmptyCount >= 3) {
    const recovered = recoverAlgorithmFromPlainText(text);
    if (recovered?.lines?.length >= 2) {
      text = recovered.lines.join('\n');
    } else {
      // Already multi-line numbered steps: still recompute nest indent.
      text = indentAlgorithmLines(text);
    }
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'vision-algorithm-line';
    const display = prepareAlgorithmDisplayLine(line);
    if (!display) {
      row.innerHTML = '&nbsp;';
    } else {
      appendAlgorithmLineContent(row, display);
    }
    host.appendChild(row);
  }
}

/** Render one algorithm line: step # | indented body (depth via CSS, not fragile spaces). */
function appendAlgorithmLineContent(container, text) {
  const cleaned = prepareAlgorithmDisplayLine(text);
  const parsed = parseAlgorithmDisplayLine(cleaned);
  container.dataset.algoDepth = String(parsed.depth || 0);
  container.style.setProperty('--algo-depth', String(parsed.depth || 0));

  if (parsed.num) {
    const num = document.createElement('span');
    num.className = 'vision-algorithm-step';
    num.textContent = parsed.num;
    container.appendChild(num);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'vision-algorithm-step vision-algorithm-step-empty';
    spacer.textContent = '';
    container.appendChild(spacer);
  }

  const body = document.createElement('span');
  body.className = 'vision-algorithm-body';
  const preparedBody = prepareAlgorithmBodyForDisplay(parsed.body || '', {
    targetLang: state.config?.targetLang || '简体中文',
  });
  appendTextWithInlineMath(body, preparedBody);
  emphasizeAlgorithmKeywords(body);
  container.appendChild(body);
}

function emphasizeAlgorithmKeywords(container) {
  if (!container?.childNodes?.length) return;
  const kw = /^(?:Begin|End(?:\s*(?:If|For|While|Function|Procedure))?|While|For|If|Else(?:\s*If)?|Then|Do|Return|Input|Output|输入|输出|开始|结束(?:条件|循环|函数|过程)?|当|对于|对每个|如果|否则如果|否则|则|执行|返回)$/iu;
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || '';
      if (!/[A-Za-z]/.test(value)) return;
      const parts = value.split(/(\b(?:Begin|End(?:\s*(?:If|For|While|Function|Procedure))?|While|For|If|Else(?:\s*If)?|Then|Do|Return|Input|Output)\b|输入|输出|开始|结束(?:条件|循环|函数|过程)?|当|对于|对每个|如果|否则如果|否则|则|执行|返回)/iu);
      if (parts.length <= 1) return;
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (kw.test(part.trim())) {
          const em = document.createElement('span');
          em.className = 'vision-algorithm-kw';
          em.textContent = part;
          frag.appendChild(em);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      }
      node.parentNode?.replaceChild(frag, node);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList?.contains?.('algorithm-math') || node.classList?.contains?.('katex')) return;
      [...node.childNodes].forEach(walk);
    }
  };
  [...container.childNodes].forEach(walk);
}

/** Tokenize plain text into text / math segments ($...$, $$...$$, \\(...\\), \\[...\\]). */
function tokenizeInlineMath(text) {
  const source = String(text || '');
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('$$', i)) {
      const end = source.indexOf('$$', i + 2);
      if (end >= 0) {
        tokens.push({ type: 'math', display: true, value: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (source.startsWith('\\[', i)) {
      const end = source.indexOf('\\]', i + 2);
      if (end >= 0) {
        tokens.push({ type: 'math', display: true, value: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (source.startsWith('\\(', i)) {
      const end = source.indexOf('\\)', i + 2);
      if (end >= 0) {
        tokens.push({ type: 'math', display: false, value: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (source[i] === '$' && source[i + 1] !== '$') {
      const end = source.indexOf('$', i + 1);
      if (end > i + 1) {
        tokens.push({ type: 'math', display: false, value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Accumulate plain text until next math candidate.
    let j = i + 1;
    while (j < source.length) {
      if (source[j] === '$' || source.startsWith('\\[', j) || source.startsWith('\\(', j)) break;
      j += 1;
    }
    tokens.push({ type: 'text', value: source.slice(i, j) });
    i = j;
  }
  return tokens;
}

function appendTextWithInlineMath(container, text) {
  const tokens = tokenizeInlineMath(text);
  for (const token of tokens) {
    if (token.type === 'text') {
      if (token.value) container.appendChild(document.createTextNode(token.value));
      continue;
    }
    const span = document.createElement('span');
    span.className = token.display ? 'algorithm-math algorithm-math-display' : 'algorithm-math';
    const latex = normalizeMathForKatex(token.value) || String(token.value || '').trim();
    try {
      if (!latex || typeof window.katex?.render !== 'function') throw new Error('no latex');
      window.katex.render(latex, span, {
        displayMode: Boolean(token.display),
        throwOnError: false,
        strict: 'ignore',
      });
      if (!span.childNodes.length) span.textContent = token.value;
    } catch {
      span.textContent = token.display ? `$$${token.value}$$` : `$${token.value}$`;
    }
    container.appendChild(span);
  }
}

/**
 * Safety net for vision Markdown: if a display equation is still followed by a
 * lone "(3)" paragraph (\\tag merge missed), wrap them in the formula grid so
 * the number sits on the right like the PDF.
 */
function layoutDisplayEquationNumbers(root) {
  if (!root?.querySelectorAll) return;
  const displays = Array.from(root.querySelectorAll('.katex-display'));
  for (const display of displays) {
    if (display.closest('.formula-latex')) continue;
    if (display.querySelector('.katex-tag, .tag')) continue;

    const host = display.parentElement;
    if (!host || host === root) continue;

    let sibling = host.nextElementSibling;
    while (sibling && !sibling.textContent?.trim()) {
      const empty = sibling;
      sibling = sibling.nextElementSibling;
      empty.remove();
    }
    if (!sibling || !isStandaloneEquationNumber(sibling.textContent)) continue;

    const bare = extractBareEquationNumber(sibling.textContent);
    const label = bare ? `(${bare})` : sibling.textContent.trim();
    sibling.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'formula-latex vision-display-math';
    const formulaHost = document.createElement('div');
    formulaHost.className = 'formula-display';
    const number = document.createElement('span');
    number.className = 'formula-number';
    number.textContent = label;
    host.replaceWith(wrapper);
    formulaHost.appendChild(display);
    wrapper.append(formulaHost, number);
  }
}
function escapeHtml(s) { return escapeHtmlText(s); }

function retryAllErrors() {
  let count = 0;
  for (const p of state.pages) {
    const formulaFailed = Object.values(p.formulaStates || {})
      .some((formulaState) => formulaState?.status === 'failed');
    if (p.translationOutcome === 'partial'
      || p.translationError
      || p.mdEl.classList.contains('error')
      || formulaFailed) {
      clearSmartPageRetry(p);
      p.smartRetryAttempt = 0;
      p.translateStarted = false;
      p.connectionAutoRetryGeneration = null;
      translatePage(p.num);
      count++;
    }
  }
  showToast(count ? `正在重试 ${count} 页…` : '没有失败的页');
}

// ---------------------------------------------------------------------------
// 页码跳转 + 全文导出
// ---------------------------------------------------------------------------
/**
 * 锁定新术语后重译命中页：只挑「已有译文 + 原文确实含该术语」的页，
 * 旧译文在重译期间保持可读（translatePageVision 的 glossaryRetranslate 路径）。
 * 缓存身份含术语指纹（translation-cache.js），这些页自然绕过旧缓存。
 * 返回安排重译的页数；翻译中的页跳过（完成后缓存身份已变，手动重试即生效）。
 */
function retranslateGlossaryHitPages(term) {
  const needle = String(term || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!needle || !state.pages?.length) return 0;
  const currentPage = currentNavPageNumber();
  const hits = [];
  for (const p of state.pages) {
    if (!p || p.translationActive) continue;
    const hasTranslation = p.translationOutcome === 'done' || p.translationOutcome === 'partial'
      || String(p.translationText || '').trim();
    if (!hasTranslation) continue;
    const source = String(p.agentSourceText || '').toLowerCase();
    if (!source.includes(needle)) continue;
    hits.push(p);
  }
  // 当前页优先，其余按与当前页距离排队，避免一次锁定挤占相邻页的即时翻译。
  hits.sort((a, b) => Math.abs(a.num - currentPage) - Math.abs(b.num - currentPage));
  for (const p of hits) {
    p.glossaryRetranslate = true;
    p.translateStarted = false;
    p.smartRetryAttempt = 0;
    clearSmartPageRetry(p);
  }
  if (hits.length) schedulePagePriority(currentPage - 1);
  return hits.length;
}

function currentVisiblePageNumber() {
  if (!state.pages?.length) return 1;
  const top = els.pdfColumn.getBoundingClientRect().top;
  // 每次 scroll 事件都会调用：二分读 O(log n) 个 rect，长文档不再每帧全量测量。
  const anchor = findColumnAnchorBisect(state.pages, 'pageEl', top);
  return Math.min(state.totalPages, Math.max(1, (anchor.index || 0) + 1));
}

/** Prefer toolbar nav cursor so rapid next/prev is not blocked by scroll lag. */
function currentNavPageNumber() {
  if (!state.pages?.length) return 1;
  const n = Number(state.navPageNumber) || 0;
  if (n >= 1 && n <= state.totalPages) return n;
  return currentVisiblePageNumber();
}

function updatePageJumpInput(pageNum = currentNavPageNumber()) {
  if (!els.pageJumpInput) return;
  const n = Math.min(state.totalPages || 1, Math.max(1, Number(pageNum) || 1));
  state.navPageNumber = n;
  if (document.activeElement !== els.pageJumpInput) {
    els.pageJumpInput.value = String(n);
  }
  if (els.pagePrev) els.pagePrev.disabled = n <= 1 || !state.totalPages;
  if (els.pageNext) els.pageNext.disabled = n >= state.totalPages || !state.totalPages;
  highlightActivePages(n);
  updateOutlineActive(n);
  scheduleReadingProgressSave(n);
}

// ---------------------------------------------------------------------------
// 阅读续读：节流记录最后阅读页；重开同一文档时提示一键跳回
// ---------------------------------------------------------------------------
let readingProgressTimer = 0;
function scheduleReadingProgressSave(pageNum) {
  if (!state.totalPages) return;
  clearTimeout(readingProgressTimer);
  readingProgressTimer = setTimeout(() => {
    const docKey = chatDocKey();
    if (docKey === 'unknown') return;
    recordReadingProgress({
      docKey,
      title: String(els.docTitle?.textContent || '').trim(),
      page: pageNum,
      pageCount: state.totalPages,
      sourceUrl: state.currentSourceUrl || '',
    });
  }, 1200);
}

function maybeOfferResume(savedEntry) {
  if (!shouldOfferResume(savedEntry, { pageCount: state.totalPages })) return;
  document.querySelector('.resume-banner')?.remove();
  const bar = document.createElement('div');
  bar.className = 'resume-banner';
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'resume-jump';
  jump.textContent = `继续上次阅读 · 跳到第 ${savedEntry.page} 页`;
  jump.addEventListener('click', () => {
    goToPage(savedEntry.page, { quiet: false });
    bar.remove();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'resume-close';
  close.textContent = '✕';
  close.title = '关闭';
  close.addEventListener('click', () => bar.remove());
  bar.append(jump, close);
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 15000); // 不打扰：15 秒后自动消失
}

// ---------------------------------------------------------------------------
// 首次使用引导：第一次打开文档时给 3 条上手提示，看过即不再出现
// ---------------------------------------------------------------------------
const ONBOARDING_KEY = 'paperlens.onboarding.v1';
function maybeShowOnboarding() {
  try {
    if (localStorage.getItem(ONBOARDING_KEY)) return;
  } catch { return; }
  if (document.querySelector('.onboarding-card')) return;
  const card = document.createElement('div');
  card.className = 'onboarding-card';
  card.setAttribute('role', 'note');
  card.innerHTML = `
    <div class="onboarding-title">3 步上手 PaperLens</div>
    <ol class="onboarding-list">
      <li><b>双击</b>右侧译文可定位左栏原文；左栏<b>划词</b>即时翻译。</li>
      <li>键盘流：<kbd>J</kbd>/<kbd>K</kbd> 翻页、<kbd>O</kbd> 目录、<kbd>S</kbd> 框选提问、<kbd>A</kbd> 科研助手，<kbd>?</kbd> 看全部。</li>
      <li>译法不满意？划词后点「<b>锁定术语</b>」，全文乃至之后的论文都强制统一。</li>
    </ol>
    <button type="button" class="onboarding-close">知道了</button>`;
  card.querySelector('.onboarding-close').addEventListener('click', () => {
    try { localStorage.setItem(ONBOARDING_KEY, String(Date.now())); } catch { /* 隐私模式忽略 */ }
    card.remove();
  });
  document.body.appendChild(card);
}

// ---------------------------------------------------------------------------
// 目录侧边栏：按译文标题生成（paperTools.getOutline），点击跳页
// ---------------------------------------------------------------------------
let outlinePanelEl = null;
function toggleOutlinePanel(force) {
  const open = typeof force === 'boolean' ? force : !outlinePanelEl;
  if (!open) {
    outlinePanelEl?.remove();
    outlinePanelEl = null;
    els.btnOutline?.classList.remove('is-open');
    return;
  }
  if (!outlinePanelEl) {
    const panel = document.createElement('aside');
    panel.className = 'outline-panel';
    panel.setAttribute('aria-label', '译文目录');
    const head = document.createElement('div');
    head.className = 'outline-head';
    const title = document.createElement('span');
    title.className = 'outline-title';
    title.textContent = '目录';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'outline-close';
    close.textContent = '✕';
    close.title = '关闭目录';
    close.addEventListener('click', () => toggleOutlinePanel(false));
    head.append(title, close);
    const list = document.createElement('ul');
    list.className = 'outline-list';
    panel.append(head, list);
    document.body.appendChild(panel);
    outlinePanelEl = panel;
    els.btnOutline?.classList.add('is-open');
  }
  refreshOutlinePanel({ reveal: true });
}

/** 重建目录列表；随译文进度自动增补（updateProgress 每次调用）。 */
function refreshOutlinePanel({ reveal = false } = {}) {
  if (!outlinePanelEl) return;
  const list = outlinePanelEl.querySelector('.outline-list');
  if (!list) return;
  const { items } = paperTools.getOutline();
  list.textContent = '';
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'outline-empty';
    empty.textContent = '先翻译几页，目录会随译文标题自动出现。';
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = `outline-item outline-lvl-${item.level}`;
    li.dataset.page = String(item.page);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.text;
    btn.title = `第 ${item.page} 页`;
    btn.addEventListener('click', () => goToPage(item.page, { quiet: true }));
    li.appendChild(btn);
    list.appendChild(li);
  }
  updateOutlineActive();
  if (reveal) list.querySelector('.outline-item.is-active')?.scrollIntoView({ block: 'nearest' });
}

/** 轻量高亮当前章节（滚动/翻页时调用，不重建列表）。 */
function updateOutlineActive(current = currentNavPageNumber()) {
  if (!outlinePanelEl) return;
  let active = null;
  for (const li of outlinePanelEl.querySelectorAll('.outline-item')) {
    li.classList.remove('is-active');
    if (Number(li.dataset.page) <= current) active = li;
  }
  active?.classList.add('is-active');
}

/** Scroll a column so the page top sits near the column top (stable for chaining). */
function scrollColumnToPageEl(col, pageEl) {
  if (!col || !pageEl) return;
  const colRect = col.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  // 8px padding under toolbar sticky area inside the column.
  col.scrollTop += (pageRect.top - colRect.top) - 8;
}

function goToPage(pageNum, { quiet = false, delta = false } = {}) {
  if (!state.pages?.length) return;
  // delta=true: step from the committed nav cursor (enables rapid continuous next/prev).
  const base = delta ? currentNavPageNumber() : 0;
  const target = delta ? base + Number(pageNum || 0) : Number(pageNum || 1);
  const n = Math.min(state.totalPages, Math.max(1, Math.round(target) || 1));
  const page = state.pages[n - 1];
  if (!page?.pageEl) return;

  // Commit nav page immediately so the next click uses n±1 even before paint.
  state.navPageNumber = n;
  // Ignore scroll-driven page updates while programmatic scroll settles.
  state.navScrollLockUntil = Date.now() + 350;
  suspendScrollSync(400);

  scrollColumnToPageEl(els.pdfColumn, page.pageEl);
  if (page.sectionEl) scrollColumnToPageEl(els.panelColumn, page.sectionEl);
  flashElement(page.pageEl);
  if (page.sectionEl) flashElement(page.sectionEl);

  updatePageJumpInput(n);
  highlightActivePages(n);
  void ensurePdfPage(n - 1).catch(() => {});
  schedulePagePriority(n - 1);
  if (!quiet) showToast(`已跳到第 ${n} 页`);
}

function setupPageJumpControls() {
  const jumpFromInput = () => {
    const n = Number(els.pageJumpInput?.value);
    if (!Number.isFinite(n)) return;
    goToPage(n, { quiet: true });
  };
  // Use delta steps from nav cursor — not live viewport — so continuous clicks work.
  els.pagePrev?.addEventListener('click', (event) => {
    event.preventDefault();
    goToPage(-1, { quiet: true, delta: true });
  });
  els.pageNext?.addEventListener('click', (event) => {
    event.preventDefault();
    goToPage(1, { quiet: true, delta: true });
  });
  els.pageJumpInput?.addEventListener('change', jumpFromInput);
  els.pageJumpInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpFromInput();
      els.pageJumpInput.blur();
    }
  });
  // 阅读快捷键（不在输入框、无修饰键时生效）：翻页 j/k、目录 o、助手 a、框选 s。
  window.addEventListener('keydown', (event) => {
    if (els.reader?.hidden) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'k') {
      event.preventDefault();
      chatPanel.toggleCommand?.();
      return;
    }
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === 'PageDown' || key === 'j' || key === 'J') {
      event.preventDefault();
      goToPage(1, { quiet: true, delta: true });
    } else if (key === 'PageUp' || key === 'k' || key === 'K') {
      event.preventDefault();
      goToPage(-1, { quiet: true, delta: true });
    } else if ((key === 'o' || key === 'O') && state.totalPages) {
      event.preventDefault();
      toggleOutlinePanel();
    } else if (key === 'a' || key === 'A') {
      event.preventDefault();
      chatPanel.toggle();
    } else if ((key === 's' || key === 'S') && state.totalPages) {
      event.preventDefault();
      startSnipMode();
    } else if (key === 'Escape' && outlinePanelEl) {
      event.preventDefault();
      toggleOutlinePanel(false);
    }
  });
  // Keep the page field in sync while the user scrolls the PDF column.
  els.pdfColumn?.addEventListener('scroll', () => {
    // During chained next/prev, ignore laggy viewport until lock expires.
    if (Date.now() < (state.navScrollLockUntil || 0)) return;
    if (state.scrollSyncSuspended) return;
    const visible = currentVisiblePageNumber();
    if (visible !== state.navPageNumber) {
      state.navPageNumber = visible;
      updatePageJumpInput(visible);
      highlightActivePages(visible);
    }
  }, { passive: true });
  els.panelColumn?.addEventListener('scroll', () => {
    if (Date.now() < (state.navScrollLockUntil || 0)) return;
    if (state.scrollSyncSuspended) return;
    // When reading the (often longer) translation, still highlight active page.
    if (!state.scrollLinkEnabled) {
      const visible = currentVisiblePanelPageNumber();
      if (visible) highlightActivePages(visible);
    }
  }, { passive: true });
}

/** Soft-highlight the page currently under focus in both columns. */
function highlightActivePages(pageNum) {
  const n = Math.max(1, Math.round(Number(pageNum) || 1));
  for (const page of state.pages || []) {
    const active = page.num === n;
    page.sectionEl?.classList.toggle('is-active', active);
    page.pageEl?.classList.toggle('is-active', active);
  }
}

/** Visible page in the translation column (for unlinked scroll). */
function currentVisiblePanelPageNumber() {
  if (!els.panelColumn || !state.pages?.length) return 0;
  const top = els.panelColumn.getBoundingClientRect().top;
  const rects = state.pages.map((p) => p.sectionEl?.getBoundingClientRect?.()).filter(Boolean);
  if (!rects.length) return 0;
  let best = 1;
  let bestDist = Infinity;
  rects.forEach((rect, i) => {
    const dist = Math.abs(rect.top - top - 48);
    if (dist < bestDist) {
      bestDist = dist;
      best = state.pages[i]?.num || (i + 1);
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// 阅读快捷键帮助
// ---------------------------------------------------------------------------
function setShortcutsOpen(open) {
  if (!els.shortcutsDialog) return;
  els.shortcutsDialog.hidden = !open;
  if (open) {
    els.shortcutsClose?.focus?.();
  }
}

function setupShortcutsHelp() {
  els.btnShortcuts?.addEventListener('click', () => setShortcutsOpen(true));
  els.shortcutsClose?.addEventListener('click', () => setShortcutsOpen(false));
  els.shortcutsDialog?.addEventListener('click', (event) => {
    if (event.target === els.shortcutsDialog) setShortcutsOpen(false);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.shortcutsDialog && !els.shortcutsDialog.hidden) {
      event.preventDefault();
      setShortcutsOpen(false);
      return;
    }
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      if (els.reader?.hidden) return;
      event.preventDefault();
      setShortcutsOpen(!(els.shortcutsDialog && !els.shortcutsDialog.hidden));
    }
  });
}

/** Prefer the live rendered translation DOM (KaTeX already applied). */
function pageExportRenderedHtml(page) {
  const el = page?.mdEl;
  if (!el) return '';
  if (el.classList.contains('page-placeholder')) return '';
  if (el.classList.contains('error') && !String(page.translationText || '').trim()) return '';
  const raw = String(el.innerHTML || '').trim();
  if (!raw) return '';
  // Skip pure skeleton / spinner shells with no real content.
  if (!el.classList.contains('done') && !el.classList.contains('md') && !String(page.translationText || '').trim()) {
    return '';
  }
  return sanitizeExportHtml(raw);
}

function collectDocumentExportPages() {
  return state.pages.map((p) => ({
    num: p.num,
    html: pageExportRenderedHtml(p),
    translationText: p.translationText || '',
    domText: p.mdEl?.innerText || '',
    outcome: p.translationOutcome || '',
    error: p.translationError || '',
  }));
}

// 手机论文包：PDF 原文件 + 已译页 Markdown 单文件（app/ 手机版直接打开，
// 已译页零成本显示）。PDF 字节用 pdf.getData() 取回，不常驻内存副本。
// 返回 { json, filename, pageCount }；不可导出时 toast 并返回 null。
async function buildPaperPackForExport() {
  if (!state.pdf || !state.pages?.length) {
    showToast('请先打开 PDF', true);
    return null;
  }
  const pages = state.pages
    .map((p) => ({ page: p.num, markdown: String(p.translationText || '').trim() }))
    .filter((p) => p.markdown);
  if (!pages.length) {
    showToast('还没有已完成的译文页（可先等几页完成）', true);
    return null;
  }
  let pdfBytes;
  try {
    pdfBytes = await state.pdf.getData();
  } catch (e) {
    showToast('无法读取 PDF 原始数据：' + (e?.message || e), true);
    return null;
  }
  const { buildPaperPack, paperPackFilename } = await import('../lib/paper-pack.js');
  // 术语表随包携带：手机端翻译未译页时按同一术语表，保证双端译法一致。
  let glossary = [];
  try {
    const { loadGlossary } = await import('../lib/glossary.js');
    glossary = await loadGlossary();
  } catch { /* 无术语表照常导出 */ }
  const title = els.docTitle?.textContent || 'paper';
  const json = buildPaperPack({
    title,
    targetLang: state.config?.targetLang || '简体中文',
    totalPages: state.totalPages,
    pages,
    pdfBytes,
    glossary,
  });
  return { json, filename: paperPackFilename(title), pageCount: pages.length };
}

async function exportPaperPack() {
  try {
    const pack = await buildPaperPackForExport();
    if (!pack) return;
    const blob = new Blob([pack.json], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = pack.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    showToast(`已导出论文包（${pack.pageCount} 页译文 + 原 PDF）。手机版「选择 PDF / 论文包」直接打开即可续读，已译页不再花钱。`);
  } catch (e) {
    showToast(String(e?.message || e || '论文包导出失败'), true);
  }
}

// 一键传手机：论文包直写用户选定的云同步文件夹（iCloud/OneDrive…），
// 云盘自动同步到手机“文件”App。未配置/权限失效时引导选择文件夹后自动重写。
async function sendPaperPackToPhone() {
  try {
    const { phoneDropSupported, pickPhoneDropFolder, writePaperPackToPhoneFolder } = await import('../lib/phone-drop.js');
    if (!phoneDropSupported()) {
      showToast('当前浏览器不支持文件夹直写，已改为普通下载', true);
      await exportPaperPack();
      return;
    }
    const pack = await buildPaperPackForExport();
    if (!pack) return;
    const write = () => writePaperPackToPhoneFolder(pack.filename, pack.json);
    let result;
    try {
      result = await write();
    } catch (error) {
      if (!error?.needsSetup) throw error;
      showToast('请选择手机能收到的云同步文件夹（如 iCloud Drive / OneDrive 内的子文件夹）');
      await pickPhoneDropFolder();
      result = await write();
    }
    showToast(`已写入「${result.folder}」（${pack.pageCount} 页译文）。云盘同步后，手机“文件”App → 该文件夹 → 用 PaperLens 打开。`);
  } catch (e) {
    if (e?.name === 'AbortError') return; // 用户取消选择文件夹
    showToast(String(e?.message || e || '传输失败'), true);
  }
}

// 导出菜单：打印 PDF（原有）/ 手机论文包。轻量浮层，外点或 Esc 关闭。
let exportMenuEl = null;
function toggleExportMenu() {
  if (exportMenuEl) { closeExportMenu(); return; }
  const anchor = els.btnExportDoc;
  if (!anchor) return;
  const menu = document.createElement('div');
  menu.className = 'export-menu';
  menu.setAttribute('role', 'menu');
  const mkItem = (label, hint, onPick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<b>${label}</b><small>${hint}</small>`;
    btn.addEventListener('click', () => { closeExportMenu(); onPick(); });
    return btn;
  };
  const phoneItem = mkItem('一键传手机', '首次使用会让你选择 iCloud / OneDrive 等同步文件夹', () => { void sendPaperPackToPhone(); });
  menu.append(
    mkItem('打印 / 另存为 PDF', '带公式渲染的全文译文打印预览', () => { void exportDocumentTranslation(); }),
    phoneItem,
    mkItem('手机论文包（.json 下载）', '原 PDF + 已译页；手机版打开即续读，不再花钱', () => { void exportPaperPack(); }),
  );
  // 已配置目标文件夹时，把提示换成具体文件夹名（异步，不阻塞菜单弹出）。
  void import('../lib/phone-drop.js').then(async ({ getPhoneDropFolderName, phoneDropHint }) => {
    const name = await getPhoneDropFolderName();
    const small = phoneItem.querySelector('small');
    if (small && exportMenuEl === menu) small.textContent = phoneDropHint(name);
  }).catch(() => { /* 提示文案维持默认 */ });
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  menu.style.right = `${Math.round(Math.max(8, window.innerWidth - rect.right))}px`;
  document.body.appendChild(menu);
  exportMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('pointerdown', onExportMenuOutside, true);
    document.addEventListener('keydown', onExportMenuKey, true);
  }, 0);
}
function onExportMenuOutside(event) {
  if (exportMenuEl && !exportMenuEl.contains(event.target) && event.target !== els.btnExportDoc) closeExportMenu();
}
function onExportMenuKey(event) {
  if (event.key === 'Escape') closeExportMenu();
}
function closeExportMenu() {
  document.removeEventListener('pointerdown', onExportMenuOutside, true);
  document.removeEventListener('keydown', onExportMenuKey, true);
  exportMenuEl?.remove();
  exportMenuEl = null;
}

async function exportDocumentTranslation() {
  if (!state.pages?.length) {
    showToast('请先打开 PDF', true);
    return;
  }
  const pages = collectDocumentExportPages();
  const exportedPageCount = pages.filter((p) => (
    String(p.html || p.translationText || p.domText || '').trim()
  )).length;
  if (!exportedPageCount) {
    showToast('还没有可导出的译文（可先等几页完成）', true);
    return;
  }
  const renderedCount = pages.filter((p) => String(p.html || '').trim()).length;
  const title = els.docTitle?.textContent || 'paper';
  const assets = await loadPrintAssets();
  const html = buildPrintDocumentHtml({
    title: `${title} · 译文`,
    subtitle: `${exportedPageCount} 页有内容${renderedCount ? ` · ${renderedCount} 页含公式渲染` : ''} · ${new Date().toLocaleString('zh-CN')}`,
    sections: buildDocumentPrintSections(pages),
    assets,
    footerNote: '由 PaperLens 导出 · 在打印对话框中选择「另存为 PDF」',
    printDelayMs: 520,
  });
  const result = openPrintHtmlWindow(html);
  if (!result.ok) {
    showToast(result.reason || '无法打开打印窗口', true);
    return;
  }
  showToast(`已打开 ${exportedPageCount} 页译文打印预览（含公式），可另存为 PDF`);
}

// ---------------------------------------------------------------------------
// 滚动联动
// ---------------------------------------------------------------------------
// 联动策略：任一栏被用户滚动时，按「当前可视首个页/段 + 页内比例」把对侧滚到
// 对应阅读位置。防死循环不再依赖鼠标悬停（activeCol 对键盘/触控板/程序化滚动
// 不可靠），改用时间窗回声闸门：驱动对侧前先 suppress(对侧)，对侧因此被程序化
// 滚动产生的 scroll 回声在窗口内被忽略，不会反向再驱动本栏。窗口自动过期。
//
// 译文通常比 PDF 长：用户可关掉联动（工具栏「独立滚动」）或按住 Alt 临时解除，
// 这样滚译文时原文会停在当前页，读完后再点一次恢复同步。
function isScrollLinkActive() {
  return !!state.scrollLinkEnabled && !state.scrollLinkHoldOff && !state.scrollSyncSuspended;
}

function setupScrollSync() {
  const signal = state.documentUiController.signal;
  state.scrollSyncGuard = createScrollSyncGuard({ windowMs: 160 });
  els.pdfColumn.addEventListener('scroll', () => {
    if (!isScrollLinkActive() || state.scrollSyncSuspended || state.scrollSyncGuard.isSuppressed('pdf')) return;
    state.lastScrollSource = 'pdf';
    syncColumns('pdf');
  }, { signal });
  els.panelColumn.addEventListener('scroll', () => {
    if (!isScrollLinkActive() || state.scrollSyncSuspended || state.scrollSyncGuard.isSuppressed('panel')) return;
    state.lastScrollSource = 'panel';
    syncColumns('panel');
  }, { signal });
  setupScrollLayoutRealign(signal);
}

/**
 * After window / divider / chat / zoom / translation-height changes, page boxes
 * move but scrollTop stays absolute — left/right drift. Re-pair from a stable
 * driver (PDF page geometry is the ruler; panel reflows with width).
 */
function setupScrollLayoutRealign(signal) {
  const onLayout = () => scheduleScrollRealign('layout');
  window.addEventListener('resize', onLayout, { signal, passive: true });
  if (typeof ResizeObserver === 'function') {
    state.scrollLayoutObserver?.disconnect();
    const ro = new ResizeObserver(() => scheduleScrollRealign('layout'));
    state.scrollLayoutObserver = ro;
    if (els.pdfColumn) ro.observe(els.pdfColumn);
    if (els.panelColumn) ro.observe(els.panelColumn);
    if (els.pdfPages) ro.observe(els.pdfPages);
    if (els.panelPages) ro.observe(els.panelPages);
    signal?.addEventListener?.('abort', () => {
      ro.disconnect();
      if (state.scrollLayoutObserver === ro) state.scrollLayoutObserver = null;
    }, { once: true });
  }
}

/** Debounced re-pair after geometry reflow (not every scroll tick). */
function scheduleScrollRealign(reason = 'layout') {
  if (!state.scrollLinkEnabled || state.scrollLinkHoldOff) return;
  if (!state.pages?.length || !els.pdfColumn || !els.panelColumn) return;
  clearTimeout(state.scrollRealignTimer);
  const delay = reason === 'layout' ? 64 : 0;
  state.scrollRealignTimer = setTimeout(() => {
    state.scrollRealignTimer = null;
    if (state.scrollRealignFrame) cancelAnimationFrame(state.scrollRealignFrame);
    // Double rAF: wait for CSS / font reflow after width changes.
    state.scrollRealignFrame = requestAnimationFrame(() => {
      state.scrollRealignFrame = requestAnimationFrame(() => {
        state.scrollRealignFrame = 0;
        if (!isScrollLinkActive()) return;
        // PDF page heights only change on zoom; panel text reflows with width.
        // Prefer PDF as the reading ruler after layout so "page N" stays paired.
        const driver = reason === 'content' && state.lastScrollSource === 'panel'
          ? 'panel'
          : 'pdf';
        forceSyncColumns(driver, { fromLayout: true });
      });
    });
  }, delay);
}

// 把 source 栏的阅读锚点映射到 target 栏并对齐。用 rAF 合并高频 scroll 事件，
// 并在实际改动对侧 scrollTop 前后压制对侧的回声，避免抖动。
function syncColumns(source) {
  if (!isScrollLinkActive()) return;
  if (state.scrollSyncFrame) return;
  state.scrollSyncFrame = requestAnimationFrame(() => {
    state.scrollSyncFrame = 0;
    forceSyncColumns(source);
  });
}

/**
 * 与 findColumnAnchor 语义一致（首个 bottom > top+1 的元素 + 页内比例），但利用
 * 页/段在栏内竖直有序的事实做二分，每帧只读 O(log n) 个 rect。长文档滚动联动
 * 从每帧 n 次强制布局读取降为 ~log2(n) 次。
 */
function findColumnAnchorBisect(pages, key, viewportTop) {
  const top = Number(viewportTop) || 0;
  let lo = 0;
  let hi = pages.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = pages[mid]?.[key]?.getBoundingClientRect?.();
    if (rect && rect.bottom > top + 1) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) return { index: Math.max(0, pages.length - 1), ratio: 0 };
  const rect = pages[found][key].getBoundingClientRect();
  const height = Math.max(1, Number.isFinite(rect.height) ? rect.height : rect.bottom - rect.top);
  const ratio = Math.min(1, Math.max(0, (top - rect.top) / height));
  return { index: found, ratio };
}

/** Immediate page-ratio alignment (no rAF coalesce). Used by scroll + layout realign. */
function forceSyncColumns(source, { fromLayout = false } = {}) {
  if (!isScrollLinkActive()) return;
  const side = source === 'panel' ? 'panel' : 'pdf';
  const fromCol = side === 'pdf' ? els.pdfColumn : els.panelColumn;
  const toCol = side === 'pdf' ? els.panelColumn : els.pdfColumn;
  const other = side === 'pdf' ? 'panel' : 'pdf';
  if (!fromCol || !toCol || !state.pages?.length) return;
  // Skip if either column is mid-teardown (no layout box yet).
  if (fromCol.clientHeight < 8 || toCol.clientHeight < 8) return;
  const fromTop = fromCol.getBoundingClientRect().top;
  const fromKey = side === 'pdf' ? 'pageEl' : 'sectionEl';
  const toKey = side === 'pdf' ? 'sectionEl' : 'pageEl';
  const anchor = findColumnAnchorBisect(state.pages, fromKey, fromTop);
  const targetEl = state.pages[anchor.index]?.[toKey];
  if (!targetEl) return;
  const toTop = toCol.getBoundingClientRect().top;
  const delta = anchorScrollDelta(targetEl.getBoundingClientRect(), anchor, toTop);
  if (Math.abs(delta) < 1) return; // 已对齐，避免无意义写入引发回声
  // 压制对侧回声窗口：本次程序化滚动产生的 scroll 事件不再反向驱动本栏。
  state.scrollSyncGuard?.suppress(other, fromLayout ? 220 : undefined);
  // Layout realign also suppresses the driver briefly so ResizeObserver echo
  // from scrollTop / content shift does not fight the just-applied pairing.
  if (fromLayout) state.scrollSyncGuard?.suppress(side, 220);
  toCol.scrollTop += delta;
}

function suspendScrollSync(duration = 800) {
  state.scrollSyncSuspended = true;
  clearTimeout(state.scrollSyncTimer);
  state.scrollSyncTimer = setTimeout(() => {
    state.scrollSyncSuspended = false;
    state.scrollSyncTimer = null;
  }, duration);
}

function updateScrollLinkUi() {
  const btn = els.btnScrollLink;
  if (!btn) return;
  const linked = !!state.scrollLinkEnabled;
  const holdOff = !!state.scrollLinkHoldOff;
  btn.classList.toggle('is-linked', linked && !holdOff);
  btn.classList.toggle('is-unlinked', !linked || holdOff);
  btn.setAttribute('aria-pressed', String(linked));
  const label = btn.querySelector('.scroll-link-label');
  if (label) {
    if (holdOff && linked) label.textContent = '临时';
    else label.textContent = linked ? '联动' : '独立';
  }
  if (holdOff && linked) {
    btn.title = '按住 Alt：临时解除联动，松手恢复。';
  } else if (linked) {
    btn.title = '联动中：左右一起滚。点此改为独立；Alt 临时解除。Ctrl+Shift+L 切换。';
  } else {
    btn.title = '独立滚动：滚译文时原文停住。再点恢复联动。';
  }
  document.body.classList.toggle('scroll-unlinked', !linked);
  document.body.classList.toggle('scroll-hold-unlink', holdOff && linked);
}

function readScrollLinkPreference() {
  try {
    const raw = globalThis.localStorage?.getItem(SCROLL_LINK_STORAGE_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch { /* noop */ }
  return true;
}

function writeScrollLinkPreference(enabled) {
  try {
    globalThis.localStorage?.setItem(SCROLL_LINK_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* noop */ }
}

function setScrollLinkEnabled(enabled, { quiet = false } = {}) {
  const next = !!enabled;
  const changed = next !== !!state.scrollLinkEnabled;
  state.scrollLinkEnabled = next;
  writeScrollLinkPreference(next);
  updateScrollLinkUi();
  if (next) {
    // 恢复联动时按最近滚动的一侧对齐对侧，避免跳到错误页。
    const driver = state.lastScrollSource === 'pdf' || state.lastScrollSource === 'panel'
      ? state.lastScrollSource
      : 'pdf';
    requestAnimationFrame(() => {
      if (!state.scrollLinkEnabled || state.scrollLinkHoldOff) return;
      const wasSuspended = state.scrollSyncSuspended;
      state.scrollSyncSuspended = false;
      forceSyncColumns(driver, { fromLayout: true });
      state.scrollSyncSuspended = wasSuspended;
    });
  }
  if (!quiet && changed) {
    showToast(next ? '已恢复联动' : '已独立滚动（原文可停住）');
  }
}

function setScrollLinkHoldOff(holdOff) {
  const next = !!holdOff;
  if (next === !!state.scrollLinkHoldOff) return;
  state.scrollLinkHoldOff = next;
  updateScrollLinkUi();
}

function setupScrollLinkControls() {
  // 恢复用户偏好（默认联动开）。
  state.scrollLinkEnabled = readScrollLinkPreference();
  updateScrollLinkUi();
  els.btnScrollLink?.addEventListener('click', () => {
    setScrollLinkEnabled(!state.scrollLinkEnabled);
  });
  // Alt 按住 = 临时独立滚动（松手恢复），便于译文中途短暂停住原文。
  // Ctrl+Shift+L = 切换联动（与工具栏按钮相同）。
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Alt' && !event.repeat) {
      if (els.reader?.hidden) return;
      setScrollLinkHoldOff(true);
      return;
    }
    if ((event.key === 'l' || event.key === 'L')
      && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      if (els.reader?.hidden) return;
      event.preventDefault();
      setScrollLinkEnabled(!state.scrollLinkEnabled);
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Alt') return;
    setScrollLinkHoldOff(false);
  });
  window.addEventListener('blur', () => setScrollLinkHoldOff(false));
}

// ---------------------------------------------------------------------------
// 双向定位联动：双击文字后，另一栏滚到对应文本节点并高亮。
// 文本节点有独立 bbox 时优先精确匹配；旧会话无节点 bbox 时回退到块级。
// ---------------------------------------------------------------------------
function setupSelectionLink() {
  document.addEventListener('dblclick', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const pageDiv = target?.closest?.('.pdf-page');
    if (!pageDiv) return;
    const pageRect = pageDiv.getBoundingClientRect();
    const displayPoint = {
      x: pageRect.width ? (event.clientX - pageRect.left) / pageRect.width : NaN,
      y: pageRect.height ? (event.clientY - pageRect.top) / pageRect.height : NaN,
    };
    // 延后一拍，确保双击选词的浏览器选区已经生成。
    setTimeout(() => handleSelectionLink({ pageDiv, displayPoint }), 0);
  }, { signal: state.documentUiController.signal });
}

function selectionPointOnPage(selection, pageDiv) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorElement = ancestor?.nodeType === 1 ? ancestor : ancestor?.parentElement;
  if (!ancestorElement || !pageDiv.contains(ancestorElement)) return null;
  const rangeRect = range.getBoundingClientRect();
  const pageRect = pageDiv.getBoundingClientRect();
  if (!rangeRect.width || !rangeRect.height || !pageRect.width || !pageRect.height) return null;
  return {
    x: (rangeRect.left + rangeRect.width / 2 - pageRect.left) / pageRect.width,
    y: (rangeRect.top + rangeRect.height / 2 - pageRect.top) / pageRect.height,
  };
}

function handleSelectionLink({ pageDiv, displayPoint } = {}) {
  if (!pageDiv?.classList?.contains('pdf-page')) return;
  const num = Number(pageDiv.dataset.page);
  const p = state.pages[num - 1];
  if (!p) return;
  const sel = window.getSelection();
  const selectedPoint = selectionPointOnPage(sel, pageDiv);
  const selectionIsCurrent = selectedPoint
    && Number.isFinite(displayPoint?.x) && Number.isFinite(displayPoint?.y)
    && Math.hypot(selectedPoint.x - displayPoint.x, selectedPoint.y - displayPoint.y) <= 0.08;
  const point = displayPointToIr(
    selectionIsCurrent ? selectedPoint : displayPoint,
    p.pageObj?.rotate || 0,
  );
  if (!point) return;

  // 左栏 -> 右栏：先命中精确 text/formula fragment，再回退到二维块几何。
  const targets = new Map();
  for (const [id, target] of p.nodeEls || []) targets.set(id, target);
  for (const [id, entry] of p.structuredInlineFormulaHosts || []) targets.set(id, entry.host);
  for (const [id, entry] of p.structuredFormulaHosts || []) {
    targets.set(id, entry.target || entry.host);
  }
  const preciseId = chooseClosestReadingTarget(
    [...targets.keys()].map((id) => readingGeometry(p, id)),
    point,
    { maxDistance: 0.035 },
  );
  let targetBlk = preciseId ? targets.get(preciseId) : null;

  if (!targetBlk && Array.isArray(p.blkMeta) && Array.isArray(p.blkEls)) {
    const blockId = chooseClosestReadingTarget(
      p.blkMeta.map((meta, index) => ({ id: String(index), bbox: meta?.bbox })),
      point,
      { maxDistance: 0.055 },
    );
    if (blockId != null) targetBlk = p.blkEls[Number(blockId)];
  }
  if (targetBlk) {
    linkToBlock('panel', els.panelColumn, targetBlk);
    return;
  }
  // Vision (and any page without IR geometry): whole-page correspondence.
  flashElement(pageDiv);
  linkTo('panel', els.panelColumn, p.sectionEl || p.mdEl);
}

// ---------------------------------------------------------------------------
// 划词即时翻译浮层：左栏 PDF textLayer 上拖选文字（mouseup 且选区非空）→
// 在选区附近弹出小气泡，先显示原文片段 + 「翻译中…」，流式就地更新译文。
// 与双击定位互不干扰：双击/三击选词的 mouseup 带 event.detail>1，直接跳过，
// 交给 setupSelectionLink 的 dblclick 定位；浮层只响应拖选（detail===1）。
// ---------------------------------------------------------------------------
const SELECTION_POPOVER_SCROLL_CLOSE_PX = 48; // 左栏滚动超过该阈值即关闭浮层

const selectionPopover = {
  el: null,
  sourceEl: null,
  resultEl: null,
  askBtn: null,          // 「问 AI」按钮
  selectionText: '',     // 当前选区文本（供「问 AI」引用）
  selectionContext: '',  // 选区两侧语境（供「问 AI」引用）
  requestId: null,       // 进行中的划词请求（关闭/新选择时 cancel）
  openController: null,  // 本次打开期间的关闭监听（Esc / 点外部 / 滚动）
  anchorScrollTop: 0,
};
let selectionTranslateController = null; // 划词 mouseup 监听；关闭配置时移除

// config.selectionTranslate=false 时完全不监听划词事件（配置热更新即时生效）。
// 右栏「选中问 AI」始终随 chatAssistant 开关（见 syncPanelAskAiListener）。
function syncSelectionTranslateListener(enabled) {
  if (enabled) {
    if (selectionTranslateController) return;
    selectionTranslateController = new AbortController();
    els.pdfColumn.addEventListener('mouseup', handleSelectionTranslateGesture, {
      signal: selectionTranslateController.signal,
    });
    return;
  }
  selectionTranslateController?.abort();
  selectionTranslateController = null;
  closeSelectionPopover();
}

// 右栏译文选中 → 轻量「问 AI」浮层（不翻译，只提问）。
let panelAskAiController = null;
const panelAskMenu = {
  el: null,
  selectionText: '',
  selectionContext: '',
  openController: null,
};

function syncPanelAskAiListener(enabled) {
  if (enabled) {
    if (panelAskAiController) return;
    panelAskAiController = new AbortController();
    els.panelColumn.addEventListener('mouseup', handlePanelAskAiGesture, {
      signal: panelAskAiController.signal,
    });
    return;
  }
  panelAskAiController?.abort();
  panelAskAiController = null;
  closePanelAskMenu();
}

function handlePanelAskAiGesture(event) {
  if (event.detail > 1 || event.button !== 0) return;
  // 聊天面板自己的选区由 chat-panel 处理。
  if (event.target?.closest?.('#chat-panel, .chat-selection-menu')) return;
  setTimeout(() => maybeShowPanelAskAi(), 0);
}

function maybeShowPanelAskAi() {
  if (state.config?.chatAssistant === false) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorEl = ancestor?.nodeType === 1 ? ancestor : ancestor?.parentElement;
  if (!ancestorEl || !els.panelColumn.contains(ancestorEl)) return;
  // 避免在按钮/页眉上误触发。
  if (ancestorEl.closest?.('button, .page-actions, .panel-page-sep, a')) return;
  const text = normalizeSelectionText(sel.toString());
  if (!isTranslatableSelectionText(text) && text.length < 2) return;
  if (!/[\p{L}\p{N}]/u.test(text)) return;
  if (text.length > 1500) return;

  const pageSection = ancestorEl.closest?.('.panel-page, .md');
  const full = normalizeSelectionText(pageSection?.innerText || pageSection?.textContent || '');
  const context = full && full !== text ? full.slice(0, 1500) : '';
  const anchorRect = range.getBoundingClientRect();
  if (!anchorRect.width && !anchorRect.height) return;
  openPanelAskMenu({ text, context, anchorRect });
}

function ensurePanelAskMenu() {
  if (panelAskMenu.el) return panelAskMenu.el;
  const el = document.createElement('div');
  el.className = 'panel-ask-menu';
  el.hidden = true;
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', '对译文选中内容提问');
  const mk = (label, title, intent, autoSend) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-ask-action';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      chatPanel.askAi(panelAskMenu.selectionText, {
        context: panelAskMenu.selectionContext || '',
        intent,
        autoSend,
      });
      closePanelAskMenu();
    });
    return btn;
  };
  el.append(
    mk('解释', '请 AI 解释选中译文', 'explain', true),
    mk('白话', '用通俗白话解释', 'plain', true),
    mk('我来提问', '挂上引用后自己写问题', 'custom', false),
  );
  document.body.appendChild(el);
  panelAskMenu.el = el;
  return el;
}

function openPanelAskMenu({ text, context = '', anchorRect }) {
  const el = ensurePanelAskMenu();
  panelAskMenu.selectionText = text;
  panelAskMenu.selectionContext = context;
  el.hidden = false;
  el.style.visibility = 'hidden';
  el.style.left = '0px';
  el.style.top = '0px';
  const width = el.offsetWidth || 200;
  const height = el.offsetHeight || 36;
  const pad = 8;
  let left = anchorRect.left + anchorRect.width / 2 - width / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
  let top = anchorRect.top - height - 8;
  if (top < pad) top = anchorRect.bottom + 8;
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(pad, top)}px`;
  el.style.visibility = '';

  panelAskMenu.openController?.abort();
  const controller = new AbortController();
  panelAskMenu.openController = controller;
  document.addEventListener('mousedown', (event) => {
    if (el.contains(event.target)) return;
    closePanelAskMenu();
  }, { signal: controller.signal, capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanelAskMenu();
  }, { signal: controller.signal });
  els.panelColumn.addEventListener('scroll', () => closePanelAskMenu(), {
    signal: controller.signal,
    passive: true,
  });
}

function closePanelAskMenu() {
  panelAskMenu.openController?.abort();
  panelAskMenu.openController = null;
  if (panelAskMenu.el) panelAskMenu.el.hidden = true;
}

function handleSelectionTranslateGesture(event) {
  // detail>1 是双击/三击选词（双向定位手势），不触发划词浮层；仅左键拖选。
  if (event.detail > 1 || event.button !== 0) return;
  // 浮层内部选中复制译文时不再发起新的划词请求。
  if (selectionPopover.el && !selectionPopover.el.hidden
    && selectionPopover.el.contains(event.target)) return;
  // 与双击定位相同：延后一拍，等浏览器选区先生成。
  setTimeout(() => maybeShowSelectionTranslate(), 0);
}

function selectionSpanIndex(spans, node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const span = element?.closest?.('span');
  return span ? spans.indexOf(span) : -1;
}

function maybeShowSelectionTranslate() {
  if (state.config?.selectionTranslate === false) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorEl = ancestor?.nodeType === 1 ? ancestor : ancestor?.parentElement;
  const pageDiv = ancestorEl?.closest?.('.pdf-page');
  if (!pageDiv) return; // 选区必须完整落在一个 PDF 页内（跨页选择不弹）
  const textLayer = pageDiv.querySelector('.textLayer');
  if (!textLayer || !textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) return;

  const text = normalizeSelectionText(sel.toString());
  if (!isTranslatableSelectionText(text)) return;

  // 上下文：选中文本两侧的相邻 textLayer 行，避免短片段无语境的翻译质量问题。
  const spans = Array.from(textLayer.querySelectorAll('span'));
  const { before, after } = collectSelectionContext(
    spans.map((span) => span.textContent),
    selectionSpanIndex(spans, range.startContainer),
    selectionSpanIndex(spans, range.endContainer),
  );
  const requestText = buildSelectionTranslationRequestText({ selection: text, before, after });
  if (!requestText) return;

  const anchorRect = range.getBoundingClientRect();
  if (!anchorRect.width && !anchorRect.height) return;
  // context 供「问 AI」引用（选区两侧语境）；划词翻译本身仍用 requestText。
  const context = [before, after].filter(Boolean).join(' ');
  openSelectionPopover({ text, requestText, anchorRect, context });
}

function ensureSelectionPopover() {
  if (selectionPopover.el) return selectionPopover.el;
  const el = document.createElement('div');
  el.className = 'selection-popover';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '划词翻译');
  const source = document.createElement('div');
  source.className = 'selection-popover-source';
  const result = document.createElement('div');
  result.className = 'selection-popover-result';
  result.setAttribute('aria-live', 'polite');
  // 「问 AI」入口：一键解释，或挂引用后自己写问题（复用划词已收集的上下文）。
  const actions = document.createElement('div');
  actions.className = 'selection-popover-actions';
  const askBtn = document.createElement('button');
  askBtn.type = 'button';
  askBtn.className = 'selection-ask-ai';
  askBtn.textContent = '问 AI';
  askBtn.title = '请 AI 解释这段内容';
  askBtn.addEventListener('click', () => {
    const selected = selectionPopover.selectionText || '';
    chatPanel.askAi(selected, {
      context: selectionPopover.selectionContext || '',
      intent: 'explain',
      autoSend: true,
    });
    closeSelectionPopover();
  });
  const askCustomBtn = document.createElement('button');
  askCustomBtn.type = 'button';
  askCustomBtn.className = 'selection-ask-ai selection-ask-ai-secondary';
  askCustomBtn.textContent = '我来提问';
  askCustomBtn.title = '把选中内容挂到 AI 助手，自己写问题';
  askCustomBtn.addEventListener('click', () => {
    const selected = selectionPopover.selectionText || '';
    chatPanel.askAi(selected, {
      context: selectionPopover.selectionContext || '',
      intent: 'custom',
      autoSend: false,
    });
    closeSelectionPopover();
  });
  // 「锁定术语」：把 选中原文 → 当前译文 收入全局术语表，之后的整页/划词翻译都强制用该译法。
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'selection-ask-ai selection-ask-ai-secondary selection-lock-term';
  lockBtn.textContent = '锁定术语';
  lockBtn.title = '把「选中原文 → 当前译文」存入术语表，保证后续翻译一致（设置页可管理）';
  lockBtn.addEventListener('click', async () => {
    const term = String(selectionPopover.selectionText || '').replace(/\s+/g, ' ').trim();
    const translation = String(selectionPopover.resultEl?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!term || term.length > 80) { showToast('请选中较短的术语（80 字以内）再锁定', true); return; }
    if (!translation || /翻译中|思考中|（模型未返回译文）/.test(translation)
      || selectionPopover.resultEl.className.includes('error')
      || selectionPopover.resultEl.className.includes('pending')) {
      showToast('等译文出来后再锁定', true);
      return;
    }
    try {
      const { upsertGlossaryTerm } = await import('../lib/glossary.js');
      await upsertGlossaryTerm({ term, translation: translation.slice(0, 80) });
      const refreshed = retranslateGlossaryHitPages(term);
      showToast(refreshed > 0
        ? `已锁定术语：${term.slice(0, 24)} → ${translation.slice(0, 24)}；正在按新译法重译 ${refreshed} 个已译页`
        : `已锁定术语：${term.slice(0, 24)} → ${translation.slice(0, 24)}`);
    } catch (error) {
      showToast(String(error?.message || error || '锁定失败'), true);
    }
  });
  actions.append(askBtn, askCustomBtn, lockBtn);
  el.append(source, result, actions);
  document.body.appendChild(el);
  selectionPopover.el = el;
  selectionPopover.sourceEl = source;
  selectionPopover.resultEl = result;
  selectionPopover.askBtn = askBtn;
  selectionPopover.askCustomBtn = askCustomBtn;
  return el;
}

function openSelectionPopover({ text, requestText, anchorRect, context = '' }) {
  cancelSelectionTranslateRequest(); // 再次选择新文本：先取消旧请求再开新请求
  const el = ensureSelectionPopover();
  selectionPopover.selectionText = text;      // 供「问 AI」引用
  selectionPopover.selectionContext = context;
  selectionPopover.sourceEl.textContent = text;
  selectionPopover.resultEl.textContent = '翻译中…';
  selectionPopover.resultEl.className = 'selection-popover-result pending';
  el.hidden = false;
  positionSelectionPopover(anchorRect);
  bindSelectionPopoverDismiss();

  let out = '';
  let handle = null;
  try {
    handle = client.translateSelection(requestText, (delta) => {
      if (!handle || selectionPopover.requestId !== handle.id) return;
      out += String(delta || '');
      if (out.trim()) {
        selectionPopover.resultEl.className = 'selection-popover-result';
        selectionPopover.resultEl.textContent = out;
      }
    }, (phase) => {
      if (!handle || selectionPopover.requestId !== handle.id || out) return;
      if (phase === 'thinking') selectionPopover.resultEl.textContent = '思考中…';
    });
  } catch (error) {
    // 扩展刚重载等场景：Port 无法连接时在浮层内给出可读错误，不产生未捕获异常。
    selectionPopover.resultEl.className = 'selection-popover-result error';
    selectionPopover.resultEl.textContent = friendlyReaderError(error?.message || String(error));
    return;
  }
  const { id, promise } = handle;
  selectionPopover.requestId = id;
  promise.then(({ full }) => {
    if (selectionPopover.requestId !== id) return;
    selectionPopover.requestId = null;
    const finalText = String(full || out || '').trim();
    selectionPopover.resultEl.className = 'selection-popover-result';
    selectionPopover.resultEl.textContent = finalText || '（模型未返回译文）';
  }).catch((error) => {
    if (selectionPopover.requestId !== id) return;
    selectionPopover.requestId = null;
    if (error?.cancelled) return; // 浮层关闭时主动取消，不需要报错
    selectionPopover.resultEl.className = 'selection-popover-result error';
    selectionPopover.resultEl.textContent = friendlyReaderError(error?.message || String(error));
  });
}

// 优先显示在选区上方（bottom 锚定，流式增高向上生长，不遮挡选区）；
// 上方空间不足时显示在下方。max-height 由 CSS 限制，超长译文内部滚动。
function positionSelectionPopover(anchorRect) {
  const el = selectionPopover.el;
  el.style.visibility = 'hidden';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.bottom = 'auto';
  const placement = chooseSelectionPopoverPlacement({
    anchor: {
      left: anchorRect.left,
      right: anchorRect.right,
      top: anchorRect.top,
      bottom: anchorRect.bottom,
    },
    size: { width: el.offsetWidth, height: el.offsetHeight },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  });
  el.style.left = `${placement.left}px`;
  if (placement.placement === 'above') {
    el.style.top = 'auto';
    el.style.bottom = `${placement.bottom}px`;
  } else {
    el.style.bottom = 'auto';
    el.style.top = `${placement.top}px`;
  }
  el.style.visibility = '';
}

function bindSelectionPopoverDismiss() {
  selectionPopover.openController?.abort();
  const controller = new AbortController();
  selectionPopover.openController = controller;
  const { signal } = controller;
  selectionPopover.anchorScrollTop = els.pdfColumn.scrollTop;
  // 点浮层外任意处关闭（capture 保证先于其他 mousedown 逻辑；浮层内可选中复制）。
  document.addEventListener('mousedown', (event) => {
    if (selectionPopover.el?.contains(event.target)) return;
    closeSelectionPopover();
  }, { signal, capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSelectionPopover();
  }, { signal });
  els.pdfColumn.addEventListener('scroll', () => {
    if (Math.abs(els.pdfColumn.scrollTop - selectionPopover.anchorScrollTop)
      > SELECTION_POPOVER_SCROLL_CLOSE_PX) {
      closeSelectionPopover();
    }
  }, { signal });
}

function cancelSelectionTranslateRequest() {
  if (selectionPopover.requestId == null) return;
  client.cancel(selectionPopover.requestId); // 复用既有 cancel 消息
  selectionPopover.requestId = null;
}

function closeSelectionPopover() {
  cancelSelectionTranslateRequest(); // 关闭浮层即取消未完成的划词请求
  selectionPopover.openController?.abort();
  selectionPopover.openController = null;
  if (selectionPopover.el) selectionPopover.el.hidden = true;
}

// 在左栏 PDF 页上叠加精确 fragment 高亮；旋转页先变换到 PDF.js viewport 坐标。
function highlightPdfRegions(p, boxes) {
  const pageEl = p.pageEl;
  if (!pageEl) return;
  const displayBoxes = (Array.isArray(boxes) ? boxes : [])
    .map((box) => irBoxToDisplay(box, p.pageObj?.rotate || 0))
    .filter(Boolean);
  if (!displayBoxes.length) return;
  pageEl.querySelectorAll('.pdf-hl').forEach((overlay) => overlay.remove());
  const overlays = displayBoxes.map((nbox) => {
    const ov = document.createElement('div');
    ov.className = 'pdf-hl';
    ov.style.left = `${nbox[0] * 100}%`;
    ov.style.top = `${nbox[1] * 100}%`;
    ov.style.width = `${(nbox[2] - nbox[0]) * 100}%`;
    ov.style.height = `${(nbox[3] - nbox[1]) * 100}%`;
    ov.style.display = 'block';
    pageEl.appendChild(ov);
    return ov;
  });
  // 滚动左栏到该区域
  suspendScrollSync();
  const colTop = els.pdfColumn.getBoundingClientRect().top;
  const r = overlays[0].getBoundingClientRect();
  els.pdfColumn.scrollTop += (r.top - colTop) - els.pdfColumn.clientHeight / 4;
  for (const ov of overlays) {
    ov.classList.remove('pdf-hl-flash');
    void ov.offsetWidth;
    ov.classList.add('pdf-hl-flash');
  }
  clearTimeout(p._hlTimer);
  p._hlTimer = setTimeout(() => overlays.forEach((overlay) => overlay.remove()), 2600);
}

function highlightPdfRegion(p, nbox) {
  highlightPdfRegions(p, [nbox]);
}

// 滚动某栏到指定「块元素」并闪烁（段落级）。
function linkToBlock(sideName, col, targetBlk) {
  if (!targetBlk) return;
  suspendScrollSync();
  const colTop = col.getBoundingClientRect().top;
  const r = targetBlk.getBoundingClientRect();
  col.scrollTop += (r.top - colTop) - col.clientHeight / 4;
  flashElement(targetBlk);
}

function linkTo(sideName, col, target) {
  if (!target) return;
  suspendScrollSync();
  const colTop = col.getBoundingClientRect().top;
  const r = target.getBoundingClientRect();
  // 把目标页顶部对到视口偏上 1/6 处，居中偏上更易读
  col.scrollTop += (r.top - colTop) - col.clientHeight / 6;
  flashElement(target);
}

function flashElement(el) {
  el.classList.remove('link-flash');
  // 触发重排以重启动画
  void el.offsetWidth;
  el.classList.add('link-flash');
  setTimeout(() => el.classList.remove('link-flash'), 1200);
}
// ---------------------------------------------------------------------------
// 缩放 + 分栏拖拽
// ---------------------------------------------------------------------------
function setScale(s) {
  s = Math.min(3, Math.max(0.5, Math.round(s * 100) / 100));
  if (s === state.scale) return;
  state.scale = s;
  els.zoomLevel.textContent = `${Math.round(s * 100)}%`;
  // 缩放前记录左栏阅读锚点（页 + 页内比例），改尺寸后恢复，避免缩放跳页。
  const col = els.pdfColumn;
  const anchor = state.pages?.length && col
    ? findColumnAnchorBisect(state.pages, 'pageEl', col.getBoundingClientRect().top)
    : null;
  for (const p of state.pages) {
    p.pageEl.style.width = `${p.viewport1.width * s}px`;
    p.pageEl.style.height = `${p.viewport1.height * s}px`;
    delete p.pageEl.dataset.renderedScale;
    p.pageEl.querySelectorAll('canvas, .textLayer').forEach((n) => n.remove());
  }
  if (anchor && col) {
    const targetEl = state.pages[anchor.index]?.pageEl;
    if (targetEl) {
      const delta = anchorScrollDelta(targetEl.getBoundingClientRect(), anchor, col.getBoundingClientRect().top);
      if (Math.abs(delta) >= 1) col.scrollTop += delta;
    }
  }
  for (const p of state.pages) {
    const r = p.pageEl.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight + 500) renderPage(p.pageEl);
  }
  // Zoom changes PDF page heights — re-pair translation to the same page ratio.
  scheduleScrollRealign('layout');
}

function setupDivider() {
  let dragging = false;
  els.divider.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.classList.add('divider-dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = els.reader.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(80, Math.max(20, pct));
    document.documentElement.style.setProperty('--left-width', `${pct}%`);
    // Live re-pair while dragging so left/right never drift mid-adjust.
    scheduleScrollRealign('layout');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.classList.remove('divider-dragging');
    scheduleScrollRealign('layout');
  });
}

// ---------------------------------------------------------------------------
// UI 绑定
// ---------------------------------------------------------------------------
function bindUi() {
  els.zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
  els.zoomIn.addEventListener('click', () => setScale(state.scale + 0.15));
  els.zoomOut.addEventListener('click', () => setScale(state.scale - 0.15));
  setupScrollLinkControls();
  setupPageJumpControls();
  setupShortcutsHelp();
  els.profileSelect.addEventListener('change', switchProviderProfile);
  els.btnRetry.addEventListener('click', retryAllErrors);
  els.btnOutline?.addEventListener('click', () => toggleOutlinePanel());
  els.btnSnip?.addEventListener('click', () => startSnipMode());
  els.btnExportDoc?.addEventListener('click', () => { toggleExportMenu(); });
  els.btnChat.addEventListener('click', () => chatPanel.toggle());
  els.btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.hudToggle.addEventListener('click', () => {
    clearTimeout(healthHideTimer);
    const collapsed = els.hud.classList.toggle('collapsed');
    els.hudToggle.textContent = collapsed ? '详情' : '收起';
    els.hudToggle.setAttribute('aria-expanded', String(!collapsed));
    els.hudToggle.title = collapsed ? '显示技术详情' : '隐藏技术详情';
  });
  els.fileInput.addEventListener('change', () => { if (els.fileInput.files[0]) loadFromFile(els.fileInput.files[0]); });
  // 支持的浏览器用 showOpenFilePicker 替换文件选择：能拿到句柄 → 最近阅读可一键重开。
  const pickLabel = els.fileInput.closest('label');
  if (typeof window.showOpenFilePicker === 'function' && pickLabel) {
    pickLabel.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
        });
        if (handle) await loadFromFile(await handle.getFile(), { handle });
      } catch (error) {
        if (error?.name !== 'AbortError') showToast(friendlyReaderError(error), true);
      }
    });
  }
  els.urlGo.addEventListener('click', () => { const u = els.urlInput.value.trim(); if (u) loadFromUrl(u); });
  els.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.urlGo.click(); });
  ['dragover', 'dragenter'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragover'); }));
  els.dropzone.addEventListener('drop', (e) => {
    const item = e.dataTransfer.items?.[0];
    const f = e.dataTransfer.files[0];
    if (!f) return;
    // 拖拽也尽量拿句柄（Chromium 支持）；失败回退纯 File。
    if (item && typeof item.getAsFileSystemHandle === 'function') {
      void item.getAsFileSystemHandle()
        .then((handle) => loadFromFile(f, { handle: handle?.kind === 'file' ? handle : null }))
        .catch(() => loadFromFile(f));
    } else {
      loadFromFile(f);
    }
  });
  setupDivider();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(msg, isError = false) {
  const raw = String(msg || '').replace(/^✗\s*/u, '');
  els.toast.textContent = isError ? friendlyReaderError(raw) : raw;
  els.toast.className = `toast${isError ? ' error' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, isError ? 6000 : 2600);
}
function hideToast() { els.toast.hidden = true; }
