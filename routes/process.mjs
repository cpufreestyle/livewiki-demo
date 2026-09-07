// POST /api/process — 逐字稿结构化处理（?stream=1 时走 SSE）

import { processTranscript } from '../lib/pipeline.mjs';
import { sseHeaders, sseSend } from '../lib/sse.mjs';
import { sendJson, readJsonBody } from '../lib/http.mjs';
import { MIN_TRANSCRIPT_CHARS } from '../lib/constants.mjs';

export async function handleProcess(req, res, url) {
  const { text } = await readJsonBody(req);
  if (!text || text.trim().length < MIN_TRANSCRIPT_CHARS) {
    return sendJson(res, 400, { error: `文本太短，至少需要 ${MIN_TRANSCRIPT_CHARS} 个字符` });
  }

  // SSE 流式分支：逐节推送，前端秒见骨架、LLM 归纳完成后无缝替换
  if (url.searchParams.get('stream') === '1') {
    sseHeaders(res);
    try {
      await processTranscript(text, { onEvent: (ev) => sseSend(res, ev) });
    } catch (e) {
      sseSend(res, { type: 'error', payload: { message: e.message } });
    } finally {
      res.end();
    }
    return;
  }

  // 非流式兜底（便于脚本/测试直接拿完整 JSON）
  try {
    const result = await processTranscript(text);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}
