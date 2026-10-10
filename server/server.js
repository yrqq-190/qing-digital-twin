/**
 * 小卿个人主页 · 数字分身 —— 本地开发服务器（零依赖）
 *
 * 用途：一条命令起本地服务，同时提供
 *   1) 静态文件（index.html / css / js）—— 解决 file:// 下 ES Module 被浏览器拦截的问题；
 *   2) POST /api/chat —— 与线上 Cloudflare Worker 完全一致的代理逻辑，
 *      密钥从 .env 读取（已被 .gitignore 忽略，不会提交）。
 *
 * 启动：
 *   cp .env.example .env          # 填入 DEEPSEEK_API_KEY
 *   npm start                     # 或 node server.js
 *   浏览器打开 http://localhost:3000
 *
 * 说明：本地开发时把前端 js/config.js 的 BACKEND_URL 留空即可——
 * 本服务器会拦截同源的 /api/chat（同源请求不跨域），前端自动走真实模型。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/* ---------- 读取 .env（极小实现，避免引入依赖） ---------- */
const env = { ...process.env };
try {
  const raw = await readFile(resolve(ROOT, 'server', '.env'), 'utf-8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 时忽略 */ }

const BASE_URL = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const MODEL = env.MODEL || 'deepseek-chat';

/* ---------- MIME 表 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

/** 读取请求体（Node IncomingMessage 是流，需手动聚合），超限销毁连接 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/* ---------- 代理 /api/chat（与 worker.js 同逻辑） ---------- */
async function handleChat(req) {
  let body;
  try {
    const text = await readBody(req);
    if (!text.trim()) throw new Error('empty_body');
    body = JSON.parse(text);
  } catch {
    return json({ error: '请求体格式错误。' }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0 || messages.length > 24) {
    return json({ error: '消息数量超出限制。' }, 400);
  }
  for (const m of messages) {
    if (!m || !['user', 'assistant', 'system'].includes(m.role) ||
        typeof m.content !== 'string' || m.content.length > 2000) {
      return json({ error: '消息内容不合法。' }, 400);
    }
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return json({ error: '未配置 DEEPSEEK_API_KEY：请复制 server/.env.example 为 server/.env 并填入密钥。' }, 500);
  }

  const temperature = Math.min(Math.max(Number(body.temperature) || 0.8, 0), 1.2);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 700, 1), 2000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);

  try {
    const upstream = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens, stream: true }),
      signal: controller.signal
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return json({ error: `上游模型服务返回 ${upstream.status}：${detail.slice(0, 300)}` }, 502);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (err) {
    return json({ error: '上游模型服务超时或不可达。' }, 504);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 静态文件服务（带路径穿越防护） ---------- */
async function serveStatic(pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file = resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return json({ error: 'forbidden' }, 403);

  // 目录 → index.html
  if (!existsSync(file) && !extname(file)) file = resolve(ROOT, rel, 'index.html');
  if (!existsSync(file)) return json({ error: 'not_found' }, 404);

  const data = await readFile(file);
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  return new Response(data, { headers: { 'Content-Type': type } });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return; }

  let response;
  if (req.method === 'GET' && url.pathname === '/') {
    response = await serveStatic('/');
  } else if (req.method === 'GET' && url.pathname.startsWith('/css/')) {
    response = await serveStatic(url.pathname);
  } else if (req.method === 'GET' && url.pathname.startsWith('/js/')) {
    response = await serveStatic(url.pathname);
  } else if (req.method === 'GET' && url.pathname === '/favicon.svg') {
    response = await serveStatic('/favicon.svg');
  } else if (req.method === 'POST' && url.pathname === '/api/chat') {
    response = await handleChat(req);
  } else {
    response = await serveStatic(url.pathname);
  }

  for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : undefined);
});

const PORT = Number(env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[qing-digital-twin] 本地服务已启动：http://localhost:${PORT}`);
  console.log(`[qing-digital-twin] 模型代理：${env.DEEPSEEK_API_KEY ? '已配置 ' + MODEL : '未配置密钥（.env 缺失），仅静态页面可用'}`);
});
