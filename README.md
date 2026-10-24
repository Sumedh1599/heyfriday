<div align="center">

# Personalised Voice AI Chat

**Talk to an AI agent hands-free. It answers out loud, writes code, runs commands, drives a browser and spawns subagents.**

![What the app looks like](docs/snapshot.png)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

</div>

## Quick start

You need macOS, [Homebrew](https://brew.sh), Node.js 22+ and an [OpenRouter API key](https://openrouter.ai/keys).

```sh
git clone https://github.com/Sumedh1599/personalised-voice-chat-.git
cd personalised-voice-chat-
./install.sh
./Launch\ app
```

`install.sh` downloads about 1.5 GB (harness, speech models, browser) and only needs to run once. `Launch app` opens http://127.0.0.1:3080.

Then: click **Start voice chat** → open the menu (top right) → paste your OpenRouter key and press **Save** → pick a model → say **"Friday"** and talk.

## Using it

| You do | What happens |
|---|---|
| Say "Friday", speak, then pause | Your words are sent after the pause (default 1.5 s, adjustable 0.8–60 s) |
| Say "done" at the end | Sends immediately (optional trigger word) |
| Speak while it is talking | It stops and listens to you |
| Turn on **Conversation mode** | No wake word needed, just talk |
| Ask for code or a flowchart | Shown on screen at the left, never read aloud |
| Ask it to use the browser | A visible Chrome window is controlled by the agent |

Change the wake word, trigger word, speech speed, pause length, model favourites and more in the menu. **Clear data** wipes the conversation; **Shutdown** stops everything.

## Features

- **Wake word, Siri-style auto-send and barge-in**, with an optional chat panel and text input
- **Natural female voice** ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) `af_heart`), streamed sentence by sentence so speech starts immediately
- **Local speech recognition** ([whisper.cpp](https://github.com/ggml-org/whisper.cpp))
- **Any OpenRouter model**: star favourites, switch live in the model popup
- **Real agent**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runs in the background with tools, subagents and sessions, in auto mode
- **Browser control** via [agent-browser](https://github.com/vercel-labs/agent-browser)
- **Graph memory** via [graphify](https://github.com/Graphify-Labs/graphify): the agent queries a local graph of your code instead of grepping
- **Rive background** with `IDLE`, `Listen` and `Reply` timelines
- A request proxy that limits parallel calls and retries 429s, plus plain-language errors with a suggested fix

## Safety

> **The agent runs in full-auto mode with unrestricted file and shell access and no approval prompts.** DeepSeek Harness is developer-preview software with no security audit. Use a dedicated machine or account and keep backups.

The server listens on `127.0.0.1` only and rejects foreign hosts and requests without its app header. Do not expose port 3080. Your API key is stored in `memory/settings.json` (owner-only, git-ignored).

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing happens when I talk | Allow the microphone for `127.0.0.1:3080` in your browser; check the wake word in the menu |
| Replies are slow or tools fail | Pick a stronger model; small ones (e.g. `gpt-oss-20b`) often call tools badly |
| "No credits" or 401 errors | Check your key and balance at [openrouter.ai](https://openrouter.ai) |
| Port 3080 in use | `APP_PORT=3090 ./Launch\ app` |

Other variables: `APP_NO_OPEN=1` (don't open the browser), `APP_DEBUG=1` (log turn endings).

## Project layout

```
Launch app        start script
install.sh        one-time setup
server/index.mjs  local server: UI, harness driver, speech endpoints, OpenRouter proxy
web/              frontend (assets/animate.riv is the background animation)
voice/            text-to-speech worker; models are downloaded here
memory/           agent workspace, harness home, settings (created at runtime, git-ignored)
harness/          DeepSeek Harness checkout (created by install.sh, git-ignored)
```

## Credits

Built on OpenRouter, DeepSeek Harness, whisper.cpp, Kokoro, agent-browser, graphify, Rive and Mermaid. Full list with authors and licenses: **[CREDITS.md](CREDITS.md)**. Not affiliated with any of them.

## License

[MIT](LICENSE). Third-party components keep their own licenses; see [CREDITS.md](CREDITS.md).
