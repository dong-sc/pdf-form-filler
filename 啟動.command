#!/bin/bash
# 雙擊這個檔案就會啟動工具。用完直接關掉這個終端機視窗即可。

cd "$(dirname "$0")" || exit 1

PORT=8777
while lsof -i ":$PORT" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo "勞報單填寫工具"
echo "───────────────────────────────"
echo "正在啟動…網址 http://localhost:$PORT"
echo "用完把這個視窗關掉就會停止。"
echo ""

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!

trap 'kill $SERVER_PID 2>/dev/null' EXIT

sleep 1
open "http://localhost:$PORT"

wait $SERVER_PID
