/* ============================================================
   マイ本棚 — バーコード蔵書管理アプリ
   - バーコード(ISBN)スキャン → openBD / Google Books で書誌取得
   - 置き場所ごとの一覧・表紙グリッド・読了管理・読書ログ
   - データは localStorage に保存
   ============================================================ */

const STORAGE_KEY = "my-bookshelf-v1";
const DEFAULT_LOCATIONS = ["一人暮らし先", "実家", "祖父母宅", "研究室"];

let state = loadState();
let currentList = "owned";     // "owned"(蔵書) / "wish"(検討中)
let currentLocation = "all";   // "all" または置き場所名
let currentFilter = "all";     // all / unread / reading / done
let currentGenre = "all";      // "all" / "none"(未分類) / ジャンル名
let searchQuery = "";          // フリーワード検索(書名・著者)
let kuOnly = false;            // Kindle Unlimitedで読めると記録した本だけを表示する
let pendingBook = null;        // 登録確認中の本
let pendingList = "owned";     // 登録確認中の登録先リスト
let pendingGenres = [];        // 登録確認中に選んだジャンル
let detailIsbn = null;         // 詳細表示中の本のISBN
let baseline = null;           // 前回保存した時点の内容(端末間同期の変更検出に使う)
takeBaseline();

/* ---------- 保存・読込 ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.books) && Array.isArray(data.locations)) {
        // 旧データ移行: 並び順を手動管理に切り替え(初回だけ登録日時順に整列)
        if (!data.manualOrder) {
          data.books.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
          data.manualOrder = true;
        }
        if (!Array.isArray(data.genres)) data.genres = [];
        if (!data.tombstones) data.tombstones = {};
        data.books.forEach(normalizeBook);
        return data;
      }
    }
  } catch (e) { /* 壊れたデータは初期化 */ }
  return emptyState();
}

function emptyState() {
  return { books: [], locations: [...DEFAULT_LOCATIONS], genres: [], tombstones: {}, manualOrder: true };
}

/* 古い形式の本を今の形式にそろえる(読み込み時・取り込み時・同期で受け取ったとき) */
function normalizeBook(b) {
  // リスト区分(蔵書/検討中)がない本は蔵書扱い
  if (!b.list) b.list = "owned";
  // ジャンルは1冊につき最大3つのリストで持つ(以前は1つだけの genre)
  if (!Array.isArray(b.genres)) b.genres = b.genre ? [b.genre] : [];
  delete b.genre;
  // カートは検討中の本だけのもの
  if (b.list !== "wish") delete b.inCart;
}

/* 保存のたびに前回との差分を調べ、変わった本には更新日時を、消えた本には
   削除記録(tombstones)を残す。端末間同期で「どちらが新しいか」の判定に使う。
   (編集する箇所ごとに日時を書き込むと記録漏れが出るため、ここに集約している) */
function saveState() {
  stampLocalChanges();
  writeLocal();
  if (window.cloudSync) window.cloudSync.onLocalChange();
}

/* 同期で受け取った変更の保存。受け取った内容を自分の編集と誤認しないよう、
   日時は付け直さずに比較の基準だけ更新する */
function saveStateFromSync() {
  takeBaseline();
  writeLocal();
}

function writeLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function bookFingerprint(b) {
  const { updatedAt, ...rest } = b;
  return JSON.stringify(rest);
}

function metaFingerprint(s) {
  return JSON.stringify([s.locations, s.genres, s.books.map(b => b.isbn)]);
}

function takeBaseline() {
  baseline = {
    books: new Map(state.books.map(b => [b.isbn, bookFingerprint(b)])),
    meta: metaFingerprint(state)
  };
}

function stampLocalChanges() {
  const now = Date.now();
  if (!state.tombstones) state.tombstones = {};
  const present = new Set();
  for (const b of state.books) {
    present.add(b.isbn);
    if (baseline.books.get(b.isbn) !== bookFingerprint(b)) b.updatedAt = now;
    delete state.tombstones[b.isbn];   // 削除した本を登録し直した場合
  }
  for (const isbn of baseline.books.keys()) {
    if (!present.has(isbn)) state.tombstones[isbn] = now;
  }
  if (baseline.meta !== metaFingerprint(state)) state.metaUpdatedAt = now;
  takeBaseline();
}

/* ============================================================
   画面描画
   ============================================================ */
function render() {
  renderListSwitch();
  renderTabs();
  renderGenreFilter();
  renderCartFab();
  renderGrid();
  renderHeaderStats();
}

/* ---------- 価格 ---------- */
function yen(n) {
  return "¥" + Number(n).toLocaleString("ja-JP");
}

/* 「¥638（税込）・本体¥580」のような表示 */
function priceText(b) {
  if (!b.price || !b.price.total) return "";
  const base = b.price.base ? `・本体${yen(b.price.base)}` : "";
  return `${yen(b.price.total)}（税込）${base}`;
}

/* 古い時点の価格か(国会図書館に古い版の価格しか記録されていない本) */
function isOldPrice(p) {
  return !!(p && p.source === "ndl" && p.asOf && p.asOf < new Date().getFullYear() - 1);
}

/* 価格の出どころの説明(出版社の情報なら空) */
function priceSourceNote(p) {
  if (!p) return "";
  if (p.source === "manual") return "手入力した価格です。";
  if (p.source === "ndl") {
    return isOldPrice(p)
      ? `国立国会図書館に記録された${p.asOf}年時点の価格です。現在の価格とは違う場合があります。`
      : "国立国会図書館の情報による価格です。";
  }
  return "";
}

/* ---------- カート(検討中の本の合計金額の目安) ---------- */
function cartBooks() {
  return state.books.filter(b => b.list === "wish" && b.inCart);
}

/* スキャンボタン左のカートボタン。入っている冊数を表示する */
function renderCartFab() {
  const count = cartBooks().length;
  const badge = document.getElementById("cartFabCount");
  badge.hidden = count === 0;
  badge.textContent = count;
  document.getElementById("cartFab").setAttribute("aria-label", `カートを開く（${count}冊）`);
}

function openCart() {
  renderCartModal();
  showModal("cartModal");
}

function renderCartModal() {
  const body = document.getElementById("cartBody");
  const items = cartBooks();
  if (!items.length) {
    body.innerHTML = `<p class="cart-empty">カートは空です。<br>検討中の本の詳細で「🛒 カートに入れる」を押すと、ここに入り、買うといくらになるかの目安が分かります。</p>`;
    return;
  }
  const priced = items.filter(b => b.price && b.price.total);
  const total = priced.reduce((sum, b) => sum + b.price.total, 0);
  const unknown = items.length - priced.length;
  const old = priced.filter(b => isOldPrice(b.price)).length;
  body.innerHTML = `
    <div class="cart-summary">
      <span class="cart-title">${items.length}冊</span>
      <span class="cart-total">合計 ${yen(total)}</span>
    </div>
    <p class="cart-note">定価（税込）の合計です。送料やポイントは含みません。${unknown ? `価格が分からない${unknown}冊は合計に入っていません。` : ""}${old ? `古い時点の価格しか分からない本が${old}冊含まれているため、実際とは違う場合があります。` : ""}</p>
    <ul class="cart-list">
      ${items.map(b => `
        <li class="cart-item" data-isbn="${b.isbn}">
          ${b.cover
            ? `<img class="cart-thumb" src="${escapeHtml(b.cover)}" alt="">`
            : `<div class="cart-thumb placeholder"></div>`}
          <div class="cart-info">
            <div class="cart-item-title">${escapeHtml(b.title)}</div>
            <div class="cart-item-price">${b.price && b.price.total
              ? yen(b.price.total) + (isOldPrice(b.price) ? `<span class="cart-old">（${b.price.asOf}年時点）</span>` : "")
              : "価格不明"}</div>
          </div>
          <button class="cart-remove" data-remove="${b.isbn}">外す</button>
        </li>`).join("")}
    </ul>
    <button class="btn danger cart-clear-btn" id="cartClearBtn">カートを空にする</button>
  `;

  // 本を押すと詳細(ネットショップへのリンクがある画面)を開く
  body.querySelectorAll(".cart-item").forEach(li => {
    li.onclick = (e) => {
      if (e.target.closest(".cart-remove")) return;
      hideModal("cartModal");
      openDetail(li.dataset.isbn);
    };
  });
  body.querySelectorAll(".cart-remove").forEach(btn => {
    btn.onclick = () => {
      const b = state.books.find(x => x.isbn === btn.dataset.remove);
      if (b) delete b.inCart;
      saveState();
      render();
      renderCartModal();
    };
  });
  document.getElementById("cartClearBtn").onclick = () => {
    if (!confirm(`カートの${items.length}冊をすべてカートから外しますか？\n（本は検討中リストに残ります）`)) return;
    items.forEach(b => { delete b.inCart; });
    saveState();
    render();
    renderCartModal();
  };
}

function renderListSwitch() {
  const owned = state.books.filter(b => (b.list || "owned") === "owned").length;
  const wish = state.books.filter(b => b.list === "wish").length;
  const tabO = document.getElementById("listTabOwned");
  const tabW = document.getElementById("listTabWish");
  tabO.innerHTML = `📚 蔵書<span class="count">${owned}</span>`;
  tabW.innerHTML = `🛒 検討中<span class="count">${wish}</span>`;
  tabO.classList.toggle("active", currentList === "owned");
  tabW.classList.toggle("active", currentList === "wish");
  // 検討中リストでは置き場所タブと読了フィルタを隠す(購入前の本のため)
  const isWish = currentList === "wish";
  document.getElementById("locationTabs").style.display = isWish ? "none" : "";
  document.querySelectorAll(".filter-btn").forEach(x => { x.style.display = isWish ? "none" : ""; });
}

function renderGenreFilter() {
  const sel = document.getElementById("genreFilter");
  const prev = currentGenre;
  sel.innerHTML = "";
  sel.appendChild(new Option("全ジャンル", "all"));
  for (const g of state.genres) sel.appendChild(new Option(g, g));
  sel.appendChild(new Option("未分類", "none"));
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : "all";
  currentGenre = sel.value;
}

function renderHeaderStats() {
  const owned = state.books.filter(b => (b.list || "owned") === "owned");
  const done = owned.filter(b => b.status === "done").length;
  const stats = owned.length ? `${owned.length}冊 / 読了${done}冊 ` : "";
  document.getElementById("headerStats").innerHTML =
    `${stats}<span style="opacity:.55;font-size:.7rem">v${APP_VERSION}</span>`;
}

