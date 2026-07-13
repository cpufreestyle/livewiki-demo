// 视频转写 / 解析 的共享处理逻辑
// 同时被本地 server.js 与 Vercel serverless 函数（api/*.mjs）复用，避免重复实现。
//
// 约定：处理函数接收 (res, body)，直接用 Node 风格的 res.writeHead / res.end 输出 JSON。
// 这样在原生 http.Server 与 @vercel/node 的 Lambda res 上都能工作。

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveVideoUrl } from './resolve_video_url.js';

// 判断一个 URL 是否为视频直链（扩展名须位于路径中，避免把 www.mov 之类域名误判）
export const DIRECT_MEDIA_RE = /\/[^\/]*\.(mp4|m3u8|m3u|webm|mov|mkv|flv|ts|m4v|mp3|m4a|wav|aac|mpd)(\?|#|$)/i;

// 懒加载式解析包装：即使 Playwright 不可用也不要让整次请求崩溃
export async function resolveRealVideoUrl(pageUrl, { cookies = '', phone = '' } = {}) {
  try {
    return await resolveVideoUrl(pageUrl, { cookies, phone });
  } catch (e) {
    return { ok: false, resolved: null, origin: '', candidates: [], method: 'error', error: e.message };
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ─── 仅解析落地页中的真实视频链接（不下载、不转写） ─────────────────
export async function handleResolveVideo(res, body) {
  const pageUrl = body?.url;
  if (!pageUrl || !pageUrl.trim()) {
    json(res, 400, { error: '请提供页面 URL' });
    return;
  }
  try {
    const resolved = await resolveRealVideoUrl(pageUrl, { cookies: body?.cookies, phone: body?.phone });
    json(res, resolved.ok ? 200 : 404, resolved);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

// ─── 从视频 URL 下载 + ASR 转写 + 说话人识别 ───────────────────────
// 支持落地页 / SPA：默认自动定位页面内真实视频链接后再转写
export async function handleTranscribe(res, body) {
  const { url: videoUrl, skipDiarization, whisperModel, autoResolve, resolvedUrl, cookies, phone } = body || {};
  if (!videoUrl || !videoUrl.trim()) {
    json(res, 400, { error: '请提供视频 URL' });
    return;
  }

  // ── 自动定位真实视频链接（落地页默认开启）──
  let downloadUrl = videoUrl;
  const shouldResolve = resolvedUrl ? false : (autoResolve === undefined ? true : autoResolve);

  const resolveInfo = {
    autoResolve: !!shouldResolve,
    resolved: false,
    method: 'none',
    origin: '',
    candidates: [],
    resolvedUrl: null,
    error: null,
  };

  if (resolvedUrl) {
    downloadUrl = resolvedUrl;
    resolveInfo.resolved = true;
    resolveInfo.method = 'manual';
  } else if (shouldResolve) {
    const resolved = await resolveRealVideoUrl(videoUrl, { cookies, phone });
    resolveInfo.resolved = resolved.ok;
    resolveInfo.method = resolved.method || 'none';
    resolveInfo.origin = resolved.origin || '';
    resolveInfo.candidates = resolved.candidates || [];
    resolveInfo.resolvedUrl = resolved.ok ? resolved.resolved : null;
    resolveInfo.error = resolved.error || null;
    if (resolved.ok && resolved.resolved) downloadUrl = resolved.resolved;
    console.log(`[transcribe] 链接解析: method=${resolved.method} 命中=${resolved.ok} 候选数=${(resolved.candidates || []).length} → ${downloadUrl}`);
  }

  // 自动解析失败，且原始 URL 并非直链：直接返回友好提示，避免后端盲下载浪费时间
  if (shouldResolve && !resolvedUrl && !resolveInfo.resolved && !DIRECT_MEDIA_RE.test(videoUrl)) {
    json(res, 422, {
      error: '未能自动定位该页面中的真实视频链接。常见原因：活动页需要登录/报名后才能播放，或视频由第三方播放器（如阿里云 VOD）加密。' +
        '建议：点「🔎 解析链接」查看是否嗅探到候选地址并手动选择，或直接粘贴视频直链。',
      resolve: resolveInfo,
    });
    return;
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'transcribe.py');
  const outputDir = path.join(os.tmpdir(), `livewiki_transcribe_${Date.now()}`);
  const hfToken = process.env.HF_TOKEN || '';

  const args = [
    scriptPath,
    '--url', downloadUrl,
    '--output', outputDir,
    '--whisper-model', whisperModel || 'small',
  ];
  // 优先使用本地模型
  const localModelPath = path.join(process.cwd(), 'models', 'whisper-small');
  if (fs.existsSync(path.join(localModelPath, 'model.bin'))) {
    args.push('--model-path', localModelPath);
  }
  if (hfToken) args.push('--hf-token', hfToken);
  if (skipDiarization) args.push('--skip-diarization');
  // 携带落地页来源作为 Referer，绕过防盗链（解析到真实链接时才有意义）
  if (resolveInfo.origin) { args.push('--referer', resolveInfo.origin); }

  console.log(`[transcribe] 启动 Python 脚本: python3 ${args.join(' ')}`);

  const child = execFile('python3', args, {
    timeout: 900000, // 15 分钟超时
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  }, (err, stdout, stderr) => {
    if (err && err.killed) {
      console.error('[transcribe] 超时或被终止');
      json(res, 504, { error: '转写超时（超过 15 分钟），请尝试较短的音频', resolve: resolveInfo });
      return;
    }
    if (err) {
      console.error('[transcribe] Python 脚本失败:', err.message);
      console.error('[transcribe] stderr:', stderr?.substring(0, 500));
      json(res, 500, {
        error: '转写失败: ' + (err.message || '未知错误'),
        hint: '请确保已安装 yt-dlp, ffmpeg, faster-whisper',
        stderr: stderr?.substring(0, 1000),
        resolve: resolveInfo,
      });
      return;
    }

    try {
      const result = JSON.parse(stdout.trim().split('\n').pop());
      result.resolve = resolveInfo;
      if (result.ok) {
        console.log(`[transcribe] 成功: ${result.word_count} 字, ${result.segment_count} 片段`);
        json(res, 200, result);
      } else {
        json(res, 500, { error: result.error || '转写失败', resolve: resolveInfo });
      }
    } catch (parseErr) {
      console.error('[transcribe] JSON 解析失败:', stdout.substring(0, 500));
      json(res, 500, {
        error: '转写结果解析失败',
        stdout: stdout.substring(0, 1000),
        stderr: stderr?.substring(0, 1000),
        resolve: resolveInfo,
      });
    }
  });
}
