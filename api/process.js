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

function structureContent(segments) {
  return segments.map(seg => {
    const content = seg.content.join('\n');
    const sentences = content.split(/[。！？\n]/).filter(s => s.trim().length > 5);
    const importantKeywords = ['核心','关键','重点','必须','需要','应该','建议','注意','原理','本质'];
    const keyPoints = sentences.filter(s => importantKeywords.some(kw => s.includes(kw)) || s.length > 50).slice(0, 5);
    const summary = sentences.slice(0, 3).join('。') + '。';
    return { title: seg.title, summary, keyPoints, content: seg.content, wordCount: content.length };
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

function processTranscript(rawText) {
  const startTime = Date.now();
  const originalLength = rawText.length;
  const cleaned = preprocess(rawText);
  const segments = segmentTopics(cleaned);
  const structured = structureContent(segments);
  const relations = detectRelations(structured);
  const output = generateOutput(structured, relations, originalLength);
  return {
    stats: {
      originalLength, cleanedLength: cleaned.length, segmentCount: segments.length,
      relationCount: relations.length, processingTime: Date.now() - startTime,
      compressionRatio: ((1 - cleaned.length / originalLength) * 100).toFixed(1) + '%'
    },
    structured, relations, output
  };
}

module.exports = (req, res) => {
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
    const result = processTranscript(text);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
