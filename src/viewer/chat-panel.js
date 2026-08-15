// src/viewer/chat-panel.js
// 悬浮「科研助手」窗口（可拖动位置、可改宽高，叠在阅读器之上）：
// 消息列表、选中追问、当前页截图提问、对话导出。
// 复用当前 Profile 模型走多轮 chat（Port 消息 type:'chat'，见 docs/TECHNICAL.md §6）。
// 纯前端：会话（含工具轨迹与证据审计）写入 IndexedDB；开/关与窗口几何记忆到 localStorage。
import {
  ASK_AI_INTENTS,
  buildAskAiQuestion,
  buildChatMessages,
  chatSystemPrompt,
  clipSelectionExcerpt,
  composeUserMessageWithQuote,
  defaultChatStarterPrompts,
  defaultPageImageQuestion,
  conversationExportFilename,
  exportConversationMarkdown,
  formatSelectionQuotePreview,
  isAskableSelectionText,
  normalizeChatText,
} from '../lib/chat-assistant.js';
import {
  deleteChatSession,
  formatChatSessionTime,
  getChatSession,
  listChatSessions,
  makeChatSessionId,
  putChatSession,
} from '../lib/chat-history-store.js';
import {
  buildChatPrintSections,
  buildPrintDocumentHtml,
  loadPrintAssets,
  openPrintHtmlWindow,
  sanitizeExportHtml,
} from '../lib/print-export.js';
import {
  RESEARCH_AGENT_MAX_HISTORY_TURNS,
  RESEARCH_AGENT_MAX_ROUNDS,
  assembleAgentDialogueTurns,
  buildAgentBootstrap,
  buildContextualEvidenceQuery,
  defaultResearchAgentStarters,
  dedupeResearchToolCalls,
  executeResearchTool,
  formatToolResultsForModel,
  parseAgentResponse,
  researchAgentSystemPrompt,
} from '../lib/research-agent.js';
import {
  PRIMARY_SKILL_IDS,
  RESEARCH_SKILLS,
  appendResearchNote,
  buildFollowUpActions,
  buildSkillUserMessage,
  clearResearchNotes,
  formatPaperContextLine,
  formatResearchNotesMarkdown,
  formatToolCallLabel,
  getResearchSkill,
  linkifyPageCitationsInElement,
  loadResearchNotes,
  noteTitleFromSkillOrText,
  pageFromToolCall,
  searchResearchSkills,
  shouldUseResearchAgent,
} from '../lib/research-skills.js';
import {
  auditAnswerCitations,
  buildPriorEvidenceBrief,
  extractPageCitations,
  normalizeEvidenceItems,
  scoreEvidenceSupport,
} from '../lib/paper-retrieval.js';

const PANEL_OPEN_STORAGE_KEY = 'paperlens.chatPanel.open';
const PANEL_MODE_STORAGE_KEY = 'paperlens.chatPanel.mode';
const PANEL_WIDTH_STORAGE_KEY = 'paperlens.chatPanel.width'; // legacy → migrates into geom
const PANEL_GEOM_STORAGE_KEY = 'paperlens.chatPanel.geom';
const SKILLS_EXPANDED_KEY = 'paperlens.chatPanel.skillsExpanded';
const PANEL_WIDTH_MIN = 360;
const PANEL_WIDTH_MAX = 960;
const PANEL_WIDTH_DEFAULT = 520;
const PANEL_HEIGHT_MIN = 420;
const PANEL_HEIGHT_MAX = 960;
const PANEL_HEIGHT_DEFAULT = 640;
const PANEL_EDGE_PAD = 10;

/** 流式渲染节流器：保证两次渲染至少间隔 minIntervalMs，且尾帧不丢。 */
function createThrottledRenderer(render, minIntervalMs = 100) {
  let last = 0;
  let timer = null;
  let disposed = false;
  const run = () => {
    timer = null;
    if (disposed) return;
    last = Date.now();
    render();
  };
  return {
    schedule() {
      if (disposed || timer != null) return;
      const wait = Math.max(0, minIntervalMs - (Date.now() - last));
      if (wait === 0) { run(); return; }
      timer = setTimeout(run, wait);
    },
    dispose() {
      disposed = true;
      if (timer != null) { clearTimeout(timer); timer = null; }
    },
  };
}

