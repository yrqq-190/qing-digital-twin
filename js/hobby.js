/**
 * 自留地模块：文学与阅读 / 摄影与生活
 *
 * 存储策略：Cloudflare KV（云端）为主，localStorage 为离线缓存。
 * - 打开页面：先渲染本地缓存，再向云端拉最新数据覆盖；
 * - 任何修改：自动保存到云端（写入口令），成功后同步本地缓存；
 * - 云端不可达：修改仍保留在本地缓存，下次联网会再尝试同步。
 * - 导出数据：下载 JSON 备份（本地文件），可随时恢复。
 */
import { CONFIG } from './config.js';

const API_BASE = CONFIG.BACKEND_URL;
const STORE_KEYS = { books: 'hobby:books:v1', photos: 'hobby:photos:v1', token: 'hobby:token:v1' };

/* ================= 工具函数 ================= */

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
  } catch {
    /* 存储满时静默降级：云端仍是权威数据源 */
  }
}

function getToken() {
  return localStorage.getItem(STORE_KEYS.token) || '';
}

function setToken(t) {
  localStorage.setItem(STORE_KEYS.token, t);
}

function showSync(kind, message, isError = false) {
  const bar = document.getElementById(kind === 'photos' ? 'hobby-sync-photos' : 'hobby-sync-books');
  if (!bar) return;
  bar.textContent = message;
  bar.classList.toggle('is-error', isError);
  bar.setAttribute('data-show', 'true');
  clearTimeout(showSync._t);
  showSync._t = setTimeout(() => bar.setAttribute('data-show', 'false'), isError ? 6000 : 2500);
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

/** 下载 JSON 备份文件 */
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

async function fetchCloud(kind, method = 'GET', data = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/${kind}`, {
    method,
    headers,
    body: data ? JSON.stringify({ data }) : undefined
  });
  return res;
}

/** 云端拉取并更新内存 + 缓存；失败时保持缓存数据，不抛错 */
async function loadKind(kind, state) {
  try {
    const res = await fetchCloud(kind);
    if (!res.ok) throw new Error(`云端读取失败（${res.status}）`);
    const json = await res.json();
    if (json.ok && Array.isArray(json.data)) {
      state.length = 0;
      state.push(...json.data);
      writeCache(STORE_KEYS[kind], state);
      render(kind);
    }
  } catch {
    // 离线或 Worker 不可达：使用缓存数据，不影响浏览
  }
}

/** 保存到云端；返回 true 表示已同步云端 */
async function saveKind(kind, state) {
  writeCache(STORE_KEYS[kind], state);
  let token = getToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchCloud(kind, 'POST', state);
      if (res.ok) {
        showSync(kind, '已同步到云端');
        return true;
      }
      if (res.status === 401) {
        const input = prompt('写入口令错误。请输入写入口令（用于修改文学/摄影内容，访问者不需要）：');
        if (!input) {
          showSync(kind, '未保存到云端（已留在本地缓存）', true);
          return false;
        }
        setToken(input.trim());
        token = input.trim();
        continue;
      }
      showSync(kind, `云端保存失败（${res.status}），已留在本地缓存`, true);
      return false;
    } catch {
      showSync(kind, '网络不可达，修改已留在本地缓存，联网后会自动同步', true);
      return false;
    }
  }
  return false;
}

/* ================= 渲染 ================= */

function render(kind) {
  if (kind === 'books') renderBooks();
  else renderPhotos();
}

/* ---- 书籍：横向卡片流 ---- */

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
           <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
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

    /* 已上传封面的预览 */
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

    /* 金句：双击纸片进入编辑 */
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

/* ---- 相册 ---- */

function renderPhotos() {
  const grid = $('#photo-grid');
  if (!grid) return;
  const addBtn = $('#add-photo-btn');

  const items = photos.map((p) => {
    const el = document.createElement('div');
    el.className = 'photo-item';
    el.innerHTML = `
      <img src="${p.src}" alt="生活照片" loading="lazy" />
      <button class="photo-delete" title="删除这张照片" aria-label="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
    `;
    el.querySelector('img').addEventListener('click', () => showPreview(p.src));
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
  btn.addEventListener('click', () => {
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
      photos.push({ id: Date.now() + Math.random(), src });
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

/* 拖拽上传：拖到相册区域 */
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

/* ================= 导出数据（本地备份） ================= */

$('#export-books')?.addEventListener('click', () => {
  if (books.length === 0) {
    showSync('books', '还没有书籍可导出');
    return;
  }
  downloadJson('qing-hobby-books.json', { kind: 'books', exportedAt: new Date().toISOString(), data: books });
  showSync('books', '已导出书籍备份（JSON）');
});

$('#export-photos')?.addEventListener('click', () => {
  if (photos.length === 0) {
    showSync('photos', '还没有照片可导出');
    return;
  }
  downloadJson('qing-hobby-photos.json', { kind: 'photos', exportedAt: new Date().toISOString(), data: photos });
  showSync('photos', '已导出照片备份（JSON）');
});

/* ================= 初始化 ================= */

const books = readCache(STORE_KEYS.books, [
  { id: 1, title: '平面国', author: '埃德温·A·艾勃特', thought: '一本讲维度与偏见的几何寓言，读完再看世界会不一样。', quote: '向上，而不是向北。', cover: '' },
  { id: 2, title: '我弥留之际', author: '威廉·福克纳', thought: '多视角叙事像把真相切成碎片，读者自己拼。', quote: '福克纳用又怪又准的比喻、跳跃脱轨的联想，拼凑出一场荒诞到极致的送葬之旅。', cover: '' },
  { id: 3, title: '译边草', author: '周克希', thought: '翻译是把作者的语言变成自己的语言。', quote: '过度忠于原文反而不好。要想象自己是作者，仔细揣度，然后用中文表达出来。', cover: '' }
]);
const photos = readCache(STORE_KEYS.photos, []);

renderBooks();
renderPhotos();

if (API_BASE) {
  loadKind('books', books);
  loadKind('photos', photos);
}
