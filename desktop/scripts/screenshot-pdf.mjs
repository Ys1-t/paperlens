// 验证桌面端 PDF 流：打开测试论文 → 空状态消失、页渲染、「译此页」按钮就位。
import { _electron as electron } from 'playwright-core';
import { readFileSync } from 'node:fs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1200);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });

// 注入 PDF 文件（走与拖拽相同的 openPdf 路径）
const pdfBytes = readFileSync('../tests/fixtures/D4L-user-20p.pdf');
await win.evaluate(async (bytesBase64) => {
  const bytes = Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0));
  const file = new File([bytes], 'demo-paper.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('paper-pane').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt, bubbles: true }),
  );
}, pdfBytes.toString('base64'));
await win.waitForTimeout(9000); // 20 页渲染
const state = await win.evaluate(() => ({
  emptyHidden: document.getElementById('paper-empty').hidden,
  emptyVisible: !!document.getElementById('paper-empty').offsetParent,
  pages: document.querySelectorAll('.paper-page').length,
  transBtns: document.querySelectorAll('.trans-btn').length,
  title: document.getElementById('paper-title').textContent,
}));
console.log(JSON.stringify(state));
await win.screenshot({ path: 'shot-3-pdf.png' });
await app.close();
