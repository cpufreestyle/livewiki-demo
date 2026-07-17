# bilibili-publisher

![CI](https://github.com/cpufreestyle/bilibili-publisher/actions/workflows/ci.yml/badge.svg)

基于 [bilibili-api-python](https://github.com/bilibili-API-collect/bilibili-API-collect) 的 B站视频上传工具，提供 **命令行** 与 **WebUI** 两种用法。直接调用 B站官方 API，**免费、本地运行、无需任何第三方付费服务**。扫码登录一次后凭证自动保存，之后上传免扫码。

## 功能

- 扫码登录（二维码），凭证持久化到 `bili_credential.json`（仅本机）
- 视频上传：支持封面、标题、简介、标签、分区
- 上传失败自动重试 3 次（应对偶发网络抖动）
- 两种入口：命令行 `publish.py` 与浏览器 `WebUI`

## 安装

```bash
pip install -r requirements.txt
# 或作为包安装（提供 bili-pub 命令）
pip install .
```

## 用法一：命令行

```bash
# 首次运行：生成二维码，手机 B站扫码并点「确认登录」
python publish.py --video ai-weekly.mp4 --cover cover.png \
    --title "一周AI新闻速递" --desc "简介" --tags "AI,科技" --tid 208

# 仅登录并保存凭证（不上传）
python publish.py --login-only

# 忽略已保存凭证，重新扫码
python publish.py --force-login --video ai-weekly.mp4 --title "标题"
```

参数：

| 参数 | 说明 | 默认 |
|---|---|---|
| `--video` | 视频文件路径（必填，WebUI 模式除外） | - |
| `--cover` | 封面图路径（可选） | - |
| `--title` | 视频标题（必填，WebUI 模式除外） | - |
| `--desc` | 视频简介 | 空 |
| `--tags` | 标签，逗号分隔 | 空 |
| `--tid` | 分区 tid（208=科技，172=手机，17=单机游戏…） | 208 |
| `--login-only` | 仅登录保存凭证，不上传 | 关 |
| `--force-login` | 忽略已保存凭证，重新扫码 | 关 |

## 用法二：WebUI（推荐非技术用户）

```bash
python publish.py --web --host 0.0.0.0 --port 8000
# 浏览器打开 http://localhost:8000
```

页面内：点「生成登录二维码」→ 手机 B站扫码确认 → 填表选择视频/封面 → 点「发布」。发布成功直接显示 B站视频链接。

## 常用分区 tid

| tid | 分区 | tid | 分区 |
|---|---|---|---|
| 208 | 科技 | 172 | 手机 |
| 17 | 单机游戏 | 65 | 网络游戏 |
| 119 | 鬼畜 | 95 | 影视 |
| 21 | 动画 | 201 | 娱乐 |

## 安全说明

- 本工具仅调用 B站官方 API，不经过任何第三方服务器。
- 登录凭证保存在运行目录的 `bili_credential.json`，**请勿提交到公开仓库**（已写入 `.gitignore`）。
- 发布操作需本人扫码确认，凭证不外传。

## 开发

```bash
pip install -e .
pytest            # 暂无单测，可扩展
python -m build   # 构建 wheel / sdist
```

CI（GitHub Actions）会在 push/PR 时自动执行：依赖安装 → 语法检查 → CLI/WebUI 导入冒烟测试 → 启动 WebUI 并请求首页 → ruff 检查，并构建发布包。
