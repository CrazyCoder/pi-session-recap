import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPicker, pickerVisibleRows, pickItem } from "../index.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const ESCAPE = "\x1b";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const items = Array.from({ length: 100 }, (_, i) => {
	const label = `provider-${i % 4}/model-${i}`;
	return { value: label, label };
});

function open(initialValue, rows = 24) {
	const results = [];
	const picker = createPicker("Pick a model", items, initialValue, theme, () => rows, (value) => results.push(value));
	const type = (...keys) => keys.forEach((key) => picker.handleInput(key));
	const selectedLine = () => picker.render(80).find((line) => line.startsWith("→ "));
	return { picker, results, type, selectedLine };
}

test("the picker never grows taller than the terminal", () => {
	for (const rows of [10, 16, 24, 40, 80]) {
		const { picker } = open(undefined, rows);
		const lines = picker.render(80);
		assert.equal(lines.length, 6 + pickerVisibleRows(rows), `line count at ${rows} rows`);
		assert.ok(lines.length <= Math.max(rows, 9), `${lines.length} lines exceed ${rows} rows`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80), "no line is wider than the terminal");
	}
	assert.equal(pickerVisibleRows(10), 3, "a tiny terminal still shows three rows");
	assert.equal(pickerVisibleRows(200), 15, "a tall terminal caps the list");
});

test("it opens on the saved value and marks it", () => {
	const { selectedLine } = open("provider-2/model-82");
	assert.equal(selectedLine(), "→ provider-2/model-82 ✓");
});

test("an unknown saved value opens on the first item", () => {
	const { selectedLine } = open("gone/model");
	assert.equal(selectedLine(), "→ provider-0/model-0");
});

test("typing filters and Enter picks the top match", () => {
	const { type, selectedLine, results, picker } = open("provider-2/model-82");
	type("7", "7");
	assert.match(selectedLine(), /model-77\b/);
	assert.ok(picker.render(80).every((line) => !/model-82/.test(line)), "non-matching items are hidden");
	type(ENTER);
	assert.deepEqual(results, ["provider-1/model-77"]);
});

test("clearing the search returns to the saved value", () => {
	const { type, selectedLine } = open("provider-2/model-82");
	type("7", "\x7f");
	assert.equal(selectedLine(), "→ provider-2/model-82 ✓");
});

test("arrows wrap and page keys move a page", () => {
	const { type, selectedLine } = open(undefined, 24);
	type(UP);
	assert.equal(selectedLine(), "→ provider-3/model-99");
	type(DOWN);
	assert.equal(selectedLine(), "→ provider-0/model-0");
	type(PAGE_DOWN);
	assert.equal(selectedLine(), `→ provider-${pickerVisibleRows(24) % 4}/model-${pickerVisibleRows(24)}`);
});

test("Escape cancels; Enter on no match does nothing", () => {
	const cancelled = open();
	cancelled.type(ESCAPE);
	assert.deepEqual(cancelled.results, [undefined]);

	const empty = open();
	empty.type("z", "z", "z", ENTER);
	assert.deepEqual(empty.results, []);
	assert.ok(empty.picker.render(80).includes("  No matching models"));
});

test("pickItem uses the picker in the TUI", async () => {
	const rendered = [];
	const ui = {
		select: async () => assert.fail("the TUI must not fall back to select"),
		custom: async (factory) =>
			new Promise((resolve) => {
				const host = { terminal: { rows: 24 }, requestRender() {} };
				const component = factory(host, theme, {}, resolve);
				rendered.push(component.render(80));
				component.handleInput(DOWN);
				component.handleInput(ENTER);
			}),
	};
	assert.equal(await pickItem(ui, true, "Pick", items, "provider-0/model-0"), "provider-1/model-1");
	assert.equal(rendered[0].length, 6 + pickerVisibleRows(24));
});

test("pickItem falls back to select outside the TUI", async () => {
	const asked = [];
	const ui = {
		select: async (title, options) => {
			asked.push(options.length);
			return options[3];
		},
		custom: async () => assert.fail("RPC mode cannot draw custom components"),
	};
	assert.equal(await pickItem(ui, false, "Pick", items, undefined), "provider-3/model-3");
	assert.deepEqual(asked, [100]);
	const cancelled = { select: async () => undefined };
	assert.equal(await pickItem(cancelled, true, "Pick", items, undefined), undefined);
});
