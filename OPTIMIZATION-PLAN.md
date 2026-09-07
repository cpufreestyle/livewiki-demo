# LiveWiki Demo — 代码 / 架构优化方案

> 基于 `main` 分支全量代码审查产出。按 **P0 安全 → P1 架构 → P2 性能 → P3 工程化** 排序，每项标注问题位置、现状、改法与收益。

## ✅ 实施状态（v2.2 已全部落地）

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 凭据脱敏、SSRF 守卫、回显收敛、上传白名单、静态穿越防护、CORS 收紧 | ✅ 已完成 |
| P1 | `transcribe_runner` 抽取、路由表拆分、常量统一、解析器拆分、日志规范化 | ✅ 已完成 |
| P2 | 解析链路预算与 iframe 上限、响应体扫描预算、临时目录清理、规则引擎复杂度、缓存 LRU+TTL+debounce | ✅ 已完成 |
| P3 | 前端拆分为 `index.html`/`app.css`/`app.js`、`node:test` 单测、启动脚本退避、并发去重修复、`package.json` 完善 | ✅ 已完成 |

**新增文件**：`lib/constants.mjs`、`lib/url-guard.mjs`、`lib/log.mjs`、`lib/http.mjs`、`lib/env.mjs`、`routes/*`（8 个）、`scripts/transcribe_runner.mjs`、`scripts/autofill_login.js`、`tests/*`（3 个）、`public/app.css`、`public/app.js`、`.env.example`。

**验证**：`npm test` 22 项全通过；13 个后端模块导入无错；`app.js` 与 `transcribe.py` 语法校验通过。

**审查中发现并修复的两个真实缺陷**（非计划内）：
1. 全局正则 `/g` 配合 `exec` 循环，中途抛错会污染 `lastIndex`，影响后续所有响应的匹配起点 → 改用 `matchAll`。
2. URL 解析器把 `[::ffff:127.0.0.1]` 规范化为十六进制 `[::ffff:7f00:1]`，守卫只覆盖点分形式 → 补充十六进制解析。

---

以下为审查原文，保留作为变更依据。

## 一、现状体检

| 文件 | 行数 | 职责 | 健康度 |
| --- | --- | --- | --- |
| `public/index.html` | 1940 | HTML + CSS + JS 全内联单文件 | ⚠️ 单体过重 |
| `lib/pipeline.mjs` | 655 | 清洗/分段/规则引擎/LLM 归纳/关联/缓存 | ✅ 尚可，但职责偏多 |
| `scripts/resolve_video_url.js` | 514 | 多策略视频链接解析 + UI 自动化 | ❌ 职责混杂 |
| `server.js` | 398 | 路由 + 静态服务 + 转写 + 依赖检测 | ⚠️ 上帝文件 |
| `scripts/transcribe.py` | 264 | 下载/ASR/分离 | ⚠️ 资源泄漏 |
| `scripts/server_handlers.mjs` | 204 | 本地与 Vercel 共享转写逻辑 | ⚠️ 与 `server.js` 重复 |
| `lib/sse.mjs` / `lib/multipart.mjs` | 14 / 38 | 工具 | ✅ |
| `api/*.js` | 各 30–65 | Vercel 适配层，薄封装 | ✅ 良好 |

架构优点（应保持）：`lib/` 与 `scripts/server_handlers.mjs` 的**共享抽取**思路正确，本地与 Vercel 双端复用同一实现；`api/*.mjs` 保持薄适配层；零第三方运行时依赖。

---

## 二、P0 — 安全（建议立即修复）

### P0-1 凭据明文打印进日志 🔴

`scripts/server_handlers.mjs:150,155` 与 `server.js:263,272`：

```javascript
if (hfToken) args.push('--hf-token', hfToken);
console.log(`[transcribe] 启动 Python 脚本: python3 ${args.join(' ')}`);
```

`args` 含 HuggingFace Token，直接落盘到 `server.log`（仓库根目录已存在该文件）。

