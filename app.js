/* 兩種版本共用這支程式：
   · 資料夾版把 lib/ 裡的檔案用 <script> 載進來
   · 單一 HTML 版把同樣的程式碼內嵌，worker 改用 blob URL
   差別只在 __PDFJS_WORKER_SRC 由外層給什麼值。 */

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = window.__PDFJS_WORKER_SRC;

const { PDFDocument } = window.PDFLib;

/* ============================================================
   常數
   ============================================================ */

const CSS_SCALE = 1.35;      // PDF point → 螢幕像素的顯示倍率
const RENDER_SCALE = 2;      // 背景畫布的解析度倍率（清晰度）
const EXPORT_SCALE = 3;      // 輸出時標註層的解析度倍率
const TEXT_FONT = '"PingFang TC", "Noto Sans TC", -apple-system, sans-serif';
const DEFAULT_TEXT_SIZE = 12;   // PDF point
const DEFAULT_IMG_WIDTH = 150;  // PDF point
const LINE_HEIGHT = 1.2;        // 畫面與輸出共用，兩邊才會一致

const DEFAULT_FIELDS = [
  { label: '姓名', value: '' },
  { label: '身分證字號', value: '' },
  { label: '出生年月日', value: '' },
  { label: '戶籍地址', value: '' },
  { label: '通訊地址', value: '' },
  { label: '手機', value: '' },
  { label: 'Email', value: '' },
  { label: '銀行/分行', value: '' },
  { label: '帳號', value: '' },
];

/* ============================================================
   狀態
   ============================================================ */

const state = {
  fileName: '',
  pdfBytes: null,      // ArrayBuffer（原始檔，輸出時用）
  pages: [],           // { pageNum, width, height, wrapEl, overlayEl }
  marks: [],           // { id, page, x, y, kind, ... }
  fields: [],
  images: [],          // { id, name, dataUrl, w, h, lastWidth }
  armed: null,         // { kind:'text', text } | { kind:'image', imgId }
  selectedId: null,
  editingId: null,     // 正在就地打字的文字框
  markSeq: 0,
};

/* ============================================================
   DOM
   ============================================================ */

const $ = (id) => document.getElementById(id);

const el = {
  pdfInput: $('pdfInput'),
  exportBtn: $('exportBtn'),
  clearMarksBtn: $('clearMarksBtn'),
  addFieldBtn: $('addFieldBtn'),
  fieldList: $('fieldList'),
  imgInput: $('imgInput'),
  imgList: $('imgList'),
  symbolRow: $('symbolRow'),
  stage: $('stage'),
  pages: $('pages'),
  emptyState: $('emptyState'),
  floatBar: $('floatBar'),
  fbTextGroup: $('fbTextGroup'),
  fbImgGroup: $('fbImgGroup'),
  fbSize: $('fbSize'),
  fbScale: $('fbScale'),
  toast: $('toast'),
};

/* ============================================================
   儲存：欄位用 localStorage，圖片用 IndexedDB
   ============================================================ */

const FIELDS_KEY = 'lrd.fields.v1';

function loadFields() {
  try {
    const raw = localStorage.getItem(FIELDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (_) { /* 壞掉就用預設 */ }
  return DEFAULT_FIELDS.map((f) => ({ ...f }));
}

function saveFields() {
  try {
    localStorage.setItem(FIELDS_KEY, JSON.stringify(state.fields));
  } catch (_) {
    toast('資料存不進瀏覽器，可能空間滿了');
  }
}

/* 圖片儲存：優先 IndexedDB，不能用就退回 localStorage。
   雙擊開啟 HTML 時網址是 file://，某些瀏覽器在這個情況下
   會擋掉 IndexedDB，或是開啟請求永遠不回應——所以要設逾時。 */

const IMAGES_KEY = 'lrd.images.v1';
let storeMode = null;   // 'idb' | 'ls'
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      const req = indexedDB.open('lrd-store', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('images', { keyPath: 'id' });
      };
      req.onsuccess = () => { settled = true; resolve(req.result); };
      req.onerror = () => { settled = true; reject(req.error); };
      req.onblocked = () => { settled = true; reject(new Error('blocked')); };
      // Safari 在 file:// 下可能永遠不回應，不能無限等
      setTimeout(() => { if (!settled) reject(new Error('IndexedDB 逾時')); }, 2000);
    });
  }
  return dbPromise;
}

