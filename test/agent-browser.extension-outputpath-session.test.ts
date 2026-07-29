/**
 * Purpose: Regress managed-session preservation after durable getter output.
 * Scope: Focused fake-upstream coverage for the primary-command/diagnostic-probe environment boundary.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension preserves a managed page after a getter output file and its diagnostic probe", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-file-session-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "browser-state.json");
	const screenshotPath = join(tempDir, "after-getter.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const idleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null;
let state = { idleTimeout: null, url: "about:blank" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
if (state.idleTimeout !== null && state.idleTimeout !== idleTimeout) state.url = "about:blank";
state.idleTimeout = idleTimeout;
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout, url: state.url }) + "\\n");
if (args.includes("open")) {
  state.url = args[args.indexOf("open") + 1];
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Platform health", url: state.url } }));
} else if (args.includes("eval")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { result: JSON.stringify({ firstMatchVisible: true, matchCount: 1, visibleCount: 1 }) } }));
} else if (args.includes("get") && args.includes("text")) {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Platform health" } }));
} else if (args.includes("screenshot")) {
  const outputPath = args[args.indexOf("screenshot") + 1];
  fs.writeFileSync(outputPath, "page:" + state.url);
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { path: outputPath } }));
} else {
  fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Platform health", url: state.url } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.test/platform/health"],
				sessionMode: "fresh",
			});
			assert.equal(opened.isError, false, JSON.stringify(opened));

			const getter = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "text", "body"],
				outputPath: "logs/body.txt",
			});
			assert.equal(getter.isError, false, JSON.stringify(getter));
			assert.equal(await readFile(join(tempDir, "logs/body.txt"), "utf8"), `${JSON.stringify({ result: "Platform health" }, null, 2)}\n`);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["screenshot", screenshotPath],
			});
			assert.equal(screenshot.isError, false, JSON.stringify(screenshot));
			assert.equal(await readFile(screenshotPath, "utf8"), "page:https://example.test/platform/health");

			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("eval")), "expected the broad getter visibility probe");
			assert.deepEqual(invocations.map((entry) => entry.idleTimeout), invocations.map(() => "1234"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
