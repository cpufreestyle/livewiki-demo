// 视频转写 / 解析 的共享处理逻辑
// 同时被本地 server.js 与 Vercel serverless 函数（api/*.mjs）复用，避免重复实现。
//
// 约定：处理函数接收 (res, body)，直接用 Node 风格的 res.writeHead / res.end 输出 JSON。
// 这样在原生 http.Server 与 @vercel/node 的 Lambda res 上都能工作。

import fs from 'fs';
import path from 'path';

import { MEDIA_EXT, MIN_TRANSCRIPT_CHARS } from '../lib/constants.mjs';
import { createLogger } from '../lib/log.mjs';
import { assertPublicUrl } from '../lib/url-guard.mjs';
import { resolveVideoUrl } from './resolve_video_url.js';
import { runTranscribe } from './transcribe_runner.mjs';

const log = createLogger('handlers');

// 与 resolver 共用同一份媒体扩展名定义（此前两处各写一份且此处漏了 ogg）
export const DIRECT_MEDIA_RE = MEDIA_EXT;

// 懒加载式解析包装：即使 Playwright 不可用也不要让整次请求崩溃
export async function resolveRealVideoUrl(pageUrl, { cookies = '', phone = '' } = {}) {
  try {
    return await resolveVideoUrl(pageUrl, { cookies, phone });
  } catch (e) {
    log.warn('链接解析异常:', e.message);
    return { ok: false, resolved: null, origin: '', candidates: [], method: 'error', error: e.message };
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ─── 自动导出转写结果到 Obsidian wiki 目录 ──────────────────────────
// 由环境变量 LW_WIKI_DIR 控制（未设置则不导出）。生成带 frontmatter 的 .md，
// Obsidian 可直接索引。文件名基于标题/时间戳，非法字符会被替换。
export function exportToWiki(result, sourceUrl, title = '') {
  const wikiDir = process.env.LW_WIKI_DIR;
  if (!wikiDir) return null;
  try {
    if (!fs.existsSync(wikiDir)) fs.mkdirSync(wikiDir, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const durationMin = result.duration ? (result.duration / 60).toFixed(1) : '未知';
    const safe = (s) => String(s).replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 80);
    const baseName = safe(title || `LiveWiki_转写_${stamp}`) || `LiveWiki_转写_${stamp}`;
    // 避免覆盖同名文件
    let filePath = path.join(wikiDir, `${baseName}.md`);
    let i = 1;
    while (fs.existsSync(filePath)) { filePath = path.join(wikiDir, `${baseName}_${i++}.md`); }
    // 二次校验：确保最终路径没有越出 wikiDir（防目录穿越）
    const root = path.resolve(wikiDir);
    if (!path.resolve(filePath).startsWith(root + path.sep)) {
      log.warn('wiki 导出路径越界，已拒绝:', filePath);
      return null;
    }
    const fm = [
      '---',
      `title: "${baseName}"`,
      `source: "${sourceUrl || ''}"`,
      `duration_min: ${durationMin}`,
      `word_count: ${result.word_count || 0}`,
      `segment_count: ${result.segment_count || 0}`,
      `created: ${now.toISOString()}`,
      'tags: [livewiki, transcript]',
      '---',
      '',
      `# ${baseName}`,
      '',
    ].join('\n');
    fs.writeFileSync(filePath, fm + (result.text || ''), 'utf8');
    return filePath;
  } catch (e) {
    log.error('wiki 导出失败:', e.message);
    return null;
  }
}

// ─── 仅解析落地页中的真实视频链接（不下载、不转写） ─────────────────
export async function handleResolveVideo(res, body) {
  const pageUrl = body?.url;
  if (!pageUrl || !pageUrl.trim()) {
    json(res, 400, { error: '请提供页面 URL' });
    return;
  }
  // SSRF 守卫：必须是可安全请求的公网 http(s) 地址
  try {
    assertPublicUrl(pageUrl);
  } catch (e) {
    json(res, 400, { error: e.message });
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
  const { url: videoUrl, skipDiarization, whisperModel, autoResolve, resolvedUrl, cookies, phone, title } = body || {};
  if (!videoUrl || !videoUrl.trim()) {
    json(res, 400, { error: '请提供视频 URL' });
    return;
  }

  // SSRF 守卫
  try {
    assertPublicUrl(videoUrl);
    if (resolvedUrl) assertPublicUrl(resolvedUrl);
  } catch (e) {
    json(res, 400, { error: e.message });
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
    log.info(`链接解析: method=${resolved.method} 命中=${resolved.ok} 候选数=${(resolved.candidates || []).length}`);
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

  const out = await runTranscribe({
    source: { type: 'url', value: downloadUrl },
    whisperModel: whisperModel || 'small',
    skipDiarization: !!skipDiarization,
    referer: resolveInfo.origin || '',
  });

  if (!out.ok) {
    // 不回显 stdout/stderr：yt-dlp / ffmpeg 输出包含真实视频地址、Referer 与用户 Cookie
    json(res, out.code, { error: out.error, hint: out.hint, resolve: resolveInfo });
    return;
  }

  const result = out.result;
  result.resolve = resolveInfo;
  // 自动导出到 Obsidian wiki（若配置了 LW_WIKI_DIR）
  const wikiPath = exportToWiki(result, videoUrl, title);
  if (wikiPath) {
    result.wikiExport = wikiPath;
    log.info('已自动导出到 wiki:', wikiPath);
  }
  json(res, 200, result);
}

// ─── 从上传文件转写 ────────────────────────────────────────────────
// 与 handleTranscribe 共用 runTranscribe，仅 source 类型与清理路径不同。
export async function handleTranscribeFile(res, { file, whisperModel, skipDiarization, cleanupDirs = [] }) {
  if (!file) {
    json(res, 400, { error: '未找到上传文件' });
    return;
  }
  const out = await runTranscribe({
    source: { type: 'file', value: file.path },
    whisperModel: whisperModel || 'small',
    skipDiarization: !!skipDiarization,
    cleanupPaths: cleanupDirs,
  });

  if (!out.ok) {
    json(res, out.code, { error: out.error, hint: out.hint });
    return;
  }
  json(res, 200, out.result);
}

export { MIN_TRANSCRIPT_CHARS };
