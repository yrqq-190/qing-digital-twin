/**
 * 自留地模块：文学与阅读 / 摄影与生活
 *
 * 存储：云端（Cloudflare KV）为主，localStorage 离线缓存。
 * - 打开页面：先渲染本地缓存，再拉云端最新覆盖；
 * - 修改：自动保存云端（写入口令），成功后同步缓存；失败弹一次提示；
 * - 导出数据：下载 JSON 备份。
 * 入口卡片背景图：长按/悬停编辑按钮 → 上传 → 正方形取景框选位置 → 存云端。
 */
import { CONFIG } from './config.js';

const API_BASE = CONFIG.BACKEND_URL;
const STORE_KEYS = { books: 'hobby:books:v1', photos: 'hobby:photos:v1', profile: 'hobby:profile:v1', token: 'hobby:token:v1' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readCache(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 存储满时静默 */ }
}

function getToken() {
  return localStorage.getItem(STORE_KEYS.token) || '';
}

function setToken(t) {
  localStorage.setItem(STORE_KEYS.token, t);
}

/** 图片压缩：缩放至最长边 maxDim，输出 JPEG dataURL */
function compressImage(file, maxDim, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 下载 JSON 备份 */
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ================= 云端读写 ================= */

async function fetchCloud(path, method = 'GET', data = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: data ? JSON.stringify({ data }) : undefined
  });
  return res;
}

/** 拉取并覆盖内存+缓存；失败静默（用缓存） */
async function loadKind(kind, state) {
  try {
    const res = await fetchCloud(`/api/${kind}`);
    if (!res.ok) throw new Error('cloud read failed');
    const json = await res.json();
    if (json.ok && Array.isArray(json.data)) {
      state.length = 0;
      state.push(...json.data);
      writeCache(STORE_KEYS[kind], state);
      render(kind);
    }
  } catch { /* 离线时保持缓存 */ }
}

/** 保存到云端（401 询问口令重试一次；网络失败 alert 一次） */
async function saveKind(kind, state) {
  writeCache(STORE_KEYS[kind], state);
  let token = getToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchCloud(`/api/${kind}`, 'POST', state);
      if (res.ok) return true;
      if (res.status === 401) {
        const input = prompt('写入口令错误。请输入写入口令：');
        if (!input) return false;
        setToken(input.trim());
        token = input.trim();
        continue;
      }
      alert('云端保存失败，内容已保留在本地浏览器。');
      return false;
    } catch {
      alert('网络不可达，内容已保留在本地浏览器，联网后再试。');
      return false;
    }
  }
  return false;
}

/** 入口卡片背景图：拉取云端自定义背景并应用到卡片 */
async function loadProfile() {
  try {
    const res = await fetchCloud('/api/profile');
    if (!res.ok) throw new Error('profile read failed');
    const json = await res.json();
    if (json.ok && json.data) {
      profile = json.data;
      writeCache(STORE_KEYS.profile, profile);
      applyProfileBg();
    }
  } catch { /* 静默，用默认图 */ }
}

/** 背景图：保存云端，成功后应用 */
async function saveProfile() {
  writeCache(STORE_KEYS.profile, profile);
  let token = getToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchCloud('/api/profile', 'POST', profile);
      if (res.ok) { applyProfileBg(); return true; }
      if (res.status === 401) {
        const input = prompt('写入口令错误。请输入写入口令：');
        if (!input) return false;
        setToken(input.trim());
        token = input.trim();
        continue;
      }
      alert('背景图保存失败，已保留在本地。');
      return false;
    } catch {
      alert('网络不可达，背景图已保留在本地。');
      return false;
    }
  }
  return false;
}

function applyProfileBg() {
  if (!profile) return;
  $$('.hobby-card').forEach((card) => {
    const key = card.dataset.hobby === 'reading' ? 'bgReading' : 'bgPhoto';
    const src = profile[key];
    if (src) {
      const img = card.querySelector('.hobby-bg');
      if (img) img.src = src;
    }
  });
}

/* ================= 渲染 ================= */

function render(kind) {
  if (kind === 'books') renderBooks();
  else renderPhotos();
}

/* ---- 书籍：横滑一屏一卡 ---- */

