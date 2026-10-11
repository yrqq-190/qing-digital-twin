/**
 * 朋友空间：留言墙 + 来访卡 + 分身记忆打通
 * 留言存云端 messages 集合；访客名字/口令信物存浏览器本地。
 */
import { CONFIG } from './config.js';

const API_BASE = CONFIG.BACKEND_URL;
const FRIEND_PASS = CONFIG.FRIEND_PASS || '';
const PASS_KEY = 'friend:pass:v1';
const NAME_KEY = 'friend:name:v1';
const ADMIN_KEY = 'hobby:token:v1';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(v) {
  return String(v == null ? '' : v)
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
  } catch { return fallback; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 满时静默 */ }
}

/** 图片压缩：缩放至最长边 maxDim，输出 JPEG dataURL */
function compressImage(file, maxDim, quality = 0.8) {
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

/* ---------- 头像色块 ---------- */

const AVATAR_COLORS = ['#4A6E51', '#C88E71', '#8A9B8E', '#B87F62', '#5F7A6B', '#D4A98C'];

function avatarColor(name) {
  let h = 7;
  for (const c of String(name || '访客')) h = (h * 31 + (c.codePointAt(0) || 0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarChar(name) {
  const n = String(name || '访客').trim();
  return n ? n.slice(0, 1) : '访';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------- 状态 ---------- */

let messages = [];
let isAdmin = false;
let currentImage = null;
let messageBusy = false;

function getAdminToken() { return localStorage.getItem(ADMIN_KEY) || ''; }
function isFriend() { return Boolean(FRIEND_PASS) && (localStorage.getItem(PASS_KEY) || '') === FRIEND_PASS; }

/* ---------- 记忆打通：留言成为分身认识朋友的锚点 ---------- */

window.__friendMemory = () => {
  const recent = messages.filter((m) => m.visibility !== 'private').slice(0, 8);
  if (!recent.length) return '';
  return recent.map((m) => `- ${m.name || '匿名'}：${String(m.content || '').slice(0, 60)}`).join('\n');
};

window.__friendState = () => ({ isFriend: isFriend() });

/* ---------- 云端读写 ---------- */

async function fetchMessages() {
  if (!API_BASE) return;
  const headers = {};
  const t = getAdminToken();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  try {
    const res = await fetch(`${API_BASE}/api/messages`, { headers });
    if (!res.ok) return;
    const json = await res.json();
    if (json.ok) {
      messages = json.messages || [];
      isAdmin = Boolean(t);
      syncAdminUi();
      renderWall();
    }
  } catch { /* 离线静默 */ }
}

async function sendMessage() {
  if (messageBusy || !API_BASE) return;
  const name = $('#f-name').value.trim().slice(0, 20);
  const content = $('#f-content').value.trim().slice(0, 500);
  if (!name || !content) {
    hint('名字和想说的话都要填一下', 'is-err');
    return;
  }
  messageBusy = true;
  $('#f-send').disabled = true;
  const visibility = $('#f-visibility').dataset.mode === 'private' ? 'private' : 'public';
  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content, image: currentImage, visibility })
    });
    const json = await res.json();
    if (!json.ok) {
      hint(json.error || '留言失败，稍后再试', 'is-err');
      return;
    }
    localStorage.setItem(NAME_KEY, name);
    $('#f-content').value = '';
    currentImage = null;
    renderImagePreview();
    if (visibility === 'private') {
      hint('已悄悄告诉她啦', 'is-ok');
    } else {
      hint('留言成功', 'is-ok');
    }
    fetchMessages();
  } catch {
    hint('网络不太通，稍后再试', 'is-err');
  } finally {
    messageBusy = false;
    $('#f-send').disabled = false;
  }
}

async function deleteMessage(id) {
  const t = getAdminToken();
  if (!t) { hint('需要先进入管理模式', 'is-err'); return; }
  if (!confirm('删除这条留言？')) return;
  try {
    const res = await fetch(`${API_BASE}/api/messages?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t}` }
    });
    const json = await res.json();
    if (!json.ok) {
      hint(json.error || '删除失败', 'is-err');
      return;
    }
    fetchMessages();
  } catch {
    hint('网络不太通，稍后再试', 'is-err');
  }
}

/* ---------- 渲染 ---------- */

function hint(text, cls) {
  const el = $('#f-hint');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'f-hint' + (cls ? ' ' + cls : '');
  clearTimeout(hint._t);
  hint._t = setTimeout(() => { el.textContent = ''; el.className = 'f-hint'; }, 2600);
}

