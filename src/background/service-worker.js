// src/background/service-worker.js
// 后台服务：翻译请求的并发调度、流式端口、缓存、显式打开 PDF、右键菜单、健康检查。
import { loadChatConfig, loadConfig } from '../lib/config.js';
import { PAPERLENS_BUILD_ID, TRANSLATION_PORT_NAME } from '../lib/build-info.js';
import { chat, translate } from '../lib/translator.js';
import { glossaryTermsInText, loadGlossary } from '../lib/glossary.js';
import { addUsageSample, estimateRequestTokens } from '../lib/usage-stats.js';
import { cacheGet, cacheSet, cacheClear, cacheCount, hashKey, hashKeyStrong } from '../lib/cache.js';
import {
  cancelRequestRecord,
  createRequestRecord,
  retryTransientOnce,
} from '../lib/request-handlers.js';
import { buildTranslationCacheIdentity, isCacheableTranslation } from '../lib/translation-cache.js';
import { isCacheableStructuredTranslation } from '../lib/translation-quality.js';
import { isCacheableNodeTranslation, NODE_TRANSLATION_PROTOCOL } from '../lib/node-translation.js';
import { parseFormulaBatchTranscription, parseFormulaTranscription } from '../lib/reading-mode.js';
import { createTranslationScheduler, NORMAL_QUEUE_TIMEOUT_MS } from '../lib/translation-queue.js';
import { redactSecrets } from '../lib/secrets.js';
import { validateProfile } from '../lib/provider-profiles.js';
import { removeLegacyPdfRedirectRules } from '../lib/pdf-open-policy.js';
import {
  appendRuntimeDiagnostic,
  installRuntimeDiagnosticCapture,
} from '../lib/runtime-diagnostics.js';
import {
  normalizeObsidianSettings,
  pickObsidianConfigFields,
  probeObsidianRest,
  upsertPaperNote,
} from '../lib/obsidian-bridge.js';

if (typeof globalThis.addEventListener === 'function') {
  installRuntimeDiagnosticCapture({
    target: globalThis,
    consoleObject: console,
    component: 'service-worker',
    record: (event) => appendRuntimeDiagnostic(
      chrome.storage.local,
      { component: 'service-worker', ...event },
      { buildId: PAPERLENS_BUILD_ID },
    ),
  });
}

console.log('[PL-SW] service worker 模块开始加载', new Date().toISOString());

const REQUEST_TIMEOUT_MS = 180000; // 单请求 180s 超时（密集页 + 推理模型可能较慢）

// ---------------------------------------------------------------------------
// 并发调度（信号量）
// ---------------------------------------------------------------------------
let MAX = 4;
const scheduler = createTranslationScheduler(() => MAX);

async function refreshMax() {
  const c = await loadConfig();
  MAX = Math.min(16, Math.max(1, c.concurrency || 4));
  scheduler.pump();
}

