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

## Testing And Verification

Before marking any task as done:

1. Run `npm run lint`
2. Fix all lint issues and re-run `npm run lint` until it exits with code 0
3. Run a TypeScript typecheck (`npm run typecheck`)
4. Run `npm run build` when changes affect extension runtime behavior or startup (note: in this repo `npm run build` is currently a no-op)
5. Confirm the relevant checks complete successfully

### Definition of Done

A task is only complete when:

- The requested code changes are implemented
- `npm run lint` passes
- TypeScript typecheck passes (`npm run typecheck`)
- Any required build/compile checks pass (e.g. `npm run build` when applicable)
- Any failing checks are fixed, or their blocker is explicitly reported
- Any relevant tests are added or updated when behavior changes (this repo currently has no test script)

#### Rules

- `npm run lint` is the required lint command. Do not substitute `npx xo`, `eslint`, or other lint commands unless explicitly asked.
- Run lint before typecheck.
- Do not mark a task complete until lint has passed and TypeScript typecheck has passed.
- If lint or typecheck cannot be run in this environment, explicitly say so and explain why.
- Add or update tests when behavior changes.