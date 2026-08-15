// PaperLens Desktop 渲染进程 — 科研工作台
// 形态：左侧导航 7 视图（首页/阅读/文库/雷达/投稿/知识库/统计）+ 右侧 Agent 抽屉。
// 阅读器对齐扩展：左原文 PDF（textLayer 划词）| 右结构化译文，双栏联动、双击定位、框选提问。
/* global window, document, pdfjsLib, marked, renderMathInElement */
import { renderMarkdownWithMath } from '../../src/lib/markdown-math.js';
import { extractAnchors, findBestSpanWindow, findBlockForWord, positionRatioFallback } from '../lib/anchor-match.mjs';
import {
  emptyTabState, openTab, setActiveTab, closeTab, updateTabProgress,
  activeTab, tabLabel,
} from '../lib/reader-tabs.mjs';
import { findHighlightSpanRange } from '../lib/highlights-store.mjs';
import { draftPromptForKind, lineDiff } from '../lib/writing-draft.mjs';
import {
  buildPageInsight,
  contributionBulletsFromClaims,
  addToCompareQueue,
  removeFromCompareQueue,
  normalizeCompareQueue,
  buildBatchComparePrompt,
} from '../lib/page-insight.mjs';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  docTitle: $('doc-title'),
  log: $('log'),
  welcome: $('welcome'),
  form: $('ask-form'),
  input: $('ask-input'),
  askBtn: $('ask-btn'),
  hint: $('composer-hint'),
  settings: $('settings'),
  modelBadge: $('model-badge'),
  pdfPane: $('pdf-pane'),
  paperEmpty: $('paper-empty'),
  pdfPages: $('pdf-pages'),
  transEmpty: $('trans-empty'),
  transPages: $('trans-pages'),
  divider: $('pane-divider'),
  workspace: $('workspace'),
  statusMsg: $('status-msg'),
  statusBar: $('status-bar'),
  statusPage: $('status-page'),
  statusTranslated: $('status-translated'),
  recentList: $('recent-list'),
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
let toastTimer = null;
function toast(message, isError = false) {
  let node = document.querySelector('.toast');
  if (node) node.remove();
  node = el('div', `toast${isError ? ' err' : ''}`, String(message || ''));
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}
let statusTimer = null;
function setStatus(message, isError = false) {
  els.statusMsg.textContent = String(message || '');
  els.statusMsg.classList.toggle('err', Boolean(isError));
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => { els.statusMsg.textContent = ''; }, 7000);
}

// ---------------------------------------------------------------------------
// Markdown + KaTeX
// ---------------------------------------------------------------------------
function renderMarkdownInto(node, text) {
  renderMarkdownWithMath(node, text, {
    parse: (s) => (typeof marked?.parse === 'function' ? marked.parse(s) : ''),
    autoRender: typeof renderMathInElement === 'function' ? renderMathInElement : null,
  });
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------
const VIEWS = ['home', 'reader', 'library', 'radar', 'submit', 'kb', 'write', 'stats'];
let currentView = 'home';
function switchView(name) {
  if (!VIEWS.includes(name)) return;
  currentView = name;
  for (const v of VIEWS) {
    const view = $(`view-${v}`);
    if (view) view.classList.toggle('active', v === name);
  }
  for (const btn of document.querySelectorAll('.nav-item[data-view]')) {
    btn.classList.toggle('active', btn.dataset.view === name);
  }
  // 切到阅读器但没打开论文 → 显示空态
  if (name === 'reader') {
    // 切入阅读视图后强制检查：适宽下空白页重新渲染
    requestAnimationFrame(() => {
      if (!paperPages.length) return;
      for (const record of paperPages.slice(0, 3)) {
        if (!record.rendered || (record.canvas && record.canvas.width < 10)) {
          record.rendered = false;
          void ensurePageRendered(record).catch(() => {});
        }
      }
    });
  }
  if (name === 'reader' && !paperPages.length) {
    // 保持空态即可
  }
  // 各视图懒加载
  if (name === 'library') void renderLibrary();
  if (name === 'radar' && !radarLoaded) void refreshRadar();
  if (name === 'submit' && !submitLoaded) void renderSubmit();
  if (name === 'kb') {
    if (!kbLoaded) void renderKbOverview();
    void renderGlossaryList();
  }
  if (name === 'write') void renderWriteView();
  if (name === 'stats') void renderStats();
  if (name === 'home') void renderHome();
}
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelectorAll('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.goto));
});

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------
async function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('btn-theme').textContent = theme === 'dark' ? '◑' : '◐';
  if (window.paperlens.setUiPrefs) await window.paperlens.setUiPrefs({ theme });
}
$('btn-theme').addEventListener('click', async () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  await applyTheme(next);
  toast(next === 'dark' ? '已切换夜间模式（PDF 反色护眼）' : '已切换日间模式');
});

// ---------------------------------------------------------------------------
// Agent 抽屉
// ---------------------------------------------------------------------------
const TOOL_LABELS = {
  search_arxiv: 'arXiv 检索', lookup_citation: '查引用文献', fetch_url: '抓取网页',
  read_paper_page: '读论文页', read_paper_pages: '连读多页', search_paper_text: '检索论文全文',
  get_paper_overview: '论文概览', save_research_note: '写入笔记',
  list_project_memory: '课题记忆', add_research_todo: '添加待办', complete_research_todo: '完成待办',
  remember_research_fact: '记住要点',
  export_markdown_report: '导出 Markdown', prepare_overleaf_section: 'Overleaf 草稿', export_bibtex_stub: '导出 BibTeX',
  search_knowledge_base: '检索知识库', read_knowledge_note: '读知识库笔记', get_knowledge_base_overview: '知识库概览',
  fetch_frontier_papers: '抓前沿论文', add_to_reading_list: '加入待读', list_reading_list: '查待读清单',
  list_submission_deadlines: '查投稿 DDL',
  show_page_to_user: '带你看这页',
  list_user_highlights: '读你的高亮',
};
let active = null;
let chatBusy = false;
let pendingAttachment = null; // { dataUrl, label }

function setChatOpen(open) {
  $('chat-drawer').hidden = !open;
  document.body.classList.toggle('chat-open', open);
  $('btn-chat').classList.toggle('active', open);
  if (open) { els.input.focus(); closeDrawersExcept('chat'); refreshComposerCtx(); }
  // 停靠改变了工作区宽度：阅读器打开时按新宽度适配 PDF
  if (paperPages.length && zoomScale == null) {
    clearTimeout(setChatOpen._t);
    setChatOpen._t = setTimeout(() => void reRenderAllPages(), 260);
  }
}

// Gen1: Agent 面板宽度可拖拽（持久化到 UI 偏好）
(() => {
  const grip = $('chat-resize');
  if (!grip) return;
  let startX = 0; let startW = 0; let resizing = false;
  grip.addEventListener('pointerdown', (e) => {
    resizing = true; startX = e.clientX;
    startW = $('chat-drawer').getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('chat-resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = Math.min(Math.round(window.innerWidth * 0.55), Math.max(300, startW + (startX - e.clientX)));
    document.documentElement.style.setProperty('--chat-w', `${w}px`);
  });
  grip.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove('chat-resizing');
    const w = Math.round($('chat-drawer').getBoundingClientRect().width);
    void window.paperlens.setUiPrefs?.({ chatWidth: w });
    if (paperPages.length && zoomScale == null) void reRenderAllPages();
  });
})();

// Gen2: 输入框上方情境徽章——提问前就看到 Agent 会带什么上下文
function refreshComposerCtx() {
  const box = $('composer-ctx');
  if (!box) return;
  const parts = [];
  if (currentPaper) parts.push(`📄 ${currentPaper.name.replace(/\.pdf$/i, '').slice(0, 28)}`);
  if (currentView === 'reader' && paperPages.length) parts.push(`第 ${currentPageNum()} 页`);
  if (currentView === 'write') parts.push('✎ 写作工坊');
  box.hidden = !parts.length;
  box.textContent = parts.length ? `上下文：${parts.join(' · ')}` : '';
}
function toggleChat() { setChatOpen($('chat-drawer').hidden); }
function closeDrawersExcept(keep) {
  if (keep !== 'notes') $('notes-drawer').hidden = true;
  if (keep !== 'todos') $('todos-drawer').hidden = true;
  if (keep !== 'highlights') { const d = $('highlights-drawer'); if (d) d.hidden = true; }
}
$('btn-chat').addEventListener('click', () => toggleChat());
$('chat-close')?.addEventListener('click', () => setChatOpen(false));
function hideWelcome() { els.welcome?.remove(); els.welcome = null; }

function addUserMessage(text) {
  hideWelcome();
  const wrap = el('div', 'msg user');
  const bubble = el('span', 'bubble', text);
  wrap.appendChild(bubble);
  if (pendingAttachment) {
    const img = document.createElement('img');
    img.src = pendingAttachment.dataUrl;
    img.alt = pendingAttachment.label;
    bubble.appendChild(img);
  }
  els.log.appendChild(wrap);
  els.log.scrollTop = els.log.scrollHeight;
}

function setChatBusy(busy) {
  chatBusy = busy;
  els.askBtn.disabled = busy;
  $('btn-cancel-chat').hidden = !busy;
}

function beginAssistantMessage() {
  const wrap = el('div', 'msg assistant');
  const meta = el('div', 'agent-meta'); meta.hidden = true;
  const timeline = el('div', 'timeline'); timeline.hidden = true;
  const tools = el('div', 'tools'); tools.hidden = true;
  const content = el('div', 'content');
  const thinking = el('span', 'thinking-dot'); thinking.append(el('i'), el('i'), el('i'));
  content.appendChild(thinking);
  wrap.append(meta, timeline, tools, content);
  els.log.appendChild(wrap);
  active = { wrap, meta, timeline, tools, content, streamed: '', toolCount: 0, round: 0 };
  els.log.scrollTop = els.log.scrollHeight;
}
function ensureTimelineVisible() { if (active?.timeline) active.timeline.hidden = false; }
function appendTimelineStep(kind, text, extraClass = '') {
  if (!active?.timeline) return;
  ensureTimelineVisible();
  const row = el('div', `tl-step tl-${kind} ${extraClass}`.trim());
  const mark = el('span', 'tl-mark', kind === 'tool' ? '⚙' : kind === 'plan' ? '▸' : kind === 'confirm' ? '?' : kind === 'round' ? '·' : '•');
  row.append(mark, el('span', 'tl-text', text));
  active.timeline.appendChild(row);
  while (active.timeline.children.length > 40) active.timeline.firstChild.remove();
}

window.paperlens.onUiShowPage?.(({ page }) => {
  if (!paperPages.length) return;
  switchView('reader');
  jumpToPage(Number(page) || 1, 'both');
});

