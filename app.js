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
let pendingBook = null;        // 登録確認中の本
let detailIsbn = null;         // 詳細表示中の本のISBN

/* ---------- 保存・読込 ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.books) && Array.isArray(data.locations)) return data;
    }
  } catch (e) { /* 壊れたデータは初期化 */ }
  return { books: [], locations: [...DEFAULT_LOCATIONS] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ============================================================
   画面描画
   ============================================================ */
function render() {
  renderTabs();
  renderGrid();
  renderHeaderStats();
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
  return state.books.filter(b => {
    if (currentLocation !== "all" && b.location !== currentLocation) return false;
    if (currentFilter !== "all" && bookStatus(b) !== currentFilter) return false;
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
  const books = visibleBooks()
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  empty.hidden = books.length > 0;

  for (const b of books) {
    const card = document.createElement("div");
    card.className = "book-card";
    const st = bookStatus(b);

    const coverHtml = b.cover
      ? `<img class="book-cover" src="${escapeHtml(b.cover)}" alt="" loading="lazy"
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
    card.onclick = () => openDetail(b.isbn);
    grid.appendChild(card);
  }
}

function progressPercent(b) {
  if (!b.totalPages || !b.logs || b.logs.length === 0) return null;
  const maxPage = Math.max(...b.logs.map(l => l.page));
  return Math.min(100, Math.round((maxPage / b.totalPages) * 100));
}

/* ============================================================
   バーコードスキャン
   ============================================================ */
const APP_VERSION = "1.4";
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
        if (isIsbnCode(c.rawValue)) { onScanned(c.rawValue); return; }
      }
    } catch (e) { /* フレーム未準備などは無視 */ }
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
      if (text && isIsbnCode(text)) { onScanned(text); return; }
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

async function onScanned(isbn) {
  stopScanner();
  hideModal("scanModal");
  navigator.vibrate && navigator.vibrate(80);
  await lookupAndConfirm(isbn);
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

/* openBD(日本の書籍に強い)を優先し、表紙・ページ数など
   足りない項目は Google Books ほかで補完する */
async function fetchBookInfo(isbn) {
  const ob = await fetchOpenBd(isbn);
  const needGoogle = !ob || !ob.cover || !ob.totalPages;
  const gb = needGoogle ? await fetchGoogleBooks(isbn) : null;
  if (!ob && !gb) return null;
  const base = ob || gb;
  const sub = (ob ? gb : null) || {};
  const cover = await resolveCover(isbn, base.cover || sub.cover || "");
  return {
    isbn,
    title: base.title || sub.title || "(タイトル不明)",
    author: base.author || sub.author || "",
    publisher: base.publisher || sub.publisher || "",
    cover,
    totalPages: base.totalPages || sub.totalPages || null
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
  showModal("confirmModal");

  let info = await fetchBookInfo(isbn);
  if (!info) {
    info = { isbn, title: `ISBN ${isbn}`, author: "", publisher: "", cover: "", totalPages: null, notFound: true };
  }
  pendingBook = info;

  const coverHtml = info.cover
    ? `<img src="${escapeHtml(info.cover)}" alt="">`
    : `<div class="no-cover">表紙なし</div>`;
  body.innerHTML = `
    ${coverHtml}
    <div class="confirm-meta">
      <h3>${escapeHtml(info.title)}</h3>
      <p>${escapeHtml(info.author)}</p>
      <p>${escapeHtml(info.publisher)}</p>
      <p>ISBN: ${isbn}</p>
      ${info.totalPages ? `<p>${info.totalPages}ページ</p>` : ""}
      ${info.notFound ? `<p style="color:var(--danger)">書誌情報が見つかりませんでした。<br>このまま登録もできます。</p>` : ""}
    </div>
  `;
}

function addPendingBook() {
  if (!pendingBook) return;
  const loc = document.getElementById("confirmLocation").value;
  state.books.push({
    isbn: pendingBook.isbn,
    title: pendingBook.title,
    author: pendingBook.author,
    publisher: pendingBook.publisher,
    cover: pendingBook.cover,
    totalPages: pendingBook.totalPages,
    location: loc,
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
document.getElementById("manageLocBtn").onclick = () => { renderLocList(); showModal("locModal"); };

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

// モーダルの閉じるボタン・背景クリック
document.querySelectorAll("[data-close]").forEach(btn => {
  btn.onclick = () => hideModal(btn.dataset.close);
});
document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", e => { if (e.target === m) hideModal(m.id); });
});

render();
