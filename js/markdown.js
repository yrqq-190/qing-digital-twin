/**
 * 安全 Markdown 渲染器（零依赖）
 *
 * 设计原则：先转义、后格式化。
 * 所有用户/AI 文本先做 HTML 转义，再在其上进行白名单格式化，
 * 从根本上杜绝 XSS（链接仅允许 http/https，且 href 属性经过转义）。
 *
 * 支持：加粗 **xx**、行内代码 `xx`、代码块 ```、无序/有序列表、链接 [t](url)、换行。
 */

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** 行内格式化：必须在已转义文本上执行 */
function formatInline(text) {
  let out = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  // 链接白名单：仅 http/https
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    if (/^https?:\/\//i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return match;
  });
  return out;
}

/** 段落级渲染（非代码块片段） */
function renderBlocks(segment) {
  if (!segment) return '';
  const lines = segment.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const ulMatch = line.match(/^[-*+]\s+(.*)/);
    const olMatch = line.match(/^\d+[.)]\s+(.*)/);

    if (ulMatch) {
      if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
      out.push(`<li>${formatInline(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }
    if (olMatch) {
      if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
      out.push(`<li>${formatInline(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }
    closeLists();
    if (!line.trim()) continue;
    out.push(`<p>${formatInline(escapeHtml(line))}</p>`);
  }
  closeLists();
  return out.join('');
}

/**
 * 将 Markdown 文本安全地渲染为 HTML。
 * @param {string} src 原始 Markdown 文本
 * @returns {string} 安全 HTML
 */
export function renderMarkdown(src) {
  const text = String(src || '');
  // 先切出代码块，代码块整体保持转义原样
  const parts = text.split(/```[^\n]*\n?([\s\S]*?)```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += renderBlocks(parts[i]);
    } else {
      html += `<pre><code>${escapeHtml(parts[i])}</code></pre>`;
    }
  }
  return html || '<p></p>';
}
