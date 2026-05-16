# Design Doc: `/piper-tts` Pi Extension

## Summary

Add a Pi coding agent extension that registers the `/piper-tts` slash command. The command will read the latest finalized assistant message from the current session branch, extract its spoken text, and send it to the configured local TTS backend for playback.

The goal is a lightweight, local-only helper for hearing the AI's last answer aloud without altering the conversation state.

## Goals

- Provide a `/tts` command in Pi.
- Speak the latest assistant output from the active session branch.
- Keep the implementation local and offline after dependencies are installed.
- Avoid mutating session history or generating additional agent turns.
- Fail gracefully when no assistant message exists, text is empty, or the selected TTS backend is unavailable.

## Non-goals

- No model-generated paraphrasing or summarization before speech.
- No automatic speech on every assistant message in v1.
- No remote TTS service.
- No custom audio UI beyond basic notifications.
- No editing of the session transcript.

## Relevant Pi APIs and behavior

This feature is a Pi extension, so it should use the standard extension APIs:

- `pi.registerCommand("tts", ...)` to register the slash command.
- `ctx.waitForIdle()` to ensure the current assistant turn has fully finished before speaking.
- `ctx.sessionManager.getBranch()` to read the current active session path.
- `ctx.ui.notify()` to report success or failure.
- `pi.exec()` to invoke the selected TTS backend as a subprocess.

Important session semantics:

- `ctx.sessionManager.getBranch()` returns the entries from root to the current leaf on the active branch.
- Session entries include all message types, model changes, compaction entries, custom entries, and labels.
- Assistant messages are stored as `message` entries with `message.role === "assistant"`.
- The latest assistant output can be found by scanning the branch from end to start and selecting the last assistant message.

Relevant Pi docs:

- Extensions: `packages/coding-agent/docs/extensions.md`
- Session format: `packages/coding-agent/docs/session-format.md`
- SessionManager source: `packages/coding-agent/src/core/session-manager.ts`

## TTS backend integration

Piper CLI usage from the Piper docs:

- Install: `pip install piper-tts`
- Download voices: `python3 -m piper.download_voices <VOICE>`
- Speak text directly: `python3 -m piper -m <VOICE> -- 'This will play on your speakers.'`
- If `ffplay` is installed, omitting `-f` plays audio immediately.

The Piper docs also note that the CLI is slow for repeated use because it reloads the model each time; that is acceptable for a command invoked manually by the user.

Relevant Piper docs:

- `OHF-Voice/piper1-gpl/docs/CLI.md`
- `OHF-Voice/piper1-gpl/README.md`

## Proposed user experience

### Command behavior

`/tts` will:

1. Wait until Pi is idle.
2. Find the most recent assistant message in the current branch.
3. Extract text from the assistant message.
4. Normalize the text for speech.
5. Invoke Piper to play the audio locally.
6. Notify the user when playback starts or when an error occurs.

### Suggested command syntax for v1

Keep v1 intentionally simple:

- `/tts` — speak the latest assistant message.

Future extensions could add optional arguments such as:

- `/tts latest` / `/tts current`
- `/tts --voice <voice>`
- `/tts --max-chars <n>`
- `/tts --stop` to cancel playback

## Text selection rules

The command should speak only assistant text, not tool calls or thinking blocks.

### Extraction logic

Given the latest assistant message:

- If `message.content` is a string, use it as-is.
- If `message.content` is an array, keep only `TextContent` blocks.
- Ignore `ThinkingContent` and `ToolCall` blocks.
- Join text blocks with spaces or newlines, then collapse repeated whitespace.

### Normalization

For v1, keep the normalization light:

- collapse whitespace
- trim leading/trailing whitespace
- optionally remove obvious markdown-only noise later if needed

This keeps implementation small and avoids accidentally changing meaning.

## Piper execution plan

### Preferred approach

Use `python3 -m piper` with the configured voice/model and let Piper handle playback directly when possible.

Example shape:

