/**
 * Drafts a short Claude Code-style recap after the user has been away.
 * See README.md for triggers, settings, flags, and model selection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Message, Model as AiModel } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getAgentDir,
	type ContextEditEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type ProjectedSessionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Text,
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

type Model = AiModel<Api>;

type RecapContext = {
	messages: Message[];
	broaderContext?: string;
};

type RecapReason = "idle" | "manual" | "resume" | "focus";

const RECAP_KEY = "session-recap";

const DEFAULT_AWAY_SECONDS = 90;
const DEFAULT_IDLE_SECONDS = 120;
const ANTHROPIC_RECAP_MODEL = "claude-haiku-4-5";
// Native Anthropic model ids. Providers that route to Claude under their own
// namespace (OpenRouter's `anthropic/claude-...`) do not match.
const CLAUDE_MODEL_ID = /^claude-/;
const GPT_MODEL_ID = /(?:^|\/)gpt-/;
// In order of preference: GPT-6 Luna, then GPT-5.6 Luna on providers that do
// not offer GPT-6 Luna.
const LUNA_RECAP_MODELS = [/(?:^|\/)gpt-6-luna(?:$|[@:])/, /(?:^|\/)gpt-5[.-]6-luna(?:$|[@:])/];

// Debounce after a turn ends while blurred, so mid-loop turn_ends (which are
// immediately followed by the next turn_start) don't trigger drafts.
const POST_TURN_DEBOUNCE_MS = 3000;

// `streamSimple` cannot express "reasoning off": its `reasoning` option only
// accepts real thinking levels. Omitting it disables thinking on every API we
// use except openai-codex-responses, which sends no reasoning field at all and
// so inherits the server-side default. Those models go through `stream` with
// an explicit `reasoningEffort: "none"` instead.
const NEEDS_EXPLICIT_REASONING_OFF = new Set(["openai-codex-responses"]);

// `maxTokens` caps the recap text. Where reasoning is drawn from the same cap,
// a recap with `thinking` on gets this allowance on top, so the answer is not
// crowded out and discarded as cut off. The values are pi-ai's own default
// thinking budgets (DEFAULT_THINKING_BUDGETS, not exported), which pi-ai adds on
// top of the cap itself for the APIs below. tests/pi-ai-budgets.test.mjs checks
// both against the installed pi-ai.
export const REASONING_ALLOWANCE = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;
export const THINKING_BUDGET_ADDED_BY_PI_AI: ReadonlySet<string> = new Set([
	"anthropic-messages",
	"bedrock-converse-stream",
]);

const RECENT_MESSAGE_WINDOW = 30;
const DEFAULT_MAX_TOKENS = 256;
const MIN_ASSISTANT_WORDS = 30;
const INITIAL_TASK_EDGE_CHARS = 4000;
const TOOL_RESULT_EDGE_CHARS = 2000;

// DECSET 1004 focus reporting — https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

// ---------------------------------------------------------------------------
// Configuration: `<agent dir>/session-recap.json`, written by `/recap-config`.
// Command-line flags override it for one launch.
// ---------------------------------------------------------------------------

const CONFIG_FILE = "session-recap.json";
const RECAP_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
type RecapThinking = (typeof RECAP_THINKING_LEVELS)[number];

type IntegerRange = readonly [min: number, max: number];
const SECONDS_RANGE: IntegerRange = [5, 86_400];
const RECENT_MESSAGES_RANGE: IntegerRange = [1, 200];
const MAX_TOKENS_RANGE: IntegerRange = [64, 8192];

export interface RecapConfig {
	/** Recap model. Absent selects automatically (see `selectRecapModel`). */
	model?: { provider: string; model: string };
	/** Reasoning level for the recap request. Absent means reasoning off. */
	thinking?: RecapThinking;
	awaySeconds?: number;
	idleSeconds?: number;
	/** Automatic recaps: away timer, turn end while away, idle fallback. */
	autoRecap?: boolean;
	/** Recap automatically on `/resume` and `/fork`. Needs `autoRecap`. */
	recapOnResume?: boolean;
	duringActive?: boolean;
	/** Recent conversation messages sent with the recap request. */
	recentMessages?: number;
	/** Token cap for the recap text. Reasoning gets its own allowance; see `recapMaxTokens`. */
	maxTokens?: number;
}

/** Configuration after flags and defaults are applied. */
export interface RecapSettings {
	/** `provider/id`, or undefined for automatic selection. */
	model?: string;
	thinking?: RecapThinking;
	awaySeconds: number;
	idleSeconds: number;
	autoRecap: boolean;
	recapOnResume: boolean;
	duringActive: boolean;
	focusReporting: boolean;
	recentMessages: number;
	maxTokens: number;
}

type FlagReader = (name: string) => boolean | string | undefined;