function renderBooks() {
  const list = $('#book-list');
  if (!list) return;
  list.innerHTML = '';

  if (books.length === 0) {
    list.innerHTML = '<p class="empty-hint">还没有书籍，点右侧「＋」添加第一本</p>';
    return;
  }

  books.forEach((book) => {
    const item = document.createElement('article');
    item.className = 'book-item';
    item.dataset.id = book.id;

    const coverHtml = book.cover
      ? `<img src="${book.cover}" alt="封面" />`
      : `<span class="book-cover-placeholder">
           <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
           上传封面
         </span>`;

    const quotes = String(book.quote || '').split('\n').map((s) => s.trim()).filter(Boolean);

    item.innerHTML = `
      <button class="book-delete" title="删除这本书" aria-label="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <label class="book-cover" title="点击上传封面">
        ${coverHtml}
        <input type="file" accept="image/*" class="cover-input" hidden />
      </label>
      <div class="book-fields">
        <input class="book-title-input" placeholder="书名" value="${escapeHtml(book.title)}" />
        <input class="book-author-input" placeholder="作者" value="${escapeHtml(book.author)}" />
      </div>
      <textarea class="book-thought-input" rows="2" placeholder="写点感想…">${escapeHtml(book.thought)}</textarea>
      <div class="book-quotes">${quotes.length ? quotes.map((q) => `<div class="book-quote" title="双击编辑">${escapeHtml(q)}</div>`).join('') : ''}</div>
      <button type="button" class="book-quote-add">＋ 金句</button>
    `;

    /* 封面上传 */
    const coverInput = item.querySelector('.cover-input');
    coverInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        book.cover = await compressImage(file, 480, 0.85);
        scheduleSave('books');
        renderBooks();
      } catch (err) {
        alert('封面压缩失败：' + err.message);
      }
      e.target.value = '';
    });

    /* 已上传封面预览 */
    const coverImg = item.querySelector('.book-cover img');
    if (coverImg) {
      coverImg.addEventListener('click', (e) => {
        e.stopPropagation();
        showPreview(book.cover);
      });
    }

    /* 书名 / 作者 / 感想 */
    const bindInput = (input, field) => {
      input.addEventListener('input', () => {
        book[field] = input.value;
        scheduleSave('books');
      });
    };
    bindInput(item.querySelector('.book-title-input'), 'title');
    bindInput(item.querySelector('.book-author-input'), 'author');
    bindInput(item.querySelector('.book-thought-input'), 'thought');

    /* 金句：双击纸片编辑 */
    const quotesBox = item.querySelector('.book-quotes');
    if (quotesBox) {
      $$('.book-quote', quotesBox).forEach((el) => {
        el.addEventListener('dblclick', () => {
          const idx = Array.from(quotesBox.children).indexOf(el);
          const ta = document.createElement('textarea');
          ta.className = 'book-quote-edit';
          ta.value = quotes[idx] || '';
          ta.rows = 2;
          el.replaceWith(ta);
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          const commit = () => {
            quotes[idx] = ta.value.trim();
            book.quote = quotes.join('\n');
            scheduleSave('books');
            renderBooks();
          };
          ta.addEventListener('blur', commit);
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
            if (e.key === 'Escape') { ta.blur(); }
          });
        });
      });
    }

    /* 添加金句 */
    const addQuoteBtn = item.querySelector('.book-quote-add');
    if (addQuoteBtn) {
      addQuoteBtn.addEventListener('click', () => {
        quotes.push('');
        book.quote = quotes.join('\n');
        renderBooks();
        const lastCard = $('#book-list .book-item:last-child');
        if (lastCard) {
          const lastQuote = lastCard.querySelector('.book-quote:last-child');
          if (lastQuote) lastQuote.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }
      });
    }

    /* 删除 */
    item.querySelector('.book-delete').addEventListener('click', () => {
      if (!confirm('确定删除这本书吗？')) return;
      const idx = books.findIndex((b) => String(b.id) === String(book.id));
      if (idx >= 0) books.splice(idx, 1);
      scheduleSave('books');
      renderBooks();
    });

    list.appendChild(item);
  });
}

/* ---- 相册（带备注 + 日期） ---- */

function renderPhotos() {
  const grid = $('#photo-grid');
  if (!grid) return;
  const addBtn = $('#add-photo-btn');

  const items = photos.map((p) => {
    const el = document.createElement('figure');
    el.className = 'photo-item';
    el.innerHTML = `
      <img src="${p.src}" alt="生活照片" loading="lazy" />
      <button class="photo-delete" title="删除这张照片" aria-label="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
      <figcaption class="photo-meta">
        <input class="photo-caption" type="text" placeholder="备注" value="${escapeHtml(p.caption)}" maxlength="60" />
        <input class="photo-date" type="text" placeholder="日期，如 2026-10-01" value="${escapeHtml(p.date)}" maxlength="20" />
      </figcaption>
    `;

    el.querySelector('img').addEventListener('click', () => showPreview(p.src));

    const captionInput = el.querySelector('.photo-caption');
    const dateInput = el.querySelector('.photo-date');
    captionInput.addEventListener('input', () => { p.caption = captionInput.value; scheduleSave('photos'); });
    dateInput.addEventListener('input', () => { p.date = dateInput.value; scheduleSave('photos'); });

    el.querySelector('.photo-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('删除这张照片？')) return;
      const idx = photos.findIndex((x) => x.id === p.id);
      if (idx >= 0) photos.splice(idx, 1);
      scheduleSave('photos');
      renderPhotos();
    });
    return el;
  });

  if (photos.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = '还没有照片，点右侧「＋」上传第一张';
    grid.replaceChildren(empty, addBtn);
    return;
  }
  grid.replaceChildren(...items, addBtn);
}

