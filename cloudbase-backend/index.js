/**
 * 小卿个人主页 · 数字分身 —— 腾讯云 CloudBase HTTP 云函数后端
 *
 * 路由：
 *   POST /api/chat       SSE 流式代理 DeepSeek（密钥只在服务端环境变量中）
 *   GET  /api/books     读取书籍数据
 *   POST /api/books     全量保存书籍（需 Bearer 口令，防陌生人写入）
 *   GET  /api/photos    读取相册数据
 *   POST /api/photos    全量保存相册（需 Bearer 口令）
 *   GET  /api/profile   读取入口卡片背景
 *   POST /api/profile   全量保存背景（需 Bearer 口令）
 *
 * 数据存储：云开发文档型数据库，集合 hobby，三个文档 books / photos / profile。
 * 集合需要在控制台手动创建一次（见部署教程第 5 步）。
 */

const express = require('express');
const cloud = require('@cloudbase/node-sdk');

const app = express();
const PORT = 9000; // HTTP 云函数固定监听端口（勿改）

// 初始化云开发（HTTP 云函数运行时自动注入当前环境）
const tcbApp = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = tcbApp.database();
const COLLECTION = 'hobby';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';

/* ---------- 工具 ---------- */

function getEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

// 简易内存限流（单实例级别，重启清零，演示级防护）
const rateBuckets = new Map();
function checkRateLimit(ip, limitPerMin) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= limitPerMin;
}

// CORS：默认允许所有来源；可用 ALLOWED_ORIGINS 收紧为指定域名
function applyCors(req, res) {
  const allowed = getEnv('ALLOWED_ORIGINS', '*').split(',').map((s) => s.trim());
  const origin = req.headers.origin || '';
  let allow = '*';
  if (allowed[0] !== '*' && origin && allowed.includes(origin)) allow = origin;
  res.set('Access-Control-Allow-Origin', allow);
  res.set('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Cache-Control', 'no-store');
}

app.use((req, res, next) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '24mb' }));

/* ---------- 云数据库读写 ---------- */

async function readDoc(docId, fallback) {
  try {
    const res = await db.collection(COLLECTION).doc(docId).get();
    if (res && res.data && res.data.length > 0 && res.data[0].data !== undefined) {
      return res.data[0].data;
    }
    return fallback;
  } catch (e) {
    console.error('readDoc error:', docId, e && e.message);
    return fallback;
  }
}

async function writeDoc(docId, value) {
  await db.collection(COLLECTION).doc(docId).set({ data: value });
}

function checkWriteAuth(req) {
  const auth = req.headers.authorization || '';
  const expect = getEnv('HOBBY_TOKEN', '');
  return !expect || auth === `Bearer ${expect}`;
}

/* ---------- 聊天：SSE 流式代理 ---------- */

app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  if (!checkRateLimit(ip, Number(getEnv('RATE_LIMIT_PER_MIN', '30')))) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const maxTurns = Number(getEnv('MAX_TURNS', '24'));
  const maxChars = Number(getEnv('MAX_CHARS_PER_MESSAGE', '2000'));

  if (!messages || messages.length === 0 || messages.length > maxTurns) {
    return res.status(400).json({ error: '消息数量超出限制。' });
  }
  for (const m of messages) {
    if (
      !m ||
      !['user', 'assistant', 'system'].includes(m.role) ||
      typeof m.content !== 'string' ||
      m.content.length > maxChars
    ) {
      return res.status(400).json({ error: '消息内容不合法。' });
    }
  }

  const apiKey = getEnv('DEEPSEEK_API_KEY');
  if (!apiKey) {
    return res.status(500).json({ error: '服务端未配置 DEEPSEEK_API_KEY，请联系管理员。' });
  }

  const baseUrl = getEnv('DEEPSEEK_BASE_URL', DEFAULT_BASE_URL);
  const model = getEnv('MODEL', DEFAULT_MODEL);
  // 服务端封顶：忽略客户端超过上限的参数
  const temperature = Math.min(Math.max(Number(body.temperature) || 0.8, 0), 1.2);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 700, 1), 2000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  try {
    const upstream = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream'
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
      return res
        .status(502)
        .json({ error: `上游模型服务返回 ${upstream.status}：${detail.slice(0, 300)}` });
    }

    // 直接把上游 SSE 流透传给前端
    res.status(200);
    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    console.error('chat proxy error:', err && err.message);
    if (!res.headersSent) {
      return res.status(504).json({ error: '上游模型服务超时或不可达。' });
    }
    res.end();
  } finally {
    clearTimeout(timer);
  }
});