export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

const isIntegerInRange = (value: unknown, [min, max]: IntegerRange): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Validate a parsed config file. Invalid or unknown settings are dropped with a warning. */
export function parseConfig(raw: unknown): { config: RecapConfig; warnings: string[] } {
	const config: RecapConfig = {};
	const warnings: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, warnings: ["the file is not a JSON object; using defaults"] };
	}
	for (const [key, value] of Object.entries(raw)) {
		const invalid = (expected: string) => warnings.push(`${key} must be ${expected}; ignoring it`);
		const integer = (range: IntegerRange) => {
			if (isIntegerInRange(value, range)) return value;
			invalid(`an integer from ${range[0]} to ${range[1]}`);
			return undefined;
		};
		switch (key) {
			case "model": {
				const model = value as { provider?: unknown; model?: unknown } | null;
				if (
					model !== null &&
					typeof model === "object" &&
					typeof model.provider === "string" &&
					model.provider.length > 0 &&
					typeof model.model === "string" &&
					model.model.length > 0
				) {
					config.model = { provider: model.provider, model: model.model };
				} else {
					invalid('{ "provider": "...", "model": "..." }');
				}
				break;
			}
			case "thinking":
				if (typeof value === "string" && (RECAP_THINKING_LEVELS as readonly string[]).includes(value)) {
					config.thinking = value as RecapThinking;
				} else {
					invalid(`one of ${RECAP_THINKING_LEVELS.join(", ")}`);
				}
				break;
			case "awaySeconds":
			case "idleSeconds":
				config[key] = integer(SECONDS_RANGE);
				break;
			case "recentMessages":
				config.recentMessages = integer(RECENT_MESSAGES_RANGE);
				break;
			case "maxTokens":
				config.maxTokens = integer(MAX_TOKENS_RANGE);
				break;
			case "autoRecap":
			case "recapOnResume":
			case "duringActive":
				if (typeof value === "boolean") config[key] = value;
				else invalid("true or false");
				break;
			default:
				warnings.push(`unknown setting ${key}; ignoring it`);
		}
	}
	for (const key of Object.keys(config) as Array<keyof RecapConfig>) {
		if (config[key] === undefined) delete config[key];
	}
	return { config, warnings };
}

/**
 * Read the config file. A missing file is an empty config. `unreadable` marks a
 * file that exists but cannot be read or parsed, which `/recap-config` must not
 * overwrite.
 */
export function loadConfig(path = configPath()): {
	config: RecapConfig;
	warnings: string[];
	unreadable?: true;
} {
	if (!existsSync(path)) return { config: {}, warnings: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { config: {}, warnings: [`cannot read ${path}: ${reason}`], unreadable: true };
	}
	const { config, warnings } = parseConfig(raw);
	return { config, warnings: warnings.map((warning) => `${path}: ${warning}`) };
}

