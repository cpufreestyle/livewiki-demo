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

// ─── AI 处理管线（模拟） ────────────────────────────────────────────

/**
 * Stage 1: 预处理 — 去除语气词、重复内容、口语化表达
 */
function preprocess(rawText) {
  const fillerWords = [
    '那个', '嗯', '啊', '就是', '然后', '对吧', '怎么说呢', '其实吧',
    '就是说', '然后呢', '对对对', '是吧', '嘛', '哈', '哈哈', '呃',
    'like', 'you know', 'I mean', 'sort of'
  ];

  let cleaned = rawText;
  for (const word of fillerWords) {
    cleaned = cleaned.replace(new RegExp(word, 'g'), '');
  }

  // 合并连续空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  // 去除行首尾空白
  cleaned = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');

  // 去除重复段落
  const paragraphs = cleaned.split('\n');
  const seen = new Set();
  const deduped = paragraphs.filter(p => {
    const key = p.replace(/\s/g, '').slice(0, 50);
    if (seen.has(key) && p.length < 30) return false;
    seen.add(key);
    return true;
  });

  return deduped.join('\n');
}

/**
 * Stage 2: 语义切分 — 按主题/关键词分章分节
 */
function segmentTopics(cleanedText) {
  const paragraphs = cleanedText.split('\n').filter(p => p.trim().length > 10);

  // 主题关键词映射表
  const topicKeywords = {
    '产品定义与定位': ['产品', '定位', '用户', '需求', '场景', '市场'],
    '技术架构与实现': ['API', '模型', '架构', '技术', '实现', '代码', '系统', '部署'],
    'AI 工作流程': ['AI', '处理', '输入', '输出', '工作流', '管线', 'pipeline'],
    '商业化与增长': ['商业', '收费', '定价', '增长', '获客', '运营', '收入'],
    '项目管理与复盘': ['复盘', '总结', '计划', '迭代', '问题', '收获', '经验'],
    '核心概念': ['概念', '原理', '理论', '框架', '方法论', '思维'],
    '工具与实践': ['工具', '实践', '操作', '步骤', 'Cursor', 'Claude'],
    '用户体验设计': ['体验', '交互', '界面', '设计', 'UI', 'UX'],
  };

  const segments = [];
  let currentTopic = '开篇导入';
  let currentParagraphs = [];

  for (const para of paragraphs) {
    let bestTopic = null;
    let bestScore = 0;

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      let score = 0;
      for (const kw of keywords) {
        if (para.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }

    // 如果新主题得分足够高且与当前不同，切换主题
    if (bestTopic && bestTopic !== currentTopic && bestScore >= 2) {
      if (currentParagraphs.length > 0) {
        segments.push({ title: currentTopic, content: currentParagraphs });
      }
      currentTopic = bestTopic;
      currentParagraphs = [];
    }
    currentParagraphs.push(para);
  }

  // 最后一段
  if (currentParagraphs.length > 0) {
    segments.push({ title: currentTopic, content: currentParagraphs });
  }

  return segments;
}

/**
 * Stage 3: 内容结构化 — 提取关键点、生成摘要
 */
function structureContent(segments) {
  return segments.map(seg => {
    const content = seg.content.join('\n');
    const sentences = content.split(/[。！？\n]/).filter(s => s.trim().length > 5);

    // 提取关键句（包含重要关键词的句子）
    const importantKeywords = ['核心', '关键', '重点', '必须', '需要', '应该', '建议', '注意', '原理', '本质'];
    const keyPoints = sentences.filter(s =>
      importantKeywords.some(kw => s.includes(kw)) || s.length > 50
    ).slice(0, 5);

    // 生成摘要（取前 2-3 句话）
    const summary = sentences.slice(0, 3).join('。') + '。';

    return {
      title: seg.title,
      summary,
      keyPoints,
      content: seg.content,
      wordCount: content.length
    };
  });
}

/**
 * Stage 4: 知识关联 — 检测交叉引用
 */
function detectRelations(structured) {
  const relations = [];
  const allKeyPoints = structured.flatMap((s, i) =>
    s.keyPoints.map(kp => ({ section: i, text: kp }))
  );

  for (let i = 0; i < allKeyPoints.length; i++) {
    for (let j = i + 1; j < allKeyPoints.length; j++) {
      const a = allKeyPoints[i];
      const b = allKeyPoints[j];
      // 简单的词汇重叠检测
      const wordsA = a.text.split(/\s+|[，。、]/).filter(w => w.length > 2);
      const wordsB = b.text.split(/\s+|[，。、]/).filter(w => w.length > 2);
      const overlap = wordsA.filter(w => wordsB.includes(w));
      if (overlap.length >= 2 && a.section !== b.section) {
        relations.push({
          from: a.section,
          to: b.section,
          sharedTerms: overlap.slice(0, 5)
        });
      }
    }
  }

  return relations;
}

/**
 * Stage 5: 输出 — 生成结构化文档 + Markdown
 */
function generateOutput(structured, relations, originalLength) {
  // 生成目录
  const toc = structured.map((s, i) => `${'  '.repeat(0)}${i + 1}. ${s.title}`).join('\n');

  // 生成 Markdown
  let markdown = `# LiveWiki 结构化学习文档\n\n`;
  markdown += `> 由 LiveWiki AI 引擎自动生成 | 原文 ${originalLength} 字 → 结构化 ${structured.reduce((a, s) => a + s.wordCount, 0)} 字\n\n`;
  markdown += `## 📋 目录\n\n${toc}\n\n---\n\n`;

  for (const section of structured) {
    markdown += `## ${section.title}\n\n`;
    markdown += `**摘要**：${section.summary}\n\n`;
    if (section.keyPoints.length > 0) {
      markdown += `**关键点**：\n`;
      for (const kp of section.keyPoints) {
        markdown += `- ${kp}\n`;
      }
      markdown += `\n`;
    }
    markdown += `**正文**：\n\n${section.content.join('\n\n')}\n\n`;
  }

  if (relations.length > 0) {
    markdown += `---\n\n## 🔗 知识关联\n\n`;
    for (const rel of relations) {
      markdown += `- 「${structured[rel.from].title}」 ↔ 「${structured[rel.to].title}」(共同概念: ${rel.sharedTerms.join(', ')})\n`;
    }
    markdown += `\n`;
  }

  markdown += `---\n\n*💡 LiveWiki — 从"听过"到"学会"，从"碎片"到"体系"。*\n`;

  return { toc, markdown };
}

/**
 * 完整处理管线
 */
function processTranscript(rawText) {
  const startTime = Date.now();
  const originalLength = rawText.length;

  const cleaned = preprocess(rawText);
  const segments = segmentTopics(cleaned);
  const structured = structureContent(segments);
  const relations = detectRelations(structured);
  const output = generateOutput(structured, relations, originalLength);

  const elapsed = Date.now() - startTime;

  return {
    stats: {
      originalLength,
      cleanedLength: cleaned.length,
      segmentCount: segments.length,
      relationCount: relations.length,
      processingTime: elapsed,
      compressionRatio: ((1 - cleaned.length / originalLength) * 100).toFixed(1) + '%'
    },
    structured,
    relations,
    output
  };
}

// ─── 示例数据 ────────────────────────────────────────────────────────

const SAMPLE_TRANSCRIPT = `那个今天我们讲的是从 0 到 1 做一个 AI 产品嘛，嗯就是大家可能觉得就是 API 调用一下就行了，但其实不是的。

就是说你要想清楚你的模态是什么，你的上下文窗口够不够用，你的 TPS 能不能撑住。这些技术细节决定了产品能不能跑通。

那个模态这个概念很关键，模态就是 AI 能处理的输入输出类型。文本、图片、语音、视频，每种模态的产品形态完全不一样。你做翻译就是文本到文本，做 OCR 就是图片到文本，做语音助手就是语音到语音。

然后 API 是 AI 应用的第一块积木。核心概念是什么呢？就是说 API 本身不是产品，用 API 解决的问题才是产品。你不能说"我调了 GPT 的 API"就完了，用户不关心你用了什么 API，用户关心的是你帮他解决了什么问题。

结构化输出是 AI 产品化的关键。什么叫结构化输出？就是说 AI 返回的结果不是一坨纯文本，而是有结构的 JSON，能直接变成 UI 上的组件。比如你做一个课程笔记工具，AI 返回的不是一大段文字，而是 { title, summary, keyPoints[], references[] } 这样的结构，前端直接渲染成卡片。

上下文设计决定产品质量。上下文就是你给 AI 的输入信息，包括系统提示、用户消息、历史记录。上下文太短，AI 不理解背景；太长，又超 token 限制还很贵。核心原则是：给 AI 恰好够用的信息，不多不少。

Token 成本是 AI 产品的核心经营指标。每个 API 调用都花 token，token 就是钱。你定价的时候必须算清楚：单次处理花多少 token，成本多少毛利多少。如果 token 成本占收入的 50% 以上，这个商业模式就很危险。

然后商业模式这块，用户买的是结果不是技术。你跟用户说"我用了大模型"，用户不 care。你说"我把你的 3 万字逐字稿变成了结构化笔记，省了你 2 小时"，用户愿意付钱。定价方式要匹配用户价值感知，按次收费比按月收费更适合工具类产品。

增长飞轮很重要。产品自带传播机制是最好的增长方式。比如你生成的笔记自带 LiveWiki 水印，别人看到会问这是什么工具，这就是零成本获客。

那个复盘一下，做 AI 产品最大的收获就是：API 不是产品，问题才是。Vibe Coding 让你能快速验证想法，但产品思考才是核心壁垒。遇到的主要问题是 ASR 质量不稳定，不同工具输出的逐字稿质量差异很大。下一步计划是做多模态支持，把 PPT 和语音结合起来。`;

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

  // API: 处理逐字稿
  if (url.pathname === '/api/process' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || text.trim().length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文本太短，至少需要 10 个字符' }));
          return;
        }
        const result = processTranscript(text);
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
    req.on('end', () => {
      try {
        const { text, structured } = JSON.parse(body);
        if (!text && !structured) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 text 或 structured 参数' }));
          return;
        }

        // 如果有 structured 直接用，否则重新处理
        const struct = structured || processTranscript(text).structured;

        // ── 生成精简摘要 ──
        const allSummaries = struct.map(s => s.summary);
        const totalWords = struct.reduce((a, s) => a + s.wordCount, 0);
        const topKeyPoints = struct
          .flatMap(s => s.keyPoints)
          .slice(0, 8);

        const brief = {
          title: '全文摘要',
          overview: `${struct.length} 个主题，共 ${totalWords} 字。` +
            struct.map(s => s.title).join('、') + '。',
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
