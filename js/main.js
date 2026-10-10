/**
 * 主流程入口：状态管理、事件绑定、发送/停止/清空/下载简历。
 * 分层：main（编排）→ api（模型通信）→ ui（渲染）→ store（持久化）。
 */
import { CONFIG } from './config.js';
import { SYSTEM_PROMPT, matchLocalReply, GREETING } from './persona.js';
import { renderMarkdown } from './markdown.js';
import { loadHistory, saveHistory, clearHistory } from './store.js';
import { callBackend } from './api.js';
import * as ui from './ui.js';

const state = {
  history: [],
  isSending: false,
  abort: null,
  manuallyStopped: false,
  /** 是否已配置后端代理 */
  backendMode: Boolean(CONFIG.BACKEND_URL)
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 上下文管理 ---------- */

function pushHistory(role, content) {
  state.history.push({ role, content });
  const limit = CONFIG.MAX_TURNS * 2;
  if (state.history.length > limit) {
    state.history.splice(0, state.history.length - limit);
  }
}

function buildPayload() {
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...state.history];
}

/* ---------- 回复生产 ---------- */

function friendlyError(err) {
  const kind = err && err.kind;
  if (kind === 'timeout') return '抱歉，模型响应超时了，请稍后再试一次。';
  if (kind === 'network') return '无法连接到后端服务，请检查网络后重试。';
  if (kind === 'http') return `后端服务返回异常（${err.message}）。`;
  if (kind === 'parse' || kind === 'empty') return '模型返回的内容异常，请稍后再试。';
  return '连接模型时出了点问题，请稍后重试。';
}

/**
 * 生产一条回复。返回：
 * - { text } 需要新渲染一条完整消息；
 * - { text, keepBubble, stream } 已渲染在流式气泡中，直接收尾；
 * - null 无需渲染（已停止 / 仅提示）。
 */
async function produceReply(userText) {
  // —— 本地演示模式 ——
  if (!state.backendMode) {
    await delay(600 + Math.random() * 600);
    return { text: matchLocalReply(userText) };
  }

  // —— 真实模型（经后端代理） ——
  ui.setStatus('connecting');
  ui.toggleStop(true);
  state.manuallyStopped = false;
  state.abort = new AbortController();

  const stream = ui.mountStreamBubble();
  let acc = '';

  try {
    await callBackend(buildPayload(), {
      onToken: (delta) => {
        acc += delta;
        stream.update(renderMarkdown(acc));
      },
      signal: state.abort.signal
    });
    stream.flush();
    ui.setStatus('online');
    return { text: acc, keepBubble: true, stream };
  } catch (err) {
    if (state.manuallyStopped) {
      stream.remove();
      ui.renderNote('已停止生成。');
      return null;
    }
    if (acc.trim()) {
      stream.flush();
      ui.renderNote('连接中断，以上是已生成的部分内容。');
      return { text: acc, keepBubble: true, stream };
    }
    stream.remove();
    if (CONFIG.DEMO_FALLBACK) {
      ui.renderNote('后端暂时不可用，已切换为本地演示模式。');
      ui.setStatus('demo');
      await delay(600 + Math.random() * 600);
      return { text: matchLocalReply(userText) };
    }
    ui.renderNote(friendlyError(err));
    ui.setStatus('error');
    return null;
  }
}

/* ---------- 主流程 ---------- */

async function handleSend(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.isSending) return;

  state.isSending = true;
  ui.setBusy(true);

  ui.renderMessage('user', text);
  pushHistory('user', text);
  ui.resetInput();
  ui.mountTyping();

  let reply = null;
  try {
    reply = await produceReply(text);
  } finally {
    ui.unmountTyping();
  }

  if (reply) {
    if (reply.keepBubble && reply.stream) {
      reply.stream.flush();
    } else {
      ui.renderMessage('assistant', renderMarkdown(reply.text));
    }
    pushHistory('assistant', reply.text);
    saveHistory(state.history);
  }

  state.isSending = false;
  ui.setBusy(false);
  ui.toggleStop(false);
  ui.focusInput();
}

/* ---------- 工具栏动作 ---------- */

function handleStop() {
  state.manuallyStopped = true;
  if (state.abort) state.abort.abort();
}

function handleClear() {
  if (state.isSending) return;
  clearHistory();
  state.history = [];
  ui.clearAll();
  ui.renderMessage('assistant', renderMarkdown(GREETING));
  ui.setStatus(state.backendMode ? 'online' : 'demo');
}

/** 从前端数据生成一份纯文本简历并下载（修复原版「下载简历」无效按钮） */
function handleDownloadResume() {
  const lines = [
    '小卿 Qing · 个人简历',
    '计算机科学本科生 | 技术创作者 | 情绪观察者',
    '',
    '一句话签名：在代码与人文交汇处，寻找不枯萎的锚点。',
    '',
    '【学术与科研】',
    '大创项目负责人：主导基于「形式化建模」的大学生创新创业训练计划，负责顶层设计、技术路径规划与成果撰写，并产出学术论文。',
    '',
    '【硬核工程】',
    '挑战杯·揭榜挂帅：负责四足机器狗的运动避障与自主搜索识别红球模块，实现复杂地形下的稳定行走与避障。',
    '',
    '【社会应用】',
    '挑战杯·自闭症儿童干预项目（核心成员）：跟进从概念到落地的全生命周期，独立负责全媒体（公众号）内容运营。',
    '',
    '【当前主线】',
    '备考 2028 届计算机方向研究生，探索 AI 底层逻辑与人文科技的交叉领域。',
    '独立运营树洞自媒体账号，保持对真实世界的感知力与文字创作。',
    '',
    '【兴趣与能力】',
    'AI 底层逻辑 / 内容运营 / 技术写作 / 文学摄影 / 观鸟',
    '',
    '联系方式：hello@example.com（请替换为真实邮箱）'
  ].join('\n');

  const blob = new Blob(['\ufeff' + lines], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '小卿-Qing-简历.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  ui.dom.send.addEventListener('click', () => handleSend(ui.dom.input.value));
  ui.dom.stop.addEventListener('click', handleStop);
  ui.dom.clear.addEventListener('click', handleClear);
  if (ui.dom.resumeBtn) ui.dom.resumeBtn.addEventListener('click', handleDownloadResume);

  ui.dom.input.addEventListener('input', ui.autoGrow);
  ui.dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend(ui.dom.input.value);
    }
  });

  ui.dom.quickWrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-question]');
    if (btn) handleSend(btn.dataset.question);
  });
}

/* ---------- 初始化 ---------- */

function init() {
  bindEvents();

  const saved = loadHistory();
  if (saved.length) {
    state.history = saved;
    for (const m of saved) {
      if (m.role === 'user') {
        ui.renderMessage('user', m.content);
      } else {
        ui.renderMessage('assistant', renderMarkdown(m.content));
      }
    }
  } else {
    ui.renderMessage('assistant', renderMarkdown(GREETING));
  }

  ui.setStatus(state.backendMode ? 'online' : 'demo');

  if (state.backendMode) {
    console.info(
      '%c[Digital Twin Chat]%c 已配置后端代理，数字分身将调用真实模型。',
      'color:#4A6E51;font-weight:bold;', 'color:#5F665F;'
    );
  } else {
    console.info(
      '%c[Digital Twin Chat]%c 当前为本地演示模式。\n' +
      '在 js/config.js 的 BACKEND_URL 中填入后端代理地址即可接入真实大模型。\n' +
      '密钥只放在服务端，前端不携带任何密钥。',
      'color:#4A6E51;font-weight:bold;', 'color:#5F665F;'
    );
  }
}

init();
