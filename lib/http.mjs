// HTTP 辅助：CORS / JSON 读写 / 静态文件
// 供本地 server.js 的路由层复用（Vercel api/*.mjs 有自己的薄封装，不共用）。

import fs from 'fs';
import path from 'path';

// 请求体大小上限，防止超大 body 打爆内存
const MAX_BODY_BYTES = Number(process.env.LW_MAX_BODY_BYTES) || 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * CORS 头。默认同源（不输出 ACAO）；需要跨域调用时设 LW_CORS_ORIGIN 显式放开。
 * 说明：原先固定为 `*`，意味着任意网页都能调用本机 3210 端口的全部接口（含转写）。
 *      前端与接口同源部署，收紧后不影响现有功能。
 */
export function corsHeaders(res) {
  const allow = process.env.LW_CORS_ORIGIN;
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取并解析 JSON 请求体，超限直接抛错。 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/**
 * 静态文件服务。
 * 关键：必须校验解析后的真实路径仍在 publicRoot 之内，
 * 否则 `/../../etc/passwd` 这类请求会读到仓库外的任意文件。
 */
export function serveStatic(res, publicRoot, urlPath, fallback = 'index.html') {
  const root = path.resolve(publicRoot);
  const rel = decodeURIComponent(urlPath === '/' ? '/' + fallback : urlPath);
  const target = path.resolve(root, '.' + rel);

  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // 无扩展名的路径一律回退到 index.html（SPA 行为）
  const finalPath = path.extname(target) && fs.existsSync(target) && fs.statSync(target).isFile()
    ? target
    : path.join(root, fallback);

  try {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(finalPath)] || 'application/octet-stream' });
    res.end(fs.readFileSync(finalPath));
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}
