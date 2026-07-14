// Vercel Serverless Function: /api/process
// LiveWiki AI 处理管线

// ─── AI 处理管线 ────────────────────────────────────────────

function preprocess(rawText) {
  const fillerWords = ['那个','嗯','啊','就是','然后','对吧','怎么说呢','其实吧','就是说','然后呢','对对对','是吧','嘛','哈','哈哈','呃','like','you know','I mean','sort of'];
  let cleaned = rawText;
  for (const word of fillerWords) { cleaned = cleaned.replace(new RegExp(word, 'g'), ''); }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
  const paragraphs = cleaned.split('\n');
  const seen = new Set();
  return paragraphs.filter(p => {
    const key = p.replace(/\s/g, '').slice(0, 50);
    if (seen.has(key) && p.length < 30) return false;
    seen.add(key); return true;
  }).join('\n');
}

function segmentTopics(cleanedText) {
  const paragraphs = cleanedText.split('\n').filter(p => p.trim().length > 10);
  const topicKeywords = {
    '产品定义与定位': ['产品','定位','用户','需求','场景','市场'],
    '技术架构与实现': ['API','模型','架构','技术','实现','代码','系统','部署'],
    'AI 工作流程': ['AI','处理','输入','输出','工作流','管线','pipeline'],
    '商业化与增长': ['商业','收费','定价','增长','获客','运营','收入'],
    '项目管理与复盘': ['复盘','总结','计划','迭代','问题','收获','经验'],
    '核心概念': ['概念','原理','理论','框架','方法论','思维'],
    '工具与实践': ['工具','实践','操作','步骤','Cursor','Claude'],
    '用户体验设计': ['体验','交互','界面','设计','UI','UX'],
  };
  const segments = [];
  let currentTopic = '开篇导入';
  let currentParagraphs = [];
  for (const para of paragraphs) {
    let bestTopic = null, bestScore = 0;
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      let score = 0;
      for (const kw of keywords) { if (para.includes(kw)) score++; }
      if (score > bestScore) { bestScore = score; bestTopic = topic; }
    }
    if (bestTopic && bestTopic !== currentTopic && bestScore >= 2) {
      if (currentParagraphs.length > 0) segments.push({ title: currentTopic, content: currentParagraphs });
      currentTopic = bestTopic; currentParagraphs = [];
    }
    currentParagraphs.push(para);
  }
  if (currentParagraphs.length > 0) segments.push({ title: currentTopic, content: currentParagraphs });
  return segments;
}

// ─── 从 CC Switch 自动读取供应商 key（零依赖，正则提取 ~/.codex）────────
// CC Switch 切换供应商时会写入 Codex 的 live 配置；LiveWiki 直接复用，无需手填 .env。
// LW_CCSWITCH=0 可关闭；结果缓存避免每次请求读盘。
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
let _ccSwitchCache;
function ccSwitchTokens() {
  if (_ccSwitchCache !== undefined) return _ccSwitchCache;
  const out = { stepfun: null, nvidia: null, openai: null };
  if (process.env.LW_CCSWITCH === '0') { _ccSwitchCache = out; return out; }
  try {
    const codexDir = _path.join(_os.homedir(), '.codex');
    const tomlPath = _path.join(codexDir, 'config.toml');
    if (_fs.existsSync(tomlPath)) {
      const toml = _fs.readFileSync(tomlPath, 'utf8');
      const grab = (re) => { const m = toml.match(re); return m ? m[1] : null; };
      const anthropicBase = grab(/ANTHROPIC_BASE_URL\s*=\s*"([^"]+)"/);
      const anthropicToken = grab(/ANTHROPIC_AUTH_TOKEN\s*=\s*"([^"]+)"/);
      if (anthropicToken && anthropicBase && /stepfun/i.test(anthropicBase)) out.stepfun = anthropicToken;
      const bearer = grab(/experimental_bearer_token\s*=\s*"([^"]+)"/);
      if (bearer && /^nvapi-/.test(bearer)) out.nvidia = bearer;
    }
    const authPath = _path.join(codexDir, 'auth.json');
    if (_fs.existsSync(authPath)) {
      const auth = JSON.parse(_fs.readFileSync(authPath, 'utf8'));
      if (auth && typeof auth.OPENAI_API_KEY === 'string') out.openai = auth.OPENAI_API_KEY;
    }
  } catch (e) {
    console.warn('[CC Switch] 读取配置失败（忽略）:', e.message);
  }
  _ccSwitchCache = out;
  return out;
}

