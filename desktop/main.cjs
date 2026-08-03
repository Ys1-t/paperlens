// PaperLens Desktop 主进程：窗口 + agent IPC。
// agent 循环跑在主进程（Node 环境，联网无 CORS）；渲染进程只做 UI。
// CommonJS 入口（Electron 主进程 ESM 加载在部分版本有兼容问题）；
// agent 核心库是 ESM，用动态 import 加载。
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const configPath = () => join(app.getPath('userData'), 'agent.config.json');

function loadConfig() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { /* 首次运行 */ }
  // 兼容 CLI 的 desktop/agent.config.json（开发期共用一份配置）。
  try { return JSON.parse(readFileSync(join(__dirname, 'agent.config.json'), 'utf8')); } catch { return {}; }
}
function saveConfig(config) {
  if (!existsSync(dirname(configPath()))) mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// ESM 核心库（agent 循环 + 工具）延迟加载并缓存。
let corePromise = null;
function loadCore() {
  corePromise ||= Promise.all([
    import('./lib/agent-core.mjs'),
    import('./lib/web-tool-defs.mjs'),
    import('./lib/paper-tool-defs.mjs'),
  ]).then(([core, webDefs, paperDefs]) => ({
    ...core,
    registry: core.createToolRegistry([
      ...webDefs.createWebToolDefs(),
      ...paperDefs.createPaperToolDefs(() => paper),
    ]),
  }));
  return corePromise;
}

// 当前打开的论文（渲染进程抽取文本后注入）。
let paper = null;
ipcMain.handle('paper:set', (_event, next) => {
  const pages = (Array.isArray(next?.pages) ? next.pages : []).map((p) => String(p || ''));
  paper = pages.length ? { title: String(next?.title || '').slice(0, 200), pages } : null;
  return { ok: true, pages: pages.length };
});

// 整页视觉翻译：复用扩展的 translator（提示词/协议/流式全套成熟逻辑）。
// 渲染进程发页位图 dataURL，流式增量经 translate:delta 事件回传。
let translatorPromise = null;
function loadTranslator() {
  translatorPromise ||= Promise.all([
    import('../src/lib/translator.js'),
    import('../src/lib/reading-mode.js'),
  ]).then(([translator, readingMode]) => ({ translator, readingMode }));
  return translatorPromise;
}

ipcMain.handle('paper:translate-page', async (event, { page, image, sourceText } = {}) => {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { error: '请先在设置里配置模型（需支持图片输入的视觉模型）' };
  }
  try {
    const { translator, readingMode } = await loadTranslator();
    const requestText = readingMode.buildVisionTranslationContext({
      sourceText: String(sourceText || ''),
    });
    let raw = '';
    const full = await translator.translate({
      config: {
        protocol: config.protocol || 'openai',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        targetLang: config.targetLang || '简体中文',
        stream: true,
      },
      text: requestText,
      image: String(image || ''),
      onDelta: (delta) => {
        raw += String(delta || '');
        try { event.sender.send('translate:delta', { page, delta: String(delta || '') }); } catch { /* 窗口已关 */ }
      },
    });
    return { page, markdown: readingMode.finalizeReadingTranslation(raw, full) };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
});

// 会话历史（主进程持有；渲染进程重启不丢当轮会话）。
let history = [];

ipcMain.handle('config:get', () => {
  const config = loadConfig();
  return { baseUrl: config.baseUrl || '', model: config.model || '', hasKey: Boolean(config.apiKey) };
});
ipcMain.handle('config:set', (_event, next) => {
  const current = loadConfig();
  saveConfig({
    baseUrl: String(next?.baseUrl || current.baseUrl || '').trim(),
    apiKey: String(next?.apiKey ?? current.apiKey ?? '').trim(),
    model: String(next?.model || current.model || '').trim(),
  });
  return { ok: true };
});
ipcMain.handle('chat:reset', () => { history = []; return { ok: true }; });

ipcMain.handle('chat:ask', async (event, question) => {
  const config = loadConfig();
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return { error: '请先在设置里填写中转站 Base URL / API Key / 模型' };
  }
  const q = String(question || '').trim();
  if (!q) return { error: '问题为空' };
  const core = await loadCore();
  const chatFn = core.createOpenAiStreamingChat(config);
  history.push({ role: 'user', content: q });
  const send = (type, data) => {
    try { event.sender.send('chat:event', { type, ...data }); } catch { /* 窗口已关 */ }
  };
  try {
    const { answer, trace } = await core.runAgentTurn({
      chatFn,
      registry: core.registry,
      messages: [
        { role: 'system', content: core.agentSystemPrompt({ paperTitle: paper?.title || '' }) },
        ...history,
      ],
      onEvent: (type, data) => send(type, data),
    });
    history.push({ role: 'assistant', content: answer });
    // 简单截断防炸窗口（压缩策略后续参考扩展 compactResearchDialogue）。
    if (history.length > 24) history = history.slice(-16);
    return { answer, trace };
  } catch (error) {
    history.pop(); // 失败的问题不留在历史里
    return { error: String(error?.message || error) };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    title: 'PaperLens Desktop',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
