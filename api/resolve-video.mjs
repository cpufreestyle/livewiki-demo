// Vercel Serverless Function: /api/resolve-video
// 复用与本地 server.js 完全相同的链接解析逻辑（scripts/server_handlers.mjs）
import { handleResolveVideo } from '../scripts/server_handlers.mjs';

export const config = { maxDuration: 120 };

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      const b = req.body;
      if (typeof b === 'string') { try { return resolve(JSON.parse(b)); } catch { return resolve({}); } }
      if (Buffer.isBuffer(b)) { try { return resolve(JSON.parse(b.toString('utf8'))); } catch { return resolve({}); } }
      return resolve(b); // 已是对象
    }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

export default async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }
  const body = await readBody(req);
  await handleResolveVideo(res, body);
}