async function pickStore() {
  if (storeMode) return storeMode;
  try {
    await db();
    storeMode = 'idb';
  } catch (_) {
    storeMode = 'ls';
    console.info('IndexedDB 不能用，圖片改存 localStorage');
  }
  return storeMode;
}

function lsAll() {
  try { return JSON.parse(localStorage.getItem(IMAGES_KEY) || '[]'); }
  catch (_) { return []; }
}

function lsWrite(list) {
  try {
    localStorage.setItem(IMAGES_KEY, JSON.stringify(list));
    return true;
  } catch (_) {
    toast('圖片存不下來，這個瀏覽器空間滿了——改用 Chrome 開會比較穩', 4500);
    return false;
  }
}

async function dbAll() {
  if ((await pickStore()) === 'ls') return lsAll();
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('images').objectStore('images').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(rec) {
  if ((await pickStore()) === 'ls') {
    const list = lsAll().filter((r) => r.id !== rec.id);
    list.push(rec);
    return lsWrite(list);
  }
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('images', 'readwrite');
    tx.objectStore('images').put(rec);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  if ((await pickStore()) === 'ls') return lsWrite(lsAll().filter((r) => r.id !== id));
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('images', 'readwrite');
    tx.objectStore('images').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
   小工具
   ============================================================ */

let toastTimer = null;

function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ============================================================
   左側：常用資料欄位
   ============================================================ */

function renderFields() {
  el.fieldList.replaceChildren();

  state.fields.forEach((field, i) => {
    const row = document.createElement('div');
    row.className = 'field-row';

    const labelInput = document.createElement('input');
    labelInput.className = 'f-label';
    labelInput.value = field.label;
    labelInput.placeholder = '欄位名';
    labelInput.addEventListener('input', () => {
      field.label = labelInput.value;
      saveFields();
    });

    const valueInput = document.createElement('input');
    valueInput.value = field.value;
    valueInput.placeholder = '內容';
    valueInput.addEventListener('input', () => {
      field.value = valueInput.value;
      saveFields();
    });
    valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') armText(field.value);
    });

    const actions = document.createElement('div');
    actions.className = 'field-actions';

    const placeBtn = document.createElement('button');
    placeBtn.className = 'icon-btn';
    placeBtn.textContent = '放上去';
    placeBtn.dataset.fieldIndex = String(i);
    placeBtn.addEventListener('click', () => armText(field.value));

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn icon-btn-del';
    delBtn.textContent = '✕';
    delBtn.title = '刪除欄位';
    delBtn.addEventListener('click', () => {
      state.fields.splice(i, 1);
      saveFields();
      renderFields();
    });

    actions.append(placeBtn, delBtn);
    row.append(labelInput, valueInput, actions);
    el.fieldList.append(row);
  });
}

/* ============================================================
   左側：圖片
   ============================================================ */

function renderImages() {
  el.imgList.replaceChildren();

  if (!state.images.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.gridColumn = '1 / -1';
    empty.style.margin = '0';
    empty.textContent = '還沒有圖片。';
    el.imgList.append(empty);
    return;
  }

  state.images.forEach((img) => {
    const card = document.createElement('div');
    card.className = 'img-card';
    card.dataset.imgId = img.id;

    const thumb = document.createElement('div');
    thumb.className = 'img-thumb';
    const thumbImg = document.createElement('img');
    thumbImg.src = img.dataUrl;
    thumbImg.alt = img.name;
    thumb.append(thumbImg);

    const name = document.createElement('div');
    name.className = 'img-card-name';
    name.textContent = img.name;
    name.title = img.name;

    const actions = document.createElement('div');
    actions.className = 'img-card-actions';

    const placeBtn = document.createElement('button');
    placeBtn.className = 'icon-btn';
    placeBtn.textContent = '放上去';
    placeBtn.addEventListener('click', () => armImage(img.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn icon-btn-del';
    delBtn.textContent = '✕';
    delBtn.title = '刪除圖片';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`確定刪除「${img.name}」？`)) return;
      await dbDelete(img.id);
      state.images = state.images.filter((x) => x.id !== img.id);
      if (state.armed?.kind === 'image' && state.armed.imgId === img.id) disarm();
      renderImages();
    });

    actions.append(placeBtn, delBtn);
    card.append(thumb, name, actions);
    el.imgList.append(card);
  });
}

