/**
 * 小卿个人主页 · 数字分身 —— 后端代理（Cloudflare Worker）
 *
 * 职责：持有大模型 API Key（环境变量），为前端提供 /api/chat 流式代理。
 * 前端永远拿不到密钥；本 Worker 也不会在响应中泄漏密钥。
 *
 * 部署：
 *   wrangler secret put DEEPSEEK_API_KEY   # 填入你的 DeepSeek Key（必填）
 *   wrangler deploy
 *
 * 本地模拟测试（无 wrangler 时）：
 *   node --check worker.js
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

/** 简易速率限制：内存 Map（单 isolate 级别，重启即清零，作为演示级防护） */
const rateBuckets = new Map();

function checkRateLimit(ip, limitPerMin) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60_000;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= limitPerMin;
}

function json(data, status = 200, cors = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': cors || '*',
      'Cache-Control': 'no-store'
    }
  });
}

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = request.headers.get('Origin') || '';
  let allowOrigin = '*';
  if (allowed[0] !== '*' && origin && allowed.includes(origin)) {
    allowOrigin = origin;
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function handleOptions(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}

/**
 * 代理 /api/chat：把 messages 转发给大模型，SSE 流式回传。
 * 客户端参数只作初始值，服务端一律二次封顶，防止滥用。
 */
async function handleChat(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limit = Number(env.RATE_LIMIT_PER_MIN || 30);
  if (!checkRateLimit(ip, limit)) {
    return json({ error: '请求过于频繁，请稍后再试。' }, 429, corsHeaders(env, request)['Access-Control-Allow-Origin']);
  }

  // —— 解析并校验请求体 ——
  let body;
  try {
    const text = await request.text();
    if (text.length > 256 * 1024) throw new Error('payload_too_large');
    body = JSON.parse(text);
  } catch {
    return json({ error: '请求体格式错误。' }, 400, corsHeaders(env, request)['Access-Control-Allow-Origin']);
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  const maxTurns = Number(env.MAX_TURNS || 24);
  const maxChars = Number(env.MAX_CHARS_PER_MESSAGE || 2000);

  if (!messages || messages.length === 0 || messages.length > maxTurns) {
    return json({ error: '消息数量超出限制。' }, 400, corsHeaders(env, request)['Access-Control-Allow-Origin']);
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') ||
        typeof m.content !== 'string' || m.content.length > maxChars) {
      return json({ error: '消息内容不合法。' }, 400, corsHeaders(env, request)['Access-Control-Allow-Origin']);
    }
  }

  // —— 密钥与服务端配置 ——
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return json({ error: '服务端未配置 DEEPSEEK_API_KEY，请联系管理员。' }, 500, corsHeaders(env, request)['Access-Control-Allow-Origin']);
  }
  const baseUrl = env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  const model = env.MODEL || DEFAULT_MODEL;

  // 服务端封顶：忽略客户端超过上限的参数
  const temperature = Math.min(Math.max(Number(body.temperature) || 0.8, 0), 1.2);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 700, 1), 2000);

  // —— 调用上游，SSE 直通 ——
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);

  try {
    const upstream = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true
      }),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return json(
        { error: `上游模型服务返回 ${upstream.status}：${detail.slice(0, 300)}` },
        502,
        corsHeaders(env, request)['Access-Control-Allow-Origin']
      );
    }

    // 直接把上游的 SSE 流透传给前端
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        ...corsHeaders(env, request)
      }
    });
  } catch (err) {
    return json(
      { error: '上游模型服务超时或不可达。' },
      504,
      corsHeaders(env, request)['Access-Control-Allow-Origin']
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 云端数据（书籍 / 相册）：KV 存储读写接口。
 * - GET  /api/books  /api/photos  返回当前数据
 * - POST /api/books  /api/photos  全量覆盖保存（需 Bearer 口令，防陌生人写入）
 */
async function handleHobby(request, env, kind) {
  const cors = corsHeaders(env, request)['Access-Control-Allow-Origin'];

  if (request.method === 'GET') {
    const raw = await env.HOBBY_KV.get(kind).catch(() => null);
    const data = raw ? JSON.parse(raw) : [];
    return json({ ok: true, kind, data }, 200, cors);
  }

  if (request.method === 'POST') {
    const auth = request.headers.get('Authorization') || '';
    const expect = env.HOBBY_TOKEN || '';
    if (!expect || auth !== `Bearer ${expect}`) {
      return json({ error: '写入口令错误。' }, 401, cors);
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(ip, Number(env.RATE_LIMIT_PER_MIN || 30))) {
      return json({ error: '请求过于频繁，请稍后再试。' }, 429, cors);
    }
    let body;
    try {
      const text = await request.text();
      if (text.length > 24 * 1024 * 1024) throw new Error('payload_too_large');
      body = JSON.parse(text);
    } catch {
      return json({ error: '请求体格式错误。' }, 400, cors);
    }
    const data = Array.isArray(body.data) ? body.data : null;
    if (!data) return json({ error: 'data 必须是数组。' }, 400, cors);
    await env.HOBBY_KV.put(kind, JSON.stringify(data));
    return json({ ok: true, kind, count: data.length }, 200, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return handleOptions(request, env);

    const url = new URL(request.url);
    const cors = corsHeaders(env, request)['Access-Control-Allow-Origin'];

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'qing-digital-twin-proxy' }, 200, cors);
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(request, env);
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/books') {
      return handleHobby(request, env, 'books');
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/photos') {
      return handleHobby(request, env, 'photos');
    }
    return json({ error: 'not_found' }, 404, cors);
  }
};
