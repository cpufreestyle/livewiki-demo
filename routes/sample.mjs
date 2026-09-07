// GET /api/sample — 返回内置示例逐字稿

import { SAMPLE_TRANSCRIPT } from '../lib/pipeline.mjs';
import { sendJson } from '../lib/http.mjs';

export function handleSample(req, res) {
  sendJson(res, 200, { text: SAMPLE_TRANSCRIPT });
}