/* ================= 保存（防抖） ================= */

let saveTimer = null;
function scheduleSave(kind) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const state = kind === 'books' ? books : photos;
    saveKind(kind, state);
  }, 500);
}

/* ================= 图片预览 ================= */

const preview = document.createElement('div');
preview.className = 'img-preview';
preview.innerHTML = '<img alt="预览" />';
preview.addEventListener('click', () => preview.setAttribute('data-open', 'false'));
document.body.appendChild(preview);

function showPreview(src) {
  const img = preview.querySelector('img');
  img.src = src;
  preview.setAttribute('data-open', 'true');
}

/* ================= 模态框开关 ================= */

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute('data-open', 'true');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.setAttribute('data-open', 'false');
  document.body.style.overflow = '';
}

$$('.hobby-card').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    if (e.target.closest('.hobby-edit')) return;
    if (longPressFired) { longPressFired = false; return; }
    openModal(btn.dataset.hobby === 'reading' ? 'modal-reading' : 'modal-photo');
  });
});

$$('.hobby-modal').forEach((modal) => {
  $$('[data-close]', modal).forEach((el) => {
    el.addEventListener('click', () => closeModal(modal));
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.hobby-modal[data-open="true"]').forEach(closeModal);
    preview.setAttribute('data-open', 'false');
    if (bgEditor) bgEditor.setAttribute('data-open', 'false');
  }
});

/* ================= 相册上传 ================= */

async function handleFiles(files) {
  let changed = false;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 8 * 1024 * 1024) {
      alert(`「${file.name}」超过 8MB，请先压缩后再上传。`);
      continue;
    }
    try {
      const src = await compressImage(file, 1440, 0.82);
      photos.push({ id: Date.now() + Math.random(), src, caption: '', date: '' });
      changed = true;
    } catch (err) {
      alert('照片处理失败：' + err.message);
    }
  }
  if (changed) {
    renderPhotos();
    scheduleSave('photos');
  }
}

const photoInput = $('#photo-input');
$('#add-photo-btn')?.addEventListener('click', () => photoInput.click());

if (photoInput) {
  photoInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });
}

