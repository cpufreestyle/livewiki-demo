// LiveWiki 共享处理管线（ESM，零第三方依赖）
// 同时被本地服务 server.js 与 Vercel 函数 api/process.js 复用，
// 避免两份重复实现（约 300 行）并确保两端行为一致。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── 示例逐字稿 ───────────────────────────────────────────────
export const SAMPLE_TRANSCRIPT = `那个今天我们讲的是从 0 到 1 做一个 AI 产品嘛，嗯就是大家可能觉得就是 API 调用一下就行了，但其实不是的。

就是说你要想清楚你的模态是什么，你的上下文窗口够不够用，你的 TPS 能不能撑住。这些技术细节决定了产品能不能跑通。

那个模态这个概念很关键，模态就是 AI 能处理的输入输出类型。文本、图片、语音、视频，每种模态的产品形态完全不一样。你做翻译就是文本到文本，做 OCR 就是图片到文本，做语音助手就是语音到语音。

然后 API 是 AI 应用的第一块积木。核心概念是什么呢？就是说 API 本身不是产品，用 API 解决的问题才是产品。你不能说"我调了 GPT 的 API"就完了，用户不关心你用了什么 API，用户关心的是你帮他解决了什么问题。

结构化输出是 AI 产品化的关键。什么叫结构化输出？就是说 AI 返回的结果不是一坨纯文本，而是有结构的 JSON，能直接变成 UI 上的组件。比如你做一个课程笔记工具，AI 返回的不是一大段文字，而是 { title, summary, keyPoints[], references[] } 这样的结构，前端直接渲染成卡片。

上下文设计决定产品质量。上下文就是你给 AI 的输入信息，包括系统提示、用户消息、历史记录。上下文太短，AI 不理解背景；太长，又超 token 限制还很贵。核心原则是：给 AI 恰好够用的信息，不多不少。

Token 成本是 AI 产品的核心经营指标。每个 API 调用都花 token，token 就是钱。你定价的时候必须算清楚：单次处理花多少 token，成本多少毛利多少。如果 token 成本占收入的 50% 以上，这个商业模式就很危险。

然后商业模式这块，用户买的是结果不是技术。你跟用户说"我用了大模型"，用户不 care。你说"我把你的 3 万字逐字稿变成了结构化笔记，省了你 2 小时"，用户愿意付钱。定价方式要匹配用户价值感知，按次收费比按月收费更适合工具类产品。

增长飞轮很重要。产品自带传播机制是最好的增长方式。比如你生成的笔记自带 LiveWiki 水印，别人看到会问这是什么工具，这就是零成本获客。

那个复盘一下，做 AI 产品最大的收获就是：API 不是产品，问题才是。Vibe Coding 让你能快速验证想法，但产品思考才是核心壁垒。遇到的主要问题是 ASR 质量不稳定，不同工具输出的逐字稿质量差异很大。下一步计划是做多模态支持，把 PPT 和语音结合起来。`;

// ─── 从 CC Switch 自动读取供应商 key（零依赖，正则提取 ~/.codex）──
// CC Switch 切换供应商时会写入 Codex 的 live 配置；LiveWiki 直接复用，无需手填 .env。
// LW_CCSWITCH=0 可关闭；结果缓存避免每次请求读盘。
let _ccSwitchCache;
export function ccSwitchTokens() {
  if (_ccSwitchCache !== undefined) return _ccSwitchCache;
  const out = { stepfun: null, nvidia: null, openai: null };
  if (process.env.LW_CCSWITCH === '0') { _ccSwitchCache = out; return out; }
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const tomlPath = path.join(codexDir, 'config.toml');
    if (fs.existsSync(tomlPath)) {
      const toml = fs.readFileSync(tomlPath, 'utf8');
      const grab = (re) => { const m = toml.match(re); return m ? m[1] : null; };
      const anthropicBase = grab(/ANTHROPIC_BASE_URL\s*=\s*"([^"]+)"/);
      const anthropicToken = grab(/ANTHROPIC_AUTH_TOKEN\s*=\s*"([^"]+)"/);
      if (anthropicToken && anthropicBase && /stepfun/i.test(anthropicBase)) out.stepfun = anthropicToken;
      const bearer = grab(/experimental_bearer_token\s*=\s*"([^"]+)"/);
      if (bearer && /^nvapi-/.test(bearer)) out.nvidia = bearer;
    }
    const authPath = path.join(codexDir, 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (auth && typeof auth.OPENAI_API_KEY === 'string') out.openai = auth.OPENAI_API_KEY;
    }
  } catch (e) {
    console.warn('[CC Switch] 读取配置失败（忽略）:', e.message);
  }
  _ccSwitchCache = out;
  const found = Object.entries(out).filter(([, v]) => v).map(([k]) => k);
  if (found.length) console.log('[CC Switch] 已自动读取供应商:', found.join(', '));
  return out;
}

