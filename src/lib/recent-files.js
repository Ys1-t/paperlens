// 最近本地文件句柄库：docKey → FileSystemFileHandle 存 IndexedDB，
// 让「最近阅读」里的本地论文可以一键重开（至多一次权限确认），
// 不必每次去文件管理器重新选择。与 phone-drop / obsidian-vault-fs 同模式。

const DB_NAME = 'paperlens-recent-files-v1';
const DB_STORE = 'handles';
const MAX_HANDLES = 30;
const INDEX_KEY = '__order__'; // 最近使用的 docKey 列表（新在后），用于容量淘汰

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
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSetMany(entries) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    for (const [key, value] of entries) {
      if (value === null) store.delete(key);
      else store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存/更新 docKey 的文件句柄；超容量时淘汰最旧的句柄。失败静默（增强功能）。 */
export async function saveRecentFileHandle(docKey, handle) {
  const key = String(docKey || '').trim();
  if (!key || key === 'unknown' || !handle) return;
  try {
    const order = ((await dbGet(INDEX_KEY)) || []).filter((it) => it !== key);
    order.push(key);
    const evicted = order.length > MAX_HANDLES ? order.splice(0, order.length - MAX_HANDLES) : [];
    await dbSetMany([
      [key, handle],
      [INDEX_KEY, order],
      ...evicted.map((old) => [old, null]),
    ]);
  } catch { /* 句柄库是加速器，不阻塞打开流程 */ }
}

/** 取 docKey 的句柄；没有返回 null。 */
export async function getRecentFileHandle(docKey) {
  const key = String(docKey || '').trim();
  if (!key) return null;
  try {
    const handle = await dbGet(key);
    return handle && typeof handle.getFile === 'function' ? handle : null;
  } catch {
    return null;
  }
}

/** 查询句柄读权限：'granted' | 'prompt' | 'denied'（异常按 denied 处理）。 */
export async function queryHandlePermission(handle) {
  try { return await handle.queryPermission({ mode: 'read' }); } catch { return 'denied'; }
}

/** 在用户手势内请求读权限。 */
export async function requestHandlePermission(handle) {
  try { return await handle.requestPermission({ mode: 'read' }); } catch { return 'denied'; }
}
