// 零依赖 multipart/form-data 解析（server.js 的 /api/transcribe-file 复用）
// 返回 { fields: { name: string }, file: { data: Buffer, filename: string } | null }
export async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) throw new Error('缺少 multipart boundary');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buffer = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from('--' + boundary.trim());
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buffer.subarray(start, idx - 2));
    start = idx + boundaryBuf.length + 2;
  }
  const fields = {};
  let file = null;
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.toString('utf8', 0, headerEnd);
    // part 已在切分时去掉了段尾 \r\n，故 body 直接取到末尾，勿再 -2（否则会截断末两字节）
    const body = part.subarray(headerEnd + 4);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : null;
    if (!name) continue;
    if (/filename="/.test(headers)) {
      const fnameMatch = headers.match(/filename="([^"]*)"/);
      file = { data: body, filename: fnameMatch ? fnameMatch[1] : 'upload' };
    } else {
      fields[name] = body.toString('utf8');
    }
  }
  return { fields, file };
}
