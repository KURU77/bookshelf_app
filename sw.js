/* マイ本棚 Service Worker
   - アプリ本体(HTML/CSS/JS)をキャッシュしてオフラインでも一覧を見られるようにする
   - HTMLはネットワーク優先(更新をすぐ反映)、静的ファイルはキャッシュ優先 */

const CACHE_NAME = "my-bookshelf-v19";
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
    // 古い版を保存しないよう、サーバーから取り直した内容を保存する
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" }))))
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

/* このサイト自身のファイルは、毎回サーバーに更新の有無を確認して取得する。
   GitHub Pagesは「10分間は確認せずに使ってよい」と指示するため、通常の取得だと
   更新を公開しても古い版が表示され続ける(変更がなければ確認の通信だけで済む) */
function fetchFresh(req) {
  if (new URL(req.url).origin !== self.location.origin) return fetch(req);
  // 画面遷移のリクエストはオプションを付けて作り直せないため、URLで取り直す
  if (req.mode === "navigate") return fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
  return fetch(req, { cache: "no-cache" });
}

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
      fetchFresh(req)
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
