import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";

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

const DEFAULT_PIPER_COMMAND = "python3";
const DEFAULT_PIPER_COMMAND_ARGS = ["-m", "piper"];

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function parseCommandLine(value: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const ch of value.trim()) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				quote = null;
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
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (escaped) {
		current += "\\";
	}

	if (current.length > 0) {
		parts.push(current);
	}

	return parts;
}

function expandPath(value: string): string {
	const v = value.trim();
	if (v === "~") return homedir();
	if (v.startsWith("~/")) return join(homedir(), v.slice(2));
	return value;
}

function loadPiSettingsFile(path: string): unknown {
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

function getPiSettings(ctx: ExtensionCommandContext): Record<string, unknown> {
	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const cwd = (ctx as any).cwd ? String((ctx as any).cwd) : process.cwd();
	const projectPath = join(cwd, ".pi", "settings.json");

	const globalSettings = (loadPiSettingsFile(globalPath) ?? {}) as Record<string, unknown>;
	const projectSettings = (loadPiSettingsFile(projectPath) ?? {}) as Record<string, unknown>;

	// Project overrides global
	return { ...globalSettings, ...projectSettings };
}

function getSettingsSection(s: Record<string, unknown>): Record<string, unknown> {
	// Namespaced keys (pick one) in settings.json
	// - { "pi-tts-command": { ... } }
	// - { "tts": { ... } }
	// - { "piper": { ... } }
	const candidates = [s["pi-piper-tts"], s["pi-tts-command"], s["tts"], s["piper"]];
	for (const c of candidates) {
		if (c && typeof c === "object" && !Array.isArray(c)) {
			return c as Record<string, unknown>;
		}
	}
	return {};
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function isTtsAliasEnabledFromSettings(section: Record<string, unknown>): boolean {
	// Keep it simple: section key `enable-tts-alias`.
	const raw = section["enable-tts-alias"] ?? section["enableTtsAlias"];
	const parsed = parseOptionalBoolean(raw);
	return parsed !== undefined ? parsed : true;
}

function isTtsAliasEnabledAtLoad(): boolean {
	// Default ON for backward compatibility.
	const envRaw = process.env.PIPER_PI_ENABLE_TTS_ALIAS?.trim();
	if (envRaw) {
		const parsed = parseOptionalBoolean(envRaw);
		if (parsed !== undefined) return parsed;
		return true;
	}

	const globalPath = join(homedir(), ".pi", "agent", "settings.json");
	const projectPath = join(process.cwd(), ".pi", "settings.json");
	const globalSettings = (loadPiSettingsFile(globalPath) ?? {}) as Record<string, unknown>;
	const projectSettings = (loadPiSettingsFile(projectPath) ?? {}) as Record<string, unknown>;
	const settings = { ...globalSettings, ...projectSettings };
	const section = getSettingsSection(settings);
	return isTtsAliasEnabledFromSettings(section);
}


function getConfig(ctx: ExtensionCommandContext): PiperConfig | { error: string } {
	const settings = getPiSettings(ctx);
	const section = getSettingsSection(settings);

	const modelRaw = process.env.PIPER_PI_MODEL?.trim() || (section["piper-pi-model"] ? String(section["piper-pi-model"]) : "").trim();
	const model = modelRaw ? expandPath(modelRaw) : "";
	if (!model) {
		return { error: "Missing Piper model. Set PIPER_PI_MODEL (env) or settings.json 'pi-tts-command.piper-pi-model'." };
	}

	const binFromEnv = process.env.PIPER_PI_BIN?.trim();
	const binFromSettings = section["piper-pi-bin"] ? String(section["piper-pi-bin"]).trim() : "";
	const binSpec = binFromEnv || binFromSettings || DEFAULT_PIPER_COMMAND;

	const binParts = parseCommandLine(binSpec || "");
	if (binParts.length === 0) {
		return { error: "PIPER_PI_BIN / settings.json piper-pi-bin is empty." };
	}

	const command = binParts[0];
	const runnerArgs = binParts.length > 1 ? binParts.slice(1) : [];

	let extraArgs: string[] = [];
	const envExtraArgs = process.env.PIPER_PI_EXTRA_ARGS?.trim();
	if (envExtraArgs) {
		extraArgs = parseCommandLine(envExtraArgs);
	} else {
		const fromSettings = section["piper-pi-extra-args"];
		const settingsExtraArgs = fromSettings ? String(fromSettings).trim() : "";
		extraArgs = settingsExtraArgs ? parseCommandLine(settingsExtraArgs) : [];
	}

	const dataDirRaw = process.env.PIPER_PI_DATA_DIR?.trim() || (section["piper-pi-data-dir"] ? String(section["piper-pi-data-dir"]) : "").trim();
	const dataDir = dataDirRaw ? expandPath(dataDirRaw) : undefined;

	const maxCharsRaw = process.env.PIPER_PI_MAX_CHARS?.trim() || (section["piper-pi-max-chars"] !== undefined ? String(section["piper-pi-max-chars"]) : "").trim();
	const maxCharsParsed = maxCharsRaw ? Number.parseInt(maxCharsRaw, 10) : undefined;
	const maxChars = maxCharsParsed !== undefined && Number.isFinite(maxCharsParsed) && maxCharsParsed > 0 ? maxCharsParsed : undefined;

	if (maxCharsRaw && maxChars === undefined) {
		return { error: "PIPER_PI_MAX_CHARS must be a positive integer." };
	}

	// Back-compat: if runner was only the python command, use the old default args.
	if (command === DEFAULT_PIPER_COMMAND && runnerArgs.length === 0) {
		runnerArgs.push(...DEFAULT_PIPER_COMMAND_ARGS);
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

function extractSpokenText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}

		const candidate = block as ContentBlock;
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(candidate.text);
		}
	}

	return parts.join(" ");
}

