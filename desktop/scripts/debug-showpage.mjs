// 深入调试：手动逐步执行 app.js 同款跳页逻辑，找出滚动被谁吃掉
import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
win.on('console', (m) => console.log('[r]', m.text().slice(0, 200)));
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1200);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });
const pdfB64 = readFileSync('../tests/fixtures/D4L-user-20p.pdf').toString('base64');
await win.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'D4L-demo.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('pdf-pane').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, pdfB64);
await win.waitForTimeout(8000);

// A. 直接 scrollIntoView 第 5 页，250ms 后看是否保持
const a = await win.evaluate(async () => {
  const el5 = document.querySelector('.pdf-page[data-page="5"]');
  el5.scrollIntoView({ block: 'start' });
  const t0 = document.getElementById('pdf-pages').scrollTop;
  await new Promise((r) => setTimeout(r, 250));
  return { t0: Math.round(t0), t250: Math.round(document.getElementById('pdf-pages').scrollTop) };
});
console.log('A direct scrollIntoView:', JSON.stringify(a));

// B. 复位后发 IPC，60ms 内高频采样 scrollTop
await win.evaluate(() => { document.getElementById('pdf-pages').scrollTop = 0; });
await win.waitForTimeout(400);
await win.evaluate(() => {
  window.__samples = [];
  const pp = document.getElementById('pdf-pages');
  const iv = setInterval(() => window.__samples.push(Math.round(pp.scrollTop)), 30);
  setTimeout(() => clearInterval(iv), 1600);
});
await app.evaluate(({ BrowserWindow }) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ui:show-page', { page: 5 });
});
await win.waitForTimeout(1800);
const b = await win.evaluate(() => window.__samples.join(','));
console.log('B ipc samples:', b);
await app.close();
