# LiveWiki Demo v2.0

> AI 直播课程知识沉淀引擎 — 从视频 URL 到结构化学习文档

## ✨ 功能

### 核心功能
- **ASR 逐字稿结构化处理**：粘贴逐字稿 → AI 自动清洗、语义切分、内容结构化、知识关联 → 生成带导航的 HTML + Markdown
- **多视图输出**：文档视图（带目录、章节、关键点）、Markdown 视图、统计视图
- **一键导出**：复制 Markdown、下载 .md 文件

### 🆕 v2.0 新增：视频自动转写
- **从视频 URL 导入**：输入 YouTube/飞书/B站等视频 URL → 自动下载 → ASR 转写 → 发言人识别 → 填入文本框
- **技术管线**：yt-dlp 下载 → ffmpeg 提取音频 → faster-whisper 转写 → pyannote.audio 说话人分离
- **依赖检测**：GET `/api/transcribe/status` 检查环境是否就绪
- **可折叠 UI**：视频导入区域可展开/收起，不干扰手动粘贴工作流

## 🚀 快速开始

### 本地运行（完整功能）

```bash
# 1. 安装依赖
npm install

# 2. 安装 Python 依赖（视频转写功能）
pip3 install yt-dlp faster-whisper
pip3 install pyannote.audio  # 可选：发言人识别

# 3. 设置 HuggingFace Token（可选，用于发言人识别）
export HF_TOKEN=your_token_here

# 4. 启动
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

```
livewiki-demo/
├── server.js              # 本地 Node.js 服务器（完整功能）
├── public/
│   └── index.html         # 前端 UI（含视频导入区域）
├── scripts/
│   └── transcribe.py      # Python 转写管线（yt-dlp + whisper + pyannote）
├── api/
│   ├── process.js         # Vercel Serverless: 结构化处理
│   ├── sample.js          # Vercel Serverless: 示例数据
│   └── transcribe-status.js  # Vercel Serverless: 依赖检测
├── vercel.json            # Vercel 部署配置
├── package.json
└── README.md
```

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 前端 | HTML + CSS + Vanilla JS（无框架，零依赖） |
| 后端 | Node.js HTTP Server（本地）/ Vercel Serverless（线上） |
| 转写管线 | Python: yt-dlp + ffmpeg + faster-whisper + pyannote.audio |
| AI 处理 | 规则引擎（模拟 LLM 结构化逻辑） |

## 📊 处理流程

```
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
