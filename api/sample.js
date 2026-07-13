// Vercel Serverless Function: /api/sample

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

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  res.status(200).json({ text: SAMPLE_TRANSCRIPT });
};
