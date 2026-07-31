// Write research notes into a user-picked Obsidian vault folder via the
// File System Access API. No Local REST API / MCP required — open Obsidian
// and the .md files appear under PaperLens/ (or configured subfolder).

import {
  OBSIDIAN_DEFAULT_FOLDER,
  buildPaperNoteMarkdown,
  buildPaperNotePath,
  buildThoughtAppendMarkdown,
  sanitizeObsidianPathSegment,
} from './obsidian-bridge.js';

const DB_NAME = 'paperlens-obsidian-fs-v1';
const DB_STORE = 'handles';
const VAULT_KEY = 'vaultRoot';
const META_KEY = 'vaultMeta';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开本地库索引失败'));
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => { try { db.close(); } catch { /* noop */ } };
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => {
      try { db.close(); } catch { /* noop */ }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => {
      try { db.close(); } catch { /* noop */ }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export function canUseVaultFolderPicker(win = globalThis) {
  return typeof win?.showDirectoryPicker === 'function';
}

/** User gesture required. Persist the vault root handle for later writes. */
export async function pickObsidianVaultFolder(win = globalThis) {
  if (!canUseVaultFolderPicker(win)) {
    return { ok: false, message: '当前浏览器不支持选择文件夹，请用最新 Chrome / Edge' };
  }
  try {
    const handle = await win.showDirectoryPicker({
      id: 'paperlens-obsidian-vault',
      mode: 'readwrite',
      startIn: 'documents',
    });
    await idbSet(VAULT_KEY, handle);
    await idbSet(META_KEY, { name: handle.name, pickedAt: Date.now() });
    return { ok: true, name: handle.name };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, cancelled: true, message: '已取消选择' };
    }
    return { ok: false, message: String(error?.message || error) };
  }
}

export async function getSavedVaultMeta() {
  try {
    const meta = await idbGet(META_KEY);
    if (!meta || typeof meta !== 'object') return null;
    return { name: String(meta.name || ''), pickedAt: Number(meta.pickedAt) || 0 };
  } catch {
    return null;
  }
}

export async function getSavedVaultHandle() {
  try {
    return (await idbGet(VAULT_KEY)) || null;
  } catch {
    return null;
  }
}

export async function clearSavedVaultFolder() {
  try {
    await idbDelete(VAULT_KEY);
    await idbDelete(META_KEY);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  }
}

async function ensurePermission(handle) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  if (typeof handle.queryPermission === 'function') {
    let state = await handle.queryPermission(opts);
    if (state === 'granted') return true;
    if (typeof handle.requestPermission === 'function') {
      state = await handle.requestPermission(opts);
      return state === 'granted';
    }
  }
  // Older / odd environments: try using the handle directly.
  return true;
}

async function getOrCreateNestedDir(root, parts) {
  let dir = root;
  for (const part of parts) {
    const name = sanitizeObsidianPathSegment(part, 'PaperLens');
    dir = await dir.getDirectoryHandle(name, { create: true });
  }
  return dir;
}

function splitFolder(folder) {
  return String(folder || OBSIDIAN_DEFAULT_FOLDER)
    .replace(/\\/gu, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Create or append a paper note under vault/<folder>/<title>.md
 */
export async function upsertPaperNoteToVaultFolder({
  folder = OBSIDIAN_DEFAULT_FOLDER,
  docTitle = '',
  notesMarkdown = '',
  thoughts = '',
  sourceUrl = '',
  appendOnly = false,
} = {}) {
  const handle = await getSavedVaultHandle();
  if (!handle) {
    return {
      ok: false,
      needPick: true,
      message: '尚未选择 Obsidian 库文件夹。请在设置中点「选择库文件夹」。',
    };
  }
  const permitted = await ensurePermission(handle);
  if (!permitted) {
    return {
      ok: false,
      needPick: true,
      message: '未获得文件夹写入权限，请重新选择 Obsidian 库文件夹。',
    };
  }

  const relPath = buildPaperNotePath({ folder, docTitle });
  const parts = relPath.split('/');
  const fileName = parts.pop();
  const dir = await getOrCreateNestedDir(handle, parts.length ? parts : splitFolder(folder));

  let existingText = '';
  let exists = false;
  try {
    const existing = await dir.getFileHandle(fileName);
    const file = await existing.getFile();
    existingText = await file.text();
    exists = true;
  } catch {
    exists = false;
  }

  let nextBody;
  let created = false;
  if (!exists) {
    nextBody = buildPaperNoteMarkdown({
      docTitle,
      sourceUrl,
      notesMarkdown,
      thoughts,
    });
    created = true;
  } else {
    const chunks = [];
    if (String(notesMarkdown || '').trim() && !appendOnly) {
      chunks.push(buildThoughtAppendMarkdown({
        title: '助手笔记同步',
        content: String(notesMarkdown).trim(),
      }));
    }
    if (String(thoughts || '').trim()) {
      chunks.push(buildThoughtAppendMarkdown({
        title: '我的思考',
        content: String(thoughts).trim(),
      }));
    }
    if (appendOnly && String(notesMarkdown || '').trim() && !String(thoughts || '').trim()) {
      chunks.push(buildThoughtAppendMarkdown({
        title: '助手摘录',
        content: String(notesMarkdown).trim(),
      }));
    }
    if (!chunks.length) {
      return { ok: true, path: relPath, skipped: true, message: '没有新内容可写入', method: 'folder' };
    }
    nextBody = `${String(existingText).replace(/\s*$/u, '')}\n${chunks.join('\n')}`;
  }

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(nextBody);
  await writable.close();

  const meta = await getSavedVaultMeta();
  return {
    ok: true,
    path: relPath,
    created,
    method: 'folder',
    vaultName: meta?.name || handle.name || '',
    bytes: nextBody.length,
  };
}

/** Fallback when folder API is unavailable: trigger a .md download. */
export function downloadMarkdownFile(fileName, content, doc = globalThis.document) {
  const name = sanitizeObsidianPathSegment(fileName, 'paper-note');
  const withExt = /\.md$/iu.test(name) ? name : `${name}.md`;
  const blob = new Blob([String(content ?? '')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = url;
    a.download = withExt;
    a.rel = 'noopener';
    doc.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true, path: withExt, method: 'download' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