**改法**：敏感参数改走环境变量，命令行只保留非敏感参数；日志打印前脱敏。

```javascript
const child = execFile('python3', args, {
  env: { ...process.env, HF_TOKEN: hfToken },   // 不再作为 argv 传递
  // ...
});
console.log('[transcribe] args:', args.map(a => /^sk-|^nvapi-|^hf_/.test(a) ? '***' : a).join(' '));
```

### P0-2 SSRF：任意 URL 未做协议与内网地址校验 🔴

`scripts/resolve_video_url.js:62` 与 `428` 仅做 `new URLParse(url)` 格式校验，无协议白名单、无内网/元数据地址拦截。Playwright（L299）、`http.get`（L366）、`yt-dlp`（L128）三者均会被引导至 `http://169.254.169.254/` 等地址，且响应体经 `hints` / `candidates` 字段回显给调用方（L497,507）。

叠加 `server.js:62` 的 `Access-Control-Allow-Origin: *` 且**全接口无鉴权**，任何能访问 3210 端口的网页都可把本机当作代理。

**改法**：新增 `lib/url-guard.mjs`，在入口统一校验。

```javascript
const ALLOWED = new Set(['http:', 'https:']);
export function assertPublicUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error('URL 格式非法'); }
  if (!ALLOWED.has(u.protocol)) throw new Error('仅支持 http/https');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const blocked = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc00::|fe80:)/i;
  if (blocked.test(h) || h === 'localhost' || h === 'metadata.google.internal') {
    throw new Error('禁止访问内网/本机地址');
  }
  return u;
}
```

同时在 `server.js` 把 CORS 从 `*` 收敛为同源或可配置白名单。

### P0-3 子进程 stderr/stdout 回显到 HTTP 响应 🔴

`server.js:173,294,315` 与 `server_handlers.mjs:173,198-199` 把最多 1000 字符的 `stderr`/`stdout` 塞进响应体。yt-dlp / ffmpeg 的输出包含**完整视频 URL、Referer，以及用户粘贴的登录 Cookie**（Cookie 经 `resolve_video_url.js:124` 拼进 yt-dlp 命令行，报错即被捕获）。

**改法**：生产环境只回传一句通用提示 + `requestId`；详细日志写入服务端日志文件，并过滤含 `Cookie:` / `token` 的行。

### P0-4 上传文件名拼路径存在穿越风险 🟠

`server.js:247,254`：

```javascript
const fileName = file.filename;
const ext = path.extname(fileName) || '.bin';
const filePath = path.join(tmpDir, `input${ext}`);
```

**改法**：用扩展名白名单 + 随机文件名，绝不直接采用用户提供的 `filename`。

```javascript
const ext = (path.extname(file.filename || '').match(/^\.[a-z0-9]{1,5}$/i) || ['.bin'])[0].toLowerCase();
const filePath = path.join(tmpDir, `input${ext}`);   // tmpDir 已随机化，足矣
```

### P0-5 关闭 Chromium 沙箱加载任意 URL 🟠

`resolve_video_url.js:153` `--no-sandbox --disable-setuid-sandbox`。在 P0-2 落地 URL 白名单后可接受；若服务对公网开放，建议改回沙箱或改用独立容器承载解析。

---

## 三、P1 — 架构去重与分层

### P1-1 消除 `server.js` 与 `server_handlers.mjs` 的重复转写逻辑

`server.js:261-325`（`/api/transcribe-file`）与 `server_handlers.mjs:139-203` 是近乎逐行复制的 ~60 行：拼 `args` → `execFile('python3')` → 超时/错误/JSON 解析三段分支。

**改法**：抽 `scripts/transcribe_runner.mjs`，导出 `runTranscribe({ source: {type:'url'|'file', value}, ...opts })` 返回 Promise，两处统一调用。

### P1-2 `server.js` 拆出路由表

398 行的单个 `createServer` 回调里塞了 7 个接口 + 静态服务 + `.env` 加载。改为路由表 + `lib/static.mjs`，每个 handler 独立成文件（`routes/process.js`、`routes/transcribe.js` …），可读性与可测试性显著提升。

