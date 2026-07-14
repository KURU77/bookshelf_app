/* ============================================================
   マイ本棚 — バーコード蔵書管理アプリ
   - バーコード(ISBN)スキャン → openBD / Google Books で書誌取得
   - 置き場所ごとの一覧・表紙グリッド・読了管理・読書ログ
   - データは localStorage に保存
   ============================================================ */

const STORAGE_KEY = "my-bookshelf-v1";
const DEFAULT_LOCATIONS = ["一人暮らし先", "実家", "祖父母宅", "研究室"];

let state = loadState();
let currentLocation = "all";   // "all" または置き場所名
let currentFilter = "all";     // all / unread / reading / done
let currentGenre = "all";      // "all" / "none"(未分類) / ジャンル名
let searchQuery = "";          // フリーワード検索(書名・著者)
let pendingBook = null;        // 登録確認中の本
let detailIsbn = null;         // 詳細表示中の本のISBN

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
        return data;
      }
    }
  } catch (e) { /* 壊れたデータは初期化 */ }
  return { books: [], locations: [...DEFAULT_LOCATIONS], genres: [], manualOrder: true };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ============================================================
   画面描画
   ============================================================ */
function render() {
  renderTabs();
  renderGenreFilter();
  renderGrid();
  renderHeaderStats();
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
  const total = state.books.length;
  const done = state.books.filter(b => b.status === "done").length;
  const stats = total ? `${total}冊 / 読了${done}冊 ` : "";
  document.getElementById("headerStats").innerHTML =
    `${stats}<span style="opacity:.55;font-size:.7rem">v${APP_VERSION}</span>`;
}

