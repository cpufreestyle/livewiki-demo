#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站发布工具 WebUI（Flask）

单用户本地工具：用模块级 _SESSION 保存当前登录会话。
启动: python publish.py --web  (或 python web.py)
访问: http://localhost:8000
"""

import asyncio
import base64
import os
import tempfile

from flask import Flask, request, jsonify

from publish import (
    generate_login_qr,
    poll_login_state,
    upload_video,
    load_cred,
    save_cred,
    DEFAULT_TID,
)

app = Flask(__name__)

# 单用户本地工具：模块级状态保存当前登录会话
_SESSION = {"qr": None, "cred": None}

INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>B站发布工具 · WebUI</title>
<style>
  :root{--accent:#00D4FF;--bg:#060810;--card:#0e1422;--text:#e8eefc;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#8aa0c8;font-size:13px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid #1b2740;border-radius:12px;padding:18px;margin-bottom:18px;max-width:640px}
  h3{margin:0 0 10px;font-size:15px}
  label{display:block;font-size:13px;color:#a9bce0;margin:10px 0 4px}
  input[type=text],textarea,input[type=file]{width:100%;background:#0a0f1a;border:1px solid #233149;border-radius:8px;color:var(--text);padding:8px}
  button{background:var(--accent);color:#03121a;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer;margin-top:12px}
  .qr{margin-top:12px;min-height:20px}
  .qr img{width:240px;border-radius:8px;background:#fff;padding:8px}
  .status{font-size:13px;color:var(--accent);margin-top:8px;min-height:18px}
  .result{font-size:14px;margin-top:12px;word-break:break-all}
  a{color:var(--accent)}
  .row{display:flex;gap:12px}
  .row>div{flex:1}
</style>
</head>
<body>
  <h1>⚡ B站发布工具</h1>
  <div class="sub">扫码登录一次，之后上传免扫码。本地运行，凭证仅存本机。</div>

  <div class="card">
    <h3>1 · 登录 B站</h3>
    <button onclick="startLogin()">生成登录二维码</button>
    <div class="qr" id="qrBox"></div>
    <div class="status" id="loginStatus"></div>
  </div>

  <div class="card">
    <h3>2 · 发布视频</h3>
    <label>视频文件</label>
    <input type="file" id="video" accept="video/*">
    <label>封面（可选）</label>
    <input type="file" id="cover" accept="image/*">
    <label>标题</label>
    <input type="text" id="title" placeholder="一周AI新闻速递">
    <label>简介</label>
    <textarea id="desc" rows="2"></textarea>
    <div class="row">
      <div>
        <label>标签（逗号分隔）</label>
        <input type="text" id="tags" placeholder="AI,人工智能,科技">
      </div>
      <div>
        <label>分区 tid（默认 208 科技）</label>
        <input type="text" id="tid" value="208">
      </div>
    </div>
    <button onclick="publish()">发布</button>
    <div class="result" id="pubResult"></div>
  </div>

<script>
let timer=null;
function startLogin(){
  document.getElementById('loginStatus').textContent='生成中…';
  fetch('/api/login/start').then(r=>r.json()).then(d=>{
    if(d.error){document.getElementById('loginStatus').textContent='错误:'+d.error;return;}
    document.getElementById('qrBox').innerHTML='<img src="'+d.qr+'">';
    poll();
  }).catch(e=>document.getElementById('loginStatus').textContent='错误:'+e);
}
function poll(){
  fetch('/api/login/poll').then(r=>r.json()).then(d=>{
    document.getElementById('loginStatus').textContent='状态: '+d.state;
    if(d.logged_in){clearTimeout(timer);document.getElementById('loginStatus').textContent='✅ 已登录，可发布';return;}
    if(d.state==='TIMEOUT'||d.state==='NONE'||d.state==='ERROR'){clearTimeout(timer);return;}
    timer=setTimeout(poll,2000);
  });
}
function publish(){
  const v=document.getElementById('video').files[0];
  if(!v){document.getElementById('pubResult').textContent='请先选择视频文件';return;}
  const fd=new FormData();
  fd.append('video',v);
  const c=document.getElementById('cover').files[0]; if(c)fd.append('cover',c);
  fd.append('title',document.getElementById('title').value);
  fd.append('desc',document.getElementById('desc').value);
  fd.append('tags',document.getElementById('tags').value);
  fd.append('tid',document.getElementById('tid').value);
  document.getElementById('pubResult').textContent='上传中…';
  fetch('/api/publish',{method:'POST',body:fd}).then(r=>r.json()).then(d=>{
    if(d.url)document.getElementById('pubResult').innerHTML='✅ 发布成功: <a href="'+d.url+'" target="_blank">'+d.url+'</a>';
    else if(d.error)document.getElementById('pubResult').textContent='❌ '+d.error;
    else document.getElementById('pubResult').textContent='结果: '+JSON.stringify(d);
  }).catch(e=>document.getElementById('pubResult').textContent='错误:'+e);
}
</script>
</body>
</html>"""


@app.route("/")
def index():
    return INDEX_HTML


@app.route("/api/login/start")
def api_login_start():
    try:
        qr, png = asyncio.run(generate_login_qr())
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    _SESSION["qr"] = qr
    b64 = base64.b64encode(png).decode()
    return jsonify({"qr": "data:image/png;base64," + b64})


@app.route("/api/login/poll")
def api_login_poll():
    qr = _SESSION.get("qr")
    if qr is None:
        return jsonify({"state": "NONE"})
    state, cred = asyncio.run(poll_login_state(qr))
    if cred is not None:
        _SESSION["cred"] = cred
        save_cred(cred)
    return jsonify({"state": state, "logged_in": cred is not None})


@app.route("/api/publish", methods=["POST"])
def api_publish():
    cred = _SESSION.get("cred") or load_cred()
    if cred is None:
        return jsonify({"error": "尚未登录，请先扫码登录"}), 400

    video = request.files.get("video")
    if video is None:
        return jsonify({"error": "未收到视频文件"}), 400

    tmpdir = tempfile.mkdtemp()
    vpath = os.path.join(tmpdir, "video.mp4")
    video.save(vpath)

    cpath = None
    cover = request.files.get("cover")
    if cover:
        cpath = os.path.join(tmpdir, "cover.png")
        cover.save(cpath)

    title = request.form.get("title") or "未命名视频"
    desc = request.form.get("desc") or ""
    tags = request.form.get("tags") or ""
    try:
        tid = int(request.form.get("tid") or DEFAULT_TID)
    except ValueError:
        tid = DEFAULT_TID

    try:
        result = asyncio.run(upload_video(cred, vpath, cpath, title, desc, tags, tid))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    bvid = result.get("bvid") if isinstance(result, dict) else None
    url = f"https://www.bilibili.com/video/{bvid}" if bvid else None
    return jsonify({"result": str(result), "bvid": bvid, "url": url})


def run_web(host="0.0.0.0", port=8000):
    print(f"[web] serving on http://{host}:{port}", flush=True)
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    run_web()