const MAX_STORED_EDGE = 1800;   // 印出來遠超所需，再大只是浪費空間

/* 手機拍的身分證動輒四千像素，原樣存會塞爆瀏覽器空間。
   縮到夠用就好；有透明背景（簽名檔）的維持 PNG，照片轉 JPEG。 */
async function shrinkForStorage(rawUrl) {
  const img = await loadImage(rawUrl);
  const { naturalWidth: w, naturalHeight: h } = img;
  const scale = Math.min(1, MAX_STORED_EDGE / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, cw, ch);

  let transparent = false;
  try {
    const px = ctx.getImageData(0, 0, cw, ch).data;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 250) { transparent = true; break; }
    }
  } catch (_) {
    transparent = true;   // 讀不到就當作有透明，PNG 比較保險
  }

  const url = transparent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.88);
  // 縮完反而更大就用原圖（本來就很小的簽名檔會這樣）
  return url.length < rawUrl.length || scale < 1
    ? { dataUrl: url, w: cw, h: ch }
    : { dataUrl: rawUrl, w, h };
}

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const rawUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

    let prepared;
    try {
      prepared = await shrinkForStorage(rawUrl);
    } catch (_) {
      toast(`「${file.name}」讀不開，換個檔案試試`);
      continue;
    }

    const rec = {
      id: uid(),
      name: file.name.replace(/\.[^.]+$/, ''),
      dataUrl: prepared.dataUrl,
      w: prepared.w,
      h: prepared.h,
      lastWidth: DEFAULT_IMG_WIDTH,
    };

    await dbPut(rec);
    state.images.push(rec);
  }
  renderImages();
}

/* ============================================================
   準備放置
   ============================================================ */

function armText(text) {
  const t = (text ?? '').trim();
  if (!t) { toast('這個欄位是空的'); return; }
  if (!state.pages.length) { toast('請先開啟一份 PDF'); return; }
  state.armed = { kind: 'text', text: t };
  syncArmedUI();
  toast('點 PDF 上要填的位置');
}

function armImage(imgId) {
  if (!state.pages.length) { toast('請先開啟一份 PDF'); return; }
  state.armed = { kind: 'image', imgId };
  syncArmedUI();
  toast('點 PDF 上要放的位置');
}

function disarm() {
  state.armed = null;
  syncArmedUI();
}

function syncArmedUI() {
  const armed = !!state.armed;
  el.stage.classList.toggle('is-armed', armed);

  el.imgList.querySelectorAll('.img-card').forEach((card) => {
    card.classList.toggle(
      'is-armed',
      armed && state.armed.kind === 'image' && state.armed.imgId === card.dataset.imgId,
    );
  });
}

/* ============================================================
   載入 PDF
   ============================================================ */

async function openPdf(file) {
  if (!file) return;
  try {
    await openPdfInner(file);
  } catch (err) {
    console.error(err);
    // 加密、損毀、或根本不是 PDF——要講出來，不能默默停在空畫面
    const hint = /password|encrypt/i.test(err.message || '')
      ? '這份 PDF 有密碼保護，請先用「預覽程式」另存一份沒有密碼的。'
      : `這份 PDF 打不開：${err.message}`;
    el.emptyState.hidden = false;
    alert(hint);
  }
}

async function openPdfInner(file) {
  stopEditing();

  const buf = await file.arrayBuffer();
  state.pdfBytes = buf;
  state.fileName = file.name.replace(/\.pdf$/i, '');
  state.marks = [];
  state.selectedId = null;
  hideFloatBar();

  // pdf.js 會接管（detach）傳進去的 buffer，所以給它一份複本
  // isEvalSupported: false —— 讓 pdf.js 不要用 eval，才能在嚴格的 CSP 下運作
  const doc = await pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false }).promise;

  el.pages.replaceChildren();
  state.pages = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.width = `${viewport.width * CSS_SCALE}px`;
    wrap.style.height = `${viewport.height * CSS_SCALE}px`;

    const canvas = document.createElement('canvas');
    const rv = page.getViewport({ scale: RENDER_SCALE });
    canvas.width = Math.floor(rv.width);
    canvas.height = Math.floor(rv.height);

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset.page = String(n);

    wrap.append(canvas, overlay);
    el.pages.append(wrap);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport: rv }).promise;

    state.pages.push({
      pageNum: n,
      width: viewport.width,
      height: viewport.height,
      wrapEl: wrap,
      overlayEl: overlay,
    });

    overlay.addEventListener('mousedown', onOverlayMouseDown);
  }

  el.emptyState.hidden = true;
  el.exportBtn.disabled = false;
  el.clearMarksBtn.disabled = false;
  el.stage.scrollTop = 0;
  toast(`已開啟：${file.name}（共 ${doc.numPages} 頁）`);
}

