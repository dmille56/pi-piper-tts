import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

type SessionEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

type ContentBlock = {
  type?: string;
  text?: string;
};

type PiperConfig = {
  command: string;
  args: string[];
  model: string;
  dataDir?: string;
  extraArgs: string[];
  maxChars?: number;
  chunkChars?: number;
};

type KokoroConfig = {
  command: string;
  args: string[];
  modelPath: string;
  voicesPath: string;
  lang?: string;
  voice?: string;
  speed?: number;
  extraArgs: string[];
  maxChars?: number;
  chunkChars?: number;
};

type TtsBackend = 'piper' | 'kokoro';

type TtsConfig =
  | ({backend: 'piper'} & PiperConfig)
  | ({backend: 'kokoro'} & KokoroConfig)
  | {error: string};

const defaultPiperCommand = 'python3';
const defaultPiperCommandArgs = ['-m', 'piper'];

// Module-scope so `/piper-tts-stop` can cancel the currently running playback.
let activePlaybackController: AbortController | undefined;

// One-time deprecation warnings for legacy config/env names.
let didWarnDeprecatedConfig = false;

function notify(
  ctx: ExtensionContext,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const ch of value.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }

      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }

      continue;
    }

    current += ch;
  }

  if (escaped) {
    current += '\\';
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function expandPath(value: string, baseDir: string): string {
  const v = value.trim();
  if (v === '~') return homedir();
  if (v.startsWith('~/')) return join(homedir(), v.slice(2));

  // If it looks like an absolute path (POSIX) or a Windows drive path, keep as-is.
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) return v;

  // Resolve other relative paths against the directory containing the settings.
  if (v.startsWith('./') || v.startsWith('../') || v.startsWith('.')) {
    return join(baseDir, v);
  }

  if (!v.includes('/') && !v.includes('\\')) {
    // Bare filename: treat it as relative to baseDir (matches kokoro/piper CLIs).
    return join(baseDir, v);
  }

  return join(baseDir, v);
}

function looksLikePath(value: string): boolean {
  // If it resembles a filesystem path, we can validate with existsSync.
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('/') ||
    value.endsWith('.onnx')
  );
}

function loadPiSettingsFile(path: string): unknown {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecordUnknown(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordUnknown(value: unknown): Record<string, unknown> {
  return isRecordUnknown(value) ? value : {};
}

function getPiSettings(ctx: ExtensionContext): Record<string, unknown> {
  const globalPath = join(homedir(), '.pi', 'agent', 'settings.json');

  let cwd = process.cwd();
  if (typeof ctx === 'object' && ctx !== null && 'cwd' in ctx) {
    const raw = (ctx as {cwd?: unknown}).cwd;
    if (typeof raw === 'string' && raw) cwd = raw;
  }

  const projectPath = join(cwd, '.pi', 'settings.json');

  const globalSettings = asRecordUnknown(loadPiSettingsFile(globalPath));
  const projectSettings = asRecordUnknown(loadPiSettingsFile(projectPath));

  // Project overrides global
  return {...globalSettings, ...projectSettings};
}

type LoadedTtsSettings = {
  section: Record<string, unknown>;
  legacySection?: string;
};

function loadTtsSettingsSection(s: Record<string, unknown>): LoadedTtsSettings {
  const canonical = s['pi-tts'];
  if (isRecordUnknown(canonical)) {
    return {section: canonical};
  }

  // Legacy section names (pre-unification).
  const candidates: Array<[string, unknown]> = [
    ['pi-piper-tts', s['pi-piper-tts']],
    ['pi-tts-command', s['pi-tts-command']],
    ['tts', s.tts],
    ['piper', s.piper],
  ];
  for (const [name, c] of candidates) {
    if (isRecordUnknown(c)) {
      return {section: c, legacySection: name};
    }
  }

  return {section: {}};
}

function getSettingsSection(
  s: Record<string, unknown>,
): Record<string, unknown> {
  return loadTtsSettingsSection(s).section;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on': {
      return true;
    }

    case '0':
    case 'false':
    case 'no':
    case 'off': {
      return false;
    }

    default: {
      return undefined;
    }
  }
}

function isTtsAliasEnabledFromSettings(
  section: Record<string, unknown>,
): boolean {
  const raw =
    section['enable-alias'] ??
    section.enableAlias ??
    section['enable-tts-alias'] ??
    section.enableTtsAlias;
  const parsed = parseOptionalBoolean(raw);
  return parsed ?? true;
}

function isTtsAliasEnabledAtLoad(): boolean {
  // Default ON for backward compatibility.
  const envRaw = process.env.PI_TTS_ENABLE_ALIAS?.trim();
  const legacyEnvRaw = process.env.PIPER_PI_ENABLE_TTS_ALIAS?.trim();
  const raw = envRaw ?? legacyEnvRaw;
  if (raw) {
    const parsed = parseOptionalBoolean(raw);
    if (parsed !== undefined) return parsed;
    return true;
  }

  const globalPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const projectPath = join(process.cwd(), '.pi', 'settings.json');
  const globalSettings = asRecordUnknown(loadPiSettingsFile(globalPath));
  const projectSettings = asRecordUnknown(loadPiSettingsFile(projectPath));
  const settings = {...globalSettings, ...projectSettings};
  const {section} = loadTtsSettingsSection(settings);
  return isTtsAliasEnabledFromSettings(section);
}

function isAutoPlayEnabledFromSettings(
  section: Record<string, unknown>,
): boolean {
  // Key name: `auto-play`.
  const raw = section['auto-play'] ?? section.autoPlay;
  const parsed = parseOptionalBoolean(raw);
  return parsed ?? false;
}

function isAutoPlayEnabledAtLoad(): boolean {
  const envRaw = process.env.PI_TTS_AUTO_PLAY?.trim();
  const legacyEnvRaw = process.env.PIPER_PI_AUTO_PLAY?.trim();
  const raw = envRaw ?? legacyEnvRaw;
  if (raw) {
    const parsed = parseOptionalBoolean(raw);
    return parsed ?? false;
  }

  const globalPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const projectPath = join(process.cwd(), '.pi', 'settings.json');
  const globalSettings = asRecordUnknown(loadPiSettingsFile(globalPath));
  const projectSettings = asRecordUnknown(loadPiSettingsFile(projectPath));
  const settings = {...globalSettings, ...projectSettings};
  const {section} = loadTtsSettingsSection(settings);
  return isAutoPlayEnabledFromSettings(section);
}

