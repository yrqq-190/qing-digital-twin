/**
 * 自留地模块：文学与阅读 / 摄影与生活
 *
 * 存储策略：Cloudflare KV（云端）为主，localStorage 为离线缓存。
 * - 打开页面：先渲染本地缓存，再向云端拉最新数据覆盖；
 * - 任何修改：自动保存到云端（写入口令），成功后同步本地缓存；
 * - 云端不可达：修改仍保留在本地缓存，下次联网会再尝试同步。
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
        // 透明 PNG 先铺白底，避免 JPEG 压缩后变黑
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

function renderBooks() {
  const list = $('#book-list');
  if (!list) return;
  list.innerHTML = '';

  if (books.length === 0) {
    list.innerHTML = '<p class="empty-hint">还没有书籍，点下方「添加一本书」开始记录吧</p>';
    return;
  }

  books.forEach((book) => {
    const item = document.createElement('div');
    item.className = 'book-item';
    item.dataset.id = book.id;

    const coverHtml = book.cover
      ? `<img src="${book.cover}" alt="封面" />`
      : '<span class="book-cover-placeholder">书</span>';

    item.innerHTML = `
      <label class="book-cover" title="点击上传封面">
        ${coverHtml}
        <input type="file" accept="image/*" class="cover-input" hidden />
      </label>
      <div class="book-fields">
        <input class="book-title-input" placeholder="书名" value="${escapeHtml(book.title)}" />
        <input class="book-author-input" placeholder="作者" value="${escapeHtml(book.author)}" />
        <textarea class="book-quote-input" placeholder="摘录打动你的一句话，或者写点感受…">${escapeHtml(book.quote)}</textarea>
      </div>
      <button class="book-delete" title="删除这本书" aria-label="删除">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" /><path d="M14 11v6" />
        </svg>
      </button>
    `;

    // 封面上传
    const coverLabel = item.querySelector('.book-cover');
    const coverInput = item.querySelector('.cover-input');
    coverLabel.addEventListener('click', (e) => {
      if (e.target === coverInput || e.target.closest('img')) return;
      coverInput.click();
    });
    coverInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await compressImage(file, 480, 0.85);
        book.cover = dataUrl;
        scheduleSave('books');
        renderBooks();
      } catch (err) {
        alert('封面压缩失败：' + err.message);
      }
      e.target.value = '';
    });

    // 点击已上传的封面 → 预览大图
    const coverImg = item.querySelector('.book-cover img');
    if (coverImg) {
      coverImg.addEventListener('click', (e) => {
        e.stopPropagation();
        showPreview(book.cover);
      });
    }

    // 文本编辑
    const bindInput = (input, field) => {
      input.addEventListener('input', () => {
        book[field] = input.value;
        scheduleSave('books');
      });
    };
    bindInput(item.querySelector('.book-title-input'), 'title');
    bindInput(item.querySelector('.book-author-input'), 'author');
    bindInput(item.querySelector('.book-quote-input'), 'quote');

    // 删除
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

function renderPhotos() {
  const grid = $('#photo-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (photos.length === 0) {
    grid.innerHTML = '<p class="empty-hint">还没有照片，点上方区域上传第一张吧</p>';
    return;
  }

  photos.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'photo-item';
    item.innerHTML = `
      <img src="${p.src}" alt="生活照片" loading="lazy" />
      <button class="photo-delete" title="删除这张照片" aria-label="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>
    `;
    item.querySelector('img').addEventListener('click', () => showPreview(p.src));
    item.querySelector('.photo-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('删除这张照片？')) return;
      const idx = photos.findIndex((x) => x.id === p.id);
      if (idx >= 0) photos.splice(idx, 1);
      scheduleSave('photos');
      renderPhotos();
    });
    grid.appendChild(item);
  });
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
const uploadZone = $('.upload-zone');

if (photoInput) {
  photoInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
  });
}

if (uploadZone) {
  uploadZone.addEventListener('click', () => photoInput.click());
  ['dragenter', 'dragover'].forEach((evt) => {
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    uploadZone.addEventListener(evt, (e) => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
    });
  });
  uploadZone.addEventListener('drop', (e) => {
    handleFiles(e.dataTransfer.files);
  });
}

/* ================= 添加书籍 ================= */

$('#add-book-btn')?.addEventListener('click', () => {
  books.push({ id: Date.now(), title: '', author: '', quote: '', cover: '' });
  renderBooks();
  scheduleSave('books');
  const last = $('#book-list .book-item:last-child');
  if (last) last.querySelector('.book-title-input').focus();
});

/* ================= 初始化 ================= */

// 状态：内存数组（含云端与缓存合并后的数据）
const books = readCache(STORE_KEYS.books, [
  { id: 1, title: '平面国', author: '埃德温·A·艾勃特', quote: '向上，而不是向北。', cover: '' },
  { id: 2, title: '我弥留之际', author: '威廉·福克纳', quote: '福克纳用又怪又准的比喻、跳跃脱轨的联想，拼凑出一场荒诞到极致的送葬之旅。', cover: '' },
  { id: 3, title: '译边草', author: '周克希', quote: '过度忠于原文反而不好。要想象自己是作者，仔细揣度，然后用中文表达出来。', cover: '' }
]);
const photos = readCache(STORE_KEYS.photos, []);

renderBooks();
renderPhotos();

// 云端数据（若可用）覆盖缓存
if (API_BASE) {
  loadKind('books', books);
  loadKind('photos', photos);
}