export function saveConfig(config: RecapConfig, path = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Apply command-line flags over the config file, and defaults under both. */
export function resolveSettings(config: RecapConfig, getFlag: FlagReader): RecapSettings {
	const flagSeconds = (name: string): number | undefined => {
		const value = getFlag(name);
		if (value === undefined || value === "") return undefined;
		const seconds = Number(value);
		return Number.isFinite(seconds) ? Math.max(SECONDS_RANGE[0], seconds) : undefined;
	};
	const flagModel = String(getFlag("recap-model") ?? "").trim();
	return {
		model: flagModel || (config.model ? `${config.model.provider}/${config.model.model}` : undefined),
		thinking: config.thinking,
		awaySeconds: flagSeconds("recap-away-seconds") ?? config.awaySeconds ?? DEFAULT_AWAY_SECONDS,
		idleSeconds: flagSeconds("recap-idle-seconds") ?? config.idleSeconds ?? DEFAULT_IDLE_SECONDS,
		autoRecap: getFlag("recap-disable") ? false : (config.autoRecap ?? true),
		recapOnResume: config.recapOnResume ?? true,
		duringActive: getFlag("recap-during-active") ? true : (config.duringActive ?? false),
		focusReporting: !getFlag("recap-disable-focus"),
		recentMessages: config.recentMessages ?? RECENT_MESSAGE_WINDOW,
		maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

const OVERRIDE_FLAGS = [
	"recap-model",
	"recap-away-seconds",
	"recap-idle-seconds",
	"recap-disable",
	"recap-during-active",
] as const;

function activeOverrideFlags(getFlag: FlagReader): string[] {
	return OVERRIDE_FLAGS.filter((name) => {
		const value = getFlag(name);
		return value !== undefined && value !== false && value !== "";
	}).map((name) => `--${name}`);
}

// ---------------------------------------------------------------------------
// Picker for every choice in /recap-config. Pi's `ui.select` always opens on
// its first option, so pressing Enter through the dialogs changed settings,
// and it draws every option, so a long model list scrolls the terminal itself
// and hides the selection. Pi's own model selector needs its internal
// ModelRuntime, which extensions cannot reach.
// ---------------------------------------------------------------------------

export interface PickerItem {
	value: string;
	label: string;
}

export interface PickerOptions {
	/** Show a search line and filter as the user types. For long lists. */
	search?: boolean;
}

type PickerTheme = { fg(color: string, text: string): string; bold(text: string): string };

// The picker draws two borders, a title, the search line, a scroll-position
// line and a key hint around the list. Pi's footer and status lines stay
// below it, so those rows are kept free too.
const PICKER_CHROME_ROWS = 6;
const PICKER_RESERVED_ROWS = 6;
const PICKER_MIN_VISIBLE = 3;
const PICKER_MAX_VISIBLE = 15;
const PICKER_HINT = "↑↓ PgUp PgDn move • enter select • esc cancel";
const PICKER_SEARCH_HINT = `type to search • ${PICKER_HINT}`;

export function pickerVisibleRows(terminalRows: number): number {
	return Math.max(
		PICKER_MIN_VISIBLE,
		Math.min(PICKER_MAX_VISIBLE, terminalRows - PICKER_CHROME_ROWS - PICKER_RESERVED_ROWS),
	);
}

/**
 * A list that shows at most `pickerVisibleRows` items and scrolls inside that
 * window. It opens on `initialValue`, marked with a check, so Enter keeps it.
 */
export function createPicker(
	title: string,
	items: readonly PickerItem[],
	initialValue: string | undefined,
	theme: PickerTheme,
	terminalRows: () => number,
	done: (value: string | undefined) => void,
	{ search = false }: PickerOptions = {},
): Component & { focused: boolean; handleInput(data: string): void } {
	const input = new Input();
	input.focused = true;
	let filtered = [...items];
	let selected = Math.max(0, filtered.findIndex((item) => item.value === initialValue));

	const refilter = () => {
		const query = input.getValue();
		filtered = fuzzyFilter([...items], query, (item) => item.label);
		selected = query.trim() ? 0 : Math.max(0, filtered.findIndex((item) => item.value === initialValue));
	};
	const move = (delta: number, wrap: boolean) => {
		if (filtered.length === 0) return;
		const target = selected + delta;
		if (wrap) selected = (target + filtered.length) % filtered.length;
		else selected = Math.max(0, Math.min(filtered.length - 1, target));
	};

	return {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		render(width: number): string[] {
			const visible = pickerVisibleRows(terminalRows());
			const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), filtered.length - visible));
			const border = theme.fg("accent", "─".repeat(Math.max(1, width)));
			const lines = [border, theme.fg("accent", theme.bold(truncateToWidth(title, width)))];
			if (search) lines.push(...input.render(width));
			if (filtered.length === 0) lines.push(theme.fg("muted", "  No matches"));
			for (let i = start; i < Math.min(start + visible, filtered.length); i++) {
				const item = filtered[i]!;
				const mark = item.value === initialValue ? " ✓" : "";
				const text = truncateToWidth(`${i === selected ? "→ " : "  "}${item.label}${mark}`, width);
				lines.push(i === selected ? theme.fg("accent", text) : text);
			}
			lines.push(filtered.length > visible ? theme.fg("muted", `  (${selected + 1}/${filtered.length})`) : "");
			lines.push(theme.fg("dim", truncateToWidth(search ? PICKER_SEARCH_HINT : PICKER_HINT, width)), border);
			return lines;
		},
		invalidate() {
			input.invalidate();
		},
		handleInput(data: string) {
			// The user's own select bindings, as Pi's selectors use them.
			const keys = getKeybindings();
			if (keys.matches(data, "tui.select.cancel")) done(undefined);
			else if (keys.matches(data, "tui.select.confirm")) {
				const item = filtered[selected];
				if (item) done(item.value);
			} else if (keys.matches(data, "tui.select.up")) move(-1, true);
			else if (keys.matches(data, "tui.select.down")) move(1, true);
			else if (keys.matches(data, "tui.select.pageUp")) move(-pickerVisibleRows(terminalRows()), false);
			else if (keys.matches(data, "tui.select.pageDown")) move(pickerVisibleRows(terminalRows()), false);
			else if (search) {
				input.handleInput(data);
				refilter();
			}
		},
	};
}

type PickerUi = Pick<ExtensionContext["ui"], "select"> & Partial<Pick<ExtensionContext["ui"], "custom">>;

/**
 * Pick one item: the terminal-sized picker in the TUI, Pi's plain select
 * elsewhere (RPC mode cannot draw custom components). Plain select always
 * opens on its first option, so there the initial item is listed first.
 * Undefined on cancel.
 */
