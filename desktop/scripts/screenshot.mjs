// 启动 Electron 应用并截图（欢迎页 + 演示对话两张）。
import { _electron as electron } from 'playwright-core';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 该环境变量会把 Electron 退化成纯 Node
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

await win.evaluate(() => { document.getElementById('settings')?.close?.(); });
await win.waitForTimeout(300);
await win.screenshot({ path: 'shot-1-welcome.png' });

// 演示对话（纯 UI 展示：Markdown/KaTeX/工具轨迹的真实渲染路径）
await win.evaluate(() => {
  document.getElementById('welcome')?.remove();
  const log = document.getElementById('log');
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const u = mk('div', 'msg user'); u.appendChild(mk('span', 'bubble', '你去找一下文献 [5] 这篇文章，看看他在讲什么'));
  log.appendChild(u);
  const a = mk('div', 'msg assistant');
  const tools = mk('div', 'tools');
  for (const t of ['✓ 检索论文全文', '✓ 查引用文献']) tools.appendChild(mk('span', 'tool-chip', t));
  const content = mk('div', 'content');
  const md = [
    '### 文献 [5]：DRL-MOA（原文核实）',
    '',
    '**Deep Reinforcement Learning for Multiobjective Optimization** — Kaiwen Li, Tao Zhang, Rui Wang，*IEEE Transactions on Cybernetics*, 2019，被引 **397** 次。',
    '',
    '核心思想（来源：Semantic Scholar 原文摘要，非本论文转述）：',
    '',
    '1. 将多目标优化分解为一组标量子问题，目标函数 $g(x \\mid \\lambda) = \\sum_i \\lambda_i f_i(x)$，用 DRL 逐个求解；',
    '2. 模型一次训练后可泛化到不同规模实例，**无需重新训练**；',
    '3. 在多目标 TSP 上求解速度与解质量均显著优于 NSGA-II / MOEA/D。',
    '',
    '> 本论文第 2 页将其归为「离散 PF 生成算法」的开创工作，与原文摘要一致。',
    '',
    '来源：[Semantic Scholar](https://www.semanticscholar.org)（开放获取 PDF 可下载）',
  ].join('\n');
  content.innerHTML = window.marked.parse(md);
  window.renderMathInElement?.(content, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
  a.append(tools, content);
  log.appendChild(a);
  document.getElementById('composer-hint').textContent = '本轮共 2 次工具调用';
});
await win.fill('#ask-input', '那它和本论文的方法相比，主要区别是什么？');
await win.waitForTimeout(400);
await win.screenshot({ path: 'shot-2-main.png' });
console.log('screenshots saved');
await app.close();
