# 颜睿卿（Qing）个人主页 · 数字分身（Digital Twin Chat）

一个「个人主页 + AI 数字分身对话」的课程作业项目。左侧是个人名片，右侧是可与访问者对话的 AI 数字分身。

**技术亮点（前后端分离的工程化改造）：**

| 方面 | 实现 |
| --- | --- |
| 前端架构 | ES Modules 分层（config / persona / markdown / api / ui / store / main），零构建工具 |
| 模型调用 | **密钥只存在服务端**，前端通过自己的后端代理通信，杜绝 API Key 泄露 |
| 流式对话 | SSE 流式输出 + 打字机渲染（节流刷新），支持「停止生成」 |
| 对话持久化 | localStorage 保存历史，刷新不丢，可一键清空 |
| 安全 | CSP 内容安全策略、全量 XSS 转义后再渲染 Markdown、输入长度与服务端双重限制、演示级速率限制 |
| 降级体验 | 后端不可达时自动回退本地演示模式并明确提示，不会白屏 |
| 依赖 | 前端无任何运行时第三方库；本地服务器零 npm 依赖 |

---

## 目录结构

```
qing-digital-twin/
├── index.html            # 页面（个人信息 + 数字分身对话）
├── css/style.css         # 全部样式（无 Tailwind/CDN 运行时依赖）
├── js/
│   ├── config.js         # 配置层：后端地址、模型参数
│   ├── persona.js        # 人格设定：System Prompt + 演示模式兜底回复
│   ├── markdown.js       # 安全 Markdown 渲染器（先转义后格式化）
│   ├── api.js            # API 层：SSE 流式调用与解析
│   ├── ui.js             # UI 层：消息/打字机/流式气泡/状态栏
│   ├── store.js          # 持久化层：localStorage 读写
│   └── main.js           # 主流程：状态管理、事件绑定
├── worker/               # 旧线上后端（Cloudflare Worker，国内部分网络不可达，备用）
│   ├── worker.js
│   └── wrangler.toml
├── cloudbase-backend/     # 当前线上后端（腾讯云 CloudBase HTTP 云函数）
│   ├── index.js
│   ├── package.json
│   └── scf_bootstrap
├── server/               # 本地开发服务器（零依赖）
│   ├── server.js
│   ├── package.json
│   └── .env.example      # 密钥模板（.env 已被 gitignore）
└── README.md
```

## 架构

```
浏览器（前端，GitHub Pages）
   │  fetch /api/chat（仅携带对话内容，无密钥）
   ▼
后端代理（腾讯云 CloudBase HTTP 云函数 / 本地 server.js）
   │  持有 DEEPSEEK_API_KEY，参数二次封顶，速率限制
   ▼
DeepSeek API（SSE 流式返回）
```

## 本地运行

前置：Node.js ≥ 18。

```bash
cd qing-digital-twin/server
cp .env.example .env        # Windows 用 copy .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY=sk-xxx
npm start                   # 打开 http://localhost:3000
```

本地运行时会同时提供静态页面和 `/api/chat` 代理，前端 `BACKEND_URL` 留空即可（同源自动命中代理，走真实模型）。

没有密钥也可以跑：前端自动进入演示模式（关键词兜底回复），页面与交互完全可用。

## 部署到 GitHub Pages

```bash
# 1. 新建公开仓库并推送
cd qing-digital-twin
git init
git add .
git commit -m "颜睿卿（Qing）个人主页 + 数字分身"
gh repo create qing-digital-twin --public --source . --push

# 2. 开启 Pages（GitHub 网页端：Settings → Pages → Deploy from a branch → main / root）
#    或者用命令行：
gh api -X POST repos/<你的用户名>/qing-digital-twin/pages \
  -f "source[branch]=main" -f "source[path]=/"

# 3. 访问 https://<你的用户名>.github.io/qing-digital-twin/
```

## 部署后端代理（让数字分身接入真实模型）

### 方案 A：Cloudflare Worker（推荐，免费）

```bash
# 1. 安装并登录 Wrangler
npm i -g wrangler
wrangler login

# 2. 进入 worker 目录，设置密钥（关键一步：密钥不进代码库）
cd qing-digital-twin/worker
wrangler secret put DEEPSEEK_API_KEY     # 粘贴你的 DeepSeek Key

# 3. 部署
wrangler deploy

# 4. 部署完成后会得到一个 https://xxx.workers.dev 地址
```

### 方案 B：本地服务器长期运行

在有 Node 的服务器上运行 `server/server.js`，并把 `.env` 配好，通过反向代理（如 Nginx）对外提供 HTTPS 即可。

### 前端接线

部署好任一后端后，编辑 `js/config.js`：

```js
BACKEND_URL: 'https://your-worker.xxx.workers.dev',
```

刷新页面，状态栏显示「已接入模型」，数字分身即开始调用真实大模型。

## 模型平台切换

后端默认接入 DeepSeek（`deepseek-chat`）。如需切换到任何 OpenAI 兼容平台：

- Cloudflare：`wrangler.toml` 的 `DEEPSEEK_BASE_URL` 与 `MODEL`
- 本地：`server/.env` 的 `DEEPSEEK_BASE_URL` 与 `MODEL`

## 安全说明

- **API Key 只存在于服务端环境变量**（Worker 的 secret / 本地 .env），`.gitignore` 已排除 `.env`、`.env.local`、`.dev.vars`；
- 前端通过 CSP 限制脚本与外部请求来源；所有模型输出先 HTML 转义再渲染，杜绝 XSS；
- 服务端对消息条数、单条长度、token 数做二次封顶，并有演示级速率限制（单 IP 每分钟 30 次，可调）；
- 若按本仓库公开部署，建议把 Worker 的 `ALLOWED_ORIGINS` 从 `*` 改为你的 Pages 域名。

## 演示模式说明

未配置 `BACKEND_URL` 或后端不可达时，聊天区自动使用本地关键词匹配兜底回复（见 `js/persona.js` 的 `LOCAL_RULES`），状态栏会显示「演示模式」以保持诚实。

## 自留地模块（文学与阅读 / 摄影与生活）

左侧「自留地」两个入口卡片（带背景图，点击打开全屏模态框）：

- **文学与阅读**：横向滑动卡片流，点封面传书籍图片、填书名/作者/感想，「金句」以撕纸质感纸片呈现（双击纸片可编辑，可添加多句）；
- **摄影与生活**：相册，点「＋」或拖拽照片上传，自动压缩后存入云端，点照片看大图、悬停显示删除。

存储：数据写入腾讯云 CloudBase 文档型数据库（集合 `hobby`），任何设备打开页面都能看到，无需手动导出或改代码；localStorage 仅作离线缓存，云端不可达时仍可浏览本地快照。

- API：`GET/POST /api/books`、`GET/POST /api/photos`、`GET/POST /api/profile`（云函数 `qing-backend`，见 `cloudbase-backend/index.js`）；
- 写入口令：POST 需 `Authorization: Bearer <HOBBY_TOKEN>`（环境变量，防止访客往你的相册写入内容；读取不需要口令）；
- 图片处理：前端 canvas 压缩（书籍封面最长边 480px、相册 1440px，JPEG），单张源文件上限 8MB，请求体上限 24MB；
- 备份：模态框底部「导出数据」可下载 JSON 备份（本地文件，随时可恢复）；
- 入口卡片背景图：`assets/hobby-reading.jpg`、`assets/hobby-photo.jpg`（自托管，走 `img-src 'self'`）；
- 前端模块：`js/hobby.js`（ES Module），样式 `css/hobby.css`，均通过现有 CSP `'self'` 约束。