```bash
python3 -m piper -m <VOICE_OR_MODEL> -- "spoken text"
```

### Why this approach

- It avoids managing temp audio files in the extension.
- It stays close to Piper's documented CLI flow.
- It keeps the extension simple and local.

### Fallback strategy

If direct playback is unavailable or unreliable on a platform, a later iteration can:

- generate a temp WAV file with `-f`
- use a platform-specific audio player or `ffplay`
- clean up the temp file after playback

That fallback should be treated as a v2 improvement unless direct playback proves too brittle.

## Configuration proposal

Use environment variables for the first version. This avoids designing a new settings UI before the feature is proven.

Suggested config surface:

  - `PI_TTS_MODEL` — required Piper voice/model identifier or path passed to `-m`
  - `PI_TTS_DATA_DIR` — optional Piper `--data-dir`
  - `PI_TTS_BIN` — optional renderer command override
  - `PI_TTS_EXTRA_ARGS` — optional extra CLI args for advanced users
  - `PI_TTS_MAX_CHARS` — optional safety cap to keep very long answers from producing huge audio

The extension should validate configuration on startup or on first use and show a clear error if the model is missing.

## Error handling

The command should handle these cases cleanly:

- **No assistant message found**
  - Notify: `No assistant message to speak yet.`

- **Latest assistant message has no text**
  - Notify: `Latest assistant message contains no spoken text.`

- **Piper missing**
  - Notify with install instructions: `pip install piper-tts`

- **Voice/model missing**
  - Notify with a hint to download or configure the voice model

- **Playback failure**
  - Show the subprocess error and preserve the session

- **Very long output**
  - Either truncate with a warning or refuse above a configured limit

## Security and robustness

- Do not shell-escape a single command string.
- Use argument arrays when invoking the subprocess.
- Treat assistant text as untrusted input, even though it is local.
- Do not persist any extra session state unless later needed.

## Implementation sketch

Pseudo-flow:

```ts
pi.registerCommand("tts", {
  description: "Speak the latest assistant message",
  handler: async (_args, ctx) => {
    await ctx.waitForIdle();

    const branch = ctx.sessionManager.getBranch();
    const latestAssistant = [...branch].reverse().find(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    );

    if (!latestAssistant) {
      ctx.ui.notify("No assistant message to speak yet.", "warning");
      return;
    }

    const text = extractSpokenText(latestAssistant.message);
    if (!text) {
      ctx.ui.notify("Latest assistant message contains no spoken text.", "warning");
      return;
    }

    await pi.exec("python3", ["-m", "piper", "-m", model, "--", text], {
      signal: ctx.signal,
    });

    ctx.ui.notify("Spoken latest assistant message.", "info");
  },
});
```

## Alternatives considered

### 1. Automatic speech on every assistant message

Pros:

- Hands-free

Cons:

- Very noisy
- Hard to control during long coding sessions
- Needs more state and user preferences

### 2. Cache the latest assistant text on `message_end`

Pros:

- Fast command execution
- Avoids scanning session history each time

Cons:

- More state to manage
- Not necessary for the initial version

### 3. Use a background Piper server

Pros:

- Better performance for repeated speech

Cons:

- More setup
- More moving parts
- Not necessary for a first iteration

## Open questions

1. Should v1 speak the full assistant message or truncate long outputs by default?
2. Should the voice/model be configured via env vars only, or should we add a small JSON config file?
3. Should the command also accept an explicit message ID later, or stay latest-only for v1?
4. Is direct playback via Piper enough for the target platforms, or do we need a WAV-file fallback from day one?

## Recommendation

Ship v1 as a minimal latest-message speaker:

- one command: `/tts`
- read the last assistant message from the active branch
- extract text only
- invoke Piper locally
- notify on success or failure

That keeps the first implementation easy to validate while leaving room for richer playback controls later.

## References

Pi:

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts

Piper:

- https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md
- https://github.com/OHF-Voice/piper1-gpl/blob/main/README.md
