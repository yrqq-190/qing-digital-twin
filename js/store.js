/**
 * 对话持久化层：基于 localStorage，刷新页面后聊天记录不丢失。
 * 对损坏数据 / 配额超限做了容错，任何情况下都不会让主流程崩溃。
 */
import { CONFIG } from './config.js?v=20261014';

const KEY = CONFIG.STORAGE_KEY;

/** 读取历史，非法数据一律返回空数组 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (m) => m && typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    );
  } catch (err) {
    console.warn('[store] 读取历史失败，已忽略：', err);
    return [];
  }
}

/** 保存历史；配额超限时降级为只保存最近 N 条再试一次 */
export function saveHistory(history) {
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
    return true;
  } catch (err) {
    console.warn('[store] 保存历史失败，尝试压缩：', err);
    try {
      const trimmed = history.slice(-(CONFIG.MAX_TURNS * 2));
      localStorage.setItem(KEY, JSON.stringify(trimmed));
      return true;
    } catch {
      console.warn('[store] 压缩后仍保存失败（可能处于隐私模式）');
      return false;
    }
  }
}

/** 清空历史 */
export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
