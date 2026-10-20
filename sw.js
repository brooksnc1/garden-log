// Bump VERSION (and APP_VERSION in js/app.js) on every release so phones
// download the new files. Data is never stored here; it lives in IndexedDB.
const VERSION = '1.2.0';
const SHELL = `shell-${VERSION}`;
const FONTS = 'fonts';
importScripts('./js/crops-data.js', './js/frost.js');

const FILES = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/db.js', './js/model.js', './js/crops.js', './js/crops-data.js', './js/frost.js', './js/weather.js', './js/photos.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser's HTTP cache, so a new version never
  // gets packaged with stale copies of the old files.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== FONTS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('open-meteo.com')) return; // always live; the app caches weather itself
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((r) => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
  }
});

// ---------------------------------------------------------------------------
// Background frost check. Chrome on Android runs this for an installed app,
// roughly as often as it decides (usually around once a day), only while the
// phone has a connection. It reads the garden from IndexedDB, fetches the
// overnight lows, and notifies about frost not already announced.

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'frost-check') e.waitUntil(frostCheck());
});

self.addEventListener('message', (e) => {
  if (e.data === 'frost-check') e.waitUntil(frostCheck());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { w.navigate('./#today').catch(() => {}); return w.focus(); } }
    return self.clients.openWindow('./#today');
  })());
});

function idbOpen() {
  return new Promise((resolve) => {
    const req = indexedDB.open('garden-tracker');
    // Never create the database from here: if it doesn't exist yet, cancel.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
function idbAll(db, store) {
  return new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function idbGetMeta(db, key) {
  return new Promise((res, rej) => { const r = db.transaction('meta').objectStore('meta').get(key); r.onsuccess = () => res(r.result ? r.result.value : null); r.onerror = () => rej(r.error); });
}
function idbSetMeta(db, key, value) {
  return new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

async function frostCheck() {
  const db = await idbOpen();
  if (!db) return;
  try {
    const settings = (await idbGetMeta(db, 'settings')) || {};
    const setting = settings.frostNotify || 'off';
    if (setting === 'off' || settings.lat == null) return;
    if (self.Notification && Notification.permission !== 'granted') return;
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${settings.lat}&longitude=${settings.lon}`
      + '&daily=temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=3';
    const res = await fetch(url);
    if (!res.ok) return;
    const d = (await res.json()).daily;
    const byDate = {};
    d.time.forEach((t, i) => { byDate[t] = { tminF: d.temperature_2m_min[i] }; });
    const evs = GardenFrost.outlook({
      weatherByDate: byDate,
      containers: await idbAll(db, 'containers'),
      plantings: await idbAll(db, 'plantings'),
    });
    await notifyNew(db, evs, setting);
  } finally {
    db.close();
  }
}

async function notifyNew(db, evs, setting) {
  const sent = (await idbGetMeta(db, 'frostNotified')) || {};
  const now = Date.now();
  for (const k of Object.keys(sent)) if (now - new Date(sent[k]).getTime() > 7 * 864e5) delete sent[k];
  for (const ev of evs) {
    if (!GardenFrost.wanted(ev, setting) || sent[GardenFrost.key(ev)]) continue;
    const { title, body } = GardenFrost.describe(ev);
    await self.registration.showNotification(title, {
      body, tag: `frost-${ev.date}`, renotify: true,
      icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    });
    sent[GardenFrost.key(ev)] = new Date().toISOString();
  }
  await idbSetMeta(db, 'frostNotified', sent);
}
