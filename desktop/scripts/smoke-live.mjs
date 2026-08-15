// 真实 key 端到端冒烟：停靠 Agent 面板 / 整页翻译 / Agent 提问（情境注入+Timeline+证据）/ show_page_to_user。
// 运行：cd desktop && node scripts/smoke-live.mjs（使用 userData 里已保存的模型配置）
import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });

const results = {};
const fail = (k, extra) => { results[k] = `FAIL${extra ? ` ${extra}` : ''}`; };
const pass = (k, extra) => { results[k] = `ok${extra ? ` ${extra}` : ''}`; };

// 1) 停靠面板：打开后 body.chat-open + main-col 让位，不遮挡
await win.click('#btn-chat');
await win.waitForTimeout(400);
{
  const s = await win.evaluate(() => ({
    open: document.body.classList.contains('chat-open'),
    margin: getComputedStyle(document.getElementById('main-col')).marginRight,
    drawerHidden: document.getElementById('chat-drawer').hidden,
    ctx: document.getElementById('composer-ctx')?.textContent || '',
    resize: Boolean(document.getElementById('chat-resize')),
  }));
  (s.open && !s.drawerHidden && parseInt(s.margin) >= 300 && s.resize)
    ? pass('dock-panel', `margin=${s.margin}`)
    : fail('dock-panel', JSON.stringify(s));
}

// 2) 打开 PDF（拖拽路径，多文件逻辑）
const pdfB64 = readFileSync('../tests/fixtures/D4L-user-20p.pdf').toString('base64');
await win.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'D4L-demo.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('pdf-pane').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, pdfB64);
await win.waitForTimeout(9000);
{
  const s = await win.evaluate(() => ({
    pages: document.querySelectorAll('.pdf-page').length,
    trans: document.querySelectorAll('.trans-page').length,
    askPageBtns: document.querySelectorAll('.ask-page-btn').length,
    tabs: document.querySelectorAll('.reader-tab').length,
    ctx: document.getElementById('composer-ctx')?.textContent || '',
  }));
  (s.pages === 20 && s.askPageBtns === 20 && s.tabs >= 1) ? pass('open-pdf', `pages=${s.pages} tabs=${s.tabs}`) : fail('open-pdf', JSON.stringify(s));
  results['composer-ctx'] = s.ctx.includes('D4L') || s.ctx.includes('第') ? `ok "${s.ctx}"` : `FAIL "${s.ctx}"`;
}
await win.screenshot({ path: 'shot-live-1-dock.png' });

// 3) 真实整页翻译（第 1 页；视觉模型，最长等 120s）
await win.click('.trans-page[data-page="1"] .trans-btn');
try {
  await win.waitForFunction(() => {
    const body = document.querySelector('.trans-page[data-page="1"] .trans-body');
    const t = body?.textContent || '';
    return !body?.classList.contains('streaming') && !body?.classList.contains('skeleton') && t.length > 60 && !t.startsWith('正在分析');
  }, null, { timeout: 120000, polling: 800 });
  const s = await win.evaluate(() => {
    const body = document.querySelector('.trans-page[data-page="1"] .trans-body');
    return { err: body.classList.contains('err'), len: (body.textContent || '').length, statusTranslated: document.getElementById('status-translated')?.textContent };
  });
  s.err ? fail('translate-page', `err body len=${s.len}`) : pass('translate-page', `len=${s.len} ${s.statusTranslated || ''}`);
} catch { fail('translate-page', 'timeout 120s'); }
await win.screenshot({ path: 'shot-live-2-translate.png' });

// 4) 真实 Agent 提问：应当触发工具取证（Timeline + 证据页码 + 追问条）
await win.evaluate(() => { document.getElementById('ask-input').value = '用两三句话概括这篇论文第 1 页讲了什么？'; });
await win.evaluate(() => { document.getElementById('ask-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); });
try {
  await win.waitForFunction(() => {
    const hint = document.getElementById('composer-hint')?.textContent || '';
    return hint.includes('完成');
  }, null, { timeout: 180000, polling: 1000 });
  const s = await win.evaluate(() => {
    const msgs = [...document.querySelectorAll('.msg.assistant')];
    const last = msgs[msgs.length - 1];
    return {
      answerLen: (last?.querySelector('.content')?.textContent || '').length,
      timelineSteps: last?.querySelectorAll('.tl-step').length || 0,
      toolChips: last?.querySelectorAll('.tool-chip').length || 0,
      followups: last?.parentElement ? document.querySelectorAll('.followup-chip').length : 0,
      evidence: document.querySelectorAll('.evidence-chip, .ev-page-link').length,
      hint: document.getElementById('composer-hint')?.textContent || '',
    };
  });
  (s.answerLen > 40) ? pass('agent-ask', `len=${s.answerLen} tools=${s.toolChips} tl=${s.timelineSteps} ev=${s.evidence} followups=${s.followups} [${s.hint}]`) : fail('agent-ask', JSON.stringify(s));
} catch { fail('agent-ask', 'timeout 180s'); }
await win.screenshot({ path: 'shot-live-3-agent.png' });

// 5) show_page_to_user IPC 通路（主进程直发事件 → 阅读器跳页）
await app.evaluate(({ BrowserWindow }) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ui:show-page', { page: 5 });
});
await win.waitForTimeout(1500);
{
  const s = await win.evaluate(() => ({
    status: document.getElementById('status-page')?.textContent || '',
    scrollTop: Math.round(document.getElementById('pdf-pages').scrollTop),
    hasHandler: typeof window.paperlens.onUiShowPage === 'function',
  }));
  s.status.includes('第 5') ? pass('show-page-ipc', JSON.stringify(s)) : fail('show-page-ipc', JSON.stringify(s));
}

// 6) 质量核对入口 / 高亮抽屉 DOM 存在性
{
  const s = await win.evaluate(() => ({
    hlBtn: Boolean(document.getElementById('btn-highlights')),
    hlDrawer: Boolean(document.getElementById('highlights-drawer')),
    statusPageClickable: document.getElementById('status-page')?.style.cursor === 'pointer',
  }));
  (s.hlBtn && s.hlDrawer && s.statusPageClickable) ? pass('gen-dom') : fail('gen-dom', JSON.stringify(s));
}

console.log(JSON.stringify(results, null, 2));
await app.close();
const failed = Object.values(results).filter((v) => String(v).startsWith('FAIL')).length;
process.exit(failed ? 1 : 0);
