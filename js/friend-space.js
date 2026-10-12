/**
 * 朋友空间：留言墙 + 来访卡 + 分身记忆打通
 * 留言存云端 messages 集合；访客名字/口令信物存浏览器本地。
 */
import { CONFIG } from './config.js?v=20261015';

const API_BASE = CONFIG.BACKEND_URL;
const FRIENDS = CONFIG.FRIENDS || [];
const PASS_KEY = 'friend:pass:v1';
const NAME_KEY = 'friend:name:v1';
const ADMIN_KEY = 'hobby:token:v1';
const EDITS_KEY = 'friend:edits:v1';

function getEditToken(id) {
  const map = readCache(EDITS_KEY, {});
  return map[id] || '';
}

function saveEditToken(id, token) {
  const map = readCache(EDITS_KEY, {});
  map[id] = token;
  writeCache(EDITS_KEY, map);
}

function removeEditToken(id) {
  const map = readCache(EDITS_KEY, {});
  if (map[id]) {
    delete map[id];
    writeCache(EDITS_KEY, map);
  }
}

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

/* 朋友口令：精确匹配到对应好友，本地只存好友内部标识（不存口令本身） */
function friendState() {
  if (!FRIENDS.length) return null;
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(PASS_KEY) || ''); } catch { stored = null; }
  if (!stored || !stored.key) return null;
  const friend = FRIENDS.find((f) => f.key === stored.key);
  if (!friend) return null;
  return { isFriend: true, friend };
}

/* ---------- 记忆打通：留言成为分身认识朋友的锚点 ---------- */

window.__friendMemory = () => {
  const recent = messages.filter((m) => m.visibility !== 'private').slice(0, 3);
  if (!recent.length) return '';
  return recent.map((m) => `- ${m.name || '匿名'}：${String(m.content || '').slice(0, 40)}`).join('\n');
};

window.__friendState = () => {
  const st = friendState();
  if (!st || !st.friend) return { isFriend: false };
  const f = st.friend;
  /* 只暴露人设内容给分身，口令绝不外泄 */
  const { pass, ...profile } = f;
  return { isFriend: true, friend: profile };
};

/* ---------- 云端读写 ---------- */

async function fetchMessages() {
  if (!API_BASE) return false;
  const headers = {};
  const t = getAdminToken();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  try {
    const res = await fetch(`${API_BASE}/api/messages`, { headers });
    if (!res.ok) return false;
    const json = await res.json();
    if (!json.ok) return false;
    messages = json.messages || [];
    isAdmin = Boolean(t);
    renderWall();
    return true;
  } catch { return false; }
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
    if (json.id && json.editToken) saveEditToken(json.id, json.editToken);
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
  const et = getEditToken(id);
  if (!t && !et) { hint('这条留言不是你发的，不能删除', 'is-err'); return; }
  if (!confirm('删除这条留言？')) return;
  try {
    const headers = {};
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const url = `${API_BASE}/api/messages?id=${encodeURIComponent(id)}` + (et ? `&editToken=${encodeURIComponent(et)}` : '');
    const res = await fetch(url, { method: 'DELETE', headers });
    const json = await res.json();
    if (!json.ok) {
      hint(json.error || '删除失败', 'is-err');
      return;
    }
    removeEditToken(id);
    fetchMessages();
  } catch {
    hint('网络不太通，稍后再试', 'is-err');
  }
}

