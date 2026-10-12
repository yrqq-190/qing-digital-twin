/**
 * UI 渲染层：负责所有 DOM 操作（消息、打字指示器、流式气泡、状态栏）。
 * 不包含业务逻辑，只提供渲染与交互原语。
 */
import { CONFIG } from './config.js?v=20261014';

const dom = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  clear: document.getElementById('clear'),
  quickWrap: document.getElementById('quick-questions'),
  statusText: document.getElementById('status-text'),
  statusDot: document.querySelector('.status-dot'),
  resumeBtn: document.getElementById('download-resume')
};

export { dom };

/* ---------- 滚动 ---------- */

export function scrollToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

/** 流式输出时保持贴底：用户没往上翻才自动跟随 */
export function pinScroll() {
  const el = dom.messages;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  if (nearBottom) scrollToBottom();
}

/* ---------- 消息渲染 ---------- */

function makeRow(role, innerHtml) {
  const row = document.createElement('div');
  row.className = role === 'user' ? 'row user' : 'row';
  row.innerHTML = innerHtml;
  dom.messages.appendChild(row);
  scrollToBottom();
  return row;
}

/** 渲染一条完整消息（user 保留原文；assistant 走 Markdown） */
export function renderMessage(role, text) {
  if (role === 'user') {
    return makeRow('user', `<div class="bubble-user">${escapeText(text)}</div>`);
  }
  return makeRow('assistant',
    `<div class="ai-avatar" aria-hidden="true">Q</div><div class="bubble-ai">${text}</div>`);
}

/** 渲染系统提示气泡（降级说明 / 错误提示） */
export function renderNote(text) {
  return makeRow('assistant', `<div class="ai-avatar" aria-hidden="true">Q</div><div class="bubble-note">${escapeText(text)}</div>`);
}

function escapeText(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ---------- 打字指示器 ---------- */

export function mountTyping() {
  const row = document.createElement('div');
  row.id = 'typing-indicator';
  row.className = 'typing-row';
  row.innerHTML = `
    <div class="ai-avatar" aria-hidden="true">Q</div>
    <div class="typing-bubble">
      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
    </div>`;
  dom.messages.appendChild(row);
  scrollToBottom();
  return row;
}

export function unmountTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

/* ---------- 流式气泡 ---------- */

/**
 * 挂载一个可渐进更新的 AI 气泡。
 * @returns {{ el: HTMLElement, update: (mdHtml:string)=>void, flush: ()=>void, remove: ()=>void }}
 */
export function mountStreamBubble() {
  unmountTyping();
  const row = document.createElement('div');
  row.className = 'row';
  const bubble = document.createElement('div');
  bubble.className = 'bubble-ai';
  row.innerHTML = `<div class="ai-avatar" aria-hidden="true">Q</div>`;
  row.appendChild(bubble);
  dom.messages.appendChild(row);
  scrollToBottom();

  const stream = {
    el: bubble,
    latest: '',
    lastRender: 0,
    timer: null
  };

  const flush = () => {
    if (stream.timer) { clearTimeout(stream.timer); stream.timer = null; }
    stream.el.innerHTML = stream.latest;
    stream.lastRender = Date.now();
    pinScroll();
  };

  return {
    el: bubble,
    /** 传入最新 Markdown HTML，节流写入 DOM */
    update(mdHtml) {
      stream.latest = mdHtml;
      const now = Date.now();
      if (now - stream.lastRender >= CONFIG.RENDER_THROTTLE) {
        flush();
      } else if (!stream.timer) {
        stream.timer = setTimeout(flush, CONFIG.RENDER_THROTTLE - (now - stream.lastRender));
      }
    },
    /** 立即把最新内容渲染完成 */
    flush,
    /** 移除该气泡（停止/失败回退时） */
    remove() {
      if (stream.timer) clearTimeout(stream.timer);
      row.remove();
    }
  };
}

/* ---------- 状态栏 ---------- */

const STATUS = {
  online:  { dot: '',        text: '小卿的 AI 助手 · 已接入模型' },
  demo:    { dot: 'is-warn', text: '小卿的 AI 助手 · 演示模式' },
  connecting: { dot: 'is-warn', text: '正在连接模型…' },
  error:   { dot: 'is-error', text: '模型连接失败 · 已回退演示模式' }
};

export function setStatus(mode) {
  const s = STATUS[mode] || STATUS.demo;
  dom.statusDot.className = 'status-dot' + (s.dot ? ' ' + s.dot : '');
  dom.statusText.textContent = s.text;
}

/* ---------- 输入区 ---------- */

export function setBusy(busy) {
  dom.send.disabled = busy;
  dom.input.disabled = busy;
}

export function resetInput() {
  dom.input.value = '';
  dom.input.style.height = 'auto';
}

export function focusInput() {
  dom.input.focus();
}

export function autoGrow() {
  dom.input.style.height = 'auto';
  dom.input.style.height = Math.min(dom.input.scrollHeight, 120) + 'px';
}

/* ---------- 工具栏 ---------- */

export function toggleStop(visible) {
  dom.stop.classList.toggle('is-hidden', !visible);
}

export function clearAll() {
  dom.messages.innerHTML = '';
}