// ─── 真实 LLM 接入（OpenAI 兼容协议，零依赖，用内置 fetch）────
// 多供应商链：按顺序尝试，前一个失败自动切换下一个，全部失败回退规则引擎。
// key 优先级：显式环境变量 > CC Switch 自动读取。
//   StepFun 阶跃星辰:  LW_STEPFUN_API_KEY（或 CC Switch）  base https://api.stepfun.com/v1        默认 step-3.5-flash
//   NVIDIA  NIM:       LW_NVIDIA_API_KEY（或 CC Switch）   base https://integrate.api.nvidia.com/v1  默认 qwen/qwen3-next-80b-a3b-instruct
//   Custom（向后兼容）: LW_LLM_API_KEY / LW_LLM_BASE_URL / LW_LLM_MODEL
// 顺序由 LW_LLM_PROVIDER 控制（逗号分隔），默认 stepfun,nvidia,custom。
export function llmProviders() {
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

export function llmConfig() {
  return llmProviders()[0] || null;
}

async function callProvider(cfg, systemPrompt, userPrompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
      },
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

// 用 LLM 对整篇结构化结果做"生成式归纳"：重写每节的 summary / keyPoints / keywords。
// 单次批量调用（按章节顺序返回 JSON 数组），未配置或失败则原样回退规则引擎结果。
async function enhanceWithLLM(structured) {
  const cfg = llmConfig();
  if (!cfg || !structured || !structured.length) return structured;
  // 每节截取到 ~1200 字，控制 token 用量
  const sections = structured.map((s, i) => ({
    index: i,
    title: s.title,
    content: (s.content || []).join('\n').slice(0, 1200),
  }));
  const sys = '你是一个专业的课程/直播内容知识整理助手。请产出"生成式归纳"：用你自己的话重写，'
    + '不要照抄原文句子，忽略 ASR 口语词与识别错误（如把 Agent 误识别为 CACC / adent）。输出简洁、专业。';
  const user = '以下是按章节切分的直播逐字稿。请针对每个章节返回：\n'
    + '1) summary：一句话归纳（不超过 35 字，概括本节主题与核心结论）\n'
    + '2) keyPoints：3-5 条抽象要点，每条不超过 22 字，是归纳而非原文摘录\n'
    + '3) keywords：3-5 个主题关键词\n'
    + '严格只返回 JSON 数组，顺序与输入章节一一对应，格式：\n'
    + '[{"summary":"...","keyPoints":["...","..."],"keywords":["...","..."]}]\n\n'
    + '章节数据：\n'
    + sections.map(s => `【${s.index}】${s.title}\n${s.content}`).join('\n\n');
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

// ─── 规则引擎（LLM 未配置时的兜底）─────────────────────────
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

// 从文本提取关键词：中文 2-3 字 n-gram 词频统计 + 停用词 + 功能字过滤 + 英文术语
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
  const entries = [...freq.entries()]
    .filter(([w, c]) => c >= 2 || /[A-Za-z]/.test(w));
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

    return {
      title: seg.title,
      summary,
      keyPoints,
      keywords,
      content: seg.content,
      wordCount: content.length
    };
  });
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
    let bestTopic = null;
    let bestScore = 0;
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      let score = 0;
      for (const kw of keywords) { if (para.includes(kw)) score++; }
      if (score > bestScore) { bestScore = score; bestTopic = topic; }
    }
    if (bestTopic && bestTopic !== currentTopic && bestScore >= 2) {
      if (currentParagraphs.length > 0) segments.push({ title: currentTopic, content: currentParagraphs });
      currentTopic = bestTopic;
      currentParagraphs = [];
    }
    currentParagraphs.push(para);
  }
  if (currentParagraphs.length > 0) segments.push({ title: currentTopic, content: currentParagraphs });
  return segments;
}

