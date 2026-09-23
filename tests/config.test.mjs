import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sessionRecap, {
	configureInteractively,
	loadConfig,
	parseConfig,
	recapMaxTokens,
	resolveSettings,
	saveConfig,
} from "../index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "recap-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rmSync(agentDir, { recursive: true, force: true }));
// The extension's own settings file. Tests that touch it write or remove it
// first, so none depends on what an earlier test left behind.
const configFile = join(agentDir, "session-recap.json");

const noFlags = () => undefined;
const flags = (values) => (name) => values[name];

test("a valid config file parses without warnings", () => {
	const raw = {
		model: { provider: "anthropic", model: "claude-sonnet-5" },
		thinking: "low",
		awaySeconds: 30,
		idleSeconds: 600,
		autoRecap: false,
		recapOnResume: false,
		duringActive: true,
		recentMessages: 12,
		maxTokens: 512,
	};
	assert.deepEqual(parseConfig(raw), { config: raw, warnings: [] });
});

test("invalid and unknown settings are dropped with one warning each", () => {
	const { config, warnings } = parseConfig({
		model: "anthropic/claude-sonnet-5",
		thinking: "max",
		awaySeconds: 2,
		recentMessages: 1.5,
		maxTokens: "512",
		autoRecap: "yes",
		colour: "blue",
		idleSeconds: 60,
	});
	assert.deepEqual(config, { idleSeconds: 60 });
	assert.equal(warnings.length, 7);
	assert.ok(warnings.some((warning) => warning.startsWith("unknown setting colour")));
});

test("a file that is not a JSON object yields defaults", () => {
	assert.deepEqual(parseConfig([1, 2]).config, {});
	assert.equal(parseConfig(null).warnings.length, 1);
});

test("a missing file is an empty config; a malformed one is marked unreadable", () => {
	const missing = loadConfig(join(agentDir, "missing.json"));
	assert.deepEqual(missing, { config: {}, warnings: [] });

	const broken = join(agentDir, "broken.json");
	writeFileSync(broken, "{ not json");
	const loaded = loadConfig(broken);
	assert.equal(loaded.unreadable, true);
	assert.deepEqual(loaded.config, {});
});

test("saveConfig writes a file that loadConfig reads back", () => {
	const path = join(agentDir, "nested", "roundtrip.json");
	const config = { thinking: "medium", awaySeconds: 45 };
	saveConfig(config, path);
	assert.deepEqual(loadConfig(path), { config, warnings: [] });
});

test("defaults apply when neither the file nor a flag sets a value", () => {
	assert.deepEqual(resolveSettings({}, noFlags), {
		model: undefined,
		thinking: undefined,
		awaySeconds: 90,
		idleSeconds: 120,
		autoRecap: true,
		recapOnResume: true,
		duringActive: false,
		focusReporting: true,
		recentMessages: 30,
		maxTokens: 256,
	});
});

test("the config file applies beneath unset flags", () => {
	const settings = resolveSettings(
		{ model: { provider: "openai", model: "gpt-5.6-luna" }, awaySeconds: 30, autoRecap: false },
		noFlags,
	);
	assert.equal(settings.model, "openai/gpt-5.6-luna");
	assert.equal(settings.awaySeconds, 30);
	assert.equal(settings.autoRecap, false);
});

test("command-line flags override the config file", () => {
	const settings = resolveSettings(
		{ model: { provider: "openai", model: "gpt-5.6-luna" }, awaySeconds: 30, idleSeconds: 60, duringActive: false },
		flags({
			"recap-model": "anthropic/claude-haiku-4-5",
			"recap-away-seconds": "15",
			"recap-idle-seconds": "not a number",
			"recap-disable": true,
			"recap-during-active": true,
			"recap-disable-focus": true,
		}),
	);
	assert.equal(settings.model, "anthropic/claude-haiku-4-5");
	assert.equal(settings.awaySeconds, 15);
	assert.equal(settings.idleSeconds, 60, "an unparsable flag falls back to the config file");
	assert.equal(settings.autoRecap, false);
	assert.equal(settings.duringActive, true);
	assert.equal(settings.focusReporting, false);
	assert.equal(resolveSettings({}, flags({ "recap-away-seconds": "1" })).awaySeconds, 5);
});

