// URL 安全守卫：防 SSRF
//
// resolveVideoUrl 会用 Playwright、yt-dlp、http.get 三种方式去请求用户传入的 URL，
// 且响应体会经 candidates / diag.hints 回显。若不做校验，任何能访问服务端口的人
// 都可把本机当作内网探针（如 http://169.254.169.254/ 云元数据服务）。
//
// 用法：在所有接受外部 URL 的入口处先调 assertPublicUrl()。

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// 内网 / 本机 / 链路本地 / 云元数据 地址特征
const BLOCKED_HOST_RE = new Set([
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,                                  // 127.0.0.0/8
  /^10\./,                                   // 10.0.0.0/8
  /^192\.168\./,                             // 192.168.0.0/16
  /^169\.254\./,                             // 链路本地，含云元数据 169.254.169.254
  /^172\.(1[6-9]|2\d|3[01])\./,              // 172.16.0.0/12
  /^0\./,                                    // 0.0.0.0/8
  /^100\.(6[4-9]|[789]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^192\.0\.0\./, /^192\.0\.2\./, /^198\.(1[89]|51)\./, /^203\.0\.113\./,
  /^::1$/, /^::$/, /^fe[89ab][0-9a-f]:/i,    // IPv6 回环 / 链路本地
  /^f[cd][0-9a-f]{2}:/i,                     // IPv6 唯一本地 fc00::/7
  /^metadata\.google\.internal$/i,
  /^metadata$/i,
]);

// IPv4 兼容/映射形式的 IPv6（::ffff:127.0.0.1）需取出内嵌 IPv4 再判
// IPv4-mapped IPv6 有两种书写形式，都必须识别：
//   点分形式：  ::ffff:127.0.0.1
//   十六进制：  ::ffff:7f00:1   ← WHATWG URL 解析器会把前者规范化成这种
const V4_MAPPED_DOT_RE = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const V4_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

function unwrapMappedV4(host) {
  const dot = host.match(V4_MAPPED_DOT_RE);
  if (dot) return dot[1];
  const hex = host.match(V4_MAPPED_HEX_RE);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return host;
}

function isBlockedHost(host) {
  let h = String(host || '').trim().toLowerCase();
  // 去掉 IPv6 方括号与 zone id（fe80::1%eth0）
  h = h.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!h) return true;

  // 先取出内嵌的 IPv4，再走黑名单匹配——顺序反了会漏放这类绕过
  h = unwrapMappedV4(h);

  for (const re of BLOCKED_HOST_RE) if (re.test(h)) return true;

  // 纯数字点分形式的十进制 / 八进制 / 十六进制 IP（如 2130706433 == 127.0.0.1）
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n) && n > 0 && n <= 0xffffffff) {
      const a = (n >>> 24) & 0xff, b = (n >>> 16) & 0xff, c = (n >>> 8) & 0xff, d = n & 0xff;
      return isBlockedHost(`${a}.${b}.${c}.${d}`);
    }
  }
  return false;
}

/**
 * 校验 URL 是否为可安全请求的公网 http(s) 地址。
 * @param {string} raw 待校验的 URL
 * @returns {URL} 校验通过的 URL 对象
 * @throws {Error} 校验失败
 */
export function assertPublicUrl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('URL 不能为空');
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error('URL 格式非法');
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new Error(`不支持的协议：${u.protocol}（仅允许 http/https）`);
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error('禁止访问内网 / 本机 / 链路本地地址');
  }
  return u;
}

/** 非抛出版本：用于过滤候选列表。 */
export function isPublicUrl(raw) {
  try {
    assertPublicUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 重定向后再校验一次（防绕过：公网 URL 302 跳到内网地址）。
 * 调用方在每次跟随重定向后都应重新调用。
 */
export function assertRedirectTarget(location, baseUrl) {
  return assertPublicUrl(new URL(location, baseUrl).href);
}
