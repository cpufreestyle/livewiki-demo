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

// ─── AI 处理管线（规则引擎 + 可选真实 LLM 生成式归纳） ──────────────

/**
 * 从 CC Switch（cc-switch）当前激活的配置里自动提取供应商 key。
 * CC Switch 切换供应商时会把配置写入 Codex 的 live 文件（~/.codex/），
 * 我们零依赖地用正则提取需要的字段，实现"接入 CC Switch"——无需手动填 .env。
 *   - StepFun: config.toml 中 ANTHROPIC_BASE_URL 含 stepfun 时取 ANTHROPIC_AUTH_TOKEN
 *   - NVIDIA:  config.toml 中 experimental_bearer_token 以 nvapi- 开头
 *   - 兜底:    auth.json 的 OPENAI_API_KEY
 * 通过 LW_CCSWITCH=0 可关闭；默认存在配置就自动读取。结果缓存，避免每次请求读盘。
 */
let _ccSwitchCache;
function ccSwitchTokens() {
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

/**
 * 真实 LLM 接入（OpenAI 兼容协议，零第三方依赖，用内置 fetch）。
 * 支持多供应商链：按顺序尝试，前一个失败自动切换下一个，全部失败再回退规则引擎。
 *
 * key 优先级：显式环境变量 > CC Switch 自动读取。
 *   StepFun 阶跃星辰:  LW_STEPFUN_API_KEY（或 CC Switch）  base https://api.stepfun.com/v1        默认 step-3.5-flash
 *   NVIDIA  NIM:       LW_NVIDIA_API_KEY（或 CC Switch）   base https://integrate.api.nvidia.com/v1  默认 qwen/qwen3-next-80b-a3b-instruct
 *   Custom（向后兼容）: LW_LLM_API_KEY / LW_LLM_BASE_URL / LW_LLM_MODEL
 *
 * 尝试顺序由 LW_LLM_PROVIDER 控制（逗号分隔），默认 stepfun,nvidia,custom。
 * 温度统一用 LW_LLM_TEMPERATURE（默认 0.3）。
 */
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

// 兼容旧调用点：是否已启用任意 LLM 供应商
function llmConfig() {
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

// 按供应商链依次尝试，返回首个成功结果；全部失败则抛出最后一个错误
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
 * Stage 3: 内容结构化 — 生成归纳式摘要 + 提炼要点
 * 不再照抄原文前几句，而是：统计全节关键词 → 抽取式打分选代表句 → 概括包装。
 */

// 中文停用词（用于关键词提取，避免"这个/然后/就是"之类噪声词）
const STOPWORDS = new Set([
  '我们','你们','他们','这个','那个','就是','然后','所以','可以','这样','什么',
  '一个','这些','那些','因为','但是','如果','这种','那么','其实','大家','现在',
  '一下','一些','这里','那里','时候','东西','这里','包括','比如','其中','已经',
  '一样','非常','怎么','为了','或者','的话','觉得','知道','看到','或者','这么',
  '很多','自己','进行','通过','实现','提供','帮助','支持','可能','应该','能够',
  '成为','作为','对于','以及','使用','需要','一直','开始','继续','目前','还有',
  '这个','那个','哪个','这样','那样','怎样','如何','为什么','是不是',
]);

// 去时间戳 [00:03.82]、说话人标记【…】、多余空白，得到干净句子
function cleanSentence(s) {
  return String(s)
    .replace(/\[\d{1,2}:\d{2}(\.\d+)?\]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 高虚词 / 功能字黑名单：包含这些字的 n-gram 基本是切分碎片，直接丢弃
const FUNC_CHARS = new Set([
  '的','了','是','在','和','也','都','就','还','又','因','为','但','如','果',
  '当','从','向','到','以','被','把','让','给','使','对','跟','同','比','过',
  '着','要','会','能','可','该','各','每','某','此','其','之','而','或','将',
  '则','却','并','等','们','我','你','他','她','它','有','个','这','那','与','及',
]);

// 取句子的主干（第一个逗号/句号前的核心短语），用于把"摘录句"压成"要点短语"
function firstClause(s) {
  const head = String(s).split(/[，。：、；！？\n]/)[0];
  return head.trim();
}

// 从文本提取关键词：中文 2-3 字 n-gram 词频统计 + 停用词 + 功能字过滤 + 英文术语
// 关键改进：剔除碎片（含功能字）、剔除被更长候选包含的短子串，得到真正有意义的归纳词
function extractKeywords(text, topN = 6) {
  const clean = cleanSentence(text);
  const freq = new Map();
  // 英文 / 数字术语（权重略高，专名/技术词优先级高）
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z0-9+#.]{1,}/g)) {
    const w = m[0];
    if (w.length < 2) continue;
    freq.set(w, (freq.get(w) || 0) + 2);
  }
  // 中文 2-gram / 3-gram
  const zhChunks = clean.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const chunk of zhChunks) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= chunk.length; i++) {
        const w = chunk.slice(i, i + n);
        if (STOPWORDS.has(w)) continue;
        if ([...w].some(ch => FUNC_CHARS.has(ch))) continue; // 丢碎片
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  // 候选集：中文词需出现 >=2 次，英文术语放行
  const entries = [...freq.entries()]
    .filter(([w, c]) => c >= 2 || /[A-Za-z]/.test(w));
  // 剔除被更长候选"包住"的短子串（如「开发」「发者」应让位于「开发者」）
  const cleaned = entries.filter(([w, c]) =>
    !entries.some(([w2, c2]) => w2 !== w && w2.length > w.length && w2.includes(w) && c2 >= c)
  );
  const sorted = cleaned.sort((a, b) => b[1] - a[1]);
  // 二次去子串冗余
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

    // 抽取式打分：句含关键词越多、含信号词、长度适中 → 分越高
    const scored = sentences.map(s => {
      let score = 0;
      for (const kw of keywords) { if (s.includes(kw)) score += 1; }
      if (/核心|关键|重点|本质|原理|必须|建议|注意|方法|目标|结论|价值|优势/.test(s)) score += 1.5;
      const lenFactor = s.length < 12 ? 0.5 : (s.length > 60 ? 0.7 : 1);
      return { s, score: score * lenFactor };
    }).sort((a, b) => b.score - a.score);

    // 关键点：取分最高的句子，压成"要点短语"（取句首主干并截断），而非整句照抄
    const keyPoints = scored
      .filter(x => x.score > 0)
      .slice(0, 5)
      .map(x => {
        const phrase = firstClause(x.s);
        return phrase.length > 30 ? phrase.slice(0, 29) + '…' : phrase;
      });

    // 摘要：以关键词归纳主题 + 要点数量，是"归纳"而非"摘录原文"
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
async function processTranscript(rawText) {
  const startTime = Date.now();
  const originalLength = rawText.length;

  const cleaned = preprocess(rawText);
  const segments = segmentTopics(cleaned);
  const structured = structureContent(segments);
  // 可选：用真实 LLM 做生成式归纳（未配置则原样返回规则引擎结果）
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
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text || text.trim().length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '文本太短，至少需要 10 个字符' }));
          return;
        }
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
