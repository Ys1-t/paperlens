// 领域知识库：把 Obsidian vault（任意 .md 文件夹）变成 Agent 可检索的本地知识库。
// 纯函数负责扫描结果的过滤/打分/摘录；fs 遍历由调用方（主进程）注入或用内置实现。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, relative } from 'node:path';

export const KB_MAX_FILES = 4000;
export const KB_MAX_FILE_BYTES = 512 * 1024;
export const KB_SNIPPET_RADIUS = 160;

/** 递归列出 vault 里的 .md 文件（跳过 .obsidian / .git / node_modules / .trash）。 */
export function listVaultFiles(folder, { maxFiles = KB_MAX_FILES } = {}) {
  const out = [];
  const skip = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.smart-env']);
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (extname(entry.name).toLowerCase() === '.md') {
        out.push(full);
      }
    }
  };
  walk(folder);
  return out;
}

/** 读一个笔记文件（限长），返回 { path, name, text, mtime } 或 null。 */
export function readVaultNote(filePath) {
  try {
    const stat = statSync(filePath);
    if (stat.size > KB_MAX_FILE_BYTES) {
      const text = readFileSync(filePath, 'utf8').slice(0, KB_MAX_FILE_BYTES);
      return { path: filePath, name: basename(filePath, '.md'), text, mtime: stat.mtimeMs, truncated: true };
    }
    return {
      path: filePath,
      name: basename(filePath, '.md'),
      text: readFileSync(filePath, 'utf8'),
      mtime: stat.mtimeMs,
      truncated: false,
    };
  } catch {
    return null;
  }
}

/** 大小写不敏感多词检索一段文本，返回命中片段列表（纯函数）。 */
export function snippetsInText(text, query, { radius = KB_SNIPPET_RADIUS, maxSnippets = 3 } = {}) {
  const hay = String(text || '');
  const lower = hay.toLowerCase();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const snippets = [];
  const used = [];
  for (const term of terms) {
    let from = 0;
    while (snippets.length < maxSnippets) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      from = at + term.length;
      // 跳过与已有片段重叠的位置
      if (used.some(([a, b]) => at >= a && at <= b)) continue;
      const start = Math.max(0, at - radius);
      const end = Math.min(hay.length, at + term.length + radius);
      used.push([start, end]);
      snippets.push(hay.slice(start, end).replace(/\s+/g, ' ').trim());
    }
  }
  return snippets;
}

/** 文件级打分：文件名命中 5 分/词，正文命中 1 分/次（封顶 10）。 */
export function scoreVaultFile(note, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length || !note) return 0;
  const name = String(note.name || '').toLowerCase();
  const text = String(note.text || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 5;
    let from = 0;
    let hits = 0;
    while (hits < 10) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      hits += 1;
      from = at + term.length;
    }
    score += hits;
  }
  return score;
}

/**
 * vault 全文检索：返回 [{ path, name, relPath, score, snippets, mtime }]。
 * 同步 IO —— vault 一般几百个 md，冷检一次 <100ms；调用方在主进程 handler 里跑。
 */
export function searchVault(folder, query, { maxResults = 8 } = {}) {
  const files = listVaultFiles(folder);
  const scored = [];
  for (const file of files) {
    const note = readVaultNote(file);
    if (!note) continue;
    const score = scoreVaultFile(note, query);
    if (score <= 0) continue;
    scored.push({
      path: note.path,
      relPath: relative(folder, note.path),
      name: note.name,
      score,
      mtime: note.mtime,
      snippets: snippetsInText(note.text, query),
    });
  }
  scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return scored.slice(0, Math.min(20, Math.max(1, maxResults)));
}

/** vault 概览：文件数 + 最近修改的 N 篇（Agent 起步用）。 */
export function vaultOverview(folder, { recentCount = 10 } = {}) {
  const files = listVaultFiles(folder);
  const withTime = files.map((file) => {
    try { return { path: file, name: basename(file, '.md'), mtime: statSync(file).mtimeMs }; }
    catch { return null; }
  }).filter(Boolean);
  withTime.sort((a, b) => b.mtime - a.mtime);
  return {
    totalNotes: withTime.length,
    recent: withTime.slice(0, recentCount).map(({ name, path }) => ({ name, relPath: relative(folder, path) })),
  };
}
