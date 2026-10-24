#!/usr/bin/env bash
# Start HeyFriday: runs the local server (CLI) and opens the web app in Chrome.
# Also creates "Launch HeyFriday.app" on your Desktop (double-click = same as running this script).
#   ./launch.sh             start the app (and create the Desktop app if missing)
#   ./launch.sh --app-only  only (re)create the Desktop app
# (c) 2026 Aipresso Limited, MIT License.
set -euo pipefail
cd "$(dirname "$0")"
# macOS paths are case-insensitive; re-enter the folder with its true on-disk case (see install.sh).
cd "$(node -e "console.log(require('fs').realpathSync.native(process.argv[1]))" "$PWD" 2>/dev/null || pwd)"
ROOT="$PWD"
APP="$HOME/Desktop/Launch HeyFriday.app"
PORT="${APP_PORT:-3080}"
URL="http://127.0.0.1:$PORT"

build_app() {
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  local iconset; iconset="$(mktemp -d)/icon.iconset"; mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    sips -z $s $s docs/icon.png --out "$iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) docs/icon.png --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$APP/Contents/Resources/icon.icns"
  cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Launch HeyFriday</string>
<key>CFBundleExecutable</key><string>launch-app</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundleIdentifier</key><string>local.heyfriday.launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
  # The app opens a Terminal window running this script, so it gets your normal shell PATH and folder access.
  cat > "$APP/Contents/Resources/run.command" <<RUN
#!/bin/bash
cd '$ROOT' && ./launch.sh --no-app
RUN
  chmod +x "$APP/Contents/Resources/run.command"
  cat > "$APP/Contents/MacOS/launch-app" <<'LAUNCH'
#!/bin/bash
exec /usr/bin/open -a Terminal "$(dirname "$0")/../Resources/run.command"
LAUNCH
  chmod +x "$APP/Contents/MacOS/launch-app"
  xattr -cr "$APP" 2>/dev/null || true
  touch "$APP"
  echo "Desktop app ready: $APP"
}

MODE="${1:-}"
if [ "$MODE" != "--no-app" ] && { [ "$MODE" = "--app-only" ] || [ ! -d "$APP" ]; }; then build_app; fi
[ "$MODE" = "--app-only" ] && exit 0

command -v node >/dev/null || { echo "node is required (brew install node)"; exit 1; }
command -v whisper-cli >/dev/null || { echo "whisper-cli missing: brew install whisper-cpp"; exit 1; }
[ -f harness/packages/sdk/client/lib/index.js ] || { echo "Harness not built. Run ./install.sh first."; exit 1; }

open_browser() {
  [ "${APP_NO_OPEN:-}" = 1 ] && return 0
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
}

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "HeyFriday is already running on $URL. Opening it."
  open_browser; exit 0
fi

( for _ in $(seq 1 60); do
    curl -fs "$URL/api/state" >/dev/null 2>&1 && { open_browser; break; }
    sleep 0.5
  done ) &
echo "Starting HeyFriday on $URL (press Ctrl+C to stop)"
exec node server/index.mjs