function scriptedUi(answers) {
	const asked = [];
	const notices = [];
	const next = (kind, title, options) => {
		asked.push({ kind, title, options });
		assert.ok(answers.length > 0, `unexpected ${kind} dialog: ${title}`);
		const answer = answers.shift();
		return typeof answer === "function" ? answer(options) : answer;
	};
	return {
		asked,
		notices,
		ui: {
			select: async (title, options) => next("select", title, options),
			input: async (title) => next("input", title),
			notify: (message, type) => notices.push([message, type]),
		},
	};
}

const available = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "openrouter", id: "google/gemini-3-flash" },
];
const pick = (prefix) => (options) => options.find((option) => option.startsWith(prefix));

test("the dialogs build a config and leave defaults out of it", async () => {
	const { ui, asked } = scriptedUi([
		"openrouter/google/gemini-3-flash",
		"low",
		"45",
		"120",
		pick("on"),
		pick("off"),
		pick("on"),
		"20",
		"256",
	]);
	const next = await configureInteractively(ui, available, {});
	assert.deepEqual(next, {
		model: { provider: "openrouter", model: "google/gemini-3-flash" },
		thinking: "low",
		awaySeconds: 45,
		recapOnResume: false,
		duringActive: true,
		recentMessages: 20,
	});
	assert.equal(asked.length, 9);
	assert.deepEqual(asked[0].options.slice(1), ["anthropic/claude-haiku-4-5", "openrouter/google/gemini-3-flash"]);
});

test("cancelling the first dialog cancels the whole walkthrough", async () => {
	const { ui, asked } = scriptedUi([undefined]);
	assert.equal(await configureInteractively(ui, available, { awaySeconds: 30 }), undefined);
	assert.equal(asked.length, 1);
});

test("empty or cancelled answers keep settings; automatic and off clear them", async () => {
	const current = {
		model: { provider: "anthropic", model: "claude-haiku-4-5" },
		thinking: "high",
		awaySeconds: 30,
		autoRecap: false,
		maxTokens: 512,
	};
	const { ui } = scriptedUi([
		pick("automatic"),
		"off",
		"",
		undefined,
		undefined,
		undefined,
		undefined,
		"",
		undefined,
	]);
	assert.deepEqual(await configureInteractively(ui, available, current), {
		awaySeconds: 30,
		autoRecap: false,
		maxTokens: 512,
	});
});

test("an out-of-range answer warns and keeps the current value", async () => {
	const { ui, notices } = scriptedUi([
		pick("automatic"),
		undefined,
		"3",
		undefined,
		undefined,
		undefined,
		undefined,
		"abc",
		undefined,
	]);
	assert.deepEqual(await configureInteractively(ui, available, { awaySeconds: 30 }), { awaySeconds: 30 });
	assert.equal(notices.length, 2);
	assert.ok(notices.every(([, type]) => type === "warning"));
});

function makePi(flagValues = {}) {
	const commands = new Map();
	const handlers = new Map();
	return {
		commands,
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag() {},
		getFlag(name) {
			return flagValues[name];
		},
	};
}

const branch = [
	{ type: "message", message: { role: "user", content: "Please fix the bridge integration." } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "I inspected the integration and prepared the next change." }],
		},
	},
];

function model(provider, id, api = "anthropic-messages") {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "http://localhost.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function makeCtx(ui, calls, { active = model("anthropic", "claude-opus-5-5"), entries = branch } = {}) {
	const models = [active, model("anthropic", "claude-sonnet-5")];
	const record = (kind) => (requestModel, context, options) => {
		calls.push({ kind, model: `${requestModel.provider}/${requestModel.id}`, context, options });
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "Recap text." }],
				stopReason: "stop",
			}),
		};
	};
	return {
		hasUI: true,
		model: active,
		modelRegistry: {
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			stream: record("stream"),
			streamSimple: record("streamSimple"),
		},
		sessionManager: {
			buildSessionProjection: () => ({
				entries: entries.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })),
			}),
			getBranch: () => entries,
		},
		ui: {
			setStatus() {},
			notify() {},
			setWidget(_key, content) {
				if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
			},
			theme: { fg: (_n, t) => t, bold: (t) => t },
			...ui,
		},
	};
}

/** Save `config`, start a session with it, and return the recorded requests. */
function startSession(config, ctxOptions, reason = "startup") {
	saveConfig(config, configFile);
	const pi = makePi();
	sessionRecap(pi);
	const calls = [];
	const ctx = makeCtx({}, calls, ctxOptions);
	pi.handlers.get("session_start")({ reason }, ctx);
	return { pi, ctx, calls };
}

