# LiveWiki Demo v2.1.0

> AI 直播课程知识沉淀引擎 — 从视频 URL 到结构化学习文档

## ✨ 功能

### 核心功能

- **ASR 逐字稿结构化处理**：粘贴逐字稿 → AI 自动清洗、语义切分、内容结构化、知识关联 → 生成带导航的 HTML + Markdown
- **多视图输出**：文档视图（带目录、章节、关键点）、Markdown 视图、统计视图
- **一键导出**：复制 Markdown、下载 .md 文件

### 🆕 v2.0 新增：视频自动转写

- **从视频 URL 导入**：输入 YouTube/飞书/B站等视频 URL → 自动下载 → ASR 转写 → 发言人识别 → 填入文本框
- **技术管线**：yt-dlp 下载 → ffmpeg 提取音频 → faster-whisper 转写 → pyannote.audio 说话人分离（可选，无 HF_TOKEN 时默认跳过）
- **依赖检测**：GET `/api/transcribe/status` 检查环境是否就绪
- **可折叠 UI**：视频导入区域可展开/收起，不干扰手动粘贴工作流

### 🆕 v2.1 / v2.1.0 新增：落地页真实链接解析 + 自动登录 + 逐字稿一键导入

> 痛点：很多活动落地页 / SPA（如 NVIDIA SCRM 活动页、飞书、各类 H5）里的视频并非直链，而是 JS 动态注入、m3u8 切片或嵌套在第三方播放器中。直接把落地页 URL 丢给下载器往往拿不到真实视频流。

- **默认自动定位**：粘贴活动页 URL 并开启「🤖 自动找真实链接」（默认开），系统会**自动解析出页面内真实的视频流地址**再转写，无需手动找直链。
- **手机号自动登录（免验证码活动页）**：在「手机号」框填入号码后，Playwright 会先接受 Cookie 横幅 → 点击「注册并观看」等 CTA 打开报名弹窗 → 自动填入手机号并提交，进入播放态后再嗅探真实流。适用于仅填手机号即可观看的活动页。
- **Cookie 透传**：对需要真实账号（如 NVIDIA SSO）的页面，可在「Cookie」输入框粘贴已登录会话的 Cookie，解析器携带它加载已登录页面，绕过账号墙。
- **多策略解析器**（`scripts/resolve_video_url.js`）：
  1. 本身已是直链 → 直接返回
  2. `yt-dlp --get-url` 提取（YouTube / B站 / 腾讯 / 优酷 等已知平台）
  3. Playwright 无头浏览器嗅探真实媒体网络请求（mp4 / m3u8 / webm …）、读取 `<video>` 真实 `src`、`<source>`、嵌套 `iframe` 的 `src`
  4. 对每个嵌套 `iframe` 的 `src` 再跑 `yt-dlp`（第三方播放器常见于 iframe）
  5. 扫描页面 API 响应体，挖掘其中内嵌的视频地址 / 第三方播放器页（活动页常把地址放在 JSON 接口里）
  6. 静态 HTML 解析兜底（og:video、JSON-LD、video/source 标签、m3u8 链接）
- **防盗链**：解析到真实链接后，自动携带落地页来源作为 `Referer` 头传给下载器，绕过防盗链。
- **候选预览**：点「🔎 解析链接」可只解析不转写，列出按可信度排序的候选真实地址，手动选择其一再转写。
- **本地逐字稿一键导入**：转写完成后，可通过 `GET /api/last-transcript` 读取本地生成的逐字稿；前端「📥 导入并生成」按钮一键导入并自动生成结构化文档 / 摘要 / 思维导图。
- **API**：
  - `POST /api/resolve-video` `{ url, phone?, cookies? }` → 返回候选真实链接列表
  - `POST /api/transcribe` 新增 `autoResolve`（默认 `true`）、`resolvedUrl`（手动指定候选）、`phone`、`cookies` 参数，响应中附带 `resolve` 解析详情
  - `GET /api/last-transcript` → 返回最近一次本地转写的逐字稿文本
- **诚实的边界**：需要登录 / 报名且依赖密码或短信验证码（如 NVIDIA SSO）的页面，自动填手机号无法越过，需手动提供登录态 Cookie 或直链。加密第三方播放器（如阿里云 VOD `playAuth`）托管的页面，无法在无人值守情况下拿到直链。此时会给出明确提示，建议用「🔎 解析链接」查看候选或提供直链。