/* ============================================================
   放置與操作標註
   ============================================================ */

function onOverlayMouseDown(e) {
  if (e.target !== e.currentTarget) return;  // 點在既有標註上，交給它自己處理

  // mousedown 的預設行為會把焦點搶走，讓剛開好的文字框立刻失焦被當成空框刪掉
  e.preventDefault();

  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / CSS_SCALE;
  const y = (e.clientY - rect.top) / CSS_SCALE;
  const pageNum = Number(e.currentTarget.dataset.page);

  // 正在打字時點別處：先收掉這格，再接著開下一格——連續填表才不用每格點兩下
  if (state.editingId) stopEditing();

  // 沒有預備放置的東西，就地開一個文字框直接打字
  if (!state.armed) {
    const mark = addTextMark(pageNum, x, y, '');
    startEditing(mark.id);
    return;
  }

  if (state.armed.kind === 'text') {
    addTextMark(pageNum, x, y, state.armed.text);
  } else {
    addImageMark(pageNum, x, y, state.armed.imgId);
  }

  disarm();
}

/* ---- 就地編輯文字 ---- */

function startEditing(id) {
  const mark = findMark(id);
  const node = markNode(id);
  if (!mark || !node || mark.kind !== 'text') return;

  if (state.editingId && state.editingId !== id) stopEditing();

  state.editingId = id;
  select(id);

  node.contentEditable = 'plaintext-only';
  node.classList.add('is-editing');
  node.focus();

  // 已有內容就全選，方便直接覆寫
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(mark.text ? range : range.cloneRange());
  if (!mark.text) sel.collapseToEnd();

  node.addEventListener('blur', onEditBlur);
}

function onEditBlur() {
  stopEditing();
}

function stopEditing() {
  const id = state.editingId;
  if (!id) return;
  state.editingId = null;

  const mark = findMark(id);
  const node = markNode(id);
  if (!node) return;

  node.removeEventListener('blur', onEditBlur);
  node.contentEditable = 'false';
  node.classList.remove('is-editing');

  const text = (node.textContent || '').replace(/ /g, ' ').trimEnd();

  // 打了空白就當作沒打，直接收掉——誤點不會留下垃圾
  if (!text.trim()) {
    deleteMark(id);
    return;
  }

  if (mark) {
    mark.text = text;
    renderMark(mark);
    positionFloatBar(id);
  }
}

function addTextMark(page, x, y, text) {
  const mark = {
    id: uid(),
    seq: state.markSeq++,
    page,
    kind: 'text',
    x,
    y: y - DEFAULT_TEXT_SIZE / 2,  // 讓點擊處落在文字中間
    text,
    size: DEFAULT_TEXT_SIZE,
  };
  state.marks.push(mark);
  renderMark(mark);
  select(mark.id);
  return mark;
}

function addImageMark(page, x, y, imgId) {
  const img = state.images.find((i) => i.id === imgId);
  if (!img) return;

  const w = img.lastWidth || DEFAULT_IMG_WIDTH;
  const h = w * (img.h / img.w);

  const mark = {
    id: uid(),
    seq: state.markSeq++,
    page,
    kind: 'image',
    imgId,
    x: x - w / 2,   // 以點擊處為中心
    y: y - h / 2,
    w,
    h,
  };
  state.marks.push(mark);
  renderMark(mark);
  select(mark.id);
}

