/**
 * LiveWiki — AI 直播课程知识沉淀引擎 Demo
 * 核心闭环：粘贴 ASR 逐字稿 → AI 清洗 + 结构化切分 → 生成带导航的学习文档 → 导出 Markdown
 *
 * 纯 Node.js 实现，零第三方依赖，内置模拟 AI 处理管线。
 * 真实环境下可接入 OpenAI / Claude API 替换模拟处理。
 */

import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { execFile, execSync } from 'child_process';
import os from 'os';

// ── 轻量加载 .env（无第三方依赖）：为 LW_WIKI_DIR / HF_TOKEN 等提供本地配置 ──
// .env 已在 .gitignore 中，不会提交，避免把个人路径写进仓库。
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch {}

// 确保能找到 homebrew、python3 等工具
const extraPaths = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.HOME + '/.local/bin',
];
process.env.PATH = (process.env.PATH || '') + ':' + extraPaths.join(':');

const PORT = 3210;

// ─── 视频真实链接解析（落地页 / SPA 自动定位） ────────────────────────
// 复用与 Vercel serverless 函数相同的共享实现（scripts/server_handlers.mjs）
import { handleTranscribe, handleResolveVideo } from './scripts/server_handlers.mjs';

import { processTranscript, extractKeywords, SAMPLE_TRANSCRIPT } from './lib/pipeline.mjs';