// ---------------------------------------------------------------------------
// 监听器优先注册（即使下面的初始化抛错，也不影响 viewer 连接）
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TRANSLATION_PORT_NAME) {
    if (String(port.name || '').startsWith('translate')) {
      try { port.disconnect(); } catch { /* stale viewer port */ }
    }
    return;
  }
  console.log('[PL-SW] viewer 已连接端口');
  const requests = new Map();

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ping') {
      console.log('[PL-SW] 收到 ping', msg.id);
      post(port, { type: 'pong', id: msg.id, ts: Date.now(), buildId: PAPERLENS_BUILD_ID });
      return;
    }
    if (msg.type === 'cancel') {
      cancelRequestRecord(requests.get(msg.id));
      return;
    }
    if (msg.type === 'chat') {
      console.log('[PL-SW] 收到 chat', msg.id, '轮数', (msg.messages || []).length);
      handleChat(port, msg, requests);
      return;
    }
    if (msg.type !== 'translate') return;
    console.log('[PL-SW] 收到 translate', msg.id, '文本长度', (msg.text || '').length, 'priority', !!msg.priority);
    handleTranslate(port, msg, requests);
  });

  port.onDisconnect.addListener(() => {
    console.log('[PL-SW] 端口断开，中止', requests.size, '个进行中的请求');
    for (const request of requests.values()) cancelRequestRecord(request);
    requests.clear();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    let configSnapshot;
    try {
      if (msg.type === 'openViewer') {
        const tab = await chrome.tabs.create({ url: viewerUrl(msg.file) });
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }
      if (msg.type === 'testConnection') {
        const base = await loadConfig();
        const cfg = { ...base, ...(msg.override || {}), stream: false };
        configSnapshot = cfg;
        validateProfile({
          ...cfg,
          id: cfg.activeProfileId || 'connection-test',
          name: cfg.profileName || '临时连接测试',
        });
        const sample = await translate({ config: cfg, text: 'Heuristics are widely used for optimization.' });
        sendResponse({ ok: true, sample });
        return;
      }
      if (msg.type === 'clearCache') { await cacheClear(); sendResponse({ ok: true }); return; }
      if (msg.type === 'cacheCount') { sendResponse({ ok: true, count: await cacheCount() }); return; }
      if (msg.type === 'obsidian') {
        const config = await loadConfig();
        // Only Obsidian fields — never merge full runtime config (LLM baseUrl/apiKey).
        const fields = pickObsidianConfigFields(config, msg.override);
        const settings = normalizeObsidianSettings(fields);
        configSnapshot = {
          obsidianBaseUrl: settings.baseUrl,
          obsidianFolder: settings.folder,
          hasKey: Boolean(settings.apiKey),
        };
        if (msg.action === 'probe') {
          const result = await probeObsidianRest({ ...settings, enabled: true });
          sendResponse(result);
          return;
        }
        if (msg.action === 'upsertPaperNote') {
          if (!settings.enabled) {
            sendResponse({ ok: false, message: '未启用 Obsidian 同步（设置 → Obsidian）' });
            return;
          }
          if (!settings.apiKey) {
            sendResponse({
              ok: false,
              message: 'REST 模式需要 API Key。更推荐在设置中「选择库文件夹」直接写入。',
            });
            return;
          }
          const result = await upsertPaperNote(settings, {
            docTitle: msg.docTitle || '',
            notesMarkdown: msg.notesMarkdown || '',
            thoughts: msg.thoughts || '',
            sourceUrl: msg.sourceUrl || '',
            appendOnly: Boolean(msg.appendOnly),
          });
          sendResponse(result);
          return;
        }
        sendResponse({ ok: false, error: 'unknown obsidian action' });
        return;
      }
      sendResponse({ ok: false, error: 'unknown message ' + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error: safeError(e, configSnapshot) });
    }
  })();
  return true; // 异步 sendResponse
});