function getConfig(ctx: ExtensionContext): TtsConfig {
  const settings = getPiSettings(ctx);
  const {section, legacySection} = loadTtsSettingsSection(settings);

  // Resolve relative paths against the directory that contains the project's
  // `.pi/settings.json` (or `process.cwd()` if no `ctx.cwd` was provided).
  let baseDir = process.cwd();
  if (typeof ctx === 'object' && ctx !== null && 'cwd' in ctx) {
    const raw = (ctx as {cwd?: unknown}).cwd;
    if (typeof raw === 'string' && raw) baseDir = raw;
  }

  const warnings: string[] = [];
  const pushWarning = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const envTrim = (name: string): string | undefined => {
    const raw = process.env[name];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed || undefined;
  };

  const sectionTrim = (key: string): string | undefined => {
    const raw = section[key];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed || undefined;
  };

  // Deprecation warnings (one-time per extension load).
  if (legacySection) {
    pushWarning(
      `Deprecated TTS settings section used: ${legacySection}. Use settings.json section 'pi-tts' instead.`,
    );
  }

  const maybeWarnOnce = () => {
    if (didWarnDeprecatedConfig) return;
    if (warnings.length === 0) return;

    didWarnDeprecatedConfig = true;
    for (const w of warnings) {
      notify(ctx, w, 'warning');
      if (!ctx.hasUI) console.warn(w);
    }
  };

  const legacyAliasEnv = envTrim('PIPER_PI_ENABLE_TTS_ALIAS');
  const canonicalAliasEnv = envTrim('PI_TTS_ENABLE_ALIAS');
  if (!canonicalAliasEnv && legacyAliasEnv) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_ENABLE_TTS_ALIAS. Use PI_TTS_ENABLE_ALIAS instead.',
    );
  }

  const legacyAutoPlayEnv = envTrim('PIPER_PI_AUTO_PLAY');
  const canonicalAutoPlayEnv = envTrim('PI_TTS_AUTO_PLAY');
  if (!canonicalAutoPlayEnv && legacyAutoPlayEnv) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_AUTO_PLAY. Use PI_TTS_AUTO_PLAY instead.',
    );
  }

  // Backend selection
  const backendEnvCanonical = envTrim('PI_TTS_BACKEND');
  const backendEnvLegacy = envTrim('PIPER_PI_TTS_BACKEND');
  const backendFromCanonicalSettings = sectionTrim('backend');
  const backendFromLegacySettings =
    sectionTrim('tts-backend') ?? sectionTrim('ttsBackend');

  let backend: TtsBackend = 'piper';
  if (backendEnvCanonical) {
    backend =
      backendEnvCanonical.toLowerCase() === 'kokoro' ? 'kokoro' : 'piper';
  } else if (backendFromCanonicalSettings) {
    backend =
      backendFromCanonicalSettings.toLowerCase() === 'kokoro'
        ? 'kokoro'
        : 'piper';
  } else if (backendFromLegacySettings) {
    pushWarning(
      'Deprecated TTS settings key used for backend: tts-backend. Use settings.json key "backend" under "pi-tts" instead.',
    );
    backend =
      backendFromLegacySettings.toLowerCase() === 'kokoro' ? 'kokoro' : 'piper';
  } else if (backendEnvLegacy) {
    pushWarning(
      'Deprecated TTS env var used for backend: PIPER_PI_TTS_BACKEND. Use PI_TTS_BACKEND instead.',
    );
    backend = backendEnvLegacy.toLowerCase() === 'kokoro' ? 'kokoro' : 'piper';
  }

  // maxChars
  const defaultChunkChars = 200;
  const maxCharsEnvCanonical = envTrim('PI_TTS_MAX_CHARS');
  const maxCharsEnvLegacy = envTrim('PIPER_PI_MAX_CHARS');
  const maxCharsFromCanonicalSettings = sectionTrim('max-chars');
  const maxCharsFromLegacySettings = sectionTrim('piper-pi-max-chars');

  const maxCharsRaw =
    maxCharsEnvCanonical ??
    maxCharsFromCanonicalSettings ??
    (maxCharsEnvLegacy
      ? (() => {
          pushWarning(
            'Deprecated TTS env var used: PIPER_PI_MAX_CHARS. Use PI_TTS_MAX_CHARS instead.',
          );
          return maxCharsEnvLegacy;
        })()
      : undefined) ??
    (maxCharsFromLegacySettings
      ? (() => {
          pushWarning(
            'Deprecated TTS settings key used: piper-pi-max-chars. Use settings.json key "max-chars" under "pi-tts" instead.',
          );
          return maxCharsFromLegacySettings;
        })()
      : undefined) ??
    undefined;

  const maxCharsParsed = maxCharsRaw
    ? Number.parseInt(maxCharsRaw, 10)
    : undefined;
  const maxChars =
    maxCharsParsed !== undefined &&
    Number.isFinite(maxCharsParsed) &&
    maxCharsParsed > 0
      ? maxCharsParsed
      : undefined;

  if (maxCharsRaw && maxChars === undefined) {
    maybeWarnOnce();
    return {error: 'PI_TTS_MAX_CHARS must be a positive integer.'};
  }

  // chunkChars
  const chunkCharsEnvCanonical = envTrim('PI_TTS_CHUNK_CHARS');
  const chunkCharsEnvLegacy = envTrim('PIPER_PI_CHUNK_CHARS');
  const chunkCharsFromCanonicalSettings = sectionTrim('chunk-chars');
  const chunkCharsFromLegacySettings = sectionTrim('piper-pi-chunk-chars');

  const chunkCharsRaw =
    chunkCharsEnvCanonical ??
    chunkCharsFromCanonicalSettings ??
    (chunkCharsEnvLegacy
      ? (() => {
          pushWarning(
            'Deprecated TTS env var used: PIPER_PI_CHUNK_CHARS. Use PI_TTS_CHUNK_CHARS instead.',
          );
          return chunkCharsEnvLegacy;
        })()
      : undefined) ??
    (chunkCharsFromLegacySettings
      ? (() => {
          pushWarning(
            'Deprecated TTS settings key used: piper-pi-chunk-chars. Use settings.json key "chunk-chars" under "pi-tts" instead.',
          );
          return chunkCharsFromLegacySettings;
        })()
      : undefined) ??
    '';

  const chunkCharsParsed = chunkCharsRaw
    ? Number.parseInt(chunkCharsRaw, 10)
    : undefined;

  const chunkChars =
    chunkCharsRaw &&
    chunkCharsParsed !== undefined &&
    Number.isFinite(chunkCharsParsed)
      ? chunkCharsParsed > 0
        ? chunkCharsParsed
        : undefined // non-positive disables
      : // If user explicitly provided a value but it was invalid/non-numeric,
        // treat it as disabled instead of failing.
        chunkCharsRaw
        ? undefined
        : defaultChunkChars;

  // Renderer bin/args
  const parseBin = (
    binSpec: string,
  ): {command: string; args: string[]} | {error: string} => {
    const binParts = parseCommandLine(binSpec);
    if (binParts.length === 0) return {error: 'TTS bin spec is empty.'};
    const command = binParts[0];
    const runnerArgs = binParts.length > 1 ? binParts.slice(1) : [];
    return {command, args: runnerArgs};
  };

  if (backend === 'kokoro') {
    const binSpec =
      envTrim('PI_TTS_BIN') ??
      sectionTrim('bin') ??
      envTrim('KOKORO_PI_BIN') ??
      sectionTrim('kokoro-tts-bin') ??
      'kokoro-tts';

    if (
      binSpec === envTrim('KOKORO_PI_BIN') &&
      envTrim('PI_TTS_BIN') === undefined
    ) {
      pushWarning(
        'Deprecated TTS env var used: KOKORO_PI_BIN. Use PI_TTS_BIN instead.',
      );
    }

    if (
      binSpec === sectionTrim('kokoro-tts-bin') &&
      envTrim('PI_TTS_BIN') === undefined &&
      sectionTrim('bin') === undefined
    ) {
      pushWarning(
        'Deprecated TTS settings key used: kokoro-tts-bin. Use settings.json key "bin" under "pi-tts" instead.',
      );
    }

    const binResolved = parseBin(binSpec);
    if ('error' in binResolved) {
      maybeWarnOnce();
      return {error: binResolved.error};
    }

    const modelRaw =
      envTrim('PI_TTS_MODEL') ??
      sectionTrim('model') ??
      envTrim('KOKORO_PI_MODEL') ??
      sectionTrim('kokoro-tts-model') ??
      '';
    if (
      modelRaw === envTrim('KOKORO_PI_MODEL') &&
      envTrim('PI_TTS_MODEL') === undefined &&
      sectionTrim('model') === undefined
    ) {
      pushWarning(
        'Deprecated TTS env var used: KOKORO_PI_MODEL. Use PI_TTS_MODEL instead.',
      );
    }

    if (
      modelRaw === sectionTrim('kokoro-tts-model') &&
      envTrim('PI_TTS_MODEL') === undefined &&
      sectionTrim('model') === undefined
    ) {
      pushWarning(
        'Deprecated TTS settings key used: kokoro-tts-model. Use settings.json key "model" under "pi-tts" instead.',
      );
    }

    const voicesRaw =
      envTrim('PI_TTS_VOICES') ??
      sectionTrim('voices') ??
      envTrim('KOKORO_PI_VOICES') ??
      sectionTrim('kokoro-tts-voices') ??
      '';
    if (
      voicesRaw === envTrim('KOKORO_PI_VOICES') &&
      envTrim('PI_TTS_VOICES') === undefined &&
      sectionTrim('voices') === undefined
    ) {
      pushWarning(
        'Deprecated TTS env var used: KOKORO_PI_VOICES. Use PI_TTS_VOICES instead.',
      );
    }

    if (
      voicesRaw === sectionTrim('kokoro-tts-voices') &&
      envTrim('PI_TTS_VOICES') === undefined &&
      sectionTrim('voices') === undefined
    ) {
      pushWarning(
        'Deprecated TTS settings key used: kokoro-tts-voices. Use settings.json key "voices" under "pi-tts" instead.',
      );
    }

    const modelPath = modelRaw ? expandPath(modelRaw, baseDir) : '';
    const voicesPath = voicesRaw ? expandPath(voicesRaw, baseDir) : '';
    if (!modelPath) {
      maybeWarnOnce();
      return {
        error:
          'Missing Kokoro model. Set PI_TTS_MODEL (env) or settings.json "model" under "pi-tts".',
      };
    }

    if (!voicesPath) {
      maybeWarnOnce();
      return {
        error:
          'Missing Kokoro voices file. Set PI_TTS_VOICES (env) or settings.json "voices" under "pi-tts".',
      };
    }

    const envLang = envTrim('PI_TTS_LANG');
    const lang =
      envLang ??
      sectionTrim('lang') ??
      envTrim('KOKORO_PI_LANG') ??
      sectionTrim('kokoro-tts-lang');
    if (!envLang && lang === envTrim('KOKORO_PI_LANG')) {
      pushWarning(
        'Deprecated TTS env var used: KOKORO_PI_LANG. Use PI_TTS_LANG instead.',
      );
    }

    const envVoice = envTrim('PI_TTS_VOICE');
    const voice =
      envVoice ??
      sectionTrim('voice') ??
      envTrim('KOKORO_PI_VOICE') ??
      sectionTrim('kokoro-tts-voice');
    if (!envVoice && voice === envTrim('KOKORO_PI_VOICE')) {
      pushWarning(
        'Deprecated TTS env var used: KOKORO_PI_VOICE. Use PI_TTS_VOICE instead.',
      );
    }

    const speedRaw =
      envTrim('PI_TTS_SPEED') ??
      sectionTrim('speed') ??
      envTrim('KOKORO_PI_SPEED') ??
      sectionTrim('kokoro-tts-speed') ??
      '';
    const speedParsed = speedRaw ? Number.parseFloat(speedRaw) : undefined;
    const speed =
      speedParsed !== undefined &&
      Number.isFinite(speedParsed) &&
      speedParsed > 0
        ? speedParsed
        : speedRaw
          ? undefined
          : undefined;
    if (speedRaw && speed === undefined) {
      maybeWarnOnce();
      return {error: 'PI_TTS_SPEED must be a positive number.'};
    }

    const extraArgs: string[] = [];
    const extraEnv = envTrim('PI_TTS_EXTRA_ARGS');
    const extraFromSection = sectionTrim('extra-args');
    const extraLegacyEnv = envTrim('KOKORO_PI_EXTRA_ARGS');
    const extraLegacySection = sectionTrim('kokoro-tts-extra-args');
    const extraSpec =
      extraEnv ??
      extraFromSection ??
      extraLegacyEnv ??
      extraLegacySection ??
      '';
    if (extraSpec) {
      if (!extraEnv && !extraFromSection && extraLegacyEnv) {
        pushWarning(
          'Deprecated TTS env var used: KOKORO_PI_EXTRA_ARGS. Use PI_TTS_EXTRA_ARGS instead.',
        );
      }

      if (
        !extraEnv &&
        !extraFromSection &&
        !extraLegacyEnv &&
        extraLegacySection
      ) {
        pushWarning(
          'Deprecated TTS settings key used: kokoro-tts-extra-args. Use settings.json key "extra-args" under "pi-tts" instead.',
        );
      }

      extraArgs.push(...parseCommandLine(extraSpec));
    }

    maybeWarnOnce();

    return {
      backend: 'kokoro',
      command: binResolved.command,
      args: binResolved.args,
      modelPath,
      voicesPath,
      lang,
      voice,
      speed,
      extraArgs,
      maxChars,
      chunkChars,
    };
  }

  // Piper backend
  const binSpec =
    envTrim('PI_TTS_BIN') ??
    sectionTrim('bin') ??
    envTrim('PIPER_PI_BIN') ??
    sectionTrim('piper-pi-bin') ??
    defaultPiperCommand;

  if (
    binSpec === envTrim('PIPER_PI_BIN') &&
    envTrim('PI_TTS_BIN') === undefined
  ) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_BIN. Use PI_TTS_BIN instead.',
    );
  }

  if (
    binSpec === sectionTrim('piper-pi-bin') &&
    envTrim('PI_TTS_BIN') === undefined &&
    sectionTrim('bin') === undefined
  ) {
    pushWarning(
      'Deprecated TTS settings key used: piper-pi-bin. Use settings.json key "bin" under "pi-tts" instead.',
    );
  }

  const binResolved = parseBin(binSpec);
  if ('error' in binResolved) {
    maybeWarnOnce();
    return {error: binResolved.error};
  }

  const modelRaw =
    envTrim('PI_TTS_MODEL') ??
    sectionTrim('model') ??
    envTrim('PIPER_PI_MODEL') ??
    sectionTrim('piper-pi-model') ??
    '';
  if (
    modelRaw === envTrim('PIPER_PI_MODEL') &&
    envTrim('PI_TTS_MODEL') === undefined &&
    sectionTrim('model') === undefined
  ) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_MODEL. Use PI_TTS_MODEL instead.',
    );
  }

  const model = modelRaw ? expandPath(modelRaw, baseDir) : '';
  if (!model) {
    maybeWarnOnce();
    return {
      error:
        'Missing Piper model. Set PI_TTS_MODEL (env) or settings.json "model" under "pi-tts".',
    };
  }

  const dataDirRaw =
    envTrim('PI_TTS_DATA_DIR') ??
    sectionTrim('data-dir') ??
    envTrim('PIPER_PI_DATA_DIR') ??
    sectionTrim('piper-pi-data-dir') ??
    '';
  if (
    dataDirRaw === envTrim('PIPER_PI_DATA_DIR') &&
    envTrim('PI_TTS_DATA_DIR') === undefined &&
    sectionTrim('data-dir') === undefined
  ) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_DATA_DIR. Use PI_TTS_DATA_DIR instead.',
    );
  }

  const dataDir = dataDirRaw ? expandPath(dataDirRaw, baseDir) : undefined;

  const extraEnv = envTrim('PI_TTS_EXTRA_ARGS');
  const extraFromSection = sectionTrim('extra-args');
  const extraLegacyEnv = envTrim('PIPER_PI_EXTRA_ARGS');
  const extraLegacySection = sectionTrim('piper-pi-extra-args');
  const extraSpec =
    extraEnv ?? extraFromSection ?? extraLegacyEnv ?? extraLegacySection ?? '';

  if (extraSpec && !extraEnv && !extraFromSection && extraLegacyEnv) {
    pushWarning(
      'Deprecated TTS env var used: PIPER_PI_EXTRA_ARGS. Use PI_TTS_EXTRA_ARGS instead.',
    );
  }

  if (
    extraSpec &&
    !extraEnv &&
    !extraFromSection &&
    !extraLegacyEnv &&
    extraLegacySection
  ) {
    pushWarning(
      'Deprecated TTS settings key used: piper-pi-extra-args. Use settings.json key "extra-args" under "pi-tts" instead.',
    );
  }

  const extraArgs = extraSpec ? parseCommandLine(extraSpec) : [];

  // Back-compat: if runner was only the python command, use the old default args.
  if (
    binResolved.command === defaultPiperCommand &&
    binResolved.args.length === 0
  ) {
    binResolved.args.push(...defaultPiperCommandArgs);
  }

  maybeWarnOnce();

  return {
    backend: 'piper',
    command: binResolved.command,
    args: binResolved.args,
    model,
    dataDir,
    extraArgs,
    maxChars,
    chunkChars,
  };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    /\baborted\b/i.test(error.message) ||
    /\babort\b/i.test(error.message)
  );
}

