// POST /api/resolve-video — 仅解析落地页中的真实视频链接（不下载、不转写）

import { readJsonBody } from '../lib/http.mjs';
import { handleResolveVideo } from '../scripts/server_handlers.mjs';

export async function handleResolveVideoRoute(req, res) {
  const parsed = await readJsonBody(req);
  await handleResolveVideo(res, parsed);
}
