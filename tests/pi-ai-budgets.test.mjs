// recapMaxTokens mirrors two facts about pi-ai that pi-ai does not export: its
// default thinking budgets, and which APIs add that budget on top of maxTokens
// themselves. Both are read from the installed pi-ai here, so an upgrade that
// changes either fails this test instead of silently skewing the recap cap.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REASONING_ALLOWANCE, THINKING_BUDGET_ADDED_BY_PI_AI } from "../index.ts";

// Resolved like any import, so it also works from the packed copy of these
// tests that verify:tarball runs. The package root entry sits in dist/.
const apiDir = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "api");

test("the reasoning allowance equals pi-ai's default thinking budgets", async () => {
	const { DEFAULT_THINKING_BUDGETS } = await import(pathToFileURL(join(apiDir, "simple-options.js")).href);
	assert.ok(DEFAULT_THINKING_BUDGETS, "pi-ai no longer defines DEFAULT_THINKING_BUDGETS where expected");
	assert.deepEqual({ ...REASONING_ALLOWANCE }, { ...DEFAULT_THINKING_BUDGETS });
});

test("the APIs that add the budget themselves are the ones calling adjustMaxTokensForThinking", () => {
	const callers = readdirSync(apiDir)
		.filter((file) => file.endsWith(".js") && file !== "simple-options.js")
		.filter((file) => readFileSync(join(apiDir, file), "utf-8").includes("adjustMaxTokensForThinking("))
		.map((file) => file.replace(/\.js$/, ""))
		.sort();
	assert.ok(callers.length > 0, "found no caller at all, so the scan itself is broken");
	assert.deepEqual(callers, [...THINKING_BUDGET_ADDED_BY_PI_AI].sort());
});
