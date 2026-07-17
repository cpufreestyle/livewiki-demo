#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站视频上传工具（扫码登录 + 凭证持久化 + 上传 + WebUI）

基于 bilibili-api-python（直接调用 B站官方 API），无需第三方付费服务。

用法:
  命令行（首次会生成二维码，手机 B站扫码并点「确认登录」）:
    python publish.py --video ai-weekly.mp4 --cover cover.png \
        --title "标题" --desc "简介" --tags "AI,科技" --tid 208

  仅登录保存凭证（不上传）:
    python publish.py --login-only

  忽略已保存凭证，重新扫码:
    python publish.py --force-login --video ... --title ...

  WebUI（浏览器里操作，更适合非技术用户）:
    python publish.py --web --host 0.0.0.0 --port 8000
    # 然后浏览器打开 http://localhost:8000

说明:
  - 凭证保存在脚本同目录 bili_credential.json（仅本机，不外传）。
  - 二维码有效期约 3 分钟，请在手机上及时「确认登录」。
  - 上传失败自动重试 3 次（应对偶发网络抖动）。
"""

import argparse
import asyncio
import json
import os
import sys
import time

from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents
from bilibili_api.video_uploader import VideoUploader, VideoUploaderPage, VideoMeta
from bilibili_api.utils.picture import Picture
from bilibili_api import Credential

DEFAULT_TID = 208          # 科技
CRED_FILE = "bili_credential.json"
SCAN_TIMEOUT = 180         # 秒，二维码等待上限
UPLOAD_RETRIES = 3
RETRY_WAIT = 8             # 秒


# --------------------------------------------------------------------------- #
# 凭证持久化
# （该版本 Credential 无 .serialize()，用 get_cookies / from_cookies 做存读）
# --------------------------------------------------------------------------- #
def save_cred(cred: Credential) -> bool:
    try:
        with open(CRED_FILE, "w", encoding="utf-8") as f:
            json.dump(cred.get_cookies(), f, ensure_ascii=False, indent=2)
        print("[cred] saved ->", os.path.abspath(CRED_FILE), flush=True)
        return True
    except Exception as e:
        print("[cred] save failed:", repr(e), flush=True)
        return False


def load_cred():
    if not os.path.isfile(CRED_FILE):
        return None
    try:
        with open(CRED_FILE, "r", encoding="utf-8") as f:
            cookies = json.load(f)
        c = Credential.from_cookies(cookies)
        if not (c.has_sessdata() and c.has_bili_jct()):
            print("[cred] saved credential incomplete, will re-login", flush=True)
            return None
        return c
    except Exception as e:
        print("[cred] load failed:", repr(e), flush=True)
        return None


# --------------------------------------------------------------------------- #
# 登录（二维码）
# --------------------------------------------------------------------------- #
async def generate_login_qr():
    """生成登录二维码，返回 (QrCodeLogin 对象, PNG 字节)。"""
    qr = QrCodeLogin()
    await qr.generate_qrcode()
    pic = qr.get_qrcode_picture()
    return qr, pic.content


async def poll_login_state(qr):
    """轮询扫码状态，返回 (状态名, 登录成功时的 Credential 或 None)。"""
    try:
        state = await qr.check_state()
    except Exception:
        return "TIMEOUT", None
    if state == QrCodeLoginEvents.DONE:
        try:
            return "DONE", qr.get_credential()
        except Exception:
            return "ERROR", None
    return state.name, None


# --------------------------------------------------------------------------- #
# 上传
# --------------------------------------------------------------------------- #
async def upload_video(cred, video, cover, title, desc, tags, tid):
    cover_pic = Picture.from_file(cover) if cover and os.path.isfile(cover) else None
    page = VideoUploaderPage(path=video, title=title[:80], description=desc[:250])
    meta = VideoMeta(
        tid=tid,
        title=title[:80],
        desc=desc,
        cover=cover_pic,
        tags=[t.strip() for t in tags.split(",") if t.strip()],
        original=True,
        no_reprint=True,
    )
    print("[upload] starting:", video, flush=True)
    uploader = VideoUploader(pages=[page], meta=meta, credential=cred)
    result = await uploader.start()
    save_cred(cred)  # 上传过程可能刷新 cookie
    return result


# --------------------------------------------------------------------------- #
# 编排（命令行主流程）
# --------------------------------------------------------------------------- #
async def run_publish(args):
    if not args.video or not args.title:
        print("ERROR: --video 和 --title 均为必填", flush=True)
        sys.exit(1)
    if not os.path.isfile(args.video):
        print("ERROR: video not found:", args.video, flush=True)
        sys.exit(1)

    cred = None if args.force_login else load_cred()
    if cred is None:
        print("[cred] need login", flush=True)
        qr, png = await generate_login_qr()
        ts = time.strftime("%H%M%S")
        qr_path = os.path.abspath(f"bilibili-qr-{ts}.png")
        with open(qr_path, "wb") as f:
            f.write(png)
        print("QR_READY:" + qr_path, flush=True)
        print("请用 B站 App 扫码，并在手机上点「确认登录」（约 3 分钟有效）", flush=True)

        deadline = time.time() + SCAN_TIMEOUT
        while time.time() < deadline:
            await asyncio.sleep(2)
            state, c = await poll_login_state(qr)
            print("STATE:", state, flush=True)
            if c is not None:
                cred = c
                save_cred(cred)
                break
        else:
            print("LOGIN_FAIL", flush=True)
            sys.exit(1)

    if args.login_only:
        print("LOGIN_ONLY_DONE", flush=True)
        return

    last_err = None
    for attempt in range(1, UPLOAD_RETRIES + 1):
        try:
            print(f"[upload] attempt {attempt}", flush=True)
            result = await upload_video(
                cred, args.video, args.cover, args.title, args.desc, args.tags, args.tid
            )
            print("UPLOAD_RESULT:" + str(result), flush=True)
            if isinstance(result, dict) and result.get("bvid"):
                print("BV:" + result["bvid"])
                print("URL:https://www.bilibili.com/video/" + result["bvid"])
            return
        except Exception as e:
            last_err = e
            print(f"[upload] attempt {attempt} FAILED: {e!r}", flush=True)
            await asyncio.sleep(RETRY_WAIT)
    print("UPLOAD_GIVEUP:", repr(last_err), flush=True)
    sys.exit(1)


# --------------------------------------------------------------------------- #
# CLI 入口
# --------------------------------------------------------------------------- #
def parse_args():
    ap = argparse.ArgumentParser(description="B站视频上传工具（扫码登录 + 凭证持久化）")
    ap.add_argument("--video", default=None, help="视频文件路径")
    ap.add_argument("--cover", default=None, help="封面图路径（可选）")
    ap.add_argument("--title", default=None, help="视频标题")
    ap.add_argument("--desc", default="", help="视频简介")
    ap.add_argument("--tags", default="", help="标签，逗号分隔，如 AI,科技,新闻")
    ap.add_argument("--tid", type=int, default=DEFAULT_TID, help="分区 tid，默认 208(科技)")
    ap.add_argument("--login-only", action="store_true", help="仅登录并保存凭证，不上传")
    ap.add_argument("--force-login", action="store_true", help="忽略已保存凭证，重新扫码登录")
    ap.add_argument("--web", action="store_true", help="启动 WebUI（浏览器操作）")
    ap.add_argument("--host", default="0.0.0.0", help="WebUI 监听地址")
    ap.add_argument("--port", type=int, default=8000, help="WebUI 端口")
    return ap.parse_args()


def cli():
    args = parse_args()
    if args.web:
        from web import run_web
        run_web(args.host, args.port)
        return
    asyncio.run(run_publish(args))


if __name__ == "__main__":
    cli()