// ---------------------------------------------------------------------------
// 初始化（包裹 try/catch，避免初始化异常导致监听器所在模块失败）
// ---------------------------------------------------------------------------
(async () => {
  try { await disableAutomaticPdfInterception(); } catch (e) { console.warn('[PL-SW] 清理旧 PDF 拦截规则失败', safeError(e)); }
  try { await refreshMax(); } catch (e) { console.warn('[PL-SW] refreshMax 失败', safeError(e)); }
  console.log('[PL-SW] 初始化完成，MAX=', MAX);
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) {
    refreshMax().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 翻译处理
// ---------------------------------------------------------------------------
function cacheKeyFor(cfg, text) {
  // 64 位组合键：避免 32 位 FNV 生日碰撞导致「静默串译文」。
  return hashKeyStrong(buildTranslationCacheIdentity(cfg, text));
}

// v0.9.4 及更早版本写入的 32 位键。读取时兜底命中并迁移到新键，保住存量缓存。
function legacyCacheKeyFor(cfg, text) {
  return hashKey(buildTranslationCacheIdentity(cfg, text));
}

// 非流式代理 / 长思考模型可能在首字节前长时间无任何消息；viewer 的无活动守卫
// 首字节窗口是 90s，而 SW 硬超时 180s。这里在首字节前周期性回 thinking 心跳，
// 证明请求仍在进行，把「是否超时」的裁决权交还给 SW 的 180s 硬超时。
const PRE_OUTPUT_HEARTBEAT_MS = 20000;

async function handleTranslate(port, msg, requests) {
  const {
    id, text, image, markdown, formula, formulaBatch, nodeProtocol, nodeSlotRetry = false,
    bypassCache = false,
    queuePriority = 0,
  } = msg;
  const formulaJob = Boolean(formula || formulaBatch);
  const payload = formulaBatch
    ? ('FORMULA_BATCH:v6:' + hashKey(`${text || ''}:${image || ''}`))
    : formula
      ? ('FORMULA:v6:' + hashKey(`${text || ''}:${image || ''}`))
    : image
      ? ('IMG:' + hashKey(image))
      : nodeProtocol
        ? `${NODE_TRANSLATION_PROTOCOL}:` + text
        : (markdown ? 'MD:' + text : text);
  const request = createRequestRecord();
  requests.set(id, request);
  const stopIfCancelled = () => {
    if (!request.cancelled) return false;
    post(port, { type: 'cancelled', id });
    requests.delete(id);
    return true;
  };
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (request.cancelled) post(port, { type: 'cancelled', id });
    else post(port, { type: 'error', id, message: '读取配置失败：' + safeError(e) });
    requests.delete(id);
    return;
  }
  if (stopIfCancelled()) return;

  // 用户锁定术语：整页视觉翻译注入全表（截断见 glossary.js），
  // 文本/划词请求只注入命中原文的术语。加载失败静默降级为无术语。
  try {
    const glossary = await loadGlossary();
    cfg.glossary = image ? glossary : glossaryTermsInText(glossary, text);
  } catch { cfg.glossary = []; }

  if (!cfg.apiKey) {
    if (cfg.profileName) {
      post(port, {
        type: 'error',
        id,
        message: `尚未配置 API Key（当前 Profile：${cfg.profileName}）。点击工具栏图标 → 设置，填入 Key 后重试。`,
      });
      requests.delete(id);
      return;
    }
    post(port, { type: 'error', id, message: '尚未配置 API Key。点击工具栏图标 → 设置，填入 Key 后重试。' });
    requests.delete(id);
    return;
  }

  const reusableTranslation = (value) => (
    isCacheableTranslation(value)
    && (!markdown || isCacheableStructuredTranslation(text, value, cfg.targetLang))
    && (!nodeProtocol || isCacheableNodeTranslation(text, value, cfg.targetLang))
    && (!formula || Boolean(parseFormulaTranscription(value, { sourceText: text || '' })))
    && (!formulaBatch || (() => {
      let expected = [];
      try {
        const metadata = JSON.parse(String(text || ''));
        expected = Array.isArray(metadata?.formulas) ? metadata.formulas : (metadata?.ids || []);
      } catch {
        return false;
      }
      const parsed = parseFormulaBatchTranscription(value, expected);
      return Boolean(parsed && expected.length > 0
        && parsed.items.length === expected.length
        && parsed.missingIds.length === 0
        && parsed.unknownIds.length === 0
        && parsed.rejectedIds.length === 0);
    })())
  );

  // 局部质量修复必须跳过旧结果，否则会再次命中同一条坏缓存。
  // 普通读取也会先做公式 token / 未翻译检查，旧的污染缓存不会重放。
  // 划词（priority）请求带页面局部上下文、复用率极低，既不读也不写共享译文
  // 缓存，避免临时选择污染正文缓存空间（正文缓存身份/管线版本保持不变）。
  if (!bypassCache && !msg.priority) {
    try {
      let cached = await cacheGet(cacheKeyFor(cfg, payload));
      if (cached == null) {
        // 旧 32 位键的存量缓存：命中后迁移到 64 位组合键，下次直接命中新键。
        const legacy = await cacheGet(legacyCacheKeyFor(cfg, payload));
        if (legacy != null && reusableTranslation(legacy)) {
          cached = legacy;
          try { await cacheSet(cacheKeyFor(cfg, payload), legacy); } catch { /* noop */ }
        }
      }
      if (stopIfCancelled()) return;
      if (reusableTranslation(cached)) {
        console.log('[PL-SW] 缓存命中', id);
        post(port, { type: 'done', id, full: cached, cached: true });
        requests.delete(id);
        return;
      }
    } catch (e) { console.warn('[PL-SW] 读缓存失败（忽略）', safeError(e, cfg)); }
  }
  if (stopIfCancelled()) return;

  const runTask = async () => {
    if (stopIfCancelled()) return;
    const ctrl = new AbortController();
    request.controller = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    post(port, { type: 'status', id, phase: 'connecting' });
    let outputStarted = false;
    const heartbeat = setInterval(() => {
      if (!outputStarted && !request.cancelled) post(port, { type: 'status', id, phase: 'thinking' });
    }, PRE_OUTPUT_HEARTBEAT_MS);
    try {
      const full = await retryTransientOnce(
        () => translate({
          config: cfg,
          text,
          image,
          markdown,
          formula,
          formulaBatch,
          nodeProtocol,
          nodeSlotRetry,
          signal: ctrl.signal,
          onDelta: (d) => {
            if (String(d || '').length > 0) outputStarted = true;
            post(port, { type: 'chunk', id, delta: d });
          },
          onStatus: (phase) => post(port, { type: 'status', id, phase }),
        }),
        {
          signal: ctrl.signal,
          // 429（限频/欠费）用更长退避，普通瞬时网络错误快速重试一次。
          delayMs: (error) => (Number(error?.status) === 429 ? 1500 : 200),
          shouldRetry: () => !outputStarted,
          onRetry: () => {
            console.warn('[PL-SW] transient fetch failure; retrying once', id);
            post(port, { type: 'status', id, phase: 'connecting' });
          },
        },
      );
      if (request.cancelled) {
        post(port, { type: 'cancelled', id });
        return;
      }
      if (!isCacheableTranslation(full)) {
        throw new Error(formulaJob ? '公式识别返回空结果' : '模型返回空译文');
      }
      console.log('[PL-SW] 完成', id, '译文长度', (full || '').length);
      // 用量估算（字符启发式；不读 SSE usage 字段，兼容各类中转站）。失败静默。
      void addUsageSample(estimateRequestTokens({ text, image: !!image, full }));
      post(port, { type: 'done', id, full });
      if (msg.priority) {
        // 划词请求不写入共享译文缓存（见上方缓存读取处的说明）。
      } else if (reusableTranslation(full)) {
        try { await cacheSet(cacheKeyFor(cfg, payload), full); } catch { /* noop */ }
      } else {
        console.warn('[PL-SW] 译文未通过结构质量检查，不写入缓存', id);
      }
    } catch (e) {
      if (timedOut) {
        post(port, { type: 'error', id, message: `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）——请检查网络 / Base URL / 模型名是否正确` });
      } else if (request.cancelled || ctrl.signal.aborted || e?.name === 'AbortError') {
        post(port, { type: 'cancelled', id });
      } else {
        const message = safeError(e, cfg);
        console.warn('[PL-SW] 翻译失败', id, message);
        post(port, { type: 'error', id, message });
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      requests.delete(id);
    }
  };

  // 划词翻译（priority）立即执行，不排队；文档批量翻译走并发队列。
  // 入队即回一个 queued 状态，让前端知道「请求还活着，只是在排队」，避免误判超时。
  if (stopIfCancelled()) return;
  if (!msg.priority && scheduler.isSaturated({ formula: formulaJob })) post(port, { type: 'status', id, phase: 'queued' });
  const p = msg.priority ? runTask() : scheduler.schedule(runTask, {
    formula: formulaJob,
    priority: Number(queuePriority) || 0,
    // 4 个并发槽位可被慢请求合法占满 REQUEST_TIMEOUT_MS(180s)；排队死线取
    // 180s + 60s = 240s（NORMAL_QUEUE_TIMEOUT_MS），排队最长等完一个完整慢请求。
    queueTimeoutMs: formulaJob ? 0 : NORMAL_QUEUE_TIMEOUT_MS,
  });
  p.catch((e) => {
    requests.delete(id);
    post(port, { type: 'error', id, message: safeError(e, cfg) });
  });
}

// AI 助手多轮对话：与 translate 完全独立的消息类型。立即执行、不排队，
// **不经 cacheGet/cacheSet**（聊天不该进翻译缓存）。复用当前 Profile 的
// baseUrl/apiKey/model 与既有取消 / 超时 / 流式回传语义。
async function handleChat(port, msg, requests) {
  const { id, messages } = msg;
  const request = createRequestRecord();
  requests.set(id, request);
  const stopIfCancelled = () => {
    if (!request.cancelled) return false;
    post(port, { type: 'cancelled', id });
    requests.delete(id);
    return true;
  };
  let cfg;
  try {
    // 对话可使用独立 Profile（更强模型 / 另一套 API），与翻译 activeProfile 解耦。
    cfg = await loadChatConfig();
  } catch (e) {
    if (request.cancelled) post(port, { type: 'cancelled', id });
    else post(port, { type: 'error', id, message: '读取配置失败：' + safeError(e) });
    requests.delete(id);
    return;
  }
  if (stopIfCancelled()) return;

  if (!cfg.apiKey) {
    const suffix = cfg.profileName
      ? `（AI 助手 Profile：${cfg.profileName}）`
      : '';
    post(port, { type: 'error', id, message: `尚未配置 API Key${suffix}。请在设置里为 AI 助手选定的 Profile 填入 Key。` });
    requests.delete(id);
    return;
  }
  const hasUserTurn = Array.isArray(messages) && messages.some((m) => {
    if (m?.role !== 'user') return false;
    if (String(m.content || '').trim()) return true;
    return Array.isArray(m.images) && m.images.some((url) => /^data:image\//i.test(String(url || '')));
  });
  if (!hasUserTurn) {
    post(port, { type: 'error', id, message: '聊天请求缺少有效的用户消息。' });
    requests.delete(id);
    return;
  }
  if (stopIfCancelled()) return;

  const ctrl = new AbortController();
  request.controller = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, REQUEST_TIMEOUT_MS);
  post(port, { type: 'status', id, phase: 'connecting' });
  let outputStarted = false;
  const heartbeat = setInterval(() => {
    if (!outputStarted && !request.cancelled) post(port, { type: 'status', id, phase: 'thinking' });
  }, PRE_OUTPUT_HEARTBEAT_MS);
  try {
    const full = await chat({
      config: cfg,
      messages,
      signal: ctrl.signal,
      onDelta: (d) => {
        if (String(d || '').length > 0) outputStarted = true;
        post(port, { type: 'chunk', id, delta: d });
      },
      onStatus: (phase) => post(port, { type: 'status', id, phase }),
    });
    if (request.cancelled) {
      post(port, { type: 'cancelled', id });
      return;
    }
    console.log('[PL-SW] chat 完成', id, '回复长度', (full || '').length);
    // 对话用量同样计入估算统计（输入=全部轮次文本）。
    void addUsageSample(estimateRequestTokens({
      text: (messages || []).map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n'),
      full,
    }));
    post(port, { type: 'done', id, full });
  } catch (e) {
    if (timedOut) {
      post(port, { type: 'error', id, message: `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）——请检查网络 / Base URL / 模型名是否正确` });
    } else if (request.cancelled || ctrl.signal.aborted || e?.name === 'AbortError') {
      post(port, { type: 'cancelled', id });
    } else {
      const message = safeError(e, cfg);
      console.warn('[PL-SW] chat 失败', id, message);
      post(port, { type: 'error', id, message });
    }
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    requests.delete(id);
  }
}

function safeError(error, config) {
  return redactSecrets(error?.message || error, [config?.apiKey]);
}

function post(port, m) {
  try { port.postMessage(m); } catch { /* 端口已断开 */ }
}

function viewerUrl(file) {
  const base = chrome.runtime.getURL('src/viewer/viewer.html');
  return file ? `${base}?file=${encodeURIComponent(file)}` : base;
}

// ---------------------------------------------------------------------------
// 旧版本曾自动拦截 .pdf / arXiv 主框架导航。动态规则会跨浏览器重启和
// 扩展升级保留，因此新版必须主动删除它们。这里绝不再添加重定向规则：
// 阅读器只由 popup、右键菜单或显式 openViewer 消息打开。
// ---------------------------------------------------------------------------
async function disableAutomaticPdfInterception() {
  const removed = await removeLegacyPdfRedirectRules(chrome.declarativeNetRequest);
  if (removed) console.log('[PL-SW] 已禁用 PDF 自动拦截并清理旧规则');
}

// ---------------------------------------------------------------------------
// 安装 / 启动
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'paperlens-open',
    title: '用 PaperLens 打开 / 翻译此 PDF',
    contexts: ['link', 'page'],
  }, () => void chrome.runtime.lastError);
  disableAutomaticPdfInterception().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => { disableAutomaticPdfInterception().catch(() => {}); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (url) chrome.tabs.create({ url: viewerUrl(url) });
});

console.log('[PL-SW] service worker 模块加载完成');
