/**
 * Service worker: app-shell caching only.
 *
 * Deliberately narrow. It caches the static shell so the dashboard opens
 * instantly and works on a bad connection, and it never touches Firestore -
 * Firestore's own IndexedDB cache handles data offline, and a second cache in
 * front of it would serve stale balances with no way to tell.
 */
const VERSION = 'trea-v2-1';
const SHELL = [
    './',
    './index.html',
    './app.js',
    './manifest.webmanifest',
    './image.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(VERSION)
            // Individually, so one missing asset does not fail the whole install.
            .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // Same-origin only. Auth, Firestore and CDN traffic go straight to the
    // network - caching a signed request or an auth response would be a bug
    // with security consequences, not just a stale asset.
    if (url.origin !== self.location.origin) return;

    // Network-first for the app's own code so a deploy is picked up on the next
    // load rather than being pinned by the cache.
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(VERSION).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(() => caches.match(request).then((hit) => hit ?? caches.match('./index.html')))
    );
});
