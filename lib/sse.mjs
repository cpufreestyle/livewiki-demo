// 共享 SSE 辅助（server.js 与 api/process.js 复用，消除重复）
export function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function sseSend(res, ev) {
  try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
}
