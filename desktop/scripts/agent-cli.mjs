#!/usr/bin/env node
// 桌面 agent 的命令行验证器：不装 Electron 也能先验证真工具循环 + 联网检索。
// 用法：
//   node scripts/agent-cli.mjs "Deep reinforcement learning for multiobjective optimization 这篇在讲什么"
// 配置（环境变量或 desktop/agent.config.json）：
//   PL_BASE_URL / PL_API_KEY / PL_MODEL（OpenAI 兼容端点；DeepSeek/GPT/中转站均可）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createToolRegistry, createOpenAiChat, runAgentTurn, agentSystemPrompt } from '../lib/agent-core.mjs';
import { createWebToolDefs } from '../lib/web-tool-defs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let fileConfig = {};
try { fileConfig = JSON.parse(readFileSync(join(here, '..', 'agent.config.json'), 'utf8')); } catch { /* 可选 */ }

const baseUrl = process.env.PL_BASE_URL || fileConfig.baseUrl;
const apiKey = process.env.PL_API_KEY || fileConfig.apiKey;
const model = process.env.PL_MODEL || fileConfig.model;
const question = process.argv.slice(2).join(' ').trim();

if (!baseUrl || !apiKey || !model || !question) {
  console.error('用法：PL_BASE_URL=… PL_API_KEY=… PL_MODEL=… node scripts/agent-cli.mjs "你的问题"');
  console.error('或在 desktop/agent.config.json 写 {"baseUrl":…,"apiKey":…,"model":…}');
  process.exit(1);
}

const registry = createToolRegistry(createWebToolDefs());
const chatFn = createOpenAiChat({ baseUrl, apiKey, model });

console.log(`[agent] model=${model} tools=${registry.list().map((t) => t.name).join(',')}`);
const { answer, trace, rounds } = await runAgentTurn({
  chatFn,
  registry,
  messages: [
    { role: 'system', content: agentSystemPrompt({}) },
    { role: 'user', content: question },
  ],
  onEvent: (type, data) => {
    if (type === 'tool-start') console.log(`[tool] → ${data.name} ${JSON.stringify(data.args).slice(0, 160)}`);
    if (type === 'tool-done') console.log(`[tool] ← ${data.name} ${data.ok ? 'ok' : 'ERROR'}`);
  },
});
console.log(`\n[trace] ${rounds} 轮 · ${trace.length} 次工具调用\n`);
console.log(answer);