async function saveMessageEdit(m, content) {
  const t = getAdminToken();
  const et = getEditToken(m.id);
  if (!t && !et) { hint('这条留言不是你发的，不能修改', 'is-err'); return false; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const body = { content };
    if (et && !t) body.editToken = et;
    const res = await fetch(`${API_BASE}/api/messages?id=${encodeURIComponent(m.id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      hint(json.error || '修改失败', 'is-err');
      return false;
    }
    return true;
  } catch {
    hint('网络不太通，稍后再试', 'is-err');
    return false;
  }
}

function startEdit(m) {
  const card = document.querySelector(`.visit-card[data-id="${CSS.escape(m.id)}"]`);
  if (!card) return;
  const text = card.querySelector('.visit-text');
  if (!text) return;
  const editArea = document.createElement('div');
  editArea.className = 'visit-edit-area';
  editArea.innerHTML = `
    <textarea class="visit-edit-input" maxlength="500">${escapeHtml(m.content)}</textarea>
    <div class="visit-edit-actions">
      <button type="button" class="visit-edit-save">保存</button>
      <button type="button" class="visit-edit-cancel">取消</button>
    </div>`;
  text.replaceWith(editArea);
  const ta = editArea.querySelector('.visit-edit-input');
  const save = editArea.querySelector('.visit-edit-save');
  const cancel = editArea.querySelector('.visit-edit-cancel');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const doSave = async () => {
    const content = ta.value.trim().slice(0, 500);
    if (!content) { hint('内容不能为空', 'is-err'); return; }
    save.disabled = true;
    const ok = await saveMessageEdit(m, content);
    if (ok) { hint('已修改', 'is-ok'); fetchMessages(); }
    else save.disabled = false;
  };
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', () => fetchMessages());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); }
  });
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

function canManage(m) {
  return isAdmin || Boolean(getEditToken(m.id));
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
    card.dataset.id = m.id;
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
      ${canManage(m) ? `<div class="visit-ops">
        <button class="visit-edit" data-id="${escapeHtml(m.id)}" title="修改" aria-label="修改">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button class="visit-del" data-id="${escapeHtml(m.id)}" title="删除" aria-label="删除">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      </div>` : ''}
    `;

    const img = card.querySelector('.visit-img');
    if (img) {
      img.addEventListener('click', () => showPreview(img.src, `${m.name || '匿名'} · ${formatDate(m.createdAt)}`));
    }
    const del = card.querySelector('.visit-del');
    if (del) {
      del.addEventListener('click', () => deleteMessage(del.dataset.id));
    }
    const edit = card.querySelector('.visit-edit');
    if (edit) {
      edit.addEventListener('click', () => startEdit(m));
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

/* ---------- 统一口令入口 ---------- */

function submitPass(v) {
  if (!v) return;
  const hit = FRIENDS.find((f) => f.pass === v);
  if (hit) {
    localStorage.setItem(PASS_KEY, JSON.stringify({ key: hit.key }));
    hint('已识别为朋友，欢迎回来', 'is-ok');
    return;
  }
  localStorage.setItem(ADMIN_KEY, v);
  fetchMessages().then((ok) => {
    if (ok) {
      hint('已进入管理模式', 'is-ok');
    } else {
      localStorage.removeItem(ADMIN_KEY);
      isAdmin = false;
      renderWall();
      hint('口令不对哦', 'is-err');
    }
    updatePassPanel();
  });
}

/* 退出朋友/管理模式：清掉本地信物，分身回到普通访客模式 */
function exitPassMode() {
  localStorage.removeItem(PASS_KEY);
  localStorage.removeItem(ADMIN_KEY);
  isAdmin = false;
  renderWall();
  hint('已退出当前模式', 'is-ok');
  updatePassPanel();
}

/* 有生效的模式时显示"退出"按钮 */
function updatePassPanel() {
  const btn = $('#f-pass-exit');
  if (!btn) return;
  const hasFriend = !!friendState();
  const hasAdmin = !!localStorage.getItem(ADMIN_KEY);
  btn.hidden = !(hasFriend || hasAdmin);
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
  const box = $('#f-pass-box');
  if (box) box.hidden = true;
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

  /* 统一口令入口：右下角小按钮，展开输入框 */
  const passToggle = $('#f-pass-toggle');
  const passBox = $('#f-pass-box');
  if (passToggle && passBox) {
    passToggle.addEventListener('click', () => {
      passBox.hidden = !passBox.hidden;
      if (!passBox.hidden) $('#f-pass-input').focus();
    });
  }
  $('#f-pass-input').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    e.target.value = '';
    if (passBox) passBox.hidden = true;
    submitPass(v);
  });
  $('#f-pass-exit').addEventListener('click', exitPassMode);
  updatePassPanel();
  $('#f-pass-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      e.target.value = '';
      if (passBox) passBox.hidden = true;
      submitPass(v);
    }
  });

  fetchMessages();
}

init();