window.paperlens.onChatEvent((data) => {
  if (!active) return;
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 140;
  if (data.type === 'skill') {
    active.meta.hidden = false;
    active.meta.textContent = `技能 · ${data.label || data.id}`;
  } else if (data.type === 'status') {
    if (data.phase === 'start') appendTimelineStep('status', `开始执行（最多 ${data.maxRounds || '?'} 轮）`);
    else if (data.phase === 'limit') appendTimelineStep('status', '已达轮次上限', 'warn');
  } else if (data.type === 'round') {
    active.round = data.round || 0;
    appendTimelineStep('round', `第 ${data.round}/${data.maxRounds} 轮推理`);
  } else if (data.type === 'plan') {
    const text = String(data.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (text) appendTimelineStep('plan', text);
  } else if (data.type === 'delta') {
    active.streamed += data.delta || '';
    renderMarkdownInto(active.content, active.streamed);
  } else if (data.type === 'tool-start') {
    active.tools.hidden = false;
    active.toolCount += 1;
    const label = TOOL_LABELS[data.name] || data.name;
    const argHint = data.args && Object.keys(data.args).length ? ` ${JSON.stringify(data.args).slice(0, 72)}` : '';
    appendTimelineStep('tool', `${label}${argHint}`);
    const chip = el('span', 'tool-chip');
    chip.dataset.name = data.name; chip.dataset.seq = String(active.toolCount);
    chip.append(el('span', 'spin'), document.createTextNode(label));
    active.tools.appendChild(chip);
    if (!active.streamed.trim()) {
      active.content.replaceChildren((() => { const t = el('span', 'thinking-dot'); t.append(el('i'), el('i'), el('i')); return t; })());
    }
  } else if (data.type === 'tool-confirm') {
    showToolConfirmCard(data);
  } else if (data.type === 'tool-done') {
    const label = TOOL_LABELS[data.name] || data.name;
    const chips = active.tools.querySelectorAll(`[data-name="${CSS.escape(data.name)}"]`);
    const chip = chips[chips.length - 1];
    if (chip) {
      const prefix = data.duplicate ? '↷ ' : data.denied ? '🚫 ' : (data.ok ? '✓ ' : '✕ ');
      chip.replaceChildren(document.createTextNode(`${prefix}${label}`));
      if (!data.ok) chip.classList.add('err');
      if (data.duplicate) chip.classList.add('dup');
      if (data.denied) chip.classList.add('denied');
    }
    const last = active.timeline?.querySelector('.tl-step.tl-tool:last-child .tl-text, .tl-step.tl-confirm:last-child .tl-text');
    if (last && data.preview) last.textContent = `${label} → ${String(data.preview).slice(0, 100)}`;
  } else if (data.type === 'evidence') {
    active.pendingEvidence = data;
  } else if (data.type === 'cancelled') {
    appendTimelineStep('status', '已停止', 'warn');
  }
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
});

function showToolConfirmCard(data) {
  if (!active?.timeline) return;
  ensureTimelineVisible();
  appendTimelineStep('confirm', `待确认：${data.preview || data.name || '写操作'}`, 'warn');
  const card = el('div', 'confirm-card');
  card.appendChild(el('div', 'confirm-title', '写操作需要你确认'));
  card.appendChild(el('div', 'confirm-body', data.preview || TOOL_LABELS[data.name] || data.name));
  const actions = el('div', 'confirm-actions');
  const allowBtn = el('button', 'confirm-allow', '允许'); allowBtn.type = 'button';
  const denyBtn = el('button', 'confirm-deny', '拒绝'); denyBtn.type = 'button';
  const finish = async (allowed) => {
    allowBtn.disabled = true; denyBtn.disabled = true;
    card.classList.add(allowed ? 'allowed' : 'denied');
    await window.paperlens.respondToolConfirm?.({ id: data.id, allowed });
    appendTimelineStep('status', allowed ? `已允许 ${TOOL_LABELS[data.name] || data.name}` : `已拒绝 ${TOOL_LABELS[data.name] || data.name}`, allowed ? '' : 'warn');
  };
  allowBtn.addEventListener('click', () => void finish(true));
  denyBtn.addEventListener('click', () => void finish(false));
  actions.append(allowBtn, denyBtn);
  card.appendChild(actions);
  active.timeline.appendChild(card);
  els.log.scrollTop = els.log.scrollHeight;
}

function mountEvidenceCards(message, evidence, answerHtmlHost) {
  const pages = evidence?.pages || evidence?.cards?.map((c) => c.page) || [];
  if (answerHtmlHost) linkifyPageButtons(answerHtmlHost);
  if (!pages.length) return;
  const bar = el('div', 'evidence-bar');
  bar.appendChild(el('span', 'evidence-label', '证据'));
  for (const page of pages) {
    const btn = el('button', 'evidence-chip', `第 ${page} 页`);
    btn.type = 'button'; btn.title = '跳转到原文';
    btn.addEventListener('click', () => { switchView('reader'); jumpToPage(page, 'both'); });
    bar.appendChild(btn);
  }
  message.content.after(bar);
}
function linkifyPageButtons(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) if (/第\s*\d{1,4}\s*页/.test(node.nodeValue || '')) targets.push(node);
  for (const textNode of targets) {
    const raw = textNode.nodeValue || '';
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = /第\s*(\d{1,4})\s*页/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const page = Number(m[1]);
      const btn = el('button', 'ev-page-link', m[0]);
      btn.type = 'button'; btn.dataset.plPage = String(page);
      btn.title = `跳转到原文第 ${page} 页`;
      btn.addEventListener('click', (ev) => { ev.preventDefault(); switchView('reader'); jumpToPage(page, 'both'); });
      frag.appendChild(btn);
      last = m.index + m[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

/** 当前工作情境：随每次提问带给 Agent（在哪个视图、看哪页），免得用户复述 */
function buildAskContext() {
  const ctx = { view: currentView };
  if (currentView === 'reader' && paperPages.length) {
    ctx.page = currentPageNum();
    ctx.totalPages = currentPaper?.totalPages || paperPages.length;
    ctx.translatedPages = paperPages.filter((r) => r.translated).length;
  }
  if (currentView === 'write') {
    ctx.draftTitle = $('write-title')?.value?.trim() || '';
    ctx.draftKind = $('write-kind')?.value || '';
  }
  return ctx;
}

async function send(question, opts = {}) {
  const q = String(question || '').trim();
  if (!q && !pendingAttachment) return;
  if (chatBusy) { toast('Agent 正在执行上一个任务 — 可点「停止」后再问', true); return; } // Gen29: 忙时给反馈而非静默吞掉
  setChatOpen(true);
  const hasImage = Boolean(pendingAttachment);
  els.input.value = '';
  autoGrow();
  setChatBusy(true);
  els.hint.textContent = '';
  addUserMessage(q || '（框选图提问）');
  beginAssistantMessage();
  const result = await window.paperlens.ask(q, {
    skillId: opts.skillId || undefined,
    autoSkill: opts.skillId ? false : true,
    image: hasImage ? pendingAttachment.dataUrl : undefined,
    context: buildAskContext(),
  });
  pendingAttachment = null;
  $('attach-strip').hidden = true;
  if (result?.cancelled) {
    if (!active.streamed.trim()) active.content.textContent = '已停止。';
    else appendTimelineStep('status', '已停止', 'warn');
  } else if (result?.error) {
    active.content.textContent = `⚠ ${result.error}`;
  } else {
    renderMarkdownInto(active.content, result?.answer || '（空回答）');
    mountEvidenceCards(active, result?.evidence, active.content);
    const n = result?.trace?.length || 0;
    const skill = result?.skillId ? ` · 技能 ${result.skillId}` : '';
    const mode = result?.agentMode === 'autopilot' ? ' · 自动驾驶' : ' · 副驾驶';
    els.hint.textContent = n ? `完成：${n} 次工具 · ${result?.rounds || '?'} 轮${skill}${mode}` : `完成${skill}${mode}`;
    attachAnswerActions(active, q, result?.answer || '');
    if (result?.trace?.some((t) => t.name === 'save_research_note' && t.ok)) void refreshNotesCount();
    void refreshTodoBadge();
    void window.paperlens.recordStat?.('agent-ask', 1);
    // Gen30: Agent 回合 token 估算（问题+回答 len/2 + 每次工具约 800）
    void window.paperlens.recordStat?.('tokens', Math.round((q.length + (result?.answer?.length || 0)) / 2) + n * 800);
  }
  active = null;
  setChatBusy(false);
  els.input.focus();
  els.log.scrollTop = els.log.scrollHeight;
  return result;
}

els.form.addEventListener('submit', (event) => { event.preventDefault(); void send(els.input.value); });
// Gen26: 输入历史——↑/↓ 翻最近发过的问题（输入框为空或正在翻历史时生效）
const askHistory = [];
let askHistoryIdx = -1;
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const v = els.input.value.trim();
    if (v) { askHistory.push(v); if (askHistory.length > 50) askHistory.shift(); }
    askHistoryIdx = -1;
    void send(els.input.value);
    return;
  }
  if (event.key === 'ArrowUp' && (askHistoryIdx >= 0 || !els.input.value.trim())) {
    if (!askHistory.length) return;
    event.preventDefault();
    askHistoryIdx = askHistoryIdx < 0 ? askHistory.length - 1 : Math.max(0, askHistoryIdx - 1);
    els.input.value = askHistory[askHistoryIdx]; autoGrow();
  } else if (event.key === 'ArrowDown' && askHistoryIdx >= 0) {
    event.preventDefault();
    askHistoryIdx += 1;
    if (askHistoryIdx >= askHistory.length) { askHistoryIdx = -1; els.input.value = ''; }
    else els.input.value = askHistory[askHistoryIdx];
    autoGrow();
  }
});
function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(140, els.input.scrollHeight)}px`; }
els.input.addEventListener('input', autoGrow);

function bindStarterClicks(root) {
  root?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-skill], [data-q]');
    if (!btn) return;
    const skillId = btn.dataset.skill;
    const q = btn.dataset.q || (skillId ? `请执行技能：${skillId}` : '');
    if (q || skillId) void send(q, skillId ? { skillId } : {});
  });
}
bindStarterClicks($('starters'));

// 技能条 + Ctrl+K 面板
async function renderSkillBar() {
  const bar = $('skill-bar');
  if (!window.paperlens.listSkills) return;
  try {
    const { skills } = await window.paperlens.listSkills();
    bar.replaceChildren();
    const preferred = ['deep-read', 'paper-qa', 'method', 'experiment', 'critique', 'lit-survey', 'frontier-digest', 'kb-weave', 'meeting', 'tldr', 'venue-advisor', 'rebuttal', 'overleaf', 'export-report'];
    const ordered = [...skills || []].sort((a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id));
    for (const skill of ordered.slice(0, 12)) {
      const btn = el('button', 'skill-chip', skill.short || skill.label);
      btn.type = 'button'; btn.title = skill.title || skill.label;
      btn.addEventListener('click', () => {
        const prompts = {
          'deep-read': '请对当前论文做一键深读。',
          'paper-qa': '请基于原文回答：这篇论文的核心贡献是什么？',
          method: '请拆解本文方法。',
          experiment: '请解读实验与主结果。',
          critique: '请做批判性阅读笔记。',
          'lit-survey': '请围绕当前论文主题做简要文献调研。',
          meeting: '请生成组会讲稿大纲。',
          tldr: '请给出三句话 TL;DR。',
          'frontier-digest': '请抓取我兴趣方向的最新论文并做一页速报。',
          'kb-weave': '请把当前论文和我的知识库串联起来。',
          'venue-advisor': '请基于我当前的工作和投稿目标，建议投到哪里。',
          rebuttal: '我要写 rebuttal，请帮我逐条拆解审稿意见并起草回复。',
          'export-report': '请生成完整深读报告并导出为 Markdown 文件。',
          overleaf: '请生成 Related Work 的 LaTeX section 草稿并准备粘贴到 Overleaf。',
        };
        void send(prompts[skill.id] || `请执行「${skill.label}」。`, { skillId: skill.id });
      });
      bar.appendChild(btn);
    }
  } catch { /* 旧 preload */ }
}
void renderSkillBar();

// Ctrl+K 技能面板
let paletteItems = [];
let paletteIndex = 0;
async function openSkillPalette() {
  if (!paletteItems.length) {
    try {
      const { skills } = await window.paperlens.listSkills();
      paletteItems = skills || [];
    } catch { return; }
  }
  const list = $('palette-list');
  list.replaceChildren();
  paletteItems.forEach((skill, i) => {
    const btn = el('button', 'palette-item');
    btn.dataset.index = String(i);
    btn.append(el('span', 'pi-label', skill.label), el('span', 'pi-title', skill.title || ''));
    btn.addEventListener('click', () => { $('skill-palette').close(); void send(`请执行技能：${skill.id}`, { skillId: skill.id }); });
    list.appendChild(btn);
  });
  paletteIndex = 0;
  updatePaletteSelection();
  $('palette-input').value = '';
  $('skill-palette').showModal();
  setTimeout(() => $('palette-input').focus(), 50);
}
function updatePaletteSelection() {
  const items = $('palette-list').querySelectorAll('.palette-item');
  items.forEach((it, i) => it.classList.toggle('selected', i === paletteIndex));
  items[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}
$('palette-input').addEventListener('input', () => {
  const q = $('palette-input').value.trim().toLowerCase();
  const list = $('palette-list');
  let firstVisible = -1;
  list.querySelectorAll('.palette-item').forEach((it, i) => {
    const skill = paletteItems[i];
    const hay = `${skill.label} ${skill.title || ''} ${skill.id}`.toLowerCase();
    const show = !q || hay.includes(q);
    it.hidden = !show;
    if (show && firstVisible < 0) firstVisible = i;
  });
  paletteIndex = firstVisible < 0 ? -1 : firstVisible;
  updatePaletteSelection();
});
$('palette-input').addEventListener('keydown', (event) => {
  const items = [...$('palette-list').querySelectorAll('.palette-item:not([hidden])')];
  if (!items.length) return;
  const idxInVisible = items.findIndex((it) => Number(it.dataset.index) === paletteIndex);
  if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Number(items[Math.min(items.length - 1, idxInVisible + 1)].dataset.index); updatePaletteSelection(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Number(items[Math.max(0, idxInVisible - 1)].dataset.index); updatePaletteSelection(); }
  else if (event.key === 'Enter') { event.preventDefault(); items[idxInVisible]?.click(); }
  else if (event.key === 'Escape') { $('skill-palette').close(); }
});

$('btn-cancel-chat')?.addEventListener('click', async () => { await window.paperlens.cancelChat?.(); setStatus('正在停止…'); });
$('btn-reset')?.addEventListener('click', async () => {
  await window.paperlens.cancelChat?.();
  await window.paperlens.resetChat();
  els.log.replaceChildren();
  const welcome = el('section', null); welcome.id = 'welcome';
  welcome.innerHTML = `
    <h1>PaperLens Research Agent</h1>
    <p class="welcome-sub">先取证再结论 · Timeline 可观察 · 连着你的论文/知识库/前沿雷达</p>
    <div id="starters" class="starters">
      <button type="button" data-skill="deep-read">📖 一键深读当前论文</button>
      <button type="button" data-skill="frontier-digest" data-q="帮我看看我的方向今天有什么新论文">◎ 前沿日报</button>
      <button type="button" data-skill="kb-weave" data-q="把当前论文和我的知识库串联起来">✦ 和我的知识库串联</button>
      <button type="button" data-skill="meeting">🎤 生成组会讲稿</button>
    </div>
    <p class="kbd-hints">Ctrl+K 搜索全部技能 · 划词「问 AI」带引用 · 框选可发图提问</p>`;
  els.log.appendChild(welcome);
  els.welcome = welcome;
  bindStarterClicks($('starters'));
  setChatBusy(false);
  setStatus('已开始新会话');
  els.input.focus();
});

// ---------------------------------------------------------------------------
// 历史会话（持久化在主进程 sessions.json）
// ---------------------------------------------------------------------------
function fmtSessionTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function toggleSessionList() {
  const list = $('session-list');
  if (!list.hidden) { list.hidden = true; return; }
  const { sessions = [] } = await window.paperlens.listSessions?.() || {};
  list.replaceChildren();
  if (!sessions.length) {
    list.appendChild(el('p', 'session-empty', '还没有历史会话 — 和 Agent 聊过并点「新会话」后会存档在这里'));
  }
  for (const session of sessions) {
    const row = el('div', 'session-row');
    const main = el('button', 'session-open'); main.type = 'button';
    main.append(
      el('span', 'session-title', session.title),
      el('span', 'session-sub', `${fmtSessionTime(session.updatedAt)} · ${session.turns} 轮${session.paperTitle ? ` · ${session.paperTitle.slice(0, 24)}` : ''}`),
    );
    main.addEventListener('click', async () => {
      const result = await window.paperlens.openSession(session.id);
      if (result?.error) { toast(result.error, true); return; }
      // 回放会话消息到聊天区
      hideWelcome();
      els.log.replaceChildren();
      for (const msg of result.session.messages) {
        if (msg.role === 'user') {
          const wrap = el('div', 'msg user'); wrap.appendChild(el('span', 'bubble', msg.content));
          els.log.appendChild(wrap);
        } else {
          const wrap = el('div', 'msg assistant');
          const content = el('div', 'content');
          renderMarkdownInto(content, msg.content);
          linkifyPageButtons(content); // Gen8: 回放的回答同样可点页码跳转
          wrap.appendChild(content);
          els.log.appendChild(wrap);
        }
      }
      list.hidden = true;
      els.log.scrollTop = els.log.scrollHeight;
      setStatus(`已恢复会话「${session.title}」，可继续追问`);
    });
    const del = el('button', 'icon-x session-del', '✕'); del.type = 'button'; del.title = '删除会话';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.paperlens.removeSession(session.id);
      row.remove();
    });
    row.append(main, del);
    list.appendChild(row);
  }
  list.hidden = false;
}
$('btn-sessions')?.addEventListener('click', () => void toggleSessionList());

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
async function refreshModelBadge() {
  const config = await window.paperlens.getConfig();
  els.modelBadge.textContent = config.model || '未配置';
  return config;
}
// Gen15: 状态栏模型徽章点击直达设置（title 一直这么写，但之前没接线）
els.modelBadge.addEventListener('click', () => $('btn-settings').click());
$('btn-settings').addEventListener('click', async () => {
  const config = await window.paperlens.getConfig();
  const ws = await window.paperlens.getWorkspace();
  $('cfg-baseurl').value = config.baseUrl || '';
  $('cfg-model').value = config.model || '';
  const key = $('cfg-apikey'); key.value = ''; key.placeholder = config.hasKey ? '已保存（留空保持不变）' : 'sk-…';
  $('cfg-agent-mode').value = config.agentMode === 'autopilot' ? 'autopilot' : 'copilot';
  const tl = $('cfg-targetlang'); if (tl && config.targetLang) tl.value = config.targetLang;
  $('cfg-overleaf-url').value = config.overleaf?.projectUrl || '';
  $('cfg-field').value = ws.profile?.field || '';
  $('cfg-direction').value = ws.profile?.direction || '';
  $('cfg-goal').value = ws.profile?.goal || '';
  await refreshObsidianSettings();
  els.settings.showModal();
});
async function refreshObsidianSettings() {
  const obs = await window.paperlens.obsidianStatus();
  const toggle = $('cfg-obsidian-toggle');
  const status = $('cfg-obsidian-status');
  toggle.checked = Boolean(obs?.enabled);
  status.textContent = obs?.folder ? `${obs.enabled ? '✓ 同步中' : '已暂停'} → ${obs.folder}` : '未配置 — 收藏的笔记不会写入 vault';
}
$('cfg-obsidian-pick').addEventListener('click', async () => {
  const result = await window.paperlens.pickObsidianFolder();
  if (result?.ok) await refreshObsidianSettings();
});
$('cfg-obsidian-toggle').addEventListener('change', async (event) => {
  await window.paperlens.setObsidianEnabled(event.target.checked);
  await refreshObsidianSettings();
});
$('cfg-cancel').addEventListener('click', () => els.settings.close());
$('cfg-save').addEventListener('click', async () => {
  const apiKey = $('cfg-apikey').value.trim();
  const agentMode = $('cfg-agent-mode')?.value || 'copilot';
  const overleafProjectUrl = $('cfg-overleaf-url')?.value?.trim() || '';
  await window.paperlens.setConfig({
    baseUrl: $('cfg-baseurl').value.trim(),
    model: $('cfg-model').value.trim(),
    ...(apiKey ? { apiKey } : {}),
    agentMode,
    targetLang: $('cfg-targetlang')?.value || '简体中文',
    overleafProjectUrl,
    overleafEnabled: Boolean(overleafProjectUrl),
  });
  await window.paperlens.setProfile({
    field: $('cfg-field').value.trim(),
    direction: $('cfg-direction').value.trim(),
    goal: $('cfg-goal').value.trim(),
  });
  els.settings.close();
  await refreshModelBadge();
  setStatus(agentMode === 'autopilot' ? '已切换自动驾驶（写操作免确认）' : '已切换副驾驶（写操作需确认）');
});

// ---------------------------------------------------------------------------
// PDF 状态
// ---------------------------------------------------------------------------
let pdfDoc = null;
let currentPaper = null; // {path, name, totalPages}
/** 多论文标签（内存；按 path 打开，不缓存整本 DOM） */
let readerTabState = emptyTabState();
let switchingTab = false;
let zoomScale = null; // null = 适宽
/** @type {Array} */
const paperPages = [];
let autoTranslate = false;
let scrollLinkEnabled = true;

const cacheDb = new Promise((resolve) => {
  const req = indexedDB.open('paperlens-desktop-cache', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('translations');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null);
});
async function cacheGet(key) {
  const db = await cacheDb; if (!db) return null;
  return new Promise((resolve) => {
    const r = db.transaction('translations').objectStore('translations').get(key);
    r.onsuccess = () => resolve(r.result ?? null); r.onerror = () => resolve(null);
  });
}
async function cacheSet(key, value) {
  const db = await cacheDb; if (!db) return;
  try { db.transaction('translations', 'readwrite').objectStore('translations').put(value, key); } catch { /* 配额 */ }
}
async function pageCacheKey(record) {
  const config = await window.paperlens.getConfig();
  return `${currentPaper?.path || currentPaper?.name}|p${record.num}|${config.model}|zh`;
}

// ---------------------------------------------------------------------------
// textLayer 选择增强
// ---------------------------------------------------------------------------
let textLayerSelectionCleanupBound = false;
function enhanceTextLayerSelection(tl) {
  if (!tl || tl.querySelector(':scope > .endOfContent')) return;
  const endOfContent = document.createElement('div'); endOfContent.className = 'endOfContent';
  tl.appendChild(endOfContent);
  tl.addEventListener('pointerdown', () => tl.classList.add('selecting'));
  if (textLayerSelectionCleanupBound) return;
  textLayerSelectionCleanupBound = true;
  const clearSelecting = () => { for (const layer of els.pdfPages.querySelectorAll('.textLayer.selecting')) layer.classList.remove('selecting'); };
  document.addEventListener('pointerup', clearSelecting);
  document.addEventListener('pointercancel', clearSelecting);
}

async function renderPdfPageVisual(record, cssWidth) {
  if (!pdfDoc) throw new Error('无 PDF 文档');
  const page = record.pageObj || await pdfDoc.getPage(record.num);
  record.pageObj = page;
  const base = page.getViewport({ scale: 1 });
  // 适宽：用实测栏宽；若布局尚未完成（clientWidth≈0）则延后重试，避免画出 0 高空白页
  let fitW = Number(cssWidth) || 0;
  if (!zoomScale) {
    const measured = Math.max(0, (els.pdfPages?.clientWidth || 0) - 36);
    fitW = measured > 120 ? measured : (fitW > 120 ? fitW : 0);
    if (fitW < 120) {
      // 布局未就绪：保持 pending，下一帧再渲染
      record.rendered = false;
      record.renderPending = false;
      requestAnimationFrame(() => {
        if (paperPages[record.num - 1] === record && !record.rendered) {
          void ensurePageRendered(record).catch(() => {});
        }
      });
      return record.text || '';
    }
  }
  const scale = zoomScale || (fitW / base.width);
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: scale * dpr });
  const canvas = record.canvas;
  const w = Math.max(1, Math.round(viewport.width));
  const h = Math.max(1, Math.round(viewport.height));
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${Math.round(base.width * scale)}px`;
  canvas.style.height = `${Math.round(base.height * scale)}px`;
  const ctx = canvas.getContext('2d', { alpha: false });
  // 白底：避免透明/未绘区域看起来像「空白故障」
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const cssViewport = page.getViewport({ scale });
  let tl = record.textLayer;
  if (tl) tl.remove();
  tl = document.createElement('div'); tl.className = 'textLayer';
  tl.style.width = `${cssViewport.width}px`; tl.style.height = `${cssViewport.height}px`;
  tl.style.setProperty('--scale-factor', String(scale));
  record.pdfEl.appendChild(tl);
  record.textLayer = tl;
  let text = record.text;
  try {
    const textContent = await page.getTextContent();
    if (!text) {
      text = (textContent.items || []).map((it) => String(it.str || '')).join(' ').replace(/\s+/g, ' ').trim();
      record.text = text;
    }
    if (typeof pdfjsLib.renderTextLayer === 'function') {
      const task = pdfjsLib.renderTextLayer({
        textContentSource: textContent, container: tl, viewport: cssViewport, textDivs: [],
      });
      await (task.promise || task);
      enhanceTextLayerSelection(tl);
    }
  } catch (err) { console.warn('[PL-DESK] textLayer failed', err); }
  return text;
}

