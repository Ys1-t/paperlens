// src/lib/cache.js
// 基于 IndexedDB 的翻译缓存，避免重复请求 API（省钱、更快）。
// key = hashKey(protocol|model|targetLang|systemPrompt|text)，value = 译文字符串。

const DB_NAME = 'paperlens';
const STORE = 'translations';
const VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  const open = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  // 5s 超时：避免 IndexedDB open 卡死导致整条翻译链路永久挂起。
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('IndexedDB open 超时（5s）')), 5000);
  });
  dbPromise = Promise.race([open, timeout]).catch((e) => {
    dbPromise = null; // 允许后续重试
    throw e;
  });
  return dbPromise;
}

export async function cacheGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheCount() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** FNV-1a 32 位哈希（可指定初始桶），返回无符号 32 位整数。 */
function fnv1a32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** FNV-1a 32 位哈希，返回 base36 字符串。稳定、快速、无需异步 crypto。 */
export function hashKey(str) {
  return fnv1a32(str).toString(36);
}

/**
 * 64 位组合键：两路独立初始桶的 FNV-1a 拼接。
 * 32 位键在几千条缓存时生日碰撞概率已达百分位级，碰撞后果是「静默复用另一段
 * 文本的译文」。组合键把碰撞概率压到工程上可忽略的量级；旧 32 位键的存量
 * 缓存由 service worker 读取时做一次性迁移（见 cacheKeyFor 调用处）。
 */
export function hashKeyStrong(str) {
  return `${fnv1a32(str).toString(36)}.${fnv1a32(str, 0x9747b28c).toString(36)}`;
}
