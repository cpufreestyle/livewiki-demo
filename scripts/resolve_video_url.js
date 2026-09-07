// scripts/resolve_video_url.js
//
// LiveWiki — 视频真实链接解析器
//
// 问题背景：
//   很多落地页 / SPA 活动页（如 NVIDIA SCRM 活动页、飞书、各类 H5）里的
//   <video> 标签或播放器并非直链，而是经过 JS 动态注入、m3u8 切片、
//   或嵌套在 iframe 中的第三方播放器。直接把落地页 URL 丢给 yt-dlp / ffmpeg
//   会拿不到真正的视频流地址。
//
// 解决思路（自动、多策略、可降级）：
//   1. URL 本身是直链 → 直接返回
//   2. yt-dlp --get-url 提取（对 YouTube / B站 / 腾讯 / 优酷 等已知平台有效）
//   3. Playwright 无头浏览器加载页面，嗅探真实媒体网络请求（mp4 / m3u8 / webm …）
//      并读取 <video> 的 currentSrc、<source>、嵌套 iframe 的 src
//   4. 对每个嵌套 iframe 的 src 再跑一次 yt-dlp（第三方播放器常用于 iframe，有数量上限）
//   5. 静态 HTML 解析兜底（og:video meta、JSON-LD、video/source 标签、m3u8 链接）
//
// 输出：按可信度打分排序的候选链接列表，并给出最佳候选。
//
// 性能：整条链路受 RESOLVE_BUDGET_MS 软截止约束，到点即返回已收集到的候选，
//       不再继续后续策略；媒体出现后由事件驱动提前结束等待，而非固定 sleep。

import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { URL as URLParse } from 'url';
import http from 'http';
import https from 'https';

import {
  MEDIA_EXT, MEDIA_CT,
  URL_FORM_SCORE, URL_FORM_DEFAULT_SCORE, SOURCE_SCORE,
  TIMEOUT, LIMITS, DEFAULT_UA, RESOLVE_BUDGET_MS,
} from '../lib/constants.mjs';
import { createLogger } from '../lib/log.mjs';
import { assertPublicUrl, isPublicUrl } from '../lib/url-guard.mjs';
import { autoRegister, clickPlay } from './autofill_login.js';

const log = createLogger('resolver');

// ─── 媒体特征 ────────────────────────────────────────────────

// 不该作为视频流返回的伪协议
function isUseless(url) {
  return /^blob:/i.test(url) || /^data:/i.test(url) || !url || url.length < LIMITS.MIN_URL_LEN;
}

function isDirectMedia(url) {
  return MEDIA_EXT.test(url.split('?')[0].split('#')[0]);
}

function scoreByUrl(url) {
  const u = url.split('?')[0].split('#')[0].toLowerCase();
  for (const [re, score] of URL_FORM_SCORE) if (re.test(u)) return score;
  return URL_FORM_DEFAULT_SCORE;
}

// ─── 工具：安全地把字符串加入候选 Map ─────────────────────────
// 只接受公网 http(s) 地址：既是防 SSRF 的第二道闸，
// 也保证回显给前端的候选列表里不会出现内网地址。
function makeStore(onAdd) {
  const map = new Map();
  return {
    add(url, reason, score) {
      if (isUseless(url)) return;
      if (!isPublicUrl(url)) return;
      if (!map.has(url)) map.set(url, { url, reasons: new Set(), score: 0, times: 0 });
      const e = map.get(url);
      if (reason) e.reasons.add(reason);
      e.score += (score || 0);
      e.times += 1;
      if (onAdd) { try { onAdd(e); } catch {} }
    },
    list() {
      return [...map.values()].map(e => ({
        url: e.url,
        score: e.score + scoreByUrl(e.url), // 叠加 URL 形态加成
        times: e.times,
        reason: [...e.reasons].join(' / ') || '嗅探'
      }));
    }
  };
}

// ─── Cookie 解析（支持两种格式） ───────────────────────────
// 1) 原始 Cookie 请求头字符串："a=b; c=d"（用户从 DevTools Network 复制最方便）
// 2) JSON 数组（cookie-editor 等扩展导出）：[{name,value,domain,path}]
function parseCookies(input, pageHost) {
  if (!input) return [];
  input = String(input).trim();
  if (!input) return [];
  // JSON 数组
  if (input.startsWith('[')) {
    try {
      const arr = JSON.parse(input);
      if (Array.isArray(arr)) {
        return arr
          .map(c => ({
            name: c.name, value: c.value,
            domain: c.domain || pageHost || '', path: c.path || '/',
            secure: !!c.secure, httpOnly: !!c.httpOnly
          }))
          .filter(c => c.name);
      }
    } catch (e) {
      log.swallow('Cookie JSON 解析（按字符串处理）', e);
    }
  }
  // 原始 "k=v; k2=v2" 字符串
  const out = [];
  for (const part of input.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push({ name, value, domain: pageHost || '', path: '/' });
  }
  return out;
}