// ─── 真实 LLM 接入（OpenAI 兼容协议，零依赖，用内置 fetch）──────────
// 多供应商链：按顺序尝试，前一个失败自动切换下一个，全部失败回退规则引擎。
// key 优先级：显式环境变量 > CC Switch 自动读取。
//   StepFun 阶跃星辰:  LW_STEPFUN_API_KEY（或 CC Switch）  base https://api.stepfun.com/v1
//   NVIDIA  NIM:       LW_NVIDIA_API_KEY（或 CC Switch）   base https://integrate.api.nvidia.com/v1
//   Custom（向后兼容）: LW_LLM_API_KEY / LW_LLM_BASE_URL / LW_LLM_MODEL
// 顺序由 LW_LLM_PROVIDER 控制（逗号分隔，默认 stepfun,nvidia,custom）。
function llmProviders() {
  const temp = Number(process.env.LW_LLM_TEMPERATURE || '0.3') || 0.3;
  const cc = ccSwitchTokens();
  const stepfunKey = process.env.LW_STEPFUN_API_KEY || cc.stepfun;
  const nvidiaKey = process.env.LW_NVIDIA_API_KEY || cc.nvidia;
  const defs = {
    stepfun: () => stepfunKey && {
      name: 'stepfun',
      baseURL: (process.env.LW_STEPFUN_BASE_URL || 'https://api.stepfun.com/v1').replace(/\/$/, ''),
      apiKey: stepfunKey,
      model: process.env.LW_STEPFUN_MODEL || 'step-3.5-flash',
      temperature: temp,
    },
    nvidia: () => nvidiaKey && {
      name: 'nvidia',
      baseURL: (process.env.LW_NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
      apiKey: nvidiaKey,
      model: process.env.LW_NVIDIA_MODEL || 'qwen/qwen3-next-80b-a3b-instruct',
      temperature: temp,
    },
    custom: () => process.env.LW_LLM_API_KEY && {
      name: 'custom',
      baseURL: (process.env.LW_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: process.env.LW_LLM_API_KEY,
      model: process.env.LW_LLM_MODEL || 'gpt-4o-mini',
      temperature: temp,
    },
  };
  const order = (process.env.LW_LLM_PROVIDER || 'stepfun,nvidia,custom')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return order.map(k => defs[k] && defs[k]()).filter(Boolean);
}

function llmConfig() {
  return llmProviders()[0] || null;
}

async function callProvider(cfg, systemPrompt, userPrompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + txt.slice(0, 200));
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callLLM(systemPrompt, userPrompt, { timeoutMs = 120000 } = {}) {
  const providers = llmProviders();
  if (!providers.length) throw new Error('LLM 未配置');
  let lastErr;
  for (const cfg of providers) {
    try {
      const out = await callProvider(cfg, systemPrompt, userPrompt, timeoutMs);
      if (out) {
        if (providers[0] !== cfg) console.log(`[LLM] 已切换到备用供应商 ${cfg.name}(${cfg.model})`);
        return out;
      }
      lastErr = new Error(cfg.name + ' 返回空内容');
    } catch (e) {
      lastErr = e;
      console.warn(`[LLM] 供应商 ${cfg.name}(${cfg.model}) 调用失败: ${e.message}，尝试下一个…`);
    }
  }
  throw lastErr || new Error('所有 LLM 供应商均失败');
}

// 从 LLM 的自由文本回复中稳健地截取出 JSON 数组字符串。
// 关键修复：用「第一个 [」到「最后一个 ]」截取，而不是用正则贪心匹配最近一个 ]，
// 否则多节数组会在第一节 keyPoints 的 ] 处被截断，导致解析失败。
// 同时去掉可能的 ```json 围栏、首尾多余文本，以及 { / ] 前的尾随逗号。
function extractJSONArray(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  let json = s.slice(start, end + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1'); // 去掉尾随逗号
  return json;
}

async function enhanceWithLLM(structured) {
  const cfg = llmConfig();
  if (!cfg || !structured || !structured.length) return structured;
  const sections = structured.map((s, i) => ({
    index: i, title: s.title,
    content: (s.content || []).join('\n').slice(0, 1200),
  }));
  const sys = '你是一个专业的课程/直播内容知识整理助手。请产出"生成式归纳"：用你自己的话重写，'
    + '不要照抄原文句子，忽略 ASR 口语词与识别错误。输出简洁、专业。';
  const user = '以下是按章节切分的直播逐字稿。请针对每个章节返回：\n'
    + '1) summary：一句话归纳（不超过 35 字，概括本节主题与核心结论）\n'
    + '2) keyPoints：3-5 条抽象要点，每条不超过 22 字，是归纳而非原文摘录\n'
    + '3) keywords：3-5 个主题关键词\n'
    + '严格只返回 JSON 数组，顺序与输入章节一一对应，格式：\n'
    + '[{"summary":"...","keyPoints":["...","..."],"keywords":["...","..."]}]\n\n'
    + '章节数据：\n' + sections.map(s => `【${s.index}】${s.title}\n${s.content}`).join('\n\n');
  try {
    const raw = await callLLM(sys, user, { timeoutMs: 120000 });
    const jsonStr = extractJSONArray(raw);
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) throw new Error('LLM 返回非数组');
    return structured.map((s, i) => {
      const e = arr[i];
      if (!e) return s;
      const kp = Array.isArray(e.keyPoints) ? e.keyPoints.map(String).filter(Boolean).slice(0, 5) : [];
      const kw = Array.isArray(e.keywords) ? e.keywords.map(String).filter(Boolean).slice(0, 6) : [];
      return {
        ...s,
        summary: typeof e.summary === 'string' && e.summary.trim() ? e.summary.trim() : s.summary,
        keyPoints: kp.length ? kp : s.keyPoints,
        keywords: kw.length ? kw : s.keywords,
      };
    });
  } catch (e) {
    console.warn('[LLM] 生成式归纳失败，回退规则引擎:', e.message);
    return structured;
  }
}

const STOPWORDS = new Set([
  '我们','你们','他们','这个','那个','就是','然后','所以','可以','这样','什么',
  '一个','这些','那些','因为','但是','如果','这种','那么','其实','大家','现在',
  '一下','一些','这里','那里','时候','东西','这里','包括','比如','其中','已经',
  '一样','非常','怎么','为了','或者','的话','觉得','知道','看到','或者','这么',
  '很多','自己','进行','通过','实现','提供','帮助','支持','可能','应该','能够',
  '成为','作为','对于','以及','使用','需要','一直','开始','继续','目前','还有',
  '这个','那个','哪个','这样','那样','怎样','如何','为什么','是不是',
]);
const FUNC_CHARS = new Set([
  '的','了','是','在','和','也','都','就','还','又','因','为','但','如','果',
  '当','从','向','到','以','被','把','让','给','使','对','跟','同','比','过',
  '着','要','会','能','可','该','各','每','某','此','其','之','而','或','将',
  '则','却','并','等','们','我','你','他','她','它','有','个','这','那','与','及',
]);

function cleanSentence(s) {
  return String(s)
    .replace(/\[\d{1,2}:\d{2}(\.\d+)?\]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstClause(s) {
  const head = String(s).split(/[，。：、；！？\n]/)[0];
  return head.trim();
}

function extractKeywords(text, topN = 6) {
  const clean = cleanSentence(text);
  const freq = new Map();
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z0-9+#.]{1,}/g)) {
    const w = m[0];
    if (w.length < 2) continue;
    freq.set(w, (freq.get(w) || 0) + 2);
  }
  const zhChunks = clean.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const chunk of zhChunks) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= chunk.length; i++) {
        const w = chunk.slice(i, i + n);
        if (STOPWORDS.has(w)) continue;
        if ([...w].some(ch => FUNC_CHARS.has(ch))) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  const entries = [...freq.entries()].filter(([w, c]) => c >= 2 || /[A-Za-z]/.test(w));
  const cleaned = entries.filter(([w, c]) =>
    !entries.some(([w2, c2]) => w2 !== w && w2.length > w.length && w2.includes(w) && c2 >= c)
  );
  const sorted = cleaned.sort((a, b) => b[1] - a[1]);
  const picked = [];
  for (const [w] of sorted) {
    if (picked.some(p => p.includes(w) || w.includes(p))) continue;
    picked.push(w);
    if (picked.length >= topN) break;
  }
  return picked;
}

function structureContent(segments) {
  return segments.map(seg => {
    const content = seg.content.join('\n');
    const sentences = content
      .split(/[。！？\n]/)
      .map(cleanSentence)
      .filter(s => s.length > 6);
    const keywords = extractKeywords(content, 6);
    const scored = sentences.map(s => {
      let score = 0;
      for (const kw of keywords) { if (s.includes(kw)) score += 1; }
      if (/核心|关键|重点|本质|原理|必须|建议|注意|方法|目标|结论|价值|优势/.test(s)) score += 1.5;
      const lenFactor = s.length < 12 ? 0.5 : (s.length > 60 ? 0.7 : 1);
      return { s, score: score * lenFactor };
    }).sort((a, b) => b.score - a.score);
    const keyPoints = scored
      .filter(x => x.score > 0)
      .slice(0, 5)
      .map(x => {
        const phrase = firstClause(x.s);
        return phrase.length > 30 ? phrase.slice(0, 29) + '…' : phrase;
      });
    let summary;
    if (keywords.length) {
      const kwStr = keywords.slice(0, 4).join('、');
      summary = `本节聚焦「${kwStr}」，提炼 ${keyPoints.length} 个要点`;
    } else {
      const head = (sentences[0] ? firstClause(sentences[0]) : '') || '（本节内容较少）';
      summary = `本节要点：${head.length > 30 ? head.slice(0, 29) + '…' : head}`;
    }
    return { title: seg.title, summary, keyPoints, keywords, content: seg.content, wordCount: content.length };
  });
}

function detectRelations(structured) {
  const relations = [];
  const allKeyPoints = structured.flatMap((s, i) => s.keyPoints.map(kp => ({ section: i, text: kp })));
  for (let i = 0; i < allKeyPoints.length; i++) {
    for (let j = i + 1; j < allKeyPoints.length; j++) {
      const a = allKeyPoints[i], b = allKeyPoints[j];
      const wordsA = a.text.split(/\s+|[，。、]/).filter(w => w.length > 2);
      const wordsB = b.text.split(/\s+|[，。、]/).filter(w => w.length > 2);
      const overlap = wordsA.filter(w => wordsB.includes(w));
      if (overlap.length >= 2 && a.section !== b.section) {
        relations.push({ from: a.section, to: b.section, sharedTerms: overlap.slice(0, 5) });
      }
    }
  }
  return relations;
}

function generateOutput(structured, relations, originalLength) {
  const toc = structured.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  let markdown = `# LiveWiki 结构化学习文档\n\n> 由 LiveWiki AI 引擎自动生成 | 原文 ${originalLength} 字 → 结构化 ${structured.reduce((a, s) => a + s.wordCount, 0)} 字\n\n## 📋 目录\n\n${toc}\n\n---\n\n`;
  for (const section of structured) {
    markdown += `## ${section.title}\n\n**摘要**：${section.summary}\n\n`;
    if (section.keyPoints.length > 0) {
      markdown += `**关键点**：\n`;
      for (const kp of section.keyPoints) markdown += `- ${kp}\n`;
      markdown += `\n`;
    }
    markdown += `**正文**：\n\n${section.content.join('\n\n')}\n\n`;
  }
  if (relations.length > 0) {
    markdown += `---\n\n## 🔗 知识关联\n\n`;
    for (const rel of relations) markdown += `- 「${structured[rel.from].title}」 ↔ 「${structured[rel.to].title}」(共同概念: ${rel.sharedTerms.join(', ')})\n`;
    markdown += `\n`;
  }
  markdown += `---\n\n*💡 LiveWiki — 从"听过"到"学会"，从"碎片"到"体系"。*\n`;
  return { toc, markdown };
}

async function processTranscript(rawText) {
  const startTime = Date.now();
  const originalLength = rawText.length;
  const cleaned = preprocess(rawText);
  const segments = segmentTopics(cleaned);
  const structured = structureContent(segments);
  const enhanced = await enhanceWithLLM(structured);
  const relations = detectRelations(enhanced);
  const output = generateOutput(enhanced, relations, originalLength);
  return {
    stats: {
      originalLength, cleanedLength: cleaned.length, segmentCount: segments.length,
      relationCount: relations.length, processingTime: Date.now() - startTime,
      llmEnabled: !!llmConfig(),
      compressionRatio: ((1 - cleaned.length / originalLength) * 100).toFixed(1) + '%'
    },
    structured: enhanced, relations, output
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { text } = req.body || {};
  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: '文本太短，至少需要 10 个字符' });
    return;
  }
  try {
    const result = await processTranscript(text);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