// ---------------------------------------------------------------------------
// 懒渲染：IntersectionObserver 只渲染视口附近的 PDF 页
// ---------------------------------------------------------------------------
let lazyObserver = null;
let lazyCssWidth = 0;
async function ensurePageRendered(record) {
  if (record.rendered || record.renderPending) return;
  record.renderPending = true;
  try {
    const w = lazyCssWidth || Math.max(0, (els.pdfPages?.clientWidth || 0) - 36);
    await renderPdfPageVisual(record, w);
    // 仅当 canvas 真有像素时才标 rendered（避免 0 宽空白被永久跳过）
    if (record.canvas && record.canvas.width > 10 && record.canvas.height > 10) {
      record.rendered = true;
      record.pdfEl.classList.remove('pending');
      void applyHighlightsToPage(record);
    }
  } catch (err) {
    console.warn('[PL-DESK] ensurePageRendered failed', record?.num, err);
    record.rendered = false;
  } finally {
    record.renderPending = false;
  }
}

/** 把持久高亮画回 textLayer spans */
async function applyHighlightsToPage(record) {
  if (!currentPaper?.path || !record?.textLayer) return;
  try {
    const { highlights = [] } = await window.paperlens.listHighlights?.(currentPaper.path) || {};
    const pageHs = highlights.filter((h) => h.page === record.num);
    if (!pageHs.length) return;
    const spans = [...record.textLayer.querySelectorAll('span')];
    const texts = spans.map((s) => s.textContent || '');
    for (const h of pageHs) {
      const range = findHighlightSpanRange(texts, h.text);
      if (!range) continue;
      for (let i = range.start; i <= range.end; i += 1) {
        spans[i]?.classList.add('hl-mark', `hl-${h.color || 'yellow'}`);
        spans[i]?.setAttribute('data-hl-id', h.id);
        spans[i].title = h.note || h.text.slice(0, 80);
      }
    }
  } catch { /* noop */ }
}
function setupLazyRender(cssWidth) {
  lazyCssWidth = cssWidth;
  lazyObserver?.disconnect();
  lazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const num = Number(entry.target.dataset.page);
      const record = paperPages[num - 1];
      if (record && !record.rendered) void ensurePageRendered(record).catch(() => {});
    }
  }, { root: els.pdfPages, rootMargin: '1200px 0px' }); // 提前约 2 屏渲染
  for (const record of paperPages) lazyObserver.observe(record.pdfEl);
}

// ---------------------------------------------------------------------------
// 打开 PDF
// ---------------------------------------------------------------------------
// 并发打开守卫：两条路径同时 openPdfData（历史上如 drop 冒泡）会交错破坏 paperPages
let openingPdf = null;
async function openPdfData(payload, resumePage = 0) {
  while (openingPdf) await openingPdf; // 排队而不是丢弃：多文件依次打开仍成立
  let release;
  openingPdf = new Promise((r) => { release = r; });
  try {
    return await openPdfDataInner(payload, resumePage);
  } finally {
    openingPdf = null; release();
  }
}
async function openPdfDataInner({ path, name, data }, resumePage = 0) {
  if (!window.pdfjsLib) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = '../../src/vendor/pdf.worker.min.js';
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  try { pdfDoc?.destroy?.(); } catch { /* noop */ }
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  currentPaper = { path: path || '', name: name || 'paper.pdf', totalPages: pdfDoc.numPages };
  // 多标签：登记 / 激活
  if (!switchingTab) {
    readerTabState = openTab(readerTabState, {
      path: currentPaper.path,
      name: currentPaper.name,
      totalPages: currentPaper.totalPages,
      lastPage: Math.max(1, resumePage || 1),
    });
  } else {
    readerTabState = updateTabProgress(readerTabState, {
      path: currentPaper.path,
      lastPage: Math.max(1, resumePage || 1),
      totalPages: currentPaper.totalPages,
    });
  }
  renderReaderTabs();
  els.docTitle.textContent = currentPaper.name;
  els.docTitle.title = currentPaper.name;
  $('reader-toolbar').hidden = false;
  const tabsEl = $('reader-tabs');
  if (tabsEl) tabsEl.hidden = readerTabState.tabs.length === 0;
  els.paperEmpty.hidden = true;
  els.transEmpty.hidden = true;
  els.pdfPages.hidden = false;
  els.transPages.hidden = false;
  els.pdfPages.replaceChildren();
  els.transPages.replaceChildren();
  paperPages.length = 0;
  switchView('reader');

  // 先铺骨架
  for (let num = 1; num <= pdfDoc.numPages; num += 1) {
    els.pdfPages.appendChild(el('div', 'paper-skeleton'));
    const sk = el('div', 'trans-page');
    sk.innerHTML = `<div class="trans-page-head"><span class="tp-num">第 ${num} / ${pdfDoc.numPages} 页</span></div><div class="trans-body skeleton">等待翻译…</div>`;
    els.transPages.appendChild(sk);
  }
  updateStatusBar();

  const pageTexts = [];
  const cssWidth = Math.max(280, els.pdfPages.clientWidth - 36);
  // 基准宽高比（第 1 页），未渲染页先按此占位保证滚动条稳定
  const firstPage = await pdfDoc.getPage(1);
  const baseVp = firstPage.getViewport({ scale: 1 });
  const baseRatio = baseVp.height / baseVp.width;

  for (let num = 1; num <= pdfDoc.numPages; num += 1) {
    const pdfEl = el('div', 'pdf-page pending'); pdfEl.dataset.page = String(num);
    const canvas = document.createElement('canvas');
    canvas.style.width = `${Math.round(cssWidth)}px`;
    canvas.style.height = `${Math.round(cssWidth * baseRatio)}px`;
    const pnum = el('div', 'pnum', `${num} / ${pdfDoc.numPages}`);
    pdfEl.append(canvas, pnum);
    const transEl = el('div', 'trans-page'); transEl.dataset.page = String(num);
    const head = el('div', 'trans-page-head');
    const tpNum = el('span', 'tp-num', `第 ${num} / ${pdfDoc.numPages} 页`);
    const transBtn = el('button', 'trans-btn', '译此页'); transBtn.type = 'button';
    const askPageBtn = el('button', 'trans-btn ask-page-btn', '✧ 问此页'); askPageBtn.type = 'button';
    askPageBtn.title = '让 Agent 精讲本页（自动取证本页原文）';
    askPageBtn.addEventListener('click', () => {
      void send(`请精讲论文第 ${num} 页：本页在讲什么、关键公式/图表、与全文的联系。先 read_paper_page 取证。`, {});
    });
    head.append(tpNum, transBtn, askPageBtn);
    const transBody = el('div', 'trans-body skeleton', '等待翻译…');
    transEl.append(head, transBody);
    const pdfSk = els.pdfPages.children[num - 1];
    if (pdfSk) pdfSk.replaceWith(pdfEl); else els.pdfPages.appendChild(pdfEl);
    const trSk = els.transPages.children[num - 1];
    if (trSk) trSk.replaceWith(transEl); else els.transPages.appendChild(transEl);
    const record = { num, pdfEl, canvas, textLayer: null, transEl, transBody, transBtn, text: '', translated: '', translating: false, streamRaw: '', pageObj: null, rendered: false, renderPending: false };
    if (num === 1) record.pageObj = firstPage;
    transBtn.addEventListener('click', () => void translatePaperPage(record, { force: true }));
    pdfEl.addEventListener('dblclick', (event) => handlePdfDblClick(record, event));
    transEl.addEventListener('dblclick', (event) => handleTransDblClick(record, event));
    paperPages.push(record);
    void pageCacheKey(record).then(cacheGet).then((cached) => {
      if (!cached || record.translated) return;
      record.translated = cached;
      record.transBody.className = 'trans-body';
      renderMarkdownInto(record.transBody, cached);
      record.transBtn.textContent = '重译';
      onPaperTranslated();
      updateStatusBar();
    });
  }

  // 懒渲染：视口附近的页才渲染 canvas + textLayer（几百页不卡）
  setupLazyRender(cssWidth);
  // 首屏立即渲染前 2 页
  for (const record of paperPages.slice(0, 2)) {
    try { await ensurePageRendered(record); } catch (err) { console.warn('[PL-DESK] render page failed', record.num, err); }
  }

  // 后台顺序抽取全部文本（Agent 上下文与锚点定位需要；不渲染 canvas，开销小）
  const docAtExtract = pdfDoc;
  for (let num = 1; num <= docAtExtract.numPages; num += 1) {
    if (pdfDoc !== docAtExtract) return; // 换文档了，停止
    const record = paperPages[num - 1];
    if (!record) return;
    if (!record.text) {
      try {
        const page = record.pageObj || await docAtExtract.getPage(num);
        record.pageObj = page;
        const textContent = await page.getTextContent();
        record.text = (textContent.items || []).map((it) => String(it.str || '')).join(' ').replace(/\s+/g, ' ').trim();
      } catch { /* 单页文本抽取失败不阻塞 */ }
    }
    pageTexts.push(record.text);
  }

  await window.paperlens.setPaper({ title: currentPaper.name, pages: pageTexts, path: currentPaper.path || '' });
  if (currentPaper.path) {
    void window.paperlens.touchRecent({ path: currentPaper.path, title: currentPaper.name, totalPages: currentPaper.totalPages, lastPage: Math.max(1, resumePage) });
    // 启发式元数据（标题/arXiv id/年份）——只在文库条目还是文件名时补
    if (paperPages[0]?.text) {
      void window.paperlens.extractMetadata?.({
        path: currentPaper.path,
        firstPageText: paperPages[0].text,
        fallbackName: currentPaper.name,
      });
    }
  }
  void refreshTodoBadge();
  void window.paperlens.recordStat?.('paper-opened', 1);
  setStatus(`已载入《${currentPaper.name}》（${pdfDoc.numPages} 页）— 双栏对照；选中原文可划词`);
  updateStatusBar();
  if (resumePage > 1) jumpToPage(resumePage, 'both');
  // 自动译第一页
  if (autoTranslate && paperPages[0]) void translatePaperPage(paperPages[0]);
  setupReadTimer();
  pageRailOpen = true;
  $('page-rail')?.classList.remove('collapsed');
  $('btn-page-rail')?.classList.add('on');
  schedulePageInsight();
}

async function openByPath(path, resumePage = 0) {
  const result = await window.paperlens.openPdfPath(path);
  if (result?.error) { setStatus(result.error, true); return; }
  await openPdfData(result, resumePage);
}

// ---------------------------------------------------------------------------
// 多论文标签
// ---------------------------------------------------------------------------
function renderReaderTabs() {
  const bar = $('reader-tabs');
  if (!bar) return;
  bar.replaceChildren();
  if (!readerTabState.tabs.length) { bar.hidden = true; return; }
  bar.hidden = false;
  for (const tab of readerTabState.tabs) {
    const chip = el('button', `reader-tab${tab.id === readerTabState.activeId ? ' active' : ''}`);
    chip.type = 'button';
    chip.title = tab.path || tab.name;
    chip.appendChild(el('span', 'rt-label', tabLabel(tab)));
    const x = el('span', 'rt-close', '×');
    x.title = '关闭';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      void closeReaderTab(tab.id);
    });
    chip.appendChild(x);
    chip.addEventListener('click', () => void switchReaderTab(tab.id));
    bar.appendChild(chip);
  }
}

async function switchReaderTab(id) {
  if (id === readerTabState.activeId && paperPages.length) return;
  // 记下当前页再切
  if (currentPaper?.path && paperPages.length) {
    const page = currentPageNum?.() || 1;
    readerTabState = updateTabProgress(readerTabState, {
      path: currentPaper.path, lastPage: page, totalPages: currentPaper.totalPages,
    });
  }
  readerTabState = setActiveTab(readerTabState, id);
  const tab = activeTab(readerTabState);
  renderReaderTabs();
  if (!tab?.path) { toast('该标签无本地路径，无法切换', true); return; }
  switchingTab = true;
  try {
    await openByPath(tab.path, tab.lastPage || 1);
  } finally {
    switchingTab = false;
    renderReaderTabs();
  }
}

async function closeReaderTab(id) {
  const wasActive = readerTabState.activeId === id;
  readerTabState = closeTab(readerTabState, id);
  renderReaderTabs();
  if (!readerTabState.tabs.length) {
    // 清空阅读器
    try { pdfDoc?.destroy?.(); } catch { /* noop */ }
    pdfDoc = null;
    currentPaper = null;
    paperPages.length = 0;
    els.pdfPages.replaceChildren();
    els.transPages.replaceChildren();
    els.pdfPages.hidden = true;
    els.transPages.hidden = true;
    els.paperEmpty.hidden = false;
    els.transEmpty.hidden = false;
    $('reader-toolbar').hidden = true;
    $('reader-tabs').hidden = true;
    els.docTitle.textContent = 'PaperLens 科研工作台';
    updateStatusBar?.();
    return;
  }
  if (wasActive) {
    const tab = activeTab(readerTabState);
    if (tab?.path) {
      switchingTab = true;
      try { await openByPath(tab.path, tab.lastPage || 1); }
      finally { switchingTab = false; renderReaderTabs(); }
    }
  }
}

// ---------------------------------------------------------------------------
// 双击定位：块级锚点匹配（anchor-match.mjs）→ 页级兜底
// ---------------------------------------------------------------------------
function textLayerSpans(record) {
  if (!record.textLayer) return [];
  return [...record.textLayer.querySelectorAll('span')].filter((s) => s.textContent.trim());
}
function flashSpans(spans) {
  for (const span of spans) span.classList.add('anchor-hit');
  setTimeout(() => { for (const span of spans) span.classList.remove('anchor-hit'); }, 1800);
}
function handlePdfDblClick(record, event) {
  // 双击左栏：优先用选中的词在译文里找对应块；找不到退回页级
  const word = String(window.getSelection?.()?.toString() || '').trim();
  jumpToPage(record.num, 'trans');
  if (word && word.length >= 2 && record.translated) {
    const blocks = [...record.transBody.children].map((b) => b.textContent || '');
    const hit = findBlockForWord(blocks, word);
    if (hit) {
      const target = record.transBody.children[hit.index];
      target?.scrollIntoView({ block: 'center' });
      target?.classList.add('block-hit');
      setTimeout(() => target?.classList.remove('block-hit'), 1800);
      return;
    }
  }
  // 兜底：点位锚框（原页级行为）
  const rect = record.pdfEl.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  flashAnchor(record.pdfEl, x, y);
}
function handleTransDblClick(record, event) {
  // 双击右栏译文块：提取锚 token → 在左栏 textLayer 找最佳 span 窗口高亮
  jumpToPage(record.num, 'pdf');
  const block = event.target?.closest?.('p, li, h1, h2, h3, h4, blockquote, td, div.katex-display');
  const spans = textLayerSpans(record);
  if (block && spans.length) {
    const anchors = extractAnchors(block.textContent);
    const win = findBestSpanWindow(spans.map((s) => s.textContent), anchors);
    if (win) {
      const hitSpans = spans.slice(win.start, win.end + 1);
      hitSpans[0]?.scrollIntoView({ block: 'center' });
      flashSpans(hitSpans);
      return;
    }
    // 锚点找不到 → 垂直比例回退（滚到原文页对应位置）
    const ratio = positionRatioFallback(block.getBoundingClientRect(), record.transEl.getBoundingClientRect());
    const pdfRect = record.pdfEl.getBoundingClientRect();
    flashAnchor(record.pdfEl, 0.1, ratio);
    els.pdfPages.scrollTop += (pdfRect.top + pdfRect.height * ratio) - (els.pdfPages.getBoundingClientRect().top + els.pdfPages.clientHeight / 2);
  }
}
function flashAnchor(pdfEl, x, y) {
  const box = el('div', 'anchor-flash');
  box.style.left = `${(x - 0.04) * 100}%`;
  box.style.top = `${(y - 0.02) * 100}%`;
  box.style.width = '8%';
  box.style.height = '6%';
  pdfEl.appendChild(box);
  setTimeout(() => box.remove(), 1500);
}

function jumpToPage(num, side = 'both') {
  const record = paperPages[num - 1];
  if (!record) return;
  scrollSync.lock = true;
  scrollSync.source = 'jump';
  if (side === 'pdf' || side === 'both') { record.pdfEl.scrollIntoView({ block: 'start' }); flashEl(record.pdfEl); }
  if (side === 'trans' || side === 'both') { record.transEl.scrollIntoView({ block: 'start' }); flashEl(record.transEl); }
  requestAnimationFrame(() => { scrollSync.lock = false; scrollSync.source = null; });
  updateStatusBar();
  schedulePageInsight();
}

// ---------------------------------------------------------------------------
// 本页洞察侧栏（本地即时）
// ---------------------------------------------------------------------------
let pageRailOpen = true;
let pageInsightTimer = null;
let lastInsightPage = 0;
let lastInsightClaims = [];

