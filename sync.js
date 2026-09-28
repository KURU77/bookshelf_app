/* ============================================================
   端末間同期 — Googleアカウントでログインし、複数の端末で同じ本棚を使う
   (Firebase Authentication + Cloud Firestore)

   クラウド上の保存形式:
     users/{uid}              置き場所・ジャンル・並び順 (metaUpdatedAt)
     users/{uid}/books/{isbn} 本1冊ずつ。削除した本は deleted:true の記録として残す

   同期の考え方:
     - 本は1冊ごとに updatedAt が新しい方を採用する。別々の端末で
       別の本を編集しても、どちらの変更も失われない
     - 受信は serverUpdatedAt(サーバー時刻)が前回受信以降のものだけを読む。
       毎回全冊を読むと、Firestoreの無料枠(読み取り回数)をすぐ使い切るため
     - 送信が必要な本は「クラウドにある版」を端末に記録して判定する。
       送信の途中でアプリを閉じても、次に開いたときに送り直される
   ============================================================ */
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0";
const SYNC_KEY = "my-bookshelf-sync-v1";
const BATCH_LIMIT = 400;             // Firestoreの一括書き込みは1回500件まで
const PULL_MARGIN_MS = 60 * 1000;    // サーバー時刻の境目で取りこぼさないための余裕
const PUSH_DELAY_MS = 1500;          // 続けて編集したときはまとめて送る

// 開発用: localhost で ?emulator を付けると、手元のFirebaseエミュレータに接続する
const USE_EMULATOR = ["localhost", "127.0.0.1"].includes(location.hostname)
  && new URLSearchParams(location.search).has("emulator");

const bridge = window.bookshelf;
const $ = (id) => document.getElementById(id);

let fbAuth = null;       // 読み込んだFirebase Authの関数群
let fs = null;           // 読み込んだFirestoreの関数群
let auth = null;
let db = null;
let user = null;
let meta = null;         // この端末の同期記録(localStorage)
let listeners = [];
let pulled = { books: false, meta: false };
let remoteMetaExists = false;
let remoteOrder = null;  // クラウドの並び順
let pendingRemote = [];  // 並べ替え中などで反映を待たせている受信データ
let flushTimer = null;
let pushTimer = null;
let pushing = false;
let pushAgain = false;
let firstSync = null;    // 初回同期の件数(完了時の案内に使う)
let status = "off";
let lastError = "";
let nextNotice = "";     // ログアウト後に表示する案内

window.cloudSync = {
  // app.js の saveState() から呼ばれる
  onLocalChange() {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushDirty, PUSH_DELAY_MS);
  }
};

/* ---------- 小道具 ---------- */
function isNative() {
  const cap = window.Capacitor;
  return !!(cap && cap.isNativePlatform && cap.isNativePlatform());
}

function isConfigured(c) {
  return !!(c && c.apiKey && c.projectId && c.appId);
}

/* 本の版(新しさ)。同期機能を入れる前に登録した本は登録日時で代用する */
function ver(b) {
  return b.updatedAt || b.addedAt || 1;
}

/* キーの並び順に左右されない比較用の文字列(updatedAtは比較から除く) */
function fingerprint(v) {
  if (Array.isArray(v)) return "[" + v.map(fingerprint).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort()
      .filter(k => k !== "updatedAt" && v[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + fingerprint(v[k]))
      .join(",") + "}";
  }
  return JSON.stringify(v);
}

function loadMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) { return null; }
}

function saveMeta() {
  if (meta) localStorage.setItem(SYNC_KEY, JSON.stringify(meta));
}