function renderMark(mark) {
  const pageInfo = state.pages.find((p) => p.pageNum === mark.page);
  if (!pageInfo) return;

  let node = pageInfo.overlayEl.querySelector(`[data-mark-id="${mark.id}"]`);
  if (!node) {
    node = document.createElement('div');
    node.className = `mark mark-${mark.kind}`;
    node.dataset.markId = mark.id;
    node.addEventListener('mousedown', onMarkMouseDown);
    if (mark.kind === 'text') {
      node.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startEditing(mark.id);
      });
    }
    pageInfo.overlayEl.append(node);
  }

  node.style.left = `${mark.x * CSS_SCALE}px`;
  node.style.top = `${mark.y * CSS_SCALE}px`;

  if (mark.kind === 'text') {
    // 正在打字時別碰 textContent，否則游標會被踢掉
    if (state.editingId !== mark.id) node.textContent = mark.text;
    node.style.fontSize = `${mark.size * CSS_SCALE}px`;
    node.style.fontFamily = TEXT_FONT;
    node.style.lineHeight = String(LINE_HEIGHT);
  } else {
    const img = state.images.find((i) => i.id === mark.imgId);
    node.style.width = `${mark.w * CSS_SCALE}px`;
    node.style.height = `${mark.h * CSS_SCALE}px`;
    let imgEl = node.querySelector('img');
    if (!imgEl) {
      imgEl = document.createElement('img');
      node.append(imgEl);
    }
    if (img && imgEl.src !== img.dataUrl) imgEl.src = img.dataUrl;
  }

  node.classList.toggle('is-selected', mark.id === state.selectedId);
}

function findMark(id) {
  return state.marks.find((m) => m.id === id);
}

function markNode(id) {
  return el.pages.querySelector(`[data-mark-id="${id}"]`);
}

/* ---- 拖曳 ---- */

let drag = null;

function onMarkMouseDown(e) {
  const id = e.currentTarget.dataset.markId;

  // 正在打字的框：讓滑鼠正常操作游標與選字，不要當成拖曳
  if (state.editingId === id) {
    e.stopPropagation();
    return;
  }

  e.stopPropagation();
  e.preventDefault();

  const mark = findMark(id);
  if (!mark) return;

  if (state.editingId) stopEditing();

  select(id);

  drag = {
    id,
    startX: e.clientX,
    startY: e.clientY,
    originX: mark.x,
    originY: mark.y,
    moved: false,
  };

  e.currentTarget.classList.add('is-dragging');
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!drag) return;
  const mark = findMark(drag.id);
  if (!mark) return;

  const dx = (e.clientX - drag.startX) / CSS_SCALE;
  const dy = (e.clientY - drag.startY) / CSS_SCALE;

  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) drag.moved = true;

  mark.x = drag.originX + dx;
  mark.y = drag.originY + dy;
  renderMark(mark);
  positionFloatBar(mark.id);
}

function onDragEnd() {
  if (drag) {
    markNode(drag.id)?.classList.remove('is-dragging');
    drag = null;
  }
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
}

/* ---- 選取 ---- */

function select(id) {
  if (state.selectedId && state.selectedId !== id) {
    markNode(state.selectedId)?.classList.remove('is-selected');
  }
  state.selectedId = id;

  if (!id) { hideFloatBar(); return; }

  markNode(id)?.classList.add('is-selected');
  showFloatBar(id);
}

function showFloatBar(id) {
  const mark = findMark(id);
  if (!mark) return hideFloatBar();

  const isText = mark.kind === 'text';
  el.fbTextGroup.hidden = !isText;
  el.fbImgGroup.hidden = isText;

  if (isText) {
    el.fbSize.textContent = String(Math.round(mark.size));
  } else {
    const img = state.images.find((i) => i.id === mark.imgId);
    const base = img ? DEFAULT_IMG_WIDTH : mark.w;
    el.fbScale.textContent = `${Math.round((mark.w / base) * 100)}%`;
  }

  el.floatBar.hidden = false;
  positionFloatBar(id);
}

function positionFloatBar(id) {
  const node = markNode(id);
  if (!node || el.floatBar.hidden) return;

  const r = node.getBoundingClientRect();
  const barW = el.floatBar.offsetWidth;
  const barH = el.floatBar.offsetHeight;

  let left = r.left + r.width / 2 - barW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - barW - 8));

  let top = r.top - barH - 10;
  if (top < 8) top = r.bottom + 10;

  el.floatBar.style.left = `${left}px`;
  el.floatBar.style.top = `${top}px`;
}

