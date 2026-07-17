#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站视频上传工具（扫码登录 + 凭证持久化 + 上传）

基于 bilibili-api-python（直接调用 B站官方 API），无需第三方付费服务。

用法:
  首次运行（会生成二维码，手机 B站扫码并点「确认登录」）:
    python publish.py --video ai-weekly.mp4 --cover cover.png \
        --title "标题" --desc "简介" --tags "AI,科技" --tid 208

  凭证已保存后（bili_credential.json），再次运行免扫码直接上传:
    python publish.py --video ai-weekly.mp4 --cover cover.png --title "..." ...

  仅登录并保存凭证（不上传）:
    python publish.py --login-only

  强制重新扫码登录（忽略已保存凭证）:
    python publish.py --force-login --video ... --title ...

说明:
  - 登录凭证保存在脚本同目录的 bili_credential.json（仅本机，不外传）。
  - 二维码有效期约 3 分钟，请在手机上及时「确认登录」。
  - 上传失败会自动重试 3 次（应对偶发网络抖动）。
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


# --------------------------------------------------------------------------- #
# 凭证持久化（该版本 Credential 无 .serialize()，用 get_cookies/from_cookies）
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
async def do_login() -> Credential | None:
    qr = QrCodeLogin()
    await qr.generate_qrcode()
    ts = time.strftime("%H%M%S")
    qr_path = os.path.abspath(f"bilibili-qr-{ts}.png")
    pic = qr.get_qrcode_picture()
    with open(qr_path, "wb") as f:
        f.write(pic.content)
    print("QR_READY:" + qr_path, flush=True)
    print("请用 B站 App 扫码，并在手机上点「确认登录」（二维码有效期约 3 分钟）", flush=True)

    deadline = time.time() + SCAN_TIMEOUT
    while time.time() < deadline:
        await asyncio.sleep(2)
        state = await qr.check_state()
        if state == QrCodeLoginEvents.SCAN:
            print("STATE: SCAN (已扫描)", flush=True)
        elif state == QrCodeLoginEvents.CONF:
            print("STATE: CONF (已确认)", flush=True)
        elif state == QrCodeLoginEvents.DONE:
            cred = qr.get_credential()
            print("STATE: DONE (登录成功)", flush=True)
            save_cred(cred)
            return cred
        elif state == QrCodeLoginEvents.TIMEOUT:
            print("STATE: TIMEOUT (二维码过期，请重新运行)", flush=True)
            return None
    print("STATE: TIMEOUT (等待超时)", flush=True)
    return None


# --------------------------------------------------------------------------- #
# 上传
# --------------------------------------------------------------------------- #
async def do_upload(cred, video, cover, title, desc, tags, tid):
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
    # 上传过程可能刷新 cookie，覆盖保存
    try:
        save_cred(cred)
    except Exception:
        pass
    return result


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
async def main():
    ap = argparse.ArgumentParser(description="B站视频上传工具（扫码登录 + 凭证持久化）")
    ap.add_argument("--video", required=True, help="视频文件路径")
    ap.add_argument("--cover", default=None, help="封面图路径（可选）")
    ap.add_argument("--title", required=True, help="视频标题")
    ap.add_argument("--desc", default="", help="视频简介")
    ap.add_argument("--tags", default="", help="标签，逗号分隔，如 AI,科技,新闻")
    ap.add_argument("--tid", type=int, default=DEFAULT_TID, help="分区 tid，默认 208(科技)")
    ap.add_argument("--login-only", action="store_true", help="仅登录并保存凭证，不上传")
    ap.add_argument("--force-login", action="store_true", help="忽略已保存凭证，重新扫码登录")
    args = ap.parse_args()

    if not os.path.isfile(args.video):
        print("ERROR: video not found:", args.video, flush=True)
        sys.exit(1)

    cred = None if args.force_login else load_cred()
    if cred is not None:
        print("[cred] reuse saved credential", flush=True)
    else:
        print("[cred] need login", flush=True)
        cred = await do_login()
        if cred is None:
            print("LOGIN_FAIL", flush=True)
            sys.exit(1)

    if args.login_only:
        print("LOGIN_ONLY_DONE", flush=True)
        return

    last_err = None
    for attempt in range(1, 4):
        try:
            print(f"[upload] attempt {attempt}", flush=True)
            result = await do_upload(
                cred, args.video, args.cover, args.title, args.desc, args.tags, args.tid
            )
            print("UPLOAD_RESULT:" + str(result), flush=True)
            if isinstance(result, dict) and result.get("bvid"):
                print("BV:" + result["bvid"], flush=True)
                print("URL:https://www.bilibili.com/video/" + result["bvid"], flush=True)
            return
        except Exception as e:
            last_err = e
            print(f"[upload] attempt {attempt} FAILED: {e!r}", flush=True)
            await asyncio.sleep(8)
    print("UPLOAD_GIVEUP:", repr(last_err), flush=True)
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
