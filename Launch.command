#!/usr/bin/env bash
# Double-click launcher for macOS. Runs ./Launch\ app in Terminal.
cd "$(dirname "$0")"
# Clear the macOS "downloaded from the internet" flag on this folder (local files only).
xattr -dr com.apple.quarantine . 2>/dev/null || true
exec ./"Launch app"