export function createChatPanel({
  sendChat,
  renderMarkdown,
  getConfig = () => ({}),
  showToast = () => {},
  /** @returns {Promise<{dataUrl:string, pageNum:number}|null>} */
  capturePageImage = null,
  getDocTitle = () => '',
  getDocKey = () => 'unknown',
  /** Paper tools for research agent mode */
  paperTools = null,
  /** Jump reader to page N */
  goToPage = null,
  /** Called when the panel opens (e.g. to prefetch page source text) */
  onOpen = null,
  document: doc = globalThis.document,
} = {}) {
  const history = [];        // {role, content, images?, pageNum?}
  let activeRequestId = null;
  let streamingBubble = null;
  let mounted = false;
  let pendingQuote = null;    // { selection, context }
  let pendingImage = null;    // { dataUrl, pageNum }
  let selectionMenu = null;
  let selectionMenuController = null;
  let sessionId = makeChatSessionId();
  let sessionCreatedAt = Date.now();
  let historyDrawerOpen = false;
  let notesDrawerOpen = false;
  let skillPaletteOpen = false;
  let skillPaletteReturnFocus = null;
  let skillPaletteSelectedIndex = 0;
  let evidencePanelSeq = 0;
  let historyFilter = 'doc'; // 'doc' | 'all'
  let persistTimer = null;
  // Default to deep-read (agent) for research-assistant product direction.
  let agentMode = readAgentMode(); // 'chat' | 'agent'
  let agentAbort = false;
  let agentRunning = false;
  let contextTimer = null;
  let autoScrollPaused = false;
  let programmaticScroll = false;
  const els = {};

  function readAgentMode() {
    try {
      const raw = globalThis.localStorage?.getItem(PANEL_MODE_STORAGE_KEY);
      if (raw === 'chat') return 'chat';
      // Missing key or 'agent' → deep-read default.
      return 'agent';
    } catch {
      return 'agent';
    }
  }
  function writeAgentMode(mode) {
    try {
      globalThis.localStorage?.setItem(PANEL_MODE_STORAGE_KEY, mode === 'agent' ? 'agent' : 'chat');
    } catch { /* noop */ }
  }

  function persistOpen(open) {
    try { globalThis.localStorage?.setItem(PANEL_OPEN_STORAGE_KEY, open ? '1' : '0'); } catch { /* noop */ }
  }
  function readOpen() {
    try { return globalThis.localStorage?.getItem(PANEL_OPEN_STORAGE_KEY) === '1'; } catch { return false; }
  }

  function mount() {
    if (mounted) return els.root;
    const root = doc.createElement('aside');
    root.id = 'chat-panel';
    root.className = 'chat-panel';
    root.setAttribute('aria-label', '科研助手');
    root.hidden = true;
    root.innerHTML = `
      <div class="chat-float-edges" aria-hidden="true">
        <span class="chat-resize chat-resize-n" data-edge="n"></span>
        <span class="chat-resize chat-resize-s" data-edge="s"></span>
        <span class="chat-resize chat-resize-e" data-edge="e"></span>
        <span class="chat-resize chat-resize-w" data-edge="w"></span>
        <span class="chat-resize chat-resize-ne" data-edge="ne"></span>
        <span class="chat-resize chat-resize-nw" data-edge="nw"></span>
        <span class="chat-resize chat-resize-se" data-edge="se" title="拖动调整窗口大小"></span>
        <span class="chat-resize chat-resize-sw" data-edge="sw"></span>
      </div>
      <div class="chat-head" title="拖动标题栏可移动窗口">
        <div class="chat-head-top">
          <div class="chat-brand">
            <span class="chat-avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v1.2A4.5 4.5 0 0 0 8.5 20h.7a2.8 2.8 0 0 0 5.6 0h.7A4.5 4.5 0 0 0 19 11.2V10a7 7 0 0 0-7-7Zm-2.2 8.2a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm4.4 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>
            </span>
            <div class="chat-title-block">
              <span class="chat-title">科研助手</span>
              <span class="chat-model-label" title="对话使用的模型 Profile（可在设置中与翻译分开配置）"></span>
            </div>
          </div>
          <button type="button" class="chat-tool-btn chat-collapse" title="关闭窗口" aria-label="关闭科研助手窗口">
            <span class="chat-tool-ico" aria-hidden="true">×</span>
          </button>
        </div>
        <div class="chat-paper-context" title="当前阅读上下文">
          <span class="chat-paper-context-main">未打开 PDF</span>
          <span class="chat-paper-context-title"></span>
        </div>
        <div class="chat-head-tools">
          <div class="chat-mode-switch" role="group" aria-label="助手模式">
            <button type="button" class="chat-mode-btn" data-mode="chat" title="快速问答：解释选区、页图，不自动多页检索">快问</button>
            <button type="button" class="chat-mode-btn is-active" data-mode="agent" title="深读：自动查阅各页译文并取证">深读</button>
          </div>
          <div class="chat-head-actions">
            <button type="button" class="chat-tool-btn chat-command-btn" title="搜索全部科研技能（Ctrl+K）" aria-expanded="false" aria-controls="chat-skill-command">
              <span class="chat-tool-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span><span>技能</span>
            </button>
            <button type="button" class="chat-tool-btn chat-notes-btn" title="本篇科研笔记">
              <span class="chat-tool-ico" aria-hidden="true">✎</span><span>笔记</span>
            </button>
            <button type="button" class="chat-tool-btn chat-history-btn" title="查看历史聊天记录">
              <span class="chat-tool-ico" aria-hidden="true">☰</span><span>记录</span>
            </button>
            <button type="button" class="chat-tool-btn chat-export" title="导出对话为 PDF（系统打印对话框）">
              <span class="chat-tool-ico" aria-hidden="true">↓</span><span>PDF</span>
            </button>
            <button type="button" class="chat-tool-btn chat-export-md" title="下载带证据溯源的 Markdown 对话记录">
              <span class="chat-tool-svg" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 3.5h9l5 5v12H5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 3.5v5h5M8 13v4m0-4 2 2 2-2v4m2-4h2.5a1.5 1.5 0 0 1 0 3H14z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>MD</span>
            </button>
            <button type="button" class="chat-tool-btn chat-clear" title="新建对话（当前会话会保留在记录里）">
              <span class="chat-tool-ico" aria-hidden="true">＋</span><span>新建</span>
            </button>
          </div>
        </div>
        <div class="chat-skills" role="toolbar" aria-label="科研技能"></div>
      </div>
      <div class="chat-command-overlay" hidden>
        <section id="chat-skill-command" class="chat-command-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-command-title">
          <div class="chat-command-head">
            <div>
              <div id="chat-command-title" class="chat-command-title">科研技能</div>
              <div class="chat-command-subtitle">按名称或用途搜索，回车运行</div>
            </div>
            <button type="button" class="chat-command-close" aria-label="关闭技能搜索" title="关闭（Esc）">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <label class="chat-command-search">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <span class="sr-only">搜索科研技能</span>
            <input type="search" class="chat-command-input" autocomplete="off" placeholder="例如：实验、复现、审稿、术语…" aria-controls="chat-command-results" aria-autocomplete="list" />
            <kbd>Ctrl K</kbd>
          </label>
          <div id="chat-command-results" class="chat-command-results" role="listbox" aria-label="科研技能搜索结果"></div>
          <div class="chat-command-help">↑↓ 选择 · Enter 运行 · Esc 关闭</div>
        </section>
      </div>
      <div class="chat-history-drawer" hidden>
        <div class="chat-history-head">
          <span class="chat-history-title">聊天记录</span>
          <div class="chat-history-tabs">
            <button type="button" class="chat-history-tab is-active" data-filter="doc">本 PDF</button>
            <button type="button" class="chat-history-tab" data-filter="all">全部</button>
          </div>
          <button type="button" class="chat-history-close" title="关闭记录">关闭</button>
        </div>
        <div class="chat-history-list" role="list" aria-label="历史会话列表"></div>
      </div>
      <div class="chat-notes-drawer" hidden>
        <div class="chat-notes-head">
          <span class="chat-notes-title">本篇科研笔记</span>
          <div class="chat-notes-actions">
            <button type="button" class="chat-tool-btn chat-notes-obsidian" title="同步到本机 Obsidian 库">Obsidian</button>
            <button type="button" class="chat-tool-btn chat-notes-copy" title="复制为 Markdown">复制</button>
            <button type="button" class="chat-tool-btn chat-notes-download" title="下载为 .md 文件（含我的思考）">下载</button>
            <button type="button" class="chat-tool-btn chat-notes-clear" title="清空本篇笔记">清空</button>
            <button type="button" class="chat-history-close chat-notes-close" title="关闭笔记">关闭</button>
          </div>
        </div>
        <div class="chat-notes-thought">
          <label class="chat-notes-thought-label" for="chat-notes-thought-input">我的思考（写入 Obsidian）</label>
          <textarea id="chat-notes-thought-input" class="chat-notes-thought-input" rows="3" placeholder="读完这页 / 这篇的想法、疑问、可复用点… 点 Obsidian 一并写入库"></textarea>
        </div>
        <div class="chat-notes-body" role="region" aria-label="科研笔记列表"></div>
      </div>
      <div class="chat-messages" role="log" aria-live="polite" aria-label="对话记录"></div>
      <button type="button" class="chat-scroll-bottom" hidden aria-label="回到最新回答">回到最新内容 ↓</button>
      <div class="chat-composer">
        <div class="chat-attachments">
          <div class="chat-quote" hidden>
            <div class="chat-quote-body">
              <span class="chat-quote-label">引用</span>
              <span class="chat-quote-text"></span>
            </div>
            <button type="button" class="chat-quote-clear" title="去掉引用" aria-label="去掉引用">×</button>
          </div>
          <div class="chat-page-attach" hidden>
            <img class="chat-page-thumb" alt="当前页截图预览" />
            <div class="chat-page-meta">
              <span class="chat-page-label">当前页截图</span>
              <span class="chat-page-num"></span>
            </div>
            <button type="button" class="chat-page-clear" title="去掉截图" aria-label="去掉截图">×</button>
          </div>
        </div>
        <form class="chat-input-row">
          <button type="button" class="chat-page-btn" title="附上当前 PDF 页截图再提问">
            <span class="chat-page-btn-ico" aria-hidden="true">▣</span>
            <span>页图</span>
          </button>
          <textarea class="chat-input" rows="2" placeholder="深读模式会自动查页取证… 也可点上方技能" aria-label="输入问题"></textarea>
          <button type="submit" class="chat-send" title="发送（Enter）">
            <span class="chat-send-label">发送</span>
          </button>
        </form>
        <div class="chat-composer-hint chat-composer-hint-chat" hidden>快问：解释选区 / 页图 · Enter 发送 · 复杂问题可切「深读」</div>
        <div class="chat-composer-hint chat-composer-hint-agent">深读：自动查阅译文并标页码 · 点「一键导读」生成 briefing · 「笔记」沉淀本篇要点</div>
      </div>`;
    doc.body.appendChild(root);

    els.root = root;
    els.messages = root.querySelector('.chat-messages');
    els.scrollBottom = root.querySelector('.chat-scroll-bottom');
    els.form = root.querySelector('.chat-input-row');
    els.input = root.querySelector('.chat-input');
    els.send = root.querySelector('.chat-send');
    els.sendLabel = root.querySelector('.chat-send-label');
    els.clear = root.querySelector('.chat-clear');
    els.collapse = root.querySelector('.chat-collapse');
    els.export = root.querySelector('.chat-export');
    els.exportMarkdown = root.querySelector('.chat-export-md');
    els.commandBtn = root.querySelector('.chat-command-btn');
    els.commandOverlay = root.querySelector('.chat-command-overlay');
    els.commandDialog = root.querySelector('.chat-command-dialog');
    els.commandInput = root.querySelector('.chat-command-input');
    els.commandResults = root.querySelector('.chat-command-results');
    els.commandClose = root.querySelector('.chat-command-close');
    els.historyBtn = root.querySelector('.chat-history-btn');
    els.historyDrawer = root.querySelector('.chat-history-drawer');
    els.historyList = root.querySelector('.chat-history-list');
    els.historyClose = root.querySelector('.chat-history-close');
    els.historyTabs = root.querySelectorAll('.chat-history-tab');
    els.notesBtn = root.querySelector('.chat-notes-btn');
    els.notesDrawer = root.querySelector('.chat-notes-drawer');
    els.notesBody = root.querySelector('.chat-notes-body');
    els.notesClose = root.querySelector('.chat-notes-close');
    els.notesCopy = root.querySelector('.chat-notes-copy');
    els.notesDownload = root.querySelector('.chat-notes-download');
    els.notesClear = root.querySelector('.chat-notes-clear');
    els.notesObsidian = root.querySelector('.chat-notes-obsidian');
    els.notesThought = root.querySelector('.chat-notes-thought-input');
    els.skills = root.querySelector('.chat-skills');
    els.paperContext = root.querySelector('.chat-paper-context');
    els.paperContextMain = root.querySelector('.chat-paper-context-main');
    els.paperContextTitle = root.querySelector('.chat-paper-context-title');
    els.modelLabel = root.querySelector('.chat-model-label');
    els.modeBtns = root.querySelectorAll('.chat-mode-btn');
    els.hintChat = root.querySelector('.chat-composer-hint-chat');
    els.hintAgent = root.querySelector('.chat-composer-hint-agent');
    els.quote = root.querySelector('.chat-quote');
    els.quoteText = root.querySelector('.chat-quote-text');
    els.quoteClear = root.querySelector('.chat-quote-clear');
    els.pageAttach = root.querySelector('.chat-page-attach');
    els.pageThumb = root.querySelector('.chat-page-thumb');
    els.pageNum = root.querySelector('.chat-page-num');
    els.pageClear = root.querySelector('.chat-page-clear');
    els.pageBtn = root.querySelector('.chat-page-btn');
    els.attachments = root.querySelector('.chat-attachments');
    els.head = root.querySelector('.chat-head');
    els.resizeEdges = root.querySelectorAll('.chat-resize');

    els.form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    els.input.addEventListener('input', autosizeInput);
    els.messages.addEventListener('scroll', () => {
      if (programmaticScroll) return;
      autoScrollPaused = !isMessagesNearBottom();
      syncScrollBottomButton();
    }, { passive: true });
    els.scrollBottom?.addEventListener('click', () => scrollToBottom({ force: true }));
    els.clear.addEventListener('click', () => { void startNewConversation(); });
    els.collapse.addEventListener('click', () => setOpen(false));
    els.quoteClear.addEventListener('click', () => clearQuote());
    els.pageClear.addEventListener('click', () => clearPageImage());
    els.pageBtn.addEventListener('click', () => { void attachCurrentPageImage(); });
    els.export.addEventListener('click', () => { void exportConversationPdf(); });
    els.exportMarkdown?.addEventListener('click', () => { void exportConversationMd(); });
    els.commandBtn?.addEventListener('click', () => {
      if (skillPaletteOpen) closeSkillPalette();
      else openSkillPalette();
    });
    els.commandClose?.addEventListener('click', () => closeSkillPalette());
    els.commandOverlay?.addEventListener('mousedown', (event) => {
      if (event.target === els.commandOverlay) closeSkillPalette();
    });
    els.commandInput?.addEventListener('input', () => {
      skillPaletteSelectedIndex = 0;
      renderSkillPaletteResults(els.commandInput.value);
    });
    els.commandInput?.addEventListener('keydown', handleSkillPaletteKeydown);
    els.commandDialog?.addEventListener('keydown', trapSkillPaletteFocus);
    els.historyBtn.addEventListener('click', () => { void toggleHistoryDrawer(); });
    els.historyClose.addEventListener('click', () => setHistoryDrawerOpen(false));
    els.notesBtn?.addEventListener('click', () => toggleNotesDrawer());
    els.notesClose?.addEventListener('click', () => setNotesDrawerOpen(false));
    els.notesCopy?.addEventListener('click', () => { void copyResearchNotes(); });
    els.notesDownload?.addEventListener('click', () => { void downloadResearchNotesMd(); });
    els.notesObsidian?.addEventListener('click', () => { void syncNotesToObsidian(); });
    els.notesClear?.addEventListener('click', () => {
      clearResearchNotes(getDocKey());
      renderNotesDrawer();
      showToast('已清空本篇笔记');
    });
    for (const tab of els.historyTabs) {
      tab.addEventListener('click', () => {
        historyFilter = tab.dataset.filter === 'all' ? 'all' : 'doc';
        for (const other of els.historyTabs) {
          other.classList.toggle('is-active', other.dataset.filter === historyFilter);
        }
        void refreshHistoryList();
      });
    }
    for (const btn of els.modeBtns) {
      btn.addEventListener('click', () => setAgentMode(btn.dataset.mode === 'agent' ? 'agent' : 'chat'));
    }
    renderSkillsBar();
    applyAgentModeUi();
    applyGeometry(readGeometry());
    setupFloatingWindow();
    refreshPaperContext();

    els.messages.addEventListener('mouseup', (event) => {
      if (event.button !== 0 || event.detail > 1) return;
      setTimeout(() => handleMessageSelection(event), 0);
    });

    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!isOpen()) return;
      if (skillPaletteOpen) {
        closeSkillPalette();
        event.preventDefault();
        return;
      }
      if (selectionMenu && !selectionMenu.hidden) {
        hideSelectionMenu();
        event.preventDefault();
        return;
      }
      if (normalizeChatText(els.input?.value || '')) return;
      setOpen(false);
    });
    globalThis.addEventListener?.('resize', () => {
      if (!els.root || els.root.hidden) return;
      applyGeometry(readLiveGeometry());
    });

    renderEmptyState();
    mounted = true;
    if (readOpen()) setOpen(true);
    return root;
  }

  function viewportSize() {
    return {
      w: Math.max(320, Number(globalThis.innerWidth) || 1200),
      h: Math.max(320, Number(globalThis.innerHeight) || 800),
    };
  }

  function defaultGeometry() {
    const vp = viewportSize();
    const w = Math.min(PANEL_WIDTH_DEFAULT, Math.max(PANEL_WIDTH_MIN, vp.w - 48));
    const h = Math.min(
      PANEL_HEIGHT_DEFAULT,
      Math.max(PANEL_HEIGHT_MIN, Math.floor(vp.h * 0.78)),
    );
    return clampGeometry({
      x: Math.max(PANEL_EDGE_PAD, vp.w - w - 24),
      y: Math.max(PANEL_EDGE_PAD, 56 + 16),
      w,
      h,
    });
  }

  function clampGeometry(geom = {}) {
    const vp = viewportSize();
    const maxW = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, vp.w - PANEL_EDGE_PAD * 2));
    const maxH = Math.max(PANEL_HEIGHT_MIN, Math.min(PANEL_HEIGHT_MAX, vp.h - PANEL_EDGE_PAD * 2));
    const w = Math.max(PANEL_WIDTH_MIN, Math.min(maxW, Math.round(Number(geom.w) || PANEL_WIDTH_DEFAULT)));
    const h = Math.max(PANEL_HEIGHT_MIN, Math.min(maxH, Math.round(Number(geom.h) || PANEL_HEIGHT_DEFAULT)));
    const x = Math.max(
      PANEL_EDGE_PAD,
      Math.min(Math.max(PANEL_EDGE_PAD, vp.w - w - PANEL_EDGE_PAD), Math.round(Number(geom.x) || PANEL_EDGE_PAD)),
    );
    const y = Math.max(
      PANEL_EDGE_PAD,
      Math.min(Math.max(PANEL_EDGE_PAD, vp.h - h - PANEL_EDGE_PAD), Math.round(Number(geom.y) || PANEL_EDGE_PAD)),
    );
    return { x, y, w, h };
  }

  function readGeometry() {
    try {
      const raw = globalThis.localStorage?.getItem(PANEL_GEOM_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return clampGeometry(parsed);
      }
      // Migrate legacy width-only preference into a floating default.
      const legacyW = Number(globalThis.localStorage?.getItem(PANEL_WIDTH_STORAGE_KEY));
      if (Number.isFinite(legacyW) && legacyW >= PANEL_WIDTH_MIN) {
        const base = defaultGeometry();
        return clampGeometry({ ...base, w: legacyW });
      }
    } catch { /* noop */ }
    return defaultGeometry();
  }

  function writeGeometry(geom) {
    try {
      const c = clampGeometry(geom);
      globalThis.localStorage?.setItem(PANEL_GEOM_STORAGE_KEY, JSON.stringify(c));
      // Keep legacy key warm so older builds still get a sensible width.
      globalThis.localStorage?.setItem(PANEL_WIDTH_STORAGE_KEY, String(c.w));
    } catch { /* noop */ }
  }

  function readLiveGeometry() {
    if (!els.root) return readGeometry();
    const rect = els.root.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(rect.width)) return readGeometry();
    return clampGeometry({
      x: rect.left,
      y: rect.top,
      w: rect.width,
      h: rect.height,
    });
  }

  function applyGeometry(geom) {
    if (!els.root) return clampGeometry(geom);
    const c = clampGeometry(geom);
    els.root.style.left = `${c.x}px`;
    els.root.style.top = `${c.y}px`;
    els.root.style.width = `${c.w}px`;
    els.root.style.height = `${c.h}px`;
    els.root.style.setProperty('--chat-panel-width', `${c.w}px`);
    els.root.style.setProperty('--chat-panel-height', `${c.h}px`);
    return c;
  }

  /** Floating window: drag by title bar; resize from edges/corners. */
  function setupFloatingWindow() {
    if (!els.root || els.root._plFloatBound) return;
    els.root._plFloatBound = true;

    const pointer = (event) => ({
      x: event.touches?.[0]?.clientX ?? event.clientX,
      y: event.touches?.[0]?.clientY ?? event.clientY,
    });

    // --- drag move ---
    let drag = null;
    const onDragMove = (event) => {
      if (!drag) return;
      const p = pointer(event);
      applyGeometry({
        x: drag.originX + (p.x - drag.startX),
        y: drag.originY + (p.y - drag.startY),
        w: drag.w,
        h: drag.h,
      });
      event.preventDefault?.();
    };
    const onDragUp = () => {
      if (!drag) return;
      drag = null;
      els.root?.classList.remove('is-dragging');
      doc.body.classList.remove('chat-panel-dragging');
      writeGeometry(readLiveGeometry());
      doc.removeEventListener('mousemove', onDragMove);
      doc.removeEventListener('mouseup', onDragUp);
      doc.removeEventListener('touchmove', onDragMove);
      doc.removeEventListener('touchend', onDragUp);
    };
    const onDragDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      // Buttons / chips / inputs are not drag handles.
      if (event.target?.closest?.(
        'button, a, input, textarea, select, .chat-mode-switch, .chat-skills, .chat-skill-chip, .chat-resize',
      )) return;
      const g = readLiveGeometry();
      const p = pointer(event);
      drag = { startX: p.x, startY: p.y, originX: g.x, originY: g.y, w: g.w, h: g.h };
      els.root?.classList.add('is-dragging');
      doc.body.classList.add('chat-panel-dragging');
      doc.addEventListener('mousemove', onDragMove);
      doc.addEventListener('mouseup', onDragUp);
      doc.addEventListener('touchmove', onDragMove, { passive: false });
      doc.addEventListener('touchend', onDragUp);
      event.preventDefault?.();
    };
    els.head?.addEventListener('mousedown', onDragDown);
    els.head?.addEventListener('touchstart', onDragDown, { passive: false });
    els.head?.addEventListener('dblclick', (event) => {
      if (event.target?.closest?.('button, a, input, textarea, select')) return;
      const next = applyGeometry(defaultGeometry());
      writeGeometry(next);
    });

    // --- edge / corner resize ---
    let resize = null;
    const onResizeMove = (event) => {
      if (!resize) return;
      const p = pointer(event);
      const dx = p.x - resize.startX;
      const dy = p.y - resize.startY;
      let { x, y, w, h } = resize.origin;
      const edge = resize.edge;
      if (edge.includes('e')) w = resize.origin.w + dx;
      if (edge.includes('s')) h = resize.origin.h + dy;
      if (edge.includes('w')) {
        w = resize.origin.w - dx;
        x = resize.origin.x + dx;
      }
      if (edge.includes('n')) {
        h = resize.origin.h - dy;
        y = resize.origin.y + dy;
      }
      // Keep the opposite edge pinned when clamping width/height.
      const clamped = clampGeometry({ x, y, w, h });
      if (edge.includes('w') && clamped.w !== w) {
        clamped.x = resize.origin.x + resize.origin.w - clamped.w;
      }
      if (edge.includes('n') && clamped.h !== h) {
        clamped.y = resize.origin.y + resize.origin.h - clamped.h;
      }
      applyGeometry(clamped);
      event.preventDefault?.();
    };
    const onResizeUp = () => {
      if (!resize) return;
      resize = null;
      els.root?.classList.remove('is-resizing');
      doc.body.classList.remove('chat-panel-resizing');
      writeGeometry(readLiveGeometry());
      doc.removeEventListener('mousemove', onResizeMove);
      doc.removeEventListener('mouseup', onResizeUp);
      doc.removeEventListener('touchmove', onResizeMove);
      doc.removeEventListener('touchend', onResizeUp);
    };
    const onResizeDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      const edge = event.currentTarget?.dataset?.edge;
      if (!edge) return;
      const g = readLiveGeometry();
      const p = pointer(event);
      resize = { edge, startX: p.x, startY: p.y, origin: { ...g } };
      els.root?.classList.add('is-resizing');
      doc.body.classList.add('chat-panel-resizing');
      doc.addEventListener('mousemove', onResizeMove);
      doc.addEventListener('mouseup', onResizeUp);
      doc.addEventListener('touchmove', onResizeMove, { passive: false });
      doc.addEventListener('touchend', onResizeUp);
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    for (const handle of els.resizeEdges || []) {
      handle.addEventListener('mousedown', onResizeDown);
      handle.addEventListener('touchstart', onResizeDown, { passive: false });
    }
  }

  function autosizeInput() {
    const el = els.input;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(52, el.scrollHeight))}px`;
  }

  function setOpen(open) {
    mount();
    els.root.hidden = !open;
    els.root.classList.toggle('open', open);
    doc.body.classList.toggle('chat-open', open);
    persistOpen(open);
    if (open) {
      refreshModelLabel();
      applyAgentModeUi();
      applyGeometry(readGeometry());
      syncHistoryDrawerOffset();
      refreshPaperContext();
      startContextPolling();
      try { onOpen?.(); } catch { /* noop */ }
      setTimeout(() => els.input?.focus(), 0);
      scrollToBottom({ force: true });
    } else {
      hideSelectionMenu();
      closeSkillPalette({ restoreFocus: false });
      setHistoryDrawerOpen(false);
      setNotesDrawerOpen(false);
      stopContextPolling();
    }
  }

  /** 展示对话实际使用的 Profile/模型（可与翻译不同）。 */
  function refreshModelLabel() {
    if (!els.modelLabel) return;
    const cfg = getConfig() || {};
    const chat = cfg.chatProfile || {};
    const name = chat.name || cfg.profileName || '';
    const model = chat.model || cfg.model || '';
    const same = cfg.chatUsesTranslationProfile !== false;
    if (!name && !model) {
      els.modelLabel.textContent = '';
      els.modelLabel.removeAttribute('title');
      return;
    }
    const text = [name, model].filter(Boolean).join(' · ');
    els.modelLabel.textContent = same ? `模型：${text}` : `对话：${text}`;
    els.modelLabel.title = same
      ? '与翻译使用同一 Profile（可在设置中为 AI 助手单独指定更强模型）'
      : 'AI 助手使用独立 Profile，与翻译 API/模型分开';
  }

  function currentDocMeta() {
    return {
      docKey: String(typeof getDocKey === 'function' ? getDocKey() : 'unknown') || 'unknown',
      docTitle: String(typeof getDocTitle === 'function' ? getDocTitle() : '') || '未命名 PDF',
    };
  }

  function schedulePersistSession() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { void persistCurrentSession(); }, 280);
  }

  async function persistCurrentSession() {
    if (!history.length) return null;
    try {
      const meta = currentDocMeta();
      const saved = await putChatSession({
        id: sessionId,
        docKey: meta.docKey,
        docTitle: meta.docTitle,
        messages: history,
        createdAt: sessionCreatedAt,
        updatedAt: Date.now(),
      });
      if (saved?.id) sessionId = saved.id;
      if (historyDrawerOpen) void refreshHistoryList();
      return saved;
    } catch (error) {
      console.warn('[PL-CHAT] 保存聊天记录失败', error);
      return null;
    }
  }

  function setHistoryDrawerOpen(open) {
    historyDrawerOpen = !!open;
    if (!els.historyDrawer) return;
    els.historyDrawer.hidden = !historyDrawerOpen;
    els.historyBtn?.classList.toggle('is-active', historyDrawerOpen);
    if (historyDrawerOpen) {
      setNotesDrawerOpen(false);
      void refreshHistoryList();
    }
  }

  async function toggleHistoryDrawer() {
    mount();
    setHistoryDrawerOpen(!historyDrawerOpen);
  }

  async function refreshHistoryList() {
    if (!els.historyList) return;
    els.historyList.replaceChildren();
    const loading = doc.createElement('div');
    loading.className = 'chat-history-empty';
    loading.textContent = '加载中…';
    els.historyList.appendChild(loading);

    try {
      const meta = currentDocMeta();
      const rows = await listChatSessions({
        docKey: historyFilter === 'doc' ? meta.docKey : '',
      });
      els.historyList.replaceChildren();
      if (!rows.length) {
        const empty = doc.createElement('div');
        empty.className = 'chat-history-empty';
        empty.textContent = historyFilter === 'doc'
          ? '这篇 PDF 还没有保存过的对话。聊几轮后会自动出现在这里。'
          : '还没有聊天记录。';
        els.historyList.appendChild(empty);
        return;
      }
      for (const row of rows) {
        els.historyList.appendChild(renderHistoryRow(row));
      }
    } catch (error) {
      els.historyList.replaceChildren();
      const err = doc.createElement('div');
      err.className = 'chat-history-empty';
      err.textContent = `加载失败：${error?.message || error}`;
      els.historyList.appendChild(err);
    }
  }

  function renderHistoryRow(row) {
    const item = doc.createElement('div');
    item.className = 'chat-history-item';
    item.setAttribute('role', 'listitem');
    if (row.id === sessionId) item.classList.add('is-current');

    const main = doc.createElement('button');
    main.type = 'button';
    main.className = 'chat-history-open';
    main.title = '打开这条记录';
    const title = doc.createElement('div');
    title.className = 'chat-history-item-title';
    title.textContent = row.title || '新对话';
    const meta = doc.createElement('div');
    meta.className = 'chat-history-item-meta';
    const parts = [
      formatChatSessionTime(row.updatedAt),
      `${row.messageCount || 0} 条`,
    ];
    if (historyFilter === 'all' && row.docTitle) parts.unshift(row.docTitle);
    meta.textContent = parts.filter(Boolean).join(' · ');
    main.append(title, meta);
    main.addEventListener('click', () => { void openHistorySession(row.id); });

    const del = doc.createElement('button');
    del.type = 'button';
    del.className = 'chat-history-delete';
    del.title = '删除这条记录';
    del.textContent = '删除';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      void removeHistorySession(row.id);
    });

    item.append(main, del);
    return item;
  }

  async function openHistorySession(id) {
    if (activeRequestId != null) {
      showToast('请先停止当前回复，再切换记录', true);
      return;
    }
    try {
      // 切换前先把当前会话落盘。
      await persistCurrentSession();
      const session = await getChatSession(id);
      if (!session) {
        showToast('这条记录不存在或已被删除', true);
        void refreshHistoryList();
        return;
      }
      loadSessionIntoView(session);
      setHistoryDrawerOpen(false);
      showToast('已打开历史对话');
    } catch (error) {
      showToast(String(error?.message || '打开记录失败'), true);
    }
  }

  function loadSessionIntoView(session) {
    cancelActive();
    activeRequestId = null;
    streamingBubble = null;
    clearQuote();
    clearPageImage();
    history.length = 0;
    for (const entry of session.messages || []) {
      if (entry?.role !== 'user' && entry?.role !== 'assistant') continue;
      const row = {
        role: entry.role,
        content: String(entry.content || ''),
      };
      if (entry.pageNum != null) row.pageNum = entry.pageNum;
      if (entry.hadImage) row.hadImage = true;
      if (entry.skillId) row.skillId = String(entry.skillId);
      if (Array.isArray(entry.toolSteps)) row.toolSteps = entry.toolSteps.map((step) => ({ ...step }));
      if (entry.evidence && typeof entry.evidence === 'object') row.evidence = { ...entry.evidence };
      history.push(row);
    }
    sessionId = session.id || makeChatSessionId();
    sessionCreatedAt = Number(session.createdAt) || Date.now();
    setBusy(false);
    renderHistoryMessages();
  }

  function renderHistoryMessages() {
    if (!els.messages) return;
    els.messages.replaceChildren();
    if (!history.length) {
      renderEmptyState();
      return;
    }
    for (const entry of history) {
      addBubble(entry.role, entry.content, { entry });
    }
    scrollToBottom({ force: true });
  }

  async function removeHistorySession(id) {
    try {
      await deleteChatSession(id);
      if (id === sessionId) {
        // 删的是当前会话：界面清空并开新会话 id，不重复保存已删内容。
        resetConversationLocal({ keepPersisted: false });
      }
      showToast('已删除');
      void refreshHistoryList();
    } catch (error) {
      showToast(String(error?.message || '删除失败'), true);
    }
  }

  function resetConversationLocal({ keepPersisted = true } = {}) {
    cancelActive();
    activeRequestId = null;
    streamingBubble = null;
    history.length = 0;
    autoScrollPaused = false;
    syncScrollBottomButton();
    clearQuote();
    clearPageImage();
    setBusy(false);
    hideSelectionMenu();
    if (keepPersisted) {
      // 新会话
      sessionId = makeChatSessionId();
      sessionCreatedAt = Date.now();
    } else {
      sessionId = makeChatSessionId();
      sessionCreatedAt = Date.now();
    }
    renderEmptyState();
  }

  async function startNewConversation() {
    if (activeRequestId != null) {
      showToast('请先停止当前回复，再新建对话', true);
      return;
    }
    await persistCurrentSession();
    resetConversationLocal({ keepPersisted: true });
    setHistoryDrawerOpen(false);
    showToast('已新建对话（旧对话在「记录」里）');
    els.input?.focus();
  }

  function toggle() { setOpen(els.root ? els.root.hidden : true); }
  function isOpen() { return Boolean(els.root && !els.root.hidden); }

  function setAgentMode(mode) {
    const next = mode === 'agent' ? 'agent' : 'chat';
    if (next === agentMode) return;
    if (activeRequestId != null) {
      showToast('请先停止当前回复，再切换模式', true);
      return;
    }
    agentMode = next;
    writeAgentMode(agentMode);
    applyAgentModeUi();
    if (!history.length) renderEmptyState();
    showToast(agentMode === 'agent'
      ? '深读模式：自动查阅各页并标注证据页码'
      : '快问模式：适合选区解释与页图问答');
  }

  function applyAgentModeUi() {
    if (els.root) els.root.classList.toggle('is-agent-mode', agentMode === 'agent');
    for (const btn of els.modeBtns || []) {
      btn.classList.toggle('is-active', btn.dataset.mode === agentMode);
    }
    if (els.hintChat) els.hintChat.hidden = agentMode === 'agent';
    if (els.hintAgent) els.hintAgent.hidden = agentMode !== 'agent';
    // Keep page image available in both modes — researchers need figures.
    if (els.pageBtn) els.pageBtn.hidden = false;
    if (els.input) {
      els.input.placeholder = agentMode === 'agent'
        ? '深读：例如「第 7 页算法在做什么？复杂度怎么来的？」'
        : '快问：解释选区，或附页图提问…';
    }
    syncHistoryDrawerOffset();
  }

  function syncHistoryDrawerOffset() {
    if (!els.root) return;
    const head = els.root.querySelector('.chat-head');
    const h = head?.getBoundingClientRect?.().height;
    if (h && Number.isFinite(h)) {
      els.root.style.setProperty('--chat-head-h', `${Math.ceil(h)}px`);
    }
  }

  function renderSkillsBar() {
    if (!els.skills) return;
    els.skills.replaceChildren();
    const primary = RESEARCH_SKILLS.filter((s) => PRIMARY_SKILL_IDS.includes(s.id));
    for (const skill of primary) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `chat-skill-chip${skill.id === 'briefing' ? ' is-primary' : ''}`;
      btn.dataset.skill = skill.id;
      btn.title = skill.title;
      btn.textContent = skill.short || skill.label;
      btn.addEventListener('click', () => { void runResearchSkill(skill.id); });
      els.skills.appendChild(btn);
    }
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'chat-skill-chip chat-skill-more';
    more.title = `搜索全部 ${RESEARCH_SKILLS.length} 个技能（Ctrl+K）`;
    more.setAttribute('aria-haspopup', 'dialog');
    more.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>全部技能</span>';
    more.addEventListener('click', () => openSkillPalette({ returnFocus: more }));
    els.skills.appendChild(more);
  }

  function readSkillsExpanded() {
    try { return globalThis.localStorage?.getItem(SKILLS_EXPANDED_KEY) === '1'; } catch { return false; }
  }

  function writeSkillsExpanded(value) {
    try { globalThis.localStorage?.setItem(SKILLS_EXPANDED_KEY, value ? '1' : '0'); } catch { /* noop */ }
  }

  function openSkillPalette({ returnFocus = null } = {}) {
    mount();
    if (!isOpen()) setOpen(true);
    setHistoryDrawerOpen(false);
    setNotesDrawerOpen(false);
    skillPaletteReturnFocus = returnFocus || doc.activeElement || els.commandBtn;
    skillPaletteOpen = true;
    skillPaletteSelectedIndex = 0;
    if (els.commandOverlay) els.commandOverlay.hidden = false;
    els.root?.classList.add('is-command-open');
    els.commandBtn?.setAttribute('aria-expanded', 'true');
    if (els.commandInput) els.commandInput.value = '';
    renderSkillPaletteResults('');
    writeSkillsExpanded(true);
    globalThis.setTimeout?.(() => els.commandInput?.focus(), 0);
  }

  function closeSkillPalette({ restoreFocus = true } = {}) {
    if (!skillPaletteOpen && els.commandOverlay?.hidden !== false) return;
    skillPaletteOpen = false;
    if (els.commandOverlay) els.commandOverlay.hidden = true;
    els.root?.classList.remove('is-command-open');
    els.commandBtn?.setAttribute('aria-expanded', 'false');
    writeSkillsExpanded(false);
    const target = skillPaletteReturnFocus;
    skillPaletteReturnFocus = null;
    if (restoreFocus && target && typeof target.focus === 'function') {
      globalThis.setTimeout?.(() => target.focus(), 0);
    }
  }

  function renderSkillPaletteResults(query = '') {
    if (!els.commandResults) return;
    const results = searchResearchSkills(query);
    els.commandResults.replaceChildren();
    skillPaletteSelectedIndex = Math.max(0, Math.min(skillPaletteSelectedIndex, Math.max(0, results.length - 1)));
    if (!results.length) {
      els.commandInput?.removeAttribute('aria-activedescendant');
      const empty = doc.createElement('div');
      empty.className = 'chat-command-empty';
      empty.textContent = '没有匹配的技能，试试“方法”“实验”或“复现”。';
      els.commandResults.appendChild(empty);
      return;
    }
    results.forEach((skill, index) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `chat-command-option${index === skillPaletteSelectedIndex ? ' is-selected' : ''}`;
      btn.id = `chat-command-option-${skill.id}`;
      btn.dataset.skill = skill.id;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', index === skillPaletteSelectedIndex ? 'true' : 'false');
      btn.innerHTML = '<span class="chat-command-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="17" height="17"><path d="M6 4.5h12v15H6z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 8h6M9 11.5h6M9 15h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>';
      const text = doc.createElement('span');
      text.className = 'chat-command-option-text';
      const name = doc.createElement('strong');
      name.textContent = skill.label;
      const description = doc.createElement('span');
      description.textContent = skill.title;
      text.append(name, description);
      const key = doc.createElement('span');
      key.className = 'chat-command-option-key';
      key.textContent = skill.short || skill.label;
      btn.append(text, key);
      btn.addEventListener('mouseenter', () => selectSkillPaletteIndex(index));
      btn.addEventListener('focus', () => selectSkillPaletteIndex(index));
      btn.addEventListener('click', () => activateSkillPaletteSelection(index));
      els.commandResults.appendChild(btn);
    });
    const active = els.commandResults.querySelectorAll('.chat-command-option')[skillPaletteSelectedIndex];
    if (active?.id) els.commandInput?.setAttribute('aria-activedescendant', active.id);
  }

  function selectSkillPaletteIndex(index) {
    const options = [...(els.commandResults?.querySelectorAll('.chat-command-option') || [])];
    if (!options.length) return;
    skillPaletteSelectedIndex = Math.max(0, Math.min(options.length - 1, Number(index) || 0));
    options.forEach((option, i) => {
      option.classList.toggle('is-selected', i === skillPaletteSelectedIndex);
      option.setAttribute('aria-selected', i === skillPaletteSelectedIndex ? 'true' : 'false');
    });
    if (options[skillPaletteSelectedIndex]?.id) {
      els.commandInput?.setAttribute('aria-activedescendant', options[skillPaletteSelectedIndex].id);
    }
    options[skillPaletteSelectedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }

  function activateSkillPaletteSelection(index = skillPaletteSelectedIndex) {
    const options = [...(els.commandResults?.querySelectorAll('.chat-command-option') || [])];
    const option = options[Math.max(0, Math.min(options.length - 1, Number(index) || 0))];
    const skillId = option?.dataset?.skill;
    if (!skillId) return;
    closeSkillPalette({ restoreFocus: false });
    void runResearchSkill(skillId);
  }

  function handleSkillPaletteKeydown(event) {
    const count = els.commandResults?.querySelectorAll('.chat-command-option').length || 0;
    if (event.key === 'ArrowDown' && count) {
      event.preventDefault();
      selectSkillPaletteIndex((skillPaletteSelectedIndex + 1) % count);
    } else if (event.key === 'ArrowUp' && count) {
      event.preventDefault();
      selectSkillPaletteIndex((skillPaletteSelectedIndex - 1 + count) % count);
    } else if (event.key === 'Enter' && count) {
      event.preventDefault();
      activateSkillPaletteSelection();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSkillPalette();
    }
  }

  function trapSkillPaletteFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSkillPalette();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(els.commandDialog?.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) || [])].filter((element) => !element.hidden && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function refreshPaperContext() {
    if (!els.paperContextMain) return;
    const meta = typeof paperTools?.getPaperMeta === 'function'
      ? paperTools.getPaperMeta()
      : {};
    const { line, title } = formatPaperContextLine(meta);
    els.paperContextMain.textContent = line || '未打开 PDF';
    if (els.paperContextTitle) {
      els.paperContextTitle.textContent = title || '';
      els.paperContextTitle.hidden = !title;
    }
  }

  function startContextPolling() {
    stopContextPolling();
    contextTimer = globalThis.setInterval?.(() => {
      if (!isOpen()) return;
      refreshPaperContext();
    }, 2500);
  }

  function stopContextPolling() {
    if (contextTimer) {
      try { globalThis.clearInterval(contextTimer); } catch { /* noop */ }
      contextTimer = null;
    }
  }

  async function runResearchSkill(skillId) {
    const skill = getResearchSkill(skillId);
    if (!skill) return;
    if (activeRequestId != null || agentRunning) {
      showToast('请先停止当前回复', true);
      return;
    }
    const cfg = getConfig() || {};
    if (cfg.hasApiKey === false) {
      showToast('尚未配置 API Key，点击工具栏图标 → 设置', true);
      return;
    }
    setOpen(true);
    setNotesDrawerOpen(false);
    setHistoryDrawerOpen(false);
    if (skill.forceAgent && agentMode !== 'agent') {
      agentMode = 'agent';
      writeAgentMode(agentMode);
      applyAgentModeUi();
    }
    const text = buildSkillUserMessage(skill, { docTitle: getDocTitle() });
    const userEntry = { role: 'user', content: text, skillId: skill.id };
    history.push(userEntry);
    if (els.messages.querySelector('.chat-empty')) els.messages.replaceChildren();
    addBubble('user', text, { entry: userEntry });
    void startAgentRequest(text, { skillId: skill.id, autoNote: skill.id === 'briefing' || skill.id === 'tldr' });
  }

  function jumpToPage(pageNum) {
    const n = Math.round(Number(pageNum));
    if (!Number.isFinite(n) || n < 1) return;
    try {
      if (typeof goToPage === 'function') goToPage(n);
      else if (typeof paperTools?.gotoPage === 'function') paperTools.gotoPage(n);
      showToast(`已跳到第 ${n} 页`);
      refreshPaperContext();
    } catch (error) {
      showToast(String(error?.message || '跳转失败'), true);
    }
  }

  function enhanceAssistantBubble(textEl) {
    if (!textEl) return;
    if (textEl.dataset) delete textEl.dataset.plPageLinked;
    linkifyPageCitationsInElement(textEl, { onPageClick: jumpToPage });
  }

  function toggleNotesDrawer() {
    setNotesDrawerOpen(!notesDrawerOpen);
  }

  function setNotesDrawerOpen(open) {
    notesDrawerOpen = !!open;
    if (els.notesDrawer) els.notesDrawer.hidden = !notesDrawerOpen;
    if (els.notesBtn) els.notesBtn.classList.toggle('is-active', notesDrawerOpen);
    if (notesDrawerOpen) {
      setHistoryDrawerOpen(false);
      renderNotesDrawer();
    }
  }

  function renderNotesDrawer() {
    if (!els.notesBody) return;
    const notes = loadResearchNotes(getDocKey());
    els.notesBody.replaceChildren();
    if (!notes.items.length) {
      const empty = doc.createElement('div');
      empty.className = 'chat-notes-empty';
      empty.innerHTML = '还没有笔记。<br/>可在助手回答下点「收入笔记」，或运行「一键导读」自动沉淀。';
      els.notesBody.appendChild(empty);
      return;
    }
    notes.items.slice().reverse().forEach((item) => {
      const card = doc.createElement('article');
      card.className = 'chat-note-card';
      const head = doc.createElement('header');
      head.className = 'chat-note-card-head';
      const title = doc.createElement('strong');
      title.textContent = item.title;
      const time = doc.createElement('time');
      time.textContent = new Date(item.createdAt).toLocaleString('zh-CN');
      head.append(title, time);
      const body = doc.createElement('div');
      body.className = 'chat-note-card-body';
      if (typeof renderMarkdown === 'function') {
        try { renderMarkdown(body, item.content); }
        catch { body.textContent = item.content; }
      } else {
        body.textContent = item.content;
      }
      linkifyPageCitationsInElement(body, { onPageClick: jumpToPage });
      card.append(head, body);
      els.notesBody.appendChild(card);
    });
  }

  async function copyResearchNotes() {
    const md = formatResearchNotesMarkdown(loadResearchNotes(getDocKey()), {
      docTitle: getDocTitle(),
    });
    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(md);
      } else {
        const ta = doc.createElement('textarea');
        ta.value = md;
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand?.('copy');
        ta.remove();
      }
      showToast('笔记 Markdown 已复制');
    } catch {
      showToast('复制失败，请手动选择笔记内容', true);
    }
  }

  /** 把本篇笔记（含「我的思考」）下载为 .md 文件，Obsidian 之外的通用出口。 */
  async function downloadResearchNotesMd() {
    const notes = loadResearchNotes(getDocKey());
    const thoughts = String(els.notesThought?.value || '').trim();
    if (!notes.items?.length && !thoughts) {
      showToast('还没有可下载的笔记', true);
      return;
    }
    let md = formatResearchNotesMarkdown(notes, { docTitle: getDocTitle() });
    if (thoughts) md = `${md}\n\n## 我的思考\n\n${thoughts}\n`;
    const base = String(getDocTitle() || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'PaperLens';
    try {
      const { downloadMarkdownFile } = await import('../lib/obsidian-vault-fs.js');
      downloadMarkdownFile(`${base} · 科研笔记.md`, md);
      showToast('已下载笔记 Markdown');
    } catch (error) {
      showToast(String(error?.message || error || '下载失败'), true);
    }
  }

  /** Push notes into the user-picked vault folder (preferred) or Local REST API. */
  async function syncNotesToObsidian() {
    const cfg = getConfig() || {};
    if (!cfg.obsidianEnabled) {
      showToast('未启用 Obsidian：打开设置 →「Obsidian 本地库」勾选启用，并选择库文件夹', true);
      try { chrome.runtime.openOptionsPage?.(); } catch { /* noop */ }
      return;
    }
    const notes = loadResearchNotes(getDocKey());
    const notesMarkdown = formatResearchNotesMarkdown(notes, { docTitle: getDocTitle() });
    const thoughts = String(els.notesThought?.value || '').trim();
    if (!notes.items?.length && !thoughts) {
      showToast('没有可写入的笔记或思考', true);
      return;
    }
    if (els.notesObsidian) {
      els.notesObsidian.disabled = true;
      els.notesObsidian.textContent = '写入中…';
    }
    const payload = {
      folder: cfg.obsidianFolder || 'PaperLens',
      docTitle: getDocTitle() || getDocKey() || 'paper',
      notesMarkdown: notes.items?.length ? notesMarkdown : '',
      thoughts,
      appendOnly: Boolean(thoughts) && !notes.items?.length,
    };
    try {
      // 1) Preferred: write into the vault folder the user picked in Settings.
      const { upsertPaperNoteToVaultFolder, downloadMarkdownFile, pickObsidianVaultFolder } = await import('../lib/obsidian-vault-fs.js');
      let response = await upsertPaperNoteToVaultFolder(payload);
      if (response?.needPick) {
        showToast('请选择 Obsidian 库文件夹…');
        const picked = await pickObsidianVaultFolder();
        if (!picked.ok) {
          if (!picked.cancelled) showToast(picked.message || '未选择库文件夹', true);
          // Fall through to REST / download
        } else {
          response = await upsertPaperNoteToVaultFolder(payload);
        }
      }
      if (response?.ok) {
        finishObsidianWrite(response);
        return;
      }

      // 2) Optional REST API (advanced).
      if (cfg.hasObsidianKey) {
        response = await chrome.runtime.sendMessage({
          type: 'obsidian',
          action: 'upsertPaperNote',
          docTitle: payload.docTitle,
          notesMarkdown: payload.notesMarkdown,
          thoughts: payload.thoughts,
          appendOnly: payload.appendOnly,
        });
        if (response?.ok) {
          finishObsidianWrite({ ...response, method: 'rest' });
          return;
        }
      }

      // 3) Last resort: download .md so the user can save into the vault.
      const { buildPaperNoteMarkdown, buildPaperNotePath } = await import('../lib/obsidian-bridge.js');
      const md = payload.notesMarkdown || buildPaperNoteMarkdown({
        docTitle: payload.docTitle,
        thoughts: payload.thoughts,
      });
      const path = buildPaperNotePath({
        folder: payload.folder,
        docTitle: payload.docTitle,
      });
      const fileName = path.split('/').pop();
      downloadMarkdownFile(fileName, md.includes(payload.thoughts) ? md : `${md}\n\n## 我的思考\n\n${payload.thoughts || ''}`.trim());
      showToast(`已下载 ${fileName}：请保存到 Obsidian 库的 ${payload.folder}/ 目录`, true);
    } catch (error) {
      showToast(String(error?.message || error || '写入失败'), true);
    } finally {
      if (els.notesObsidian) {
        els.notesObsidian.disabled = false;
        els.notesObsidian.textContent = 'Obsidian';
      }
    }
  }

  function finishObsidianWrite(response) {
    const path = response.path || 'PaperLens/…';
    const where = response.vaultName
      ? `${response.vaultName}/${path}`
      : path;
    if (response.skipped) {
      showToast(response.message || '没有新内容');
      return;
    }
    if (els.notesThought) els.notesThought.value = '';
    if (response.created) {
      showToast(`已写入 Obsidian：${where}`);
    } else {
      showToast(`已追加到 Obsidian：${where}`);
    }
  }

  function contentWithEvidenceProvenance(content, evidence) {
    const body = String(content || '').trim();
    if (!body || !evidence || typeof evidence !== 'object') return body;
    const pages = [...new Set((evidence.citedPages?.length ? evidence.citedPages : evidence.pages || [])
      .map(Number).filter((page) => Number.isFinite(page) && page >= 1))];
    if (!pages.length && !evidence.support?.score) return body;
    const sources = Array.isArray(evidence.sourceTypes) ? evidence.sourceTypes : [];
    const sourceLabel = sources.includes('source') && sources.includes('translation')
      ? 'PDF 原文 + 译文'
      : sources.includes('source') ? 'PDF 原文' : sources.includes('translation') ? '译文' : '';
    const meta = [
      pages.length ? `证据页：${pages.map((page) => `第 ${page} 页`).join('、')}` : '',
      sourceLabel ? `来源：${sourceLabel}` : '',
      Number.isFinite(Number(evidence.support?.score))
        ? `证据支持度：${evidence.support.score}%（仅表示可追溯性，不代表结论必然正确）`
        : '',
    ].filter(Boolean);
    return meta.length ? `${body}\n\n---\n\n${meta.join('；')}` : body;
  }

  function saveAnswerToNotes(entry, skillId = '') {
    const content = String(entry?.content || '').trim();
    if (!content) {
      showToast('没有可保存的内容', true);
      return;
    }
    appendResearchNote(getDocKey(), {
      title: noteTitleFromSkillOrText(skillId, content),
      content: contentWithEvidenceProvenance(content, entry?.evidence),
      source: skillId || 'ai',
    });
    if (notesDrawerOpen) renderNotesDrawer();
    showToast('已收入本篇笔记');
  }

  function renderEmptyState() {
    if (history.length) return;
    els.messages.replaceChildren();
    const empty = doc.createElement('div');
    empty.className = 'chat-empty';

    const isAgent = agentMode === 'agent';
    const hero = doc.createElement('div');
    hero.className = 'chat-empty-hero';
    hero.innerHTML = `
      <div class="chat-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="40" height="40">
          <rect x="6" y="10" width="36" height="26" rx="10" fill="currentColor" opacity=".12"/>
          <path d="M14 20h20M14 26h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/>
          <circle cx="34" cy="32" r="7" fill="currentColor"/>
          <path d="M31.5 32h5M34 29.5v5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </div>
      <h3 class="chat-empty-title">${isAgent ? '科研助手 · 深读' : '科研助手 · 快问'}</h3>
      <p class="chat-empty-tip">${isAgent
    ? '会查阅各页译文、检索关键词，用「第 N 页」标证据。点上方「一键导读」生成 briefing，重要回答可收入笔记。'
    : '适合解释选中段落与页图。需要跨页取证时切换到「深读」，或直接点技能按钮。'}</p>
    `;
    empty.appendChild(hero);

    const primary = doc.createElement('button');
    primary.type = 'button';
    primary.className = 'chat-briefing-cta';
    primary.innerHTML = '<span class="chat-briefing-cta-label">✦ 一键导读</span><span class="chat-briefing-cta-sub">问题 · 方法 · 实验 · 局限（带页码）</span>';
    primary.addEventListener('click', () => { void runResearchSkill('briefing'); });
    empty.appendChild(primary);

    const sectionLabel = doc.createElement('div');
    sectionLabel.className = 'chat-starter-label';
    sectionLabel.textContent = isAgent ? '深读示例' : '快问示例';
    empty.appendChild(sectionLabel);

    const chips = doc.createElement('div');
    chips.className = 'chat-starter-chips';
    const prompts = isAgent ? defaultResearchAgentStarters() : defaultChatStarterPrompts();
    prompts.forEach((prompt, index) => {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-starter-chip';
      chip.title = prompt;
      chip.innerHTML = `
        <span class="chat-starter-index">${index + 1}</span>
        <span class="chat-starter-text">${escapeChipText(prompt)}</span>
        <span class="chat-starter-arrow" aria-hidden="true">→</span>
      `;
      chip.addEventListener('click', () => {
        setOpen(true);
        els.input.value = prompt;
        autosizeInput();
        if (activeRequestId == null && !agentRunning) submit();
        else els.input.focus();
      });
      chips.appendChild(chip);
    });
    empty.appendChild(chips);
    els.messages.appendChild(empty);
  }

  function escapeChipText(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isMessagesNearBottom() {
    if (!els.messages) return true;
    return els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight <= 72;
  }

  function syncScrollBottomButton() {
    if (!els.scrollBottom) return;
    els.scrollBottom.hidden = !autoScrollPaused;
  }

  function scrollToBottom({ force = false } = {}) {
    if (!els.messages) return;
    if (!force && autoScrollPaused) {
      syncScrollBottomButton();
      return;
    }
    programmaticScroll = true;
    els.messages.scrollTop = els.messages.scrollHeight;
    autoScrollPaused = false;
    syncScrollBottomButton();
    const release = () => { programmaticScroll = false; };
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(release);
    else setTimeout(release, 0);
  }

  function refreshAttachmentsVisibility() {
    if (!els.attachments) return;
    const open = Boolean(
      (els.quote && !els.quote.hidden)
      || (els.pageAttach && !els.pageAttach.hidden),
    );
    els.attachments.classList.toggle('is-open', open);
  }

  function setQuote({ selection = '', context = '' } = {}) {
    const excerpt = clipSelectionExcerpt(selection);
    if (!excerpt) {
      clearQuote();
      return;
    }
    pendingQuote = {
      selection: excerpt,
      context: clipSelectionExcerpt(context),
    };
    if (!els.quote) return;
    els.quote.hidden = false;
    els.quoteText.textContent = formatSelectionQuotePreview(excerpt);
    els.quoteText.title = excerpt;
    refreshAttachmentsVisibility();
    updateInputPlaceholder();
  }

  function clearQuote() {
    pendingQuote = null;
    if (els.quote) {
      els.quote.hidden = true;
      if (els.quoteText) {
        els.quoteText.textContent = '';
        els.quoteText.removeAttribute('title');
      }
    }
    refreshAttachmentsVisibility();
    updateInputPlaceholder();
  }

  function setPageImage({ dataUrl = '', pageNum = null } = {}) {
    const url = String(dataUrl || '').trim();
    if (!/^data:image\//i.test(url)) {
      clearPageImage();
      return;
    }
    pendingImage = {
      dataUrl: url,
      pageNum: Number.isFinite(Number(pageNum)) ? Number(pageNum) : null,
    };
    if (!els.pageAttach) return;
    els.pageAttach.hidden = false;
    els.pageThumb.src = url;
    els.pageNum.textContent = pendingImage.pageNum != null
      ? `第 ${pendingImage.pageNum} 页`
      : '当前页';
    refreshAttachmentsVisibility();
    updateInputPlaceholder();
  }

  function clearPageImage() {
    pendingImage = null;
    if (els.pageAttach) {
      els.pageAttach.hidden = true;
      if (els.pageThumb) els.pageThumb.removeAttribute('src');
      if (els.pageNum) els.pageNum.textContent = '';
    }
    refreshAttachmentsVisibility();
    updateInputPlaceholder();
  }

  function updateInputPlaceholder() {
    if (!els.input) return;
    if (pendingQuote && pendingImage) {
      els.input.placeholder = '针对引用与页图提问…';
    } else if (pendingQuote) {
      els.input.placeholder = '针对引用继续提问…';
    } else if (pendingImage) {
      els.input.placeholder = '针对页图提问，可留空直接发送…';
    } else {
      els.input.placeholder = agentMode === 'agent'
        ? '深读：例如「第 7 页算法在做什么？复杂度怎么来的？」'
        : '快问：解释选区，或附页图提问…';
    }
  }

  async function attachCurrentPageImage() {
    mount();
    setOpen(true);
    if (typeof capturePageImage !== 'function') {
      showToast('当前没有可截取的 PDF 页面', true);
      return;
    }
    els.pageBtn.disabled = true;
    els.pageBtn.textContent = '…';
    try {
      const shot = await capturePageImage();
      if (!shot?.dataUrl) {
        showToast('截取当前页失败，请稍后再试', true);
        return;
      }
      setPageImage(shot);
      showToast(`已附上第 ${shot.pageNum || '?'} 页截图`);
      els.input?.focus();
    } catch (error) {
      showToast(String(error?.message || error || '截取当前页失败'), true);
    } finally {
      els.pageBtn.disabled = false;
      els.pageBtn.textContent = '页图';
    }
  }

  function addBubble(role, content, { entry = null, skillId = '' } = {}) {
    const empty = els.messages.querySelector('.chat-empty');
    if (empty) empty.remove();
    const bubble = doc.createElement('div');
    bubble.className = `chat-msg chat-msg-${role}`;
    const body = doc.createElement('div');
    body.className = 'chat-bubble';
    bubble.appendChild(body);
    const resolvedSkill = skillId || entry?.skillId || '';

    if (role === 'user' && entry?.images?.length) {
      const media = doc.createElement('div');
      media.className = 'chat-bubble-media';
      for (const url of entry.images) {
        const img = doc.createElement('img');
        img.className = 'chat-bubble-image';
        img.src = url;
        img.alt = entry.pageNum != null ? `第 ${entry.pageNum} 页` : '页图';
        media.appendChild(img);
      }
      if (entry.pageNum != null) {
        const cap = doc.createElement('div');
        cap.className = 'chat-bubble-image-cap';
        cap.textContent = `第 ${entry.pageNum} 页`;
        media.appendChild(cap);
      }
      body.appendChild(media);
    } else if (role === 'user' && entry?.hadImage && !entry?.images?.length) {
      const cap = doc.createElement('div');
      cap.className = 'chat-bubble-image-cap chat-bubble-image-cap-only';
      cap.textContent = entry.pageNum != null
        ? `（历史记录：曾附第 ${entry.pageNum} 页截图）`
        : '（历史记录：曾附页面截图）';
      body.appendChild(cap);
    }

    if (role === 'assistant') {
      renderAssistantContent(body, content || '');
      const actions = doc.createElement('div');
      actions.className = 'chat-msg-actions';
      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'chat-msg-action';
      copyBtn.textContent = '复制';
      copyBtn.title = '复制回答';
      copyBtn.addEventListener('click', async () => {
        const text = entry?.content || body.innerText || body.textContent || '';
        try {
          await globalThis.navigator?.clipboard?.writeText(String(text));
          copyBtn.textContent = '已复制';
          setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
        } catch {
          showToast('复制失败，请手动选择文本', true);
        }
      });
      actions.appendChild(copyBtn);

      if (entry) {
        const noteBtn = doc.createElement('button');
        noteBtn.type = 'button';
        noteBtn.className = 'chat-msg-action chat-msg-note';
        noteBtn.textContent = '收入笔记';
        noteBtn.title = '把本条回答收入本篇科研笔记';
        noteBtn.hidden = !String(entry.content || content || '').trim();
        noteBtn.addEventListener('click', () => saveAnswerToNotes(entry, resolvedSkill));
        actions.appendChild(noteBtn);
        bubble._noteBtn = noteBtn;

        const retryBtn = doc.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'chat-msg-action chat-msg-retry';
        retryBtn.textContent = '重试';
        retryBtn.title = '用同一问题重新生成';
        retryBtn.hidden = true;
        retryBtn.addEventListener('click', () => retryAssistantEntry(entry, bubble));
        actions.appendChild(retryBtn);
        bubble._retryBtn = retryBtn;
      }
      bubble.appendChild(actions);
    } else {
      const text = String(content || '');
      if (text) {
        const textNode = doc.createElement('div');
        textNode.className = 'chat-bubble-text';
        textNode.textContent = text;
        body.appendChild(textNode);
      }
    }

    els.messages.appendChild(bubble);
    if (role === 'assistant' && Array.isArray(entry?.toolSteps) && entry.toolSteps.length) {
      renderToolTrail(bubble, entry.toolSteps);
    }
    if (role === 'assistant' && entry?.evidence) renderEvidenceMeta(bubble, entry.evidence);
    scrollToBottom({ force: role === 'user' });
    return { el: bubble, textEl: body };
  }

  function renderAssistantContent(target, text, { linkify = true } = {}) {
    const value = String(text || '');
    if (!value.trim()) {
      target.classList.add('chat-bubble-pending');
      target.textContent = '思考中…';
      return;
    }
    target.classList.remove('chat-bubble-pending');
    if (typeof renderMarkdown === 'function') {
      try {
        renderMarkdown(target, value);
        if (linkify) enhanceAssistantBubble(target);
        return;
      } catch { /* 降级纯文本 */ }
    }
    target.textContent = value;
    if (linkify) enhanceAssistantBubble(target);
  }

  function setBusy(busy, label) {
    if (!els.send) return;
    els.root?.setAttribute('aria-busy', busy ? 'true' : 'false');
    els.send.disabled = false;
    const text = busy ? (label || '停止') : '发送';
    if (els.sendLabel) els.sendLabel.textContent = text;
    else els.send.textContent = text;
    els.send.classList.toggle('is-busy', busy);
    if (els.pageBtn) els.pageBtn.disabled = !!busy;
    if (els.export) els.export.disabled = false;
    for (const btn of els.modeBtns || []) btn.disabled = !!busy;
    if (els.skills) {
      for (const btn of els.skills.querySelectorAll('button')) btn.disabled = !!busy;
    }
    if (els.notesBtn) els.notesBtn.disabled = false;
  }

  function submit() {
    if (activeRequestId != null || agentRunning) {
      cancelActive();
      return;
    }
    const typed = normalizeChatText(els.input.value);
    let text = composeUserMessageWithQuote({
      question: typed,
      selection: pendingQuote?.selection || '',
      context: pendingQuote?.context || '',
    });
    const images = pendingImage?.dataUrl ? [pendingImage.dataUrl] : [];
    if (!text && images.length) {
      text = defaultPageImageQuestion(pendingImage.pageNum);
    }
    if (!text && !images.length) return;

    const cfg = getConfig() || {};
    if (cfg.hasApiKey === false) {
      showToast('尚未配置 API Key，点击工具栏图标 → 设置', true);
      return;
    }

    const userEntry = {
      role: 'user',
      content: text,
      ...(images.length ? { images, pageNum: pendingImage?.pageNum ?? null } : {}),
    };
    history.push(userEntry);
    if (els.messages.querySelector('.chat-empty')) els.messages.replaceChildren();
    addBubble('user', text, { entry: userEntry });
    els.input.value = '';
    clearQuote();
    clearPageImage();
    autosizeInput();

    // Deep-read if mode is agent, or smart-upgrade when question needs multi-page evidence.
    const useAgent = agentMode === 'agent'
      || (shouldUseResearchAgent(text) && typeof paperTools?.getCurrentPage === 'function' && !images.length);
    if (useAgent) {
      if (agentMode !== 'agent' && shouldUseResearchAgent(text)) {
        showToast('已自动使用深读取证');
      }
      void startAgentRequest(text);
      return;
    }
    startRequest();
  }

  function startRequest() {
    const cfg = getConfig() || {};
    let quickPaperContext = '';
    try {
      const current = paperTools?.getCurrentPage?.() || {};
      const page = Number(current.page);
      const text = String(current.text || '').trim();
      if (text) {
        quickPaperContext = [
          '',
          '## 当前论文页上下文（快问模式自动附带）',
          `当前页：第 ${Number.isFinite(page) ? page : '?'} 页；状态：${current.status || '已加载'}`,
          '以下内容仅用于回答当前论文问题；若依据它得出结论，请明确写出页码。',
          text.slice(0, 4200),
        ].join('\n');
      }
    } catch { /* no open paper */ }
    const messages = buildChatMessages(history, {
      targetLang: cfg.targetLang || '简体中文',
      systemPrompt: `${chatSystemPrompt(cfg.targetLang || '简体中文')}${quickPaperContext}`,
    });
    const assistantEntry = { role: 'assistant', content: '' };
    history.push(assistantEntry);
    const bubble = addBubble('assistant', '', { entry: assistantEntry });
    streamingBubble = { entry: assistantEntry, ...bubble };
    setBusy(true);

    let streamed = '';
    let handle;
    // 节流渲染：长回答每个 delta 全量重渲 Markdown 会卡 UI，100ms 一次足够流畅。
    const streamRender = createThrottledRenderer(() => {
      renderAssistantContent(bubble.textEl, streamed);
      scrollToBottom();
    });
    try {
      handle = sendChat(messages, (delta) => {
        if (!handle || activeRequestId !== handle.id) return;
        streamed += String(delta || '');
        assistantEntry.content = streamed;
        streamRender.schedule();
      }, (phase) => {
        if (!handle || activeRequestId !== handle.id || streamed) return;
        if (phase === 'thinking') renderAssistantContent(bubble.textEl, '');
      });
    } catch (error) {
      streamRender.dispose();
      finishStreaming(assistantEntry, bubble, streamed, error);
      return;
    }
    activeRequestId = handle.id;
    handle.promise.then(({ full }) => {
      if (activeRequestId !== handle.id) return;
      streamRender.dispose();
      finishStreaming(assistantEntry, bubble, String(full || streamed || ''));
    }).catch((error) => {
      if (activeRequestId !== handle.id) return;
      streamRender.dispose();
      finishStreaming(assistantEntry, bubble, streamed, error);
    });
  }

  /** Multi-step research agent: model CALLs tools, viewer executes, then FINAL. */
  async function startAgentRequest(userText, { skillId = '', autoNote = false } = {}) {
    if (typeof paperTools?.getCurrentPage !== 'function') {
      showToast('请先打开 PDF 再使用深读助手', true);
      startRequest();
      return;
    }

    const cfg = getConfig() || {};
    const targetLang = cfg.targetLang || '简体中文';
    const assistantEntry = { role: 'assistant', content: '', skillId: skillId || undefined };
    history.push(assistantEntry);
    const bubble = addBubble('assistant', '', { entry: assistantEntry, skillId });
    streamingBubble = { entry: assistantEntry, ...bubble };
    agentAbort = false;
    agentRunning = true;
    setBusy(true, '停止');
    refreshPaperContext();

    const toolSteps = [];
    // Pure multi-turn dialogue (latest user question stays last). Paper snapshot
    // goes into the system prompt so follow-ups keep conversational focus.
    const working = assembleAgentDialogueTurns(history, {
      excludeEntry: assistantEntry,
      maxTurns: RESEARCH_AGENT_MAX_HISTORY_TURNS,
    });

    if (typeof paperTools?.prepareEvidence === 'function') {
      renderAssistantContent(bubble.textEl, '_正在更新本地论文索引…_', { linkify: false });
      scrollToBottom();
      try {
        const prepared = await paperTools.prepareEvidence({ timeoutMs: 650 });
        toolSteps.push({
          name: 'prepare_evidence',
          label: `本地索引 ${Number(prepared?.readyPages) || 0}/${Number(prepared?.totalPages) || '?'} 页`,
          ok: true,
          page: null,
        });
      } catch {
        toolSteps.push({ name: 'prepare_evidence', label: '本地索引部分可用', ok: false, page: null });
      }
    }

    const evidenceQuery = buildContextualEvidenceQuery(working.slice(0, -1), userText);
    const bootstrap = buildAgentBootstrap(paperTools, { query: evidenceQuery });
    const priorEvidence = buildPriorEvidenceBrief(history);
    toolSteps.push(...bootstrap.steps);
    const consultedPages = new Set([
      ...(bootstrap.evidencePages || []),
      ...(priorEvidence.pages || []),
      ...(Number(bootstrap.currentPage) >= 1 ? [Number(bootstrap.currentPage)] : []),
    ]);
    const consultedSourceTypes = new Set(bootstrap.evidenceSourceTypes || []);
    let consultedEvidenceItems = normalizeEvidenceItems([
      ...(bootstrap.evidenceItems || []),
      ...(priorEvidence.items || []),
    ]);
    let executedToolSignatures = new Set();
    if (bootstrap.warning) {
      showToast(bootstrap.warning, bootstrap.translatedCount <= 0);
    }
    const agentSystemPrompt = researchAgentSystemPrompt(targetLang, {
      paperBrief: bootstrap.paperBrief,
      currentPageBrief: bootstrap.currentPageBrief,
      evidenceBrief: bootstrap.evidenceBrief,
      priorEvidenceBrief: priorEvidence.text,
    });

    renderToolTrail(bubble.el, toolSteps);
    showProgressUi(bubble, toolSteps, bootstrap.translatedCount <= 0
      ? '几乎没有已译页，仍尝试作答…'
      : (working.length > 1 ? '结合上文继续深读…' : '已加载论文上下文，思考中…'));

    const showProgress = (headline) => {
      showProgressUi(bubble, toolSteps, headline);
    };

    const finishAnswer = (answer) => {
      const clean = String(answer || '').trim();
      // Persist clean answer; trail/follow-ups are live UI chrome.
      assistantEntry.content = clean;
      assistantEntry.toolSteps = toolSteps.slice();
      const citationAudit = auditAnswerCitations(clean, {
        totalPages: bootstrap.totalPages,
        evidencePages: [...new Set([
          ...(bootstrap.evidencePages || []),
          ...(priorEvidence.pages || []),
        ])],
        consultedPages: [...consultedPages],
      });
      const support = scoreEvidenceSupport({ audit: citationAudit, items: consultedEvidenceItems });
      assistantEntry.evidence = {
        ...citationAudit,
        pages: citationAudit.evidencePages,
        sourceTypes: [...consultedSourceTypes],
        items: consultedEvidenceItems,
        support,
      };
      renderAssistantContent(bubble.textEl, clean || '（模型未返回内容）');
      renderToolTrail(bubble.el, toolSteps);
      renderEvidenceMeta(bubble.el, assistantEntry.evidence);
      if (bubble.el?._noteBtn) bubble.el._noteBtn.hidden = !clean;
      renderFollowUps(bubble.el, assistantEntry, skillId);
      if (autoNote && clean) {
        appendResearchNote(getDocKey(), {
          title: noteTitleFromSkillOrText(skillId, clean),
          content: contentWithEvidenceProvenance(clean, assistantEntry.evidence),
          source: skillId || 'briefing',
        });
        if (notesDrawerOpen) renderNotesDrawer();
        showToast('导读已收入本篇笔记');
      }
      schedulePersistSession();
      scrollToBottom();
      agentRunning = false;
      setBusy(false);
      streamingBubble = null;
    };

    try {
      for (let round = 0; round < RESEARCH_AGENT_MAX_ROUNDS; round += 1) {
        if (agentAbort) throw Object.assign(new Error('已取消'), { cancelled: true });

        showProgress(round === 0
          ? (working.length > 1 ? '结合上文思考中…' : '科研助手思考中…')
          : `正在深读（第 ${round + 1} 轮）…`);

        const messages = buildChatMessages(working, {
          targetLang,
          systemPrompt: agentSystemPrompt,
          // Keep full deep-read dialogue; don't cut mid-thread at 20.
          maxMessages: RESEARCH_AGENT_MAX_HISTORY_TURNS,
        });

        // 边流边显：模型直接作答（非 CALL）时实时渲染，不再等整轮结束。
        const preview = createAgentAnswerPreview(assistantEntry, bubble);
        assistantEntry.content = '';
        let reply;
        try {
          reply = await requestChatOnce(messages, {
            onStatus: (phase) => {
              if (phase === 'thinking' && !preview.started()) showProgress('科研助手思考中…');
            },
            onDelta: (_, streamedText) => preview.push(streamedText),
          });
        } finally {
          preview.dispose();
        }
        if (agentAbort) throw Object.assign(new Error('已取消'), { cancelled: true });

        const parsed = parseAgentResponse(reply);
        if (parsed.calls.length && round < RESEARCH_AGENT_MAX_ROUNDS - 1) {
          const deduped = dedupeResearchToolCalls(parsed.calls, executedToolSignatures);
          executedToolSignatures = deduped.signatures;
          const calls = deduped.calls;
          if (deduped.skipped.length) {
            toolSteps.push({
              name: 'dedupe',
              label: `跳过 ${deduped.skipped.length} 个重复调用`,
              ok: true,
              page: null,
            });
          }
          if (!calls.length) {
            working.push({ role: 'assistant', content: reply });
            working.push({
              role: 'user',
              content: '这些工具调用本会话已经执行过。请直接使用已有结果输出 FINAL；若确需新证据，请换检索词或页码。',
            });
            continue;
          }
          for (const call of calls) {
            toolSteps.push({
              name: call.name,
              label: formatToolCallLabel(call),
              ok: true,
              page: pageFromToolCall(call),
            });
          }
          showProgress(`执行：${calls.map((c) => formatToolCallLabel(c)).join(' · ')}`);
          const results = calls.map((call) => executeResearchTool(call, paperTools));
          results.forEach((result, i) => {
            const step = toolSteps[toolSteps.length - results.length + i];
            if (step) step.ok = result.ok !== false;
            const call = calls[i];
            const page = pageFromToolCall(call);
            if (page) consultedPages.add(page);
            if (call?.name === 'get_page_range') {
              const start = Math.max(1, Math.round(Number(call.args?.start) || 1));
              const end = Math.min(start + 5, Math.round(Number(call.args?.end) || start));
              for (let p = start; p <= end; p += 1) consultedPages.add(p);
            }
            for (const citedPage of extractPageCitations(result?.text || '')) consultedPages.add(citedPage);
            if (/PDF 原文|未译[·・]原文/u.test(String(result?.text || ''))) consultedSourceTypes.add('source');
            if (/\b译文\b|已完成/u.test(String(result?.text || ''))) consultedSourceTypes.add('translation');
            const dataItems = Array.isArray(result?.data?.matches)
              ? result.data.matches
              : Array.isArray(result?.data?.pages)
                ? result.data.pages.map((pageData) => ({
                    page: pageData.page,
                    snippet: pageData.text,
                    sourceType: /^\s*\[未译/u.test(String(pageData.text || '')) ? 'source' : 'translation',
                  }))
                : result?.data?.page
                  ? [{
                      page: result.data.page,
                      snippet: result.data.text,
                      sourceType: /^\s*\[未译/u.test(String(result.data.text || '')) ? 'source' : 'translation',
                    }]
                  : [];
            consultedEvidenceItems = normalizeEvidenceItems([
              ...consultedEvidenceItems,
              ...dataItems,
            ]);
          });
          working.push({ role: 'assistant', content: reply });
          working.push({ role: 'user', content: formatToolResultsForModel(results) });
          refreshPaperContext();
          continue;
        }

        finishAnswer(parsed.finalAnswer || reply);
        return;
      }

      working.push({
        role: 'user',
        content: '工具轮次已用尽。请不要再 CALL，直接输出 FINAL 与最终回答，并在要点后标注「第 N 页」。',
      });
      const messages = buildChatMessages(working, {
        targetLang,
        systemPrompt: agentSystemPrompt,
        maxMessages: RESEARCH_AGENT_MAX_HISTORY_TURNS,
      });
      const preview = createAgentAnswerPreview(assistantEntry, bubble);
      assistantEntry.content = '';
      let reply;
      try {
        reply = await requestChatOnce(messages, {
          onDelta: (_, streamedText) => preview.push(streamedText),
        });
      } finally {
        preview.dispose();
      }
      const parsed = parseAgentResponse(reply);
      finishAnswer(parsed.finalAnswer || reply);
    } catch (error) {
      agentRunning = false;
      if (error?.cancelled) {
        if (!assistantEntry.content?.trim() || /思考中|深读|执行：|快照/.test(assistantEntry.content)) {
          removeEntry(assistantEntry, bubble);
        } else {
          renderAssistantContent(bubble.textEl, assistantEntry.content);
        }
        setBusy(false);
        streamingBubble = null;
        return;
      }
      finishStreaming(assistantEntry, bubble, assistantEntry.content || '', error);
    }
  }

  function showProgressUi(bubble, toolSteps, headline) {
    renderToolTrail(bubble.el, toolSteps);
    renderAssistantContent(
      bubble.textEl,
      `_${String(headline || '思考中…')}_`,
      { linkify: false },
    );
    scrollToBottom();
  }

  function renderToolTrail(msgEl, steps) {
    if (!msgEl) return;
    msgEl.querySelector('.chat-tool-trail')?.remove();
    if (!Array.isArray(steps) || !steps.length) return;
    const trail = doc.createElement('div');
    trail.className = 'chat-tool-trail';
    const label = doc.createElement('span');
    label.className = 'chat-tool-trail-label';
    label.textContent = '查阅过程';
    trail.appendChild(label);
    const list = doc.createElement('div');
    list.className = 'chat-tool-trail-chips';
    steps.forEach((step) => {
      const chip = doc.createElement(step.page ? 'button' : 'span');
      if (step.page) chip.type = 'button';
      chip.className = `chat-tool-chip${step.ok === false ? ' is-error' : ''}${step.page ? ' is-page' : ''}`;
      chip.textContent = step.label || step.name || 'step';
      if (step.page) {
        chip.title = `跳到第 ${step.page} 页`;
        chip.addEventListener('click', () => jumpToPage(step.page));
      }
      list.appendChild(chip);
    });
    trail.appendChild(list);
    const bubbleEl = msgEl.querySelector('.chat-bubble');
    if (bubbleEl) msgEl.insertBefore(trail, bubbleEl);
    else msgEl.prepend(trail);
  }

  function renderEvidenceMeta(msgEl, evidence) {
    if (!msgEl) return;
    msgEl.querySelector('.chat-evidence-meta')?.remove();
    if (!evidence || typeof evidence !== 'object') return;
    const pages = [...new Set((evidence.pages || evidence.evidencePages || [])
      .map(Number).filter((page) => Number.isFinite(page) && page >= 1))];
    const cited = [...new Set((evidence.citedPages || [])
      .map(Number).filter((page) => Number.isFinite(page) && page >= 1))];
    const invalid = (evidence.invalidPages || []).map(Number).filter(Number.isFinite);
    const unsupported = (evidence.unsupportedPages || []).map(Number).filter(Number.isFinite);
    const sources = Array.isArray(evidence.sourceTypes) ? evidence.sourceTypes : [];
    const items = normalizeEvidenceItems(evidence.items || []);
    const support = evidence.support && Number.isFinite(Number(evidence.support.score))
      ? evidence.support
      : scoreEvidenceSupport({ audit: evidence, items });
    const supportScore = Math.max(0, Math.min(100, Math.round(Number(support?.score) || 0)));
    const supportLevel = ['strong', 'moderate', 'weak'].includes(support?.level) ? support.level : 'weak';

    const meta = doc.createElement('div');
    meta.className = `chat-evidence-meta is-support-${supportLevel}${evidence.ok ? ' is-verified' : (invalid.length || unsupported.length ? ' is-warning' : '')}`;
    const summary = doc.createElement('div');
    summary.className = 'chat-evidence-summary';
    const status = doc.createElement('span');
    status.className = 'chat-evidence-status';
    const statusIcon = doc.createElement('span');
    statusIcon.className = 'chat-evidence-status-icon';
    statusIcon.setAttribute('aria-hidden', 'true');
    statusIcon.innerHTML = evidence.ok
      ? '<svg viewBox="0 0 20 20" width="15" height="15"><path d="m4 10 3.4 3.4L16 5.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 20 20" width="15" height="15"><path d="M10 3 18 17H2z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 7v4.5m0 2.5v.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    const statusText = doc.createElement('span');
    if (evidence.ok) statusText.textContent = '证据已核验';
    else if (invalid.length || unsupported.length) statusText.textContent = '引用需核对';
    else if (!cited.length) statusText.textContent = '未标注页码';
    else statusText.textContent = '证据覆盖不足';
    status.append(statusIcon, statusText);
    summary.appendChild(status);

    const supportBadge = doc.createElement('span');
    supportBadge.className = 'chat-evidence-support';
    supportBadge.textContent = `${String(support?.label || '证据支持较弱')} ${supportScore}%`;
    supportBadge.setAttribute('aria-label', `证据支持度 ${supportScore}%，${String(support?.label || '较弱')}。只表示可追溯性，不代表结论必然正确。`);
    summary.appendChild(supportBadge);

    const source = doc.createElement('span');
    source.className = 'chat-evidence-source';
    if (sources.includes('source') && sources.includes('translation')) source.textContent = '原文 + 译文';
    else if (sources.includes('source')) source.textContent = '基于 PDF 原文';
    else if (sources.includes('translation')) source.textContent = '基于译文';
    if (source.textContent) summary.appendChild(source);

    const pageList = cited.length ? cited : pages.slice(0, 8);
    for (const page of pageList) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'chat-evidence-page';
      button.textContent = `第 ${page} 页`;
      button.title = `跳到第 ${page} 页核对`;
      button.addEventListener('click', () => jumpToPage(page));
      summary.appendChild(button);
    }
    if (pages.length > pageList.length) {
      const more = doc.createElement('span');
      more.className = 'chat-evidence-more';
      more.textContent = `另查 ${pages.length - pageList.length} 页`;
      summary.appendChild(more);
    }
    meta.appendChild(summary);

    const reasonTexts = [...new Set((Array.isArray(support?.reasons) ? support.reasons : [])
      .map((reason) => String(reason || '').trim()).filter(Boolean))];
    if (invalid.length || unsupported.length) {
      const issues = [];
      if (invalid.length) issues.push(`超出文档：${invalid.join('、')}`);
      if (unsupported.length) issues.push(`未在证据中查阅：${unsupported.join('、')}`);
      const issueEl = doc.createElement('div');
      issueEl.className = 'chat-evidence-issues';
      issueEl.textContent = `引用审计：${issues.join('；')}`;
      meta.appendChild(issueEl);
    } else if (!cited.length) {
      const issueEl = doc.createElement('div');
      issueEl.className = 'chat-evidence-issues';
      issueEl.textContent = '回答未明确写出“第 N 页”，建议继续追问并要求标注证据页。';
      meta.appendChild(issueEl);
    } else if (reasonTexts.length) {
      const hint = doc.createElement('div');
      hint.className = 'chat-evidence-hint';
      hint.textContent = reasonTexts.slice(0, 3).join('；');
      meta.appendChild(hint);
    }

    if (items.length) {
      evidencePanelSeq += 1;
      const detailsId = `chat-evidence-details-${evidencePanelSeq}`;
      const toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'chat-evidence-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', detailsId);
      toggle.innerHTML = `<span>查看 ${items.length} 条证据</span><svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      const details = doc.createElement('div');
      details.id = detailsId;
      details.className = 'chat-evidence-details';
      details.hidden = true;
      const detailsHeader = doc.createElement('div');
      detailsHeader.className = 'chat-evidence-details-head';
      detailsHeader.textContent = '回答所依据的本地论文片段';
      details.appendChild(detailsHeader);
      const list = doc.createElement('ol');
      list.className = 'chat-evidence-list';
      items.forEach((item, index) => {
        const row = doc.createElement('li');
        row.className = 'chat-evidence-item';
        const head = doc.createElement('div');
        head.className = 'chat-evidence-item-head';
        const id = doc.createElement('span');
        id.className = 'chat-evidence-id';
        id.textContent = `E${index + 1}`;
        const pageButton = doc.createElement('button');
        pageButton.type = 'button';
        pageButton.className = 'chat-evidence-item-page';
        pageButton.textContent = `第 ${item.page} 页`;
        pageButton.title = `跳到第 ${item.page} 页核对原文`;
        pageButton.addEventListener('click', () => jumpToPage(item.page));
        const type = doc.createElement('span');
        type.className = `chat-evidence-type is-${item.sourceType}`;
        type.textContent = item.sourceType === 'source' ? 'PDF 原文' : '译文';
        head.append(id, pageButton, type);
        row.appendChild(head);
        if (item.heading) {
          const heading = doc.createElement('div');
          heading.className = 'chat-evidence-heading';
          heading.textContent = item.heading;
          row.appendChild(heading);
        }
        const quote = doc.createElement('blockquote');
        quote.className = 'chat-evidence-snippet';
        quote.textContent = item.snippet;
        row.appendChild(quote);
        if (Number.isFinite(Number(item.neighborOf)) && Number(item.neighborOf) >= 1) {
          const neighbor = doc.createElement('div');
          neighbor.className = 'chat-evidence-neighbor';
          neighbor.textContent = `邻页上下文：与第 ${item.neighborOf} 页证据相邻，用于补足上下文。`;
          row.appendChild(neighbor);
        }
        list.appendChild(row);
      });
      details.appendChild(list);
      const disclaimer = doc.createElement('p');
      disclaimer.className = 'chat-evidence-disclaimer';
      disclaimer.textContent = '证据支持度只衡量答案能否追溯到已查阅片段，不代表答案必然正确。';
      details.appendChild(disclaimer);
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'chat-evidence-collapse';
      close.textContent = '收起证据';
      details.appendChild(close);

      const setExpanded = (expanded) => {
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.classList.toggle('is-expanded', expanded);
        details.hidden = !expanded;
        toggle.querySelector('span').textContent = expanded ? `收起 ${items.length} 条证据` : `查看 ${items.length} 条证据`;
      };
      toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'));
      close.addEventListener('click', () => {
        setExpanded(false);
        toggle.focus();
      });
      meta.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || details.hidden) return;
        event.stopPropagation();
        setExpanded(false);
        toggle.focus();
      });
      meta.append(toggle, details);
    }
    const bubbleEl = msgEl.querySelector('.chat-bubble');
    if (bubbleEl) bubbleEl.after(meta);
    else msgEl.appendChild(meta);
  }

  function renderFollowUps(msgEl, entry, skillId = '') {
    if (!msgEl) return;
    msgEl.querySelector('.chat-followups')?.remove();
    const answer = String(entry?.content || '').trim();
    if (!answer) return;
    const actions = buildFollowUpActions(answer, { skillId: skillId || entry?.skillId || '' });
    if (!actions.length) return;
    const row = doc.createElement('div');
    row.className = 'chat-followups';
    actions.forEach((action) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-followup-chip';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { void handleFollowUp(action, entry); });
      row.appendChild(btn);
    });
    const actionsEl = msgEl.querySelector('.chat-msg-actions');
    if (actionsEl) actionsEl.after(row);
    else msgEl.appendChild(row);
  }

  async function handleFollowUp(action, entry) {
    if (!action) return;
    if (action.kind === 'goto' && action.page) {
      jumpToPage(action.page);
      return;
    }
    if (action.kind === 'note') {
      saveAnswerToNotes(entry, entry?.skillId || '');
      return;
    }
    if (action.kind === 'skill' && action.skillId) {
      void runResearchSkill(action.skillId);
      return;
    }
    if (action.kind === 'prompt' && action.prompt) {
      if (activeRequestId != null || agentRunning) {
        showToast('请先停止当前回复', true);
        return;
      }
      setOpen(true);
      els.input.value = action.prompt;
      autosizeInput();
      submit();
    }
  }

  /**
   * 深读模式的流式预览：模型若直接作答（首词非 CALL）则边流边渲染；
   * 若是工具调用则整段抑制，避免把协议文本闪现给用户。
   * entry.content 同步更新，因此中途取消也能保留已生成的部分回答。
   */
  function createAgentAnswerPreview(entry, bubble) {
    let mode = 'pending'; // pending → stream | suppress
    let cleaned = '';
    const throttled = createThrottledRenderer(() => {
      if (mode !== 'stream') return;
      renderAssistantContent(bubble.textEl, cleaned, { linkify: false });
      scrollToBottom();
    });
    return {
      started() { return mode === 'stream'; },
      push(streamedText) {
        if (mode === 'suppress') return;
        const head = String(streamedText || '').trimStart();
        if (mode === 'pending') {
          if (!head) return;
          if (/^CALL\b/.test(head)) { mode = 'suppress'; return; }
          // 等几个字符再判定，防止「C」「CA」误判为正文。
          if (head.length < 6 && !head.includes('\n')) return;
          mode = 'stream';
        }
        cleaned = head.replace(/^FINAL[ \t]*\r?\n?/i, '');
        if (!cleaned.trim()) return;
        entry.content = cleaned;
        throttled.schedule();
      },
      dispose() { throttled.dispose(); },
    };
  }

  function requestChatOnce(messages, { onStatus, onDelta } = {}) {
    return new Promise((resolve, reject) => {
      let streamed = '';
      let handle;
      try {
        handle = sendChat(messages, (delta) => {
          if (!handle || activeRequestId !== handle.id) return;
          streamed += String(delta || '');
          onDelta?.(String(delta || ''), streamed);
        }, (phase) => {
          if (!handle || activeRequestId !== handle.id) return;
          onStatus?.(phase);
        });
      } catch (error) {
        reject(error);
        return;
      }
      activeRequestId = handle.id;
      handle.promise.then(({ full }) => {
        if (activeRequestId === handle.id) activeRequestId = null;
        resolve(String(full || streamed || ''));
      }).catch((error) => {
        if (activeRequestId === handle.id) activeRequestId = null;
        reject(error);
      });
    });
  }

  function finishStreaming(entry, bubble, text, error) {
    activeRequestId = null;
    streamingBubble = null;
    setBusy(false);
    if (error && !error.cancelled) {
      entry.content = String(text || '');
      bubble.el.classList.add('chat-msg-error');
      bubble.textEl.classList.remove('chat-bubble-pending');
      const message = friendlyChatError(error);
      bubble.textEl.textContent = entry.content ? `${entry.content}\n\n（出错：${message}）` : `出错：${message}`;
      if (bubble.el._retryBtn) bubble.el._retryBtn.hidden = false;
      schedulePersistSession();
      return;
    }
    if (error?.cancelled) {
      entry.content = String(text || '');
      if (!entry.content.trim()) {
        removeEntry(entry, bubble);
        schedulePersistSession();
        return;
      }
    }
    const finalText = String(text || entry.content || '');
    entry.content = finalText;
    if (!finalText.trim()) {
      bubble.textEl.classList.remove('chat-bubble-pending');
      bubble.textEl.textContent = '（模型未返回内容）';
      if (bubble.el._retryBtn) bubble.el._retryBtn.hidden = false;
      schedulePersistSession();
      return;
    }
    renderAssistantContent(bubble.textEl, finalText);
    if (bubble.el?._noteBtn && finalText.trim()) bubble.el._noteBtn.hidden = false;
    scrollToBottom();
    schedulePersistSession();
  }

  function retryAssistantEntry(entry, bubbleEl) {
    if (activeRequestId != null || agentRunning) return;
    const index = history.indexOf(entry);
    if (index < 0) return;
    history.splice(index, 1);
    bubbleEl.remove();
    const last = history[history.length - 1];
    if (!last || last.role !== 'user') {
      showToast('没有可重试的问题', true);
      if (!history.length) renderEmptyState();
      return;
    }
    const useAgent = agentMode === 'agent'
      || shouldUseResearchAgent(last.content)
      || last.skillId;
    if (useAgent) {
      void startAgentRequest(last.content || '', { skillId: last.skillId || entry?.skillId || '' });
      return;
    }
    startRequest();
  }

  function removeEntry(entry, bubble) {
    const index = history.indexOf(entry);
    if (index >= 0) history.splice(index, 1);
    bubble.el.remove();
    if (!history.length) renderEmptyState();
  }

  function cancelActive() {
    agentAbort = true;
    if (activeRequestId != null) {
      sendChat.cancel?.(activeRequestId);
      return;
    }
    // Agent may be between tool rounds with no in-flight request id.
    if (agentRunning) {
      agentRunning = false;
      setBusy(false);
      streamingBubble = null;
    }
  }

  function clearConversation() {
    void startNewConversation();
  }

  function renderContentForPrint(text, role) {
    const value = String(text || '').trim();
    if (!value) return '';
    // User turns: keep plain pre-wrap (quotes / free text).
    if (role === 'user') {
      return `<div class="bubble user">${escapePrintHtmlSafe(value).replace(/\n/g, '<br>')}</div>`;
    }
    // Assistant: reuse the same Markdown + KaTeX renderer as the chat bubbles.
    if (typeof renderMarkdown === 'function') {
      const tmp = doc.createElement('div');
      tmp.className = 'export-md md';
      try {
        renderMarkdown(tmp, value);
        const rich = sanitizeExportHtml(tmp.innerHTML).trim();
        if (rich) return `<div class="bubble"><div class="export-md md">${rich}</div></div>`;
      } catch { /* fall through */ }
    }
    return `<div class="bubble plain">${escapePrintHtmlSafe(value).replace(/\n/g, '<br>')}</div>`;
  }

  function escapePrintHtmlSafe(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function exportConversationPdf() {
    mount();
    if (!history.length) {
      showToast('还没有可导出的对话');
      return;
    }
    const title = typeof getDocTitle === 'function' ? getDocTitle() : '';
    const assets = await loadPrintAssets();
    const html = buildPrintDocumentHtml({
      title: title ? `${title} · 对话` : 'PaperLens 对话导出',
      subtitle: new Date().toLocaleString('zh-CN'),
      sections: buildChatPrintSections(history, { renderToHtml: renderContentForPrint }),
      assets,
      footerNote: '由 PaperLens 导出 · 在打印对话框中选择「另存为 PDF」',
      printDelayMs: 520,
    });
    const result = openPrintHtmlWindow(html);
    if (!result.ok) {
      showToast(result.reason || '无法打开打印窗口', true);
      return;
    }
    showToast('已打开打印预览（含公式），可另存为 PDF');
  }

  async function exportConversationMd() {
    mount();
    if (!history.length) {
      showToast('还没有可导出的对话');
      return;
    }
    try {
      const docTitle = typeof getDocTitle === 'function' ? getDocTitle() : '';
      const markdown = exportConversationMarkdown(history, { docTitle });
      const filename = conversationExportFilename({ docTitle });
      const { downloadMarkdownFile } = await import('../lib/obsidian-vault-fs.js');
      downloadMarkdownFile(filename, markdown);
      showToast('已下载带证据溯源的 Markdown 对话记录');
    } catch (error) {
      showToast(String(error?.message || error || 'Markdown 导出失败'), true);
    }
  }

  function askAi(selection, {
    context = '',
    intent = ASK_AI_INTENTS.explain,
    autoSend = true,
  } = {}) {
    const excerpt = clipSelectionExcerpt(selection);
    if (!excerpt || !isAskableSelectionText(excerpt)) return;
    mount();
    setOpen(true);
    hideSelectionMenu();

    if (intent === ASK_AI_INTENTS.custom || !autoSend) {
      setQuote({ selection: excerpt, context });
      els.input.value = '';
      autosizeInput();
      els.input.focus();
      return;
    }

    const question = buildAskAiQuestion(excerpt, { context, intent });
    if (!question) return;
    clearQuote();
    els.input.value = question;
    autosizeInput();
    if (activeRequestId == null) submit();
    else els.input.focus();
  }

  function ensureSelectionMenu() {
    if (selectionMenu) return selectionMenu;
    const menu = doc.createElement('div');
    menu.className = 'chat-selection-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'toolbar');
    menu.setAttribute('aria-label', '对选中内容提问');
    const actions = [
      { intent: ASK_AI_INTENTS.explain, label: '解释', title: '请 AI 解释这段' },
      { intent: ASK_AI_INTENTS.plain, label: '白话', title: '用通俗白话解释' },
      { intent: ASK_AI_INTENTS.why, label: '为何', title: '这段在论证什么' },
      { intent: ASK_AI_INTENTS.custom, label: '追问', title: '挂上引用，自己写问题' },
    ];
    for (const action of actions) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-selection-action';
      btn.dataset.intent = action.intent;
      btn.textContent = action.label;
      btn.title = action.title;
      btn.addEventListener('mousedown', (event) => { event.preventDefault(); });
      btn.addEventListener('click', () => {
        const payload = menu._payload;
        hideSelectionMenu();
        if (!payload?.selection) return;
        askAi(payload.selection, {
          context: payload.context || '',
          intent: action.intent,
          autoSend: action.intent !== ASK_AI_INTENTS.custom,
        });
      });
      menu.appendChild(btn);
    }
    doc.body.appendChild(menu);
    selectionMenu = menu;
    return menu;
  }

  function hideSelectionMenu() {
    selectionMenuController?.abort();
    selectionMenuController = null;
    if (selectionMenu) {
      selectionMenu.hidden = true;
      selectionMenu._payload = null;
    }
  }

  function showSelectionMenu({ selection, context = '', anchorRect }) {
    if (!isAskableSelectionText(selection) || !anchorRect) return;
    const menu = ensureSelectionMenu();
    menu._payload = {
      selection: clipSelectionExcerpt(selection),
      context: clipSelectionExcerpt(context),
    };
    menu.hidden = false;
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const width = menu.offsetWidth || 200;
    const height = menu.offsetHeight || 36;
    const pad = 8;
    const vw = globalThis.innerWidth || 800;
    const vh = globalThis.innerHeight || 600;
    let left = anchorRect.left + (anchorRect.width / 2) - (width / 2);
    left = Math.max(pad, Math.min(left, vw - width - pad));
    let top = anchorRect.top - height - 8;
    if (top < pad) top = anchorRect.bottom + 8;
    top = Math.max(pad, Math.min(top, vh - height - pad));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';

    selectionMenuController?.abort();
    const controller = new AbortController();
    selectionMenuController = controller;
    doc.addEventListener('mousedown', (event) => {
      if (menu.contains(event.target)) return;
      hideSelectionMenu();
    }, { signal: controller.signal, capture: true });
    doc.addEventListener('scroll', () => hideSelectionMenu(), { signal: controller.signal, capture: true, passive: true });
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideSelectionMenu();
    }, { signal: controller.signal });
  }

  function handleMessageSelection() {
    if (!isOpen()) return;
    const sel = globalThis.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      hideSelectionMenu();
      return;
    }
    const range = sel.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor?.nodeType === 1 ? ancestor : ancestor?.parentElement;
    if (!ancestorEl || !els.messages?.contains(ancestorEl)) {
      hideSelectionMenu();
      return;
    }
    if (ancestorEl.closest?.('.chat-msg-actions, .chat-selection-menu, .chat-starter-chips, .chat-bubble-media')) {
      hideSelectionMenu();
      return;
    }
    const bubble = ancestorEl.closest?.('.chat-bubble, .chat-msg');
    if (!bubble || !els.messages.contains(bubble)) {
      hideSelectionMenu();
      return;
    }
    const text = clipSelectionExcerpt(sel.toString());
    if (!isAskableSelectionText(text)) {
      hideSelectionMenu();
      return;
    }
    const full = clipSelectionExcerpt(bubble.innerText || bubble.textContent || '');
    const context = full && full !== text ? full : '';
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hideSelectionMenu();
      return;
    }
    showSelectionMenu({ selection: text, context, anchorRect: rect });
  }

  /** 把原始错误翻译成用户能行动的提示（保留原文，追加下一步建议）。 */
  function friendlyChatError(error) {
    const raw = String(error?.message || error || '').trim() || '请求失败';
    const statusMatch = /HTTP\s+(\d{3})/.exec(raw);
    const status = Number(error?.status) || (statusMatch ? Number(statusMatch[1]) : 0);
    if (/超时/.test(raw)) return `${raw}。长论文或推理模型响应慢时可稍后重试。`;
    if (status === 401 || status === 403) return `${raw}。请到设置检查 AI 助手所用 Profile 的 API Key 与权限。`;
    if (status === 429) return `${raw}。请求过于频繁或额度不足，稍等片刻再试。`;
    if (status >= 500) return `${raw}。服务端暂时不可用，稍后重试即可。`;
    if (/Failed to fetch|NetworkError|fetch failed/i.test(raw)) {
      return '网络请求失败：请检查网络连接 / 代理，以及 Base URL 是否可访问。';
    }
    return raw;
  }

  return {
    mount,
    setOpen,
    toggle,
    isOpen,
    askAi,
    setQuote,
    clearQuote,
    setPageImage,
    clearPageImage,
    attachCurrentPageImage,
    exportConversationPdf,
    startNewConversation,
    openHistory: () => { mount(); setHistoryDrawerOpen(true); },
    openNotes: () => { mount(); setNotesDrawerOpen(true); },
    runSkill: (id) => { void runResearchSkill(id); },
    toggleCommand: () => {
      if (skillPaletteOpen) closeSkillPalette();
      else openSkillPalette();
    },
    refreshModelLabel,
    refreshPaperContext,
    setAgentMode,
    clear: clearConversation,
    _getHistory: () => history.slice(),
    _getPendingQuote: () => (pendingQuote ? { ...pendingQuote } : null),
    _getPendingImage: () => (pendingImage ? { ...pendingImage } : null),
    _getSessionId: () => sessionId,
  };
}
