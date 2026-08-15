/**
 * Purpose: Guard the native extension cold-start path for issue #84.
 * Responsibilities: Measure the package extension entrypoint import plus extension factory registration in fresh Node processes.
 * Scope: Startup budget only; schema compatibility and runtime behavior have dedicated tests.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cwd, execPath } from "node:process";
import { test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const startupProfileModule = (await import("../scripts/profile-startup.mjs")) as {
	summarizeStartupValues: (values: number[], budgetMs: number) => { withinBudget?: boolean };
};
const { summarizeStartupValues } = startupProfileModule;

const STARTUP_BUDGET_MS = 250;
const STARTUP_SAMPLE_COUNT = 10;

type StartupMeasurement = {
	events: number;
	importMs: number;
	tools: string[];
	totalMs: number;
};

async function getPackageExtensionEntrypoint(): Promise<string> {
	const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { pi?: { extensions?: string[] } };
	const entrypoint = packageJson.pi?.extensions?.[0];
	assert.equal(typeof entrypoint, "string", "package.json pi.extensions[0] should name the packaged extension entrypoint");
	return entrypoint as string;
}

async function measureColdStartup(entrypoint: string): Promise<StartupMeasurement> {
	const script = `
const start = performance.now();
const extension = await import(${JSON.stringify(entrypoint)});
const imported = performance.now();
const pi = {
  events: [],
  tools: [],
  on(...args) { this.events.push(args); },
  registerTool(tool) { this.tools.push(tool); },
};
extension.default(pi);
const registered = performance.now();
console.log(JSON.stringify({
  events: pi.events.length,
  importMs: imported - start,
  tools: pi.tools.map((tool) => tool.name),
  totalMs: registered - start,
}));
`;
	const result = await execFile(execPath, ["--input-type=module", "-e", script], {
		cwd: cwd(),
		timeout: 10_000,
	});
	return JSON.parse(result.stdout.trim()) as StartupMeasurement;
}

test("startup budget tolerates host jitter but rejects sustained regressions", () => {
	assert.equal(summarizeStartupValues([240, 270, 280], STARTUP_BUDGET_MS).withinBudget, true);
	assert.equal(summarizeStartupValues([251, 270, 280], STARTUP_BUDGET_MS).withinBudget, false);
});

test("startup path imports only the pi-tui modules it uses", async () => {
	for (const path of ["extensions/agent-browser/index.ts", "extensions/agent-browser/lib/pi-tool-rendering.ts"]) {
		const source = await readFile(path, "utf8");
		assert.doesNotMatch(source, /from ["']@earendil-works\/pi-tui["']/, `${path} should not load the pi-tui barrel`);
	}
});

test("agent_browser cold startup stays below the issue #84 regression budget", async () => {
	const entrypoint = await getPackageExtensionEntrypoint();
	assert.equal(entrypoint, "./dist/extensions/agent-browser/index.js");
	const measurements: StartupMeasurement[] = [];
	for (let sample = 0; sample < STARTUP_SAMPLE_COUNT; sample += 1) measurements.push(await measureColdStartup(entrypoint));
	const totals = measurements.map((measurement) => measurement.totalMs);
	const summary = summarizeStartupValues(totals, STARTUP_BUDGET_MS);

	for (const measurement of measurements) {
		assert.ok(measurement.events > 0, "extension factory should register lifecycle handlers");
		assert.ok(measurement.tools.includes("agent_browser"), "extension factory should register the native browser tool");
	}
	assert.ok(
		summary.withinBudget,
		`cold startup exceeded ${STARTUP_BUDGET_MS}ms in every sample: ${totals.map((value) => value.toFixed(1)).join(", ")}`,
	);
});
