// 一键传手机：把论文包直写用户选定的「云同步文件夹」（iCloud Drive / OneDrive /
// 坚果云等）。桌面写入 → 云盘自动同步 → 手机“文件”App / PaperLens 打开。
// 无服务器、无账号，文件不出用户自己的云盘。
// 目录句柄经 IndexedDB 持久化（与 obsidian-vault-fs 相同模式）：首次选择文件夹，
// 之后每次导出一键直写；浏览器重启后在用户点击手势内重新请求写权限。

const DB_NAME = 'paperlens-phone-drop-v1';
const DB_STORE = 'handles';
const FOLDER_KEY = 'phoneDropFolder';

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
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 浏览器是否支持文件夹直写（Chrome / Edge；Firefox 不支持则回退手动下载）。 */
export function phoneDropSupported() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** 菜单提示文案：未配置 → 引导；已配置 → 显示目标文件夹。纯函数便于测试。 */
export function phoneDropHint(folderName) {
  const name = String(folderName || '').trim();
  return name
    ? `写入「${name}」，云盘同步后手机“文件”App 即收到`
    : '首次使用会让你选择 iCloud Drive / OneDrive 等同步文件夹';
}

/** 已保存的目标文件夹名；未配置返回 ''。 */
export async function getPhoneDropFolderName() {
  try {
    const handle = await dbGet(FOLDER_KEY);
    return handle?.name || '';
  } catch {
    return '';
  }
}

/** 让用户选择（或更换）同步文件夹；用户取消抛 AbortError。 */
export async function pickPhoneDropFolder() {
  const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
  await dbSet(FOLDER_KEY, handle);
  return handle.name;
}

async function ensureWritePermission(handle) {
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 把论文包文本写入同步文件夹。未配置 / 权限被拒时抛 { needsSetup: true } 错误，
 * 调用方据此触发重新选择文件夹。
 */
export async function writePaperPackToPhoneFolder(filename, text) {
  const handle = await dbGet(FOLDER_KEY);
  if (!handle) {
    throw Object.assign(new Error('尚未选择手机同步文件夹'), { needsSetup: true });
  }
  if (!(await ensureWritePermission(handle))) {
    throw Object.assign(new Error('未获得同步文件夹的写入权限'), { needsSetup: true });
  }
  const safeName = String(filename || 'paper.paperlens.json');
  const fileHandle = await handle.getFileHandle(safeName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
  return { folder: handle.name, filename: safeName };
}
