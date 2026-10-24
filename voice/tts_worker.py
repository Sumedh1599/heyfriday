"""Persistent text-to-speech worker. Reads JSON lines on stdin, writes WAV files.

Voice: Kokoro-82M `af_heart` through kokoro-onnx.

Request:  {"id": "...", "text": "...", "speed": 1.0, "out": "/path/file.wav"}
Response: {"id": "...", "ok": true} or {"id": "...", "ok": false, "error": "..."}
"""
import json
import sys
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

MODELS = Path(__file__).parent / "models"
VOICE = "af_heart"

kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    try:
        speed = max(0.5, min(2.0, float(req.get("speed", 1.0))))
        samples, rate = kokoro.create(req["text"], voice=VOICE, speed=speed, lang="en-us")
        sf.write(req["out"], samples, rate, subtype="PCM_16")
        print(json.dumps({"id": req["id"], "ok": True}), flush=True)
    except Exception as exc:  # report, keep serving
        print(json.dumps({"id": req.get("id"), "ok": False, "error": str(exc)}), flush=True)