function renderTabs() {
  const nav = document.getElementById("locationTabs");
  nav.innerHTML = "";
  const tabs = [{ key: "all", label: "すべて" }]
    .concat(state.locations.map(l => ({ key: l, label: l })));

  const ownedBooks = state.books.filter(b => (b.list || "owned") === "owned");
  for (const t of tabs) {
    const count = t.key === "all"
      ? ownedBooks.length
      : ownedBooks.filter(b => b.location === t.key).length;
    const btn = document.createElement("button");
    btn.className = "loc-tab" + (currentLocation === t.key ? " active" : "");
    btn.innerHTML = `${escapeHtml(t.label)}<span class="count">${count}</span>`;
    btn.onclick = () => { currentLocation = t.key; render(); };
    nav.appendChild(btn);
  }
}

function visibleBooks() {
  const q = searchQuery.toLowerCase();
  return state.books.filter(b => {
    if ((b.list || "owned") !== currentList) return false;
    if (currentList === "owned") {
      if (currentLocation !== "all" && b.location !== currentLocation) return false;
      if (currentFilter !== "all" && bookStatus(b) !== currentFilter) return false;
    }
    if (currentGenre === "none") { if (b.genres.length) return false; }
    else if (currentGenre !== "all" && !b.genres.includes(currentGenre)) return false;
    if (q && !`${b.title} ${b.author} ${b.memo || ""}`.toLowerCase().includes(q)) return false;
    if (kuOnly && !(b.ku && b.ku.status === "yes")) return false;
    return true;
  });
}

/* 状態: done(読了) / reading(ログあり・未読了) / unread(未読) */
function bookStatus(b) {
  if (b.status === "done") return "done";
  if (b.logs && b.logs.length > 0) return "reading";
  return "unread";
}

const STATUS_LABEL = { done: "読了", reading: "読書中", unread: "未読" };

function renderGrid() {
  const grid = document.getElementById("bookGrid");
  const empty = document.getElementById("emptyState");
  grid.innerHTML = "";
  // 並び順は books 配列の順そのまま(長押しドラッグで並べ替え可能)
  const books = visibleBooks();

  empty.hidden = books.length > 0;
  empty.innerHTML = currentList === "wish"
    ? `<p>検討中の本はまだありません。</p><p>スキャン時に登録先を「🛒 検討中」にすると追加できます。</p>`
    : `<p>まだ本がありません。</p><p>「＋ スキャン」でバーコードを読み取って登録しましょう。</p>` +
      `<p class="empty-sync-hint">他の端末で使っている場合は「⚙ 管理」→「端末間の同期」でログインすると、本棚が届きます。</p>`;

  for (const b of books) {
    const card = document.createElement("div");
    card.className = "book-card";
    card.dataset.isbn = b.isbn;
    const st = bookStatus(b);

    const coverHtml = b.cover
      ? `<img class="book-cover" src="${escapeHtml(b.cover)}" alt="" loading="lazy" draggable="false"
           onerror="this.outerHTML='<div class=&quot;book-cover placeholder&quot;>${escapeHtml(b.title)}</div>'">`
      : `<div class="book-cover placeholder">${escapeHtml(b.title)}</div>`;

    const progress = progressPercent(b);
    const progressHtml = progress !== null
      ? `<div class="progress-mini"><div style="width:${progress}%"></div></div>` : "";

    const isWish = b.list === "wish";
    const badgeHtml = isWish
      ? (b.inCart ? `<span class="status-badge cart">🛒 カート</span>` : "")
      : `<span class="status-badge ${st}">${STATUS_LABEL[st]}</span>`;
    // 検討中の本は、買うときの目安になるよう定価も表示する
    const priceHtml = isWish && b.price && b.price.total
      ? `<div class="book-price">${yen(b.price.total)}</div>` : "";
    card.innerHTML = `
      ${coverHtml}
      ${badgeHtml}
      ${b.memo ? `<span class="memo-mark" title="メモあり">📝</span>` : ""}
      ${b.ku && b.ku.status === "yes" ? `<span class="ku-mark" title="Kindle Unlimitedで読める">KU</span>` : ""}
      ${progressHtml}
      <div class="book-title">${escapeHtml(b.title)}</div>
      ${priceHtml}
    `;
    card.onclick = () => { if (suppressClick) return; openDetail(b.isbn); };
    attachDragHandlers(card);
    grid.appendChild(card);
  }
}

function progressPercent(b) {
  if (!b.totalPages || !b.logs || b.logs.length === 0) return null;
  const maxPage = Math.max(...b.logs.map(l => l.page));
  return Math.min(100, Math.round((maxPage / b.totalPages) * 100));
}

/* ============================================================
   並べ替え(表紙を長押し→浮き上がったらドラッグで移動)
   ============================================================ */
const LONG_PRESS_MS = 450;
let dragCtx = null;        // 進行中の長押し/ドラッグの状態
let suppressClick = false; // ドラッグ直後の誤タップ(詳細が開く)防止

function attachDragHandlers(card) {
  card.addEventListener("pointerdown", (e) => {
    if (dragCtx) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragCtx = {
      card,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      dragging: false
    };
    card.classList.add("pressing");
    dragCtx.timer = setTimeout(liftCard, LONG_PRESS_MS);
  });
}

function liftCard() {
  if (!dragCtx || dragCtx.dragging) return;
  const { card } = dragCtx;
  const rect = card.getBoundingClientRect();
  const clone = card.cloneNode(true);
  clone.classList.remove("pressing");
  clone.classList.add("drag-clone");
  clone.style.width = rect.width + "px";
  clone.style.left = rect.left + "px";
  clone.style.top = rect.top + "px";
  document.body.appendChild(clone);
  Object.assign(dragCtx, {
    clone,
    dragging: true,
    offsetX: dragCtx.lastX - rect.left,
    offsetY: dragCtx.lastY - rect.top
  });
  card.classList.remove("pressing");
  card.classList.add("drag-origin");
  try { card.setPointerCapture(dragCtx.pointerId); } catch (e) {}
  // ドラッグ中は画面スクロールを止める
  document.addEventListener("touchmove", blockTouchScroll, { passive: false });
  navigator.vibrate && navigator.vibrate(40);
}

function blockTouchScroll(e) { e.preventDefault(); }

function cancelPress() {
  if (!dragCtx) return;
  clearTimeout(dragCtx.timer);
  dragCtx.card.classList.remove("pressing");
  dragCtx = null;
}

window.addEventListener("pointermove", (e) => {
  if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
  dragCtx.lastX = e.clientX;
  dragCtx.lastY = e.clientY;

  if (!dragCtx.dragging) {
    // 長押し前に大きく動いたらスクロール操作とみなしてキャンセル
    if (Math.hypot(e.clientX - dragCtx.startX, e.clientY - dragCtx.startY) > 12) cancelPress();
    return;
  }

  const { clone, card } = dragCtx;
  clone.style.left = (e.clientX - dragCtx.offsetX) + "px";
  clone.style.top = (e.clientY - dragCtx.offsetY) + "px";

  // 指の下にある別のカードの位置へ入れ替え(クローンはpointer-events:none)
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const target = under && under.closest(".book-card");
  if (target && target !== card && target.parentElement === card.parentElement) {
    const grid = card.parentElement;
    const cards = [...grid.children];
    if (cards.indexOf(card) < cards.indexOf(target)) {
      grid.insertBefore(card, target.nextSibling);
    } else {
      grid.insertBefore(card, target);
    }
  }
});

function endDrag(e) {
  if (!dragCtx) return;
  if (e && e.pointerId !== undefined && e.pointerId !== dragCtx.pointerId) return;
  const wasDragging = dragCtx.dragging;
  clearTimeout(dragCtx.timer);
  dragCtx.card.classList.remove("pressing", "drag-origin");
  if (dragCtx.clone) dragCtx.clone.remove();
  document.removeEventListener("touchmove", blockTouchScroll);
  dragCtx = null;
  if (wasDragging) {
    commitGridOrder();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 350);
  }
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

/* グリッドの新しい並びを books 配列に反映する。
   絞り込み表示中でも、表示中の本が元々占めていた位置だけを入れ替える */
function commitGridOrder() {
  const newOrder = [...document.getElementById("bookGrid").children]
    .map(c => c.dataset.isbn);
  const visibleSet = new Set(newOrder);
  const slots = [];
  state.books.forEach((b, i) => { if (visibleSet.has(b.isbn)) slots.push(i); });
  const byIsbn = new Map(state.books.map(b => [b.isbn, b]));
  newOrder.forEach((isbn, k) => { state.books[slots[k]] = byIsbn.get(isbn); });
  saveState();
}

/* ============================================================
   バーコードスキャン
   ============================================================ */
const APP_VERSION = "3.6";
let mediaStream = null;
let scanLoopId = null;   // requestAnimationFrame用(ネイティブ検出)
let scanTimerId = null;  // setTimeout用(ZXing検出)
let scanning = false;

function setScanHint(text) {
  document.getElementById("scanHint").innerHTML =
    `${text} <small style="opacity:.5">v${APP_VERSION}</small>`;
}

async function openScanner() {
  showModal("scanModal");
  setScanHint("本は978、雑誌は491で始まるバーコードを枠に合わせてください");
  scanning = true;
  scanCooldownUntil = 0;
  lastScannedIsbn = null;
  const contSel = document.getElementById("contLocation");
  fillLocationSelect(contSel, contSel.value || undefined);
  contSel.hidden = !document.getElementById("contMode").checked || currentList === "wish";
  const video = document.getElementById("scanVideo");
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = mediaStream;
    await video.play();

    if ("BarcodeDetector" in window) {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes("ean_13")) {
        startNativeDetector(video);
        return;
      }
    }
    startZxingLoop(video);
  } catch (err) {
    document.getElementById("scanHint").innerHTML =
      "カメラを起動できませんでした。下の「手入力」をご利用ください。<br>" +
      "<small>(HTTPS接続とカメラ許可が必要です)</small>";
  }
}

function startNativeDetector(video) {
  const detector = new window.BarcodeDetector({ formats: ["ean_13"] });
  const tick = async () => {
    if (!scanning) return;
    try {
      const codes = await detector.detect(video);
      for (const c of codes) {
        if (isBookBarcode(c.rawValue)) { onScanned(c.rawValue); break; }
      }
    } catch (e) { /* フレーム未準備などは無視 */ }
    if (!scanning) return; // 通常モードで登録に進んだら終了(連続モードは継続)
    scanLoopId = requestAnimationFrame(tick);
  };
  scanLoopId = requestAnimationFrame(tick);
}

/* ZXingでの読み取り(iPhone Safariなど BarcodeDetector 非対応ブラウザ用)。
   ZXingのストリーム管理は環境依存の不具合が多いため使わず、
   カメラのフレームを自前でcanvasに切り出して直接デコードする */
function createZxingDecoder() {
  const reader = new ZXing.MultiFormatReader();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  return (canvas) => {
    try {
      const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
      return reader.decodeWithState(bitmap).getText();
    } catch (e) {
      return null; // NotFoundException = このフレームでは見つからず(正常)
    }
  };
}

