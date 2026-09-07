#!/bin/bash
# 启动 LiveWiki Demo，并在异常退出后按指数退避重启。
#
# 原先是 while true 无限重启：一旦启动即失败（端口占用、语法错误等），
# 会每秒刷一遍日志且不停止。这里加上退避与重试上限。
#
# 环境变量：
#   LW_MAX_RETRIES  连续失败重启次数上限，默认 5；设为 0 表示不限制
cd "$(dirname "$0")"

MAX_RETRIES=${LW_MAX_RETRIES:-5}
delay=1
attempt=0

while true; do
  echo "[$(date '+%H:%M:%S')] 启动 LiveWiki Demo... (第 $((attempt + 1)) 次)"
  node server.js
  EXIT_CODE=$?
  attempt=$((attempt + 1))

  if [ $EXIT_CODE -eq 0 ]; then
    echo "[$(date '+%H:%M:%S')] 服务器正常退出"
    exit 0
  fi

  if [ "$MAX_RETRIES" -gt 0 ] && [ "$attempt" -ge "$MAX_RETRIES" ]; then
    echo "[$(date '+%H:%M:%S')] 连续 ${attempt} 次异常退出（最后 exit=${EXIT_CODE}），达到上限，停止重启"
    exit "$EXIT_CODE"
  fi

  echo "[$(date '+%H:%M:%S')] 服务器退出 (code=${EXIT_CODE})，${delay}s 后重启..."
  sleep "$delay"
  delay=$((delay * 2))
  if [ $delay -gt 30 ]; then delay=30; fi
done