// 由 cookie 列表拼回 "k=v; k2=v2" 请求头（给 yt-dlp / fetchHttp 用）
function cookieHeaderFrom(input) {
  let s;
  if (typeof input === 'string') s = input.trim();
  else if (Array.isArray(input)) s = input.map(c => `${c.name}=${c.value}`).join('; ');
  else return '';
  // 去掉 CR/LF：否则可通过 --add-header 注入伪造请求头
  return s.replace(/[\r\n]+/g, ' ');
}

// ─── 策略 2：yt-dlp --get-url ───────────────────────────────
function tryYtDlp(pageUrl, store, label = 'yt-dlp', cookieHeader = '') {
  const extra = [];
  if (cookieHeader) extra.push('--add-header', `Cookie:${cookieHeader}`);
  try {
    const out = execFileSync(
      'python3',
      ['-m', 'yt_dlp', '--get-url', '--no-playlist', '--force-ipv4', '--skip-download', ...extra, pageUrl],
      { timeout: TIMEOUT.YTDLP_GET_URL, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const urls = out.split('\n').map(s => s.trim()).filter(Boolean);
    urls.forEach((u, i) => store.add(u, `${label} 提取`, SOURCE_SCORE.YTDLP - Math.min(i, 10)));
    return urls.length > 0;
  } catch (e) {
    log.swallow(`yt-dlp 提取(${label})`, e);
    return false;
  }
}

// ─── 时间预算 ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function remaining(deadline, cap) {
  const left = deadline - Date.now();
  if (left <= 0) return 0;
  return Math.min(left, cap);
}

/** 等到「出现第一个媒体候选」或超时——事件驱动，避免无条件 sleep。 */
function waitForSignal(signalPromise, ms) {
  if (ms <= 0) return Promise.resolve(false);
  return Promise.race([signalPromise, sleep(ms).then(() => false)]);
}

// ─── 策略 3：Playwright 无头浏览器嗅探 ───────────────────────
async function tryPlaywright(pageUrl, { timeout, cookies = [], phone = '', deadline }) {
  let browser;
  // 收集到媒体链接时触发 signal，主流程据此提前结束等待（事件驱动，替代无条件 sleep）
  let fireMedia;
  const mediaSignal = new Promise((r) => { fireMedia = r; });
  const store = makeStore((e) => { if (MEDIA_EXT.test(e.url)) fireMedia(true); });
  const hints = new Set();   // 可疑的视频/播放器域名（诊断用，未必是直链）
  let iframeSrcs = [];
  let title = '';
  let bytesScanned = 0;      // 响应体扫描的全局字节预算

  // 广义“像视频”的 URL 特征（不完全要求扩展名），用于失败时给诊断线索
  const HINT_RE = /(?:vod|video|media|play|live|stream|\.m3u8|\.mp4|\.mpd|aliyun|polyv|qiniu|tencent|baidu|ksyun|cloud|oss|cos|cdn)/i;
  const addHint = (u) => { if (u && !isUseless(u) && isPublicUrl(u)) hints.add(u); };

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (e) {
    // 区分“浏览器没装/无法启动”与“页面本身的问题”，便于给出可操作提示
    const msg = e.message || '';
    const browserMissing = /Executable doesn't exist|playwright install|Failed to launch|chromium/i.test(msg);
    log.warn('浏览器启动失败:', msg);
    return { store, iframeSrcs, error: msg, browserMissing };
  }

  try {
    const context = await browser.newContext({
      userAgent: process.env.LW_UA || DEFAULT_UA,
      // 允许自动播放，避免某些播放器因为策略不加载
      permissions: []
    });

    // 注入用户提供的登录态 Cookie（手动登录后复制）
    if (cookies && cookies.length) {
      try { await context.addCookies(cookies); } catch (e) { log.swallow('注入 Cookie', e); }
    }

    const page = await context.newPage();

    // ── 自动手机号登录（无需验证码的报名/活动页）──
    // 顺序很重要：必须先点开表单，再填手机号。
    if (phone) {
      await autoRegister(page, { phone, url: pageUrl });
      // 让提交后的页面加载播放器并请求真实流（受总预算约束）
      await sleep(remaining(deadline, 5000));
    }

    // 嗅探所有响应：媒体扩展名 / 媒体 content-type，以及 API 返回的“隐藏视频地址”
    // （活动落地页常把真实视频地址放在 JSON 接口里，如 Jingsocial 微页面）
    const MEDIA_IN_BODY = /https?:\/\/[^\s"'\\<>{}]+\/(?:[^\s"'\\<>{}]*?\.(?:m3u8|m3u|mp4|webm|mov|mpd|flv))(?:\?[^\s"'\\<>{}]*)?/gi;
    // 第三方视频平台页面（yt-dlp 可直接解析）
    const PLATFORM_IN_BODY = /https?:\/\/(?:v\.qq\.com|youku\.com|(?:www\.)?bilibili\.com|player\.bilibili\.com|tv\.sohu\.com|v\.youku\.com|www\.tudou\.com|weixin\.qq\.com|mp\.weixin\.qq\.com)[^\s"'\\<>{}]*/gi;

    page.on('response', async (resp) => {
      const url = resp.url();
      if (isUseless(url)) return;
      const ct = resp.headers()['content-type'] || '';
      if (HINT_RE.test(url)) addHint(url);

      // 1) 直接的媒体流响应
      if (MEDIA_EXT.test(url) || MEDIA_CT.test(ct)) {
        store.add(url, `网络响应(${ct || 'media'})`, SOURCE_SCORE.NETWORK_RESPONSE);
        return;
      }

      // 2) 扫描 JSON / 文本 / JS 响应体，挖掘其中内嵌的视频地址（活动页常见）
      if (/json|text\/|javascript|xml/.test(ct) && resp.status() === 200) {
        const cl = parseInt(resp.headers()['content-length'] || '0', 10);
        if (cl > LIMITS.BODY_SCAN_SKIP_CL) return;          // 声明过大则跳过
        if (bytesScanned >= LIMITS.BODY_SCAN_MAX) return;    // 全局预算耗尽
        try {
          const txt = await resp.text();
          if (!txt || txt.length > LIMITS.BODY_SCAN_MAX) return;
          bytesScanned += txt.length;
          // 用 matchAll 而非带 /g 的 exec 循环：后者共享 lastIndex，
          // 一旦中途抛错会污染后续所有响应的匹配起点。
          for (const m of txt.matchAll(MEDIA_IN_BODY)) {
            store.add(m[0], `API响应体(${resp.status()})`, SOURCE_SCORE.API_BODY);
          }
          for (const m of txt.matchAll(PLATFORM_IN_BODY)) {
            store.add(m[0], 'API第三方播放器', SOURCE_SCORE.API_PLATFORM);
          }
        } catch (e) {
          log.swallow('读取响应体', e);
        }
      }
    });

    // 嗅探请求侧（部分 m3u8 由 JS fetch 拉取，response 可能被缓存漏掉）
    page.on('request', (req) => {
      const url = req.url();
      if (HINT_RE.test(url)) addHint(url);
      if (MEDIA_EXT.test(url)) {
        store.add(url, '媒体请求', SOURCE_SCORE.MEDIA_REQUEST);
      }
    });

    // 记录页面标题（诊断用）
    try { title = await page.title(); } catch (e) { log.swallow('读取页面标题', e); }

    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: remaining(deadline, timeout) || timeout });
    } catch (e) {
      // 超时也继续，已捕获到的响应仍然有效
      log.swallow('页面加载', e);
    }

    // 给播放器一点时间懒加载真实流地址；一旦媒体出现立即结束等待
    await waitForSignal(mediaSignal, remaining(deadline, 5000));

    // 2.5) 触发式播放器（如阿里云播放器 / 微信视频）：很多落地页只有在点击
    //      「观看 / 直播 / 回放 / Play」后才会向真实 CDN 请求 m3u8/mp4。
    if (remaining(deadline, 1000) > 0 && store.list().length === 0) {
      await clickPlay(page, { url: pageUrl });
      await waitForSignal(mediaSignal, remaining(deadline, 4000));
    }

    // 3) 兜底：扫描整页渲染后的 HTML，挖掘内嵌媒体/平台地址
    try {
      const html = await page.content();
      for (const m of html.matchAll(MEDIA_IN_BODY)) store.add(m[0], '页面HTML', SOURCE_SCORE.PAGE_HTML);
      for (const m of html.matchAll(PLATFORM_IN_BODY)) store.add(m[0], '页面第三方播放器', SOURCE_SCORE.PAGE_PLATFORM);
    } catch (e) {
      log.swallow('扫描页面 HTML', e);
    }

    // 收集 <video> 当前真实 src
    const videoSrcs = await page.$$eval('video', (els) => {
      const res = [];
      for (const v of els) {
        if (v.currentSrc) res.push(v.currentSrc);
        else if (v.src) res.push(v.src);
        for (const s of v.querySelectorAll('source')) {
          if (s.src) res.push(s.src);
        }
      }
      return res.filter(Boolean);
    }).catch((e) => { log.swallow('读取 <video> 地址', e); return []; });
    videoSrcs.forEach(u => store.add(u, '<video> 真实地址', SOURCE_SCORE.VIDEO_TAG));

    // 收集 iframe src（第三方播放器常见）
    iframeSrcs = await page.$$eval('iframe', (els) =>
      els.map(e => e.src || e.getAttribute('data-src')).filter(Boolean)
    ).catch((e) => { log.swallow('读取 iframe', e); return []; });

    await browser.close();
    browser = null;
  } catch (e) {
    log.warn('嗅探过程异常:', e.message);
    return { store, iframeSrcs, error: e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { store, iframeSrcs, hints: [...hints], title, error: null };
}

// ─── 策略 5：静态 HTML 解析兜底（无浏览器时） ─────────────────
function fetchHttp(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > LIMITS.MAX_REDIRECTS) return resolve({ ok: false });
    let u;
    try {
      u = new URLParse(url);
      assertPublicUrl(u.href); // 重定向目标同样要过 SSRF 守卫
    } catch {
      return resolve({ ok: false });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      headers: { 'User-Agent': process.env.LW_UA || DEFAULT_UA, 'Accept': '*/*' },
      timeout: TIMEOUT.STATIC_HTTP
    }, (res) => {
      // 跟随重定向（有次数上限）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // 释放连接
        return resolve(fetchHttp(new URLParse(res.headers.location, url).href, redirects + 1));
      }
      // 流式读取并在超过预算时截断，避免无 content-length 的大响应撑爆内存
      let data = '';
      let done = false;
      const finish = (html, truncated) => {
        if (done) return;
        done = true;
        resolve({ ok: true, html, finalUrl: url, truncated });
      };
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (done) return;
        data += c;
        if (data.length >= LIMITS.BODY_SCAN_MAX) {
          res.destroy();
          finish(data, true);
        }
      });
      res.on('end', () => finish(data, false));
      res.on('error', () => finish('', false));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

