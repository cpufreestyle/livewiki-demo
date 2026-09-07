// LiveWiki 全局常量
// 统一收编散落在 server.js / server_handlers.mjs / resolve_video_url.js 中的魔法数字，
// 保证「同一语义只有一个定义」。

// ─── 媒体特征 ────────────────────────────────────────────────
// 常见直链 / 流媒体扩展名。
// 注意：必须要求扩展名位于「路径」中（前面有 /），否则会把 www.mov 这类域名误判为 .mov 直链
export const MEDIA_EXT =
  /\/[^\/]*\.(mp4|m3u8|m3u|webm|mov|mkv|flv|ts|m4v|mp3|m4a|wav|aac|ogg|mpd)(\?|#|$)/i;

// 视频 / 音频 content-type
export const MEDIA_CT = /^(video|audio)\//i;

// ─── 候选打分 ────────────────────────────────────────────────
// URL 形态加成（叠加在嗅探来源分之上）：[匹配正则, 分值] 顺序敏感
export const URL_FORM_SCORE = [
  [/\.m3u8?$/, 70],   // HLS 主播放列表，yt-dlp 可直接消费
  [/\.mp4$/, 85],     // 最理想的直链
  [/\.webm$/, 65],
  [/\.mpd$/, 55],     // DASH
  [/\.mov$/, 60],
  [/\.(ts|m4s)$/, 25], // 切片片段，单段没意义
  [/\.(mp3|m4a|wav|aac|ogg)$/, 50],
];
export const URL_FORM_DEFAULT_SCORE = 20;

// 嗅探来源基础分
export const SOURCE_SCORE = {
  YTDLP: 80,          // yt-dlp 提取（后续按序号递减）
  NETWORK_RESPONSE: 50,
  API_BODY: 55,
  API_PLATFORM: 70,
  MEDIA_REQUEST: 40,
  PAGE_HTML: 45,
  PAGE_PLATFORM: 65,
  IFRAME_DIRECT: 75,
  VIDEO_TAG: 60,
  STATIC: 35,
};

// ─── 超时（毫秒）────────────────────────────────────────────
export const TIMEOUT = {
  YTDLP_GET_URL: 25000,
  PLAYWRIGHT_GOTO: 35000,
  STATIC_HTTP: 20000,
  TRANSCRIBE: 15 * 60 * 1000, // 15 分钟
  CLICK: 1500,
  WAIT_SLICE: 700,
};

// ─── 解析链路预算（毫秒）────────────────────────────────────
// 整条 resolveVideoUrl 的软截止时间：到点即返回已收集到的候选，不再继续后续策略。
export const RESOLVE_BUDGET_MS = 75 * 1000;

// ─── 数量 / 体积上限 ────────────────────────────────────────
export const LIMITS = {
  MAX_CANDIDATES: 12,
  MAX_DIAG_HINTS: 20,
  MAX_IFRAME_RECURSE: 3,        // iframe 兜底 yt-dlp 的最大数量
  MAX_REDIRECTS: 5,             // fetchHttp 跟随重定向上限
  BODY_SCAN_SKIP_CL: 6 * 1024 * 1024,  // 声明 content-length 超此值直接跳过
  BODY_SCAN_MAX: 8 * 1024 * 1024,      // 流式扫描最多读取字节数
  MIN_URL_LEN: 12,
};

// ─── 前端 / 接口通用 ────────────────────────────────────────
export const MIN_TRANSCRIPT_CHARS = 10;

// 上传文件允许的扩展名白名单（避免采用用户提供的 filename 造成路径穿越）
export const UPLOAD_EXT_ALLOWLIST = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.flv', '.avi',
  '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac',
]);

// 浏览器 UA（可被 LW_UA 覆盖）
export const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
