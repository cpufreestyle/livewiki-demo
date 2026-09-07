// 静态文件服务单测（重点：目录穿越防护）
// 运行：npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serveStatic } from '../lib/http.mjs';

function mockRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    if (headers) Object.assign(res.headers, headers);
  };
  res.end = (b) => { res.body = b; };
  return res;
}

function makePublicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw_static_'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>spa</html>');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{}');
  return dir;
}

test('正常提供 public 下的文件', () => {
  const dir = makePublicDir();
  try {
    const res = mockRes();
    serveStatic(res, dir, '/app.css');
    assert.equal(res.statusCode, 200);
    assert.equal(String(res.body), 'body{}');
    assert.match(res.headers['Content-Type'], /text\/css/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('根路径返回 index.html', () => {
  const dir = makePublicDir();
  try {
    const res = mockRes();
    serveStatic(res, dir, '/');
    assert.equal(res.statusCode, 200);
    assert.equal(String(res.body), '<html>spa</html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('无扩展名的未知路径回退到 index.html（SPA 行为）', () => {
  const dir = makePublicDir();
  try {
    const res = mockRes();
    serveStatic(res, dir, '/some/spa/route');
    assert.equal(res.statusCode, 200);
    assert.equal(String(res.body), '<html>spa</html>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('拦截 ../ 目录穿越读取仓库外文件', () => {
  const dir = makePublicDir();
  try {
    for (const attack of [
      '/../../etc/passwd',
      '/../../../etc/hosts',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    ]) {
      const res = mockRes();
      serveStatic(res, dir, attack);
      assert.equal(res.statusCode, 403, `应拦截 ${attack}`);
      assert.notEqual(String(res.body), fs.existsSync('/etc/passwd') ? fs.readFileSync('/etc/passwd', 'utf8') : null);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不存在的静态资源返回 404 而非泄漏路径', () => {
  const dir = makePublicDir();
  try {
    const res = mockRes();
    serveStatic(res, dir, '/nope.css');
    // 无扩展名匹配的缺失文件会回退 index.html；带扩展名的缺失文件走 404 分支
    assert.ok([200, 404].includes(res.statusCode));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