export async function pickItem(
	ui: PickerUi,
	tui: boolean,
	title: string,
	items: readonly PickerItem[],
	initialValue: string | undefined,
	options: PickerOptions = {},
): Promise<string | undefined> {
	if (tui && ui.custom) {
		return ui.custom<string | undefined>((host, theme, _keybindings, done) => {
			const picker = createPicker(title, items, initialValue, theme, () => host.terminal.rows, done, options);
			return {
				get focused() {
					return picker.focused;
				},
				set focused(value: boolean) {
					picker.focused = value;
				},
				render: (width: number) => picker.render(width),
				invalidate: () => picker.invalidate(),
				handleInput(data: string) {
					picker.handleInput(data);
					host.requestRender();
				},
			};
		});
	}
	const initial = items.filter((item) => item.value === initialValue);
	const ordered = [...initial, ...items.filter((item) => item.value !== initialValue)];
	const label = await ui.select(title, ordered.map((item) => item.label));
	return items.find((item) => item.label === label)?.value;
}

type ConfigUi = Pick<ExtensionContext["ui"], "select" | "input" | "notify"> &
	Partial<Pick<ExtensionContext["ui"], "custom">>;

const AUTOMATIC_MODEL =
	"automatic — Claude Haiku 4.5 for Claude, GPT-6 Luna for GPT, else the session model";

/**
 * Walk through every setting with Pi dialogs. Returns the complete new config,
 * or undefined when the first dialog is cancelled. Cancelling or leaving a
 * later answer empty keeps that setting. Settings equal to their default are
 * left out of the file.
 */
export async function configureInteractively(
	ui: ConfigUi,
	available: ReadonlyArray<{ provider: string; id: string }>,
	current: RecapConfig,
	tui = false,
): Promise<RecapConfig | undefined> {
	const next: RecapConfig = { ...current };

	const currentModel = current.model ? `${current.model.provider}/${current.model.model}` : undefined;
	const modelItems = [AUTOMATIC_MODEL, ...available.map((model) => `${model.provider}/${model.id}`)].map(
		(label) => ({ value: label, label }),
	);
	const modelPick = await pickItem(
		ui,
		tui,
		`session-recap: recap model [${currentModel ?? "automatic"}]`,
		modelItems,
		currentModel ?? AUTOMATIC_MODEL,
		{ search: true },
	);
	if (modelPick === undefined) return undefined;
	if (modelPick === AUTOMATIC_MODEL) {
		delete next.model;
	} else {
		const slash = modelPick.indexOf("/");
		next.model = { provider: modelPick.slice(0, slash), model: modelPick.slice(slash + 1) };
	}

	const thinkingPick = await pickItem(
		ui,
		tui,
		`session-recap: thinking [${current.thinking ?? "off"}]`,
		["off", ...RECAP_THINKING_LEVELS].map((level) => ({ value: level, label: level })),
		current.thinking ?? "off",
	);
	if (thinkingPick === "off") delete next.thinking;
	else if (thinkingPick !== undefined) next.thinking = thinkingPick as RecapThinking;

	const askInteger = async (
		key: "awaySeconds" | "idleSeconds" | "recentMessages" | "maxTokens",
		title: string,
		range: IntegerRange,
		fallback: number,
	) => {
		const shown = current[key] ?? fallback;
		const answer = (await ui.input(`session-recap: ${title} [${shown}]`, String(shown)))?.trim();
		if (!answer) return;
		const value = Number(answer);
		if (!isIntegerInRange(value, range)) {
			ui.notify(
				`session-recap: ${title} must be an integer from ${range[0]} to ${range[1]}; keeping ${shown}`,
				"warning",
			);
			return;
		}
		if (value === fallback) delete next[key];
		else next[key] = value;
	};
	const askToggle = async (
		key: "autoRecap" | "recapOnResume" | "duringActive",
		title: string,
		fallback: boolean,
		on: string,
		off: string,
	) => {
		const currentValue = current[key] ?? fallback;
		const answer = await pickItem(
			ui,
			tui,
			`session-recap: ${title} [${currentValue ? "on" : "off"}]`,
			[
				{ value: "on", label: `on — ${on}` },
				{ value: "off", label: `off — ${off}` },
			],
			currentValue ? "on" : "off",
		);
		if (answer === undefined) return;
		const value = answer === "on";
		if (value === fallback) delete next[key];
		else next[key] = value;
	};

	await askInteger("awaySeconds", "seconds away before a recap", SECONDS_RANGE, DEFAULT_AWAY_SECONDS);
	await askInteger(
		"idleSeconds",
		"idle seconds before a recap on terminals without focus reporting",
		SECONDS_RANGE,
		DEFAULT_IDLE_SECONDS,
	);
	await askToggle(
		"autoRecap",
		"automatic recaps",
		true,
		"recap when you have been away",
		"only /recap draws a recap",
	);
	await askToggle(
		"recapOnResume",
		"recap on /resume and /fork",
		true,
		"recap the session you resume or fork",
		"no recap on /resume or /fork",
	);
	await askToggle(
		"duringActive",
		"recap while the agent is running",
		false,
		"draft an away recap mid-turn",
		"wait until the agent finishes",
	);
	await askInteger("recentMessages", "recent messages sent with the request", RECENT_MESSAGES_RANGE, RECENT_MESSAGE_WINDOW);
	await askInteger(
		"maxTokens",
		"token cap for the recap text (reasoning is allowed for separately)",
		MAX_TOKENS_RANGE,
		DEFAULT_MAX_TOKENS,
	);

	return next;
}