/* 拖拽上传 */
const photoGrid = $('#photo-grid');
if (photoGrid) {
  ['dragenter', 'dragover'].forEach((evt) => {
    photoGrid.addEventListener(evt, (e) => {
      e.preventDefault();
      photoGrid.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    photoGrid.addEventListener(evt, (e) => {
      e.preventDefault();
      photoGrid.classList.remove('dragover');
    });
  });
  photoGrid.addEventListener('drop', (e) => {
    handleFiles(e.dataTransfer.files);
  });
}

/* ================= 添加书籍 ================= */

$('#add-book-btn')?.addEventListener('click', () => {
  books.push({ id: Date.now(), title: '', author: '', thought: '', quote: '', cover: '' });
  renderBooks();
  scheduleSave('books');
  const scroll = $('.book-scroll');
  if (scroll) {
    requestAnimationFrame(() => {
      scroll.scrollTo({ left: scroll.scrollWidth, behavior: 'smooth' });
    });
  }
});

/* ================= 导出数据 ================= */

$('#export-books')?.addEventListener('click', () => {
  if (books.length === 0) { alert('还没有书籍可导出'); return; }
  downloadJson('qing-hobby-books.json', { kind: 'books', exportedAt: new Date().toISOString(), data: books });
});

$('#export-photos')?.addEventListener('click', () => {
  if (photos.length === 0) { alert('还没有照片可导出'); return; }
  downloadJson('qing-hobby-photos.json', { kind: 'photos', exportedAt: new Date().toISOString(), data: photos });
});

/* ================= 入口卡片背景图编辑器 ================= */

let bgState = null; // { target, natW, natH, dispW, dispH, offX, offY, boxCX, boxCY, boxLen }

/* 编辑器弹窗（动态创建） */
const bgEditor = document.createElement('div');
bgEditor.className = 'bg-editor';
bgEditor.setAttribute('aria-hidden', 'true');
bgEditor.innerHTML = `
  <div class="modal-backdrop" data-bgclose></div>
  <div class="modal-panel">
    <header class="modal-header">
      <div><h2 class="modal-title">更换背景图</h2></div>
      <button type="button" class="modal-close" data-bgclose aria-label="关闭">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
    </header>
    <div class="bg-editor-body">
      <label class="bg-file-label" for="bg-file-input">选择新图片</label>
      <input type="file" id="bg-file-input" accept="image/*" hidden />
      <div class="bg-preview-stage" id="bg-stage">
        <img id="bg-stage-img" alt="预览" />
        <div class="bg-crop-box" id="bg-crop-box"></div>
      </div>
      <div class="bg-zoom-row">
        <span>缩放</span>
        <input type="range" id="bg-zoom" min="40" max="100" value="90" aria-label="缩放取景框" />
      </div>
    </div>
    <footer class="modal-footer bg-actions">
      <button type="button" class="btn-ghost-mini" data-bgclose>取消</button>
      <button type="button" class="btn-primary-mini" id="bg-confirm">保存</button>
    </footer>
  </div>`;
document.body.appendChild(bgEditor);

const bgStage = $('#bg-stage', bgEditor);
const bgStageImg = $('#bg-stage-img', bgEditor);
const bgCropBox = $('#bg-crop-box', bgEditor);
const bgZoom = $('#bg-zoom', bgEditor);
const bgFileInput = $('#bg-file-input', bgEditor);

/* 关闭编辑器 */
function closeBgEditor() {
  bgEditor.setAttribute('data-open', 'false');
  document.body.style.overflow = '';
  bgState = null;
}

/* 打开编辑器 */
function openBgEditor(target) {
  const card = $(`.hobby-card[data-hobby="${target}"]`);
  const currentSrc = card ? card.querySelector('.hobby-bg').src : '';
  bgState = { target };
  const img = new Image();
  img.onload = () => {
    bgState.natW = img.naturalWidth;
    bgState.natH = img.naturalHeight;
    bgStageImg.src = currentSrc;
    /* 默认取景：居中，覆盖 90% 短边 */
    bgState.boxLen = 0.9;
    bgState.boxCX = 0.5;
    bgState.boxCY = 0.5;
    bgZoom.value = 90;
    layoutBgStage();
    bgEditor.setAttribute('data-open', 'true');
    document.body.style.overflow = 'hidden';
  };
  img.src = currentSrc; // 复用当前卡片背景（可能是云端自定义图）
}

/* 计算 contain 显示区域 + 更新取景框 */
function layoutBgStage() {
  const stageW = bgStage.clientWidth || 400;
  const stageH = bgStage.clientHeight || 400;
  const scale = Math.min(stageW / bgState.natW, stageH / bgState.natH);
  bgState.dispW = bgState.natW * scale;
  bgState.dispH = bgState.natH * scale;
  bgState.offX = (stageW - bgState.dispW) / 2;
  bgState.offY = (stageH - bgState.dispH) / 2;
  renderCropBox();
}

function renderCropBox() {
  const len = bgState.boxLen * Math.min(bgState.dispW, bgState.dispH);
  const cx = Math.min(Math.max(bgState.boxCX * bgState.dispW + bgState.offX, bgState.offX + len / 2), bgState.offX + bgState.dispW - len / 2);
  const cy = Math.min(Math.max(bgState.boxCY * bgState.dispH + bgState.offY, bgState.offY + len / 2), bgState.offY + bgState.dispH - len / 2);
  const box = bgCropBox;
  box.style.left = (cx - len / 2) + 'px';
  box.style.top = (cy - len / 2) + 'px';
  box.style.width = len + 'px';
  box.style.height = len + 'px';
  bgState._len = len;
  bgState._cx = cx;
  bgState._cy = cy;
}

/* 拖动取景框 */
let drag = null;
bgStage.addEventListener('pointerdown', (e) => {
  if (!bgState) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  drag = { startX, startY, cx: bgState._cx, cy: bgState._cy };
  bgStage.setPointerCapture(e.pointerId);
});

bgStage.addEventListener('pointermove', (e) => {
  if (!drag || !bgState) return;
  const len = bgState._len;
  const minX = bgState.offX + len / 2;
  const maxX = bgState.offX + bgState.dispW - len / 2;
  const minY = bgState.offY + len / 2;
  const maxY = bgState.offY + bgState.dispH - len / 2;
  const cx = Math.min(Math.max(drag.cx + (e.clientX - drag.startX), minX), maxX);
  const cy = Math.min(Math.max(drag.cy + (e.clientY - drag.startY), minY), maxY);
  bgState.boxCX = (cx - bgState.offX) / bgState.dispW;
  bgState.boxCY = (cy - bgState.offY) / bgState.dispH;
  renderCropBox();
});

bgStage.addEventListener('pointerup', () => { drag = null; });
bgStage.addEventListener('pointercancel', () => { drag = null; });

/* 缩放滑块 */
bgZoom.addEventListener('input', () => {
  if (!bgState) return;
  bgState.boxLen = Number(bgZoom.value) / 100;
  renderCropBox();
});

/* 选择新图 */
bgFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || !bgState) return;
  if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      bgState.natW = img.naturalWidth;
      bgState.natH = img.naturalHeight;
      bgStageImg.src = reader.result;
      bgState.boxLen = 0.9;
      bgState.boxCX = 0.5;
      bgState.boxCY = 0.5;
      bgZoom.value = 90;
      layoutBgStage();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

/* 确认：裁切正方形 → 保存 */
bgEditor.querySelector('#bg-confirm').addEventListener('click', async () => {
  if (!bgState) return;
  const { natW, natH } = bgState;
  const lenDisp = bgState._len;
  const minDisp = Math.min(bgState.dispW, bgState.dispH);
  const len = lenDisp / minDisp * Math.min(natW, natH);
  const sx = (bgState._cx - bgState.offX) / bgState.dispW * natW;
  const sy = (bgState._cy - bgState.offY) / bgState.dispH * natH;
  const px = Math.min(Math.max(Math.round(sx - len / 2), 0), Math.max(natW - len, 0));
  const py = Math.min(Math.max(Math.round(sy - len / 2), 0), Math.max(natH - len, 0));
  const cropLen = Math.round(Math.min(len, natW - px, natH - py));

  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 900;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, 900, 900);
  try {
    ctx.drawImage(bgStageImg, px, py, cropLen, cropLen, 0, 0, 900, 900);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    profile[bgState.target === 'reading' ? 'bgReading' : 'bgPhoto'] = dataUrl;
    await saveProfile();
    closeBgEditor();
  } catch (err) {
    alert('处理失败：' + err.message);
  }
});