function preprocess(rawText) {
  const fillerWords = [
    '那个','嗯','啊','就是','然后','对吧','怎么说呢','其实吧',
    '就是说','然后呢','对对对','是吧','嘛','哈','哈哈','呃',
    'like','you know','I mean','sort of'
  ];
  let cleaned = rawText;
  for (const word of fillerWords) {
    cleaned = cleaned.replace(new RegExp(word, 'g'), '');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
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

// 把一段文本切成用于"跨章节相似度"比较的 token 集合：
// 英文/数字词 + 中文 2-gram（解决中文无空格、整句做词匹配永远不重叠的问题）。
function tokenize(text) {
  const t = String(text || '');
  const grams = new Set();
  for (const m of t.matchAll(/[A-Za-z0-9][A-Za-z0-9+#.]{1,}/g)) grams.add(m[0].toLowerCase());
  const zh = t.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const chunk of zh) {
    for (let i = 0; i + 2 <= chunk.length; i++) grams.add(chunk.slice(i, i + 2));
  }
  return grams;
}

function detectRelations(structured) {
  const all = structured.flatMap((s, i) =>
    s.keyPoints.map(kp => ({ section: i, grams: tokenize(kp) }))
  );
  const raw = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.section === b.section) continue;
      const overlap = [...a.grams].filter(g => b.grams.has(g));
      if (overlap.length >= 2) {
        raw.push({ from: a.section, to: b.section, sharedTerms: overlap.slice(0, 5) });
      }
    }
  }
  // 同一对章节只保留一条关系
  const seen = new Set();
  return raw.filter(r => {
    const k = [r.from, r.to].sort().join('-');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function generateOutput(structured, relations, originalLength) {
  const toc = structured.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
  let markdown = `# LiveWiki 结构化学习文档\n\n`;
  markdown += `> 由 LiveWiki AI 引擎自动生成 | 原文 ${originalLength} 字 → 结构化 ${structured.reduce((a, s) => a + s.wordCount, 0)} 字\n\n`;
  markdown += `## 📋 目录\n\n${toc}\n\n---\n\n`;
  for (const section of structured) {
    markdown += `## ${section.title}\n\n`;
    markdown += `**摘要**：${section.summary}\n\n`;
    if (section.keyPoints.length > 0) {
      markdown += `**关键点**：\n`;
      for (const kp of section.keyPoints) markdown += `- ${kp}\n`;
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

export async function processTranscript(rawText) {
  const startTime = Date.now();
  const originalLength = rawText.length;
  const cleaned = preprocess(rawText);
  const segments = segmentTopics(cleaned);
  const structured = structureContent(segments);
  const enhanced = await enhanceWithLLM(structured);
  const relations = detectRelations(enhanced);
  const output = generateOutput(enhanced, relations, originalLength);
  const elapsed = Date.now() - startTime;
  return {
    stats: {
      originalLength,
      cleanedLength: cleaned.length,
      segmentCount: segments.length,
      relationCount: relations.length,
      processingTime: elapsed,
      llmEnabled: !!llmConfig(),
      compressionRatio: ((1 - cleaned.length / originalLength) * 100).toFixed(1) + '%'
    },
    structured: enhanced,
    relations,
    output
  };
}

export { extractKeywords };