// ─── HTTP 服务器 ─────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: 处理逐字稿（?stream=1 时走 SSE 流式输出，否则返回完整 JSON）
  if (url.pathname === '/api/process' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const { text } = parsed;
      if (!text || text.trim().length < 10) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '文本太短，至少需要 10 个字符' }));
        return;
      }
      // SSE 流式分支：逐节推送，前端秒见骨架、LLM 归纳完成后无缝替换
      if (url.searchParams.get('stream') === '1') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (ev) => {
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
        };
        try {
          await processTranscript(text, { onEvent: send });
        } catch (e) {
          send('error', { message: e.message });
        } finally {
          res.end();
        }
        return;
      }
      // 非流式兜底（便于脚本/测试直接拿完整 JSON）
      try {
        const result = await processTranscript(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: 生成精简摘要 + 思维导图
  if (url.pathname === '/api/summarize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text, structured } = JSON.parse(body);
        if (!text && !structured) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 text 或 structured 参数' }));
          return;
        }

        // 如果有 structured 直接用，否则重新处理（structured 已含 LLM 归纳结果）
        const struct = structured || (await processTranscript(text)).structured;

        // ── 生成精简摘要 ──
        const allSummaries = struct.map(s => s.summary);
        const totalWords = struct.reduce((a, s) => a + s.wordCount, 0);
        const topKeyPoints = struct
          .flatMap(s => s.keyPoints)
          .slice(0, 8);

        // 全文主线关键词（基于全文本归纳，而非简单罗列章节标题）
        const globalText = struct.map(s => (s.content || []).join('\n')).join('\n');
        const globalKw = extractKeywords(globalText, 5);
        const overview = globalKw.length
          ? `共 ${struct.length} 个章节、${totalWords} 字，全文主线围绕「${globalKw.join('、')}」展开。`
          : `共 ${struct.length} 个章节、${totalWords} 字。`;

        const brief = {
          title: '全文摘要',
          overview,
          keyTakeaways: topKeyPoints,
          sectionSummaries: struct.map((s, i) => ({
            index: i + 1,
            title: s.title,
            summary: s.summary,
            pointCount: s.keyPoints.length
          }))
        };

        // ── 生成思维导图结构 ──
        const mindmap = {
          name: 'LiveWiki 知识图',
          children: struct.map((s, i) => ({
            name: `${i + 1}. ${s.title}`,
            summary: s.summary,
            children: s.keyPoints.slice(0, 4).map(kp => ({
              name: kp.length > 40 ? kp.substring(0, 40) + '...' : kp
            }))
          }))
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ brief, mindmap }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: 获取示例数据
  if (url.pathname === '/api/sample' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: SAMPLE_TRANSCRIPT }));
    return;
  }

  // API: 获取最近一次本地转写生成的逐字稿（用于把已转好的稿直接导入页面）
  // 路径可用环境变量 LW_TRANSCRIPT_PATH 覆盖，默认读取 transcribe.py 的输出目录
  if (url.pathname === '/api/last-transcript' && req.method === 'GET') {
    // 候选基目录：环境变量 > /tmp（transcribe.py 默认输出地）> 系统临时目录
    const baseDirs = [
      process.env.LW_TRANSCRIPT_DIR,
      '/tmp',
      os.tmpdir(),
    ].filter(Boolean);
    const names = ['transcript_with_speakers.txt', 'transcript.txt'];
    const candidates = [];
    for (const dir of baseDirs) {
      for (const n of names) candidates.push(path.join(dir, 'lw_out', n));
    }
    if (process.env.LW_TRANSCRIPT_PATH) candidates.unshift(process.env.LW_TRANSCRIPT_PATH);
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const text = fs.readFileSync(p, 'utf8');
          if (text.trim().length >= 10) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, text, path: p, chars: text.length }));
            return;
          }
        }
      } catch {}
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '未找到本地逐字稿文件（默认 /tmp/lw_out/transcript_with_speakers.txt），请先完成一次转写' }));
    return;
  }

  // API: 从视频 URL 下载 + ASR 转写 + 说话人识别（支持落地页自动定位真实链接）
  // 逻辑复用 scripts/server_handlers.mjs（与 Vercel serverless 函数一致）
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      handleTranscribe(res, parsed);
    });
    return;
  }

  // API: 仅解析落地页中的真实视频链接（不下载、不转写）
  if (url.pathname === '/api/resolve-video' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      handleResolveVideo(res, parsed);
    });
    return;
  }

  // API: 从上传文件转写（支持视频/音频）
  if (url.pathname === '/api/transcribe-file' && req.method === 'POST') {
    // 解析 multipart/form-data
    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少 multipart boundary' }));
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);
      
      // 简单解析 multipart
      let fileData = null;
      let fileName = 'upload';
      let skipDiarization = false;
      let whisperModel = 'small';

      const parts = [];
      let start = 0;
      while (true) {
        const idx = buffer.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) parts.push(buffer.slice(start, idx - 2)); // -2 for \r\n before boundary
        start = idx + boundaryBuf.length + 2; // +2 for \r\n after boundary
      }
      
      for (const part of parts) {
        const partStr = part.toString('utf8');
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = partStr.substring(0, headerEnd);
        const body = part.slice(headerEnd + 4, part.length - 2); // -2 for trailing \r\n
        
        if (headers.includes('name="file"')) {
          fileData = body;
          const fnameMatch = headers.match(/filename="([^"]+)"/);
          if (fnameMatch) fileName = fnameMatch[1];
        } else if (headers.includes('name="skipDiarization"')) {
          skipDiarization = body.toString('utf8') === 'true';
        } else if (headers.includes('name="whisperModel"')) {
          whisperModel = body.toString('utf8') || 'small';
        }
      }
      
      if (!fileData) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未找到上传文件' }));
        return;
      }
      
      // 保存到临时文件
      const tmpDir = path.join(os.tmpdir(), `livewiki_upload_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const ext = path.extname(fileName) || '.bin';
      const filePath = path.join(tmpDir, `input${ext}`);
      fs.writeFileSync(filePath, fileData);
      
      console.log(`[transcribe-file] 收到文件: ${fileName} (${(fileData.length/1024/1024).toFixed(1)} MB), 保存到 ${filePath}`);
      
      // 调用 Python 脚本（用 --file 模式）
      const scriptPath = path.join(process.cwd(), 'scripts', 'transcribe.py');
      const hfToken = process.env.HF_TOKEN || '';
      const args = [scriptPath, '--file', filePath, '--output', tmpDir, '--whisper-model', whisperModel];
      // 优先使用本地模型
      const localModelPath2 = path.join(process.cwd(), 'models', 'whisper-small');
      if (fs.existsSync(path.join(localModelPath2, 'model.bin'))) {
        args.push('--model-path', localModelPath2);
      }
      if (hfToken) args.push('--hf-token', hfToken);
      if (skipDiarization) args.push('--skip-diarization');
      
      console.log(`[transcribe-file] 启动 Python 脚本: python3 ${args.join(' ')}`);
      
      const child = execFile('python3', args, {
        timeout: 900000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        // 清理上传文件
        try { fs.unlinkSync(filePath); } catch {}
        
        if (err && err.killed) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '转写超时（超过 15 分钟）' }));
          return;
        }
        if (err) {
          console.error('[transcribe-file] Python 失败:', err.message);
          console.error('[transcribe-file] stderr:', stderr?.substring(0, 500));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: '转写失败: ' + (err.message || '未知错误'),
            hint: '请确保已安装 ffmpeg, faster-whisper',
            stderr: stderr?.substring(0, 1000)
          }));
          return;
        }
        
        try {
          const lastLine = stdout.trim().split('\n').pop();
          const result = JSON.parse(lastLine);
          if (result.ok) {
            console.log(`[transcribe-file] 成功: ${result.word_count} 字, ${result.segment_count} 片段`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.error || '转写失败' }));
          }
        } catch(parseErr) {
          console.error('[transcribe-file] JSON 解析失败:', stdout.substring(0, 500));
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: '转写结果解析失败',
            stdout: stdout.substring(0, 1000),
            stderr: stderr?.substring(0, 1000)
          }));
        }
      });
    });
    return;
  }

  // API: 检查转写环境依赖
  if (url.pathname === '/api/transcribe/status' && req.method === 'GET') {
    const checks = {};
    const env = { ...process.env };
    
    try { execSync('which python3', { stdio: 'pipe', env }); checks.python3 = true; } catch { checks.python3 = false; }
    try { execSync('python3 -m yt_dlp --version', { stdio: 'pipe', env, timeout: 5000 }); checks.yt_dlp = true; } catch { checks.yt_dlp = false; }
    try { execSync('which ffmpeg', { stdio: 'pipe', env }); checks.ffmpeg = true; } catch { checks.ffmpeg = false; }
    try { execSync('python3 -c "import faster_whisper"', { stdio: 'pipe', env, timeout: 5000 }); checks.faster_whisper = true; } catch { checks.faster_whisper = false; }
    try { execSync('python3 -c "import pyannote.audio"', { stdio: 'pipe', env, timeout: 5000 }); checks.pyannote = true; } catch { checks.pyannote = false; }
    checks.hf_token = !!process.env.HF_TOKEN;
    
    const allReady = checks.python3 && checks.yt_dlp && checks.ffmpeg && checks.faster_whisper;
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ready: allReady,
      checks,
      message: allReady ? '环境就绪' : '部分依赖缺失，转写功能可能不可用'
    }));
    return;
  }

  // 静态文件
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const fullPath = path.join(process.cwd(), 'public', filePath);

  if (filePath === '/index.html' || !path.extname(filePath)) {
    serveFile(res, path.join(process.cwd(), 'public', 'index.html'), 'text/html');
    return;
  }

  // 尝试提供静态文件
  if (fs.existsSync(fullPath)) {
    serveFile(res, fullPath);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function serveFile(res, filePath, forcedType) {
  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const contentType = forcedType || types[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  LiveWiki Demo — AI 知识沉淀引擎已启动  ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  地址: http://localhost:${PORT}             ║`);
  console.log(`║  状态: 运行中 ✓                          ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
