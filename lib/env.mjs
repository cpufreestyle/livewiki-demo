// 环境变量引导：加载 .env 并补齐 PATH
// 必须在其它模块之前 import（ESM 按 import 顺序求值），
// 保证 LW_WIKI_DIR / HF_TOKEN / LW_CORS_ORIGIN 等在后续模块读取时已就绪。

import fs from 'fs';
import path from 'path';

// 轻量加载 .env（无第三方依赖）
// .env 已在 .gitignore 中，不会提交，避免把个人路径写进仓库。
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch { /* .env 不存在或不可读，忽略 */ }

// 确保能找到 homebrew、python3、ffmpeg 等工具
const extraPaths = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.HOME + '/.local/bin',
];
process.env.PATH = (process.env.PATH || '') + ':' + extraPaths.join(':');
