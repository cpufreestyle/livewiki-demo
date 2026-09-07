// 统一日志：分级 + 敏感信息脱敏
//
// 背景：转写会把 HF_TOKEN、用户粘贴的登录 Cookie、Referer 等拼进 Python 命令行，
// 一旦 console.log(args.join(' ')) 就会把这些凭据原样写进 server.log。
// 所有可能包含外部数据的输出都必须先过 redact()。

const DEBUG = process.env.LW_DEBUG === '1';

// 命中即整体替换为 ***[标签]***
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9._-]{8,}/g, '***[API_KEY]***'],
  [/nvapi-[A-Za-z0-9._-]{8,}/g, '***[NVAPI_KEY]***'],
  [/hf_[A-Za-z0-9]{8,}/g, '***[HF_TOKEN]***'],
  [/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***[TOKEN]***'],
  [/(?:Cookie\s*:\s*)[^\r\n"']+/gi, 'Cookie: ***[REDACTED]***'],
  [/(--(?:hf-token|api-key|token|password)\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1***[REDACTED]***'],
  [/\b([a-z_0-9]*(?:token|secret|password|api[_-]?key)[a-z_0-9]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1=***[REDACTED]***'],
  [/\b([?&](?:token|key|api_key|apikey|access_token|auth)=)[^&\s"']+/gi, '$1***[REDACTED]***'],
];

/** 对任意字符串做脱敏，用于日志与响应回显。 */
export function redact(input) {
  let s = typeof input === 'string' ? input : String(input ?? '');
  for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to);
  return s;
}

/** 把命令行参数数组拼成安全可打印的字符串。 */
export function safeCmd(cmd, args) {
  return [cmd, ...args].map((a) => redact(String(a))).join(' ');
}

function emit(level, tag, args) {
  const line = args
    .map((a) => (a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a))))
    .join(' ');
  const out = `[${tag}] ${redact(line)}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

/**
 * 创建一个带作用域标签的 logger。
 * debug 级别仅在 LW_DEBUG=1 时输出，用于替代原先静默的 `catch {}`。
 */
export function createLogger(tag) {
  return {
    debug: (...a) => { if (DEBUG) emit('log', tag, a); },
    info: (...a) => emit('log', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
    /**
     * 捕获并上报一个被忽略的异常（替代裸 catch {}）。
     * 不抛出，仅记录，保证原降级逻辑不变。
     */
    swallow: (scope, e) => {
      if (DEBUG) emit('warn', tag, [`${scope} 失败（已降级）:`, e?.message || e]);
    },
  };
}

export { DEBUG };