## 🚀 快速开始

### 本地运行（完整功能）

```bash
# 1. 安装依赖
npm install

# 1.1 安装 Playwright 无头浏览器（落地页自动找真实链接功能依赖）
npx playwright install chromium

# 2. 安装 Python 依赖（视频转写功能）
#    推荐在虚拟环境中安装，避免影响系统 Python：
python3 -m venv .venv && source .venv/bin/activate
pip install yt-dlp faster-whisper
pip install pyannote.audio  # 可选：发言人识别（默认转写会跳过，需 HF_TOKEN）
#    若使用系统 Python 且遇到 externally-managed 报错，可改用：
#    python3 -m pip install --break-system-packages yt-dlp faster-whisper

# 3. 设置 HuggingFace Token（可选，用于发言人识别）
export HF_TOKEN=your_token_here

# 4. （可选）接入真实 LLM 做「生成式归纳」摘要
#    不配置时自动回退到内置规则引擎（关键词归纳 + 抽取式要点）
#    配置后，摘要/要点/关键词由大模型用自有语言重写，而非摘录原文
#    支持多供应商链：按顺序尝试，前一个失败自动切下一个
export LW_LLM_PROVIDER=stepfun,nvidia       # 尝试顺序（默认 stepfun,nvidia,custom）

# 阶跃星辰 StepFun（step-3.5-flash / step-3.7-flash）
export LW_STEPFUN_API_KEY=xxx
export LW_STEPFUN_MODEL=step-3.5-flash

# 英伟达 NVIDIA NIM（qwen/qwen3-next-80b-a3b-instruct 等，中文更优）
export LW_NVIDIA_API_KEY=nvapi-xxx
export LW_NVIDIA_MODEL=qwen/qwen3-next-80b-a3b-instruct

# 5. 启动
node server.js
# 打开 http://localhost:3210
```

### Vercel 部署（仅结构化处理）

```bash
# Vercel 环境不支持视频转写（需要 Python + ffmpeg + GPU）
# 但结构化处理功能完全可用
vercel --prod
```

## 📁 项目结构

```text
livewiki-demo/
├── server.js                 # 本地 Node.js 服务器（完整功能）
├── public/
│   └── index.html            # 前端 UI（含视频导入 / 逐字稿导入区域）
├── scripts/
│   ├── transcribe.py         # Python 转写管线（yt-dlp + ffmpeg + whisper）
│   ├── resolve_video_url.js  # 落地页真实视频链接多策略解析器
│   └── server_handlers.mjs   # 解析 / 转写逻辑（server.js 与 Vercel 共用）
├── api/
│   ├── process.js            # Vercel Serverless: 结构化处理
│   ├── sample.js             # Vercel Serverless: 示例数据
│   ├── transcribe-status.js  # Vercel Serverless: 依赖检测
│   ├── resolve-video.mjs     # Vercel Serverless: 解析落地页真实链接
│   └── transcribe.mjs        # Vercel Serverless: 视频转写
├── vercel.json               # Vercel 部署配置
├── package.json
└── README.md
```

## 🛠️ 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | HTML + CSS + Vanilla JS（无框架，零依赖） |
| 后端 | Node.js HTTP Server（本地）/ Vercel Serverless（线上） |
| 转写管线 | Python: yt-dlp + ffmpeg + faster-whisper + pyannote.audio |
| AI 处理 | 规则引擎（模拟 LLM 结构化逻辑） |

## 📊 处理流程

```text
视频 URL → yt-dlp 下载 → ffmpeg 提音频 → faster-whisper 转写 → pyannote 说话人分离
                                                                          ↓
                                                         带发言人标签的逐字稿
                                                                          ↓
                                              预处理 → 语义切分 → 结构化 → 知识关联
                                                                          ↓
                                                    HTML 文档 + Markdown + 统计
```

## 🎯 使用场景

1. **直播课程复盘**：粘贴/导入课程逐字稿 → 生成结构化笔记
2. **会议纪要**：会议录音转写 → 自动提取关键点和主题
3. **播客整理**：播客视频 URL → 带发言人标签的摘要文档
4. **培训资料**：培训视频 → 可搜索的知识库文档

## 📝 License

MIT
