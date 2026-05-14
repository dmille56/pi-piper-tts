import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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

function getConfig(): PiperConfig | { error: string } {
	const model = process.env.PIPER_MODEL?.trim();
	if (!model) {
		return { error: "Missing PIPER_MODEL. Set it to a Piper voice/model path or identifier." };
	}

	const binSpec = process.env.PIPER_BIN?.trim();
	const binParts = parseCommandLine(binSpec || DEFAULT_PIPER_COMMAND);
	if (binParts.length === 0) {
		return { error: "PIPER_BIN is empty." };
	}

	const extraArgs = process.env.PIPER_EXTRA_ARGS?.trim()
		? parseCommandLine(process.env.PIPER_EXTRA_ARGS)
		: [];

	const maxCharsRaw = process.env.PIPER_MAX_CHARS?.trim();
	const maxChars = maxCharsRaw ? Number.parseInt(maxCharsRaw, 10) : undefined;
	if (maxCharsRaw && (!Number.isFinite(maxChars) || (maxChars ?? 0) <= 0)) {
		return { error: "PIPER_MAX_CHARS must be a positive integer." };
	}

	return {
		command: binParts[0],
		args: binSpec && binParts.length > 1 ? binParts.slice(1) : DEFAULT_PIPER_COMMAND_ARGS,
		model,
		dataDir: process.env.PIPER_DATA_DIR?.trim() || undefined,
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
		return `Piper could not load the configured voice/model. Check PIPER_MODEL and download the voice.`;
	}

	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tts", {
		description: "Speak the latest assistant message",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const config = getConfig();
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
				const result = await pi.exec(config.command, args, {
					signal: ctx.signal,
				});

				if (result.code !== 0) {
					const errorMessage = formatSubprocessFailure(result.stderr || result.stdout, config.command);
					notify(ctx, errorMessage, "error");
					return;
				}

				notify(ctx, "Spoken latest assistant message.", "info");
			} catch (error) {
				notify(ctx, formatExecError(config.command, error), "error");
			}
		},
	});
}
