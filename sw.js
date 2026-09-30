/* マイ本棚 Service Worker
   - アプリ本体(HTML/CSS/JS)をキャッシュしてオフラインでも一覧を見られるようにする
   - HTMLはネットワーク優先(更新をすぐ反映)、静的ファイルはキャッシュ優先 */

const CACHE_NAME = "my-bookshelf-v18";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sync.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // 扱うのは画面・スクリプト・スタイル・画像だけ。書誌検索APIや同期の通信
  // (データベースとの常時接続など)はキャッシュすると壊れるため素通しする
  const isPage = req.mode === "navigate" || req.destination === "script" || req.destination === "style";
  const isAsset = req.destination === "image" || req.destination === "manifest";
  if (!isPage && !isAsset) return;

  // ページ本体とJS/CSSはネットワーク優先(修正の反映を優先)、失敗時にキャッシュ
  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // 表紙画像やアイコンはキャッシュ優先、なければ取得してキャッシュ
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
