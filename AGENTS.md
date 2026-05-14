# AGENTS.md

- Repo is a single TypeScript Pi extension in `extensions/tts.ts`; `tsconfig.json` only includes `extensions/**/*.ts` and `extensions/**/*.d.ts`.
- Validate with `npm run typecheck`. `npm run build` is a no-op.
- There is no test script in `package.json`.
- `release` runs `npm run typecheck && npm version patch && npm publish --access public`.
- `prepublishOnly` currently runs `npm run check`, but no `check` script exists.
- Runtime config precedence in `extensions/tts.ts` is env vars first, then Pi settings from `~/.pi/agent/settings.json`, overridden by `<cwd>/.pi/settings.json`.
- The command refuses to run without `PIPER_PI_MODEL` or `pi-tts-command.piper-pi-model`, and it also checks that the model file and sibling `.json` exist.
- The extension speaks only the latest assistant message on the current branch, collapses whitespace, and truncates when `PIPER_PI_MAX_CHARS` is set.
- `PIPER_PI_BIN` can be a command plus args; it is parsed as a command line, not treated as one opaque string.
- If you use the Nix shell, it sets `PI_CODING_AGENT_DIR=$PWD/.pi-agent`; `pi-vanilla` is the wrapper that unsets it.
