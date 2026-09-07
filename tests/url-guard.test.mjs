// SSRF 守卫单测
// 运行：npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertPublicUrl, isPublicUrl } from '../lib/url-guard.mjs';

test('放行公网 http/https 地址', () => {
  assert.doesNotThrow(() => assertPublicUrl('https://example.com/watch?v=1'));
  assert.doesNotThrow(() => assertPublicUrl('http://v.qq.com/x/cover.m3u8'));
  assert.equal(isPublicUrl('https://cdn.example.com/a.mp4'), true);
});

test('拦截回环与本机地址', () => {
  for (const u of [
    'http://localhost:3210/',
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://[::1]/',
    'http://0.0.0.0/',
  ]) {
    assert.throws(() => assertPublicUrl(u), /禁止访问内网/, `应拦截 ${u}`);
    assert.equal(isPublicUrl(u), false, `${u} 不应判定为公网`);
  }
});

test('拦截私有网段', () => {
  for (const u of [
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://100.64.0.1/',
  ]) {
    assert.throws(() => assertPublicUrl(u), /禁止访问内网/, `应拦截 ${u}`);
  }
});

test('拦截云元数据服务（SSRF 最典型目标）', () => {
  assert.throws(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /禁止访问内网/);
  assert.throws(() => assertPublicUrl('http://metadata.google.internal/'), /禁止访问内网/);
});

test('拦截十进制 / 映射形式的内网 IP 绕过', () => {
  // 2130706433 == 127.0.0.1
  assert.throws(() => assertPublicUrl('http://2130706433/'), /禁止访问内网/);
  // IPv4-mapped IPv6
  assert.throws(() => assertPublicUrl('http://[::ffff:127.0.0.1]/'), /禁止访问内网/);
});

test('拦截非 http/https 协议', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/a.mp4', 'javascript:alert(1)']) {
    assert.throws(() => assertPublicUrl(u), /不支持的协议|URL 格式非法/);
  }
});

test('拦截空值与非法 URL', () => {
  for (const u of ['', '   ', 'not a url', null, undefined]) {
    assert.throws(() => assertPublicUrl(u));
  }
});

test('172.32 / 11.x 等公网网段不应被误伤', () => {
  assert.doesNotThrow(() => assertPublicUrl('http://172.32.0.1/'));
  assert.doesNotThrow(() => assertPublicUrl('http://11.0.0.1/'));
});