function startZxingLoop(video) {
  if (!window.ZXing) {
    setScanHint("読み取りライブラリを読み込めませんでした。手入力をご利用ください。");
    return;
  }
  const decodeCanvas = createZxingDecoder();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let attempts = 0;

  const tick = () => {
    if (!scanning) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      // 画面の照準枠に相当する中央帯だけを切り出してデコード(高速・高精度)
      const cw = Math.round(vw * 0.8);
      const ch = Math.round(vh * 0.45);
      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch);
      const text = decodeCanvas(canvas);
      attempts++;
      if (text && isBookBarcode(text)) {
        onScanned(text);
        if (!scanning) return; // 通常モードで登録に進んだら終了(連続モードは継続)
      }
      if (attempts % 6 === 0) {
        setScanHint(`スキャン中… バーコードを枠に合わせてください (${attempts})`);
      }
    }
    scanTimerId = setTimeout(tick, 150);
  };
  tick();
}

/* 書籍のISBN(978/979始まり)と国内雑誌の定期刊行物コード(491始まり)を
   受け付ける。本の下段バーコード(192...)や他の商品コードは無視する */
function isBookBarcode(text) {
  return /^97[89]\d{10}$/.test(text) || /^491\d{10}$/.test(text);
}

/* 491始まり = 雑誌(定期刊行物コード) */
function isMagazineCode(code) {
  return /^491/.test(code);
}

function codeLabel(code) {
  return isMagazineCode(code) ? "雑誌コード" : "ISBN";
}

function stopScanner() {
  scanning = false;
  if (scanLoopId) cancelAnimationFrame(scanLoopId);
  scanLoopId = null;
  if (scanTimerId) clearTimeout(scanTimerId);
  scanTimerId = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  const video = document.getElementById("scanVideo");
  video.srcObject = null;
}

/* ---------- 連続登録モード ---------- */
let scanCooldownUntil = 0;
let lastScannedIsbn = null;
let toastTimer = null;

function showScanToast(msg, warn) {
  const t = document.getElementById("scanToast");
  t.textContent = msg;
  t.classList.toggle("warn", !!warn);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, warn ? 4500 : 2400);
}

async function onScanned(isbn) {
  if (!document.getElementById("contMode").checked) {
    // 通常モード: スキャンを終了して確認画面へ
    stopScanner();
    hideModal("scanModal");
    navigator.vibrate && navigator.vibrate(80);
    await lookupAndConfirm(isbn);
    return;
  }

  // 連続登録モード: カメラを止めずに自動登録していく
  const now = Date.now();
  if (isbn === lastScannedIsbn && now < scanCooldownUntil) return;
  lastScannedIsbn = isbn;
  scanCooldownUntil = now + 3000;
  navigator.vibrate && navigator.vibrate(80);

  const dup = state.books.find(b => b.isbn === isbn);
  if (dup) {
    showScanToast(dup.list === "wish" ? "検討中リストに登録済みの本です" : "すでに蔵書に登録されている本です", true);
    return;
  }
  showScanToast(`検索中… (${isbn})`);
  let info = await fetchBookInfo(isbn);
  let notFound = false;
  if (!info) {
    notFound = true;
    info = { isbn, title: `${codeLabel(isbn)} ${isbn}`, author: "", publisher: "", cover: "", totalPages: null };
  }
  if (state.books.some(b => b.isbn === isbn)) return; // 取得中の二重登録防止
  state.books.unshift({
    isbn: info.isbn,
    title: info.title,
    author: info.author,
    publisher: info.publisher,
    cover: info.cover,
    totalPages: info.totalPages,
    ...(info.price ? { price: info.price } : {}),
    list: currentList, // 今見ているリスト(蔵書/検討中)に登録
    location: currentList === "wish" ? "" : document.getElementById("contLocation").value,
    genres: [],
    status: "unread",
    logs: [],
    addedAt: Date.now()
  });
  saveState();
  render();
  if (!info.price) setTimeout(backfillPrices, 500);
  if (notFound) {
    showScanToast(isMagazineCode(isbn)
      ? "雑誌を登録しました。詳細画面の「✎情報を編集」で誌名を入力できます"
      : "情報が見つからずISBNのみで登録。詳細画面の「✎情報を編集」で書名を入力できます", true);
  } else {
    showScanToast(`「${info.title}」を${currentList === "wish" ? "検討中リスト" : "蔵書"}に登録しました`);
  }
}

/* ============================================================
   書誌情報の取得 (openBD・国立国会図書館・Google Books・Open Library)
   ============================================================ */
// 応答が遅い検索先を待ち続けないための上限(ふだんは1〜3秒で返る。まれに30秒以上止まる)
const LOOKUP_TIMEOUT_MS = 7000;

function fetchWithTimeout(url, ms = LOOKUP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function fetchOpenBd(isbn) {
  try {
    const res = await fetchWithTimeout(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
    const data = await res.json();
    if (!data || !data[0]) return null;
    const s = data[0].summary || {};
    let totalPages = null;
    try {
      const extents = data[0].onix.DescriptiveDetail.Extent || [];
      const pageExt = extents.find(e => e.ExtentType === "11" || e.ExtentType === "00");
      if (pageExt) totalPages = parseInt(pageExt.ExtentValue, 10) || null;
    } catch (e) {}
    return {
      title: s.title || "",
      author: (s.author || "").replace(/／著|／作|／文/g, "").trim(),
      publisher: s.publisher || "",
      cover: s.cover || "",
      totalPages,
      price: priceFromOpenBd(data[0])
    };
  } catch (e) { return null; }
}

/* openBDの出版社情報(ONIX)から定価を取り出す。
   日本の本は本体価格(税抜)で登録されているので、消費税10%を加えた額も持つ */
function priceFromOpenBd(item) {
  try {
    const prices = item.onix.ProductSupply.SupplyDetail.Price || [];
    const p = prices.find(x => !x.CurrencyCode || x.CurrencyCode === "JPY");
    const amount = p && parseInt(p.PriceAmount, 10);
    if (!amount) return null;
    // PriceType 02/04 は税込、それ以外(01/03)は税抜
    if (p.PriceType === "02" || p.PriceType === "04") return { total: amount, source: "openbd" };
    return { base: amount, total: Math.floor(amount * 11 / 10), source: "openbd" };
  } catch (e) {
    return null;
  }
}

/* 国立国会図書館サーチ。国内で出版された本は国会図書館への納本が法律で
   義務づけられているため、openBDに無い本(出版社が情報を登録していない本)も見つかる。
   見つからなければ null、通信に失敗したら例外を投げる */
async function fetchNdl(isbn) {
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${isbn}&cnt=20`;
  let text;
  // 国会図書館はときどき応答が遅れたり一時的に失敗したりするので、1回だけやり直す
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error("NDL " + res.status);
      text = await res.text();
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  const xml = new DOMParser().parseFromString(text, "text/xml");
  const values = (el, tag) => [...el.getElementsByTagName(tag)]
    .map(n => n.textContent.normalize("NFKC").trim()).filter(Boolean);
  // 問い合わせたISBNが識別子に入っている記録だけが、この本そのもの
  // (点字版・CD-ROMなどの関連資料は識別子にISBNを持たないので除かれる)
  const own = [...xml.getElementsByTagName("item")]
    .filter(it => values(it, "dc:identifier").some(id => normalizeIsbn(id) === isbn));
  if (!own.length) return null;

  // 情報が多くそろっている「図書」の記録を代表にする
  const score = (it) => (values(it, "category").some(c => c.includes("図書")) ? 8 : 0)
    + (values(it, "dcndl:price").length ? 4 : 0)
    + (values(it, "dc:extent").length ? 2 : 0)
    + (values(it, "dc:creator").length ? 1 : 0);
  const best = own.slice().sort((a, b) => score(b) - score(a))[0];
  const year = (it) => parseInt((values(it, "dcterms:issued")[0] || "").match(/\d{4}/), 10) || null;

  // 価格は、価格が記録されている中でいちばん新しい版のものを使う
  const priced = own.filter(it => values(it, "dcndl:price").length)
    .sort((a, b) => (year(b) || 0) - (year(a) || 0))[0];

  const pagesText = values(best, "dc:extent")[0] || "";
  const pages = parseInt((pagesText.match(/(\d+)\s*p/) || [])[1], 10) || null;
  return {
    title: (values(best, "dc:title")[0] || "").split(" : ")[0],
    author: values(best, "dc:creator").map(cleanNdlName).join("、"),
    publisher: values(best, "dc:publisher")[0] || "",
    cover: "",
    totalPages: pages,
    price: priced ? priceFromNdl(values(priced, "dcndl:price")[0], year(priced)) : null
  };
}

/* 「村田, 沙耶香, 1979-」→「村田沙耶香」。外国人名(Dick, Philip K.)はそのまま */
function cleanNdlName(name) {
  const n = name.replace(/,\s*\d{4}-(\d{4})?$/, "").trim();
  return /[぀-ヿ一-鿿]/.test(n) ? n.replace(/,\s*/g, "") : n;
}

/* 国会図書館の価格(「2600円」「６４０円」など)。本体価格(税抜)で記録されている。
   古い版の価格しか無い本もあるので、何年時点の価格かも持つ */
function priceFromNdl(text, year) {
  const m = (text || "").replace(/,/g, "").match(/(\d+)\s*円/);
  const amount = m && parseInt(m[1], 10);
  if (!amount) return null;
  if (/税込/.test(text)) return { total: amount, source: "ndl", asOf: year };
  return { base: amount, total: Math.floor(amount * 11 / 10), source: "ndl", asOf: year };
}

/* 複数の本の定価をまとめて取得する。openBD(まとめて問い合わせできる)を先に調べ、
   定価が無かった本だけ国会図書館に1冊ずつ問い合わせる。
   prices: 見つかった本の定価 / checked: 問い合わせに成功した本(見つからなかった本も含む) */
async function fetchPrices(isbns) {
  const prices = {};
  const checked = [];
  const needNdl = [];
  for (let i = 0; i < isbns.length; i += 50) {
    const chunk = isbns.slice(i, i + 50);
    try {
      const res = await fetchWithTimeout(`https://api.openbd.jp/v1/get?isbn=${chunk.join(",")}`);
      const data = await res.json();
      data.forEach((item, k) => {
        const price = item && priceFromOpenBd(item);
        if (price) {
          prices[chunk[k]] = price;
          checked.push(chunk[k]);
        } else {
          needNdl.push(chunk[k]);
        }
      });
    } catch (e) { /* 通信できなかった分は次回また問い合わせる */ }
  }
  for (const isbn of needNdl) {
    try {
      const info = await fetchNdl(isbn);
      if (info && info.price) prices[isbn] = info.price;
      checked.push(isbn);
    } catch (e) { /* 通信できなかった分は次回また問い合わせる */ }
  }
  return { prices, checked };
}

/* 定価を持っていない登録済みの本に、定価を補う(起動後に裏で1回)。
   見つからなかった本はこの端末に記録し、毎回問い合わせないようにする。
   (v2: 国会図書館を調べ先に加えたので、以前見つからなかった本も調べ直す) */