function hideFloatBar() {
  el.floatBar.hidden = true;
}

function deleteMark(id) {
  if (state.editingId === id) state.editingId = null;
  const node = markNode(id);
  node?.remove();
  state.marks = state.marks.filter((m) => m.id !== id);
  if (state.selectedId === id) select(null);
}


/* ============================================================
   輸出 PDF
   ============================================================ */

async function exportPdf() {
  if (!state.pdfBytes) return;

  stopEditing();   // 正在打的字要先落地，否則會漏掉

  if (!state.marks.length && !confirm('目前還沒填任何東西，仍要輸出嗎？')) return;

  el.exportBtn.disabled = true;
  const originalLabel = el.exportBtn.textContent;
  el.exportBtn.textContent = '產生中…';

  try {
    const out = await PDFDocument.load(state.pdfBytes.slice(0));
    const outPages = out.getPages();

    // 先把圖片解碼好，避免在迴圈裡重複做
    const imgCache = new Map();
    for (const img of state.images) {
      if (state.marks.some((m) => m.kind === 'image' && m.imgId === img.id)) {
        imgCache.set(img.id, await loadImage(img.dataUrl));
      }
    }

    for (let i = 0; i < outPages.length; i++) {
      const pageMarks = state.marks.filter((m) => m.page === i + 1);
      if (!pageMarks.length) continue;

      const pageInfo = state.pages[i];
      const outPage = outPages[i];
      const box = outPage.getCropBox();
      const rotation = ((outPage.getRotation().angle % 360) + 360) % 360;

      // 1) 在「顯示座標系」畫出透明標註層
      const layer = document.createElement('canvas');
      layer.width = Math.round(pageInfo.width * EXPORT_SCALE);
      layer.height = Math.round(pageInfo.height * EXPORT_SCALE);
      const ctx = layer.getContext('2d');
      ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

      for (const mark of pageMarks.sort((a, b) => a.seq - b.seq)) {
        if (mark.kind === 'text') {
          ctx.font = `${mark.size}px ${TEXT_FONT}`;
          ctx.fillStyle = '#111111';
          ctx.textBaseline = 'top';
          mark.text.split('\n').forEach((line, li) => {
            ctx.fillText(line, mark.x, mark.y + li * mark.size * LINE_HEIGHT);
          });
        } else {
          const bitmap = imgCache.get(mark.imgId);
          if (bitmap) ctx.drawImage(bitmap, mark.x, mark.y, mark.w, mark.h);
        }
      }

      // 2) 轉回「未旋轉的頁面座標系」
      const flat = unrotateLayer(layer, rotation, box, EXPORT_SCALE);

      // 3) 疊到原頁面上，原本的內容一個字都不動
      const png = await out.embedPng(flat.toDataURL('image/png'));
      outPage.drawImage(png, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
    }

    const bytes = await out.save();
    downloadBlob(
      new Blob([bytes], { type: 'application/pdf' }),
      `${state.fileName || '勞報單'}-已填.pdf`,
    );
    toast('已輸出，檢查一下有沒有跑位');
  } catch (err) {
    console.error(err);
    alert(`輸出失敗：${err.message}`);
  } finally {
    el.exportBtn.textContent = originalLabel;
    el.exportBtn.disabled = false;
  }
}

// 頁面若有 rotation，標註層要先反向轉回去，疊上去才會對齊
function unrotateLayer(layer, rotation, box, scale) {
  if (rotation === 0) return layer;

  const out = document.createElement('canvas');
  out.width = Math.round(box.width * scale);
  out.height = Math.round(box.height * scale);
  const ctx = out.getContext('2d');

  if (rotation === 90) {
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(out.width, out.height);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
  }

  ctx.drawImage(layer, 0, 0);
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = src;
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================================
   事件綁定
   ============================================================ */

el.pdfInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) openPdf(file);
  e.target.value = '';
});

el.imgInput.addEventListener('change', async (e) => {
  await addImageFiles([...e.target.files]);
  e.target.value = '';
});

el.exportBtn.addEventListener('click', exportPdf);