function parseStaticHtml(html, pageUrl, store) {
  if (!html) return;
  const base = pageUrl;

  const push = (raw) => {
    if (!raw) return;
    let u = raw.trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('/')) {
      try { u = new URLParse(u, base).href; } catch { return; }
    }
    store.add(u, '静态解析', SOURCE_SCORE.STATIC);
  };

  // og:video / og:video:url / og:video:secure_url
  for (const m of html.matchAll(/<meta[^>]+property=["']og:video(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  // <video src> / <source src>
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  // JSON-LD 中的视频 URL
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const json = JSON.parse(m[1]);
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.contentUrl === 'string') push(obj.contentUrl);
        if (typeof obj.url === 'string' && isDirectMedia(obj.url)) push(obj.url);
        if (typeof obj.embedUrl === 'string') push(obj.embedUrl);
        for (const k of Object.values(obj)) walk(k);
      };
      walk(json);
    } catch (e) {
      log.swallow('JSON-LD 解析', e);
    }
  }
  // 直接出现 m3u8 / mp4 的链接（扩展名须在路径中，避免把域名误判）
  for (const m of html.matchAll(/(https?:\/\/[^\s"'<>]+\/(?:[^\s"'<>]*?\.(?:m3u8|mp4|webm|mov)))(?:\?[^"'\s<>]*)?/gi)) {
    push(m[1]);
  }
}