function extractText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function findInitialTask(entries: SessionEntry[]): string | undefined {
	const edits = new Map<string, ContextEditEntry["replacement"]>();
	for (const entry of entries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	}

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const replacement = edits.get(entry.id);
		if (replacement === null) continue;
		const initialTask = extractText(replacement?.content ?? entry.message.content).trim();
		if (initialTask) return initialTask;
	}
	return undefined;
}

export function buildRecapContext(
	entries: ProjectedSessionEntry[],
	branchEntries: SessionEntry[],
	recentWindow = RECENT_MESSAGE_WINDOW,
): RecapContext {
	let summary: string | undefined;
	for (const { sourceEntry, messages } of entries) {
		if (sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary") continue;
		if (messages.length > 0) summary = sourceEntry.summary.trim() || summary;
	}
	const initialTask = findInitialTask(branchEntries);

	const messages = convertToLlm(
		entries
			.filter(({ sourceEntry }) => sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary")
			.flatMap((entry) => entry.messages),
	).map((message) => {
		if (message.role !== "toolResult") return message;
		return {
			...message,
			content: message.content.map((block) => {
				if (block.type !== "text" || block.text.length <= TOOL_RESULT_EDGE_CHARS * 2) return block;
				return {
					...block,
					text: `${block.text.slice(0, TOOL_RESULT_EDGE_CHARS)}\n… [tool result truncated for recap] …\n${block.text.slice(-TOOL_RESULT_EDGE_CHARS)}`,
				};
			}),
		};
	});
	let start = Math.max(0, messages.length - recentWindow);
	while (start > 0 && messages[start].role === "toolResult") start--;
	let recentMessages = messages.slice(start);
	if (recentMessages[0]?.role === "assistant") {
		recentMessages = [
			{
				role: "user",
				content: "(Earlier conversation omitted.)",
				timestamp: recentMessages[0].timestamp,
			},
			...recentMessages,
		];
	}

	const broader: string[] = [];
	const initialTaskInRecent = recentMessages.some(
		(message) => message.role === "user" && extractText(message.content).trim() === initialTask,
	);
	if (initialTask && !initialTaskInRecent) {
		const framedInitialTask =
			initialTask.length <= INITIAL_TASK_EDGE_CHARS * 2
				? initialTask
				: `${initialTask.slice(0, INITIAL_TASK_EDGE_CHARS)}\n… [middle of initial request omitted for recap] …\n${initialTask.slice(-INITIAL_TASK_EDGE_CHARS)}`;
		broader.push(`Initial user request:\n${framedInitialTask}`);
	}
	if (summary) broader.push(`Session summary:\n${summary}`);

	return {
		messages: recentMessages,
		broaderContext: broader.length > 0 ? broader.join("\n\n") : undefined,
	};
}

export function hasMeaningfulActivity(entries: ProjectedSessionEntry[]): boolean {
	const messages = convertToLlm(entries.flatMap((entry) => entry.messages));
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	const tail = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
	let assistantWords = 0;
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		if (message.content.some((block) => block.type === "toolCall")) return true;
		assistantWords += extractText(message.content).split(/\s+/).filter(Boolean).length;
	}
	return assistantWords >= MIN_ASSISTANT_WORDS;
}

export function selectRecapModel(
	activeModel: Model | undefined,
	overrideSpec: string | undefined,
	registry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable">,
): Model | undefined {
	if (overrideSpec) {
		const slash = overrideSpec.indexOf("/");
		if (slash <= 0) return activeModel;
		return registry.find(overrideSpec.slice(0, slash), overrideSpec.slice(slash + 1)) ?? activeModel;
	}
	if (!activeModel) return undefined;

	const available = registry
		.getAvailable()
		.filter((model) => model.provider === activeModel.provider);
	if (activeModel.provider === "anthropic" || CLAUDE_MODEL_ID.test(activeModel.id)) {
		return available.find((model) => model.id === ANTHROPIC_RECAP_MODEL) ?? activeModel;
	}
	if (!GPT_MODEL_ID.test(activeModel.id)) return activeModel;
	for (const luna of LUNA_RECAP_MODELS) {
		const match = available.find((model) => luna.test(model.id));
		if (match) return match;
	}
	return activeModel;
}

/**
 * The output cap sent with a recap request: `maxTokens` for the text, plus a
 * reasoning allowance where reasoning counts against the cap. Never above the
 * model's own output limit.
 */
export function recapMaxTokens(
	model: Pick<Model, "api" | "reasoning" | "maxTokens">,
	settings: Pick<RecapSettings, "thinking" | "maxTokens">,
): number {
	if (!settings.thinking || !model.reasoning || THINKING_BUDGET_ADDED_BY_PI_AI.has(model.api)) {
		return settings.maxTokens;
	}
	const total = settings.maxTokens + REASONING_ALLOWANCE[settings.thinking];
	return model.maxTokens > 0 ? Math.min(total, model.maxTokens) : total;
}

async function generateRecap(
	recapContext: RecapContext,
	ctx: ExtensionContext,
	settings: Pick<RecapSettings, "model" | "thinking" | "maxTokens">,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const model = selectRecapModel(ctx.model, settings.model, ctx.modelRegistry);
	if (!model) return undefined;

	// Ambient-auth providers can succeed without returning an API key.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) return undefined;

	const prompt =
		(recapContext.broaderContext
			? `Broader session context:\n${recapContext.broaderContext}\n\n`
			: "") +
		"The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
		"Start by stating the high-level task — what they are building or debugging, not " +
		"implementation details. Next: the concrete next step. Skip status reports and commit recaps.";

	const context = {
		systemPrompt: "",
		messages: [
			...recapContext.messages,
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		],
	};
	const options = {
		signal,
		cacheRetention: "none" as const,
		maxTokens: recapMaxTokens(model, settings),
	};

	// Dispatch through Pi's model runtime rather than pi-ai's standalone
	// `complete*`: the runtime resolves request auth and runs provider overrides
	// that extensions register, such as the OAuth request shaping an Anthropic
	// subscription needs. Reasoning stays off unless `thinking` is configured,
	// which keeps each away-timer fire cheap.
	const request = settings.thinking
		? ctx.modelRegistry.streamSimple(model, context, { ...options, reasoning: settings.thinking })
		: NEEDS_EXPLICIT_REASONING_OFF.has(model.api)
			? ctx.modelRegistry.stream(model, context, { ...options, reasoningEffort: "none" })
			: ctx.modelRegistry.streamSimple(model, context, options);
	const response = await request.result();

	// pi-ai resolves instead of throwing when a stream fails, is aborted, or stops
	// at the token cap: the message it hands back then holds only the text that
	// arrived before the cut. Half a sentence orients nobody, so draw a recap from
	// a whole response only.
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "the recap request failed mid-stream");
	}
	if (response.stopReason !== "stop") return undefined;

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	return text || undefined;
}