test("thinking on a Codex model uses streamSimple with a reasoning level", async () => {
	const { pi, ctx, calls } = startSession(
		{ thinking: "low" },
		{ active: model("openai-codex", "gpt-6-luna", "openai-codex-responses") },
	);
	await pi.commands.get("recap").handler("", ctx);
	assert.equal(calls[0].kind, "streamSimple", "thinking replaces the explicit reasoning-off stream() path");
	assert.equal(calls[0].options.reasoning, "low");
	assert.equal(calls[0].options.reasoningEffort, undefined);
	assert.equal(calls[0].options.maxTokens, 256 + 2048, "the default text cap plus the low reasoning allowance");
});

test("recapMaxTokens adds a reasoning allowance only where reasoning shares the cap", () => {
	const responses = { api: "openai-responses", reasoning: true, maxTokens: 128_000 };
	assert.equal(recapMaxTokens(responses, { maxTokens: 256 }), 256, "no thinking, no allowance");
	assert.equal(recapMaxTokens(responses, { thinking: "minimal", maxTokens: 256 }), 256 + 1024);
	assert.equal(recapMaxTokens(responses, { thinking: "medium", maxTokens: 512 }), 512 + 8192);
	assert.equal(recapMaxTokens(responses, { thinking: "high", maxTokens: 256 }), 256 + 16384);
	for (const api of ["anthropic-messages", "bedrock-converse-stream"]) {
		assert.equal(
			recapMaxTokens({ api, reasoning: true, maxTokens: 64_000 }, { thinking: "high", maxTokens: 256 }),
			256,
			`pi-ai adds the thinking budget itself on ${api}`,
		);
	}
	assert.equal(
		recapMaxTokens({ ...responses, reasoning: false }, { thinking: "high", maxTokens: 256 }),
		256,
		"a model that cannot reason ignores the thinking level",
	);
	assert.equal(
		recapMaxTokens({ ...responses, maxTokens: 4096 }, { thinking: "high", maxTokens: 256 }),
		4096,
		"never above the model's own output limit",
	);
});

test("recentMessages narrows the conversation sent with the request", async () => {
	const narrow = startSession({ recentMessages: 1 });
	await narrow.pi.commands.get("recap").handler("", narrow.ctx);
	assert.equal(narrow.calls[0].context.messages[0].content, "(Earlier conversation omitted.)");

	const full = startSession({});
	await full.pi.commands.get("recap").handler("", full.ctx);
	assert.equal(full.calls[0].context.messages[0].content, "Please fix the bridge integration.");
});

const activeBranch = [
	branch[0],
	{
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "bridge.ts" } }],
		},
	},
];
const afterResumeDelay = () => new Promise((resolve) => setTimeout(resolve, 500));

test("recapOnResume controls the recap on /resume", async () => {
	const on = startSession({}, { entries: activeBranch }, "resume");
	await afterResumeDelay();
	assert.equal(on.calls.length, 1, "the default recaps a resumed session");

	const off = startSession({ recapOnResume: false }, { entries: activeBranch }, "resume");
	await afterResumeDelay();
	assert.equal(off.calls.length, 0, "recapOnResume: false skips it");
});

test("/recap-config saves the file and the next recap uses it", async () => {
	rmSync(configFile, { force: true });
	const pi = makePi();
	sessionRecap(pi);
	const calls = [];
	const notices = [];
	const { ui } = scriptedUi([
		"anthropic/claude-sonnet-5",
		"medium",
		"",
		"",
		undefined,
		undefined,
		undefined,
		"",
		"1024",
	]);
	const ctx = makeCtx({ ...ui, notify: (message, type) => notices.push([message, type]) }, calls);

	await pi.commands.get("recap-config").handler("", ctx);
	const saved = JSON.parse(readFileSync(configFile, "utf-8"));
	assert.deepEqual(saved, {
		model: { provider: "anthropic", model: "claude-sonnet-5" },
		thinking: "medium",
		maxTokens: 1024,
	});
	assert.match(notices[0][0], /Recaps in this session use anthropic\/claude-sonnet-5/);

	await pi.commands.get("recap").handler("", ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].kind, "streamSimple");
	assert.equal(calls[0].model, "anthropic/claude-sonnet-5");
	assert.equal(calls[0].options.reasoning, "medium");
	assert.equal(calls[0].options.maxTokens, 1024, "on Anthropic pi-ai adds the thinking budget, so the cap is sent as saved");
});

