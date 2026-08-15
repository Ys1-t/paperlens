// 工作台验证：书房首页（最近阅读卡片）+ 笔记抽屉。
import { _electron as electron } from 'playwright-core';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1000);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });

// 种入演示数据：两条最近阅读 + 一条笔记
await win.evaluate(async () => {
  await window.paperlens.touchRecent({
    path: 'D:/papers/MTPSL.pdf',
    title: 'Multi-Task Pareto Set Learning: A Decomposition-for-Learning Paradigm.pdf',
    totalPages: 20, lastPage: 7, translatedCount: 12,
  });
  await window.paperlens.touchRecent({
    path: 'D:/papers/DRL-MOA.pdf',
    title: 'Deep Reinforcement Learning for Multiobjective Optimization.pdf',
    totalPages: 14, lastPage: 3, translatedCount: 3,
  });
  await window.paperlens.addNote({
    title: '文献 [5] 在讲什么',
    content: 'DRL-MOA (IEEE T-CYB 2019, 被引 397)：将多目标优化分解为标量子问题，用 DRL 逐个求解；一次训练可泛化到不同规模实例。',
    paperTitle: 'MTPSL.pdf', source: 'ai',
  });
});
await win.reload();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1200);
await win.evaluate(() => { document.getElementById('settings')?.close?.(); });
await win.waitForTimeout(400);
await win.screenshot({ path: 'shot-4-workspace.png' });

await win.click('#btn-notes');
await win.waitForTimeout(500);
await win.screenshot({ path: 'shot-5-notes.png' });
const state = await win.evaluate(() => ({
  recentCards: document.querySelectorAll('.recent-card').length,
  notes: document.querySelectorAll('.note-item').length,
  notesCount: document.getElementById('notes-count').textContent,
}));
console.log(JSON.stringify(state));
await app.close();
