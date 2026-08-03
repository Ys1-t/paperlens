// PaperLens Desktop 渲染进程：左论文右对话。
// - PDF.js 渲染论文页；各页文本抽给主进程 → agent 的论文工具（read_paper_page 等）。
// - 每页「译此页」：主进程用扩展同款 translator 视觉翻译，流式回传增量。
// - 回答与译文统一走共享渲染管线（公式保护 + 算法块提升 + KaTeX）。
/* global window, document, pdfjsLib, marked, renderMathInElement */
import { renderMarkdownWithMath } from '../../src/lib/markdown-math.js';

const els = {
  log: document.getElementById('log'),
  welcome: document.getElementById('welcome'),
  form: document.getElementById('ask-form'),
  input: document.getElementById('ask-input'),
  askBtn: document.getElementById('ask-btn'),
  hint: document.getElementById('composer-hint'),
  settings: document.getElementById('settings'),
  modelBadge: document.getElementById('model-badge'),
  paperPane: document.getElementById('paper-pane'),
  paperTitle: document.getElementById('paper-title'),
  paperEmpty: document.getElementById('paper-empty'),
  paperPages: document.getElementById('paper-pages'),
  pdfInput: document.getElementById('pdf-input'),
  divider: document.getElementById('pane-divider'),
};