/* ---------- 数据读写接口（books / photos / profile） ---------- */

function makeDataRoute(kind, fallback) {
  app.get(`/api/${kind}`, async (req, res) => {
    try {
      const data = await readDoc(kind, fallback);
      res.json({ ok: true, kind, data });
    } catch (e) {
      res.status(500).json({ error: `读取失败：${e && e.message}` });
    }
  });

  app.post(`/api/${kind}`, async (req, res) => {
    if (!checkWriteAuth(req)) {
      return res.status(401).json({ error: '写入口令错误。' });
    }
    const body = req.body || {};
    const data = body.data;
    const valid =
      kind === 'profile'
        ? data && typeof data === 'object' && !Array.isArray(data)
        : Array.isArray(data);
    if (!valid) {
      return res.status(400).json({ error: 'data 格式不正确。' });
    }
    try {
      await writeDoc(kind, data);
      const out = { ok: true, kind };
      if (Array.isArray(data)) out.count = data.length;
      res.json(out);
    } catch (e) {
      console.error('write error:', kind, e && e.message);
      res.status(500).json({ error: `保存失败：${e && e.message}` });
    }
  });
}

makeDataRoute('books', []);
makeDataRoute('photos', []);
makeDataRoute('profile', {});

/* ---------- 留言墙（朋友空间） ----------
 * 集合 messages：每条留言一个文档。
 * 留言：公开（public）或悄悄话（private，仅管理口令可见）。
 * 接口：
 *   GET    /api/messages            公开留言（带管理口令时含悄悄话）
 *   POST   /api/messages            新增留言（任何人，限流）
 *   DELETE /api/messages?id=xxx     管理端删除留言（口令）
 */

const MSG_COLLECTION = 'messages';

app.get('/api/messages', async (req, res) => {
  try {
    const res2 = await db.collection(MSG_COLLECTION).limit(500).get();
    const docs = res2.data || [];
    const isAdmin = checkWriteAuth(req);
    const messages = docs
      .filter((d) => d.visibility !== 'private' || isAdmin)
      .map((d) => ({
        id: d.id, name: d.name, content: d.content,
        image: d.image || null, visibility: d.visibility || 'public',
        createdAt: d.createdAt
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, messages });
  } catch (e) {
    console.error('messages read error:', e && e.message);
    res.status(500).json({ error: `读取留言失败：${e && e.message}` });
  }
});

app.post('/api/messages', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  if (!checkRateLimit(ip, Number(getEnv('MSG_RATE_PER_MIN', '10')))) {
    return res.status(429).json({ error: '留言太频繁啦，歇一会儿再来。' });
  }
  const { name, content, image, visibility } = req.body || {};
  const n = String(name || '').trim().slice(0, 20);
  const c = String(content || '').trim().slice(0, 500);
  if (!n || !c) return res.status(400).json({ error: '昵称和内容不能为空。' });
  if (image && (typeof image !== 'string' || image.length > 2 * 1024 * 1024)) {
    return res.status(400).json({ error: '图片太大了，压缩到 2MB 内再传。' });
  }
  const createdAt = Date.now();
  const id = String(createdAt) + String(Math.floor(Math.random() * 1000));
  try {
    await db.collection(MSG_COLLECTION).add({
      id, name: n, content: c,
      image: image ? String(image).slice(0, 2 * 1024 * 1024) : null,
      visibility: visibility === 'private' ? 'private' : 'public',
      createdAt
    });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('messages add error:', e && e.message);
    res.status(500).json({ error: `留言保存失败：${e && e.message}` });
  }
});

app.delete('/api/messages', async (req, res) => {
  if (!checkWriteAuth(req)) return res.status(401).json({ error: '写入口令错误。' });
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: '缺少留言 id。' });
  try {
    const res2 = await db.collection(MSG_COLLECTION).where({ id }).get();
    const doc = res2.data && res2.data[0];
    if (!doc) return res.status(404).json({ error: '留言不存在。' });
    await db.collection(MSG_COLLECTION).doc(doc._id).remove();
    res.json({ ok: true });
  } catch (e) {
    console.error('messages delete error:', e && e.message);
    res.status(500).json({ error: `删除失败：${e && e.message}` });
  }
});

app.get('/', (req, res) => res.json({ ok: true, service: 'qing-digital-twin-cloudbase' }));

app.listen(PORT, () => {
  console.log(`[cloudbase-backend] listening on ${PORT}`);
});
