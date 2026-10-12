/**
 * API 调用层：与后端代理通信，解析 SSE 流式响应。
 *
 * 安全约定：
 * - 前端只携带用户消息，不携带任何密钥；
 * - 模型名/温度/长度等参数虽可传，但服务端会做二次封顶；
 * - 后端不可用时抛出带 kind 的错误，由上层决定是否回退演示模式。
 */
import { CONFIG } from './config.js?v=20261013';

export class BackendError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'BackendError';
    this.kind = kind; // 'timeout' | 'network' | 'http' | 'parse' | 'empty'
  }
}

/** 解析 SSE 文本流，把每个 data 分片交给 onData */
function consumeSseStream(reader, decoder, onData, onDone) {
  let buffer = '';

  const pump = () => reader.read().then(({ done, value }) => {
    if (done) { onDone(); return; }
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop(); // 最后一个可能是不完整帧，留到下次

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { onDone(); return; }
        onData(payload);
      }
    }
    return pump();
  });

  return pump();
}

/**
 * 调用后端代理（流式优先，兼容非流式 JSON 响应）。
 *
 * @param {Array<{role:string, content:string}>} messages 完整消息列表（含 system）
 * @param {object} handlers
 * @param {(delta:string)=>void} handlers.onToken 每收到一段文本增量
 * @param {()=>void} [handlers.onDone] 流结束
 * @param {AbortSignal} [signal] 外部中止信号（停止生成）
 * @returns {Promise<string>} 完整回复文本
 */
export async function callBackend(messages, { onToken, onDone, signal } = {}) {
  if (!CONFIG.BACKEND_URL) {
    throw new BackendError('unconfigured', '未配置后端代理地址');
  }

  const controller = new AbortController();
  const externalAbort = signal;

  const abortFromExternal = () => controller.abort();
  if (externalAbort) {
    if (externalAbort.aborted) controller.abort();
    else externalAbort.addEventListener('abort', abortFromExternal, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

  let res;
  try {
    res = await fetch(`${CONFIG.BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: CONFIG.MODEL,
        temperature: CONFIG.TEMPERATURE,
        max_tokens: CONFIG.MAX_TOKENS,
        stream: true
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new BackendError('timeout', '请求超时或已中止');
    throw new BackendError('network', '无法连接到后端代理');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new BackendError('http', `后端返回 ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
  }

  const isStream = (res.headers.get('content-type') || '').includes('text/event-stream');

  // —— 非流式 JSON（兼容兜底）——
  if (!isStream || !res.body) {
    const data = await res.json().catch(() => null);
    const content = data && data.content;
    if (!content) throw new BackendError('parse', '后端响应格式异常');
    if (onToken) onToken(content);
    if (onDone) onDone();
    return content;
  }

  // —— SSE 流式 ——
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let full = '';

  const onData = (payload) => {
    try {
      const json = JSON.parse(payload);
      if (json.error) throw new Error(json.error);
      // 兼容两种流格式：
      // 1) OpenAI 兼容格式：choices[0].delta.content（DeepSeek 等标准 SSE）
      // 2) 简单直传格式：delta 为字符串
      let delta = '';
      if (typeof json.delta === 'string') {
        delta = json.delta;
      } else if (json.choices && json.choices[0] && json.choices[0].delta) {
        const d = json.choices[0].delta;
        if (typeof d.content === 'string') delta = d.content;
      }
      if (delta) {
        full += delta;
        if (onToken) onToken(delta);
      }
    } catch (err) {
      throw new BackendError('parse', '流数据解析失败：' + err.message);
    }
  };

  const finished = new Promise((resolve, reject) => {
    consumeSseStream(reader, decoder, onData, resolve)
      .catch((err) => {
        if (err && err.name === 'AbortError') {
          reject(new BackendError('timeout', '流被中断'));
        } else if (err instanceof BackendError) {
          reject(err);
        } else {
          reject(new BackendError('network', '读取流失败：' + (err && err.message)));
        }
      });
  });

  await finished;
  if (onDone) onDone();
  if (!full.trim()) throw new BackendError('empty', '模型未返回内容');
  return full;
}