function renderTabs() {
  const nav = document.getElementById("locationTabs");
  nav.innerHTML = "";
  const tabs = [{ key: "all", label: "すべて" }]
    .concat(state.locations.map(l => ({ key: l, label: l })));

  for (const t of tabs) {
    const count = t.key === "all"
      ? state.books.length
      : state.books.filter(b => b.location === t.key).length;
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
    if (currentLocation !== "all" && b.location !== currentLocation) return false;
    if (currentFilter !== "all" && bookStatus(b) !== currentFilter) return false;
    if (currentGenre === "none") { if (b.genre) return false; }
    else if (currentGenre !== "all" && b.genre !== currentGenre) return false;
    if (q && !`${b.title} ${b.author}`.toLowerCase().includes(q)) return false;
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

    card.innerHTML = `
      ${coverHtml}
      <span class="status-badge ${st}">${STATUS_LABEL[st]}</span>
      ${progressHtml}
      <div class="book-title">${escapeHtml(b.title)}</div>
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
const APP_VERSION = "1.6";
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
  setScanHint("本の裏表紙の 978 で始まるバーコードを枠に合わせてください");
  scanning = true;
  scanCooldownUntil = 0;
  lastScannedIsbn = null;
  const contSel = document.getElementById("contLocation");
  fillLocationSelect(contSel, contSel.value || undefined);
  contSel.hidden = !document.getElementById("contMode").checked;
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
        if (isIsbnCode(c.rawValue)) { onScanned(c.rawValue); break; }
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
      if (text && isIsbnCode(text)) {
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

/* 書籍のISBNバーコード(978/979始まり)だけを受け付ける。
   日本の本の下段バーコード(192...)や他の商品コードは無視する */
function isIsbnCode(text) {
  return /^97[89]\d{10}$/.test(text);
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
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
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

  if (state.books.some(b => b.isbn === isbn)) {
    showScanToast("すでに登録されている本です", true);
    return;
  }
  showScanToast(`検索中… (${isbn})`);
  let info = await fetchBookInfo(isbn);
  if (!info) {
    info = { isbn, title: `ISBN ${isbn}`, author: "", publisher: "", cover: "", totalPages: null };
  }
  if (state.books.some(b => b.isbn === isbn)) return; // 取得中の二重登録防止
  state.books.unshift({
    isbn: info.isbn,
    title: info.title,
    author: info.author,
    publisher: info.publisher,
    cover: info.cover,
    totalPages: info.totalPages,
    location: document.getElementById("contLocation").value,
    genre: "",
    status: "unread",
    logs: [],
    addedAt: Date.now()
  });
  saveState();
  render();
  showScanToast(`「${info.title}」を登録しました`);
}

/* ============================================================
   書誌情報の取得 (openBD → Google Books)
   ============================================================ */
async function fetchOpenBd(isbn) {
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
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
      totalPages
    };
  } catch (e) { return null; }
}

async function fetchGoogleBooks(isbn) {
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
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
    const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
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

/* openBD(日本の書籍) → Google Books → Open Library(洋書) の順に検索し、
   表紙・ページ数など足りない項目を後続のソースで補完する */
async function fetchBookInfo(isbn) {
  const fetchers = [fetchOpenBd, fetchGoogleBooks, fetchOpenLibrary];
  const merged = { title: "", author: "", publisher: "", cover: "", totalPages: null };
  let found = false;
  for (const f of fetchers) {
    if (found && merged.title && merged.cover && merged.totalPages) break;
    const r = await f(isbn);
    if (!r) continue;
    found = true;
    merged.title = merged.title || r.title;
    merged.author = merged.author || r.author;
    merged.publisher = merged.publisher || r.publisher;
    merged.cover = merged.cover || r.cover;
    merged.totalPages = merged.totalPages || r.totalPages;
  }
  if (!found) return null;
  return {
    isbn,
    title: merged.title || "(タイトル不明)",
    author: merged.author,
    publisher: merged.publisher,
    cover: await resolveCover(isbn, merged.cover),
    totalPages: merged.totalPages
  };
}

async function lookupAndConfirm(isbn) {
  if (state.books.some(b => b.isbn === isbn)) {
    alert("この本はすでに登録されています。");
    openDetail(isbn);
    return;
  }

  const body = document.getElementById("confirmBody");
  body.innerHTML = `<p style="padding:20px 0;color:var(--muted)">検索中… (ISBN: ${isbn})</p>`;
  fillLocationSelect(document.getElementById("confirmLocation"));
  fillGenreSelect(document.getElementById("confirmGenre"), "");
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
    // 書誌データベースに無い本: 手入力フォームを表示
    body.innerHTML = `
      ${coverHtml}
      <div class="confirm-meta" style="flex:1">
        <p style="color:var(--danger);margin-bottom:8px">書誌情報が見つかりませんでした。<br>手入力で登録できます。</p>
        <input class="edit-field" id="editTitle" placeholder="書名（必須）">
        <input class="edit-field" id="editAuthor" placeholder="著者">
        <input class="edit-field" id="editPublisher" placeholder="出版社">
        <input class="edit-field" id="editPages" type="number" inputmode="numeric" placeholder="総ページ数">
        <p style="margin-top:6px">ISBN: ${isbn}</p>
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
      </div>
    `;
  }
}

function addPendingBook() {
  if (!pendingBook) return;
  const loc = document.getElementById("confirmLocation").value;
  const genreVal = document.getElementById("confirmGenre").value;

  let { title, author, publisher, totalPages } = pendingBook;
  // 手入力フォームがある場合(書誌情報が見つからなかった本)はその値を使う
  const titleInput = document.getElementById("editTitle");
  if (titleInput) {
    title = titleInput.value.trim() || `ISBN ${pendingBook.isbn}`;
    author = document.getElementById("editAuthor").value.trim();
    publisher = document.getElementById("editPublisher").value.trim();
    const p = parseInt(document.getElementById("editPages").value, 10);
    totalPages = p > 0 ? p : null;
  }

  state.books.unshift({
    isbn: pendingBook.isbn,
    title,
    author,
    publisher,
    cover: pendingBook.cover,
    totalPages,
    location: loc,
    genre: genreVal === "__new" ? "" : genreVal,
    status: "unread",
    logs: [],
    addedAt: Date.now()
  });
  pendingBook = null;
  saveState();
  hideModal("confirmModal");
  render();
}

/* ============================================================
   本の詳細
   ============================================================ */
function openDetail(isbn) {
  detailIsbn = isbn;
  renderDetail();
  showModal("detailModal");
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

  body.innerHTML = `
    <div class="detail-top">
      ${coverHtml}
      <div class="detail-meta">
        <h3>${escapeHtml(b.title)}</h3>
        <p>${escapeHtml(b.author)}</p>
        <p>${escapeHtml(b.publisher)}</p>
        <p>ISBN: ${b.isbn}</p>
        ${b.totalPages ? `<p>全${b.totalPages}ページ</p>` : ""}
      </div>
    </div>

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
    <label class="field-label">ジャンル
      <select id="detailGenre"></select>
    </label>

    <div class="section-title">📖 読書の記録</div>
    <div class="log-form">
      <input type="number" id="logPage" min="1" placeholder="ページ数">
      <input type="date" id="logDate" value="${today}">
      <button id="logAddBtn">記録</button>
    </div>
    ${logsHtml}

    <div class="btn-row" style="margin-top:20px">
      <button class="btn danger" id="deleteBookBtn">この本を削除</button>
    </div>
  `;

  // 置き場所セレクト
  const sel = body.querySelector("#detailLocation");
  fillLocationSelect(sel, b.location);
  sel.onchange = () => { b.location = sel.value; saveState(); render(); };

  // ジャンルセレクト
  const gsel = body.querySelector("#detailGenre");
  fillGenreSelect(gsel, b.genre || "");
  gsel.onchange = () => {
    const v = resolveGenreChoice(gsel, b.genre || "");
    b.genre = v;
    saveState();
    render();
  };

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
function fillGenreSelect(sel, selected) {
  sel.innerHTML = "";
  sel.appendChild(new Option("（ジャンルなし）", ""));
  for (const g of state.genres) sel.appendChild(new Option(g, g));
  sel.appendChild(new Option("＋ 新しいジャンルを追加…", "__new"));
  sel.value = selected && state.genres.includes(selected) ? selected : "";
}

/* 「＋新しいジャンル」が選ばれたらprompt入力→登録し、確定した値を返す */
function resolveGenreChoice(sel, prevValue) {
  if (sel.value !== "__new") return sel.value;
  const name = (prompt("新しいジャンル名を入力してください") || "").trim();
  if (name && !state.genres.includes(name)) {
    state.genres.push(name);
    saveState();
  }
  const finalValue = name && state.genres.includes(name) ? name : prevValue;
  fillGenreSelect(sel, finalValue);
  return finalValue;
}

function renderGenreList() {
  const ul = document.getElementById("genreList");
  ul.innerHTML = "";
  if (state.genres.length === 0) {
    ul.innerHTML = `<li style="color:var(--muted);font-size:.82rem">まだジャンルがありません</li>`;
  }
  for (const g of state.genres) {
    const count = state.books.filter(b => b.genre === g).length;
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(g)} <small style="color:var(--muted)">(${count}冊)</small></span>`;
    const del = document.createElement("button");
    del.className = "loc-del";
    del.textContent = "削除";
    del.onclick = () => {
      const msg = count > 0
        ? `ジャンル「${g}」を削除しますか？\n(${count}冊の本は「ジャンルなし」になります)`
        : `ジャンル「${g}」を削除しますか？`;
      if (!confirm(msg)) return;
      state.genres = state.genres.filter(x => x !== g);
      state.books.forEach(b => { if (b.genre === g) b.genre = ""; });
      if (currentGenre === g) currentGenre = "all";
      saveState();
      renderGenreList();
      render();
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
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
  for (const l of state.locations) {
    const count = state.books.filter(b => b.location === l).length;
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(l)} <small style="color:var(--muted)">(${count}冊)</small></span>`;
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
    li.appendChild(del);
    ul.appendChild(li);
  }
}

/* ============================================================
   モーダル・ユーティリティ
   ============================================================ */
function showModal(id) { document.getElementById(id).hidden = false; }
function hideModal(id) {
  document.getElementById(id).hidden = true;
  if (id === "scanModal") stopScanner();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ISBN10 → ISBN13 変換（手入力対応） */
function normalizeIsbn(input) {
  const s = input.replace(/[-\s]/g, "");
  if (/^97[89]\d{10}$/.test(s)) return s;
  if (/^\d{9}[\dXx]$/.test(s)) {
    const core = "978" + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (i % 2 === 0 ? 1 : 3) * parseInt(core[i], 10);
    return core + ((10 - (sum % 10)) % 10);
  }
  return null;
}

/* ============================================================
   イベント登録・初期化
   ============================================================ */
document.getElementById("scanFab").onclick = openScanner;
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
document.getElementById("confirmGenre").onchange = (e) => {
  resolveGenreChoice(e.target, "");
};

// 連続登録モードの切替(ONのとき登録先の置き場所を表示)
document.getElementById("contMode").onchange = (e) => {
  document.getElementById("contLocation").hidden = !e.target.checked;
};

document.getElementById("manualAddBtn").onclick = async () => {
  const raw = document.getElementById("manualIsbn").value;
  const isbn = normalizeIsbn(raw);
  if (!isbn) { alert("ISBNの形式が正しくありません。\n(978から始まる13桁、または10桁)"); return; }
  stopScanner();
  hideModal("scanModal");
  document.getElementById("manualIsbn").value = "";
  await lookupAndConfirm(isbn);
};

// フィルタボタン
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".filter-btn").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render();
  };
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

render();