function renderWall() {
  const wall = $('#friend-wall');
  if (!wall) return;
  const list = messages.filter((m) => m.visibility !== 'private' || isAdmin);
  wall.innerHTML = '';

  if (!list.length) {
    wall.innerHTML = '<p class="empty-hint" style="text-align:center;padding:30px 0;color:#9ca39c;font-size:13px;">还没有留言，来写第一条吧</p>';
    return;
  }

  for (const m of list) {
    const card = document.createElement('div');
    card.className = 'visit-card';
    const isPrivate = m.visibility === 'private';

    card.innerHTML = `
      <span class="visit-avatar" style="background:${avatarColor(m.name)}">${escapeHtml(avatarChar(m.name))}</span>
      <div class="visit-main">
        <div class="visit-head">
          <span class="visit-name">${escapeHtml(m.name || '匿名')}</span>
          ${isPrivate ? '<span class="visit-private-tag">悄悄话</span>' : ''}
          <span class="visit-date">${escapeHtml(formatDate(m.createdAt))}</span>
        </div>
        <p class="visit-text">${escapeHtml(m.content)}</p>
        ${m.image ? `<img class="visit-img" src="${m.image}" alt="留言图片" />` : ''}
      </div>
      ${isAdmin ? `<button class="visit-del" data-id="${escapeHtml(m.id)}" title="删除" aria-label="删除">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6L6 18" /><path d="M6 6l12 12" />
        </svg>
      </button>` : ''}
    `;

    const img = card.querySelector('.visit-img');
    if (img) {
      img.addEventListener('click', () => showPreview(img.src, `${m.name || '匿名'} · ${formatDate(m.createdAt)}`));
    }
    const del = card.querySelector('.visit-del');
    if (del) {
      del.addEventListener('click', () => deleteMessage(del.dataset.id));
    }
    wall.appendChild(card);
  }
}

function renderImagePreview() {
  const box = $('#f-image-preview');
  if (!box) return;
  if (currentImage) {
    box.classList.add('has-img');
    const img = box.querySelector('img');
    img.src = currentImage;
  } else {
    box.classList.remove('has-img');
  }
}

/* ---------- 图片预览（复用自留地的预览层） ---------- */

function showPreview(src, metaText) {
  const pv = document.querySelector('.img-preview');
  if (!pv) return;
  const img = pv.querySelector('img');
  img.src = src;
  const meta = pv.querySelector('.img-preview-meta');
  meta.textContent = metaText || '';
  meta.style.display = metaText ? '' : 'none';
  pv.setAttribute('data-open', 'true');
}

/* ---------- 管理 ---------- */

function syncAdminUi() {
  const btn = $('#f-admin-btn');
  if (!btn) return;
  if (isAdmin) {
    btn.textContent = '管理模式';
    btn.classList.add('is-on');
    $('#f-admin-box').hidden = true;
  } else if (getAdminToken()) {
    btn.textContent = '管理';
    btn.classList.remove('is-on');
    $('#f-admin-box').hidden = false;
  }
}

function toggleAdmin() {
  const box = $('#f-admin-box');
  if (isAdmin) {
    localStorage.removeItem(ADMIN_KEY);
    isAdmin = false;
    box.hidden = false;
    $('#f-admin-btn').textContent = '管理';
    $('#f-admin-btn').classList.remove('is-on');
    fetchMessages();
    return;
  }
  box.hidden = !box.hidden;
  if (!box.hidden) $('#f-admin-pass').focus();
}

function submitAdmin() {
  const pass = $('#f-admin-pass').value.trim();
  if (!pass) return;
  localStorage.setItem(ADMIN_KEY, pass);
  $('#f-admin-pass').value = '';
  fetchMessages();
}

/* ---------- 模态框开关 ---------- */

function openFriend() {
  const el = $('#modal-friend');
  if (!el) return;
  el.setAttribute('data-open', 'true');
  document.body.style.overflow = 'hidden';
  fetchMessages();
}

function closeFriend() {
  $('#modal-friend').setAttribute('data-open', 'false');
  document.body.style.overflow = '';
}

/* ---------- 初始化 ---------- */

function init() {
  const fab = $('#friend-fab');
  if (fab) fab.addEventListener('click', openFriend);

  const modal = $('#modal-friend');
  if (!modal) return;

  $$('[data-fclose]', modal).forEach((el) => el.addEventListener('click', closeFriend));

  const nameInput = $('#f-name');
  const savedName = localStorage.getItem(NAME_KEY) || '';
  if (savedName && nameInput) nameInput.value = savedName;

  /* 悄悄话切换 */
  const visBtn = $('#f-visibility');
  visBtn.addEventListener('click', () => {
    const isPrivate = visBtn.dataset.mode === 'private';
    visBtn.dataset.mode = isPrivate ? 'public' : 'private';
    visBtn.classList.toggle('is-private', !isPrivate);
    visBtn.textContent = isPrivate ? '公开留言' : '悄悄话';
  });

  /* 图片上传 */
  const fileInput = $('#f-image');
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { hint('请选择图片文件', 'is-err'); return; }
    if (file.size > 8 * 1024 * 1024) { hint('图片太大，先压缩一下再传', 'is-err'); return; }
    try {
      currentImage = await compressImage(file, 800, 0.8);
      renderImagePreview();
    } catch (err) {
      hint('图片处理失败', 'is-err');
    }
  });

  const clearImg = $('#f-image-clear');
  if (clearImg) clearImg.addEventListener('click', () => {
    currentImage = null;
    renderImagePreview();
  });

  /* 发送 */
  $('#f-send').addEventListener('click', sendMessage);
  $('#f-content').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  /* 好友口令 */
  $('#f-pass-input').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (!FRIEND_PASS) { hint('朋友口令尚未开放', 'is-err'); return; }
    if (v === FRIEND_PASS) {
      localStorage.setItem(PASS_KEY, v);
      hint('已识别为朋友，欢迎回来', 'is-ok');
    } else {
      hint('口令不对哦', 'is-err');
    }
  });

  /* 管理 */
  $('#f-admin-btn').addEventListener('click', toggleAdmin);
  $('#f-admin-ok').addEventListener('click', submitAdmin);
  $('#f-admin-pass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdmin();
  });

  fetchMessages();
}

init();