### P1-3 媒体特征常量重复定义

`server_handlers.mjs:14` 的 `DIRECT_MEDIA_RE` 与 `resolve_video_url.js:31` 的 `MEDIA_EXT` 是同一语义的两份正则（且前者少了 `ogg`）。统一到 `lib/media.js`，同时收编散落各处的打分常量（`scoreByUrl` 的 70/85/65/55/60/25/50/20）。

`looksLikeDirectMedia` 已导出但无人调用，删除或接入。

### P1-4 `resolve_video_url.js` 拆分

`tryPlaywright()`（L141 起，约 220 行）把「浏览器启动 + 网络嗅探」与「业务级 UI 自动化（Cookie 横幅 → 报名弹窗 → 填手机号 → 勾选协议 → 提交）」揉在一起。且 L190/198/236/311 的四组中文按钮文案是针对 NVIDIA SCRM 单页的硬编码。

**改法**：
- `scripts/sniffer.js` — 通用嗅探（网络响应/请求/iframe/静态 HTML）
- `scripts/autofill_login.js` — 站点专属自动化，按钮文案抽为可配置 `SELECTORS` 表，按域名匹配

### P1-5 错误处理：消灭静默 `catch {}`

`resolve_video_url.js` 有 12 处裸 `catch {}`（L100,134,173,193,203,252,302,322,330,356,462,478），失败零日志。改为统一 `debugLog(scope, e)`，受 `LW_DEBUG=1` 控制，默认至少 `console.warn`。

`transcribe.py:253` 只有一个兜底 `except` 且丢堆栈，改为 `traceback.format_exc()` 输出。

---

## 四、P2 — 性能与资源

### P2-1 解析链路串行耗时可超 2 分钟

最坏路径累加：yt-dlp 25s（L129）+ `goto` 35s（L299）+ 固定 `waitForTimeout(5000)`（L305）+ 播放点击 4000ms（L321）+ 手机号流程 ~15s（L195-251）+ **每个 iframe 再跑 25s 且 iframe 数量无上限**（L466-472）。

**改法**：
- 硬编码 `waitForTimeout`（合计 ~13s）改为 `waitForSelector` / 事件驱动
- iframe 递归加深度上限（≤2）与数量上限（≤3），并设全局 `deadline`，超时即返回已收集候选
- 策略 1（直链判定）命中时直接短路，不再启动浏览器

### P2-2 响应体内存风险

`resolve_video_url.js:276-280`：

```javascript
if (cl > 0 && cl > 6 * 1024 * 1024) return;   // 有 content-length 才拦得住
const buf = await resp.body();                 // 先整包读入内存
if (txt.length > 8 * 1024 * 1024) return;      // 检查在读完之后
```

缺少 `content-length` 的 chunked 响应可绕过前置检查直接 OOM。改为流式读取并边读边截断（读满 8MB 即 `destroy()`）。

### P2-3 临时文件泄漏

- `transcribe.py:259` 的 `finally` 只删 `audio.wav`，**下载的 mp4 与整个临时目录永久残留**
- `server_handlers.mjs:136` 的 `livewiki_transcribe_*` 输出目录无清理逻辑
- `server.js:252` 的 `livewiki_upload_*` 目录，回调里只删了输入文件，目录本身未删

**改法**：统一 `shutil.rmtree(tmpdir, ignore_errors=True)` / `fs.rm(tmpDir, {recursive:true, force:true})`，并加一个启动时扫描清理超过 24 小时的残留目录。

### P2-4 规则引擎复杂度

`pipeline.mjs:387-389` 关键词去重是 O(n²) 的 `entries.some(...)`；`detectRelations`（L518-541）对所有要点做 O(m²) 全对比较。3 万字长文会明显卡顿。

**改法**：
- 去重改用按词长分组 + 倒排索引，或先按频次降序截断到 Top 200 再做两两比较
- `detectRelations` 先按章节聚合 token 集合，再做章节级两两比较（章节数远小于要点数）

