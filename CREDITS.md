# Credits and licenses

This project is a thin layer that connects the following open-source projects and services. Each remains the property of its authors and is used under its own license. This project is not affiliated with or endorsed by any of them. Licenses below were checked against each project's repository or package metadata on 2026-10-24.

## Core

| Project | Author | License | How it is used |
|---|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek-AI | MIT | The agent runtime (tools, subagents, sessions). Cloned and built by `install.sh`; not copied into this repo. |
| [OpenRouter](https://openrouter.ai) | OpenRouter, Inc. | Hosted service ([terms](https://openrouter.ai/terms)) | Gateway to the language models. Requires your own API key. |

## Voice

| Project | Author | License | How it is used |
|---|---|---|---|
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Georgi Gerganov and contributors (ggml-org) | MIT | Local speech recognition (`whisper-server`), installed with Homebrew. |
| [Whisper](https://github.com/openai/whisper) `base.en` model | OpenAI | MIT | Model weights in ggml format, downloaded from [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp). |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | hexgrad | Apache-2.0 | Text-to-speech model and voices (`af_heart`), downloaded from the kokoro-onnx releases. |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | thewh1teagle | MIT | Runs Kokoro with ONNX Runtime. |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Microsoft | MIT | Inference engine (pip dependency). |
| [python-soundfile](https://github.com/bastibe/python-soundfile) | Bastian Bechtold | BSD-3-Clause | Writes WAV files (pip dependency). |
| [phonemizer](https://github.com/bootphon/phonemizer) and [espeak-ng](https://github.com/espeak-ng/espeak-ng) | Bootphon / espeak-ng contributors | GPL-3.0-or-later | Pulled in by kokoro-onnx (via `espeakng-loader`) for phonemes. Installed from PyPI into your local virtualenv; not redistributed in this repository. If you redistribute a bundle that includes them, the GPL applies to that bundle. |

## Agent abilities

| Project | Author | License | How it is used |
|---|---|---|---|
| [agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs | Apache-2.0 | Browser control for the agent (`npm install -g agent-browser`). |
| [Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing) | Google | Google Chrome terms | Browser binary downloaded by `agent-browser install`. |
| [graphify](https://github.com/Graphify-Labs/graphify) (PyPI: `graphifyy`) | Graphify Labs | Apache-2.0 | Local code knowledge graph used as the agent's memory. "graphify" is a mark of Graphify Labs; this project is community-built and unaffiliated. |

## Bundled in `web/vendor/`

| Project | Author | License | Version |
|---|---|---|---|
| [Rive canvas runtime](https://github.com/rive-app/rive-wasm) (`rive.js`, `rive.wasm`) | Rive | MIT | 2.45.1 |
| [Mermaid](https://github.com/mermaid-js/mermaid) (`mermaid.min.js`, license in `mermaid.LICENSE`) | Knut Sveidqvist and contributors | MIT | 11.4.1 |

## This repository

Application code is MIT licensed (see [LICENSE](LICENSE)). `web/assets/animate.riv` is the author's own animation and is covered by the same license.

## Citation for the harness

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## Notice

DeepSeek Harness is developer-preview software with no security audit. This project runs it in full-auto mode with unrestricted file and shell access; see the Safety section of the README.
