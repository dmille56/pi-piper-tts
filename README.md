# pi-piper-tts

A Pi package that adds a `/piper-tts` slash command (and a `/tts` alias).

## What it does

`/piper-tts` speaks the latest assistant message from the current session branch using local Piper TTS.

It:

- waits for Pi to finish the current turn
- scans the active branch for the most recent assistant message
- extracts only spoken text blocks
- normalizes whitespace
- calls Piper locally through `pi.exec()`

## Install

Install from a local path while developing:

```bash
pi install /absolute/path/to/pi-piper-tts
```

Once published to npm, install it like this:

```bash
pi install npm:pi-piper-tts
```

Or pin a version:

```bash
pi install npm:pi-piper-tts@0.1.0
```

## Requirements

- Pi with package support
- Python 3
- **Piper (piper-tts) installed locally**:

```bash
pip install piper-tts
```

- **ffplay installed** (from `ffmpeg`) and available on your `PATH`
- A Piper voice/model downloaded and available locally

## Configuration

You can configure `/piper-tts` (and the `/tts` alias) using environment variables (highest priority) and/or Pi `settings.json`.

### Environment variables

Set these environment variables before launching Pi:

- `PIPER_PI_MODEL` — required. Piper voice/model identifier or path passed to `-m`
- `PIPER_PI_BIN` — optional. Overrides the Piper command. Default is `python3 -m piper`
- `PIPER_PI_DATA_DIR` — optional. Passed to Piper as `--data-dir`
- `PIPER_PI_EXTRA_ARGS` — optional extra arguments appended to the Piper command
- `PIPER_PI_MAX_CHARS` — optional safety cap for long assistant messages (must be a positive integer)

### Pi settings (`settings.json`)

Alternatively (or in addition), you can set configuration in `settings.json`.

Supported section/key names:

- `pi-piper-tts` (preferred)
- `pi-tts-command` (legacy alias)
- `tts`
- `piper`

Keys in that section:

- `piper-pi-model` — required (same value as `PIPER_PI_MODEL`)
- `piper-pi-bin` — same as `PIPER_PI_BIN`
- `piper-pi-data-dir` — same as `PIPER_PI_DATA_DIR`
- `piper-pi-extra-args` — same as `PIPER_PI_EXTRA_ARGS`
- `piper-pi-max-chars` — same as `PIPER_PI_MAX_CHARS`

Pi loads settings from:

- `~/.pi/agent/settings.json` (global)
- `<cwd>/.pi/settings.json` (project override, takes precedence)

Example `settings.json`:

```json
{
  "pi-piper-tts": {
    "piper-pi-model": "/path/to/your/voice.onnx",
    "piper-pi-data-dir": "$HOME/.local/share/piper",
    "piper-pi-bin": "python3 -m piper",
    "piper-pi-extra-args": "--speaker 0",
    "piper-pi-max-chars": 8000
  }
}
```


### Quick environment-variable example

```bash
export PIPER_PI_MODEL=/path/to/your/voice.onnx
export PIPER_PI_DATA_DIR=$HOME/.local/share/piper
pi
```

If you want to override the command used to start Piper:

```bash
export PIPER_PI_BIN="python3 -m piper"
```

You can also add extra arguments:

```bash
export PIPER_PI_EXTRA_ARGS="--speaker 0"
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
export PIPER_PI_ENABLE_TTS_ALIAS=0
```

**Pi `settings.json`** (global: `~/.pi/agent/settings.json`, or project: `<cwd>/.pi/settings.json`):

```json
{
  "pi-piper-tts": {
    "enable-tts-alias": false
  }
}

This is read when the extension loads; you may need to restart (or `/reload`) after changing it.
```

## Behavior

If something is wrong, the command will notify you and leave the session unchanged.

Common cases:

- no assistant message yet
- latest assistant message has no text
- `PIPER_PI_MODEL` is missing
- Piper is not installed (or `ffplay` is missing)
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