function clearRecap(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(RECAP_KEY, undefined);
	ctx.ui.setStatus(RECAP_KEY, undefined);
}

export function showRecap(ctx: ExtensionContext, recap: string) {
	const theme = ctx.ui.theme;
	const header = theme.fg("accent", theme.bold("✦ recap"));
	const body = theme.fg("dim", recap);
	const mounted: { tui?: TUI } = {};
	ctx.ui.setWidget(
		RECAP_KEY,
		(candidate) => {
			mounted.tui = candidate;
			return new Container();
		},
		{ placement: "belowEditor" },
	);

	// RPC mode never calls widget factories, so `tui` stays unset there. Pi
	// mounts the scrollable document as its first TUI child.
	const tui = mounted.tui;
	const document = tui?.children[0];
	if (!tui || tui.mode !== "fullscreen" || !(document instanceof Container)) {
		ctx.ui.setWidget(RECAP_KEY, [header, body], { placement: "aboveEditor" });
		return;
	}

	const content = new Container();
	content.addChild(new Text(header, 1, 0));
	content.addChild(new Text(body, 1, 0));
	const transcriptRecap: Component = {
		render: (width) => (tui.mode === "fullscreen" ? content.render(width) : []),
		invalidate: () => content.invalidate(),
	};
	document.addChild(transcriptRecap);

	ctx.ui.setWidget(
		RECAP_KEY,
		() => ({
			render: () => [],
			invalidate: () => {},
			dispose: () => document.removeChild(transcriptRecap),
		}),
		{ placement: "belowEditor" },
	);
}