/* 关闭按钮 / 遮罩 */
$$('[data-bgclose]', bgEditor).forEach((el) => {
  el.addEventListener('click', closeBgEditor);
});

/* 长按入口卡片进入编辑（桌面 hover 按钮 + 长按均触发） */
let longPressFired = false;

$$('.hobby-card').forEach((card) => {
  const editBtn = card.querySelector('.hobby-edit');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openBgEditor(card.dataset.hobby);
  });

  let longPressTimer = null;
  let pressStart = null;

  const start = (e) => {
    if (e.target.closest('.hobby-edit')) return;
    pressStart = { x: e.clientX, y: e.clientY };
    longPressFired = false;
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      openBgEditor(card.dataset.hobby);
    }, 550);
  };
  const cancel = () => {
    clearTimeout(longPressTimer);
    pressStart = null;
  };

  card.addEventListener('pointerdown', start);
  card.addEventListener('pointermove', (e) => {
    if (!pressStart) return;
    if (Math.abs(e.clientX - pressStart.x) > 15 || Math.abs(e.clientY - pressStart.y) > 15) {
      cancel();
    }
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointerleave', cancel);
  card.addEventListener('pointercancel', cancel);
});

/* ================= 初始化 ================= */

const books = readCache(STORE_KEYS.books, [
  { id: 1, title: '平面国', author: '埃德温·A·艾勃特', thought: '一本讲维度与偏见的几何寓言，读完再看世界会不一样。', quote: '向上，而不是向北。', cover: '' },
  { id: 2, title: '我弥留之际', author: '威廉·福克纳', thought: '多视角叙事像把真相切成碎片，读者自己拼。', quote: '福克纳用又怪又准的比喻、跳跃脱轨的联想，拼凑出一场荒诞到极致的送葬之旅。', cover: '' },
  { id: 3, title: '译边草', author: '周克希', thought: '翻译是把作者的语言变成自己的语言。', quote: '过度忠于原文反而不好。要想象自己是作者，仔细揣度，然后用中文表达出来。', cover: '' }
]);
const photos = readCache(STORE_KEYS.photos, []);
let profile = readCache(STORE_KEYS.profile, {});

renderBooks();
renderPhotos();
applyProfileBg();

if (API_BASE) {
  loadKind('books', books);
  loadKind('photos', photos);
  loadProfile();
}