const TOOL_LABELS = {
  search_arxiv: 'arXiv 检索',
  lookup_citation: '查引用文献',
  fetch_url: '抓取网页',
  read_paper_page: '读论文页',
  search_paper_text: '检索论文全文',
  get_paper_overview: '论文概览',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Markdown + KaTeX（共享管线：公式占位保护 → marked → 算法块提升 → KaTeX）
// ---------------------------------------------------------------------------
function renderMarkdownInto(node, text) {
  renderMarkdownWithMath(node, text, {
    parse: (s) => (typeof marked?.parse === 'function' ? marked.parse(s) : ''),
    autoRender: typeof renderMathInElement === 'function' ? renderMathInElement : null,
  });
}

// ---------------------------------------------------------------------------
// 对话渲染
// ---------------------------------------------------------------------------
function hideWelcome() { els.welcome?.remove(); els.welcome = null; }

function addUserMessage(text) {
  hideWelcome();
  const wrap = el('div', 'msg user');
  wrap.appendChild(el('span', 'bubble', text));
  els.log.appendChild(wrap);
  els.log.scrollTop = els.log.scrollHeight;
}

let active = null;
function beginAssistantMessage() {
  const wrap = el('div', 'msg assistant');
  const tools = el('div', 'tools');
  tools.hidden = true;
  const content = el('div', 'content');
  const thinking = el('span', 'thinking-dot');
  thinking.append(el('i'), el('i'), el('i'));
  content.appendChild(thinking);
  wrap.append(tools, content);
  els.log.appendChild(wrap);
  active = { tools, content, streamed: '' };
  els.log.scrollTop = els.log.scrollHeight;
}

window.paperlens.onChatEvent((data) => {
  if (!active) return;
  const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120;
  if (data.type === 'delta') {
    active.streamed += data.delta || '';
    renderMarkdownInto(active.content, active.streamed);
  } else if (data.type === 'tool-start') {
    active.tools.hidden = false;
    const chip = el('span', 'tool-chip');
    chip.dataset.name = data.name;
    chip.append(el('span', 'spin'), document.createTextNode(TOOL_LABELS[data.name] || data.name));
    active.tools.appendChild(chip);
    active.streamed = '';
    active.content.replaceChildren((() => {
      const t = el('span', 'thinking-dot');
      t.append(el('i'), el('i'), el('i'));
      return t;
    })());
  } else if (data.type === 'tool-done') {
    const chips = active.tools.querySelectorAll(`[data-name="${CSS.escape(data.name)}"]`);
    const chip = chips[chips.length - 1];
    if (chip) {
      chip.replaceChildren(document.createTextNode(`${data.ok ? '✓ ' : '✕ '}${TOOL_LABELS[data.name] || data.name}`));
      if (!data.ok) chip.classList.add('err');
    }
  }
  if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
});

async function send(question) {
  const q = String(question || '').trim();
  if (!q || els.askBtn.disabled) return;
  els.input.value = '';
  autoGrow();
  els.askBtn.disabled = true;
  els.hint.textContent = '';
  addUserMessage(q);
  beginAssistantMessage();
  const result = await window.paperlens.ask(q);
  if (result?.error) {
    active.content.textContent = `⚠ ${result.error}`;
  } else {
    renderMarkdownInto(active.content, result?.answer || '（空回答）');
    if (result?.trace?.length) {
      els.hint.textContent = `本轮共 ${result.trace.length} 次工具调用`;
    }
  }
  active = null;
  els.askBtn.disabled = false;
  els.input.focus();
  els.log.scrollTop = els.log.scrollHeight;
}

els.form.addEventListener('submit', (event) => { event.preventDefault(); void send(els.input.value); });
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(els.input.value); }
});
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(160, els.input.scrollHeight)}px`;
}
els.input.addEventListener('input', autoGrow);

document.getElementById('starters')?.addEventListener('click', (event) => {
  const q = event.target.closest('[data-q]')?.dataset?.q;
  if (q) void send(q);
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  await window.paperlens.resetChat();
  els.log.replaceChildren();
  els.hint.textContent = '已开始新会话';
  els.input.focus();
});

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
async function refreshModelBadge() {
  const config = await window.paperlens.getConfig();
  els.modelBadge.textContent = config.model || '未配置';
  return config;
}
document.getElementById('btn-settings').addEventListener('click', async () => {
  const config = await window.paperlens.getConfig();
  document.getElementById('cfg-baseurl').value = config.baseUrl || '';
  document.getElementById('cfg-model').value = config.model || '';
  const key = document.getElementById('cfg-apikey');
  key.value = '';
  key.placeholder = config.hasKey ? '已保存（留空保持不变）' : 'sk-…';
  els.settings.showModal();
});
document.getElementById('cfg-cancel').addEventListener('click', () => els.settings.close());
document.getElementById('cfg-save').addEventListener('click', async () => {
  const apiKey = document.getElementById('cfg-apikey').value.trim();
  await window.paperlens.setConfig({
    baseUrl: document.getElementById('cfg-baseurl').value.trim(),
    model: document.getElementById('cfg-model').value.trim(),
    ...(apiKey ? { apiKey } : {}),
  });
  els.settings.close();
  await refreshModelBadge();
});

// ---------------------------------------------------------------------------
// PDF 论文：渲染 + 文本抽取 → 注入主进程 agent
// ---------------------------------------------------------------------------
let pdfDoc = null;
const paperPages = []; // {num, holder, canvas, transBtn, transEl, text, translated}

async function openPdf(file) {
  if (!window.pdfjsLib) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = '../../src/vendor/pdf.worker.min.js';
  const data = await file.arrayBuffer();
  try { pdfDoc?.destroy?.(); } catch { /* noop */ }
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  els.paperTitle.textContent = file.name;
  els.paperEmpty.hidden = true;
  els.paperPages.hidden = false;
  els.paperPages.replaceChildren();
  paperPages.length = 0;

  const pageTexts = [];
  for (let num = 1; num <= pdfDoc.numPages; num += 1) {
    const holder = el('div', 'paper-page');
    const canvas = document.createElement('canvas');
    const actions = el('div', 'page-actions');
    const transBtn = el('button', 'trans-btn', '译此页');
    transBtn.type = 'button';
    actions.appendChild(transBtn);
    const transEl = el('div', 'paper-trans');
    transEl.hidden = true;
    holder.append(canvas, el('div', 'pnum', `${num} / ${pdfDoc.numPages}`), actions, transEl);
    els.paperPages.appendChild(holder);
    const page = await pdfDoc.getPage(num);
    const scale = (els.paperPages.clientWidth - 28) / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = (tc.items || []).map((it) => String(it.str || '')).join(' ').replace(/\s+/g, ' ').trim();
    } catch { /* 扫描页 */ }
    pageTexts.push(text);
    const record = { num, holder, canvas, transBtn, transEl, text, translated: '' };
    transBtn.addEventListener('click', () => void translatePaperPage(record));
    paperPages.push(record);
  }
  await window.paperlens.setPaper({ title: file.name, pages: pageTexts });
  els.hint.textContent = `已载入《${file.name}》（${pdfDoc.numPages} 页）— 每页可「译此页」，也可以问「本论文」的问题`;
}

// 整页视觉翻译（扩展同款管线；流式增量渲染进 transEl）。
window.paperlens.onTranslateDelta(({ page, delta }) => {
  const record = paperPages[page - 1];
  if (!record || !record.translating) return;
  record.streamRaw += String(delta || '');
  renderMarkdownInto(record.transEl, record.streamRaw);
});

async function translatePaperPage(record) {
  if (record.translating) return;
  if (record.translated) { // 再点一次 = 收起/展开
    record.transEl.hidden = !record.transEl.hidden;
    record.transBtn.textContent = record.transEl.hidden ? '译此页' : '收起译文';
    return;
  }
  record.translating = true;
  record.streamRaw = '';
  record.transBtn.disabled = true;
  record.transBtn.textContent = '翻译中…';
  record.transEl.hidden = false;
  record.transEl.classList.add('streaming');
  record.transEl.textContent = '模型思考中…';
  // 页位图（1500px 与扩展常规页一致）
  const page = await pdfDoc.getPage(record.num);
  const scale = 1500 / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const image = canvas.toDataURL('image/jpeg', 0.9);
  canvas.width = 0; canvas.height = 0;

  const result = await window.paperlens.translatePage({
    page: record.num, image, sourceText: record.text,
  });
  record.translating = false;
  record.transEl.classList.remove('streaming');
  record.transBtn.disabled = false;
  if (result?.error) {
    record.transEl.classList.add('err');
    record.transEl.textContent = `⚠ ${result.error}`;
    record.transBtn.textContent = '重试翻译';
    return;
  }
  record.translated = result.markdown || '';
  renderMarkdownInto(record.transEl, record.translated);
  record.transEl.classList.remove('err');
  record.transBtn.textContent = '收起译文';
}

els.pdfInput.addEventListener('change', () => {
  const file = els.pdfInput.files?.[0];
  if (file) void openPdf(file);
  els.pdfInput.value = '';
});
els.paperPane.addEventListener('dragover', (e) => e.preventDefault());
els.paperPane.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.pdf$/i.test(file.name)) void openPdf(file);
});

// 分栏拖拽
let dragging = false;
els.divider.addEventListener('pointerdown', (e) => { dragging = true; els.divider.setPointerCapture(e.pointerId); });
els.divider.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const pct = Math.min(62, Math.max(22, (e.clientX / window.innerWidth) * 100));
  els.paperPane.style.width = `${pct}%`;
});
els.divider.addEventListener('pointerup', () => { dragging = false; });

// 启动
refreshModelBadge().then((config) => {
  if (!config.baseUrl || !config.hasKey || !config.model) {
    document.getElementById('btn-settings').click();
  }
});
