// 最终验证：欢迎页（快捷键提示）+ 划词浮层（带操作条）。
import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1200);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });
await win.waitForTimeout(300);
await win.screenshot({ path: 'shot-6-welcome2.png' });

// 打开 PDF 并模拟划词浮层（直接调 UI 函数路径:构造 DOM 展示）
const pdfBytes = readFileSync('../tests/fixtures/D4L-user-20p.pdf');
await win.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'demo.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('paper-pane').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
}, pdfBytes.toString('base64'));
await win.waitForTimeout(9000);
// 演示划词浮层
await win.evaluate(() => {
  const pop = document.createElement('div');
  pop.className = 'selection-popover';
  pop.style.left = '120px'; pop.style.top = '300px';
  pop.innerHTML = '<div class="sp-src">the mixture of experts (MoE) can be effectively…</div>'
    + '<div class="sp-dst">专家混合（MoE）可以被有效地用于多任务学习中的参数共享…</div>'
    + '<div class="sp-actions"><button class="sp-btn">问 AI</button><button class="sp-btn">锁定术语</button></div>';
  document.body.appendChild(pop);
});
await win.waitForTimeout(400);
const state = await win.evaluate(() => ({
  exportBtn: !document.getElementById('btn-export-md').hidden,
  translateAll: !document.getElementById('btn-translate-all').hidden,
  pages: document.querySelectorAll('.paper-page').length,
  skeletons: document.querySelectorAll('.paper-skeleton').length,
}));
console.log(JSON.stringify(state));
await win.screenshot({ path: 'shot-7-selection.png' });
await app.close();