// ─── 主入口 ──────────────────────────────────────────────────
export async function resolveVideoUrl(pageUrl, { timeout = TIMEOUT.PLAYWRIGHT_GOTO, cookies = '', phone = '' } = {}) {
  // SSRF 守卫：解析目标必须是公网 http(s) 地址
  assertPublicUrl(pageUrl);

  const budget = Number(process.env.LW_RESOLVE_BUDGET_MS) || RESOLVE_BUDGET_MS;
  const deadline = Date.now() + budget;
  const origin = (() => { try { return new URLParse(pageUrl).origin; } catch { return ''; } })();
  // Cookie 字符串 / JSON 数组 → Playwright cookie 列表；同时拼回 header 给 yt-dlp
  let cookieList = [];
  try {
    cookieList = parseCookies(cookies, (() => { try { return new URLParse(pageUrl).host; } catch { return ''; } })());
  } catch (e) {
    log.swallow('Cookie 解析', e);
  }
  const cookieHeader = cookieHeaderFrom(cookies);

  // 1. 本身就是直链
  if (isDirectMedia(pageUrl)) {
    return {
      ok: true,
      method: 'direct',
      resolved: pageUrl,
      origin,
      candidates: [{ url: pageUrl, score: 100, times: 1, reason: '直链地址' }]
    };
  }

  const master = makeStore();

  // 2. yt-dlp 直取落地页（带 Cookie）
  if (remaining(deadline, TIMEOUT.YTDLP_GET_URL) > 0) {
    tryYtDlp(pageUrl, master, 'yt-dlp', cookieHeader);
  }

  // 3 + 4. Playwright 嗅探 + iframe 收集（带 Cookie + 自动手机号登录）
  let iframeSrcs = [];
  let browserMissing = false;
  let diagHints = [];
  let diagTitle = '';
  try {
    const r = await tryPlaywright(pageUrl, { timeout, cookieList, phone, deadline });
    r.store && r.store.list().forEach(c => master.add(c.url, c.reason, c.score));
    iframeSrcs = r.iframeSrcs || [];
    browserMissing = !!r.browserMissing;
    diagHints = r.hints || [];
    diagTitle = r.title || '';
  } catch (e) {
    // 浏览器不可用时静默降级
    log.swallow('Playwright 嗅探', e);
  }

  // 4. 对每个 iframe src 再尝试 yt-dlp（第三方播放器）
  //    有数量上限：此前无上限且每个最多 25s，iframe 多时会把整条链路拖到数分钟
  const seenIframe = new Set();
  for (const src of iframeSrcs) {
    if (seenIframe.size >= LIMITS.MAX_IFRAME_RECURSE) break;
    if (remaining(deadline, TIMEOUT.YTDLP_GET_URL) <= 0) break;
    if (isUseless(src) || seenIframe.has(src)) continue;
    seenIframe.add(src);
    // iframe 的 src 本身就可能是 m3u8/mp4
    if (isDirectMedia(src)) master.add(src, '<iframe>', SOURCE_SCORE.IFRAME_DIRECT);
    else tryYtDlp(src, master, 'iframe-yt-dlp', cookieHeader);
  }

  // 5. 静态 HTML 兜底（即便浏览器成功也补一层，覆盖懒加载未触发的情况）
  if (remaining(deadline, TIMEOUT.STATIC_HTTP) > 0) {
    try {
      const { ok, html } = await fetchHttp(pageUrl);
      if (ok) parseStaticHtml(html, pageUrl, master);
    } catch (e) {
      log.swallow('静态 HTML 兜底', e);
    }
  }

  // 汇总排序
  const candidates = master.list().filter(c => !isUseless(c.url));
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    // 区分“浏览器没装”与“页面真的没有可嗅探的链接”，给出可操作提示
    if (browserMissing) {
      return {
        ok: false, method: 'browser-missing', resolved: null, origin, candidates: [],
        error: '未找到可用的视频链接。原因：Playwright 无头浏览器（chromium）未安装或无法启动，' +
          '导致无法嗅探 JS 动态注入的视频流。请先执行 `npx playwright install chromium` 后再试。'
      };
    }
    return {
      ok: false, method: 'none', resolved: null, origin, candidates: [],
      error: '未找到可用的视频链接',
      diag: { title: diagTitle, iframes: iframeSrcs, hints: diagHints.slice(0, LIMITS.MAX_DIAG_HINTS) }
    };
  }

  return {
    ok: true,
    method: candidates[0].reason,
    resolved: candidates[0].url,
    origin,
    candidates: candidates.slice(0, LIMITS.MAX_CANDIDATES),
    diag: { title: diagTitle, iframes: iframeSrcs, hints: diagHints.slice(0, LIMITS.MAX_DIAG_HINTS) }
  };
}

// 供其它模块判断是否需要解析
export function looksLikeDirectMedia(url) {
  return isDirectMedia(url);
}