test("session_start loads the file and reports its warnings", async () => {
	writeFileSync(configFile, JSON.stringify({ thinking: "low", colour: "blue" }));
	const pi = makePi();
	sessionRecap(pi);
	const calls = [];
	const notices = [];
	const ctx = makeCtx({ notify: (message, type) => notices.push([message, type]) }, calls);

	pi.handlers.get("session_start")({ reason: "startup" }, ctx);
	assert.equal(notices.length, 1);
	assert.match(notices[0][0], /unknown setting colour/);
	assert.equal(notices[0][1], "warning");

	await pi.commands.get("recap").handler("", ctx);
	assert.equal(calls[0].model, "anthropic/claude-opus-5-5", "no Haiku is available, so the session model is used");
	assert.equal(calls[0].options.reasoning, "low");
});

test("/recap-config refuses to overwrite a file it cannot parse", async () => {
	writeFileSync(configFile, "{ not json");
	const pi = makePi();
	sessionRecap(pi);
	const notices = [];
	const { ui, asked } = scriptedUi([]);
	const ctx = makeCtx({ ...ui, notify: (message, type) => notices.push([message, type]) }, []);

	await pi.commands.get("recap-config").handler("", ctx);
	assert.equal(asked.length, 0);
	assert.equal(notices[0][1], "error");
	assert.equal(readFileSync(configFile, "utf-8"), "{ not json");
});

test("/recap-config warns about overriding flags", async () => {
	rmSync(configFile, { force: true });
	const pi = makePi({ "recap-model": "anthropic/claude-sonnet-5", "recap-disable-focus": true });
	sessionRecap(pi);
	const notices = [];
	const { ui } = scriptedUi([pick("automatic"), "low", "", "", undefined, undefined, undefined, "", ""]);
	const ctx = makeCtx({ ...ui, notify: (message, type) => notices.push([message, type]) }, []);

	await pi.commands.get("recap-config").handler("", ctx);
	assert.match(notices[0][0], /Recaps in this session use anthropic\/claude-sonnet-5/, "the flag decides the model");
	assert.deepEqual(
		notices.slice(1).map(([message, type]) => [message.replace(/^session-recap: /, "").split(" ")[0], type]),
		[["--recap-model", "warning"]],
		"only the overriding flag; --recap-disable-focus overrides no setting, and thinking needs no warning",
	);
});

// Every choice set away from its default, so a dialog that opens on its first
// option would change something when Enter is pressed.
const nonDefaults = {
	model: { provider: "openrouter", model: "google/gemini-3-flash" },
	thinking: "high",
	awaySeconds: 30,
	autoRecap: false,
	recapOnResume: false,
	duringActive: true,
	maxTokens: 512,
};

test("pressing Enter through every TUI dialog keeps the settings", async () => {
	const openedOn = [];
	const ui = {
		select: async () => assert.fail("the TUI must use the picker, which opens on the current value"),
		input: async () => "",
		notify: () => assert.fail("nothing to warn about"),
		custom: (factory) =>
			new Promise((resolve) => {
				const host = { terminal: { rows: 24 }, requestRender() {} };
				const component = factory(host, { fg: (_c, t) => t, bold: (t) => t }, {}, resolve);
				openedOn.push(component.render(100).find((line) => line.startsWith("→ ")));
				component.handleInput("\r");
			}),
	};
	assert.deepEqual(await configureInteractively(ui, available, nonDefaults, true), nonDefaults);
	assert.deepEqual(openedOn, [
		"→ openrouter/google/gemini-3-flash ✓",
		"→ high ✓",
		"→ off — only /recap draws a recap ✓",
		"→ off — no recap on /resume or /fork ✓",
		"→ on — draft an away recap mid-turn ✓",
	]);
});

test("pressing Enter through every select outside the TUI keeps the settings", async () => {
	const ui = {
		select: async (_title, options) => options[0],
		input: async () => "",
		notify: () => assert.fail("nothing to warn about"),
	};
	assert.deepEqual(await configureInteractively(ui, available, nonDefaults, false), nonDefaults);
});