function splitSpeechIntoChunks(text: string, chunkChars: number): string[] {
  if (!text) return [];
  if (!Number.isFinite(chunkChars) || chunkChars <= 0) return [text];

  // 1) Break into sentence-ish units.
  const units: string[] = [];
  let current = '';

  const isSentenceEnd = (ch: string) => ch === '.' || ch === '!' || ch === '?';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\n' || ch === '\r') {
      const trimmed = current.trim();
      if (trimmed) units.push(trimmed);
      current = '';
      continue;
    }

    current += ch;

    if (isSentenceEnd(ch)) {
      // Include consecutive punctuation (e.g. "..." or "!!!").
      let j = i + 1;
      while (j < text.length && isSentenceEnd(text[j])) {
        current += text[j];
        j++;
      }

      i = j - 1;

      const trimmed = current.trim();
      if (trimmed) units.push(trimmed);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) units.push(tail);

  if (units.length === 0) return [text];

  // 2) Pack units into <= chunkChars chunks.
  const chunks: string[] = [];
  let chunk = '';

  const flushChunk = () => {
    const trimmed = chunk.trim();
    if (trimmed) chunks.push(trimmed);
    chunk = '';
  };

  const hardSplit = (s: string): string[] => {
    if (s.length <= chunkChars) return [s];
    const segs: string[] = [];
    for (let i = 0; i < s.length; i += chunkChars) {
      segs.push(s.slice(i, i + chunkChars));
    }

    return segs;
  };

  for (const unit of units) {
    if (!unit) continue;

    if (unit.length <= chunkChars) {
      if (!chunk) {
        chunk = unit;
        continue;
      }

      if (chunk.length + 1 + unit.length <= chunkChars) {
        chunk = `${chunk} ${unit}`;
        continue;
      }

      flushChunk();
      chunk = unit;
      continue;
    }

    // Unit is too large: split by spaces first, then hard-split long words.
    const words = unit.split(/\s+/g).filter(Boolean);
    for (const word of words) {
      const segments = hardSplit(word);
      for (const [si, seg] of segments.entries()) {
        const joiner = chunk.length === 0 ? '' : si === 0 ? ' ' : '';

        if (!chunk) {
          chunk = seg;
          continue;
        }

        if (chunk.length + joiner.length + seg.length <= chunkChars) {
          chunk = `${chunk}${joiner}${seg}`;
        } else {
          flushChunk();
          chunk = seg;
        }
      }
    }
  }

  flushChunk();
  return chunks.length > 0 ? chunks : [text];
}

