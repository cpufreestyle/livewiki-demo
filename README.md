# bilibili-publisher

![CI](https://github.com/cpufreestyle/bilibili-publisher/actions/workflows/ci.yml/badge.svg)

基于 [bilibili-api-python](https://github.com/bilibili-API-collect/bilibili-API-collect) 的 B站视频上传命令行工具。直接调用 B站官方 API，**免费、本地运行、无需任何第三方付费服务**。扫码登录一次后凭证自动保存，之后上传免扫码。

## 功能

- 扫码登录（二维码有效期约 3 分钟，手机 B站 App 确认）
- 登录凭证持久化到 `bili_credential.json`，下次运行免扫码
- 视频上传（支持封面、标题、简介、标签、分区）
- 上传失败自动重试 3 次（应对偶发网络抖动）

## 依赖

- Python 3.10+
- bilibili-api-python >= 17.0.0
- aiohttp

## 安装

```bash
python -m venv .venv
# Windows
.venv\Scripts\pip install -r requirements.txt
# macOS / Linux
.venv/bin/pip install -r requirements.txt
```

## 使用

首次运行（生成二维码，手机扫码确认登录，随后自动上传）：

```bash
python publish.py \
  --video ai-weekly.mp4 \
  --cover cover.png \
  --title "一周AI新闻速递 | AI Weekly #01" \
  --desc "本集回顾本周 AI 领域 5 条重磅动态……" \
  --tags "AI,人工智能,科技,新闻,每周速递" \
  --tid 208
```

凭证已保存后，再次运行会**自动跳过登录**直接上传。

其他模式：

```bash
# 仅登录并保存凭证（不上传）
python publish.py --login-only

# 强制重新扫码登录（忽略已保存凭证）
python publish.py --force-login --video ai-weekly.mp4 --title "..." --tags "AI"
```

参数说明：

| 参数 | 必填 | 说明 |
|------|------|------|
| `--video` | 是 | 视频文件路径 |
| `--cover` | 否 | 封面图路径 |
| `--title` | 是 | 视频标题（≤80 字） |
| `--desc`  | 否 | 视频简介 |
| `--tags`  | 否 | 标签，逗号分隔 |
| `--tid`   | 否 | 分区 id，默认 `208`（科技） |
| `--login-only` | 否 | 仅登录保存凭证 |
| `--force-login` | 否 | 忽略已保存凭证重新登录 |

## 安全说明

- 登录凭证仅保存在你本机的 `bili_credential.json`，**请勿提交到 Git 仓库**（已在 `.gitignore` 中排除）。
- 上传操作需登录你本人的 B站账号，请自行对发布内容负责。

## 分区 tid 参考

- 科技 `208`
- 动画 `19`
- 游戏 `4`
- 生活 `21`
- 知识 `201`

完整分区见 B站创作中心。