const PRICE_CHECK_KEY = "my-bookshelf-pricecheck-v2";

let backfilling = false;
let backfillAgain = false;

async function backfillPrices() {
  if (!navigator.onLine) return;
  // 実行中にまた呼ばれたら(連続登録など)、終わってからもう一度だけ回す
  if (backfilling) { backfillAgain = true; return; }
  backfilling = true;
  try {
    await backfillPricesOnce();
  } finally {
    backfilling = false;
    if (backfillAgain) {
      backfillAgain = false;
      backfillPrices();
    }
  }
}

async function backfillPricesOnce() {
  localStorage.removeItem("my-bookshelf-pricecheck");   // 以前の版の記録
  let done = {};
  try { done = JSON.parse(localStorage.getItem(PRICE_CHECK_KEY)) || {}; } catch (e) { /* 初回 */ }
  const targets = state.books
    .filter(b => !b.price && !done[b.isbn] && /^97[89]\d{10}$/.test(b.isbn))
    .map(b => b.isbn);

  // 国会図書館へは1冊ずつ問い合わせるため時間がかかる。途中でアプリを閉じても
  // それまでの分が無駄にならないよう、20冊ごとに保存する
  for (let i = 0; i < targets.length; i += 20) {
    const { prices, checked } = await fetchPrices(targets.slice(i, i + 20));
    let changed = false;
    for (const isbn of checked) {
      done[isbn] = Date.now();
      // 取得中に同期で差し替わっていても、今の本に書き込む
      const cur = state.books.find(b => b.isbn === isbn);
      if (cur && !cur.price && prices[isbn]) {
        cur.price = prices[isbn];
        changed = true;
      }
    }
    localStorage.setItem(PRICE_CHECK_KEY, JSON.stringify(done));
    if (changed) {
      saveState();
      render();
    }
  }
}

async function fetchGoogleBooks(isbn) {
  try {
    const res = await fetchWithTimeout(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const data = await res.json();
    if (!data.totalItems) return null;
    const v = data.items[0].volumeInfo;
    return {
      title: v.title || "",
      author: (v.authors || []).join("、"),
      publisher: v.publisher || "",
      cover: (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail) || "")
        .replace(/^http:/, "https:"),
      totalPages: v.pageCount || null
    };
  } catch (e) { return null; }
}

/* ISBN13 → ISBN10 変換（Amazon書影URL用。978始まりのみ変換可能） */
function isbn13to10(isbn13) {
  if (!/^978\d{10}$/.test(isbn13)) return null;
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * parseInt(core[i], 10);
  const d = (11 - (sum % 11)) % 11;
  return core + (d === 10 ? "X" : String(d));
}

/* 画像URLが実在する(1x1のダミーでない)場合だけtrueを返す */
function checkImageExists(url) {
  return new Promise(resolve => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 6000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 10); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = url;
  });
}

/* 表紙候補URLを順に試して、最初に読み込めたものを返す */
async function resolveCover(isbn, apiCover) {
  const candidates = [];
  if (apiCover) candidates.push(apiCover);
  const isbn10 = isbn13to10(isbn);
  if (isbn10) {
    candidates.push(`https://images-na.ssl-images-amazon.com/images/P/${isbn10}.09.LZZZZZZZ.jpg`);
  }
  candidates.push(`https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=1`);
  candidates.push(`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`);
  for (const url of candidates) {
    if (await checkImageExists(url)) return url;
  }
  return "";
}

