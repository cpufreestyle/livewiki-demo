// GET /api/last-transcript — 读取最近一次本地转写生成的逐字稿
// 用于把已转好的稿直接导入页面（前端「📥 导入并生成」按钮）。

import fs from 'fs';
import os from 'os';
import path from 'path';

import { sendJson } from '../lib/http.mjs';
import { MIN_TRANSCRIPT_CHARS } from '../lib/constants.mjs';

export function handleLastTranscript(req, res) {
  const candidates = [];
  if (process.env.LW_LAST_TRANSCRIPT_PATH) candidates.push(process.env.LW_LAST_TRANSCRIPT_PATH);
  if (process.env.LW_TRANSCRIPT_PATH) candidates.push(process.env.LW_TRANSCRIPT_PATH);

  // 转写执行器落盘的稳定路径（默认 /tmp/lw_out/transcript_with_speakers.txt）
  const stable = process.env.LW_LAST_TRANSCRIPT_PATH
    || path.join(os.tmpdir(), 'lw_out', 'transcript_with_speakers.txt');
  candidates.push(stable);

  // 兼容旧逻辑：环境变量指定目录 / /tmp 下的 lw_out
  const baseDirs = [process.env.LW_TRANSCRIPT_DIR, '/tmp', os.tmpdir()].filter(Boolean);
  for (const dir of baseDirs) {
    for (const n of ['transcript_with_speakers.txt', 'transcript.txt']) {
      candidates.push(path.join(dir, 'lw_out', n));
    }
  }

  const seen = new Set();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (text.trim().length >= MIN_TRANSCRIPT_CHARS) {
        return sendJson(res, 200, { ok: true, text, path: p, chars: text.length });
      }
    } catch {
      /* 单个候选读取失败，继续下一个 */
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: '未找到本地逐字稿文件，请先完成一次转写'
  });
}