el.clearMarksBtn.addEventListener('click', () => {
  stopEditing();
  if (!state.marks.length) return;
  if (!confirm('清空這份 PDF 上所有填寫的內容？（存起來的資料和圖片不會被刪）')) return;
  state.marks.forEach((m) => markNode(m.id)?.remove());
  state.marks = [];
  select(null);
});

el.addFieldBtn.addEventListener('click', () => {
  state.fields.push({ label: '', value: '' });
  saveFields();
  renderFields();
  const rows = el.fieldList.querySelectorAll('.field-row');
  rows[rows.length - 1]?.querySelector('input')?.focus();
});

el.symbolRow.addEventListener('click', (e) => {
  const sym = e.target.dataset?.sym;
  if (sym) armText(sym);
});

/* 浮動工具列 */

el.floatBar.addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;

  const mark = findMark(state.selectedId);
  if (!mark) return;

  if (act === 'delete') {
    deleteMark(mark.id);
    return;
  }

  if (act === 'edit') {
    startEditing(mark.id);
    return;
  }

  if (act === 'size-up' || act === 'size-down') {
    mark.size = Math.max(5, Math.min(72, mark.size + (act === 'size-up' ? 1 : -1)));
    el.fbSize.textContent = String(Math.round(mark.size));
  }

  if (act === 'scale-up' || act === 'scale-down') {
    const factor = act === 'scale-up' ? 1.1 : 1 / 1.1;
    const cx = mark.x + mark.w / 2;
    const cy = mark.y + mark.h / 2;
    mark.w = Math.max(10, mark.w * factor);
    mark.h = Math.max(10, mark.h * factor);
    mark.x = cx - mark.w / 2;   // 以中心縮放，比較好對位
    mark.y = cy - mark.h / 2;

    const img = state.images.find((i) => i.id === mark.imgId);
    if (img) {
      img.lastWidth = mark.w;   // 記住這張圖慣用的大小
      dbPut(img).catch(() => {});
      el.fbScale.textContent = `${Math.round((mark.w / DEFAULT_IMG_WIDTH) * 100)}%`;
    }
  }

  renderMark(mark);
  positionFloatBar(mark.id);
});

/* 鍵盤 */

window.addEventListener('keydown', (e) => {
  // 就地打字中：只攔 Esc（結束編輯），其餘全部交給輸入法和瀏覽器
  if (state.editingId) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopEditing();
    }
    return;
  }

  const typing = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);

  if (e.key === 'Escape') {
    if (state.armed) { disarm(); toast('已取消'); }
    else select(null);
    return;
  }

  if (typing || !state.selectedId) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteMark(state.selectedId);
    return;
  }

  // 方向鍵微調位置，按住 Shift 走大步
  const step = e.shiftKey ? 5 : 0.5;
  const moves = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    ArrowUp: [0, -step], ArrowDown: [0, step],
  };
  if (moves[e.key]) {
    e.preventDefault();
    const mark = findMark(state.selectedId);
    mark.x += moves[e.key][0];
    mark.y += moves[e.key][1];
    renderMark(mark);
    positionFloatBar(mark.id);
  }
});

/* 捲動時工具列要跟著 */

el.stage.addEventListener('scroll', () => {
  if (state.selectedId) positionFloatBar(state.selectedId);
});

/* 拖放檔案 */

['dragenter', 'dragover'].forEach((evt) => {
  el.stage.addEventListener(evt, (e) => {
    e.preventDefault();
    el.stage.classList.add('is-dragover');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  el.stage.addEventListener(evt, (e) => {
    e.preventDefault();
    if (evt === 'dragleave' && el.stage.contains(e.relatedTarget)) return;
    el.stage.classList.remove('is-dragover');
  });
});

el.stage.addEventListener('drop', async (e) => {
  const files = [...e.dataTransfer.files];
  const pdf = files.find((f) => f.type === 'application/pdf');
  if (pdf) { await openPdf(pdf); return; }

  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length) {
    await addImageFiles(images);
    toast(`已加入 ${images.length} 張圖片`);
  }
});

/* ============================================================
   啟動
   ============================================================ */

(async function init() {
  state.fields = loadFields();
  renderFields();

  try {
    state.images = await dbAll();
  } catch (_) {
    state.images = [];
  }
  renderImages();
})();
