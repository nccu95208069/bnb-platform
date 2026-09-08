#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "${0:A:h}/../.."
echo '正在啟動競品雷達。請保持此視窗與 Codex 開啟。'
echo '測試頁面：http://127.0.0.1:43118/radar-test'
exec node scripts/radar-desktop/start.mjs