/* server: クラウドにある各本の版。"a<版>"=登録中 / "d<日時>"=削除済み */
function freshMeta(uid) {
  return { uid, lastServerMs: 0, server: {}, metaAt: 0, lastSyncAt: 0 };
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 画面 ---------- */
function showMessage(text) {
  const m = $("syncMessage");
  m.textContent = text;
  m.hidden = !text;
}

function renderPanel(mode) {
  $("syncSignedOut").hidden = mode !== "signedOut";
  $("syncSignedIn").hidden = mode !== "signedIn";
  const notes = {
    loading: "同期機能を読み込み中…",
    native: "ストア版アプリでは、現在は同期機能を利用できません。",
    unconfigured: "同期機能は現在準備中です。",
    loadError: "同期機能を読み込めませんでした。インターネットに接続してから、アプリを開き直してください。"
  };
  let note = notes[mode] || "";
  if (mode === "signedOut" && nextNotice) {
    note = nextNotice;
    nextNotice = "";
  }
  showMessage(note);
  if (mode === "signedIn") {
    $("syncAccount").textContent = `ログイン中: ${user.email || user.displayName || ""}`;
  }
}

function setStatus(st) {
  status = st;
  const icons = { synced: "☁️", syncing: "🔄", offline: "📴", error: "⚠️" };
  const labels = {
    synced: "同期済み",
    syncing: "同期中…",
    offline: "オフライン（接続すると自動で同期します）",
    error: "同期エラー"
  };
  const badge = $("syncBadge");
  badge.hidden = !user || !icons[st];
  badge.textContent = icons[st] || "";
  badge.title = labels[st] || "";

  if (!user) return;
  let line = labels[st] || "";
  if (st === "error" && lastError) line += `（${lastError}）`;
  if (meta && meta.lastSyncAt) line += ` ・ 最終同期 ${formatTime(meta.lastSyncAt)}`;
  $("syncStatusText").textContent = line;
}

/* ---------- 起動 ---------- */
async function loadFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`)
  ]);
  return { appMod, authMod, fsMod };
}

async function init() {
  if (!bridge) return;
  $("syncSignInBtn").onclick = signIn;
  $("syncSignOutBtn").onclick = signOutNow;
  $("syncNowBtn").onclick = () => { setStatus("syncing"); pushDirty(); };
  $("syncDeleteBtn").onclick = deleteCloudData;

  if (isNative()) { renderPanel("native"); return; }
  if (!isConfigured(firebaseConfig) && !USE_EMULATOR) { renderPanel("unconfigured"); return; }

  renderPanel("loading");
  let mods;
  try {
    mods = await loadFirebase();
  } catch (e) {
    renderPanel("loadError");
    return;
  }
  fbAuth = mods.authMod;
  fs = mods.fsMod;

  const config = USE_EMULATOR
    ? { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-bookshelf", appId: "demo" }
    : firebaseConfig;
  const fbApp = mods.appMod.initializeApp(config);
  auth = fbAuth.getAuth(fbApp);
  // 古い本には値のない項目があるため、undefined は保存時に無視する
  db = fs.initializeFirestore(fbApp, { ignoreUndefinedProperties: true });
  if (USE_EMULATOR) {
    fbAuth.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    fs.connectFirestoreEmulator(db, "127.0.0.1", 8080);
    exposeTestHooks();
  }

  fbAuth.onAuthStateChanged(auth, handleUser);
  window.addEventListener("online", () => { if (user) { setStatus("syncing"); pushDirty(); } });
  window.addEventListener("offline", () => { if (user) setStatus("offline"); });
  // アプリを閉じる・切り替える直前に、待たせている送信を済ませる
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && user) {
      clearTimeout(pushTimer);
      pushDirty();
    }
  });
}

/* ---------- ログイン状態 ---------- */
function handleUser(u) {
  stopListening();
  user = u;
  if (!u) {
    meta = null;
    setStatus("off");
    renderPanel("signedOut");
    return;
  }

  const saved = loadMeta();
  if (saved && saved.uid && saved.uid !== u.uid) {
    // 以前は別のGoogleアカウントで同期していた端末
    const s = bridge.getState();
    const merge = s.books.length === 0 || confirm(
      "この端末には、別のGoogleアカウントで同期していた本棚があります。\n\n" +
      "OK: この本棚を今のアカウントにも統合する\n" +
      "キャンセル: この端末の本棚を消して、今のアカウントの本棚を使う");
    if (!merge) bridge.resetLocal();
  }
  meta = saved && saved.uid === u.uid ? saved : freshMeta(u.uid);
  if (!meta.server) meta.server = {};
  saveMeta();

  pulled = { books: false, meta: false };
  remoteMetaExists = false;
  remoteOrder = null;
  firstSync = meta.lastSyncAt ? null : { down: 0, up: 0 };
  renderPanel("signedIn");
  setStatus(navigator.onLine ? "syncing" : "offline");
  startListening();
}

async function signIn() {
  showMessage("");
  const provider = new fbAuth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await fbAuth.signInWithPopup(auth, provider);
  } catch (e) {
    const msg = authErrorMessage(e);
    if (msg) showMessage(msg);
  }
}

function authErrorMessage(e) {
  switch (e && e.code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/user-cancelled":
      return "";
    case "auth/popup-blocked":
      return "ログイン画面がブロックされました。ポップアップを許可してから、もう一度お試しください。";
    case "auth/unauthorized-domain":
      return "このアドレスからのログインは許可されていません（アプリ側の設定が必要です）。";
    case "auth/network-request-failed":
      return "通信できませんでした。インターネット接続を確認してください。";
    default:
      return `ログインできませんでした。（${(e && (e.code || e.message)) || "不明なエラー"}）`;
  }
}

async function signOutNow() {
  if (!confirm("ログアウトしますか？\nこの端末の本棚はそのまま残ります。")) return;
  clearTimeout(pushTimer);
  // 送り残しがあれば済ませる(通信できないときは待たずにログアウトし、次回ログイン時に送る)
  if (navigator.onLine) {
    await Promise.race([pushDirty(), new Promise(r => setTimeout(r, 4000))]);
  }
  nextNotice = "ログアウトしました。この端末の本棚はそのまま残っています。";
  await fbAuth.signOut(auth);
}

/* ---------- 受信 ---------- */
function startListening() {
  const uid = user.uid;
  const since = fs.Timestamp.fromMillis(Math.max(0, meta.lastServerMs - PULL_MARGIN_MS));
  const booksQuery = fs.query(
    fs.collection(db, "users", uid, "books"),
    fs.where("serverUpdatedAt", ">", since)
  );
  listeners.push(fs.onSnapshot(booksQuery, (snap) => {
    for (const ch of snap.docChanges()) {
      // 自分が送信中の書き込みは、サーバーに届いてから改めて受け取る
      if (ch.type === "removed" || ch.doc.metadata.hasPendingWrites) continue;
      pendingRemote.push({ kind: "book", id: ch.doc.id, data: ch.doc.data() });
    }
    if (!snap.metadata.fromCache) pendingRemote.push({ kind: "pulled", what: "books" });
    flushRemote();
  }, onListenError));

  listeners.push(fs.onSnapshot(fs.doc(db, "users", uid), (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    pendingRemote.push({ kind: "meta", exists: snap.exists(), data: snap.exists() ? snap.data() : null });
    if (!snap.metadata.fromCache) pendingRemote.push({ kind: "pulled", what: "meta" });
    flushRemote();
  }, onListenError));
}

function stopListening() {
  listeners.forEach(unsubscribe => unsubscribe());
  listeners = [];
  pendingRemote = [];
  clearTimeout(flushTimer);
  clearTimeout(pushTimer);
}

function onListenError(e) {
  lastError = e.code || e.message;
  setStatus("error");
}

function flushRemote() {
  clearTimeout(flushTimer);
  if (!pendingRemote.length || !meta) return;
  // 並べ替えの最中に本の並びを変えると操作が壊れるため、終わるまで待つ
  if (bridge.isBusy()) {
    flushTimer = setTimeout(flushRemote, 400);
    return;
  }
  const items = pendingRemote;
  pendingRemote = [];
  const s = bridge.getState();
  if (!s.tombstones) s.tombstones = {};

  let changed = false;
  for (const it of items) {
    if (it.kind === "book") {
      const t = it.data.serverUpdatedAt;
      const ms = t && t.toMillis ? t.toMillis() : 0;
      if (ms > meta.lastServerMs) meta.lastServerMs = ms;
      if (mergeRemoteBook(s, it.id, it.data)) changed = true;
    } else if (it.kind === "meta") {
      remoteMetaExists = it.exists;
      if (it.exists && mergeRemoteMeta(s, it.data)) changed = true;
    } else if (it.kind === "pulled") {
      pulled[it.what] = true;
    }
  }
  // クラウドの並び順に従っている間は、届いた本もその並び順にそろえる
  if (remoteOrder && (s.metaUpdatedAt || 0) === meta.metaAt && applyOrder(s, remoteOrder)) {
    changed = true;
  }
  saveMeta();
  if (changed) bridge.commitRemoteChanges();
  if (pulled.books && pulled.meta) pushDirty();
}

/* 届いた1冊を取り込む。この端末の方が新しければ何もしない(後で送る) */
function mergeRemoteBook(s, isbn, r) {
  const rv = r.updatedAt || 0;
  meta.server[isbn] = (r.deleted ? "d" : "a") + rv;
  const i = s.books.findIndex(b => b.isbn === isbn);
  const local = i >= 0 ? s.books[i] : null;

  if (r.deleted) {
    if (local && ver(local) > rv) return false;   // 削除より後にこの端末で編集した
    if (local) s.books.splice(i, 1);
    s.tombstones[isbn] = rv;
    return !!local;
  }
  if ((s.tombstones[isbn] || 0) > rv) return false; // この端末での削除の方が新しい

  const book = { ...r };
  delete book.serverUpdatedAt;
  delete book.deleted;
  if (local) {
    if (ver(local) > rv) return false;
    if (fingerprint(local) === fingerprint(book)) {
      if (ver(local) === rv) return false;
      local.updatedAt = rv;                          // 内容は同じなので版だけそろえる
      return true;
    }
    s.books[i] = book;
  } else {
    delete s.tombstones[isbn];
    s.books.unshift(book);
  }
  if (firstSync) firstSync.down++;
  return true;
}

/* 置き場所・ジャンル・並び順を取り込む */
function mergeRemoteMeta(s, r) {
  const rv = r.metaUpdatedAt || 0;
  remoteOrder = Array.isArray(r.order) ? r.order : [];
  meta.metaAt = rv;
  if ((s.metaUpdatedAt || 0) > rv) return false;     // この端末の方が新しい(後で送る)

  // この端末の本が使っている名前は、クラウド側に無くても消さずに残す
  const remoteLocations = r.locations && r.locations.length ? r.locations : s.locations;
  const locations = withUsedNames(remoteLocations, s.books.map(b => b.location));
  const genres = withUsedNames(r.genres || [], s.books.map(b => b.genre));
  const before = fingerprint([s.locations, s.genres, s.metaUpdatedAt || 0]);
  s.locations = locations;
  s.genres = genres;
  const added = locations.length !== remoteLocations.length || genres.length !== (r.genres || []).length;
  s.metaUpdatedAt = added ? Date.now() : rv;         // 足した名前はクラウドにも送り返す
  return fingerprint([s.locations, s.genres, s.metaUpdatedAt]) !== before;
}

function withUsedNames(list, used) {
  const out = [...list];
  for (const name of used) {
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/* クラウドの並び順にそろえる。まだ並び順に無い本は先頭に置く */
function applyOrder(s, order) {
  const pos = new Map(order.map((isbn, i) => [isbn, i]));
  const before = s.books.map(b => b.isbn).join(",");
  const fresh = s.books.filter(b => !pos.has(b.isbn));
  const known = s.books.filter(b => pos.has(b.isbn))
    .sort((a, b) => pos.get(a.isbn) - pos.get(b.isbn));
  s.books.splice(0, s.books.length, ...fresh, ...known);
  return s.books.map(b => b.isbn).join(",") !== before;
}

/* ---------- 送信 ---------- */
async function pushDirty() {
  if (!user || !meta || !(pulled.books && pulled.meta)) return;
  if (pushing) {
    pushAgain = true;
    return;
  }
  pushing = true;
  const uid = user.uid;
  try {
    const s = bridge.getState();
    const present = new Set(s.books.map(b => b.isbn));
    const writes = [];
    for (const b of s.books) {
      const tag = "a" + ver(b);
      if (meta.server[b.isbn] !== tag) {
        writes.push({ isbn: b.isbn, tag, data: { ...b, updatedAt: ver(b), deleted: false } });
      }
    }
    for (const [isbn, ts] of Object.entries(s.tombstones || {})) {
      // クラウドに残っている本だけ削除を伝える
      const srv = meta.server[isbn];
      if (!present.has(isbn) && srv && srv[0] === "a") {
        writes.push({ isbn, tag: "d" + ts, data: { isbn, deleted: true, updatedAt: ts } });
      }
    }

    if (writes.length) setStatus(navigator.onLine ? "syncing" : "offline");
    for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
      const chunk = writes.slice(i, i + BATCH_LIMIT);
      const batch = fs.writeBatch(db);
      for (const w of chunk) {
        batch.set(fs.doc(db, "users", uid, "books", w.isbn),
          { ...w.data, serverUpdatedAt: fs.serverTimestamp() });
      }
      await batch.commit();
      for (const w of chunk) meta.server[w.isbn] = w.tag;
      if (firstSync) firstSync.up += chunk.length;
      saveMeta();
    }

    if (!s.metaUpdatedAt) {
      // 同期機能を入れる前のデータには日時がないので、ここで付ける
      s.metaUpdatedAt = Date.now();
      bridge.commitRemoteChanges();
    }
    if (!remoteMetaExists || s.metaUpdatedAt !== meta.metaAt) {
      const at = s.metaUpdatedAt;
      await fs.setDoc(fs.doc(db, "users", uid), {
        locations: s.locations,
        genres: s.genres,
        order: s.books.map(b => b.isbn),
        metaUpdatedAt: at,
        serverUpdatedAt: fs.serverTimestamp()
      });
      meta.metaAt = at;
      remoteMetaExists = true;
    }

    meta.lastSyncAt = Date.now();
    saveMeta();
    setStatus(navigator.onLine ? "synced" : "offline");
    if (firstSync) {
      showMessage(`同期を開始しました。この端末から${firstSync.up}件を送信し、クラウドから${firstSync.down}冊を受け取りました。`);
      firstSync = null;
    }
  } catch (e) {
    lastError = e.code || e.message;
    setStatus("error");
  } finally {
    pushing = false;
    if (pushAgain) {
      pushAgain = false;
      pushDirty();
    }
  }
}

/* ---------- クラウドのデータ削除(同期をやめる) ---------- */
async function deleteCloudData() {
  if (!confirm(
    "クラウドに保存した本棚のデータとログイン情報を削除し、同期をやめます。\n" +
    "この端末や他の端末の本棚はそのまま残ります。\n\n本当に削除しますか？")) return;
  const current = auth.currentUser;
  if (!current) return;
  setStatus("syncing");
  stopListening();
  try {
    const uid = current.uid;
    const snap = await fs.getDocs(fs.collection(db, "users", uid, "books"));
    for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
      const batch = fs.writeBatch(db);
      snap.docs.slice(i, i + BATCH_LIMIT).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    await fs.deleteDoc(fs.doc(db, "users", uid));
  } catch (e) {
    showMessage(`削除できませんでした。（${e.code || e.message}）`);
    handleUser(auth.currentUser);   // 同期を再開する
    return;
  }

  localStorage.removeItem(SYNC_KEY);
  meta = null;
  nextNotice = "クラウドのデータを削除しました。この端末の本棚はそのまま残っています。" +
    "他の端末でも同期をやめる場合は、その端末でログアウトしてください。";
  try {
    await fbAuth.deleteUser(current);
  } catch (e) {
    try {
      if (e.code !== "auth/requires-recent-login") throw e;
      // 最後のログインから時間が経っている場合は、本人確認をしてから削除する
      await fbAuth.reauthenticateWithPopup(current, new fbAuth.GoogleAuthProvider());
      await fbAuth.deleteUser(current);
    } catch (e2) {
      // 本棚のデータは削除済み。ログイン情報だけ残ったので、ログアウトして同期を止める
      await fbAuth.signOut(auth);
    }
  }
}

/* ---------- 開発用(エミュレータ接続時のみ) ---------- */
function exposeTestHooks() {
  window.cloudSyncTest = {
    signIn: (sub, email) => fbAuth.signInWithCredential(auth,
      fbAuth.GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true }))),
    offline: () => fs.disableNetwork(db),
    online: () => fs.enableNetwork(db),
    info: () => ({ status, pulled: { ...pulled }, meta })
  };
}

init();
