#!/usr/bin/env bash
# Start HeyFriday: DeepSeek Harness runs in the background, the UI opens in your browser.
set -euo pipefail
cd "$(dirname "$0")"
cd "$(node -e "console.log(require('fs').realpathSync.native(process.argv[1]))" "$PWD" 2>/dev/null || pwd)"
# Clear the macOS "downloaded from the internet" flag on this folder (local files only).
xattr -dr com.apple.quarantine . 2>/dev/null || true
PORT="${APP_PORT:-3080}"
export APP_PORT="$PORT"

command -v node >/dev/null || { echo "node is required"; exit 1; }
command -v whisper-cli >/dev/null || { echo "whisper-cli missing: brew install whisper-cpp"; exit 1; }
[ -f harness/packages/sdk/client/lib/index.js ] || { echo "Harness not built: cd harness && pnpm install && pnpm run build"; exit 1; }

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT already in use (app already running?). Opening it."
  open "http://127.0.0.1:$PORT"; exit 0
fi

( for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1 && { [ "${APP_NO_OPEN:-}" = 1 ] || open "http://127.0.0.1:$PORT"; break; }
    sleep 0.5
  done ) &
exec node server/index.mjs
