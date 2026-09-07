// GET /api/transcribe/status — 检查转写环境依赖是否就绪

import { execSync } from 'child_process';

import { sendJson } from '../lib/http.mjs';

export function handleTranscribeStatus(req, res) {
  const checks = {};
  const env = { ...process.env };

  const probe = (name, cmd, opts = {}) => {
    try {
      execSync(cmd, { stdio: 'pipe', env, timeout: 5000, ...opts });
      checks[name] = true;
    } catch {
      checks[name] = false;
    }
  };

  probe('python3', 'which python3');
  probe('yt_dlp', 'python3 -m yt_dlp --version');
  probe('ffmpeg', 'which ffmpeg');
  probe('faster_whisper', 'python3 -c "import faster_whisper"');
  probe('pyannote', 'python3 -c "import pyannote.audio"');
  checks.hf_token = !!process.env.HF_TOKEN;

  const allReady = checks.python3 && checks.yt_dlp && checks.ffmpeg && checks.faster_whisper;

  sendJson(res, 200, {
    ready: allReady,
    checks,
    message: allReady ? '环境就绪' : '部分依赖缺失，转写功能可能不可用'
  });
}