type HandledTtsError = Error & {handled: true};

function isHandledTtsError(error: unknown): error is HandledTtsError {
  if (!(error instanceof Error)) return false;

  const handled: unknown = Reflect.get(error, 'handled');
  return handled === true;
}

function debugEnabled(): boolean {
  return process.env.PIPER_PI_TTS_DEBUG === '1';
}

function debugNotify(
  ctx: ExtensionContext,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
) {
  if (!debugEnabled()) return;
  if (ctx.hasUI) notify(ctx, message, level);
  else console.log(message);
}

export function removeStreamFlagFromArgs(args: string[]): string[] {
  return args.filter((a) => {
    if (a === '--stream') return false;
    if (a.startsWith('--stream=')) return false;
    return true;
  });
}

type KokoroRenderStrategy = 'save-no-play' | 'save' | 'positional-output';

type KokoroRenderSupport =
  | {supported: false; reason: string; helpSnippet?: string}
  | {
      supported: true;
      strategy: KokoroRenderStrategy;
      helpSnippet?: string;
    };

const kokoroRenderSupportCache = new Map<string, KokoroRenderSupport>();

async function detectKokoroRenderSupport(
  pi: ExtensionAPI,
  config: KokoroConfig,
): Promise<KokoroRenderSupport> {
  const cacheKey = `${config.command}`;
  const cached = kokoroRenderSupportCache.get(cacheKey);
  if (cached) return cached;

  let helpText = '';
  try {
    // Some CLIs accept only `-h`.
    const responseHelp = await pi.exec(config.command, ['--help'], {
      timeout: 15_000,
    });
    helpText = `${responseHelp.stdout}\n${responseHelp.stderr}`;

    if (!helpText.trim()) {
      const responseH = await pi.exec(config.command, ['-h'], {
        timeout: 15_000,
      });
      helpText = `${responseH.stdout}\n${responseH.stderr}`;
    }
  } catch {
    // If probing fails, we’ll treat it as unsupported and fall back.
  }

  const lower = helpText.toLowerCase();
  const hasSave = lower.includes('--save');
  const hasNoPlay = lower.includes('--no-play');
  const hasStream = lower.includes('--stream');
  const hasOutputToken =
    /\boutput\b/i.test(helpText) || /\bout\b/i.test(helpText);

  let support: KokoroRenderSupport;

  if (hasSave) {
    support = {
      supported: true,
      strategy: hasNoPlay ? 'save-no-play' : 'save',
      helpSnippet: helpText.slice(0, 800),
    };
  } else if (hasStream && hasOutputToken) {
    support = {
      supported: true,
      strategy: 'positional-output',
      helpSnippet: helpText.slice(0, 800),
    };
  } else {
    support = {
      supported: false,
      reason:
        'Could not detect Kokoro render-to-file flags for this kokoro-tts CLI.',
      helpSnippet: helpText.slice(0, 800),
    };
  }

  kokoroRenderSupportCache.set(cacheKey, support);
  return support;
}

