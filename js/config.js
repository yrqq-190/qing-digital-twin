/**
 * 全局配置层
 *
 * 前端不包含任何密钥。真实模型调用统一走 BACKEND_URL 指向的后端代理，
 * 密钥只存在于服务端环境变量中（见 worker/ 与 server/）。
 */
export const CONFIG = {
  /**
   * 后端代理地址。
   * - 留空：纯本地演示模式（关键词匹配兜底），适合未部署后端时使用；
   * - 填写（如 https://your-worker.xxx.workers.dev）：接入真实大模型；
   *   若请求失败且 DEMO_FALLBACK 为 true，会自动回退到演示模式并提示用户。
   */
  BACKEND_URL: '',

  /* 模型参数（前端仅作初始值，服务端会二次封顶，防止滥用） */
  MODEL: 'deepseek-chat',
  TEMPERATURE: 0.8,
  MAX_TOKENS: 700,
  MAX_TURNS: 12,           // 保留最近 N 轮对话作为上下文
  REQUEST_TIMEOUT: 60000,  // 后端流式响应整体超时（毫秒）

  /* 后端不可达时是否回退本地演示模式 */
  DEMO_FALLBACK: true,

  /* 输入与存储 */
  MAX_INPUT_LENGTH: 500,
  STORAGE_KEY: 'qing-digital-twin:v1:history',

  /* 流式渲染节流：每 N 毫秒最多刷新一次 DOM（避免高频 chunk 卡顿） */
  RENDER_THROTTLE: 40
};