/* Open Library — 洋書に強い(キー不要) */
async function fetchOpenLibrary(isbn) {
  try {
    const res = await fetchWithTimeout(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const data = await res.json();
    const v = data[`ISBN:${isbn}`];
    if (!v) return null;
    return {
      title: v.title || "",
      author: (v.authors || []).map(a => a.name).join(", "),
      publisher: (v.publishers || []).map(p => p.name).join(", "),
      cover: (v.cover && (v.cover.large || v.cover.medium)) || "",
      totalPages: v.number_of_pages || null
    };
  } catch (e) { return null; }
}

/* 4つの検索先に同時に問い合わせ(待ち時間は一番遅いものだけで済む)、
   openBD(出版社の情報) → 国会図書館 → Google Books → Open Library(洋書) の優先順で
   項目ごとに組み合わせる。表紙・ページ数・定価など足りない項目は後ろの検索先で補う */
async function fetchBookInfo(isbn, opts = {}) {
  // 雑誌(491コード)は号ごとの書誌データベースが存在しないため手入力登録にする
  if (isMagazineCode(isbn)) return null;
  const others = [fetchNdl(isbn).catch(() => null), fetchGoogleBooks(isbn), fetchOpenLibrary(isbn)];
  const ob = await fetchOpenBd(isbn);
  // openBDで書名と定価がそろっていれば、他の検索先は少し待つだけにする
  // (そろっていなければ、国会図書館などの応答を打ち切りまで待つ)
  const wait = ob && ob.title && ob.price ? 2500 : LOOKUP_TIMEOUT_MS * 2 + 1500;
  const giveUp = new Promise(r => setTimeout(() => r(null), wait));
  const results = [ob, ...await Promise.all(others.map(p => Promise.race([p, giveUp])))];
  const merged = { title: "", author: "", publisher: "", cover: "", totalPages: null, price: null };
  let found = false;
  for (const r of results) {
    if (!r) continue;
    found = true;
    merged.title = merged.title || r.title;
    merged.author = merged.author || r.author;
    merged.publisher = merged.publisher || r.publisher;
    merged.cover = merged.cover || r.cover;
    merged.totalPages = merged.totalPages || r.totalPages;
    merged.price = merged.price || r.price || null;
  }
  if (!found) return null;
  return {
    isbn,
    title: merged.title || "(タイトル不明)",
    author: merged.author,
    publisher: merged.publisher,
    // 表紙画像の確認には時間がかかるため、不要なとき(既に表紙がある本の更新)は省く
    cover: opts.cover === false ? merged.cover : await resolveCover(isbn, merged.cover),
    totalPages: merged.totalPages,
    price: merged.price
  };
}

async function lookupAndConfirm(isbn) {
  const existing = state.books.find(b => b.isbn === isbn);
  if (existing) {
    alert(existing.list === "wish"
      ? "この本は検討中リストに登録済みです。\n詳細画面から蔵書に移せます。"
      : "この本はすでに蔵書に登録されています。");
    openDetail(isbn);
    return;
  }

  const body = document.getElementById("confirmBody");
  body.innerHTML = `<p style="padding:20px 0;color:var(--muted)">検索中… (ISBN: ${isbn})<br>
    <small>出版社の情報・国立国会図書館などを探しています</small></p>`;
  fillLocationSelect(document.getElementById("confirmLocation"));
  pendingGenres = [];
  renderGenreChips(document.getElementById("confirmGenres"), pendingGenres, (next) => { pendingGenres = next; });
  setPendingList(currentList); // 今見ているリストを登録先の初期値に
  showModal("confirmModal");

  let info = await fetchBookInfo(isbn);
  if (!info) {
    info = { isbn, title: "", author: "", publisher: "", cover: "", totalPages: null, notFound: true };
  }
  pendingBook = info;

  const coverHtml = info.cover
    ? `<img src="${escapeHtml(info.cover)}" alt="">`
    : `<div class="no-cover">表紙なし</div>`;

  if (info.notFound) {
    // 書誌データベースに無い本・雑誌: 手入力フォームを表示
    const isMag = isMagazineCode(isbn);
    const notice = isMag
      ? "雑誌は号ごとの情報がデータベースにないため、<br>誌名と号数を入力してください。"
      : "書誌情報が見つかりませんでした。<br>手入力で登録できます。";
    const titlePh = isMag ? "誌名と号数（例: 週刊少年ジャンプ 2026年30号）" : "書名（必須）";
    body.innerHTML = `
      ${coverHtml}
      <div class="confirm-meta" style="flex:1">
        <p style="color:${isMag ? "var(--accent)" : "var(--danger)"};margin-bottom:8px">${notice}</p>
        <input class="edit-field" id="editTitle" placeholder="${titlePh}">
        <input class="edit-field" id="editAuthor" placeholder="著者">
        <input class="edit-field" id="editPublisher" placeholder="出版社">
        <input class="edit-field" id="editPages" type="number" inputmode="numeric" placeholder="総ページ数">
        <input class="edit-field" id="editPrice" type="number" inputmode="numeric" placeholder="定価（税込・円）">
        <p style="margin-top:6px">${codeLabel(isbn)}: ${isbn}</p>
      </div>
    `;
  } else {
    body.innerHTML = `
      ${coverHtml}
      <div class="confirm-meta">
        <h3>${escapeHtml(info.title)}</h3>
        <p>${escapeHtml(info.author)}</p>
        <p>${escapeHtml(info.publisher)}</p>
        <p>ISBN: ${isbn}</p>
        ${info.totalPages ? `<p>${info.totalPages}ページ</p>` : ""}
        ${info.price ? `<p class="confirm-price">定価 ${priceText(info)}</p>` : ""}
        ${priceSourceNote(info.price) ? `<p class="price-note">${priceSourceNote(info.price)}</p>` : ""}
      </div>
    `;
  }
}

function addPendingBook() {
  if (!pendingBook) return;
  const loc = document.getElementById("confirmLocation").value;

  let { title, author, publisher, totalPages, price } = pendingBook;
  // 手入力フォームがある場合(書誌情報が見つからなかった本)はその値を使う
  const titleInput = document.getElementById("editTitle");
  if (titleInput) {
    title = titleInput.value.trim() || `${codeLabel(pendingBook.isbn)} ${pendingBook.isbn}`;
    author = document.getElementById("editAuthor").value.trim();
    publisher = document.getElementById("editPublisher").value.trim();
    const p = parseInt(document.getElementById("editPages").value, 10);
    totalPages = p > 0 ? p : null;
    const yenValue = parseInt(document.getElementById("editPrice").value, 10);
    price = yenValue > 0 ? { total: yenValue, source: "manual" } : null;
  }

  state.books.unshift({
    isbn: pendingBook.isbn,
    title,
    author,
    publisher,
    cover: pendingBook.cover,
    totalPages,
    ...(price ? { price } : {}),
    list: pendingList,
    location: pendingList === "wish" ? "" : loc,
    genres: pendingGenres,
    status: "unread",
    logs: [],
    addedAt: Date.now()
  });
  pendingBook = null;
  saveState();
  hideModal("confirmModal");
  render();
  // 定価が取れなかった本は、裏で国会図書館に問い合わせ直す(応答が遅れていた場合のため)
  if (!price) setTimeout(backfillPrices, 500);
}

/* 登録確認画面の登録先(蔵書/検討中)切り替え */
function setPendingList(list) {
  pendingList = list;
  document.getElementById("destOwned").classList.toggle("active", list === "owned");
  document.getElementById("destWish").classList.toggle("active", list === "wish");
  // 検討中リストには置き場所が不要
  document.getElementById("confirmLocationLabel").style.display = list === "wish" ? "none" : "";
}

/* ============================================================
   本の詳細
   ============================================================ */
let memoTimer = null;       // メモの保存待ち
let memoSavedTimer = null;

function openDetail(isbn) {
  flushMemo();
  detailIsbn = isbn;
  renderDetail();
  showModal("detailModal");
}

/* 書きかけのメモを保存する(入力の手が止まったとき・欄を離れたとき・アプリを閉じるとき) */
function flushMemo() {
  if (!memoTimer) return;
  clearTimeout(memoTimer);
  memoTimer = null;
  saveState();
  render();   // 一覧の📝印を更新する
  const saved = document.getElementById("memoSaved");
  if (!saved) return;
  saved.hidden = false;
  clearTimeout(memoSavedTimer);
  memoSavedTimer = setTimeout(() => { saved.hidden = true; }, 1500);
}

function renderDetail() {
  const b = state.books.find(x => x.isbn === detailIsbn);
  if (!b) { hideModal("detailModal"); return; }
  const body = document.getElementById("detailBody");
  const st = bookStatus(b);
  const progress = progressPercent(b);
  const today = new Date().toISOString().slice(0, 10);

  const coverHtml = b.cover
    ? `<img src="${escapeHtml(b.cover)}" alt="">`
    : `<div class="no-cover">表紙なし</div>`;

  const logsHtml = (b.logs || []).length === 0
    ? `<p class="log-empty">まだ記録がありません</p>`
    : `<ul class="log-list">` +
      b.logs.slice().sort((a, c) => c.date.localeCompare(a.date) || c.page - a.page)
        .map((l, i) => `
          <li>
            <span><strong>${l.page}</strong> ページまで <span class="log-date">${l.date}</span></span>
            <button class="log-del" data-logindex="${b.logs.indexOf(l)}">削除</button>
          </li>`).join("") +
      `</ul>`;

  const isWish = b.list === "wish";

  // 定価。出版社の情報が無い本は、ボタンで取り直すか手入力できる
  const canFetchPrice = /^97[89]\d{10}$/.test(b.isbn);
  const priceNote = priceSourceNote(b.price);
  const priceLineHtml = b.price && b.price.total
    ? `<p class="detail-price">定価 ${priceText(b)}</p>${priceNote ? `<p class="price-note">${priceNote}</p>` : ""}`
    : `<p class="detail-price none">定価 未登録${canFetchPrice ? ` <button class="price-fetch-btn" id="priceFetchBtn">↻ 取得</button>` : ""}</p>`;

  const commonTop = `
    <div class="detail-top">
      ${coverHtml}
      <div class="detail-meta">
        ${isWish ? `<p style="color:var(--accent);font-weight:bold">🛒 検討中の本</p>` : ""}
        <h3>${escapeHtml(b.title)}</h3>
        <p>${escapeHtml(b.author)}</p>
        <p>${escapeHtml(b.publisher)}</p>
        <p>${codeLabel(b.isbn)}: ${b.isbn}</p>
        ${b.totalPages ? `<p>全${b.totalPages}ページ</p>` : ""}
        ${priceLineHtml}
        <button class="edit-info-btn" id="editInfoBtn">✎ 情報を編集</button>
      </div>
    </div>

    <div class="edit-info-form" id="editInfoForm" hidden>
      <input class="edit-field" id="dEditTitle" placeholder="書名（必須）" value="${escapeHtml(b.title)}">
      <input class="edit-field" id="dEditAuthor" placeholder="著者" value="${escapeHtml(b.author)}">
      <input class="edit-field" id="dEditPublisher" placeholder="出版社" value="${escapeHtml(b.publisher)}">
      <input class="edit-field" id="dEditPages" type="number" inputmode="numeric" placeholder="総ページ数" value="${b.totalPages || ""}">
      <input class="edit-field" id="dEditPrice" type="number" inputmode="numeric" placeholder="定価（税込・円）" value="${b.price && b.price.total ? b.price.total : ""}">
      <div class="btn-row" style="margin-top:8px">
        <button class="btn secondary" id="dEditCancel">キャンセル</button>
        <button class="btn primary" id="dEditSave">保存</button>
      </div>
    </div>
  `;

  const memoHtml = `
    <div class="section-title">📝 メモ <span class="memo-hint">入力すると自動で保存されます</span></div>
    <textarea class="memo-input" id="memoInput" rows="3" maxlength="5000"
      placeholder="感想、貸した相手、買ったお店、気になったページなど">${escapeHtml(b.memo || "")}</textarea>
    <p class="memo-saved" id="memoSaved" hidden>✓ 保存しました</p>
  `;

  const genreHtml = `
    <div class="field-label">ジャンル（${MAX_GENRES}つまで選べます）</div>
    <div class="genre-chips" id="detailGenres"></div>
  `;

  const links = shopLinks(b);
  const shopHtml = `
    <div class="section-title">🛍 ネットで探す</div>
    <div class="shop-links">
      <a class="shop-link amazon" href="${escapeHtml(links.amazon)}" target="_blank" rel="noopener">Amazon</a>
      <a class="shop-link yahoo" href="${escapeHtml(links.yahoo)}" target="_blank" rel="noopener">Yahoo!ショッピング</a>
      <a class="shop-link rakuten" href="${escapeHtml(links.rakuten)}" target="_blank" rel="noopener">楽天市場</a>
    </div>
    <p class="shop-note">国内の新品の本は定価で販売されるため、どのお店でも本の値段はほぼ同じです（送料やポイントはお店ごとに異なります）。</p>
  `;

  // Kindle Unlimited: 対象かどうかを自動で判定する公式の手段が無いため、
  // 読み放題対象だけに絞ったAmazon検索を開き、確かめた結果をここに記録する
  const ku = b.ku && b.ku.status;
  const kuHtml = `
    <div class="section-title">📖 Kindle Unlimited</div>
    <a class="ku-search-btn" href="${escapeHtml(kuSearchUrl(b))}" target="_blank" rel="noopener">Kindle Unlimitedの読み放題で探す</a>
    ${canSearchKuByIsbn(b) ? `
    <p class="ku-hint">ISBNで、Amazonの読み放題の対象作品からこの本だけを探します。<br>
      <strong>この本が「Kindle Unlimited」の表示つきで出れば読み放題の対象</strong>です。
      「Kindleストアに…の結果は見つかりませんでした」と出たら対象外です（その下に紙の本が表示されても、読み放題ではありません）。
      まれにKindle版がISBNで見つからない本もあるので、気になるときは
      <a href="${escapeHtml(kuSearchUrl(b, "title"))}" target="_blank" rel="noopener">書名で探す</a>でも確かめてください。</p>` : `
    <p class="ku-hint">書名で、Amazonの読み放題の対象作品から探します。この本が「Kindle Unlimited」の表示つきで出れば対象です。
      「結果は見つかりませんでした」と出たり、別の本しか出なかったりする場合は対象外です。</p>`}
    <p class="ku-hint">確かめた結果を下で記録しておけます（対象作品は毎月入れ替わります）。</p>
    <div class="ku-record">
      <button class="ku-chip yes ${ku === "yes" ? "on" : ""}" data-ku="yes">✓ 読める</button>
      <button class="ku-chip no ${ku === "no" ? "on" : ""}" data-ku="no">読めない</button>
      <span class="ku-date">${ku ? `確認日 ${formatDate(b.ku.at)}` : "未確認"}</span>
    </div>
  `;

  if (isWish) {
    // 検討中の本: 読書記録の代わりに、カート・お店へのリンク・「蔵書に移す」を表示
    body.innerHTML = `
      ${commonTop}
      <button class="btn ${b.inCart ? "secondary" : "primary"} cart-toggle" id="cartToggleBtn">
        ${b.inCart ? "✓ カートに入っています（外す）" : "🛒 カートに入れる"}
      </button>
      ${shopHtml}
      ${kuHtml}
      ${genreHtml}
      ${memoHtml}

      <div class="section-title">📚 購入したら蔵書へ</div>
      <label class="field-label">置き場所を選んでください
        <select id="moveLocation"></select>
      </label>
      <button class="btn primary" id="moveToOwnedBtn" style="width:100%">📚 蔵書に移す</button>

      <div class="btn-row" style="margin-top:20px">
        <button class="btn danger" id="deleteBookBtn">この本を削除</button>
      </div>
    `;
  } else {
    body.innerHTML = `
      ${commonTop}
      <div class="status-toggle">
        <button id="stUnread" class="${b.status !== "done" ? "active" : ""}">未読了</button>
        <button id="stDone" class="${b.status === "done" ? "active" : ""}">読了 ✓</button>
      </div>

      ${progress !== null ? `
        <div class="progress-block">
          <div class="progress-bar"><div style="width:${progress}%"></div></div>
          <span class="progress-text">進捗 ${progress}%（${Math.max(...b.logs.map(l => l.page))} / ${b.totalPages}ページ）</span>
        </div>` : ""}

      <label class="field-label">置き場所
        <select id="detailLocation"></select>
      </label>
      ${genreHtml}
      ${memoHtml}

      <div class="section-title">📖 読書の記録</div>
      <div class="log-form">
        <input type="number" id="logPage" min="1" placeholder="ページ数">
        <input type="date" id="logDate" value="${today}">
        <button id="logAddBtn">記録</button>
      </div>
      ${logsHtml}
      ${shopHtml}
      ${kuHtml}

      <div class="btn-row" style="margin-top:20px">
        <button class="btn secondary" id="moveToWishBtn">🛒 検討中へ移す</button>
        <button class="btn danger" id="deleteBookBtn">この本を削除</button>
      </div>
    `;
  }

  // 書誌情報の編集(書名が取得できなかった本の手直しにも使う)
  body.querySelector("#editInfoBtn").onclick = () => {
    const form = body.querySelector("#editInfoForm");
    form.hidden = !form.hidden;
  };
  body.querySelector("#dEditCancel").onclick = () => {
    body.querySelector("#editInfoForm").hidden = true;
  };
  body.querySelector("#dEditSave").onclick = () => {
    const title = body.querySelector("#dEditTitle").value.trim();
    if (!title) { alert("書名を入力してください。"); return; }
    b.title = title;
    b.author = body.querySelector("#dEditAuthor").value.trim();
    b.publisher = body.querySelector("#dEditPublisher").value.trim();
    const p = parseInt(body.querySelector("#dEditPages").value, 10);
    b.totalPages = p > 0 ? p : null;
    // 定価を書き換えたときだけ手入力の値にする(出版社の情報はそのまま残す)
    const yenValue = parseInt(body.querySelector("#dEditPrice").value, 10);
    if (!(yenValue > 0)) delete b.price;
    else if (!b.price || b.price.total !== yenValue) b.price = { total: yenValue, source: "manual" };
    saveState();
    renderDetail();
    render();
  };

  // 定価を出版社の情報から取り直す
  const priceFetchBtn = body.querySelector("#priceFetchBtn");
  if (priceFetchBtn) {
    priceFetchBtn.onclick = async () => {
      priceFetchBtn.disabled = true;
      priceFetchBtn.textContent = "取得中…";
      const { prices } = await fetchPrices([b.isbn]);
      const cur = state.books.find(x => x.isbn === b.isbn);
      if (cur && prices[b.isbn]) {
        cur.price = prices[b.isbn];
        saveState();
        render();
        renderDetail();
      } else {
        priceFetchBtn.textContent = "見つかりませんでした";
      }
    };
  }

  // Kindle Unlimitedで読めるかの記録(同じボタンをもう一度押すと「未確認」に戻る)
  body.querySelectorAll(".ku-chip").forEach(btn => {
    btn.onclick = () => {
      const cur = state.books.find(x => x.isbn === b.isbn);
      if (!cur) return;
      if (cur.ku && cur.ku.status === btn.dataset.ku) delete cur.ku;
      else cur.ku = { status: btn.dataset.ku, at: Date.now() };
      saveState();
      render();
      renderDetail();
    };
  });

  // ジャンル(最大3つ)
  renderGenreChips(body.querySelector("#detailGenres"), b.genres, (next) => {
    // 同期で本のデータが差し替わっていても、今の本に書き込む
    const cur = state.books.find(x => x.isbn === b.isbn);
    if (!cur) return;
    cur.genres = next;
    saveState();
    render();
  });

  // メモ(入力のたびに本へ書き込み、少し間をおいて保存する)
  const memo = body.querySelector("#memoInput");
  const growMemo = () => {
    memo.style.height = "auto";
    memo.style.height = memo.scrollHeight + "px";
  };
  growMemo();
  memo.addEventListener("input", () => {
    // 同期で本のデータが差し替わっていても、今の本に書き込む
    const cur = state.books.find(x => x.isbn === b.isbn);
    if (!cur) return;
    if (memo.value) cur.memo = memo.value;
    else delete cur.memo;
    growMemo();
    clearTimeout(memoTimer);
    memoTimer = setTimeout(flushMemo, 600);
  });
  memo.addEventListener("blur", flushMemo);

  if (isWish) {
    // カートに入れる・外す
    body.querySelector("#cartToggleBtn").onclick = () => {
      if (b.inCart) delete b.inCart;
      else b.inCart = true;
      saveState();
      renderDetail();
      render();
    };

    // 検討中 → 蔵書へ移動(購入時)
    const msel = body.querySelector("#moveLocation");
    fillLocationSelect(msel);
    body.querySelector("#moveToOwnedBtn").onclick = () => {
      b.list = "owned";
      b.location = msel.value;
      delete b.inCart;
      saveState();
      renderDetail();
      render();
    };
  } else {
    // 置き場所セレクト
    const sel = body.querySelector("#detailLocation");
    fillLocationSelect(sel, b.location);
    sel.onchange = () => { b.location = sel.value; saveState(); render(); };

    // 読了トグル
    body.querySelector("#stUnread").onclick = () => { b.status = "unread"; saveState(); renderDetail(); render(); };
    body.querySelector("#stDone").onclick = () => { b.status = "done"; saveState(); renderDetail(); render(); };

    // ログ追加
    body.querySelector("#logAddBtn").onclick = () => {
      const page = parseInt(body.querySelector("#logPage").value, 10);
      const date = body.querySelector("#logDate").value;
      if (!page || page < 1) { alert("ページ数を入力してください。"); return; }
      if (!date) { alert("日付を選んでください。"); return; }
      b.logs = b.logs || [];
      b.logs.push({ page, date });
      // 最終ページまで読んだら読了を提案
      if (b.totalPages && page >= b.totalPages && b.status !== "done") {
        if (confirm("最後のページまで読みました。読了にしますか？")) b.status = "done";
      }
      saveState();
      renderDetail();
      render();
    };

    // ログ削除
    body.querySelectorAll(".log-del").forEach(btn => {
      btn.onclick = () => {
        b.logs.splice(parseInt(btn.dataset.logindex, 10), 1);
        saveState();
        renderDetail();
        render();
      };
    });

    // 蔵書 → 検討中へ戻す
    body.querySelector("#moveToWishBtn").onclick = () => {
      if (!confirm(`「${b.title}」を検討中リストへ移しますか？`)) return;
      b.list = "wish";
      b.location = "";
      saveState();
      renderDetail();
      render();
    };
  }

  // 本の削除
  body.querySelector("#deleteBookBtn").onclick = () => {
    if (!confirm(`「${b.title}」を削除しますか？`)) return;
    state.books = state.books.filter(x => x.isbn !== b.isbn);
    saveState();
    hideModal("detailModal");
    render();
  };
}

/* ============================================================
   ジャンル
   ============================================================ */
const MAX_GENRES = 3;   // 1冊に付けられるジャンルの数

/* ジャンルを選ぶボタン群。押すたびに選択を切り替え、新しい選択を onChange に渡す */
function renderGenreChips(container, selected, onChange) {
  const change = (next) => {
    onChange(next);
    renderGenreChips(container, next, onChange);
  };
  container.innerHTML = "";
  for (const g of state.genres) {
    const on = selected.includes(g);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "genre-chip" + (on ? " on" : "");
    chip.textContent = (on ? "✓ " : "") + g;
    chip.onclick = () => {
      if (on) change(selected.filter(x => x !== g));
      else if (selected.length >= MAX_GENRES) alert(`ジャンルは1冊につき${MAX_GENRES}つまで選べます。\n別のジャンルを外してから選んでください。`);
      else change([...selected, g]);
    };
    container.appendChild(chip);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "genre-chip add";
  add.textContent = "＋ 新しいジャンル";
  add.onclick = () => {
    const name = (prompt("新しいジャンル名を入力してください") || "").trim();
    if (!name) return;
    if (!state.genres.includes(name)) {
      state.genres.push(name);
      saveState();
      render();
    }
    // 作ったジャンルは、枠が空いていればそのまま選んだ状態にする
    if (!selected.includes(name) && selected.length < MAX_GENRES) change([...selected, name]);
    else renderGenreChips(container, selected, onChange);
  };
  container.appendChild(add);
}

/* ============================================================
   登録済みの本の情報をまとめて更新
   (以前の版で登録して書名が分からなかった本や、欠けている項目を調べ直す)
   ============================================================ */
const PLACEHOLDER_TITLE = /^(ISBN|雑誌コード) \d+$/;   // 書名が分からず仮の名前で登録した本
let refreshRun = null;   // 実行中・直前の更新の進み具合

function missingInfo(b) {
  return {
    title: PLACEHOLDER_TITLE.test(b.title),
    cover: !b.cover,
    price: !(b.price && b.price.total),
    other: !b.author || !b.publisher || !b.totalPages
  };
}

/* 調べ直す対象(ISBNの本で、どこかに空欄がある本。雑誌は書誌データが無いので除く) */
function refreshTargets() {
  return state.books.filter(b => {
    if (!/^97[89]\d{10}$/.test(b.isbn)) return false;
    const m = missingInfo(b);
    return m.title || m.cover || m.price || m.other;
  });
}

function openRefresh() {
  kuCheckIsbns = null;   // 開くたびに、今の未確認の本を集め直す
  renderRefreshModal();
  showModal("refreshModal");
}

function renderRefreshModal() {
  const targets = refreshTargets();
  const count = (key) => targets.filter(b => missingInfo(b)[key]).length;
  const running = refreshRun && refreshRun.running;
  document.getElementById("refreshCount").textContent = targets.length
    ? `調べ直す本: ${targets.length}冊（書名が分からない本 ${count("title")}冊・表紙なし ${count("cover")}冊・定価なし ${count("price")}冊・著者などが欠けている本 ${count("other")}冊）`
    : "欠けている情報のある本はありません。";
  const runBtn = document.getElementById("refreshRunBtn");
  runBtn.disabled = running || !targets.length;
  runBtn.textContent = running ? "更新中…" : "まとめて更新する";
  document.getElementById("refreshProgress").hidden = !running;
  updateRefreshProgress();
  renderRefreshResult();
  renderKuChecklist();
}

function updateRefreshProgress() {
  if (!refreshRun) return;
  const pct = refreshRun.total ? Math.round(refreshRun.done / refreshRun.total * 100) : 100;
  document.getElementById("refreshBar").style.width = pct + "%";
  document.getElementById("refreshProgressText").textContent =
    `${refreshRun.done} / ${refreshRun.total} 冊を確認しました（国立国会図書館などに問い合わせ中）`;
}

function renderRefreshResult() {
  const box = document.getElementById("refreshResult");
  if (!refreshRun || refreshRun.running) { box.hidden = true; return; }
  const f = refreshRun.filled;
  const parts = [["書名", f.title], ["著者", f.author], ["出版社", f.publisher], ["表紙", f.cover], ["ページ数", f.pages], ["定価", f.price]]
    .filter(([, n]) => n).map(([label, n]) => `${label} ${n}冊`);
  const untitled = state.books.filter(b => PLACEHOLDER_TITLE.test(b.title));
  const unknownBooks = untitled.filter(b => !isMagazineCode(b.isbn)).length;
  const unknownMags = untitled.length - unknownBooks;
  box.hidden = false;
  box.innerHTML = `
    <p><strong>更新が終わりました。</strong>${parts.length ? `埋まった項目: ${parts.join("・")}` : "新しく分かった情報はありませんでした。"}</p>
    ${unknownBooks ? `<p class="refresh-unknown">まだ書名が分からない本が${unknownBooks}冊あります。どのデータベースにも登録されていないため、本の詳細の「✎ 情報を編集」から書名を入力してください。</p>` : ""}
    ${unknownMags ? `<p class="refresh-unknown">誌名が未入力の雑誌が${unknownMags}冊あります。雑誌は誌名を自動で調べられないため、「✎ 情報を編集」から入力してください。</p>` : ""}
  `;
}

async function runRefresh() {
  if (refreshRun && refreshRun.running) return;
  const targets = refreshTargets().map(b => b.isbn);
  refreshRun = {
    running: true, done: 0, total: targets.length,
    filled: { title: 0, author: 0, publisher: 0, cover: 0, pages: 0, price: 0 }
  };
  renderRefreshModal();

  // 3冊ずつ同時に調べる。途中で閉じても無駄にならないよう、5冊ごとに保存する
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const isbn = targets[next++];
      try { await refreshOne(isbn); } catch (e) { /* 1冊の失敗で止めない */ }
      refreshRun.done++;
      if (refreshRun.done % 5 === 0) { saveState(); render(); }
      updateRefreshProgress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  refreshRun.running = false;
  saveState();
  render();
  if (!document.getElementById("refreshModal").hidden) renderRefreshModal();
}

/* 1冊を調べ直し、空欄だけを埋める(手で入力した書名・定価などは書き換えない) */
async function refreshOne(isbn) {
  const before = state.books.find(b => b.isbn === isbn);
  if (!before) return;
  const info = await fetchBookInfo(isbn, { cover: !before.cover });
  // 調べている間に同期などで差し替わっていても、今の本に書き込む
  const cur = state.books.find(b => b.isbn === isbn);
  if (!info || !cur) return;
  const f = refreshRun.filled;
  if (PLACEHOLDER_TITLE.test(cur.title) && info.title && info.title !== "(タイトル不明)") { cur.title = info.title; f.title++; }
  if (!cur.author && info.author) { cur.author = info.author; f.author++; }
  if (!cur.publisher && info.publisher) { cur.publisher = info.publisher; f.publisher++; }
  if (!cur.cover && info.cover) { cur.cover = info.cover; f.cover++; }
  if (!cur.totalPages && info.totalPages) { cur.totalPages = info.totalPages; f.pages++; }
  if (!(cur.price && cur.price.total) && info.price) { cur.price = info.price; f.price++; }
}

/* ---------- Kindle Unlimited の確認一覧 ---------- */
let kuCheckIsbns = null;   // 一覧を開いた時点の未確認の本(記録しても行が消えて並びがずれないように固定する)

function renderKuChecklist() {
  const list = document.getElementById("kuCheckList");
  if (!kuCheckIsbns) {
    // 検討中の本(買う前にKUで読めるか知りたい本)を先に並べる
    kuCheckIsbns = state.books.filter(b => !b.ku)
      .sort((a, b) => (a.list === "wish" ? 0 : 1) - (b.list === "wish" ? 0 : 1))
      .map(b => b.isbn);
  }
  const books = kuCheckIsbns.map(isbn => state.books.find(b => b.isbn === isbn)).filter(Boolean);
  const remaining = books.filter(b => !b.ku).length;
  document.getElementById("kuCount").textContent = books.length
    ? `未確認: ${remaining}冊（この一覧の${books.length}冊中）`
    : "すべての本を確認済みです。";
  list.innerHTML = books.map(b => {
    const st = b.ku && b.ku.status;
    return `
      <li class="ku-check-item ${st ? "done" : ""}" data-isbn="${b.isbn}">
        <div class="ku-check-title">${b.list === "wish" ? `<span class="ku-check-wish">検討中</span>` : ""}${escapeHtml(b.title)}
          ${canSearchKuByIsbn(b) ? `<a class="ku-check-bytitle" href="${escapeHtml(kuSearchUrl(b, "title"))}" target="_blank" rel="noopener">書名で探す</a>` : ""}</div>
        <div class="ku-check-actions">
          <a class="ku-check-search" href="${escapeHtml(kuSearchUrl(b))}" target="_blank" rel="noopener">探す</a>
          <button class="ku-chip yes ${st === "yes" ? "on" : ""}" data-ku="yes">✓ 読める</button>
          <button class="ku-chip no ${st === "no" ? "on" : ""}" data-ku="no">読めない</button>
        </div>
      </li>`;
  }).join("");
  list.querySelectorAll(".ku-check-item").forEach(li => {
    li.querySelectorAll(".ku-chip").forEach(btn => {
      btn.onclick = () => {
        const cur = state.books.find(b => b.isbn === li.dataset.isbn);
        if (!cur) return;
        if (cur.ku && cur.ku.status === btn.dataset.ku) delete cur.ku;
        else cur.ku = { status: btn.dataset.ku, at: Date.now() };
        saveState();
        render();
        renderKuChecklist();
      };
    });
  });
}

/* ---------- Kindle Unlimited ---------- */
/* Amazonの「Kindleストア」で「読み放題対象タイトル」だけに絞った検索。
   (Amazonの検索画面の絞り込みと同じ条件) */
const KU_FILTER = "n:2250738051,p_n_feature_nineteen_browse-bin:3169286051";

/* ISBNで探すと、Amazonが紙の本と結び付けているKindle版だけがぴったり出る
   (対象外なら「結果は見つかりませんでした」と出る)。書名で探すと似た本が大量に出るため、
   ISBNのある本はISBNで探し、書名での検索は念のための確認用に残す */
function kuSearchUrl(b, by = "isbn") {
  const key = by === "isbn" && /^97[89]\d{10}$/.test(b.isbn) ? b.isbn : b.title;
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent(key)}&i=digital-text&rh=${encodeURIComponent(KU_FILTER)}`;
}

function canSearchKuByIsbn(b) {
  return /^97[89]\d{10}$/.test(b.isbn);
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------- ネットショップへのリンク ---------- */
function shopLinks(b) {
  const code = b.isbn;
  const isbn10 = isbn13to10(code);
  // 雑誌はAmazonではコード検索が当たりにくいため誌名で探す
  const amazonQuery = isMagazineCode(code) ? b.title : code;
  return {
    amazon: isbn10 && !isMagazineCode(code)
      ? `https://www.amazon.co.jp/dp/${isbn10}`
      : `https://www.amazon.co.jp/s?k=${encodeURIComponent(amazonQuery)}`,
    yahoo: `https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(code)}`,
    rakuten: `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(code)}/`
  };
}

