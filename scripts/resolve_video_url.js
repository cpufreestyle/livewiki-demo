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
//   4. 对每个嵌套 iframe 的 src 再跑一次 yt-dlp（第三方播放器常用于 iframe）
//   5. 静态 HTML 解析兜底（og:video meta、JSON-LD、video/source 标签、m3u8 链接）
//
// 输出：按可信度打分排序的候选链接列表，并给出最佳候选。

import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { URL as URLParse, parse as urlParse } from 'url';
import http from 'http';
import https from 'https';

// ─── 媒体特征 ────────────────────────────────────────────────

// 常见直链 / 流媒体扩展名
// 注意：必须要求扩展名位于「路径」中（前面有 /），否则会把 www.mov 这类域名误判为 .mov 直链
const MEDIA_EXT = /\/[^\/]*\.(mp4|m3u8|m3u|webm|mov|mkv|flv|ts|m4v|mp3|m4a|wav|aac|ogg|mpd)(\?|#|$)/i;
// 视频 / 音频 content-type
const MEDIA_CT = /^(video|audio)\//i;

// 不该作为视频流返回的伪协议
function isUseless(url) {
  return /^blob:/i.test(url) || /^data:/i.test(url) || !url || url.length < 12;
}

function isDirectMedia(url) {
  return MEDIA_EXT.test(url.split('?')[0].split('#')[0]);
}

function scoreByUrl(url) {
  const u = url.split('?')[0].split('#')[0].toLowerCase();
  if (/\.m3u8?$/.test(u)) return 70;      // HLS 主播放列表，yt-dlp 可直接消费
  if (/\.mp4$/.test(u)) return 85;        // 最理想的直链
  if (/\.webm$/.test(u)) return 65;
  if (/\.mpd$/.test(u)) return 55;        // DASH
  if (/\.mov$/.test(u)) return 60;
  if (/\.(ts|m4s)$/.test(u)) return 25;   // 切片片段，单段没意义
  if (/\.(mp3|m4a|wav|aac|ogg)$/.test(u)) return 50;
  return 20;
}

// ─── 工具：安全地把字符串加入候选 Map ─────────────────────────
function makeStore() {
  const map = new Map();
  return {
    add(url, reason, score) {
      if (isUseless(url)) return;
      try { new URLParse(url); } catch { return; }
      if (!map.has(url)) map.set(url, { url, reasons: new Set(), score: 0, times: 0 });
      const e = map.get(url);
      if (reason) e.reasons.add(reason);
      e.score += (score || 0);
      e.times += 1;
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
    } catch { /* 不是合法 JSON，按字符串处理 */ }
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
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return input.map(c => `${c.name}=${c.value}`).join('; ');
  return '';
}

// ─── 策略 2：yt-dlp --get-url ───────────────────────────────
function tryYtDlp(pageUrl, store, label = 'yt-dlp', cookieHeader = '') {
  const extra = [];
  if (cookieHeader) extra.push('--add-header', `Cookie:${cookieHeader}`);
  try {
    const out = execFileSync(
      'python3',
      ['-m', 'yt_dlp', '--get-url', '--no-playlist', '--force-ipv4', '--skip-download', ...extra, pageUrl],
      { timeout: 25000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const urls = out.split('\n').map(s => s.trim()).filter(Boolean);
    urls.forEach((u, i) => store.add(u, `${label} 提取`, 80 - Math.min(i, 10)));
    return urls.length > 0;
  } catch {
    return false;
  }
}

// ─── 策略 3：Playwright 无头浏览器嗅探 ───────────────────────
let lastBrowserLaunchError = null; // 供主流程判断“是否因浏览器不可用而失败”
async function tryPlaywright(pageUrl, timeout, cookies = [], phone = '') {
  let browser;
  const store = makeStore();
  const hints = new Set();   // 可疑的视频/播放器域名（诊断用，未必是直链）
  let iframeSrcs = [];
  let title = '';
  // 广义“像视频”的 URL 特征（不完全要求扩展名），用于失败时给诊断线索
  const HINT_RE = /(?:vod|video|media|play|live|stream|\.m3u8|\.mp4|\.mpd|aliyun|polyv|qiniu|tencent|baidu|ksyun|cloud|oss|cos|cdn)/i;
  const addHint = (u) => { if (u && !isUseless(u)) { try { new URLParse(u); hints.add(u); } catch {} } };
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (e) {
    // 区分“浏览器没装/无法启动”与“页面本身的问题”，便于给出可操作提示
    const msg = e.message || '';
    const browserMissing = /Executable doesn't exist|playwright install|Failed to launch|chromium/i.test(msg);
    lastBrowserLaunchError = browserMissing ? msg : null;
    return { store, iframeSrcs, error: msg, browserMissing };
  }

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      // 允许自动播放，避免某些播放器因为策略不加载
      permissions: []
    });

    // 注入用户提供的登录态 Cookie（手动登录后复制）
    if (cookies && cookies.length) {
      try { await context.addCookies(cookies); } catch {}
    }

    const page = await context.newPage();

    // ── 自动手机号登录（无需验证码的报名/活动页）──
    // 真实流程（以 NVIDIA SCRM / Jingsocial 为例）：
    //   1) 先接受 Cookie 横幅（否则后续点击会被横幅拦截）
    //   2) 点击「注册并观看 / 报名 / 观看」CTA，打开报名表单（手机号框此时才出现）
    //   3) 在弹窗/表单里填手机号（必要时填姓名），提交
    //   4) 等待播放器加载真实视频流
    // 顺序很重要：必须先点开表单，再填手机号。
    if (phone) {
      try {
        const sleep = (ms) => page.waitForTimeout(ms).catch(() => {});

        // 1) 接受 Cookie 横幅
        const cookieLabels = ['全部接受', '接受全部', '同意', '接受', '我同意', '确认', '知道了', 'Got it', 'Accept', '同意并继续'];
        for (const lbl of cookieLabels) {
          const hs = await page.getByText(lbl, { exact: false }).all();
          for (const h of hs.slice(0, 4)) { try { await h.click({ timeout: 1000, force: true }); } catch {} }
        }
        await sleep(800);

        // 2) 点击报名/观看 CTA，打开表单
        const ctaLabels = ['注册并观看', '报名并观看', '立即报名', '我要报名', '报名观看', '观看直播', '直播回放', '注册', '报名', '观看回放'];
        let opened = false;
        for (const lbl of ctaLabels) {
          const hs = await page.getByText(lbl, { exact: false }).all();
          for (const h of hs.slice(0, 3)) {
            try { await h.click({ timeout: 1500, force: true }); opened = true; } catch {}
          }
          if (opened) break;
        }
        await sleep(1000);

        // 3) 轮询等待手机号输入框出现（表单可能在弹窗/异步层里）
        let phoneEl = null;
        for (let i = 0; i < 12; i++) {
          phoneEl = await page.$('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[id*="mobile" i], input[placeholder*="手机" i], input[placeholder*="电话" i], input[placeholder*="手机号" i]').catch(() => null);
          if (phoneEl) break;
          await sleep(700);
        }

        if (phoneEl) {
          // 用 Playwright 原生 fill 触发框架的受控输入事件
          try { await phoneEl.fill(phone); }
          catch {
            await page.evaluate((ph) => {
              const sel = 'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[placeholder*="手机" i], input[placeholder*="电话" i]';
              const el = document.querySelector(sel);
              if (el) { el.focus(); el.value = ph; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            }, phone);
          }
          // 顺带填姓名（报名表单常要求姓名）
          const nameEl = await page.$('input[name*="name" i]:not([type="hidden"]), input[id*="name" i]:not([type="hidden"]), input[placeholder*="姓名" i], input[placeholder*="名字" i]').catch(() => null);
          if (nameEl) { try { await nameEl.fill('LiveWiki User'); } catch {} }
          // 勾选隐私/协议同意框（若提交按钮依赖它）
          const agree = await page.$('input[type="checkbox"]:not([checked])').catch(() => null);
          if (agree) { try { await agree.check({ timeout: 800 }).catch(() => {}); } catch {} }
          await sleep(800);

          // 4) 提交表单
          const submitLabels = ['提交', '确定', '完成', '确认', '提交报名', '立即报名', '进入观看', '开始观看', '观看', 'Submit', 'OK'];
          let submitted = false;
          for (const lbl of submitLabels) {
            const hs = await page.getByText(lbl, { exact: false }).all();
            for (const h of hs.slice(0, 3)) {
              try { await h.click({ timeout: 1500, force: true }); submitted = true; } catch {}
            }
            if (submitted) break;
          }
          if (!submitted) {
            // 兜底：点表单内的最后一个 button / submit
            await page.locator('button, input[type="submit"]').last().click({ timeout: 1500, force: true }).catch(() => {});
          }
        }
        // 让提交后的页面加载播放器并请求真实流
        await sleep(5000);
      } catch {}
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
        store.add(url, `网络响应(${ct || 'media'})`, 50);
        return;
      }

      // 2) 扫描 JSON / 文本 / JS 响应体，挖掘其中内嵌的视频地址（活动页常见）
      if (/json|text\/|javascript|xml/.test(ct) && resp.status() === 200) {
        const cl = parseInt(resp.headers()['content-length'] || '0', 10);
        if (cl > 0 && cl > 6 * 1024 * 1024) return; // 太大则跳过，避免卡顿
        try {
          const buf = await resp.body();
          const txt = buf.toString('utf8');
          if (txt.length > 8 * 1024 * 1024) return;
          let m;
          while ((m = MEDIA_IN_BODY.exec(txt))) store.add(m[0], `API响应体(${resp.status()})`, 55);
          while ((m = PLATFORM_IN_BODY.exec(txt))) store.add(m[0], 'API第三方播放器', 70);
        } catch { /* body 不可读时忽略 */ }
      }
    });

    // 嗅探请求侧（部分 m3u8 由 JS fetch 拉取，response 可能被缓存漏掉）
    page.on('request', (req) => {
      const url = req.url();
      if (HINT_RE.test(url)) addHint(url);
      if (MEDIA_EXT.test(url)) store.add(url, '媒体请求', 40);
    });

    // 记录页面标题（诊断用）
    try { title = await page.title(); } catch {}

    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      // 超时也继续，已捕获到的响应仍然有效
    }

    // 给播放器一点时间懒加载真实流地址
    await page.waitForTimeout(5000).catch(() => {});

    // 2.5) 触发式播放器（如阿里云播放器 / 微信视频）：很多落地页只有在点击
    //      「观看 / 直播 / 回放 / Play」后才会向真实 CDN 请求 m3u8/mp4。
    //      这里做一次无侵入的「播放按钮点击」，提高真实链接命中率。
    try {
      const playLabels = ['观看', '立即观看', '去观看', '播放', '直播', '回放', '重播', 'Watch', 'Play', 'Replay', 'Live', '▶'];
      for (const lbl of playLabels) {
        const handles = await page.getByText(lbl, { exact: false }).all();
        for (const h of handles.slice(0, 3)) {
          try { await h.click({ timeout: 1500, force: true }); } catch {}
        }
      }
      // 顺便点击可能的播放器容器
      await page.locator('video, [class*="player"], [class*="video"], [id*="player"]').first()
        .click({ timeout: 1500, force: true }).catch(() => {});
      await page.waitForTimeout(4000).catch(() => {});
    } catch {}

    // 3) 兜底：扫描整页渲染后的 HTML，挖掘内嵌媒体/平台地址
    try {
      const html = await page.content();
      let m;
      while ((m = MEDIA_IN_BODY.exec(html))) store.add(m[0], '页面HTML', 45);
      while ((m = PLATFORM_IN_BODY.exec(html))) store.add(m[0], '页面第三方播放器', 65);
    } catch {}

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
    }).catch(() => []);
    videoSrcs.forEach(u => store.add(u, '<video> 真实地址', 60));

    // 收集 iframe src（第三方播放器常见）
    iframeSrcs = await page.$$eval('iframe', (els) =>
      els.map(e => e.src || e.getAttribute('data-src')).filter(Boolean)
    ).catch(() => []);

    await browser.close();
    browser = null;
  } catch (e) {
    return { store, iframeSrcs, error: e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { store, iframeSrcs, hints: [...hints], title, error: null };
}

// ─── 策略 5：静态 HTML 解析兜底（无浏览器时） ─────────────────
function fetchHttp(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      timeout: 20000
    }, (res) => {
      // 跟随一次重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchHttp(new URLParse(res.headers.location, url).href));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ ok: true, html: data, finalUrl: url }));
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
      try { u = new URLParse(u, base).href; } catch {}
    }
    store.add(u, '静态解析', 35);
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
    } catch {}
  }
  // 直接出现 m3u8 / mp4 的链接（扩展名须在路径中，避免把域名误判）
  for (const m of html.matchAll(/(https?:\/\/[^\s"'<>]+\/(?:[^\s"'<>]*?\.(?:m3u8|mp4|webm|mov)))(?:\?[^"'\s<>]*)?/gi)) {
    push(m[1]);
  }
}

