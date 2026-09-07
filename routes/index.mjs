// 路由表：把原先堆在 server.js 单个回调里的 8 个接口拆成独立模块
// 每个 handler 签名统一为 (req, res, url)，与原生 http.Server 保持一致。

import { handleProcess } from './process.mjs';
import { handleSample } from './sample.mjs';
import { handleSummarize } from './summarize.mjs';
import { handleLastTranscript } from './last-transcript.mjs';
import { handleTranscribeStatus } from './transcribe-status.mjs';
import { handleTranscribeRoute } from './transcribe.mjs';
import { handleTranscribeFileRoute } from './transcribe-file.mjs';
import { handleResolveVideoRoute } from './resolve-video.mjs';

export const ROUTES = [
  { method: 'POST', path: '/api/process', handler: handleProcess },
  { method: 'POST', path: '/api/summarize', handler: handleSummarize },
  { method: 'GET', path: '/api/sample', handler: handleSample },
  { method: 'GET', path: '/api/last-transcript', handler: handleLastTranscript },
  { method: 'GET', path: '/api/transcribe/status', handler: handleTranscribeStatus },
  { method: 'POST', path: '/api/transcribe', handler: handleTranscribeRoute },
  { method: 'POST', path: '/api/transcribe-file', handler: handleTranscribeFileRoute },
  { method: 'POST', path: '/api/resolve-video', handler: handleResolveVideoRoute },
];

/**
 * 分发请求。
 * @returns {Promise<boolean>} 是否命中路由；false 表示调用方应走静态文件兜底
 */
export async function dispatch(req, res, url) {
  for (const r of ROUTES) {
    if (r.method !== req.method || r.path !== url.pathname) continue;
    await r.handler(req, res, url);
    return true;
  }
  return false;
}