async function renderPiperChunkToWav(parameters: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Extract<TtsConfig, {backend: 'piper'}>;
  chunkText: string;
  chunkIndex: number;
  totalChunks: number;
  playbackController: AbortController;
  renderStartTimes: number[];
  renderEndTimes: number[];
}): Promise<
  {status: 'ok'; wavPath: string} | {status: 'aborted'} | {status: 'error'}
> {
  const {
    pi,
    ctx,
    config,
    chunkText,
    chunkIndex,
    totalChunks,
    playbackController,
    renderStartTimes,
    renderEndTimes,
  } = parameters;

  const wavPath = join(tmpdir(), `pi-tts-${randomUUID()}.wav`);

  const wavArgs = [
    ...config.args,
    ...(config.dataDir ? ['--data-dir', config.dataDir] : []),
    '-m',
    config.model,
    ...config.extraArgs,
    '-f',
    wavPath,
    '--',
    chunkText,
  ];

  if (debugEnabled()) {
    debugNotify(
      ctx,
      `Piper render (chunk ${chunkIndex + 1}/${totalChunks}): command=${config.command} args=${JSON.stringify(wavArgs)}`,
    );
  }

  renderStartTimes[chunkIndex] = performance.now();
  let renderResult: Awaited<ReturnType<ExtensionAPI['exec']>>;
  try {
    renderResult = await pi.exec(config.command, wavArgs, {
      signal: playbackController.signal,
    });
  } finally {
    renderEndTimes[chunkIndex] = performance.now();
  }

  if (playbackController.signal.aborted || renderResult.killed) {
    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // best-effort cleanup
    }

    return {status: 'aborted'};
  }

  if (renderResult.code !== 0) {
    const renderOutput =
      `${renderResult.stderr}\n${renderResult.stdout}`.trim();
    const errorMessage = formatSubprocessFailure(
      renderOutput,
      config.command,
      'piper',
    );
    notify(ctx, errorMessage, 'error');

    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // best-effort cleanup
    }

    return {status: 'error'};
  }

  return {status: 'ok', wavPath};
}