function schedulePageInsight() {
  if (!pageRailOpen || !paperPages.length) return;
  clearTimeout(pageInsightTimer);
  pageInsightTimer = setTimeout(() => refreshPageInsight(), 180);
}

function refreshPageInsight() {
  const rail = $('page-rail');
  if (!rail || !paperPages.length) return;
  const page = currentPageNum();
  const record = paperPages[page - 1];
  if (!record) return;
  lastInsightPage = page;
  const insight = buildPageInsight({
    page,
    sourceText: record.text || '',
    translationText: record.translated || '',
  });
  lastInsightClaims = insight.claims || [];
  $('pr-page-label').textContent = `第 ${page} 页`;

  const sec = $('pr-sections');
  sec.replaceChildren();
  for (const c of insight.sectionCues || []) sec.appendChild(el('span', 'pr-chip', c));
  if (!insight.sectionCues?.length) sec.appendChild(el('span', 'pr-chip muted', '结构未识别'));

  const claimsBox = $('pr-claims');
  claimsBox.replaceChildren();
  if (!insight.claims.length) {
    claimsBox.appendChild(el('p', 'pr-empty',
      insight.hasTranslation ? '本页暂无高置信主张句' : '译完本页后主张更准 · 或点「主张地图」'));
  } else {
    for (const c of insight.claims) {
      const row = el('button', `pr-claim ${c.confidence}`);
      row.type = 'button';
      row.textContent = c.text;
      row.title = '点击写入 Agent 提问';
      row.addEventListener('click', () => {
        setChatOpen(true);
        els.input.value = `请核实并精炼这个主张（标页码）：\n「${c.text}」\n（第 ${page} 页）\n`;
        autoGrow();
        els.input.focus();
      });
      claimsBox.appendChild(row);
    }
  }

  const sym = $('pr-symbols');
  sym.replaceChildren();
  for (const s of insight.symbols || []) {
    const chip = el('button', 'pr-chip sym', s.token);
    chip.type = 'button';
    chip.title = s.kind;
    chip.addEventListener('click', () => {
      setChatOpen(true);
      els.input.value = `「${s.token}」在本文中是什么含义？请取证并标页码。\n`;
      autoGrow(); els.input.focus();
    });
    sym.appendChild(chip);
  }
  if (!insight.symbols?.length) sym.appendChild(el('span', 'pr-chip muted', '—'));

  const nums = $('pr-numbers');
  nums.replaceChildren();
  for (const n of insight.numbers || []) {
    const row = el('div', 'pr-num');
    row.append(el('b', null, n.value), el('span', null, n.context || ''));
    nums.appendChild(row);
  }
  if (!insight.numbers?.length) nums.appendChild(el('p', 'pr-empty', '—'));
}

$('btn-page-rail')?.addEventListener('click', () => {
  pageRailOpen = !pageRailOpen;
  $('page-rail')?.classList.toggle('collapsed', !pageRailOpen);
  $('btn-page-rail')?.classList.toggle('on', pageRailOpen);
  if (pageRailOpen) schedulePageInsight();
});
$('pr-agent-claims')?.addEventListener('click', () => {
  if (!paperPages.length) { toast('先打开论文', true); return; }
  void send('请对当前论文做主张地图（可检验主张 + 证据页码）。', { skillId: 'claim-map' });
});
$('pr-agent-coach')?.addEventListener('click', () => {
  if (!paperPages.length) { toast('先打开论文', true); return; }
  void send(`我在第 ${currentPageNum()} 页，请当带读教练：这页看什么、下一跳哪里。`, { skillId: 'reading-coach' });
});
$('pr-to-bullets')?.addEventListener('click', () => {
  const bullets = contributionBulletsFromClaims(lastInsightClaims);
  if (!bullets.length) {
    // 尝试汇总已译页主张
    const all = [];
    for (const r of paperPages) {
      if (!r.translated) continue;
      all.push(...buildPageInsight({ translationText: r.translated, sourceText: r.text }).claims);
    }
    const b2 = contributionBulletsFromClaims(all);
    if (!b2.length) { toast('先翻译几页或等侧栏出现主张', true); return; }
    showContributionBullets(b2);
  } else {
    showContributionBullets(bullets);
  }
  switchView('submit');
});

function showContributionBullets(bullets) {
  const panel = $('contrib-panel');
  const list = $('contrib-list');
  if (!panel || !list) return;
  panel.hidden = false;
  list.replaceChildren();
  for (const b of bullets) list.appendChild(el('li', null, b));
  toast(`已生成 ${bullets.length} 条 contribution`);
}
$('contrib-copy')?.addEventListener('click', async () => {
  const items = [...($('contrib-list')?.querySelectorAll('li') || [])].map((li) => `• ${li.textContent}`);
  if (!items.length) return;
  try {
    await navigator.clipboard.writeText(items.join('\n'));
    toast('已复制贡献条');
  } catch { toast('复制失败', true); }
});
$('venue-bullets')?.addEventListener('click', () => {
  if (!paperPages.length) { toast('先打开并翻译论文', true); return; }
  const all = [];
  for (const r of paperPages) {
    if (!r.translated) continue;
    all.push(...buildPageInsight({ translationText: r.translated, sourceText: r.text }).claims);
  }
  const bullets = contributionBulletsFromClaims(all, { max: 5 });
  if (!bullets.length) {
    void send('请做主张地图，并改写成 3–5 条英文投稿 contribution bullets。', { skillId: 'claim-map' });
    return;
  }
  showContributionBullets(bullets);
});
function flashEl(node) { node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 700); }

// ---------------------------------------------------------------------------
// 双栏滚动联动（带开关 + Alt 临时解除）
// ---------------------------------------------------------------------------
const scrollSync = { lock: false, source: null, holdOff: false };
function isScrollLinkActive() { return scrollLinkEnabled && !scrollSync.holdOff && !scrollSync.lock; }
function currentPageFromScroll(container, getEl) {
  const top = container.getBoundingClientRect().top + 40;
  let best = 1; let bestDist = Infinity;
  for (const record of paperPages) {
    const elNode = getEl(record);
    const dist = Math.abs(elNode.getBoundingClientRect().top - top);
    if (dist < bestDist) { bestDist = dist; best = record.num; }
  }
  return best;
}
function bindScrollSync(from, to, getFromEl, getToEl, name) {
  let timer = null;
  from.addEventListener('scroll', () => {
    if (scrollSync.lock && scrollSync.source !== name) return;
    if (timer) return;
    timer = requestAnimationFrame(() => {
      timer = null;
      if (!paperPages.length || !isScrollLinkActive()) return;
      scrollSync.lock = true;
      scrollSync.source = name;
      const page = currentPageFromScroll(from, getFromEl);
      const target = getToEl(paperPages[page - 1]);
      const fromEl = getFromEl(paperPages[page - 1]);
      if (target && fromEl) {
        const fromTop = fromEl.getBoundingClientRect().top;
        const containerTop = from.getBoundingClientRect().top;
        const offset = fromTop - containerTop;
        const toContainerTop = to.getBoundingClientRect().top;
        const desired = target.getBoundingClientRect().top - toContainerTop;
        to.scrollTop += desired - offset;
      }
      highlightOutlineCurrent(page);
      updateStatusBar(page);
      maybeAutoTranslate(page);
      schedulePageInsight();
      requestAnimationFrame(() => { scrollSync.lock = false; scrollSync.source = null; });
    });
  }, { passive: true });
}
bindScrollSync(els.pdfPages, els.transPages, (r) => r.pdfEl, (r) => r.transEl, 'pdf');
bindScrollSync(els.transPages, els.pdfPages, (r) => r.transEl, (r) => r.pdfEl, 'trans');
// 即使关闭联动，滚动也要刷新本页洞察
els.pdfPages?.addEventListener('scroll', () => schedulePageInsight(), { passive: true });

function maybeAutoTranslate(page) {
  if (!autoTranslate) return;
  const record = paperPages[page - 1];
  if (record && !record.translated && !record.translating) void translatePaperPage(record);
}

// 联动开关
$('btn-scroll-link').addEventListener('click', async () => {
  scrollLinkEnabled = !scrollLinkEnabled;
  $('btn-scroll-link').classList.toggle('on', scrollLinkEnabled);
  await window.paperlens.setUiPrefs?.({ scrollLink: scrollLinkEnabled });
  toast(scrollLinkEnabled ? '已开启滚动联动' : '已关闭滚动联动（两栏独立滚动）');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Alt') scrollSync.holdOff = true;
});
document.addEventListener('keyup', (event) => {
  if (event.key === 'Alt') scrollSync.holdOff = false;
});

// ---------------------------------------------------------------------------
// 划词翻译（依赖 textLayer）
// ---------------------------------------------------------------------------
let selectionPopover = null;
function showSelectionPopover(text, rect, pageNum = 1) {
  selectionPopover?.remove();
  const pop = el('div', 'selection-popover');
  pop.appendChild(el('div', 'sp-src', text.slice(0, 120) + (text.length > 120 ? '…' : '')));
  const dst = el('div', 'sp-dst pending', '翻译中…');
  pop.appendChild(dst);
  const actions = el('div', 'sp-actions');
  const explainBtn = el('button', 'sp-btn', '✧ 解释'); explainBtn.type = 'button';
  explainBtn.title = '让 Agent 直接解释这段（结合本页上下文）';
  explainBtn.addEventListener('click', () => {
    closeSelectionPopover();
    void send(`请结合第 ${pageNum} 页上下文解释这段原文（术语、含义、在论文中的作用）：\n\n> ${text.slice(0, 800)}`, {});
  });
  const askBtn = el('button', 'sp-btn', '问 AI'); askBtn.type = 'button';
  askBtn.addEventListener('click', () => {
    closeSelectionPopover();
    setChatOpen(true);
    els.input.value = `关于论文里这段内容：\n"${text.slice(0, 600)}"\n\n`;
    autoGrow(); els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  });
  actions.append(explainBtn, askBtn);
  // 持久高亮
  if (currentPaper?.path) {
    const hlBtn = el('button', 'sp-btn', '高亮'); hlBtn.type = 'button';
    hlBtn.title = '保存高亮，重开论文后仍在';
    hlBtn.addEventListener('click', async () => {
      const result = await window.paperlens.addHighlight?.({
        path: currentPaper.path,
        page: pageNum,
        text: text.slice(0, 500),
        color: 'yellow',
      });
      if (result?.added || result?.highlight) {
        hlBtn.textContent = '✓ 已高亮';
        hlBtn.disabled = true;
        const record = paperPages[pageNum - 1];
        if (record?.rendered) void applyHighlightsToPage(record);
        toast('高亮已保存');
      } else toast(result?.highlight ? '已存在相同高亮' : '高亮失败', !result?.highlight);
    });
    actions.appendChild(hlBtn);
  }
  let lockBtn = null;
  if (text.length <= 80) {
    lockBtn = el('button', 'sp-btn', '锁定术语'); lockBtn.type = 'button'; lockBtn.disabled = true;
    actions.appendChild(lockBtn);
  }
  pop.appendChild(actions);
  const left = Math.min(rect.left, window.innerWidth - 420);
  const top = Math.min(rect.bottom + 8, window.innerHeight - 180);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  document.body.appendChild(pop);
  selectionPopover = pop;
  void window.paperlens.translateSelection({ text, glossary }).then((result) => {
    if (pop !== selectionPopover) return;
    if (result?.error) { dst.className = 'sp-dst err'; dst.textContent = `⚠ ${result.error}`; return; }
    dst.className = 'sp-dst';
    const translation = String(result.translation || '').trim();
    dst.textContent = translation;
    if (lockBtn) {
      lockBtn.disabled = false;
      lockBtn.addEventListener('click', async () => {
        const saved = await window.paperlens.lockTerm({ term: text, translation: translation.slice(0, 80) });
        await loadGlossary();
        lockBtn.textContent = `✓ 已锁定（共 ${saved.count} 条）`;
        lockBtn.disabled = true;
        toast(`术语已锁定：${text.slice(0, 24)} → ${translation.slice(0, 24)}`);
      });
    }
  });
}
function closeSelectionPopover() { selectionPopover?.remove(); selectionPopover = null; }
let glossary = [];
async function loadGlossary() {
  try { const ws = await window.paperlens.getWorkspace(); glossary = Array.isArray(ws.glossary) ? ws.glossary : []; } catch { glossary = []; }
  return glossary;
}
document.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection?.();
    const text = sel?.toString().trim() || '';
    if (text.length < 2 || text.length > 2000) { closeSelectionPopover(); return; }
    if (!sel.rangeCount) { closeSelectionPopover(); return; }
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const node = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const layer = node?.closest?.('.textLayer');
    if (!layer || !els.pdfPages.contains(layer)) { closeSelectionPopover(); return; }
    const pageEl = layer.closest('.pdf-page');
    const pageNum = Number(pageEl?.dataset?.page) || currentPageNum() || 1;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { closeSelectionPopover(); return; }
    showSelectionPopover(text, rect, pageNum);
  }, 10);
});
document.addEventListener('mousedown', (event) => {
  if (selectionPopover && !selectionPopover.contains(event.target)) closeSelectionPopover();
});

// ---------------------------------------------------------------------------
// 框选提问（对齐扩展）
// ---------------------------------------------------------------------------
let snipCleanup = null;
function startSnip() {
  if (snipCleanup) { snipCleanup(); return; }
  if (!paperPages.length) { toast('请先打开论文', true); return; }
  const overlay = el('div', 'snip-overlay');
  const hint = el('div', 'snip-hint', '按住左键框选要提问的图 / 公式 / 段落，Esc 取消');
  const rectEl = el('div', 'snip-rect');
  overlay.append(hint, rectEl);
  document.body.append(overlay);
  let start = null;
  const onDown = (event) => {
    start = { x: event.clientX, y: event.clientY };
    rectEl.style.left = `${event.clientX}px`; rectEl.style.top = `${event.clientY}px`;
    rectEl.style.width = '0px'; rectEl.style.height = '0px';
  };
  const onMove = (event) => {
    if (!start) return;
    const x = Math.min(start.x, event.clientX); const y = Math.min(start.y, event.clientY);
    const w = Math.abs(event.clientX - start.x); const h = Math.abs(event.clientY - start.y);
    rectEl.style.left = `${x}px`; rectEl.style.top = `${y}px`;
    rectEl.style.width = `${w}px`; rectEl.style.height = `${h}px`;
  };
  const onUp = async (event) => {
    if (!start) return;
    const box = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), w: Math.abs(event.clientX - start.x), h: Math.abs(event.clientY - start.y) };
    start = null;
    if (box.w < 12 || box.h < 12) { toast('框选区域太小，已取消'); cleanup(); return; }
    cleanup();
    await snipToChat(box);
  };
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);
  const onKey = (event) => { if (event.key === 'Escape') cleanup(); };
  document.addEventListener('keydown', onKey);
  function cleanup() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    snipCleanup = null;
  }
  snipCleanup = cleanup;
}
async function snipToChat(box) {
  // 找相交面积最大的页
  let best = null; let bestArea = 0;
  for (const record of paperPages) {
    const r = record.pdfEl.getBoundingClientRect();
    const ix = Math.max(0, Math.min(box.x + box.w, r.right) - Math.max(box.x, r.left));
    const iy = Math.max(0, Math.min(box.y + box.h, r.bottom) - Math.max(box.y, r.top));
    const area = ix * iy;
    if (area > bestArea) { bestArea = area; best = { record, r }; }
  }
  if (!best) { toast('请框选左侧 PDF 页面内的区域', true); return; }
  try {
    const { record, r } = best;
    const page = record.pageObj || await pdfDoc.getPage(record.num);
    record.pageObj = page;
    // 框选在页上的归一化坐标
    const left = (box.x - r.left) / r.width;
    const top = (box.y - r.top) / r.height;
    const right = (box.x + box.w - r.left) / r.width;
    const bottom = (box.y + box.h - r.top) / r.height;
    const baseVp = page.getViewport({ scale: 1 });
    const scale = 2.0; // 高清裁图
    const vp = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width); off.height = Math.round(vp.height);
    await page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport: vp }).promise;
    const sx = Math.max(0, Math.floor(left * vp.width));
    const sy = Math.max(0, Math.floor(top * vp.height));
    const sw = Math.max(1, Math.min(vp.width - sx, Math.ceil((right - left) * vp.width)));
    const sh = Math.max(1, Math.min(vp.height - sy, Math.ceil((bottom - top) * vp.height)));
    const cropped = document.createElement('canvas');
    cropped.width = sw; cropped.height = sh;
    cropped.getContext('2d').drawImage(off, sx, sy, sw, sh, 0, 0, sw, sh);
    off.width = 0; off.height = 0;
    const dataUrl = cropped.toDataURL('image/jpeg', 0.9);
    pendingAttachment = { dataUrl, label: `第 ${record.num} 页框选区域` };
    $('attach-thumb').src = dataUrl;
    $('attach-label').textContent = `已附第 ${record.num} 页框选图`;
    $('attach-strip').hidden = false;
    setChatOpen(true);
    els.input.value = `这张图说明了什么？（第 ${record.num} 页）\n\n`;
    autoGrow(); els.input.focus();
    toast('已附上框选图，输入问题即可发送');
  } catch (error) {
    toast(String(error?.message || error || '框选截图失败'), true);
  }
}
$('btn-snip').addEventListener('click', () => { switchView('reader'); setTimeout(startSnip, 60); });
$('attach-remove')?.addEventListener('click', () => { pendingAttachment = null; $('attach-strip').hidden = true; });

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------
function rebuildOutline() {
  const items = [];
  for (const record of paperPages) {
    if (!record.translated) continue;
    for (const line of String(record.translated).split('\n')) {
      const m = /^(#{1,4})\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const level = m[1].length;
      const title = m[2].replace(/\s+/g, ' ').trim().slice(0, 60);
      if (title) items.push({ level, title, page: record.num });
    }
  }
  const list = $('outline-list');
  list.replaceChildren();
  if (!items.length) { list.appendChild(el('div', 'outline-empty', '译完的页里出现标题后，这里会自动生成大纲。')); return; }
  for (const item of items.slice(0, 120)) {
    const li = el('li', `h${item.level}`, item.title);
    li.dataset.page = String(item.page);
    li.addEventListener('click', () => jumpToPage(item.page, 'both'));
    list.appendChild(li);
  }
}
function highlightOutlineCurrent(page) {
  const n = page || currentPageFromScroll(els.pdfPages, (r) => r.pdfEl);
  for (const li of $('outline-list').children) li.classList.toggle('current', Number(li.dataset.page) === n);
}
function onPaperTranslated() {
  rebuildOutline();
  $('btn-outline').classList.add('on');
  schedulePageInsight();
}
$('btn-outline').addEventListener('click', () => {
  const rail = $('outline-rail');
  rail.hidden = !rail.hidden;
  $('btn-outline').classList.toggle('on', !rail.hidden);
  if (!rail.hidden) rebuildOutline();
});

// ---------------------------------------------------------------------------
// 译文搜索（Ctrl+F）
// ---------------------------------------------------------------------------
let searchMatches = [];
let searchIndex = -1;
function clearSearchHighlights() {
  for (const node of els.transPages.querySelectorAll('.search-hit')) {
    const text = document.createTextNode(node.textContent);
    node.parentNode.replaceChild(text, node);
  }
  els.transPages.normalize?.();
}
function runSearch(query) {
  clearSearchHighlights();
  searchMatches = []; searchIndex = -1;
  const q = String(query || '').trim();
  if (!q) { $('search-count').textContent = ''; return; }
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(els.transPages, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue && node.nodeValue.toLowerCase().includes(lower) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const textNode of targets) {
    const raw = textNode.nodeValue || '';
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = new RegExp(lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
      const span = el('span', 'search-hit', m[0]);
      searchMatches.push(span);
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < raw.length) frag.appendChild(document.createTextNode(raw.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
  $('search-count').textContent = searchMatches.length ? `1 / ${searchMatches.length}` : '无';
  if (searchMatches.length) focusSearchMatch(0);
}
function focusSearchMatch(i) {
  if (!searchMatches.length) return;
  searchMatches.forEach((m) => m.classList.remove('current'));
  searchIndex = (i + searchMatches.length) % searchMatches.length;
  const m = searchMatches[searchIndex];
  m.classList.add('current');
  m.scrollIntoView({ block: 'center' });
  $('search-count').textContent = `${searchIndex + 1} / ${searchMatches.length}`;
}
$('btn-search').addEventListener('click', () => {
  if ($('search-bar').hidden) { $('search-bar').hidden = false; setTimeout(() => $('search-input').focus(), 50); }
  else { $('search-bar').hidden = true; clearSearchHighlights(); }
});
$('search-input').addEventListener('input', (e) => runSearch(e.target.value));
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); focusSearchMatch(searchIndex + (e.shiftKey ? -1 : 1)); }
});
$('search-next').addEventListener('click', () => focusSearchMatch(searchIndex + 1));
$('search-prev').addEventListener('click', () => focusSearchMatch(searchIndex - 1));
$('search-close').addEventListener('click', () => { $('search-bar').hidden = true; clearSearchHighlights(); });

