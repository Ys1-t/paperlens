// PaperLens PWA 离线壳。策略：同源静态资源**网络优先、缓存兜底**——
// 保证每次在线打开都拿到最新版（旧版曾是缓存优先且 SW 从不更新，
// 导致已装设备永远停在首次安装的版本），离线时回退到最近一次成功缓存。
// 模型 API 调用是跨域 POST，不经过这里；译文缓存在 IndexedDB（cache.js）。
const SHELL_CACHE = 'paperlens-app-shell-v3';
const SHELL_ASSETS = [
  './index.html',
  './app.css',
  './app.js',
  './mobile-ux.js',
  './manifest.webmanifest',
  '../src/vendor/pdf.min.js',
  '../src/vendor/pdf.worker.min.js',
  '../src/vendor/marked.min.js',
  '../src/vendor/katex/katex.min.js',
  '../src/vendor/katex/katex.min.css',
  '../src/vendor/katex/auto-render.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('paperlens-app-shell-') && key !== SHELL_CACHE)
        .map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // API / 字体等跨域请求不接管
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(request).then((hit) => hit || Response.error())),
  );
});
