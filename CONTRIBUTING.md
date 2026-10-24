# Contributing

Thanks for helping! Good first areas: Linux/Windows support, a voice picker, local model endpoints, an approval mode.

1. Fork and clone, then run `./install.sh` and `./Launch\ app`.
2. Keep changes small and focused; match the surrounding style (plain ESM JavaScript, no build step).
3. Check syntax before opening a PR: `node --check server/index.mjs && node --check web/app.js && bash -n install.sh`.
4. Describe what you changed and how you tried it. Screenshots help for UI changes.

Never commit API keys, `memory/`, downloaded models or `harness/` (they are git-ignored). New third-party code needs a license entry in `CREDITS.md`.