// ---------------------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------------------
$('btn-zoom-in').addEventListener('click', () => { zoomScale = (zoomScale || 1) * 1.12; reRenderAllPages(); updateZoomLabel(); });
$('btn-zoom-out').addEventListener('click', () => { zoomScale = (zoomScale || 1) / 1.12; reRenderAllPages(); updateZoomLabel(); });
$('zoom-label').addEventListener('click', () => { zoomScale = null; reRenderAllPages(); updateZoomLabel(); });
function updateZoomLabel() {
  const label = $('zoom-label');
  if (zoomScale) label.textContent = `${Math.round(zoomScale * 100)}%`;
  else label.textContent = '适宽';
}
async function reRenderAllPages() {
  const cssWidth = Math.max(280, els.pdfPages.clientWidth - 36);
  lazyCssWidth = cssWidth;
  // 只重渲已渲染过的页；未渲染页更新占位尺寸，等滚到时按新宽度渲染
  for (const record of paperPages) {
    if (record.rendered) { try { await renderPdfPageVisual(record, cssWidth); } catch { /* noop */ } }
  }
}

// Gen18: 窗口大小变化时适宽模式自动重排（原来要重开论文才适配）
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!paperPages.length || zoomScale != null) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void reRenderAllPages(), 300);
});

// 自动译 / 对照开关
$('btn-auto-translate').addEventListener('click', async () => {
  autoTranslate = !autoTranslate;
  $('btn-auto-translate').classList.toggle('on', autoTranslate);
  await window.paperlens.setUiPrefs?.({ autoTranslate });
  if (autoTranslate) { const p = currentPageNum(); maybeAutoTranslate(p); toast('已开启自动翻译：滚到的未译页自动翻译'); }
  else toast('已关闭自动翻译');
});
$('btn-bilingual').addEventListener('click', async () => {
  const on = !$('btn-bilingual').classList.contains('on');
  $('btn-bilingual').classList.toggle('on', on);
  await window.paperlens.setUiPrefs?.({ bilingual: on });
  for (const record of paperPages) toggleBilingual(record, on);
});
function toggleBilingual(record, on) {
  let src = record.transEl.querySelector('.trans-source');
  if (on) {
    if (!src) {
      src = el('div', 'trans-source');
      record.transEl.appendChild(src);
    }
    src.textContent = record.text || '（本页无可提取文本，可能是扫描页）';
  } else if (src) {
    src.remove();
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
async function exportTranslationsMd() {
  const translated = paperPages.filter((r) => r.translated);
  if (!translated.length) { toast('还没有已译页可导出', true); return; }
  const lines = [`# ${currentPaper?.name?.replace(/\.pdf$/i, '') || '论文'} · 译文`, ''];
  for (const record of translated) { lines.push('---', '', `<!-- 第 ${record.num} 页 -->`, '', record.translated, ''); }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(currentPaper?.name || 'paper').replace(/\.pdf$/i, '')}-译文.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  toast(`已导出 ${translated.length} 页译文`);
}
$('btn-export-md').addEventListener('click', () => void exportTranslationsMd());

// ---------------------------------------------------------------------------
// Gen11/12: 高亮列表抽屉——查看、跳转、删除、让 Agent 串讲
// ---------------------------------------------------------------------------
async function openHighlightsDrawer() {
  const drawer = $('highlights-drawer'); const list = $('highlights-list');
  if (!drawer || !list) return;
  if (!currentPaper?.path) { toast('先打开一篇论文', true); return; }
  setChatOpen(false); $('notes-drawer').hidden = true; $('todos-drawer').hidden = true;
  const { highlights = [] } = await window.paperlens.listHighlights?.(currentPaper.path) || {};
  list.replaceChildren();
  if (!highlights.length) list.appendChild(el('div', 'notes-empty', '还没有高亮。左栏划词后点「高亮」即可保存。'));
  for (const h of highlights) {
    const item = el('div', 'note-item');
    const head = el('div', 'n-head');
    const jump = el('button', 'n-title hl-jump', `第 ${h.page} 页`); jump.type = 'button';
    jump.addEventListener('click', () => { drawer.hidden = true; jumpToPage(h.page, 'both'); });
    const del = el('button', 'n-del', '删除'); del.type = 'button';
    del.addEventListener('click', async () => {
      await window.paperlens.removeHighlight?.({ path: currentPaper.path, id: h.id });
      item.remove();
      const record = paperPages[h.page - 1];
      if (record?.textLayer) {
        for (const s of record.textLayer.querySelectorAll(`[data-hl-id="${CSS.escape(h.id)}"]`)) {
          s.classList.remove('hl-mark', `hl-${h.color || 'yellow'}`); s.removeAttribute('data-hl-id'); s.removeAttribute('title');
        }
      }
    });
    head.append(jump, del);
    item.append(head, el('div', 'n-body', h.text));
    list.appendChild(item);
  }
  drawer.hidden = false;
}
$('btn-highlights')?.addEventListener('click', () => void openHighlightsDrawer());
$('highlights-close')?.addEventListener('click', () => $('highlights-drawer').hidden = true);
$('highlights-ask')?.addEventListener('click', () => {
  $('highlights-drawer').hidden = true;
  void send('请调用 list_user_highlights 读出我在这篇论文上的全部高亮，按主题串讲：我为什么会标这些、它们之间的联系、还应该注意哪几页。', {});
});

// 阅读进度 + 统计计时
let progressTimer = null;
let readTimer = null;
function setupReadTimer() {
  clearInterval(readTimer);
  readTimer = setInterval(() => { void window.paperlens.recordStat?.('read-minutes', 1); }, 60000);
}
els.pdfPages.addEventListener('scroll', () => {
  if (progressTimer || !currentPaper?.path) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    void window.paperlens.touchRecent({
      path: currentPaper.path, title: currentPaper.name,
      totalPages: currentPaper.totalPages, lastPage: currentPageNum(),
      translatedCount: paperPages.filter((r) => r.translated).length,
    });
  }, 600);
}, { passive: true });

// Gen14: 点状态栏页码输入跳页
els.statusPage.addEventListener('click', () => {
  if (!paperPages.length) return;
  const v = prompt(`跳到第几页？（1–${paperPages.length}）`, String(currentPageNum()));
  const n = Math.round(Number(v));
  if (n >= 1 && n <= paperPages.length) jumpToPage(n, 'both');
});
els.statusPage.style.cursor = 'pointer';
els.statusPage.title = '点击跳页';

function updateStatusBar(page) {
  const p = page || currentPageNum();
  if (currentPaper) {
    els.statusPage.hidden = false;
    els.statusPage.textContent = `第 ${p} / ${currentPaper.totalPages} 页`;
  }
  const translated = paperPages.filter((r) => r.translated).length;
  if (currentPaper && translated) {
    els.statusTranslated.hidden = false;
    els.statusTranslated.textContent = `已译 ${translated}/${paperPages.length}`;
  }
  if (!$('chat-drawer').hidden) refreshComposerCtx(); // Gen9: 停靠面板情境随翻页刷新
  if (p !== lastInsightPage) schedulePageInsight();
  else schedulePageInsight(); // 译文更新后也刷新
}

// ---------------------------------------------------------------------------
// 整页视觉翻译
// ---------------------------------------------------------------------------
window.paperlens.onTranslateDelta(({ page, delta }) => {
  const record = paperPages[page - 1];
  if (!record || !record.translating) return;
  record.streamRaw += String(delta || '');
  record.transBody.className = 'trans-body streaming';
  renderMarkdownInto(record.transBody, record.streamRaw);
});

// 灾难性质量失败（拒答/自言自语/重复死循环/空输出）才自动重试；普通告警不阻断阅读（扩展 Gen14 教训）
const CATASTROPHIC_QUALITY = new Set(['empty', 'model-refusal', 'model-self-talk', 'repetition-loop']);
function isCatastrophicQuality(quality) {
  if (!quality || quality.ok !== false) return false;
  return (quality.reasons || [quality.reason]).some((r) => CATASTROPHIC_QUALITY.has(String(r)));
}
async function renderPageImage(record, width) {
  const page = record.pageObj || await pdfDoc.getPage(record.num);
  record.pageObj = page;
  const scale = width / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const off = document.createElement('canvas');
  off.width = Math.round(viewport.width); off.height = Math.round(viewport.height);
  await page.render({ canvasContext: off.getContext('2d', { alpha: false }), viewport }).promise;
  const image = off.toDataURL('image/jpeg', 0.9);
  off.width = 0; off.height = 0;
  return image;
}
async function translatePaperPage(record, { force = false } = {}) {
  if (record.translating) return;
  if (record.translated && !force) return;
  if (!force) {
    const cacheKey = await pageCacheKey(record);
    const cached = await cacheGet(cacheKey);
    if (cached) {
      record.translated = cached;
      record.transBody.className = 'trans-body';
      renderMarkdownInto(record.transBody, cached);
      record.transBtn.textContent = '重译';
      onPaperTranslated(); updateStatusBar();
      return;
    }
  }
  record.translating = true;
  record.streamRaw = '';
  record.transBtn.disabled = true;
  record.transBtn.textContent = '翻译中…';
  record.transBody.className = 'trans-body streaming';
  record.transBody.textContent = '正在分析页面…';
  try {
    // 懒抽取还没到这页时按需补文本（质量门锚点和术语命中都依赖）
    if (!record.text) {
      try {
        const page = record.pageObj || await pdfDoc.getPage(record.num);
        record.pageObj = page;
        const tc = await page.getTextContent();
        record.text = (tc.items || []).map((it) => String(it.str || '')).join(' ').replace(/\s+/g, ' ').trim();
      } catch { /* 无文字层（扫描页）也允许翻译 */ }
    }
    let image = await renderPageImage(record, 1500);
    let result = await window.paperlens.translatePage({ page: record.num, image, sourceText: record.text });
    // 质量门：灾难性失败自动以 2050px + temperature 0 + 失败原因上下文重试一次
    if (!result?.error && isCatastrophicQuality(result?.quality)) {
      setStatus(`第 ${record.num} 页首译质量异常（${result.quality.reason}），正在高精度重译…`);
      record.streamRaw = '';
      image = await renderPageImage(record, 2050);
      const retry = await window.paperlens.translatePage({
        page: record.num, image, sourceText: record.text, qualityRetry: result.quality,
      });
      // 重试结果非空且不再灾难性失败才替换；否则保留首译（可读优先，不清空页面）
      if (!retry?.error && retry?.markdown?.trim() && !isCatastrophicQuality(retry?.quality)) result = retry;
    }
    record.translating = false;
    record.transBtn.disabled = false;
    if (result?.error) {
      record.transBody.className = 'trans-body err';
      record.transBody.textContent = `⚠ ${result.error}`;
      record.transBtn.textContent = '重试';
      return;
    }
    record.translated = result.markdown || record.streamRaw || '';
    record.transBody.className = 'trans-body';
    renderMarkdownInto(record.transBody, record.translated);
    record.transBtn.textContent = '重译';
    // 非灾难性告警只提示不阻断；Gen4: 告警同时给一个「让 Agent 核对」入口
    if (result.quality && !isCatastrophicQuality(result.quality)) {
      record.transEl.title = `质量提示：${result.quality.message || result.quality.reason}`;
      let warn = record.transEl.querySelector('.quality-warn');
      warn?.remove();
      warn = el('button', 'quality-warn', `⚠ ${String(result.quality.message || result.quality.reason).slice(0, 40)} · ✧ 让 Agent 核对`);
      warn.type = 'button';
      warn.addEventListener('click', () => {
        warn.remove();
        void send(`第 ${record.num} 页的翻译质量检查提示「${result.quality.message || result.quality.reason}」。请 read_paper_page 取第 ${record.num} 页原文，核对译文是否有漏段/错译/公式问题，指出具体差异。`, {});
      });
      record.transEl.querySelector('.trans-page-head')?.after(warn);
    } else {
      record.transEl.querySelector('.quality-warn')?.remove();
    }
    const cacheKey = await pageCacheKey(record);
    // 灾难性失败的结果不进缓存（下次重开重新译），普通结果正常缓存
    if (record.translated.trim() && !isCatastrophicQuality(result.quality)) void cacheSet(cacheKey, record.translated);
    onPaperTranslated(); updateStatusBar();
    void window.paperlens.recordStat?.('page-translated', 1);
    // Gen30: 估算 token（视觉页 ≈ 图片 1100 + 输出 len/2）——之前统计页 token 恒为 0
    void window.paperlens.recordStat?.('tokens', 1100 + Math.round((record.translated.length + (record.text?.length || 0)) / 2));
    // 对照开关开着则补原文
    if ($('btn-bilingual').classList.contains('on')) toggleBilingual(record, true);
  } catch (err) {
    record.translating = false;
    record.transBtn.disabled = false;
    record.transBody.className = 'trans-body err';
    record.transBody.textContent = `⚠ ${err?.message || err}`;
    record.transBtn.textContent = '重试';
  }
}

let translateAllActive = false;
async function translateAll() {
  if (translateAllActive) { translateAllActive = false; $('btn-translate-all').textContent = '译全篇'; return; }
  translateAllActive = true;
  $('btn-translate-all').textContent = '停止翻译';
  const start = currentPageNum();
  const queue = [...paperPages.slice(start - 1), ...paperPages.slice(0, start - 1)].filter((r) => !r.translated);
  let done = 0;
  for (const record of queue) {
    if (!translateAllActive) break;
    await translatePaperPage(record);
    done += 1;
    // Gen16: 按钮上直接显示进度，不用只盯状态栏
    $('btn-translate-all').textContent = `停止（${done}/${queue.length}）`;
    setStatus(`译全篇进行中：${done}/${queue.length}`);
  }
  translateAllActive = false;
  $('btn-translate-all').textContent = '译全篇';
  setStatus(done ? `译全篇完成 ${done} 页` : '已停止');
}
$('btn-translate-all').addEventListener('click', () => void translateAll());

$('btn-open-pdf').addEventListener('click', async () => {
  const result = await window.paperlens.pickPdf();
  if (result?.error) { setStatus(result.error, true); return; }
  if (result?.ok) await openPdfData(result);
});
$('home-open-pdf').addEventListener('click', () => $('btn-open-pdf').click());
$('home-ask-agent').addEventListener('click', () => { switchView('reader'); toggleChat(); });

