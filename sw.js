const CACHE = 'smartnote-offline-shell-v32';
const ASSETS = [
  './index.html',
  './index-en.html',
  './index-ar.html',
  './app.en.js',
  './styles.css',
  './app.js',
  './app.ar.js',
  './theme.js',
  './language.js',
  './manifest.json',
  './lucide.min.js',
  './icons/smartnote-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map(async asset => {
      try { await cache.add(asset); } catch (error) { console.warn('Offline asset cache failed:', asset, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('smartnote-offline-shell-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      fetch(request).then(async response => {
        if (response && response.ok) (await caches.open(CACHE)).put(request, response.clone());
      }).catch(() => {});
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response && response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch {
      return Response.error();
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const taskId = data.taskId;
  const assignmentId = data.assignmentId;
  const alertKey = data.key;
  if (!taskId && !assignmentId) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (assignmentId) client.postMessage({ type: 'OPEN_ASSIGNED_NOTIFICATION', assignmentId, notificationId: data.notificationId });
      else client.postMessage({ type: 'OPEN_TASK_NOTIFICATION', taskId, key: alertKey });
      if ('focus' in client) return client.focus();
    }
    const target = taskId ? `./?openTask=${encodeURIComponent(taskId)}` : './';
    return self.clients.openWindow(target);
  })());
});