function renderGenreList() {
  const ul = document.getElementById("genreList");
  ul.innerHTML = "";
  if (state.genres.length === 0) {
    ul.innerHTML = `<li style="color:var(--muted);font-size:.82rem">まだジャンルがありません</li>`;
  }
  state.genres.forEach((g, i) => {
    const count = state.books.filter(b => b.genres.includes(g)).length;
    const li = document.createElement("li");
    li.innerHTML = `<span class="loc-name">${escapeHtml(g)} <small style="color:var(--muted)">(${count}冊)</small></span>`;
    const actions = document.createElement("div");
    actions.className = "loc-actions";

    const up = makeActBtn("↑", i === 0);
    up.onclick = () => { moveItem(state.genres, i, -1); saveState(); renderGenreList(); render(); };
    const down = makeActBtn("↓", i === state.genres.length - 1);
    down.onclick = () => { moveItem(state.genres, i, 1); saveState(); renderGenreList(); render(); };

    const ren = makeActBtn("変更");
    ren.onclick = () => {
      const name = (prompt("新しいジャンル名を入力してください", g) || "").trim();
      if (!name || name === g) return;
      if (state.genres.includes(name)) { alert("同じ名前のジャンルがあります。"); return; }
      state.genres[i] = name;
      state.books.forEach(b => { b.genres = b.genres.map(x => x === g ? name : x); });
      if (currentGenre === g) currentGenre = name;
      saveState();
      renderGenreList();
      render();
    };

    const del = document.createElement("button");
    del.className = "loc-del";
    del.textContent = "削除";
    del.onclick = () => {
      const msg = count > 0
        ? `ジャンル「${g}」を削除しますか？\n(${count}冊の本からこのジャンルが外れます。本は削除されません)`
        : `ジャンル「${g}」を削除しますか？`;
      if (!confirm(msg)) return;
      state.genres = state.genres.filter(x => x !== g);
      state.books.forEach(b => { b.genres = b.genres.filter(x => x !== g); });
      if (currentGenre === g) currentGenre = "all";
      saveState();
      renderGenreList();
      render();
    };

    actions.append(up, down, ren, del);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

/* 管理リスト用の小ボタン */
function makeActBtn(label, disabled) {
  const btn = document.createElement("button");
  btn.className = "loc-act-btn";
  btn.textContent = label;
  btn.disabled = !!disabled;
  return btn;
}

/* 配列のi番目をdir(-1/+1)方向へ移動 */
function moveItem(arr, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

/* ============================================================
   置き場所の管理
   ============================================================ */
function fillLocationSelect(sel, selected) {
  sel.innerHTML = "";
  for (const l of state.locations) {
    const opt = document.createElement("option");
    opt.value = l;
    opt.textContent = l;
    if (l === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderLocList() {
  const ul = document.getElementById("locList");
  ul.innerHTML = "";
  state.locations.forEach((l, i) => {
    const count = state.books.filter(b => b.location === l).length;
    const li = document.createElement("li");
    li.innerHTML = `<span class="loc-name">${escapeHtml(l)} <small style="color:var(--muted)">(${count}冊)</small></span>`;
    const actions = document.createElement("div");
    actions.className = "loc-actions";

    const up = makeActBtn("↑", i === 0);
    up.onclick = () => { moveItem(state.locations, i, -1); saveState(); renderLocList(); render(); };
    const down = makeActBtn("↓", i === state.locations.length - 1);
    down.onclick = () => { moveItem(state.locations, i, 1); saveState(); renderLocList(); render(); };

    const ren = makeActBtn("変更");
    ren.onclick = () => {
      const name = (prompt("新しい名前を入力してください", l) || "").trim();
      if (!name || name === l) return;
      if (state.locations.includes(name)) { alert("同じ名前の置き場所があります。"); return; }
      state.locations[i] = name;
      state.books.forEach(b => { if (b.location === l) b.location = name; });
      if (currentLocation === l) currentLocation = name;
      saveState();
      renderLocList();
      render();
    };

    const del = document.createElement("button");
    del.className = "loc-del";
    del.textContent = "削除";
    del.onclick = () => {
      if (count > 0) {
        alert(`「${l}」には${count}冊の本があります。先に本を移動または削除してください。`);
        return;
      }
      if (state.locations.length <= 1) {
        alert("置き場所は最低1つ必要です。");
        return;
      }
      if (!confirm(`置き場所「${l}」を削除しますか？`)) return;
      state.locations = state.locations.filter(x => x !== l);
      if (currentLocation === l) currentLocation = "all";
      saveState();
      renderLocList();
      render();
    };

    actions.append(up, down, ren, del);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

/* ============================================================
   データの引き継ぎ(エクスポート/インポート)
   ============================================================ */
function buildExportJson() {
  return JSON.stringify({
    app: "my-bookshelf",
    formatVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data: state
  }, null, 2);
}

/* ストア版アプリ(Capacitor)で動いているか。
   WebViewはWeb Share APIやダウンロードに対応しないため処理を分ける */
function nativePlugins() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
  const p = cap.Plugins || {};
  return p.Filesystem && p.Share ? p : null;
}

async function exportData() {
  const json = buildExportJson();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `bookshelf-${stamp}.json`;

  // ストア版アプリ: 一時ファイルに書き出してOSの共有シートへ渡す
  const native = nativePlugins();
  if (native) {
    try {
      const written = await native.Filesystem.writeFile({
        path: filename,
        data: json,
        directory: "CACHE",
        encoding: "utf8"
      });
      await native.Share.share({ title: "マイ本棚のデータ", files: [written.uri] });
    } catch (e) {
      const msg = (e && e.message) || "";
      if (!/cancel|abort/i.test(msg)) alert("書き出しに失敗しました。\n" + msg);
    }
    return;
  }

  const file = new File([json], filename, { type: "application/json" });

  // iPhoneなどでは共有シート(AirDrop/LINE/メール等)を優先
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "マイ本棚のデータ" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return; // ユーザーがキャンセル
      /* 共有に失敗したらダウンロードへフォールバック */
    }
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* インポートデータの検証。正しければstate形式のオブジェクトを返す */
function parseImportJson(text) {
  const parsed = JSON.parse(text);
  const d = parsed && parsed.app === "my-bookshelf" ? parsed.data : parsed;
  if (!d || !Array.isArray(d.books) || !Array.isArray(d.locations)) {
    throw new Error("形式が違います");
  }
  if (!Array.isArray(d.genres)) d.genres = [];
  d.books.forEach(normalizeBook);
  return d;
}

/* mode: "merge"(統合・重複スキップ) / "replace"(全置き換え) */
function applyImport(imported, mode) {
  if (mode === "replace") {
    state = { ...imported, manualOrder: true };
  } else {
    const existingIsbn = new Set(state.books.map(b => b.isbn));
    const newBooks = imported.books.filter(b => !existingIsbn.has(b.isbn));
    state.books = state.books.concat(newBooks);
    for (const l of imported.locations) {
      if (!state.locations.includes(l)) state.locations.push(l);
    }
    for (const g of imported.genres) {
      if (!state.genres.includes(g)) state.genres.push(g);
    }
  }
  saveState();
  render();
}

function importDataFromText(text) {
  let imported;
  try {
    imported = parseImportJson(text);
  } catch (e) {
    alert("読み込めませんでした。マイ本棚で書き出したファイルを選んでください。");
    return;
  }
  const merge = confirm(
    `${imported.books.length}冊のデータを読み込みました。\n\n` +
    `OK: 今のデータに統合する(同じ本はスキップ)\n` +
    `キャンセル: 今のデータをすべて置き換える`
  );
  if (!merge) {
    if (!confirm("この端末の現在のデータを消して、読み込んだ内容に置き換えます。\n本当によろしいですか？")) return;
    applyImport(imported, "replace");
    alert("置き換えが完了しました。");
  } else {
    const before = state.books.length;
    applyImport(imported, "merge");
    alert(`統合が完了しました。(${state.books.length - before}冊を追加)`);
  }
}

/* ============================================================
   モーダル・ユーティリティ
   ============================================================ */
function showModal(id) { document.getElementById(id).hidden = false; }
function hideModal(id) {
  document.getElementById(id).hidden = true;
  if (id === "scanModal") stopScanner();
  if (id === "detailModal") flushMemo();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ISBN10 → ISBN13 変換（手入力対応）。雑誌の491コードもそのまま受け付ける */
function normalizeIsbn(input) {
  const s = compactCode(input);
  if (/^97[89]\d{10}$/.test(s)) return s;
  if (/^491\d{10}$/.test(s)) return s;
  if (/^\d{9}[\dXx]$/.test(s)) {
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * parseInt(core[i], 10);
    return core + ((10 - (sum % 10)) % 10);
  }
  return null;
}

/* 全角数字・ハイフン・空白を取り除いた番号 */
function compactCode(input) {
  return String(input).normalize("NFKC").replace(/[-\s]/g, "");
}

/* 入力された番号の最後の1桁(チェック数字)が合っているか。打ち間違いを見つけるために使う
   (13桁は1・3を交互に掛ける方式、旧10桁のISBNは10〜1を掛けて11で割り切れるか) */
function hasValidCheckDigit(input) {
  const s = compactCode(input).toUpperCase();
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === Number(s[12]);
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : Number(s[i])) * (10 - i);
    return sum % 11 === 0;
  }
  return false;
}

/* ============================================================
   イベント登録・初期化
   ============================================================ */
document.getElementById("scanFab").onclick = openScanner;
document.getElementById("cartFab").onclick = openCart;
document.getElementById("refreshBtn").onclick = openRefresh;
document.getElementById("refreshRunBtn").onclick = runRefresh;
document.getElementById("kuFilterBtn").onclick = () => {
  kuOnly = !kuOnly;
  document.getElementById("kuFilterBtn").classList.toggle("active", kuOnly);
  render();
};
document.getElementById("confirmAddBtn").onclick = addPendingBook;
document.getElementById("manageLocBtn").onclick = () => { renderLocList(); renderGenreList(); showModal("locModal"); };

document.getElementById("addLocBtn").onclick = () => {
  const input = document.getElementById("newLocName");
  const name = input.value.trim();
  if (!name) return;
  if (state.locations.includes(name)) { alert("同じ名前の置き場所があります。"); return; }
  state.locations.push(name);
  input.value = "";
  saveState();
  renderLocList();
  render();
};

document.getElementById("addGenreBtn").onclick = () => {
  const input = document.getElementById("newGenreName");
  const name = input.value.trim();
  if (!name) return;
  if (state.genres.includes(name)) { alert("同じ名前のジャンルがあります。"); return; }
  state.genres.push(name);
  input.value = "";
  saveState();
  renderGenreList();
  render();
};

// アプリの共有(リンク送信・QRコード表示)
const APP_URL = "https://kuru77.github.io/bookshelf_app/";
document.getElementById("shareAppBtn").onclick = async () => {
  const data = { title: "マイ本棚", text: "本のバーコードを読み取るだけで蔵書管理できる無料アプリ", url: APP_URL };
  const native = nativePlugins();
  if (native) {
    try { await native.Share.share(data); } catch (e) { /* キャンセルは無視 */ }
    return;
  }
  if (navigator.share) {
    try { await navigator.share(data); } catch (e) { /* キャンセルは無視 */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(APP_URL);
    alert("リンクをコピーしました:\n" + APP_URL);
  } catch (e) {
    prompt("このURLを共有してください", APP_URL);
  }
};
document.getElementById("qrBtn").onclick = () => {
  const area = document.getElementById("qrArea");
  if (!area.hidden) { area.hidden = true; return; }
  area.innerHTML = "";
  try {
    const writer = new ZXing.BrowserQRCodeSvgWriter();
    const svg = writer.write(APP_URL, 200, 200);
    area.appendChild(svg);
    const p = document.createElement("p");
    p.textContent = "友達にこのQRコードを読み取ってもらうとアプリが開きます";
    area.appendChild(p);
    area.hidden = false;
  } catch (e) {
    alert("QRコードを生成できませんでした。リンク共有をご利用ください。");
  }
};

// データの引き継ぎ
document.getElementById("exportBtn").onclick = exportData;
document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // 同じファイルを再選択できるようにリセット
  if (!file) return;
  importDataFromText(await file.text());
  renderLocList();
  renderGenreList();
};

// 蔵書 / 検討中リストの切り替え
document.getElementById("listTabOwned").onclick = () => { currentList = "owned"; render(); };
document.getElementById("listTabWish").onclick = () => { currentList = "wish"; render(); };

// 登録確認画面の登録先切り替え
document.getElementById("destOwned").onclick = () => setPendingList("owned");
document.getElementById("destWish").onclick = () => setPendingList("wish");

// フリーワード検索(書名・著者)
document.getElementById("searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim();
  render();
});

// ジャンル絞り込み
document.getElementById("genreFilter").onchange = (e) => {
  currentGenre = e.target.value;
  render();
};

// 登録確認画面のジャンルで「＋新規」を選んだ場合
// 連続登録モードの切替(ONのとき登録先の置き場所を表示。検討中リストでは不要)
document.getElementById("contMode").onchange = (e) => {
  document.getElementById("contLocation").hidden = !e.target.checked || currentList === "wish";
};

/* ISBN手入力での登録。連続登録モードがONなら画面を閉じずに
   次のコードを続けて入力できる(カメラが使えない場所での一括登録用) */
async function submitManualIsbn() {
  const input = document.getElementById("manualIsbn");
  const isbn = normalizeIsbn(input.value);
  if (!isbn) {
    alert("コードの形式が正しくありません。\n(本: 978から始まる13桁または10桁 / 雑誌: 491から始まる13桁)");
    return;
  }
  if (!hasValidCheckDigit(input.value) && !confirm(
    "この番号は、どこかの数字が違っている可能性があります。\n" +
    "（最後の1桁は打ち間違いを見つけるための数字で、それが合いません）\n\n" +
    "本の裏表紙の番号をもう一度確認してください。このまま検索しますか？")) {
    input.focus();
    return;
  }
  const continuous = document.getElementById("contMode").checked;
  input.value = "";
  if (continuous) {
    // 同じコードを続けて入れ直せるよう、直前コードの抑止を解除しておく
    lastScannedIsbn = null;
    scanCooldownUntil = 0;
    await onScanned(isbn);
    input.focus();
    return;
  }
  stopScanner();
  hideModal("scanModal");
  await lookupAndConfirm(isbn);
}

document.getElementById("manualAddBtn").onclick = submitManualIsbn;
// Enterキーでも登録できるようにする(連続入力を速く)
document.getElementById("manualIsbn").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitManualIsbn(); }
});

// フィルタボタン
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".filter-btn").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render();
  };
});

