// POST /api/transcribe — 视频 URL → 下载 + ASR 转写 + 说话人识别
// 逻辑复用 scripts/server_handlers.mjs（与 Vercel serverless 函数一致）

import { readJsonBody } from '../lib/http.mjs';
import { handleTranscribe } from '../scripts/server_handlers.mjs';

export async function handleTranscribeRoute(req, res) {
  const parsed = await readJsonBody(req);
  await handleTranscribe(res, parsed);
}
