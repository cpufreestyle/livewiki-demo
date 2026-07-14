// Vercel Serverless Function: /api/process
// LiveWiki AI 处理管线（ESM，复用 lib/pipeline.mjs 以与本地 server.js 保持一致）

import { processTranscript } from '../lib/pipeline.mjs';
import { sseHeaders, sseSend } from '../lib/sse.mjs';

// 兼容两种运行环境：
// - Vercel Node 运行时已把 JSON body 解析到 req.body
// - 原生 Node IncomingMessage 需自行读取流
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const str = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    try { return JSON.parse(str); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// 关掉 Vercel 默认 bodyParser，以便自行读取流 & 流式输出
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const query = new URL(req.url, 'http://localhost').searchParams;
  const stream = query.get('stream') === '1';

  const { text } = await readJsonBody(req);
  if (!text || text.trim().length < 10) {
    res.status(400).json({ error: '文本太短，至少需要 10 个字符' });
    return;
  }

  if (stream) {
    sseHeaders(res);
    try {
      await processTranscript(text, { onEvent: (ev) => sseSend(res, ev) });
    } catch (e) {
      sseSend(res, { type: 'error', payload: { message: e.message } });
    } finally {
      res.end();
    }
    return;
  }

  try {
    const result = await processTranscript(text);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