// 拖拽打开
function setupDrop(target) {
  target.addEventListener('dragover', (e) => e.preventDefault());
  target.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 嵌套目标（pdf-pane 在 workspace 里）会让同一次 drop 冒泡触发两个 handler，
    // 同一 PDF 被并发打开两次 → paperPages 出现脱离 DOM 的僵尸记录。就地截断。
    e.stopPropagation();
    // Gen27: 支持一次拖多个 PDF——依次开成多标签
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name));
    if (!files.length) return;
    for (const file of files.slice(0, 8)) {
      const path = file.path || '';
      if (path) { await openByPath(path); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await openPdfData({ path: '', name: file.name, data: btoa(binary) });
    }
    if (files.length > 1) toast(`已打开 ${Math.min(files.length, 8)} 篇（标签栏切换）`);
  });
}
setupDrop(els.pdfPane);
setupDrop(els.workspace);
setupDrop($('view-home'));

// 粘贴 arXiv 链接
document.addEventListener('paste', async (event) => {
  if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'TEXTAREA') return;
  const text = (event.clipboardData?.getData('text') || '').trim();
  const m = text.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i) || text.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/);
  if (!m) return;
  event.preventDefault();
  toast(`正在下载 arXiv ${m[1]}…`);
  const result = await window.paperlens.openArxivPdf({ arxivId: m[1] });
  if (result?.error) { toast(result.error, true); return; }
  if (result?.ok) await openPdfData(result);
});

// 分栏拖拽
let dragging = false;
els.divider.addEventListener('pointerdown', (e) => { dragging = true; els.divider.setPointerCapture(e.pointerId); });
els.divider.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = els.workspace.getBoundingClientRect();
  const outlineW = $('outline-rail').hidden ? 0 : $('outline-rail').offsetWidth;
  const x = e.clientX - rect.left - outlineW;
  const usable = rect.width - outlineW;
  const pct = Math.min(70, Math.max(28, (x / usable) * 100));
  els.pdfPane.style.width = `${pct}%`;
});
els.divider.addEventListener('pointerup', () => { dragging = false; });

// ---------------------------------------------------------------------------
// 笔记 / 待办（抽屉）
// ---------------------------------------------------------------------------
function attachAnswerActions(message, question, answer) {
  if (!answer.trim()) return;
  const actions = el('div', 'msg-actions');  const save = el('button', null, '☆ 收入笔记'); save.type = 'button';
  save.addEventListener('click', async () => {
    const result = await window.paperlens.addNote({ title: question.slice(0, 60), content: answer, paperTitle: currentPaper?.name || '', source: 'ai' });
    save.textContent = result.added ? '★ 已收藏' : '★ 已在笔记中'; save.disabled = true;
    void refreshNotesCount();
    if (result.added) {
      const obs = await window.paperlens.obsidianStatus();
      if (obs?.enabled) {
        const wrote = await window.paperlens.writeNoteToObsidian({ title: question.slice(0, 60), content: answer, paperTitle: currentPaper?.name || '', source: 'ai' });
        if (wrote?.ok) setStatus('已收藏并写入 Obsidian vault');
      }
    }
  });
  const copy = el('button', null, '⧉ 复制'); copy.type = 'button';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(answer); copy.textContent = '✓ 已复制'; } catch { /* noop */ } setTimeout(() => { copy.textContent = '⧉ 复制'; }, 1200); });
  const insert = el('button', null, '✎ 插入草稿'); insert.type = 'button';
  insert.title = '追加到写作工坊当前草稿末尾';
  insert.addEventListener('click', () => {
    const body = $('write-body');
    if (!body) return;
    body.value = body.value ? `${body.value.replace(/\s+$/, '')}\n\n${answer}` : answer;
    switchView('write');
    toast('已插入写作草稿（记得保存）');
  });
  actions.append(save, copy, insert);
  message.content.after(actions);
  // Gen3: 追问建议——把回答变成下一步动作的起点
  const followups = el('div', 'followup-bar');
  const sugg = [
    ['↳ 展开讲', `针对你上面的回答，挑最重要的一点展开细讲，引用原文页码。`],
    ['↳ 有何局限', `上面的结论有什么局限或反例？请批判性核查，必要时重新取证。`],
    ['↳ 相关工作', `围绕上面讨论的主题，检索 arXiv 找 3 篇最相关论文并简评。`],
  ];
  for (const [label, q] of sugg) {
    const b = el('button', 'followup-chip', label); b.type = 'button';
    b.addEventListener('click', () => { followups.remove(); void send(q); });
    followups.appendChild(b);
  }
  actions.after(followups);
}
async function refreshNotesCount() {
  const workspace = await window.paperlens.getWorkspace();
  const count = workspace.notes?.length || 0;
  $('notes-count').hidden = !count;
  $('notes-count').textContent = String(count);
  return workspace;
}
async function refreshTodoBadge() {
  const pill = $('todos-count');
  if (!pill || !window.paperlens.listTodos) return;
  try {
    const data = await window.paperlens.listTodos({ paperPath: currentPaper?.path || '', includeDone: false });
    const n = (data.todos || []).filter((t) => !t.done).length;
    pill.hidden = !n; pill.textContent = String(n);
  } catch { /* noop */ }
}
async function openTodosDrawer() {
  const drawer = $('todos-drawer'); const list = $('todos-list'); const memList = $('memory-list');
  setChatOpen(false); $('notes-drawer').hidden = true;
  const data = await window.paperlens.listTodos({ paperPath: currentPaper?.path || '', includeDone: true });
  list.replaceChildren();
  const todos = data.todos || [];
  if (!todos.length) list.appendChild(el('div', 'notes-empty', '还没有待办。可让 Agent 添加，或在下方手动添加。'));
  for (const todo of todos) {
    const row = el('div', `todo-item${todo.done ? ' done' : ''}`);
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = Boolean(todo.done);
    check.addEventListener('change', async () => { await window.paperlens.setTodoDone({ id: todo.id, done: check.checked }); void openTodosDrawer(); void refreshTodoBadge(); });
    const body = el('div', 'todo-text', todo.text);
    if (todo.paperTitle) body.appendChild(el('span', 'todo-paper', todo.paperTitle));
    row.append(check, body); list.appendChild(row);
  }
  memList.replaceChildren();
  const mem = data.memory || [];
  if (!mem.length) memList.appendChild(el('div', 'notes-empty', '尚无跨会话要点。Agent 可用 remember_research_fact 写入。'));
  for (const item of mem) memList.appendChild(el('div', 'mem-item', item.fact));
  // Gen23: 待办可一键让 Agent 接着干
  const openTodos = todos.filter((t) => !t.done);
  if (openTodos.length) {
    const goBtn = el('button', 'primary-btn todo-go', `✧ 让 Agent 推进这 ${openTodos.length} 项待办`);
    goBtn.type = 'button';
    goBtn.addEventListener('click', () => {
      drawer.hidden = true;
      void send('请 list_project_memory 读出我的课题待办与要点，挑最可推进的 1–2 项直接开始做（取证/调研/起草），完成的用 complete_research_todo 勾掉。', {});
    });
    list.prepend(goBtn);
  }
  drawer.hidden = false; void refreshTodoBadge();
}
$('btn-todos')?.addEventListener('click', () => void openTodosDrawer());
$('todos-close')?.addEventListener('click', () => $('todos-drawer').hidden = true);
$('todo-add-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('todo-input');
  const text = input?.value?.trim();
  if (!text) return;
  await window.paperlens.addTodo({ text, paperPath: currentPaper?.path || '', paperTitle: currentPaper?.name || '' });
  input.value = ''; void openTodosDrawer();
});
async function openNotesDrawer() {
  const workspace = await refreshNotesCount();
  setChatOpen(false); $('todos-drawer').hidden = true;
  const list = $('notes-list'); list.replaceChildren();
  if (!workspace.notes?.length) list.appendChild(el('div', 'notes-empty', '还没有笔记。AI 回答下点「☆ 收入笔记」即可收藏。'));
  for (const note of workspace.notes || []) {
    const item = el('div', 'note-item');
    const head = el('div', 'n-head');
    const del = el('button', 'n-del', '删除'); del.type = 'button';
    del.addEventListener('click', async () => { await window.paperlens.removeNote(note.id); item.remove(); void refreshNotesCount(); });
    head.append(el('span', 'n-title', note.title), del);
    item.appendChild(head);
    if (note.paperTitle) item.appendChild(el('div', 'n-paper', `📄 ${note.paperTitle}`));
    // Gen22: 笔记正文渲染 Markdown（公式/列表可读），长内容折叠
    const body = el('div', 'n-body md');
    renderMarkdownInto(body, note.content);
    if (String(note.content || '').length > 600) {
      body.classList.add('collapsed');
      const more = el('button', 'n-more', '展开全文'); more.type = 'button';
      more.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed');
        more.textContent = collapsed ? '展开全文' : '收起';
      });
      item.append(body, more);
    } else item.appendChild(body);
    list.appendChild(item);
  }
  $('notes-drawer').hidden = false;
}
$('btn-notes').addEventListener('click', () => void openNotesDrawer());
$('notes-close').addEventListener('click', () => $('notes-drawer').hidden = true);
$('notes-export').addEventListener('click', async () => {
  const result = await window.paperlens.exportNotes();
  if (result?.error) setStatus(result.error, true);
  else if (result?.ok) setStatus(`笔记已导出：${result.filePath}`);
});

// ---------------------------------------------------------------------------
// 最近阅读（阅读器空态）
// ---------------------------------------------------------------------------
function recentCardModelLocal(entry) {
  const name = String(entry.title || '').replace(/\.pdf$/i, '');
  const progress = entry.totalPages ? Math.min(100, Math.round((entry.lastPage / entry.totalPages) * 100)) : 0;
  return { ...entry, displayTitle: name.length > 60 ? `${name.slice(0, 57)}…` : name, progressPercent: progress,
    subtitle: entry.totalPages ? `读到第 ${entry.lastPage} / ${entry.totalPages} 页${entry.translatedCount ? ` · 已译 ${entry.translatedCount} 页` : ''}` : '尚未开始' };
}
async function renderRecentList() {
  const workspace = await window.paperlens.getWorkspace();
  const list = els.recentList; list.replaceChildren();
  for (const entry of (workspace.recent || []).slice(0, 5)) {
    const model = recentCardModelLocal(entry);
    const card = el('button', 'recent-card'); card.type = 'button';
    const bar = el('div', 'rc-bar'); const fill = el('i'); fill.style.width = `${model.progressPercent}%`;
    bar.appendChild(fill);
    card.append(el('div', 'rc-title', model.displayTitle), el('div', 'rc-sub', model.subtitle), bar);
    card.addEventListener('click', () => void openByPath(entry.path, entry.lastPage));
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 首页
// ---------------------------------------------------------------------------
async function renderHome() {
  const ws = await window.paperlens.getWorkspace();
  // 问候
  const h = new Date().getHours();
  $('home-greeting').textContent = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
  // 继续阅读
  const recentList = $('home-recent-list');
  const recent = (ws.recent || []).filter((e) => e.starred || (e.lastPage > 1 && e.totalPages && e.lastPage < e.totalPages) || e.translatedCount).slice(0, 4);
  recentList.replaceChildren();
  if (!recent.length) recentList.innerHTML = '<p class="hc-empty">打开过的论文会出现在这里</p>';
  for (const entry of recent) {
    const model = recentCardModelLocal(entry);
    const btn = el('button', 'hc-item');
    btn.innerHTML = `<span>${model.displayTitle}</span><span class="hc-sub">${model.subtitle}</span>`;
    btn.addEventListener('click', () => void openByPath(entry.path, entry.lastPage));
    recentList.appendChild(btn);
  }
  // 待读清单
  const rl = $('home-reading-list');
  const reading = (ws.readingList || []).filter((r) => !r.done).slice(0, 4);
  rl.replaceChildren();
  if (!reading.length) rl.innerHTML = '<p class="hc-empty">暂无待读论文 — 去雷达找</p>';
  for (const item of reading) {
    const row = el('div', 'hc-item-row');
    const btn = el('button', 'hc-item');
    btn.innerHTML = `<span>${String(item.title).slice(0, 70)}</span><span class="hc-sub">${item.summary ? String(item.summary).slice(0, 60) : (item.arxivId || '')}</span>`;
    btn.addEventListener('click', () => {
      if (item.arxivId) { toast(`正在下载 ${item.arxivId}…`); void window.paperlens.openArxivPdf({ arxivId: item.arxivId, title: item.title }).then((r) => { if (r?.ok) openPdfData(r); else if (r?.error) toast(r.error, true); }); }
    });
    // Gen20: 一键标记已读，从清单清掉
    const done = el('button', 'hc-done', '✓'); done.type = 'button'; done.title = '标记已读';
    done.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.paperlens.setReadingItem({ id: item.id, done: true });
      row.remove();
      if (!rl.children.length) rl.innerHTML = '<p class="hc-empty">暂无待读论文 — 去雷达找</p>';
    });
    row.append(btn, done);
    rl.appendChild(row);
  }
  // 投稿 DDL
  const ddlList = $('home-ddl-list');
  try {
    const { board } = await window.paperlens.getVenues();
    const upcoming = board.filter((v) => v.countdown && !v.countdown.passed).slice(0, 3);
    ddlList.replaceChildren();
    if (!upcoming.length) ddlList.innerHTML = '<p class="hc-empty">未设置投稿目标</p>';
    for (const venue of upcoming) {
      const chip = el('span', `hc-ddl-chip ${venue.countdown.urgency}`, venue.countdown.label);
      const btn = el('button', 'hc-item');
      btn.innerHTML = `<span>${venue.abbr} <span class="hc-sub">${venue.name}</span></span>`;
      btn.appendChild(chip);
      btn.addEventListener('click', () => switchView('submit')); // Gen28: DDL 卡片可点进投稿助手
      ddlList.appendChild(btn);
    }
  } catch { /* noop */ }
  // 本周统计
  try {
    const stats = await window.paperlens.getStats();
    const w = stats.week;
    $('home-stats-body').innerHTML = `<div class="hc-stat-row">
      <div class="hc-stat"><b>${w.readMinutes}</b><span>阅读分钟</span></div>
      <div class="hc-stat"><b>${w.pagesTranslated}</b><span>翻译页</span></div>
      <div class="hc-stat"><b>${w.agentAsks}</b><span>问 Agent</span></div>
      <div class="hc-stat"><b>${w.activeDays}</b><span>活跃天</span></div>
    </div>`;
  } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// 文库
// ---------------------------------------------------------------------------
let libStarOnly = false;
let libTagFilter = '';
let libQuery = ''; // Gen24: 搜索词并入统一渲染，结果保留标签/星标/进度
async function renderLibrary() {
  const grid = $('lib-grid');
  const tagsBox = $('lib-tags');
  let entries; let tags;
  try {
    const data = await window.paperlens.getLibrary({ query: libQuery, starredOnly: libStarOnly, tag: libTagFilter });
    entries = data.entries || []; tags = data.tags || [];
  } catch { entries = []; tags = []; }
  // 标签栏
  tagsBox.replaceChildren();
  const all = el('button', `lib-tag${libTagFilter ? '' : ' on'}`, '全部');
  all.addEventListener('click', () => { libTagFilter = ''; void renderLibrary(); });
  tagsBox.appendChild(all);
  for (const { tag, count } of tags.slice(0, 12)) {
    const btn = el('button', `lib-tag${libTagFilter === tag ? ' on' : ''}`, `${tag} ${count}`);
    btn.addEventListener('click', () => { libTagFilter = libTagFilter === tag ? '' : tag; void renderLibrary(); });
    tagsBox.appendChild(btn);
  }
  // 卡片
  grid.replaceChildren();
  if (!entries.length) {
    // Gen25: 空态区分「文库真空」和「筛选无结果」
    const filtered = libQuery || libStarOnly || libTagFilter;
    grid.appendChild(el('p', 'hc-empty', filtered ? '没有符合筛选条件的论文 — 试试清掉搜索词 / 标签 / 星标筛选' : '文库为空 — 打开过的论文会自动收录'));
    return;
  }
  for (const entry of entries) {
    const model = recentCardModelLocal(entry);
    const card = el('div', 'lib-card');
    const title = el('div', 'lc-title', model.displayTitle);
    title.addEventListener('click', () => void openByPath(entry.path, entry.lastPage));
    const star = el('button', `lc-star${entry.starred ? ' on' : ''}`, entry.starred ? '★' : '☆');
    star.title = entry.starred ? '取消星标' : '星标';
    star.addEventListener('click', async () => { await window.paperlens.updateLibraryEntry(entry.path, { starred: !entry.starred }); void renderLibrary(); });
    if (entry.oneLiner) card.appendChild(el('div', 'lc-oneliner', entry.oneLiner));
    const meta = el('div', 'lc-meta');
    meta.append(star, el('span', null, model.subtitle));
    const tagsRow = el('div', 'lc-tags');
    for (const tag of entry.tags || []) {
      const t = el('span', 'lc-tag', tag);
      t.title = '点击移除';
      t.addEventListener('click', async () => { await window.paperlens.updateLibraryEntry(entry.path, { removeTag: tag }); void renderLibrary(); });
      tagsRow.appendChild(t);
    }
    const addTag = el('button', 'lc-addtag', '＋ 标签');
    addTag.addEventListener('click', async () => {
      const tag = prompt('标签名：'); if (!tag) return;
      await window.paperlens.updateLibraryEntry(entry.path, { addTag: tag });
      void renderLibrary();
    });
    tagsRow.appendChild(addTag);
    const bar = el('div', 'lc-bar'); const fill = el('i'); fill.style.width = `${model.progressPercent}%`; bar.appendChild(fill);
    // Gen19: 文库卡片直连 Agent + 可移出文库
    const ops = el('div', 'lc-ops');
    const askBtn = el('button', 'lc-op', '✧ 问'); askBtn.type = 'button'; askBtn.title = '打开并让 Agent 深读';
    askBtn.addEventListener('click', async () => {
      await openByPath(entry.path, entry.lastPage);
      void send('请对当前论文做一键深读。', { skillId: 'deep-read' });
    });
    const rmBtn = el('button', 'lc-op', '移出'); rmBtn.type = 'button'; rmBtn.title = '从文库移除（不删除文件）';
    rmBtn.addEventListener('click', async () => {
      if (!confirm(`把《${model.displayTitle}》移出文库？（不会删除 PDF 文件）`)) return;
      await window.paperlens.removeLibraryEntry?.(entry.path);
      void renderLibrary();
    });
    ops.append(askBtn, rmBtn);
    card.append(title, meta, tagsRow, bar, ops);
    grid.appendChild(card);
  }
}
$('lib-search')?.addEventListener('input', (e) => { debouncedLibSearch(e.target.value); });
let libSearchTimer = null;
function debouncedLibSearch(q) {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => { libQuery = String(q || '').trim(); void renderLibrary(); }, 220);
}
$('lib-star-filter')?.addEventListener('click', () => { libStarOnly = !libStarOnly; $('lib-star-filter').classList.toggle('on', libStarOnly); void renderLibrary(); });
$('lib-import')?.addEventListener('click', async () => {
  setStatus('选择文件夹后开始扫描…');
  const result = await window.paperlens.importFolder?.();
  if (result?.cancelled) { setStatus(''); return; }
  if (result?.note) { toast(result.note, true); return; }
  toast(`已收录 ${result?.imported ?? 0} 篇（共扫到 ${result?.total ?? 0} 个 PDF）`);
  void renderLibrary();
});

