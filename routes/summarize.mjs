// POST /api/summarize — 生成精简摘要 + 思维导图

import { processTranscript, extractKeywords } from '../lib/pipeline.mjs';
import { sendJson, readJsonBody } from '../lib/http.mjs';

export async function handleSummarize(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  const { text, structured } = payload;
  if (!text && !structured) {
    return sendJson(res, 400, { error: '缺少 text 或 structured 参数' });
  }

  try {
    // 如果有 structured 直接用，否则重新处理（structured 已含 LLM 归纳结果）
    const struct = structured || (await processTranscript(text)).structured;

    // ── 生成精简摘要 ──
    const totalWords = struct.reduce((a, s) => a + s.wordCount, 0);
    const topKeyPoints = struct.flatMap(s => s.keyPoints).slice(0, 8);

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

    sendJson(res, 200, { brief, mindmap });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}