// アプリを閉じる・切り替える直前に、書きかけのメモを保存する
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushMemo();
});

// 長押し時にOSのメニュー(画像保存・右クリック)が出ないようにする
document.getElementById("bookGrid").addEventListener("contextmenu", e => e.preventDefault());

// モーダルの閉じるボタン・背景クリック
document.querySelectorAll("[data-close]").forEach(btn => {
  btn.onclick = () => hideModal(btn.dataset.close);
});
document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", e => { if (e.target === m) hideModal(m.id); });
});

/* 端末間同期(sync.js)との窓口 */
window.bookshelf = {
  getState: () => state,
  // 受け取った変更を保存して画面に反映する(自分の編集としては扱わない)
  commitRemoteChanges() {
    // 古い版のアプリが送った本(ジャンルが1つの形式など)も今の形式にそろえる
    state.books.forEach(normalizeBook);
    saveStateFromSync();
    refreshAfterSync();
  },
  // 別アカウントの本棚を引き継がない場合に、この端末の本棚を空にする
  resetLocal() {
    state = emptyState();
    saveStateFromSync();
    render();
  },
  // 並べ替えの最中は、受け取った変更の反映を待たせる
  isBusy: () => !!dragCtx
};

function refreshAfterSync() {
  render();
  if (!document.getElementById("cartModal").hidden) renderCartModal();
  if (!document.getElementById("refreshModal").hidden) renderRefreshModal();
  const modal = document.getElementById("detailModal");
  if (modal.hidden) return;
  // ページ数などを入力している最中は、書きかけが消えないよう詳細画面を描き直さない
  const el = document.activeElement;
  const typing = el && modal.contains(el) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  if (!typing) renderDetail();
}

render();
// 起動直後の同期の受信を待ってから、定価のない本に定価を補う
setTimeout(backfillPrices, 3000);
