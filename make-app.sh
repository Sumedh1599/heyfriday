#!/usr/bin/env bash
# Build HeyFriday.app on your Desktop. Built locally, so macOS never flags it.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
APP="${1:-$HOME/Desktop}/HeyFriday.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>HeyFriday</string>
<key>CFBundleExecutable</key><string>HeyFriday</string>
<key>CFBundleIdentifier</key><string>local.heyfriday.launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/HeyFriday" <<LAUNCH
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
mkdir -p "\$HOME/Library/Logs"
exec "$ROOT/Launch.command" >>"\$HOME/Library/Logs/HeyFriday.log" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/HeyFriday"
xattr -cr "$APP" 2>/dev/null || true
echo "Created $APP. Double-click it to start HeyFriday (logs: ~/Library/Logs/HeyFriday.log)."