// ---------------------------------------------------------------------------
// 前沿雷达
// ---------------------------------------------------------------------------
let radarLoaded = false;
let radarInterests = { categories: [], keywords: [] };
let radarRanked = [];
async function refreshRadar() {
  $('radar-list').innerHTML = '<p class="hc-empty">正在抓取最新论文…</p>';
  const result = await window.paperlens.fetchRadar();
  if (result?.needsSetup) {
    radarInterests = { categories: [], keywords: [] };
    renderRadarSetup(result.presets || []);
    $('radar-setup').hidden = false;
    $('radar-list').innerHTML = '<p class="hc-empty">点上方「兴趣设置」选好方向并保存，再来刷新</p>';
    radarLoaded = true;
    return;
  }
  if (result?.error) { $('radar-list').innerHTML = `<p class="hc-empty" style="color:var(--danger)">⚠ ${result.error}</p>`; radarLoaded = true; return; }
  radarInterests = result.interests || { categories: [], keywords: [] };
  // 若档案自动种了关键词但用户未保存，提示可一键采纳
  if (result.autoSeeded && result.suggestedKeywords?.length) {
    radarInterests = {
      ...radarInterests,
      keywords: [...new Set([...(radarInterests.keywords || []), ...result.suggestedKeywords])],
    };
  }
  radarRanked = result.papers || [];
  renderRadarSetup(result.presets || []);
  renderRadarList();
  if (result.autoSeeded) {
    toast('已用研究档案关键词临时打分 — 可在兴趣设置里保存');
  }
  radarLoaded = true;
}
function renderRadarSetup(presets) {
  const cats = $('radar-cats'); cats.replaceChildren();
  for (const cat of presets) {
    const btn = el('button', `radar-cat${radarInterests.categories.includes(cat.id) ? ' on' : ''}`, cat.label);
    btn.addEventListener('click', () => {
      const idx = radarInterests.categories.indexOf(cat.id);
      if (idx >= 0) radarInterests.categories.splice(idx, 1); else radarInterests.categories.push(cat.id);
      btn.classList.toggle('on');
    });
    cats.appendChild(btn);
  }
  renderRadarKeywords();
}
function renderRadarKeywords() {
  const box = $('radar-keywords'); box.replaceChildren();
  for (const kw of radarInterests.keywords) {
    const chip = el('span', 'radar-kw');
    chip.append(document.createTextNode(kw), el('button', null, '✕'));
    chip.querySelector('button').addEventListener('click', () => {
      radarInterests.keywords = radarInterests.keywords.filter((k) => k !== kw);
      renderRadarKeywords();
    });
    box.appendChild(chip);
  }
}
$('radar-kw-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !radarInterests.keywords.includes(v)) { radarInterests.keywords.push(v); renderRadarKeywords(); }
    e.target.value = '';
  }
});
$('radar-setup-toggle')?.addEventListener('click', () => { $('radar-setup').hidden = !$('radar-setup').hidden; });
$('radar-save')?.addEventListener('click', async () => {
  await window.paperlens.setInterests(radarInterests);
  toast('兴趣已保存'); $('radar-setup').hidden = true;
  void refreshRadar();
});
$('radar-refresh')?.addEventListener('click', () => void refreshRadar());
$('radar-digest')?.addEventListener('click', async () => {
  if (!radarRanked.length) { toast('先刷新拿到论文', true); return; }
  const result = await window.paperlens.radarDigestToVault(radarRanked);
  if (result?.ok) toast(`日报已写入 vault：${result.filePath}`);
  else if (result?.reason === 'not-configured') toast('请先在设置里配置 Obsidian vault', true);
  else toast(result?.reason || '写入失败', true);
});
function renderRadarList() {
  const list = $('radar-list'); list.replaceChildren();
  if (!radarRanked.length) {
    list.innerHTML = '<p class="hc-empty">没有论文 — 先保存兴趣分类/关键词再刷新</p>';
    return;
  }
  const needsKw = radarRanked.some((p) => p.needsKeywords) || !(radarInterests.keywords || []).length;
  if (needsKw) {
    const ban = el('div', 'radar-banner warn');
    ban.innerHTML = '<b>相关度偏「浏览分」</b>：还没设方向关键词时，分数主要来自分类与新旧。'
      + '请在兴趣里加<strong>任务/方法级</strong>词（如 multi-objective、Pareto、tool-use），比只选 cs.LG 有用得多。';
    list.appendChild(ban);
  }
  // 分层统计
  const must = radarRanked.filter((p) => p.tier === 'must');
  const skim = radarRanked.filter((p) => p.tier === 'skim');
  const stats = el('div', 'radar-stats');
  stats.innerHTML = `<span class="rs must">必读候选 ${must.length}</span>`
    + `<span class="rs skim">值得扫 ${skim.length}</span>`
    + `<span class="rs all">共 ${radarRanked.length}</span>`
    + `<button type="button" class="ghost-btn" id="radar-ask-triage">✧ Agent 今日分拣</button>`;
  list.appendChild(stats);
  stats.querySelector('#radar-ask-triage')?.addEventListener('click', () => {
    void send('请根据我的雷达兴趣做今日文献分拣（必读/可扫/可跳过），并说明与我方向的关联。', { skillId: 'frontier-digest' });
  });

  const tierLabel = { must: '必读', skim: '可扫', browse: '浏览' };
  for (const paper of radarRanked.slice(0, 30)) {
    const item = el('div', `radar-item tier-${paper.tier || 'browse'}`);
    const head = el('div', 'ri-head');
    const title = el('div', 'ri-title');
    if (paper.isNew) title.appendChild(el('span', 'ri-new', 'NEW'));
    title.appendChild(el('span', `ri-tier ${paper.tier || ''}`, tierLabel[paper.tier] || '浏览'));
    const link = document.createElement('a');
    link.href = paper.pdfUrl || `https://arxiv.org/abs/${paper.arxivId || ''}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = paper.title || '(无标题)';
    title.appendChild(link);
    const scoreBox = el('div', 'ri-score-box');
    const stars = '★'.repeat(paper.stars || 0) + '☆'.repeat(Math.max(0, 5 - (paper.stars || 0)));
    scoreBox.append(
      el('div', 'ri-score-num', String(paper.score ?? 0)),
      el('div', 'ri-stars', stars),
    );
    head.append(title, scoreBox);

    const why = (paper.reasons || []).length
      ? el('div', 'ri-why', `为何推荐：${paper.reasons.join(' · ')}`)
      : el('div', 'ri-why muted', paper.needsKeywords ? '未设关键词，仅按分类/新旧排序' : '弱相关');
    const meta = el('div', 'ri-meta',
      `${(paper.authors || []).slice(0, 3).join(', ')}${(paper.authors || []).length > 3 ? ' 等' : ''}`
      + ` · ${paper.published || ''}`
      + (paper.primaryCategory ? ` · ${paper.primaryCategory}` : '')
      + (paper.matchedKeywords?.length ? ` · 命中 ${paper.matchedKeywords.join('、')}` : ''));

    const summary = el('div', 'ri-summary collapsed', paper.summary || '');
    summary.title = '点击展开/收起摘要';
    summary.addEventListener('click', () => summary.classList.toggle('collapsed'));

    const actions = el('div', 'ri-actions');
    const openBtn = el('button', 'ghost-btn primary-ghost', '阅读器打开');
    openBtn.addEventListener('click', async () => {
      if (!paper.arxivId) { toast('无 arXiv id', true); return; }
      toast(`下载 ${paper.arxivId}…`);
      const r = await window.paperlens.openArxivPdf({ arxivId: paper.arxivId, title: paper.title });
      if (r?.ok) await openPdfData(r);
      else toast(r?.error || '下载失败', true);
    });
    const readBtn = el('button', 'ghost-btn', '+ 待读');
    readBtn.addEventListener('click', async () => {
      const r = await window.paperlens.addReadingItem({
        title: paper.title, arxivId: paper.arxivId, url: paper.pdfUrl,
        summary: String(paper.summary || '').slice(0, 200),
      });
      toast(r.added ? '已加入待读' : '已在清单中');
    });
    const askBtn = el('button', 'ghost-btn', '值不值得读？');
    askBtn.addEventListener('click', () => void send(
      [
        '请判断这篇论文对我是否值得精读（给 必读/扫摘要/可跳过 + 理由）。',
        `标题：${paper.title}`,
        `相关度 ${paper.score}；推荐理由：${(paper.reasons || []).join('；') || '无'}`,
        `摘要：${String(paper.summary || '').slice(0, 500)}`,
        currentPaper?.name ? `我正在读：${currentPaper.name} — 请对照关联点。` : '若有我的研究档案请结合。',
      ].join('\n'),
      { skillId: paperPages.length ? 'paper-compare' : 'frontier-digest' },
    ));
    const cmpBtn = el('button', 'ghost-btn', '对照当前文');
    cmpBtn.disabled = !paperPages.length;
    cmpBtn.title = paperPages.length ? '与正在阅读的论文对照' : '先打开一篇论文';
    cmpBtn.addEventListener('click', () => void send(
      `请对照【当前打开的论文】与下面这篇的方法/设定/结果：\n标题：${paper.title}\n摘要：${String(paper.summary || '').slice(0, 600)}`,
      { skillId: 'paper-compare' },
    ));
    const queueBtn = el('button', 'ghost-btn', '+ 对照队列');
    queueBtn.addEventListener('click', () => {
      const r = addToCompareQueue(compareQueue, paper);
      compareQueue = r.queue;
      renderCompareQueueBar();
      toast(r.added ? '已加入对照队列' : '已在队列中');
    });
    actions.append(openBtn, readBtn, askBtn, cmpBtn, queueBtn);
    item.append(head, why, meta, summary, actions);
    list.appendChild(item);
  }
  renderCompareQueueBar();
}

// 雷达 × 在读论文：对照队列
let compareQueue = [];
function renderCompareQueueBar() {
  const bar = $('compare-queue-bar');
  const chips = $('compare-queue-chips');
  const count = $('compare-queue-count');
  const run = $('compare-queue-run');
  if (!bar) return;
  compareQueue = normalizeCompareQueue(compareQueue);
  if (!compareQueue.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  count.textContent = String(compareQueue.length);
  run.disabled = !paperPages.length || !compareQueue.length;
  run.title = paperPages.length ? '批量对照当前打开的论文' : '先打开一篇论文';
  chips.replaceChildren();
  for (const item of compareQueue) {
    const chip = el('span', 'cq-chip');
    chip.appendChild(document.createTextNode(item.title.slice(0, 28) + (item.title.length > 28 ? '…' : '')));
    const x = el('button', null, '×');
    x.type = 'button';
    x.addEventListener('click', () => {
      compareQueue = removeFromCompareQueue(compareQueue, item.id);
      renderCompareQueueBar();
    });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
}
$('compare-queue-run')?.addEventListener('click', () => {
  if (!paperPages.length) { toast('先打开要对照的论文', true); return; }
  if (!compareQueue.length) return;
  const prompt = buildBatchComparePrompt(currentPaper?.name || '', compareQueue);
  void send(prompt, { skillId: 'paper-compare' });
});
$('compare-queue-clear')?.addEventListener('click', () => {
  compareQueue = [];
  renderCompareQueueBar();
});

// ---------------------------------------------------------------------------
// 投稿助手
// ---------------------------------------------------------------------------
let submitLoaded = false;
async function renderSubmit() {
  submitLoaded = true;
  // 预设
  const dl = $('venue-presets');
  const { presets, board, checklist } = await window.paperlens.getVenues();
  dl.replaceChildren();
  for (const p of presets) { const o = el('option', null, `${p.abbr} — ${p.name}`); o.value = p.abbr; dl.appendChild(o); }
  // 看板
  renderVenueBoard(board);
  // 检查清单
  const cl = $('submit-checklist'); cl.replaceChildren();
  for (const item of checklist) {
    const label = el('label', `check-item`);
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.addEventListener('change', () => label.classList.toggle('done', cb.checked));
    label.append(cb, el('div', null));
    label.lastChild.append(el('div', 'ck-label', item.label), el('div', 'ck-desc', item.desc));
    cl.appendChild(label);
  }
}
function renderVenueBoard(board) {
  const box = $('venue-board'); box.replaceChildren();
  if (!board.length) { box.appendChild(el('p', 'hc-empty', '还没有目标 — 上方添加一个会议')); return; }
  for (const venue of board) {
    const row = el('div', 'venue-row');
    const abbr = el('span', 'vr-abbr', venue.abbr);
    const name = el('span', 'vr-name', venue.name);
    const ddl = venue.countdown ? el('span', `vr-ddl ${venue.countdown.urgency}`, venue.countdown.label) : el('span', 'vr-ddl normal', '未设日期');
    const del = el('button', 'vr-del', '✕');
    del.addEventListener('click', async () => { await window.paperlens.removeVenue(venue.id); void renderSubmit(); });
    if (venue.url) { const a = el('a', 'vr-name'); a.href = venue.url; a.target = '_blank'; a.textContent = venue.name; row.append(abbr, a, ddl, del); }
    else row.append(abbr, name, ddl, del);
    box.appendChild(row);
  }
}
$('venue-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const abbr = $('venue-abbr').value.trim();
  if (!abbr) return;
  await window.paperlens.addVenue({ abbr, deadline: $('venue-deadline').value, url: $('venue-url').value.trim() });
  $('venue-abbr').value = ''; $('venue-deadline').value = ''; $('venue-url').value = '';
  void renderSubmit();
});
$('venue-ask-agent')?.addEventListener('click', () => void send('基于我当前打开的论文（或我的研究方向）和已设置的投稿目标，建议我投到哪里？请调用 list_submission_deadlines 查我的目标。', { skillId: 'venue-advisor' }));

// ---------------------------------------------------------------------------
// 知识库
// ---------------------------------------------------------------------------
let kbLoaded = false;
async function renderKbOverview() {
  kbLoaded = true;
  const box = $('kb-overview');
  const data = await window.paperlens.kbOverview();
  if (!data.configured) {
    box.innerHTML = '<p>尚未配置 Obsidian vault。点上方「选择 vault 文件夹」连接你的笔记库 — 笔记同步、知识库检索、Agent 读取都从这里来。</p>';
    return;
  }
  box.innerHTML = `<p>已连接 vault：<code>${data.folder}</code> · 共 <b>${data.totalNotes || 0}</b> 篇笔记</p><div class="kb-recent" id="kb-recent"></div>`;
  const recent = $('kb-recent');
  for (const r of data.recent || []) {
    const chip = el('button', 'kb-recent-chip', r.name);
    chip.addEventListener('click', () => { $('kb-search-input').value = r.name; void searchKb(r.name); });
    recent.appendChild(chip);
  }
}
$('kb-pick')?.addEventListener('click', async () => { const r = await window.paperlens.pickObsidianFolder(); if (r?.ok) { toast('已连接 vault'); void renderKbOverview(); } });
$('kb-search-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void searchKb(e.target.value); } });
$('kb-weave')?.addEventListener('click', () => {
  if (!paperPages.length) { toast('先打开一篇论文再串联', true); return; }
  void send('请把当前论文和我的知识库串联起来。', { skillId: 'kb-weave' });
});
async function searchKb(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const results = $('kb-results');
  results.replaceChildren();
  results.appendChild(el('p', 'hc-empty', '检索中…'));
  const data = await window.paperlens.kbSearch({ query: q, maxResults: 8 });
  if (!data.configured) { results.innerHTML = '<p class="hc-empty">请先配置 Obsidian vault</p>'; return; }
  results.replaceChildren();
  if (!data.hits.length) { results.appendChild(el('p', 'hc-empty', `知识库中未找到「${q}」`)); return; }
  for (const hit of data.hits) {
    const card = el('div', 'kb-hit');
    const name = el('div', null);
    name.append(el('span', 'kh-name', hit.name), el('span', 'kh-path', hit.relPath));
    card.appendChild(name);
    for (const snippet of hit.snippets || []) card.appendChild(el('div', 'kh-snippet', `…${snippet}…`));
    // Gen21: 每条命中直接可让 Agent 展开读
    const ask = el('button', 'followup-chip', '✧ 让 Agent 读这篇笔记'); ask.type = 'button';
    ask.addEventListener('click', () => {
      void send(`请 read_knowledge_note 读我的知识库笔记「${hit.relPath}」，总结要点，并说说它和${currentPaper ? '当前论文' : '我的研究方向'}的联系。`, {});
    });
    card.appendChild(ask);
    results.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// 术语表管理（知识库视图）
// ---------------------------------------------------------------------------
async function renderGlossaryList() {
  const box = $('glossary-list');
  if (!box) return;
  const data = await window.paperlens.listGlossary?.() || {};
  const list = Array.isArray(data.glossary) ? data.glossary : [];
  glossary = list;
  box.replaceChildren();
  if (!list.length) {
    box.appendChild(el('p', 'hc-empty', '还没有锁定术语。在阅读器划词翻译后点「锁定术语」，或在上方表单添加。'));
    return;
  }
  for (const item of list) {
    const row = el('div', 'glossary-row');
    row.append(
      el('span', 'gl-term', item.term),
      el('span', 'gl-arrow', '→'),
      el('span', 'gl-trans', item.translation),
    );
    const del = el('button', 'gl-del', '删除');
    del.type = 'button';
    del.title = `删除「${item.term}」`;
    del.addEventListener('click', async () => {
      await window.paperlens.removeTerm?.(item.term);
      await loadGlossary();
      void renderGlossaryList();
      toast(`已删除术语：${item.term}`);
    });
    row.appendChild(del);
    box.appendChild(row);
  }
}
$('glossary-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = $('glossary-term')?.value?.trim();
  const translation = $('glossary-translation')?.value?.trim();
  if (!term || !translation) return;
  await window.paperlens.lockTerm({ term, translation });
  $('glossary-term').value = '';
  $('glossary-translation').value = '';
  await loadGlossary();
  void renderGlossaryList();
  toast(`术语已保存：${term} → ${translation}`);
});

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
$('stats-price')?.addEventListener('input', (e) => { const price = Number(e.target.value) || 0; void renderCost(price); });
async function renderStats() {
  try {
    const stats = await window.paperlens.getStats();
    const cards = $('stats-cards');
    const weekTok = stats.week?.tokens || 0;
    const cardsData = [
      ['本周阅读', `${stats.week.readMinutes} 分`],
      ['本周翻译', `${stats.week.pagesTranslated} 页`],
      ['本周问 Agent', `${stats.week.agentAsks} 次`],
      ['本周 token', weekTok.toLocaleString()],
      ['活跃天', `${stats.week.activeDays} / 7`],
      ['本月阅读', `${stats.month.readMinutes} 分`],
      ['累计翻译', `${stats.total.pagesTranslated} 页`],
      ['累计打开', `${stats.total.papersOpened || 0} 篇`],
    ];
    cards.replaceChildren();
    for (const [label, val] of cardsData) {
      const c = el('div', 'stat-card');
      c.appendChild(el('b', null, val)); c.appendChild(el('span', null, label));
      cards.appendChild(c);
    }
    // 本周 vs 上周
    const cmp = $('stats-compare');
    if (cmp) {
      const w = stats.week || {};
      const prev = stats.prevWeek || stats.lastWeek || {};
      const rows = [
        ['阅读分钟', w.readMinutes, prev.readMinutes],
        ['翻译页', w.pagesTranslated, prev.pagesTranslated],
        ['Agent', w.agentAsks, prev.agentAsks],
        ['Token', w.tokens, prev.tokens],
      ];
      cmp.replaceChildren();
      for (const [label, cur, old] of rows) {
        const row = el('div', 'cmp-row');
        const delta = (Number(cur) || 0) - (Number(old) || 0);
        const sign = delta > 0 ? `+${delta}` : String(delta);
        row.append(
          el('span', 'cmp-label', label),
          el('span', 'cmp-cur', String(cur ?? 0)),
          el('span', `cmp-delta${delta > 0 ? ' up' : delta < 0 ? ' down' : ''}`, `上周 ${old ?? 0}（${sign}）`),
        );
        cmp.appendChild(row);
      }
    }
    // 热力图
    const hm = $('stats-heatmap'); hm?.replaceChildren();
    for (const col of stats.heatmap?.grid || []) {
      const colEl = el('div', 'hm-col');
      for (const cell of col) {
        const c = el('div', `hm-cell${cell ? ` l${cell.level}` : ' empty'}`);
        if (cell) c.title = `${cell.key} · ${cell.minutes} 分钟 · ${cell.pages || 0} 页`;
        colEl.appendChild(c);
      }
      hm?.appendChild(colEl);
    }
    const price = Number($('stats-price')?.value) || 0;
    void renderCost(price, stats.total.tokens, weekTok);
  } catch { /* noop */ }
}
function renderCost(price, tokens, weekTokens = 0) {
  const cost = price > 0 ? ((tokens ?? 0) / 1e6) * price : 0;
  const weekCost = price > 0 ? ((weekTokens ?? 0) / 1e6) * price : 0;
  const box = $('stats-cost');
  if (!box) return;
  if (price > 0) {
    box.innerHTML = `累计 <b>${(tokens ?? 0).toLocaleString()}</b> tokens ≈ <b>¥${cost.toFixed(2)}</b>`
      + `<br/>本周 <b>${(weekTokens ?? 0).toLocaleString()}</b> tokens ≈ <b>¥${weekCost.toFixed(2)}</b>`;
  } else {
    box.innerHTML = `累计约 ${(tokens ?? 0).toLocaleString()} tokens · 本周 ${(weekTokens ?? 0).toLocaleString()}（填单价估算花费）`;
  }
}

// ---------------------------------------------------------------------------
// 写作工坊
// ---------------------------------------------------------------------------
let writeDraftId = null;
let writeBaselineBody = ''; // 润色前快照，用于 diff

async function renderWriteView() {
  const list = $('write-draft-list');
  if (!list) return;
  const { drafts = [] } = await window.paperlens.listDrafts?.() || {};
  list.replaceChildren();
  if (!drafts.length) {
    list.appendChild(el('p', 'hc-empty', '还没有草稿'));
  }
  for (const d of drafts) {
    const row = el('button', `write-draft-item${d.id === writeDraftId ? ' active' : ''}`);
    row.type = 'button';
    row.appendChild(el('div', 'wd-title', d.title));
    row.appendChild(el('div', 'wd-meta', `${d.kind} · ${d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : ''}`));
    row.addEventListener('click', () => void loadWriteDraft(d.id));
    list.appendChild(row);
  }
  if (writeDraftId && !drafts.some((d) => d.id === writeDraftId)) {
    writeDraftId = null;
  }
  if (!writeDraftId && drafts[0]) void loadWriteDraft(drafts[0].id);
}

async function loadWriteDraft(id) {
  const { draft } = await window.paperlens.getDraft?.(id) || {};
  if (!draft) return;
  writeDraftId = draft.id;
  writeBaselineBody = draft.body || '';
  $('write-title').value = draft.title || '';
  $('write-kind').value = draft.kind || 'general';
  $('write-body').value = draft.body || '';
  $('write-diff').hidden = true;
  $('write-meta').textContent = draft.updatedAt
    ? `已保存 · ${new Date(draft.updatedAt).toLocaleString()}${draft.paperTitle ? ` · ${draft.paperTitle}` : ''}`
    : '未保存';
  void renderWriteView();
}

async function saveWriteDraft() {
  const title = $('write-title')?.value?.trim() || '未命名草稿';
  const body = $('write-body')?.value || '';
  const kind = $('write-kind')?.value || 'general';
  const result = await window.paperlens.saveDraft?.({
    id: writeDraftId || undefined,
    title,
    body,
    kind,
    paperPath: currentPaper?.path || '',
    paperTitle: currentPaper?.name || '',
  });
  if (result?.draft) {
    writeDraftId = result.draft.id;
    writeBaselineBody = result.draft.body || '';
    $('write-meta').textContent = `已保存 · ${new Date(result.draft.updatedAt || Date.now()).toLocaleString()}`;
    toast('草稿已保存');
    void renderWriteView();
  }
}

function newWriteDraft() {
  writeDraftId = null;
  writeBaselineBody = '';
  $('write-title').value = currentPaper?.name ? `${currentPaper.name.replace(/\.pdf$/i, '')} · 草稿` : '新草稿';
  $('write-kind').value = 'general';
  $('write-body').value = '';
  $('write-diff').hidden = true;
  $('write-meta').textContent = '尚未保存';
  void renderWriteView();
}

function showWriteDiff(before, after) {
  const box = $('write-diff');
  if (!box) return;
  const rows = lineDiff(before, after);
  box.replaceChildren();
  box.hidden = false;
  box.appendChild(el('div', 'diff-head', '与润色前对比（绿=新增，红=删除）'));
  for (const row of rows.slice(0, 200)) {
    box.appendChild(el('div', `diff-line diff-${row.type}`, row.text || ' '));
  }
}

$('write-new')?.addEventListener('click', () => newWriteDraft());
$('write-save')?.addEventListener('click', () => void saveWriteDraft());
$('write-gen-rw')?.addEventListener('click', async () => {
  switchView('write');
  const prompt = draftPromptForKind('related-work', {
    paperTitle: currentPaper?.name || '',
    body: $('write-body')?.value || '',
  });
  setChatOpen(true);
  await send(prompt, { skillId: 'overleaf' });
  // 用户可从 Agent 回答复制；同时预填标题
  if (!$('write-title').value) {
    $('write-title').value = currentPaper?.name
      ? `${currentPaper.name.replace(/\.pdf$/i, '')} · Related Work`
      : 'Related Work 草稿';
  }
  $('write-kind').value = 'related-work';
});
$('write-polish')?.addEventListener('click', async () => {
  const body = $('write-body')?.value || '';
  if (!body.trim()) { toast('先写点内容再润色', true); return; }
  writeBaselineBody = body;
  const prompt = draftPromptForKind('polish', { body });
  setChatOpen(true);
  const result = await send(prompt);
  const answer = String(result?.answer || '').trim();
  if (!answer || result?.error || result?.cancelled) return;
  // 答完直接给「一键应用」：显示 diff，用户确认后替换编辑器内容
  showWriteDiff(writeBaselineBody, answer);
  const diffBox = $('write-diff');
  const bar = el('div', 'diff-apply-bar');
  const apply = el('button', 'primary-btn', '✓ 应用润色结果'); apply.type = 'button';
  apply.addEventListener('click', () => {
    $('write-body').value = answer;
    bar.remove();
    toast('已应用润色（Ctrl+S 保存；diff 保留供对照）');
  });
  const dismiss = el('button', 'ghost-btn', '保留原稿'); dismiss.type = 'button';
  dismiss.addEventListener('click', () => { diffBox.hidden = true; });
  bar.append(apply, dismiss);
  diffBox.prepend(bar);
  switchView('write');
});

// 监听写作区粘贴后若有 baseline 则显示 diff（手动按钮更清晰）
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's' && $('view-write')?.classList.contains('active')) {
    e.preventDefault();
    void saveWriteDraft();
  }
});

// ---------------------------------------------------------------------------
// 右键菜单（阅读器双栏）
// ---------------------------------------------------------------------------
let ctxMenu = null;
function closeCtxMenu() { ctxMenu?.remove(); ctxMenu = null; }
function openCtxMenu(x, y, items) {
  closeCtxMenu();
  ctxMenu = el('div', 'ctx-menu');
  for (const item of items) {
    if (item === '-') { ctxMenu.appendChild(el('div', 'ctx-sep')); continue; }
    const btn = el('button', 'ctx-item', item.label); btn.type = 'button';
    btn.addEventListener('click', () => { closeCtxMenu(); item.run(); });
    ctxMenu.appendChild(btn);
  }
  document.body.appendChild(ctxMenu);
  // 防溢出定位
  const rect = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}
document.addEventListener('click', () => closeCtxMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
function recordFromEventTarget(target) {
  const pageEl = target?.closest?.('.pdf-page, .trans-page');
  if (!pageEl) return null;
  return paperPages[Number(pageEl.dataset.page) - 1] || null;
}
els.pdfPages.addEventListener('contextmenu', (event) => {
  const record = recordFromEventTarget(event.target);
  if (!record) return;
  event.preventDefault();
  const selected = String(window.getSelection?.()?.toString() || '').trim();
  openCtxMenu(event.clientX, event.clientY, [
    ...(selected ? [
      { label: '复制选中原文', run: () => { navigator.clipboard?.writeText(selected); toast('已复制原文'); } },
      { label: '问 AI 这段原文', run: () => { setChatOpen(true); els.input.value = `请解释这段原文：\n\n> ${selected.slice(0, 800)}\n\n`; autoGrow(); els.input.focus(); } },
      '-',
    ] : []),
    { label: `翻译第 ${record.num} 页`, run: () => void translatePaperPage(record, { force: Boolean(record.translated) }) },
    { label: '框选提问（S）', run: () => startSnip() },
    { label: '复制本页全部原文', run: () => { navigator.clipboard?.writeText(record.text || ''); toast(record.text ? '已复制本页原文' : '本页无文字层', !record.text); } },
  ]);
});
els.transPages.addEventListener('contextmenu', (event) => {
  const record = recordFromEventTarget(event.target);
  if (!record) return;
  event.preventDefault();
  const selected = String(window.getSelection?.()?.toString() || '').trim();
  openCtxMenu(event.clientX, event.clientY, [
    ...(selected ? [
      { label: '复制选中译文', run: () => { navigator.clipboard?.writeText(selected); toast('已复制'); } },
      { label: '✧ 问 AI 这段译文', run: () => { void send(`请解释译文里这段内容（出自第 ${record.num} 页，可 read_paper_page 对照原文）：\n\n> ${selected.slice(0, 800)}`, {}); } },
      '-',
    ] : []),
    { label: `重译第 ${record.num} 页`, run: () => void translatePaperPage(record, { force: true }) },
    { label: '复制本页译文', run: () => { navigator.clipboard?.writeText(record.translated || ''); toast(record.translated ? '已复制本页译文' : '本页还没译', !record.translated); } },
    { label: '存为笔记', run: async () => {
      const content = selected || record.translated;
      if (!content) { toast('本页还没有译文', true); return; }
      await window.paperlens.addNote({ content: content.slice(0, 4000), paperTitle: currentPaper?.name || '', page: record.num });
      toast('已存入笔记'); void refreshNotesCount();
    } },
    { label: '定位左栏原文', run: () => jumpToPage(record.num, 'pdf') },
  ]);
});

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
function currentPageNum() { return currentPageFromScroll(els.pdfPages, (r) => r.pdfEl); }
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  // Ctrl+K 技能面板（任何地方）
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); void openSkillPalette(); return;
  }
  // Ctrl+F 搜索译文
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    switchView('reader');
    $('search-bar').hidden = false; setTimeout(() => $('search-input').focus(), 60);
    return;
  }
  // Ctrl+O 打开 PDF
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault(); $('btn-open-pdf').click(); return;
  }
  if (typing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'a' || event.key === 'A') { event.preventDefault(); toggleChat(); return; }
  if (!paperPages.length) return;
  // Gen17: J/K 翻到未译页时若开了自动译则立即触发（原来要滚动才触发）
  if (event.key === 'j' || event.key === 'J') { const n = Math.min(paperPages.length, currentPageNum() + 1); jumpToPage(n, 'both'); maybeAutoTranslate(n); }
  else if (event.key === 'k' || event.key === 'K') { const n = Math.max(1, currentPageNum() - 1); jumpToPage(n, 'both'); maybeAutoTranslate(n); }
  else if (event.key === 't' || event.key === 'T') { const r = paperPages[currentPageNum() - 1]; if (r) void translatePaperPage(r, { force: Boolean(r.translated) }); }
  else if (event.key === 'o' || event.key === 'O') $('btn-outline').click();
  else if (event.key === 'i' || event.key === 'I') $('btn-page-rail')?.click();
  else if (event.key === 's' || event.key === 'S') { event.preventDefault(); startSnip(); }
  else if (event.key === '/') { event.preventDefault(); setChatOpen(true); els.input.focus(); }
  else if (event.key === '?') { $('help-dialog').showModal(); }
});
$('help-close')?.addEventListener('click', () => $('help-dialog').close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSelectionPopover();
    // Gen10: 停靠面板不被 Esc 误关——只有焦点在 Agent 输入框里按 Esc 才收起
    if (!$('chat-drawer').hidden && document.activeElement === els.input) setChatOpen(false);
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function init() {
  const config = await refreshModelBadge();
  const ws = await window.paperlens.getWorkspace();
  // 应用 UI 偏好
  if (ws.ui) {
    if (ws.ui.theme === 'dark') void applyTheme('dark');
    scrollLinkEnabled = ws.ui.scrollLink !== false;
    $('btn-scroll-link').classList.toggle('on', scrollLinkEnabled);
    autoTranslate = Boolean(ws.ui.autoTranslate);
    $('btn-auto-translate').classList.toggle('on', autoTranslate);
    if (ws.ui.bilingual) $('btn-bilingual').classList.add('on');
    // Gen5: 恢复 Agent 面板宽度
    const cw = Number(ws.ui.chatWidth) || 0;
    if (cw >= 300) document.documentElement.style.setProperty('--chat-w', `${Math.min(Math.round(window.innerWidth * 0.55), cw)}px`);
  }
  // 目标语言
  if (config.targetLang && $('cfg-targetlang')) $('cfg-targetlang').value = config.targetLang;
  void renderRecentList();
  void renderHome();
  void refreshNotesCount();
  void refreshTodoBadge();
  void loadGlossary();
  if (!config.baseUrl || !config.hasKey || !config.model) {
    // 首次使用：不强制弹设置，首页会提示
    setStatus('尚未配置模型 — 点右上角 ⚙ 设置 API');
  }
}
init();
