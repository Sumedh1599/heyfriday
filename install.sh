#!/usr/bin/env bash
# One-time setup for HeyFriday on macOS. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
# Downloaded ZIPs are flagged by macOS Gatekeeper; clear it for this folder so launching works.
xattr -dr com.apple.quarantine . 2>/dev/null || true
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
command -v node >/dev/null || brew install node
command -v pnpm >/dev/null || npm i -g pnpm
command -v uv >/dev/null || brew install uv

# 1. DeepSeek Harness (MIT): the agent that runs in the background
[ -d harness ] || git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git harness
(cd harness && pnpm install && pnpm run build)

# 2. Speech to text: whisper.cpp (MIT) + English base model
brew list whisper-cpp >/dev/null 2>&1 || brew install whisper-cpp
mkdir -p voice/models
[ -f voice/models/ggml-base.en.bin ] || curl -L -o voice/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# 3. Text to speech: Kokoro-82M (Apache-2.0), voice af_heart, via kokoro-onnx (MIT)
[ -d voice/venv ] || uv venv --python 3.13 voice/venv
uv pip install --python voice/venv/bin/python kokoro-onnx soundfile
K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -f voice/models/kokoro-v1.0.onnx ] || curl -L -o voice/models/kokoro-v1.0.onnx $K/kokoro-v1.0.onnx
[ -f voice/models/voices-v1.0.bin ] || curl -L -o voice/models/voices-v1.0.bin $K/voices-v1.0.bin

# 4. Browser control: agent-browser (Apache-2.0)
command -v agent-browser >/dev/null || npm install -g agent-browser
agent-browser install

# 5. Graph memory: graphify (Apache-2.0); code is parsed locally, no LLM
command -v graphify >/dev/null || uv tool install graphifyy

echo
./make-app.sh
echo "Done. Double-click HeyFriday on your Desktop to start."