export default function (pi: ExtensionAPI) {
	// No flag declares a default: an unset flag must read as undefined so the
	// config file applies beneath it.
	pi.registerFlag("recap-away-seconds", {
		description: `Seconds of continuous terminal blur before an away recap is generated (default ${DEFAULT_AWAY_SECONDS})`,
		type: "string",
	});
	pi.registerFlag("recap-idle-seconds", {
		description: `Idle-fallback: seconds after turn_end before a recap when the terminal doesn't report focus (default ${DEFAULT_IDLE_SECONDS})`,
		type: "string",
	});
	pi.registerFlag("recap-disable-focus", {
		description: "Disable DECSET ?1004 focus reporting (idle fallback still runs)",
		type: "boolean",
	});
	pi.registerFlag("recap-during-active", {
		description: "Allow away recaps while an agent turn is still running",
		type: "boolean",
	});
	pi.registerFlag("recap-disable", {
		description: "Disable the automatic session recap",
		type: "boolean",
	});
	pi.registerFlag("recap-model", {
		description: "Override the recap model, e.g. anthropic/claude-sonnet-4-6",
		type: "string",
	});

	let config: RecapConfig = {};
	const getFlag: FlagReader = (name) => pi.getFlag(name);
	const settings = (): RecapSettings => resolveSettings(config, getFlag);

	let idleTimer: NodeJS.Timeout | undefined;
	let awayTimer: NodeJS.Timeout | undefined;
	let postTurnTimer: NodeJS.Timeout | undefined;
	let activeController: AbortController | undefined;
	let agentActive = false;
	let awayRecapPending = false;
	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;
	let isBlurred = false;
	let focusEventsSeen = false;
	let lastDraftedContext: string | undefined;

	const isDisabled = (): boolean => !settings().autoRecap;

	const clearIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const clearAwayTimer = () => {
		if (awayTimer) {
			clearTimeout(awayTimer);
			awayTimer = undefined;
		}
	};
	const clearPostTurnTimer = () => {
		if (postTurnTimer) {
			clearTimeout(postTurnTimer);
			postTurnTimer = undefined;
		}
	};

	const cancelActive = () => {
		activeController?.abort();
		activeController = undefined;
	};

	const generateAndShow = async (ctx: ExtensionContext, reason: RecapReason) => {
		if (!ctx.hasUI) return;
		const projection = ctx.sessionManager.buildSessionProjection();
		if (reason !== "manual" && !hasMeaningfulActivity(projection.entries)) return;

		const current = settings();
		const recapContext = buildRecapContext(
			projection.entries,
			ctx.sessionManager.getBranch(),
			current.recentMessages,
		);
		if (recapContext.messages.length === 0 && !recapContext.broaderContext) return;

		const startContext = JSON.stringify(recapContext);
		if (reason !== "manual" && lastDraftedContext === startContext) return;

		cancelActive();
		const controller = new AbortController();
		activeController = controller;

		const showStatus = reason === "manual" || reason === "idle";
		if (showStatus) ctx.ui.setStatus(RECAP_KEY, ctx.ui.theme.fg("dim", "✦ drafting recap…"));

		try {
			const recap = await generateRecap(recapContext, ctx, current, controller.signal);
			if (!recap || controller.signal.aborted) return;
			const currentContext = buildRecapContext(
				ctx.sessionManager.buildSessionProjection().entries,
				ctx.sessionManager.getBranch(),
				current.recentMessages,
			);
			if (JSON.stringify(currentContext) !== startContext) return;

			lastDraftedContext = startContext;
			clearIdleTimer();
			clearPostTurnTimer();

			showRecap(ctx, recap);
		} catch (err) {
			// Report through the UI, never console.*: pi installs no console interception, so
			// an extension writing there puts raw text on the terminal mid-frame and mangles the
			// status bar it lands on. `generateAndShow` already returned early unless `ctx.hasUI`.
			if (!controller.signal.aborted) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`session-recap: ${message}`, "error");
			}
		} finally {
			if (activeController === controller) {
				activeController = undefined;
				if (showStatus) ctx.ui.setStatus(RECAP_KEY, undefined);
			}
		}
	};

	const tryAwayRecap = (ctx: ExtensionContext) => {
		if (isDisabled() || !ctx.hasUI || !isBlurred) return;
		if (agentActive && !settings().duringActive) {
			awayRecapPending = true;
			return;
		}
		if (!activeController) void generateAndShow(ctx, "focus");
	};

	const handleFocusOut = (ctx: ExtensionContext) => {
		focusEventsSeen = true;
		isBlurred = true;
		clearIdleTimer();
		if (isDisabled()) return;
		clearAwayTimer();
		awayTimer = setTimeout(() => {
			awayTimer = undefined;
			tryAwayRecap(ctx);
		}, settings().awaySeconds * 1000);
	};

	const handleFocusIn = () => {
		focusEventsSeen = true;
		isBlurred = false;
		awayRecapPending = false;
		clearAwayTimer();
		clearPostTurnTimer();
		clearIdleTimer();
		// Leave an in-flight recap to land as the user returns.
	};

	const attachFocusReporting = (ctx: ExtensionContext) => {
		if (focusEnabled || !settings().focusReporting || !ctx.hasUI) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;

		try {
			process.stdout.write(FOCUS_ENABLE);
		} catch {
			return;
		}

		// Focus sequences may straddle input chunks, so retain the unmatched tail.
		const MAX_SEQ = Math.max(FOCUS_IN_SEQ.length, FOCUS_OUT_SEQ.length);
		let buf = "";
		const listener = (chunk: Buffer) => {
			buf += chunk.toString("binary");
			let i = 0;
			while (i + MAX_SEQ <= buf.length) {
				if (buf.startsWith(FOCUS_IN_SEQ, i)) {
					handleFocusIn();
					i += FOCUS_IN_SEQ.length;
				} else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
					handleFocusOut(ctx);
					i += FOCUS_OUT_SEQ.length;
				} else {
					i++;
				}
			}
			buf = buf.slice(i);
		};
		process.stdin.on("data", listener);
		focusListener = listener;
		focusEnabled = true;
	};

	const detachFocusReporting = () => {
		if (focusListener) {
			process.stdin.off("data", focusListener);
			focusListener = undefined;
		}
		if (focusEnabled) {
			try {
				process.stdout.write(FOCUS_DISABLE);
			} catch {}
			focusEnabled = false;
		}
		isBlurred = false;
		awayRecapPending = false;
	};

	pi.on("turn_end", (_event, ctx) => {
		if (isDisabled() || !ctx.hasUI) return;

		// Debounce mid-loop turn_end → turn_start pairs.
		if (isBlurred) {
			clearPostTurnTimer();
			postTurnTimer = setTimeout(() => {
				postTurnTimer = undefined;
				tryAwayRecap(ctx);
			}, POST_TURN_DEBOUNCE_MS);
		}

		if (!focusEventsSeen) {
			clearIdleTimer();
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				if (!focusEventsSeen) void generateAndShow(ctx, "idle");
			}, settings().idleSeconds * 1000);
		}
	});

	pi.on("turn_start", () => {
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
	});

	pi.on("input", (_event, ctx) => {
		clearIdleTimer();
		clearPostTurnTimer();
		clearAwayTimer();
		cancelActive();
		awayRecapPending = false;
		clearRecap(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		agentActive = true;
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
		clearRecap(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		agentActive = false;
		if (awayRecapPending) {
			awayRecapPending = false;
			tryAwayRecap(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		agentActive = false;
		awayRecapPending = false;
		clearIdleTimer();
		clearAwayTimer();
		clearPostTurnTimer();
		cancelActive();
		detachFocusReporting();
	});

	pi.on("session_start", (event, ctx) => {
		const loaded = loadConfig();
		config = loaded.config;
		if (ctx.hasUI) {
			for (const warning of loaded.warnings) ctx.ui.notify(`session-recap: ${warning}`, "warning");
		}
		attachFocusReporting(ctx);
		if (isDisabled() || !settings().recapOnResume || !ctx.hasUI) return;
		if (event.reason === "resume" || event.reason === "fork") {
			setTimeout(() => {
				void generateAndShow(ctx, "resume");
			}, 300);
		}
	});

	pi.registerCommand("recap", {
		description: "Generate a recap of recent session activity",
		handler: (_args, ctx) => generateAndShow(ctx, "manual"),
	});

	pi.registerCommand("recap-config", {
		description: "Configure session-recap: model, thinking, delays, triggers and request size",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const loaded = loadConfig();
			if (loaded.unreadable) {
				ctx.ui.notify(
					`session-recap: ${loaded.warnings.join("; ")}. Fix or delete the file, then run /recap-config again.`,
					"error",
				);
				return;
			}
			const next = await configureInteractively(
				ctx.ui,
				ctx.modelRegistry.getAvailable(),
				loaded.config,
				ctx.mode === "tui",
			);
			if (!next) return;
			try {
				saveConfig(next);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`session-recap: cannot save ${configPath()}: ${reason}`, "error");
				return;
			}
			config = next;

			const model = selectRecapModel(ctx.model, settings().model, ctx.modelRegistry);
			const uses = model ? `${model.provider}/${model.id}` : "the session model";
			ctx.ui.notify(`session-recap: saved ${configPath()}. Recaps in this session use ${uses}.`, "info");
			const overrides = activeOverrideFlags(getFlag);
			if (overrides.length > 0) {
				ctx.ui.notify(
					`session-recap: ${overrides.join(", ")} on the command line still override the saved settings.`,
					"warning",
				);
			}
		},
	});
}
