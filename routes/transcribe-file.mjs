// POST /api/transcribe-file — 上传视频/音频文件后转写

import fs from 'fs';
import os from 'os';
import path from 'path';

import { sendJson } from '../lib/http.mjs';
import { createLogger } from '../lib/log.mjs';
import { UPLOAD_EXT_ALLOWLIST } from '../lib/constants.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { handleTranscribeFile } from '../scripts/server_handlers.mjs';

const log = createLogger('upload');

export async function handleTranscribeFileRoute(req, res) {
  let tmpDir = null;
  try {
    const { fields, file } = await parseMultipart(req);
    if (!file) return sendJson(res, 400, { error: '未找到上传文件' });

    // 扩展名白名单：绝不直接采用用户提供的 filename 拼路径（防目录穿越）
    const rawExt = path.extname(file.filename || '').toLowerCase();
    const ext = UPLOAD_EXT_ALLOWLIST.has(rawExt) ? rawExt : '.bin';
    if (ext === '.bin' && rawExt) log.warn(`扩展名 ${rawExt} 不在白名单内，按 .bin 处理`);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livewiki_upload_'));
    const filePath = path.join(tmpDir, `input${ext}`);
    fs.writeFileSync(filePath, file.data);
    log.info(`收到文件: ${file.filename} (${(file.data.length / 1024 / 1024).toFixed(1)} MB)`);

    // 上传目录交给 runner 在转写结束后统一清理（含成功与失败路径）
    await handleTranscribeFile(res, {
      file: { path: filePath },
      whisperModel: fields.whisperModel || 'small',
      skipDiarization: fields.skipDiarization === 'true',
      cleanupDirs: [tmpDir],
    });
  } catch (e) {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    sendJson(res, 400, { error: e.message });
  }
}
