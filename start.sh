#!/bin/bash
cd "$(dirname "$0")"
while true; do
  echo "[$(date '+%H:%M:%S')] 启动 LiveWiki Demo..."
  node server.js
  EXIT_CODE=$?
  echo "[$(date '+%H:%M:%S')] 服务器退出 (code=$EXIT_CODE)，3秒后重启..."
  sleep 3
done
