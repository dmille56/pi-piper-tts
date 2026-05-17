# pi-piper-tts

A Pi package that adds a `/piper-tts` slash command (and a `/tts` alias).

## What it does

`/piper-tts` speaks the latest assistant message from the current session branch using a local TTS backend.

By default it uses Piper; you can switch to Kokoro via configuration.

It:

- waits for Pi to finish the current turn
- scans the active branch for the most recent assistant message
- extracts only spoken text blocks
- normalizes whitespace
- calls the configured backend locally through `pi.exec()`

## Install

Install from npm:

```bash
pi install npm:@dmille56/pi-piper-tts
```

Or pin a version:

```bash
pi install npm:@dmille56/pi-piper-tts@0.1.0
```

Install from a local path while developing:

```bash
pi install /absolute/path/to/pi-piper-tts
```


## Requirements

- Pi with package support
- Python 3
- **Piper (piper-tts) installed locally** (default backend):

Up-to-date install/docs: https://github.com/OHF-Voice/piper1-gpl

```bash
pip install piper-tts
```

- **Kokoro (kokoro-tts) installed locally** (when using the Kokoro backend):

```bash
pip install kokoro-tts
```

- **ffplay installed** (from `ffmpeg`) and available on your `PATH`
- A Piper voice/model downloaded and available locally (when using Piper)

## Configuration

You can configure `/piper-tts` (and the `/tts` alias) using environment variables (highest priority) and/or Pi `settings.json`.

### Environment variables

Set these environment variables before launching Pi:

- `PI_TTS_BACKEND` — optional. `piper` (default) or `kokoro`
- `PI_TTS_MODEL` — required. Piper: voice/model identifier or path passed to `-m`. Kokoro: path to `kokoro-v1.0.onnx` (passed to Kokoro as `--model`)
- `PI_TTS_VOICES` — required when using Kokoro. Path to `voices-v1.0.bin` (passed to Kokoro as `--voices`)
- `PI_TTS_BIN` — optional. Overrides the renderer command (Piper or Kokoro). Default is backend-specific (`python3 -m piper` or `kokoro-tts`)
- `PI_TTS_DATA_DIR` — optional. Passed to Piper as `--data-dir` (Piper backend only)
- `PI_TTS_LANG` — optional. Passed to Kokoro as `--lang` (Kokoro backend only)
- `PI_TTS_VOICE` — optional. Passed to Kokoro as `--voice` (supports blending) (Kokoro backend only). Defaults to `af_sarah`.
- `PI_TTS_SPEED` — optional. Passed to Kokoro as `--speed` (Kokoro backend only)
- `PI_TTS_EXTRA_ARGS` — optional extra arguments appended to the backend command
- `PI_TTS_MAX_CHARS` — optional safety cap for long assistant messages (must be a positive integer)
- `PI_TTS_CHUNK_CHARS` — optional. Split long assistant messages into smaller chunks so speech starts earlier and `/piper-tts-stop` can cancel reliably mid-message. Must be a positive integer. Default: 200. Set to `0` (or negative) to disable chunking.
- `PI_TTS_VOLUME` — optional. Volume multiplier for `ffplay` playback. Must be between `0` and `1` (inclusive). `0` mutes; `1` is normal.
- `PI_TTS_AUTO_PLAY` — optional. When truthy, auto-plays TTS after the agent finishes a user-triggered run.

### Pi settings (`settings.json`)

Alternatively (or in addition), you can set configuration in `settings.json`.

Note: chunking happens after any global truncation from `PI_TTS_MAX_CHARS` / `max-chars` is applied.

Supported section/key names:

- `pi-tts` (preferred)

Legacy section/key/env names (PIPER_PI_*, KOKORO_PI_*, pi-piper-tts, piper-pi-*, kokoro-tts-*) still work but will log deprecation warnings.

Keys in `pi-tts`:

- `backend` — optional. `piper` (default) or `kokoro`
- `model` — required. Piper: voice/model identifier or path passed to `-m`. Kokoro: path to `kokoro-v1.0.onnx`
- `voices` — Kokoro only. Path to `voices-v1.0.bin`
- `bin` — optional. Overrides the renderer command (Piper or Kokoro)
- `data-dir` — optional. Piper only. Passed to Piper as `--data-dir`
- `lang` — Kokoro only. Passed to Kokoro as `--lang`
- `voice` — Kokoro only. Passed to Kokoro as `--voice` (supports blending). Defaults to `af_sarah`.
- `speed` — Kokoro only. Passed to Kokoro as `--speed`
- `extra-args` — optional. Extra arguments appended to the backend command
- `max-chars` — optional. Same as `PI_TTS_MAX_CHARS`
- `chunk-chars` — optional. Same as `PI_TTS_CHUNK_CHARS`
- `volume` — optional. Volume multiplier for `ffplay` playback. Must be between `0` and `1` (inclusive). `0` mutes; `1` is normal.
- `auto-play` — optional boolean. When true, auto-plays TTS after the agent finishes a user-triggered run.
- `enable-alias` — optional boolean (controls `/tts` alias). Same as `PI_TTS_ENABLE_ALIAS`.

Pi loads settings from:

- `~/.pi/agent/settings.json` (global)
- `<cwd>/.pi/settings.json` (project override, takes precedence)

Example `settings.json`:

```json
{
  "pi-tts": {
    "backend": "piper",
    "model": "/path/to/your/voice.onnx",
    "data-dir": "$HOME/.local/share/piper",
    "bin": "python3 -m piper",
    "extra-args": "--speaker 0",
    "max-chars": 8000
  }
}
```


### Quick environment-variable example

```bash
export PI_TTS_MODEL=/path/to/your/voice.onnx
export PI_TTS_DATA_DIR=$HOME/.local/share/piper
pi
```

If you want to override the command used to start Piper:

```bash
export PI_TTS_BIN="python3 -m piper"
```

You can also add extra arguments:

```bash
export PI_TTS_EXTRA_ARGS="--speaker 0"
```

## Usage

Once Pi is running, type one of:

```text
/piper-tts
```

or the convenience alias:

```text
/tts
```

Pi will speak the latest assistant message aloud.

### `/tts` alias (optional)

By default, this extension registers both commands:

- `/piper-tts` (primary)
- `/tts` (alias for `/piper-tts`)

If you want to disable the `/tts` alias (it will be *unregistered*):

**Environment variable (highest priority):**

```bash
export PI_TTS_ENABLE_ALIAS=0
```

**Pi `settings.json`** (global: `~/.pi/agent/settings.json`, or project: `<cwd>/.pi/settings.json`):

```json
{
  "pi-tts": {
    "enable-alias": false
  }
}

```

This is read when the extension loads; you may need to restart (or `/reload`) after changing it.

## Behavior

If something is wrong, the command will notify you and leave the session unchanged.

Common cases:

- no assistant message yet
- latest assistant message has no text
- Missing configured model/voices for the selected backend
- Selected backend is not installed (or `ffplay` is missing when using Piper)
- the configured voice/model cannot be loaded

## Publishing

This package is ready to publish to npm.

```bash
npm publish
```

## Notes

- The extension is implemented in TypeScript and does not require compilation.
- It uses argument arrays with `pi.exec()` and does not shell-escape a single command string.
- It is local-only after installation.
