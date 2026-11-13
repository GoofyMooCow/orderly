// Orderly service worker: keeps the app opening when you're offline, and shows push notifications.
// Bump CACHE when you want everyone's saved copy of the page thrown away.
const CACHE = "orderly-shell-v1";
const SHELL = [
    "./app/", "./login/", "./css/app.css", "./css/login.css", "./js/app.js", "./js/extras.js", "./js/login.js",
    "./favicon-light.png", "./favicon-dark.png", "./icons/icon-192.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Always try the network first so a new version shows up straight away; fall back to the saved copy offline.
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // the server connection and everything else is left alone
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.ok && res.type === "basic") {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {
                    });
                }
                return res;
            })
            .catch(() => caches.match(req, {ignoreSearch: true}).then((hit) => hit || (req.mode === "navigate" ? caches.match("./app/") : Response.error())))
    );
});

self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = {body: event.data ? event.data.text() : ""};
    }
    event.waitUntil(self.registration.showNotification(data.title || "Orderly", {
        body: data.body || "",
        tag: data.tag || undefined,
        renotify: !!data.tag,
        icon: "./icons/icon-192.png",
        badge: "./icons/badge-96.png",
        data: {url: data.url || new URL("./app/", self.registration.scope).href},
    }));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || new URL("./app/", self.registration.scope).href;
    event.waitUntil(
        self.clients.matchAll({type: "window", includeUncontrolled: true}).then((list) => {
            for (const c of list) {
                if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
            }
            return self.clients.openWindow(url);
        })
    );
});
