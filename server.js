/**
 * LiveWiki — AI 直播课程知识沉淀引擎 Demo
 * 核心闭环：粘贴 ASR 逐字稿 → AI 清洗 + 结构化切分 → 生成带导航的学习文档 → 导出 Markdown
 *
 * 本文件只做「引导 + 分发」：路由表见 routes/index.mjs，
 * 共享处理管线见 lib/ 与 scripts/server_handlers.mjs。
 */

import './lib/env.mjs'; // 必须最先导入：加载 .env 并补齐 PATH

import http from 'http';
import path from 'path';
import { URL } from 'url';

import { corsHeaders, serveStatic } from './lib/http.mjs';
import { createLogger } from './lib/log.mjs';
import { dispatch } from './routes/index.mjs';

const log = createLogger('server');

const PORT = Number(process.env.PORT) || 3210;
const PUBLIC_DIR = path.join(process.cwd(), 'public');

const server = http.createServer(async (req, res) => {
  corsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  try {
    // 1) API 路由
    if (await dispatch(req, res, url)) return;
    // 2) 静态文件兜底（含 SPA 回退到 index.html）
    serveStatic(res, PUBLIC_DIR, url.pathname);
  } catch (e) {
    log.error(`请求处理异常 ${req.method} ${url.pathname}:`, e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  LiveWiki Demo — AI 知识沉淀引擎已启动  ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  地址: http://localhost:${PORT}             ║`);
  console.log(`║  状态: 运行中 ✓                          ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