### P2-5 缓存落盘阻塞事件循环

`pipeline.mjs:36-43` 每次 `cacheSet` 都同步 `writeFileSync` **全量**重写 50 条结果，大结果下直接阻塞。且无 TTL，`/tmp/livewiki_proc_cache.json` 只增不减。

**改法**：改为 debounce 落盘（如 2s 合并写）+ LRU 淘汰 + 每条加 `ts` 字段，加载时丢弃超过 7 天的条目。

### P2-6 填充词正则每次请求重建

`pipeline.mjs:489-491` 对每个填充词 `new RegExp(word, 'g')`，每次请求重建 16 个正则。提到模块顶层预编译为常量数组。

---

## 五、P3 — 工程化与可维护性

| 项 | 现状 | 建议 |
| --- | --- | --- |
| 测试 | 0 | 为 `lib/pipeline.mjs`（纯函数：`preprocess`/`extractKeywords`/`detectRelations`）与 `lib/url-guard.mjs` 补 `node:test` 单测，这两个模块零依赖、最易测、也最容易回归 |
| 前端 | 1940 行单文件 | 拆为 `index.html` + `app.css` + `app.js`；`app.js` 再按视图（文档/摘要/导图）分模块，用 ESM `<script type="module">` |
| JS↔Python 契约 | 约定「stdout 最后一行是 JSON」，进度打 stderr | 显式约定：Python 只向 stdout 输出**一行** JSON，所有进度/日志走 stderr；Node 侧取最后一行前先过滤空行 |
| 崩溃重启 | `start.sh:3-9` 无限 `while true`，无退避 | 加指数退避与连续失败上限（如 5 次内退出），避免 crash loop 刷屏 |
| 并发去重 | `pipeline.mjs:592-596` 在 `run()` reject 时，等待方会拿到 rejected promise 且 `emit('done')` 不触发 | `_inflight` 存 `{ promise, catch: promise.catch(e=>e) }`，等待方统一走 `.catch()` 分支并 `emit('error')` |
| 魔法数字 | 打分/超时/截断值散落 | 收编到 `lib/constants.js` |
| 硬编码 | `resolve_video_url.js:165` 写死 macOS Chrome 124 UA；`transcribe.py:200` `SPEAKER_MAP` 定义在 `main()` 内部、写死 5 人且 `name` 恒等于 `id`（与 docstring 承诺的映射不符） | UA 抽常量；`SPEAKER_MAP` 提到模块级并支持环境变量覆盖 |
| 版本管理 | `package.json` 只声明 `playwright` | 补充 `engines`、`lint`/`test` 脚本；`.env.example` 目前只在 README 里，建议实体化 |

---

## 六、落地路线图

| 阶段 | 内容 | 预估工作量 | 风险 |
| --- | --- | --- | --- |
| **第 1 批**（当天） | P0-1 脱敏、P0-2 URL 守卫、P0-3 收敛回显、P0-4 文件名白名单 | 半天 | 低，均为局部改动 |
| **第 2 批** | P1-1 抽 `transcribe_runner.mjs`、P1-3 统一媒体常量、P1-5 日志规范化 | 1 天 | 中，涉及双端共用逻辑，需本地 + Vercel 各验一次 |
| **第 3 批** | P2-1 解析链路并行化与超时、P2-2 流式读取、P2-3 临时目录清理 | 1 天 | 中，需真实活动页回归 |
| **第 4 批** | P1-2 路由表拆分、P1-4 解析器拆分、P2-4/5/6 性能 | 2 天 | 中高，建议先补 P3 单测再动 |
| **第 5 批** | P3 前端拆分、工程化（`node:test`、lint、`.env.example`） | 2 天 | 低，纯增量 |

**建议先做第 1 批**：四个 P0 都是"改动小、收益大"的局部修复，不涉及架构变动，可独立发版。第 4 批的架构拆分建议在第 3 批完成且补齐 `pipeline.mjs` 单测之后再启动。
