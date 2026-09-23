// Recaps must never spend reasoning tokens. `streamSimple` disables thinking
// for every API by omitting `reasoning`, except openai-codex-responses, which
// then inherits the server-side default — that api must get an explicit
// `reasoningEffort: "none"` through `stream`.
//
// Both go through `ctx.modelRegistry`, Pi's model runtime, which is where
// extension provider overrides run. pi-anthropic-auth shapes Anthropic OAuth
// requests there; a recap sent past it is billed as extra usage.
import assert from "node:assert/strict";
import sessionRecap from "../index.ts";

const calls = [];

function stubStream(kind) {
	return (model, _context, options) => {
		calls.push({ kind, api: model.api, options });
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "Recap text." }],
				stopReason: "stop",
			}),
		};
	};
}

function makePi() {
	const commands = new Map();
	const flags = new Map();
	return {
		commands,
		on() {},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerFlag(name, options) {
			flags.set(name, options.default);
		},
		getFlag(name) {
			return flags.get(name);
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

function makeCtx(model) {
	return {
		hasUI: true,
		model,
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "unused" }),
			stream: stubStream("stream"),
			streamSimple: stubStream("streamSimple"),
		},
		sessionManager: {
			buildSessionProjection: () => ({
				entries: branch.map((sourceEntry) => ({ sourceEntry, messages: [sourceEntry.message] })),
			}),
			getBranch: () => branch,
		},
		ui: {
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") content({ mode: "regular", children: [] }, this.theme);
			},
			theme: { fg: (_n, t) => t, bold: (t) => t },
		},
	};
}

function makeModel(api, id) {
	return {
		id,
		name: id,
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai-codex",
		baseUrl: "http://localhost.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

const pi = makePi();
sessionRecap(pi);
const recap = pi.commands.get("recap").handler;

await recap("", makeCtx(makeModel("openai-codex-responses", "gpt-5.6-luna")));
await recap("", makeCtx(makeModel("anthropic-messages", "claude-haiku-4-5")));

const codex = calls.find((c) => c.api === "openai-codex-responses");
const anthropic = calls.find((c) => c.api === "anthropic-messages");

assert.ok(codex, "codex recap should have issued a request through ctx.modelRegistry");
assert.equal(codex.kind, "stream", "codex recaps must use stream(), not streamSimple()");
assert.equal(codex.options.reasoningEffort, "none", "codex recaps must disable reasoning explicitly");

assert.ok(anthropic, "anthropic recap should have issued a request through ctx.modelRegistry");
assert.equal(anthropic.kind, "streamSimple", "other apis keep using streamSimple()");
assert.equal(
	anthropic.options.apiKey,
	undefined,
	"the runtime resolves request auth; a recap must not pin a key that bypasses it",
);
assert.equal(
	anthropic.options.reasoning,
	undefined,
	"omitting `reasoning` is what disables thinking on non-codex apis",
);
assert.equal(
	anthropic.options.reasoningEffort,
	undefined,
	"streamSimple has no reasoningEffort option — it would be silently dropped",
);

console.log("reasoning-off test passed");
