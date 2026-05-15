import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import type {
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
};

const defaultPiperCommand = 'python3';
const defaultPiperCommandArgs = ['-m', 'piper'];

// Module-scope so `/piper-tts-stop` can cancel the currently running playback.
let activePlaybackController: AbortController | undefined;

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

function expandPath(value: string): string {
  const v = value.trim();
  if (v === '~') return homedir();
  if (v.startsWith('~/')) return join(homedir(), v.slice(2));
  return value;
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

function getSettingsSection(
  s: Record<string, unknown>,
): Record<string, unknown> {
  // Namespaced keys (pick one) in settings.json
  // - { "pi-tts-command": { ... } }
  // - { "tts": { ... } }
  // - { "piper": { ... } }
  const candidates = [s['pi-piper-tts'], s['pi-tts-command'], s.tts, s.piper];
  for (const c of candidates) {
    if (isRecordUnknown(c)) {
      return c;
    }
  }

  return {};
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
  // Keep it simple: section key `enable-tts-alias`.
  const raw = section['enable-tts-alias'] ?? section.enableTtsAlias;
  const parsed = parseOptionalBoolean(raw);
  return parsed ?? true;
}

function isTtsAliasEnabledAtLoad(): boolean {
  // Default ON for backward compatibility.
  const envRaw = process.env.PIPER_PI_ENABLE_TTS_ALIAS?.trim();
  if (envRaw) {
    const parsed = parseOptionalBoolean(envRaw);
    if (parsed !== undefined) return parsed;
    return true;
  }

  const globalPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const projectPath = join(process.cwd(), '.pi', 'settings.json');
  const globalSettings = asRecordUnknown(loadPiSettingsFile(globalPath));
  const projectSettings = asRecordUnknown(loadPiSettingsFile(projectPath));
  const settings = {...globalSettings, ...projectSettings};
  const section = getSettingsSection(settings);
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
  const envRaw = process.env.PIPER_PI_AUTO_PLAY?.trim();
  if (envRaw) {
    const parsed = parseOptionalBoolean(envRaw);
    return parsed ?? false;
  }

  const globalPath = join(homedir(), '.pi', 'agent', 'settings.json');
  const projectPath = join(process.cwd(), '.pi', 'settings.json');
  const globalSettings = asRecordUnknown(loadPiSettingsFile(globalPath));
  const projectSettings = asRecordUnknown(loadPiSettingsFile(projectPath));
  const settings = {...globalSettings, ...projectSettings};
  const section = getSettingsSection(settings);
  return isAutoPlayEnabledFromSettings(section);
}

function getConfig(
  ctx: ExtensionContext,
): PiperConfig | {error: string} {
  const settings = getPiSettings(ctx);
  const section = getSettingsSection(settings);

  const modelFromSection = section['piper-pi-model'];
  const modelRaw =
    process.env.PIPER_PI_MODEL?.trim() ??
    (typeof modelFromSection === 'string' ? modelFromSection.trim() : '');
  const model = modelRaw ? expandPath(modelRaw) : '';
  if (!model) {
    return {
      error:
        "Missing Piper model. Set PIPER_PI_MODEL (env) or settings.json 'pi-tts-command.piper-pi-model'.",
    };
  }

  const binFromEnv = process.env.PIPER_PI_BIN?.trim();
  const binFromSettingsRaw = section['piper-pi-bin'];
  const binFromSettings =
    typeof binFromSettingsRaw === 'string' ? binFromSettingsRaw.trim() : '';

  const binSpec =
    binFromEnv && binFromEnv.length > 0
      ? binFromEnv
      : binFromSettings && binFromSettings.length > 0
        ? binFromSettings
        : defaultPiperCommand;

  const binParts = parseCommandLine(binSpec);
  if (binParts.length === 0) {
    return {error: 'PIPER_PI_BIN / settings.json piper-pi-bin is empty.'};
  }

  const command = binParts[0];
  const runnerArgs = binParts.length > 1 ? binParts.slice(1) : [];

  let extraArgs: string[] = [];
  const envExtraArgs = process.env.PIPER_PI_EXTRA_ARGS?.trim();
  if (envExtraArgs) {
    extraArgs = parseCommandLine(envExtraArgs);
  } else {
    const fromSettings = section['piper-pi-extra-args'];
    const settingsExtraArgs =
      typeof fromSettings === 'string' ? fromSettings.trim() : '';
    extraArgs = settingsExtraArgs ? parseCommandLine(settingsExtraArgs) : [];
  }

  const dataDirFromEnv = process.env.PIPER_PI_DATA_DIR?.trim();
  const dataDirFromSettingsRaw = section['piper-pi-data-dir'];
  const dataDirRaw =
    dataDirFromEnv ??
    (typeof dataDirFromSettingsRaw === 'string'
      ? dataDirFromSettingsRaw.trim()
      : '');
  const dataDir = dataDirRaw ? expandPath(dataDirRaw) : undefined;

  const maxCharsFromEnv = process.env.PIPER_PI_MAX_CHARS?.trim();
  const maxCharsFromSettingsRaw = section['piper-pi-max-chars'];
  const maxCharsRaw =
    maxCharsFromEnv ??
    (typeof maxCharsFromSettingsRaw === 'string'
      ? maxCharsFromSettingsRaw.trim()
      : '');
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
    return {error: 'PIPER_PI_MAX_CHARS must be a positive integer.'};
  }

  // Back-compat: if runner was only the python command, use the old default args.
  if (command === defaultPiperCommand && runnerArgs.length === 0) {
    runnerArgs.push(...defaultPiperCommandArgs);
  }

  return {
    command,
    args: runnerArgs,
    model,
    dataDir,
    extraArgs,
    maxChars,
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

async function speakText(pi: ExtensionAPI, ctx: ExtensionContext, text: string) {
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

  let commandForError = 'piper';

  try {
    if (playbackController.signal.aborted) return;

    const config = getConfig(ctx);
    if ('error' in config) {
      notify(ctx, config.error, 'error');
      return;
    }

    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      debugDumpConfig(ctx, config);
    }

    commandForError = config.command;

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

    // Validate model path early so we can show a precise error.
    if (!existsSync(config.model)) {
      notify(ctx, `Piper model file not found at: ${config.model}`, 'error');
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

    notify(ctx, 'Speaking latest assistant message...', 'info');

    const args = [
      ...config.args,
      ...(config.dataDir ? ['--data-dir', config.dataDir] : []),
      '-m',
      config.model,
      ...config.extraArgs,
      '--',
      speechText,
    ];

    // Helpful hint when debugging Piper configuration issues.
    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      notify(
        ctx,
        `Piper config: command=${config.command} args=${JSON.stringify(args)}`,
        'info',
      );
    }

    const result = await pi.exec(config.command, args, {
      signal: playbackController.signal,
    });
    if (playbackController.signal.aborted) return;

    if (result.code !== 0) {
      const output = (result.stderr || result.stdout || '').toString();

      // Piper uses ffplay for playback; for long utterances it can exceed
      // Piper's internal 5s wait timeout and throw a TimeoutExpired.
      if (
        /ffplay/i.test(output) &&
        /(timed out|timeoutexpired)/i.test(output)
      ) {
        notify(
          ctx,
          'Piper playback timed out; retrying by rendering WAV then playing it.',
          'warning',
        );

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
          speechText,
        ];

        const renderResult = await pi.exec(config.command, wavArgs, {
          signal: playbackController.signal,
        });
        if (playbackController.signal.aborted) return;

        if (renderResult.code !== 0) {
          const renderOutput = (
            renderResult.stderr ||
            renderResult.stdout ||
            ''
          ).toString();
          const errorMessage = formatSubprocessFailure(
            renderOutput,
            config.command,
          );
          notify(ctx, errorMessage, 'error');
          return;
        }

        // Play the generated WAV.
        try {
          const ffplayResult = await pi.exec(
            'ffplay',
            ['-nodisp', '-autoexit', '-loglevel', 'quiet', wavPath],
            {signal: playbackController.signal},
          );
          if (playbackController.signal.aborted) return;

          if (ffplayResult.code !== 0) {
            notify(
              ctx,
              `ffplay failed with exit code ${ffplayResult.code}.`,
              'error',
            );
            return;
          }
        } catch {
          if (playbackController.signal.aborted) return;
          notify(
            ctx,
            'ffplay failed. Is ffmpeg/ffplay installed and on PATH?',
            'error',
          );
          return;
        }

        notify(ctx, 'Spoken latest assistant message.', 'info');
        return;
      }

      const errorMessage = formatSubprocessFailure(output, config.command);
      notify(ctx, errorMessage, 'error');
      return;
    }

    notify(ctx, 'Spoken latest assistant message.', 'info');
  } catch (error) {
    if (playbackController.signal.aborted || isAbortError(error)) return;
    notify(ctx, formatExecError(commandForError, error), 'error');
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

function normalizeSpeechText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
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

function formatExecError(command: string, error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (/enoent|not found/i.test(message)) {
      return `Piper unavailable. Install Piper and Python first: pip install piper-tts`;
    }

    return message || `Failed to run ${command}.`;
  }

  return `Failed to run ${command}.`;
}

function formatSubprocessFailure(stderr: string, command: string): string {
  const output = stderr.trim();
  if (!output) {
    return `Piper failed to run ${command}.`;
  }

  if (/no module named piper|modulenotfounderror/i.test(output)) {
    return 'Piper is not installed. Install it with: pip install piper-tts';
  }

  if (/model|voice|file|no such file|cannot find/i.test(output)) {
    return `Piper could not load the configured voice/model. Check PIPER_PI_MODEL and download the voice.\n\n--- Piper stderr/stdout ---\n${output}`;
  }

  return output;
}

function stopCurrentPlayback() {
  activePlaybackController?.abort();
}

function debugDumpConfig(ctx: ExtensionContext, config: PiperConfig) {
  const payload = {
    command: config.command,
    args: config.args,
    model: config.model,
    dataDir: config.dataDir,
    extraArgs: config.extraArgs,
    maxChars: config.maxChars,
  };

  const message = `PIPER_PI_TTS_DEBUG=1 resolved config: ${JSON.stringify(payload)}`;
  if (ctx.hasUI) notify(ctx, message, 'info');
  else console.log(message);
}

export default function piperTtsExtension(pi: ExtensionAPI) {
  const autoPlayEnabled = isAutoPlayEnabledAtLoad();
  if (process.env.PIPER_PI_TTS_DEBUG === '1') {
    const msg = `PIPER_PI_TTS_DEBUG=1 autoPlayEnabled=${autoPlayEnabled}`;
    console.log(msg);
  }
  let pendingAutoPlay: boolean = false;
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
      const msg = `PIPER_PI_TTS_DEBUG=1 input arming check: source=${event.source} pendingAutoPlay=${pendingAutoPlay}`;
      if (pi) console.log(msg);
    }
    if (
      event.source === 'interactive' ||
      event.source === 'rpc' ||
      event.source === 'extension'
    ) {
      pendingAutoPlay = true;
    }
  });

  pi.on('agent_end', async (event, ctx) => {
    if (!autoPlayEnabled) return;
    if (!pendingAutoPlay) return;
    pendingAutoPlay = false;

    if (process.env.PIPER_PI_TTS_DEBUG === '1') {
      const msg = `PIPER_PI_TTS_DEBUG=1 agent_end triggered: messages=${event.messages.length}`;
      if (ctx.hasUI) notify(ctx, msg, 'info');
      else console.log(msg);
    }

    const message = [...event.messages].reverse().find(m => m.role === 'assistant');
    if (!message || message.role !== 'assistant') return;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') {
      if (process.env.PIPER_PI_TTS_DEBUG === '1') {
        const msg = `PIPER_PI_TTS_DEBUG=1 skipping speech due to stopReason=${message.stopReason}`;
        if (ctx.hasUI) notify(ctx, msg, 'info');
        else console.log(msg);
      }
      return;
    }

    const messageKey = message.responseId ?? String(message.timestamp);
    if (lastAutoPlayedMessageKey === messageKey) return;
    lastAutoPlayedMessageKey = messageKey;

    const text = normalizeSpeechText(extractSpokenText(message.content));
    if (!text) {
      if (process.env.PIPER_PI_TTS_DEBUG === '1') {
        const msg = 'PIPER_PI_TTS_DEBUG=1 skipping speech: no spoken text in assistant message';
        if (ctx.hasUI) notify(ctx, msg, 'info');
        else console.log(msg);
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
      notify(ctx, 'No active piper playback to stop.', 'warning');
      return;
    }

    activePlaybackController.abort();
    notify(ctx, 'Stopped piper playback.', 'info');
  };

  pi.registerCommand('piper-tts', {
    description: 'Speak the latest assistant message',
    handler: speakLatestAssistant,
  });

  pi.registerCommand('piper-tts-stop', {
    description: 'Stop the current piper playback',
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