function normalizeSpeechText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}

	return {
		text: text.slice(0, maxChars).trimEnd(),
		truncated: true,
	};
}

function findLatestAssistantMessage(branch: SessionEntry[]): SessionEntry | undefined {
	return [...branch].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
}

function formatExecError(command: string, error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (/ENOENT|not found/i.test(message)) {
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

	if (/No module named piper|ModuleNotFoundError/i.test(output)) {
		return "Piper is not installed. Install it with: pip install piper-tts";
	}

	if (/model|voice|file|No such file|cannot find/i.test(output)) {
		return `Piper could not load the configured voice/model. Check PIPER_PI_MODEL and download the voice.\n\n--- Piper stderr/stdout ---\n${output}`;
	}

	return output;
}

export default function (pi: ExtensionAPI) {
	const speakLatestAssistant: ExtensionAPI["registerCommand"] extends (...args: any[]) => any
		? (_args: unknown, ctx: ExtensionCommandContext) => Promise<void>
		: never = async (_args: unknown, ctx: ExtensionCommandContext) => {
		await ctx.waitForIdle();

		const config = getConfig(ctx);
		if ("error" in config) {
			notify(ctx, config.error, "error");
			return;
		}

		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const latestAssistant = findLatestAssistantMessage(branch);

		if (!latestAssistant) {
			notify(ctx, "No assistant message to speak yet.", "warning");
			return;
		}

		let text = normalizeSpeechText(extractSpokenText(latestAssistant.message?.content));
		if (!text) {
			notify(ctx, "Latest assistant message contains no spoken text.", "warning");
			return;
		}

		if (config.maxChars && text.length > config.maxChars) {
			const truncated = truncateText(text, config.maxChars);
			text = truncated.text;
			if (truncated.truncated) {
				notify(ctx, `Latest assistant message was truncated to ${config.maxChars} characters for speech.`, "warning");
			}
		}

		// Validate model path early so we can show a precise error.
		if (!existsSync(config.model)) {
			notify(ctx, `Piper model file not found at: ${config.model}`, "error");
			return;
		}

		// Piper usually expects a sibling JSON config next to the ONNX.
		const modelJsonPath = `${config.model}.json`;
		if (!existsSync(modelJsonPath)) {
			notify(ctx, `Piper voice config JSON not found at: ${modelJsonPath} (piper guesses this automatically).`, "error");
			return;
		}

		notify(ctx, "Speaking latest assistant message...", "info");

		const args = [
			...config.args,
			...(config.dataDir ? ["--data-dir", config.dataDir] : []),
			"-m",
			config.model,
			...config.extraArgs,
			"--",
			text,
		];

		try {
			// Helpful hint when debugging Piper configuration issues.
			if (process.env.PIPER_PI_TTS_DEBUG === "1") {
				notify(ctx, `Piper config: command=${config.command} args=${JSON.stringify(args)}`, "info");
			}

			const result = await pi.exec(config.command, args, {
				signal: ctx.signal,
			});

			if (result.code !== 0) {
				const output = (result.stderr || result.stdout || "").toString();

				// Piper uses ffplay for playback; for long utterances it can exceed
				// Piper's internal 5s wait timeout and throw a TimeoutExpired.
				if (/ffplay/i.test(output) && /(timed out|TimeoutExpired)/i.test(output)) {
					notify(ctx, "Piper playback timed out; retrying by rendering WAV then playing it.", "warning");

					const wavPath = join(tmpdir(), `pi-tts-${randomUUID()}.wav`);
					const wavArgs = [
						...config.args,
						...(config.dataDir ? ["--data-dir", config.dataDir] : []),
						"-m",
						config.model,
						...config.extraArgs,
						"-f",
						wavPath,
						"--",
						text,
					];

					const renderResult = await pi.exec(config.command, wavArgs, {
						signal: ctx.signal,
					});

					if (renderResult.code !== 0) {
						const renderOutput = (renderResult.stderr || renderResult.stdout || "").toString();
						const errorMessage = formatSubprocessFailure(renderOutput, config.command);
						notify(ctx, errorMessage, "error");
						return;
					}

					// Play the generated WAV.
					try {
						const ffplayResult = await pi.exec(
							"ffplay",
							["-nodisp", "-autoexit", "-loglevel", "quiet", wavPath],
							{ signal: ctx.signal }
						);

						if (ffplayResult.code !== 0) {
							notify(ctx, `ffplay failed with exit code ${ffplayResult.code}.`, "error");
							return;
						}
					} catch {
						notify(ctx, "ffplay failed. Is ffmpeg/ffplay installed and on PATH?", "error");
						return;
					}

					notify(ctx, "Spoken latest assistant message.", "info");
					return;
				}

				const errorMessage = formatSubprocessFailure(output, config.command);
				notify(ctx, errorMessage, "error");
				return;
			}

			notify(ctx, "Spoken latest assistant message.", "info");
		} catch (error) {
			notify(ctx, formatExecError(config.command, error), "error");
		}
	};

	pi.registerCommand("piper-tts", {
		description: "Speak the latest assistant message",
		handler: speakLatestAssistant,
	});

	// Convenience alias: Pi users often expect `/tts`.
	// If disabled, we do NOT register the command at all.
	if (isTtsAliasEnabledAtLoad()) {
		pi.registerCommand("tts", {
			description: "Alias for /piper-tts",
			handler: speakLatestAssistant,
		});
	}
}