/* eslint-disable no-await-in-loop */
async function speakPiperChunks(parameters: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Extract<TtsConfig, {backend: 'piper'}>;
  chunks: string[];
  playbackController: AbortController;
}): Promise<boolean> {
  const {pi, ctx, config, chunks, playbackController} = parameters;

  const renderStartTimes: number[] = Array.from(
    {length: chunks.length},
    () => 0,
  );
  const renderEndTimes: number[] = Array.from({length: chunks.length}, () => 0);
  const playStartTimes: number[] = Array.from({length: chunks.length}, () => 0);
  const playEndTimes: number[] = Array.from({length: chunks.length}, () => 0);

  const renderedWavs = new Set<string>();

  try {
    if (chunks.length === 0) return true;

    let nextRenderPromise:
      | Promise<
          | {status: 'ok'; wavPath: string}
          | {status: 'aborted'}
          | {status: 'error'}
        >
      | undefined;

    nextRenderPromise = renderPiperChunkToWav({
      pi,
      ctx,
      config,
      chunkText: chunks[0],
      chunkIndex: 0,
      totalChunks: chunks.length,
      playbackController,
      renderStartTimes,
      renderEndTimes,
    });

    for (let i = 0; i < chunks.length; i++) {
      if (playbackController.signal.aborted) return false;

      const renderResult = await (nextRenderPromise as Promise<
        | {status: 'ok'; wavPath: string}
        | {status: 'aborted'}
        | {status: 'error'}
      >);

      if (
        playbackController.signal.aborted ||
        renderResult.status === 'aborted'
      ) {
        return false;
      }

      if (renderResult.status === 'error') {
        return false;
      }

      const currentWavPath = renderResult.wavPath;
      renderedWavs.add(currentWavPath);

      if (i + 1 < chunks.length && !playbackController.signal.aborted) {
        debugNotify(
          ctx,
          `started rendering chunk ${i + 2}/${chunks.length} during playback of chunk ${i + 1}/${chunks.length}`,
        );
        nextRenderPromise = renderPiperChunkToWav({
          pi,
          ctx,
          config,
          chunkText: chunks[i + 1],
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          playbackController,
          renderStartTimes,
          renderEndTimes,
        });
      }

      if (chunks.length > 1) {
        notify(ctx, `Speaking chunk ${i + 1}/${chunks.length}...`, 'info');
      }

      if (debugEnabled()) {
        debugNotify(ctx, `play start (chunk ${i + 1}/${chunks.length})`);
      }

      playStartTimes[i] = performance.now();

      const ffplayResult = await pi.exec(
        'ffplay',
        ['-nodisp', '-autoexit', '-loglevel', 'quiet', currentWavPath],
        {signal: playbackController.signal},
      );

      playEndTimes[i] = performance.now();

      if (playbackController.signal.aborted || ffplayResult.killed) {
        return false;
      }

      if (ffplayResult.code !== 0) {
        const output = `${ffplayResult.stderr}\n${ffplayResult.stdout}`.trim();
        const errorMessage = output
          ? `ffplay failed with exit code ${ffplayResult.code}.\n\n--- stderr/stdout ---\n${output}`
          : `ffplay failed with exit code ${ffplayResult.code}.`;
        notify(ctx, errorMessage, 'error');
        return false;
      }

      if (i + 1 < chunks.length && renderStartTimes[i + 1]) {
        const gapMs = renderStartTimes[i + 1] - playEndTimes[i];
        if (debugEnabled()) {
          debugNotify(
            ctx,
            `gap between chunk ${i + 1} play end and chunk ${i + 2} render start: ${gapMs.toFixed(
              1,
            )}ms (negative means overlap)`,
          );
          debugNotify(
            ctx,
            `render duration chunk ${i + 1}: ${(renderEndTimes[i] - renderStartTimes[i]).toFixed(1)}ms; play duration: ${(playEndTimes[i] - playStartTimes[i]).toFixed(1)}ms`,
          );
        }
      }

      // Cleanup wav after playback.
      try {
        if (existsSync(currentWavPath)) unlinkSync(currentWavPath);
      } catch {
        // best-effort cleanup
      }

      renderedWavs.delete(currentWavPath);

      debugNotify(ctx, `play end (chunk ${i + 1}/${chunks.length})`);
    }

    return true;
  } finally {
    for (const wavPath of renderedWavs) {
      try {
        if (existsSync(wavPath)) unlinkSync(wavPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/* eslint-enable no-await-in-loop */

async function renderKokoroChunkToWav(parameters: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Extract<TtsConfig, {backend: 'kokoro'}>;
  chunkText: string;
  chunkIndex: number;
  totalChunks: number;
  playbackController: AbortController;
  wavPath: string;
  renderStartTimes: number[];
  renderEndTimes: number[];
  strategy: KokoroRenderStrategy;
}): Promise<
  {status: 'ok'; wavPath: string} | {status: 'aborted'} | {status: 'error'}
> {
  const {
    pi,
    ctx,
    config,
    chunkText,
    chunkIndex,
    totalChunks,
    playbackController,
    wavPath,
    renderStartTimes,
    renderEndTimes,
    strategy,
  } = parameters;

  const currentInputPath = join(tmpdir(), `pi-tts-${randomUUID()}.txt`);

  writeFileSync(currentInputPath, chunkText, 'utf8');

  const kokoroVoice = config.voice ?? 'af_sarah';

  // Always sanitize `--stream` for render-only mode.
  const sanitizedConfigArgs = removeStreamFlagFromArgs(config.args);
  const sanitizedExtraArgs = removeStreamFlagFromArgs(config.extraArgs);

  const baseArgs = [...sanitizedConfigArgs];

  let kokoroArgs: string[];

  if (strategy === 'positional-output') {
    kokoroArgs = [
      ...baseArgs,
      currentInputPath,
      wavPath,
      '--model',
      config.modelPath,
      '--voices',
      config.voicesPath,
      ...(config.lang ? ['--lang', config.lang] : []),
      '--voice',
      kokoroVoice,
      ...(config.speed ? ['--speed', String(config.speed)] : []),
      ...sanitizedExtraArgs,
    ];
  } else {
    // Strategy A/B with `--save <wav>`.
    kokoroArgs = [
      ...baseArgs,
      currentInputPath,
      '--model',
      config.modelPath,
      '--voices',
      config.voicesPath,
      ...(config.lang ? ['--lang', config.lang] : []),
      '--voice',
      kokoroVoice,
      ...(config.speed ? ['--speed', String(config.speed)] : []),
      ...sanitizedExtraArgs,
      ...(strategy === 'save-no-play' ? ['--no-play'] : []),
      '--save',
      wavPath,
    ];
  }

  if (debugEnabled()) {
    debugNotify(
      ctx,
      `Kokoro render-to-wav (chunk ${chunkIndex + 1}/${totalChunks}): command=${config.command} args=${JSON.stringify(kokoroArgs)}`,
    );
    if (debugEnabled()) {
      // If the CLI supports it, it helps diagnose silent failures.
      kokoroArgs.push('--debug');
    }
  }

  renderStartTimes[chunkIndex] = performance.now();

  let renderResult: Awaited<ReturnType<ExtensionAPI['exec']>>;
  try {
    renderResult = await pi.exec(config.command, kokoroArgs, {
      signal: playbackController.signal,
    });
  } finally {
    renderEndTimes[chunkIndex] = performance.now();
  }

  if (playbackController.signal.aborted || renderResult.killed) {
    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // best-effort cleanup
    }

    try {
      if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
    } catch {
      // best-effort cleanup
    }

    return {status: 'aborted'};
  }

  if (renderResult.code !== 0) {
    const renderOutput =
      `${renderResult.stderr}\n${renderResult.stdout}`.trim();
    const errorMessage = formatSubprocessFailure(
      renderOutput,
      config.command,
      'kokoro',
    );
    notify(ctx, errorMessage, 'error');

    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // best-effort cleanup
    }

    try {
      if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
    } catch {
      // best-effort cleanup
    }

    return {status: 'error'};
  }

  // Render succeeded. Caller will play and then delete `wavPath`.
  try {
    if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
  } catch {
    // best-effort cleanup
  }

  return {status: 'ok', wavPath};
}

/* eslint-disable no-await-in-loop */
async function speakKokoroChunks(parameters: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  config: Extract<TtsConfig, {backend: 'kokoro'}>;
  chunks: string[];
  playbackController: AbortController;
}): Promise<boolean> {
  const {pi, ctx, config, chunks, playbackController} = parameters;

  const renderStartTimes: number[] = Array.from(
    {length: chunks.length},
    () => 0,
  );
  const renderEndTimes: number[] = Array.from({length: chunks.length}, () => 0);
  const playStartTimes: number[] = Array.from({length: chunks.length}, () => 0);
  const playEndTimes: number[] = Array.from({length: chunks.length}, () => 0);

  const renderedWavs = new Set<string>();

  const support = await detectKokoroRenderSupport(pi, config);

  if (!support.supported) {
    if (support.helpSnippet && debugEnabled()) {
      debugNotify(
        ctx,
        `Kokoro render-to-wav capability detection failed. CLI help snippet: ${support.helpSnippet}`,
        'warning',
      );
    }

    notify(
      ctx,
      'Kokoro render-to-file is not supported by this kokoro-tts CLI. Falling back to sequential streaming (audible gaps may remain).',
      'warning',
    );

    for (let i = 0; i < chunks.length; i++) {
      if (playbackController.signal.aborted) return false;

      const chunkText = chunks[i];
      if (!chunkText) continue;

      if (chunks.length > 1) {
        notify(ctx, `Speaking chunk ${i + 1}/${chunks.length}...`, 'info');
      }

      const currentInputPath = join(tmpdir(), `pi-tts-${randomUUID()}.txt`);
      writeFileSync(currentInputPath, chunkText, 'utf8');

      const kokoroVoice = config.voice ?? 'af_sarah';

      const kokoroArgs = [
        ...config.args,
        currentInputPath,
        '--stream',
        '--model',
        config.modelPath,
        '--voices',
        config.voicesPath,
        ...(config.lang ? ['--lang', config.lang] : []),
        '--voice',
        kokoroVoice,
        ...(config.speed ? ['--speed', String(config.speed)] : []),
        ...config.extraArgs,
      ];

      if (debugEnabled()) {
        debugNotify(
          ctx,
          `Kokoro streaming (chunk ${i + 1}/${chunks.length}): command=${config.command} args=${JSON.stringify(kokoroArgs)}`,
        );
        kokoroArgs.push('--debug');
      }

      let renderResult: Awaited<ReturnType<ExtensionAPI['exec']>>;
      try {
        renderResult = await pi.exec(config.command, kokoroArgs, {
          signal: playbackController.signal,
        });
      } finally {
        // no-op
      }

      if (playbackController.signal.aborted || renderResult.killed) {
        try {
          if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
        } catch {
          // best-effort cleanup
        }

        return false;
      }

      if (renderResult.code !== 0) {
        const renderOutput =
          `${renderResult.stderr}\n${renderResult.stdout}`.trim();
        const errorMessage = formatSubprocessFailure(
          renderOutput,
          config.command,
          'kokoro',
        );
        notify(ctx, errorMessage, 'error');

        try {
          if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
        } catch {
          // best-effort cleanup
        }

        return false;
      }

      try {
        if (existsSync(currentInputPath)) unlinkSync(currentInputPath);
      } catch {
        // best-effort cleanup
      }
    }

    return true;
  }

  // Render-to-file pipeline (1-chunk lookahead)
  try {
    if (chunks.length === 0) return true;

    let nextRenderPromise:
      | Promise<
          | {status: 'ok'; wavPath: string}
          | {status: 'aborted'}
          | {status: 'error'}
        >
      | undefined;

    const startRender = async (index: number) => {
      const wavPath = join(tmpdir(), `pi-tts-${randomUUID()}.wav`);
      return renderKokoroChunkToWav({
        pi,
        ctx,
        config,
        chunkText: chunks[index],
        chunkIndex: index,
        totalChunks: chunks.length,
        playbackController,
        wavPath,
        renderStartTimes,
        renderEndTimes,
        strategy: support.strategy,
      });
    };

    nextRenderPromise = startRender(0);

    for (let i = 0; i < chunks.length; i++) {
      if (playbackController.signal.aborted) return false;

      const renderResult = await (nextRenderPromise as Promise<
        | {status: 'ok'; wavPath: string}
        | {status: 'aborted'}
        | {status: 'error'}
      >);

      if (
        playbackController.signal.aborted ||
        renderResult.status === 'aborted'
      ) {
        return false;
      }

      if (renderResult.status === 'error') {
        return false;
      }

      const currentWavPath = renderResult.wavPath;
      renderedWavs.add(currentWavPath);

      if (i + 1 < chunks.length && !playbackController.signal.aborted) {
        debugNotify(
          ctx,
          `started rendering chunk ${i + 2}/${chunks.length} during playback of chunk ${i + 1}/${chunks.length}`,
        );
        nextRenderPromise = startRender(i + 1);
      }

      if (chunks.length > 1) {
        notify(ctx, `Speaking chunk ${i + 1}/${chunks.length}...`, 'info');
      }

      if (debugEnabled()) {
        debugNotify(ctx, `play start (chunk ${i + 1}/${chunks.length})`);
      }

      playStartTimes[i] = performance.now();

      const ffplayResult = await pi.exec(
        'ffplay',
        ['-nodisp', '-autoexit', '-loglevel', 'quiet', currentWavPath],
        {signal: playbackController.signal},
      );

      playEndTimes[i] = performance.now();

      if (playbackController.signal.aborted || ffplayResult.killed) {
        return false;
      }

      if (ffplayResult.code !== 0) {
        const output = `${ffplayResult.stderr}\n${ffplayResult.stdout}`.trim();
        const errorMessage = output
          ? `ffplay failed with exit code ${ffplayResult.code}.\n\n--- stderr/stdout ---\n${output}`
          : `ffplay failed with exit code ${ffplayResult.code}.`;
        notify(ctx, errorMessage, 'error');
        return false;
      }

      if (i + 1 < chunks.length && renderStartTimes[i + 1]) {
        const gapMs = renderStartTimes[i + 1] - playEndTimes[i];
        if (debugEnabled()) {
          debugNotify(
            ctx,
            `gap between chunk ${i + 1} play end and chunk ${i + 2} render start: ${gapMs.toFixed(
              1,
            )}ms (negative means overlap)`,
          );
          debugNotify(
            ctx,
            `render duration chunk ${i + 1}: ${(renderEndTimes[i] - renderStartTimes[i]).toFixed(1)}ms; play duration: ${(playEndTimes[i] - playStartTimes[i]).toFixed(1)}ms`,
          );
        }
      }

      try {
        if (existsSync(currentWavPath)) unlinkSync(currentWavPath);
      } catch {
        // best-effort cleanup
      }

      renderedWavs.delete(currentWavPath);

      debugNotify(ctx, `play end (chunk ${i + 1}/${chunks.length})`);
    }

    return true;
  } finally {
    for (const wavPath of renderedWavs) {
      try {
        if (existsSync(wavPath)) unlinkSync(wavPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/* eslint-enable no-await-in-loop */

async function speakText(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
) {
  // Cancel any previous playback before starting a new one.
  activePlaybackController?.abort();

  const playbackController = new AbortController();
  activePlaybackController = playbackController;

  const cleanup = () => {
    if (activePlaybackController === playbackController) {
      activePlaybackController = undefined;
    }
  };

  const onCtxAbort = () => {
    playbackController.abort();
  };

  if (ctx.signal) {
    if (ctx.signal.aborted) {
      playbackController.abort();
    } else {
      ctx.signal.addEventListener('abort', onCtxAbort, {once: true});
    }
  }

  let commandForError = 'tts';
  let backendForError: TtsBackend = 'piper';

  try {
    if (playbackController.signal.aborted) return;

    const config = getConfig(ctx);
    if ('error' in config) {
      notify(ctx, config.error, 'error');
      return;
    }

    commandForError = config.backend === 'piper' ? 'piper' : 'kokoro-tts';
    backendForError = config.backend;

    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      debugDumpConfig(ctx, config);
    }

    let speechText = normalizeSpeechText(text);
    if (!speechText) {
      notify(ctx, 'Provided text contains no spoken text.', 'warning');
      return;
    }

    if (config.maxChars && speechText.length > config.maxChars) {
      const truncated = truncateText(speechText, config.maxChars);
      speechText = truncated.text;
      if (truncated.truncated) {
        notify(
          ctx,
          `Latest assistant message was truncated to ${config.maxChars} characters for speech.`,
          'warning',
        );
      }
    }

    if (config.backend === 'piper') {
      if (looksLikePath(config.model)) {
        // Validate model path early so we can show a precise error.
        if (!existsSync(config.model)) {
          notify(
            ctx,
            `Piper model file not found at: ${config.model}`,
            'error',
          );
          return;
        }

        // Piper usually expects a sibling JSON config next to the ONNX.
        const modelJsonPath = `${config.model}.json`;
        if (!existsSync(modelJsonPath)) {
          notify(
            ctx,
            `Piper voice config JSON not found at: ${modelJsonPath} (piper guesses this automatically).`,
            'error',
          );
          return;
        }
      }
    } else {
      if (!existsSync(config.modelPath)) {
        notify(
          ctx,
          `Kokoro model file not found at: ${config.modelPath}`,
          'error',
        );
        return;
      }

      if (!existsSync(config.voicesPath)) {
        notify(
          ctx,
          `Kokoro voices file not found at: ${config.voicesPath}`,
          'error',
        );
        return;
      }
    }

    const {chunkChars} = config;
    const chunks =
      chunkChars && chunkChars > 0 && speechText.length > chunkChars
        ? splitSpeechIntoChunks(speechText, chunkChars)
        : [speechText];

    if (chunks.length === 1) {
      notify(ctx, 'Speaking latest assistant message...', 'info');
    } else {
      notify(
        ctx,
        `Speaking latest assistant message in ${chunks.length} chunks...`,
        'info',
      );
    }

    const completed =
      config.backend === 'piper'
        ? await speakPiperChunks({
            pi,
            ctx,
            config,
            chunks,
            playbackController,
          })
        : await speakKokoroChunks({
            pi,
            ctx,
            config,
            chunks,
            playbackController,
          });

    if (completed) {
      notify(ctx, 'Spoken latest assistant message.', 'info');
    }
  } catch (error) {
    if (playbackController.signal.aborted || isAbortError(error)) return;
    notify(
      ctx,
      formatExecError(commandForError, error, backendForError),
      'error',
    );
  } finally {
    cleanup();
  }
}

function extractSpokenText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (!isRecordUnknown(block)) {
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }

  return parts.join(' ');
}

export function normalizeSpeechText(text: string): string {
  // Strip Markdown-style double-asterisks so Piper doesn't pronounce them.
  return text.replaceAll('**', '').replaceAll(/\s+/g, ' ').trim();
}

function truncateText(
  text: string,
  maxChars: number,
): {text: string; truncated: boolean} {
  if (text.length <= maxChars) {
    return {text, truncated: false};
  }

  return {
    text: text.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function findLatestAssistantMessage(
  branch: SessionEntry[],
): SessionEntry | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      return entry;
    }
  }

  return undefined;
}

function formatExecError(
  command: string,
  error: unknown,
  backend: TtsBackend,
): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (/enoent|not found/i.test(message)) {
      if (backend === 'kokoro') {
        return 'Kokoro unavailable. Install it first: pip install kokoro-tts';
      }

      return 'Piper unavailable. Install Piper and Python first: pip install piper-tts';
    }

    return message || `Failed to run ${command}.`;
  }

  return `Failed to run ${command}.`;
}

function formatSubprocessFailure(
  stderr: string,
  command: string,
  backend: TtsBackend,
): string {
  const output = stderr.trim();
  if (!output) {
    return backend === 'kokoro'
      ? `Kokoro failed to run ${command}.`
      : `Piper failed to run ${command}.`;
  }

  if (/modulenotfounderror|no module named/i.test(output)) {
    if (backend === 'kokoro' && /kokoro/i.test(output)) {
      return 'Kokoro is not installed. Install it with: pip install kokoro-tts';
    }

    if (backend === 'piper' && /piper/i.test(output)) {
      return 'Piper is not installed. Install it with: pip install piper-tts';
    }
  }

  if (/model|voice|voices|file|no such file|cannot find/i.test(output)) {
    if (backend === 'kokoro') {
      return `Kokoro could not load the configured model/voices. Check PI_TTS_MODEL and PI_TTS_VOICES.\n\n--- Kokoro stderr/stdout ---\n${output}`;
    }

    return `Piper could not load the configured voice/model. Check PI_TTS_MODEL and download the voice.\n\n--- Piper stderr/stdout ---\n${output}`;
  }

  return output;
}

function stopCurrentPlayback() {
  activePlaybackController?.abort();
}

function debugDumpConfig(ctx: ExtensionContext, config: TtsConfig) {
  if ('error' in config) return;

  const payload =
    config.backend === 'piper'
      ? {
          backend: config.backend,
          command: config.command,
          args: config.args,
          model: config.model,
          dataDir: config.dataDir,
          extraArgs: config.extraArgs,
          maxChars: config.maxChars,
          chunkChars: config.chunkChars,
        }
      : {
          backend: config.backend,
          command: config.command,
          args: config.args,
          modelPath: config.modelPath,
          voicesPath: config.voicesPath,
          lang: config.lang,
          voice: config.voice,
          speed: config.speed,
          extraArgs: config.extraArgs,
          maxChars: config.maxChars,
          chunkChars: config.chunkChars,
        };

  const message = `PIPER_PI_TTS_DEBUG=1 resolved config: ${JSON.stringify(payload)}`;
  if (ctx.hasUI) notify(ctx, message, 'info');
  else console.log(message);
}

export default function piperTtsExtension(pi: ExtensionAPI) {
  const autoPlayEnabled = isAutoPlayEnabledAtLoad();
  if (process.env.PIPER_PI_TTS_DEBUG === '1') {
    const debugMessage = `PIPER_PI_TTS_DEBUG=1 autoPlayEnabled=${autoPlayEnabled}`;
    console.log(debugMessage);
  }

  let pendingAutoPlay = false;
  let lastAutoPlayedMessageKey: string | undefined;

  pi.on('session_shutdown', () => {
    stopCurrentPlayback();
  });

  pi.on('session_before_switch', () => {
    stopCurrentPlayback();
  });

  pi.on('session_before_fork', () => {
    stopCurrentPlayback();
  });

  pi.on('session_before_tree', () => {
    stopCurrentPlayback();
  });

  // Stop playback when the agent begins a new turn, or when the assistant
  // message is streaming/updating (prevents overlapping audio).
  pi.on('turn_start', () => {
    stopCurrentPlayback();
  });

  pi.on('message_start', (event) => {
    if (event.message?.role === 'assistant') stopCurrentPlayback();
  });

  pi.on('message_update', (event) => {
    if (event.message?.role === 'assistant') stopCurrentPlayback();
  });

  pi.on('input', (event) => {
    if (!autoPlayEnabled) return;
    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      const debugMessage = `PIPER_PI_TTS_DEBUG=1 input arming check: source=${event.source} pendingAutoPlay=${pendingAutoPlay}`;
      if (pi) console.log(debugMessage);
    }

    if (
      event.source === 'interactive' ||
      event.source === 'rpc' ||
      event.source === 'extension'
    ) {
      pendingAutoPlay = true;
    }
  });

  pi.on('agent_end', async (event: AgentEndEvent, ctx) => {
    if (!autoPlayEnabled) return;
    if (!pendingAutoPlay) return;
    pendingAutoPlay = false;

    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      const debugMessage = `PIPER_PI_TTS_DEBUG=1 agent_end triggered: messages=${event.messages.length}`;
      if (ctx.hasUI) notify(ctx, debugMessage, 'info');
      else console.log(debugMessage);
    }

    const message = [...event.messages]
      // eslint-disable-next-line unicorn/no-array-reverse
      .reverse()
      .find((m) => m.role === 'assistant');
    if (message?.role !== 'assistant') return;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') {
      if (process.env.PIPER_PI_TTS_DEBUG === '1') {
        const debugMessage = `PIPER_PI_TTS_DEBUG=1 skipping speech due to stopReason=${message.stopReason}`;
        if (ctx.hasUI) notify(ctx, debugMessage, 'info');
        else console.log(debugMessage);
      }

      return;
    }

    const messageKey = message.responseId ?? String(message.timestamp);
    if (lastAutoPlayedMessageKey === messageKey) return;
    lastAutoPlayedMessageKey = messageKey;

    const text = normalizeSpeechText(extractSpokenText(message.content));
    if (!text) {
      if (process.env.PIPER_PI_TTS_DEBUG === '1') {
        const debugMessage =
          'PIPER_PI_TTS_DEBUG=1 skipping speech: no spoken text in assistant message';
        if (ctx.hasUI) notify(ctx, debugMessage, 'info');
        else console.log(debugMessage);
      }

      return;
    }

    await speakText(pi, ctx, text);
  });

  const speakLatestAssistant: ExtensionAPI['registerCommand'] extends (
    ...args: any[]
  ) => any
    ? (_args: unknown, ctx: ExtensionCommandContext) => Promise<void>
    : never = async (_args: unknown, ctx: ExtensionCommandContext) => {
    await ctx.waitForIdle();

    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const latestAssistant = findLatestAssistantMessage(branch);

    if (!latestAssistant) {
      notify(ctx, 'No assistant message to speak yet.', 'warning');
      return;
    }

    const text = normalizeSpeechText(
      extractSpokenText(latestAssistant.message?.content),
    );
    if (!text) {
      notify(
        ctx,
        'Latest assistant message contains no spoken text.',
        'warning',
      );
      return;
    }

    await speakText(pi, ctx, text);
  };

  const stopPlayback: ExtensionAPI['registerCommand'] extends (
    ...args: any[]
  ) => any
    ? (_args: unknown, ctx: ExtensionCommandContext) => Promise<void>
    : never = async (_args: unknown, ctx: ExtensionCommandContext) => {
    if (!activePlaybackController) {
      notify(ctx, 'No active TTS playback to stop.', 'warning');
      return;
    }

    activePlaybackController.abort();
    notify(ctx, 'Stopped TTS playback.', 'info');
  };

  pi.registerCommand('piper-tts', {
    description: 'Speak the latest assistant message',
    handler: speakLatestAssistant,
  });

  pi.registerCommand('piper-tts-stop', {
    description: 'Stop the current TTS playback',
    handler: stopPlayback,
  });

  // Convenience alias: Pi users often expect `/tts`.
  // If disabled, we do NOT register the command at all.
  if (isTtsAliasEnabledAtLoad()) {
    pi.registerCommand('tts', {
      description: 'Alias for /piper-tts',
      handler: speakLatestAssistant,
    });

    pi.registerCommand('tts-stop', {
      description: 'Alias for /piper-tts-stop',
      handler: stopPlayback,
    });
  }
}
