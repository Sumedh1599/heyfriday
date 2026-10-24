#!/usr/bin/env bash
# One-time setup: builds "Launch HeyFriday.app" on your Desktop. Double-click it any time to start.
# Created locally, so macOS never flags it. (c) 2026 Aipresso Limited, MIT License.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
APP="${1:-$HOME/Desktop}/Launch HeyFriday.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Icon
ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s docs/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) docs/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

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

cat > "$APP/Contents/MacOS/launch-app" <<LAUNCH
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
mkdir -p "\$HOME/Library/Logs"
exec "$ROOT/start.sh" >>"\$HOME/Library/Logs/HeyFriday.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/launch-app"
xattr -cr "$APP" 2>/dev/null || true
touch "$APP"
echo "Created: $APP"
echo "Double-click it to start HeyFriday. Logs: ~/Library/Logs/HeyFriday.log"