// ─── 主入口 ──────────────────────────────────────────────────
export async function resolveVideoUrl(pageUrl, { timeout = 35000, cookies = '', phone = '' } = {}) {
  const origin = (() => { try { return new URLParse(pageUrl).origin; } catch { return ''; } })();
  // Cookie 字符串 / JSON 数组 → Playwright cookie 列表；同时拼回 header 给 yt-dlp
  let cookieList = [];
  try { cookieList = parseCookies(cookies, (() => { try { return new URLParse(pageUrl).host; } catch { return ''; } })()); } catch {}
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
  tryYtDlp(pageUrl, master, 'yt-dlp', cookieHeader);

  // 3 + 4. Playwright 嗅探 + iframe 收集（带 Cookie + 自动手机号登录）
  let iframeSrcs = [];
  let browserMissing = false;
  let diagHints = [];
  let diagTitle = '';
  try {
    const r = await tryPlaywright(pageUrl, timeout, cookieList, phone);
    r.store && r.store.list().forEach(c => master.add(c.url, c.reason, c.score));
    iframeSrcs = r.iframeSrcs || [];
    browserMissing = !!r.browserMissing;
    diagHints = r.hints || [];
    diagTitle = r.title || '';
  } catch { /* 浏览器不可用时静默降级 */ }

  // 4. 对每个 iframe src 再尝试 yt-dlp（第三方播放器）
  const seenIframe = new Set();
  for (const src of iframeSrcs) {
    if (isUseless(src) || seenIframe.has(src)) continue;
    seenIframe.add(src);
    // iframe 的 src 本身就可能是 m3u8/mp4
    if (isDirectMedia(src)) master.add(src, '<iframe> 直链', 75);
    else tryYtDlp(src, master, 'iframe-yt-dlp');
  }

  // 5. 静态 HTML 兜底（即便浏览器成功也补一层，覆盖懒加载未触发的情况）
  try {
    const { ok, html } = await fetchHttp(pageUrl);
    if (ok) parseStaticHtml(html, pageUrl, master);
  } catch { /* 忽略 */ }

  // 汇总排序
  const candidates = master.list().filter(c => !isUseless(c.url));
  // blob / data 已在收集时过滤；再次剔除明显非媒体的短链接
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
      diag: { title: diagTitle, iframes: iframeSrcs, hints: diagHints.slice(0, 20) }
    };
  }

  return {
    ok: true,
    method: candidates[0].reason,
    resolved: candidates[0].url,
    origin,
    candidates: candidates.slice(0, 12),
    diag: { title: diagTitle, iframes: iframeSrcs, hints: diagHints.slice(0, 20) }
  };
}

// 供其它模块判断是否需要解析
export function looksLikeDirectMedia(url) {
  return isDirectMedia(url);
}
